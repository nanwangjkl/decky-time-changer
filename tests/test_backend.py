import asyncio
import importlib.util
import itertools
import logging
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


logger = logging.getLogger("time-changer-tests")
logger.addHandler(logging.NullHandler())
logger.propagate = False
spec = importlib.util.spec_from_file_location(
    "time_changer_backend", Path(__file__).resolve().parents[1] / "main.py"
)
backend = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"decky": types.SimpleNamespace(logger=logger)}):
    spec.loader.exec_module(backend)


class FakeClock:
    def __init__(self, ntp=True, fail_set=False, fail_restore=False):
        self.ntp = ntp
        self.epoch = 1791580000
        self.fail_set = fail_set
        self.fail_restore = fail_restore

    def run(self, *args):
        if args[0] == "show":
            return f"Timezone=Asia/Shanghai\nNTPSynchronized=no\nNTP={'yes' if self.ntp else 'no'}"
        if args == ("set-ntp", "false"):
            self.ntp = False
        elif args == ("set-ntp", "true"):
            if self.fail_restore:
                raise backend.TimeCommandError("NTP restore failed")
            self.ntp = True
        elif args[0] == "set-time":
            if self.fail_set:
                raise backend.TimeCommandError("time change failed")
            self.epoch = int(args[1][1:])
        else:
            raise AssertionError(f"Unexpected command: {args}")
        return ""


class BackendTests(unittest.TestCase):
    def invoke(self, clock, method, *args):
        with patch.object(backend, "_run", side_effect=clock.run) as run:
            with patch.object(backend.time, "time", side_effect=lambda: clock.epoch):
                result = asyncio.run(getattr(backend.Plugin(), method)(*args))
        return result, run.call_args_list

    def test_status_uses_property_names_for_every_order_and_ntp_state(self):
        for enabled, synced in itertools.product((True, False), repeat=2):
            fields = [
                "Timezone=Asia/Shanghai",
                f"NTP={'yes' if enabled else 'no'}",
                f"NTPSynchronized={'yes' if synced else 'no'}",
            ]
            for order in itertools.permutations(fields):
                with self.subTest(enabled=enabled, synced=synced, order=order):
                    with patch.object(backend, "_run", return_value="\n".join(order)):
                        result = asyncio.run(backend.Plugin().get_status())
                    self.assertTrue(result["ok"])
                    self.assertEqual(result["ntp_enabled"], enabled)
                    self.assertEqual(result["ntp_synced"], synced)
                    self.assertEqual(result["timezone"], "Asia/Shanghai")

    def test_incomplete_or_invalid_status_is_an_error(self):
        for output in (
            "NTP=yes\nNTPSynchronized=no",
            "NTP=maybe\nNTPSynchronized=no\nTimezone=UTC",
            "NTP=yes\nNTPSynchronized=no\nTimezone=",
        ):
            with self.subTest(output=output):
                with patch.object(backend, "_run", return_value=output) as run:
                    result = asyncio.run(backend.Plugin().get_status())
                self.assertFalse(result["ok"])
                self.assertIn("unexpected timedatectl output", result["error"])
                run.assert_called_once()

    def test_success_sets_the_requested_epoch_and_leaves_ntp_off(self):
        result, calls = self.invoke(FakeClock(), "set_time", 1791600000)
        self.assertTrue(result["ok"])
        self.assertEqual(result["epoch"], 1791600000)
        self.assertFalse(result["ntp_enabled"])
        self.assertIn(("set-time", "@1791600000"), [call.args for call in calls])

    def test_failure_restores_previously_enabled_ntp_and_returns_actual_state(self):
        result, calls = self.invoke(FakeClock(fail_set=True), "set_time", 1791600000)
        self.assertFalse(result["ok"])
        self.assertIn("time change failed", result["error"])
        self.assertTrue(result["ntp_enabled"])
        self.assertEqual(result["epoch"], 1791580000)
        self.assertIn(("set-ntp", "true"), [call.args for call in calls])

    def test_failure_keeps_previously_disabled_ntp_off(self):
        result, calls = self.invoke(FakeClock(ntp=False, fail_set=True), "shift_time", 3600)
        self.assertFalse(result["ok"])
        self.assertFalse(result["ntp_enabled"])
        self.assertNotIn(("set-ntp", "true"), [call.args for call in calls])

    def test_rollback_failure_reports_both_errors_and_actual_ntp_state(self):
        result, _ = self.invoke(FakeClock(fail_set=True, fail_restore=True), "set_time", 1791600000)
        self.assertFalse(result["ok"])
        self.assertIn("time change failed", result["error"])
        self.assertIn("NTP restore failed", result["error"])
        self.assertFalse(result["ntp_enabled"])

    def test_unknown_original_status_prevents_clock_changes(self):
        with patch.object(backend, "_run", side_effect=backend.TimeCommandError("status unavailable")) as run:
            result = asyncio.run(backend.Plugin().set_time(1791600000))
        self.assertFalse(result["ok"])
        self.assertTrue(all(call.args[0] == "show" for call in run.call_args_list))

    def test_invalid_epoch_does_not_disable_ntp(self):
        result, calls = self.invoke(FakeClock(), "set_time", "invalid")
        self.assertFalse(result["ok"])
        self.assertTrue(result["ntp_enabled"])
        self.assertTrue(all(call.args[0] == "show" for call in calls))

    def test_restore_enables_ntp_without_claiming_immediate_synchronization(self):
        result, _ = self.invoke(FakeClock(ntp=False), "restore_time")
        self.assertTrue(result["ok"])
        self.assertTrue(result["ntp_enabled"])
        self.assertFalse(result["ntp_synced"])


if __name__ == "__main__":
    unittest.main()
