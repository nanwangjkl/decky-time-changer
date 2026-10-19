import os
import shutil
import subprocess
import time

import decky

# Resolve the absolute path once: the plugin process may have a minimal PATH
_TIMEDATECTL = shutil.which("timedatectl") or "/usr/bin/timedatectl"


def _clean_env() -> dict:
    # Decky's loader is a PyInstaller bundle; its unpack dir leaks into
    # LD_LIBRARY_PATH, so children resolve PyInstaller's old libcrypto instead
    # of the system one and system binaries like timedatectl fail to link.
    # PyInstaller preserves the pre-existing value in <VAR>_ORIG: restore it
    # when present (keeps a legitimately configured system path), otherwise
    # drop the loader-injected variable entirely.
    env = dict(os.environ)
    for var in ("LD_LIBRARY_PATH", "LD_PRELOAD"):
        orig = env.pop(f"{var}_ORIG", None)
        if orig is not None:
            env[var] = orig
        else:
            env.pop(var, None)
    return {k: v for k, v in env.items() if not k.startswith("_MEI")}


class TimeCommandError(Exception):
    pass


def _run(*args: str) -> str:
    """Run timedatectl and return its stdout, raising TimeCommandError on failure."""
    try:
        proc = subprocess.run(
            [_TIMEDATECTL, *args],
            capture_output=True,
            text=True,
            timeout=10,
            env=_clean_env(),
        )
    except FileNotFoundError:
        raise TimeCommandError(f"timedatectl not found at {_TIMEDATECTL}")
    except subprocess.TimeoutExpired:
        raise TimeCommandError("timedatectl timed out")
    if proc.returncode != 0:
        err = (proc.stderr or "").strip() or f"timedatectl exited with {proc.returncode}"
        raise TimeCommandError(err)
    return (proc.stdout or "").strip()


def _get_status() -> dict:
    # --property filters the output; it does not determine its line order.
    out = _run("show", "-p", "NTP", "-p", "NTPSynchronized", "-p", "Timezone")
    properties = {}
    for line in out.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            properties[key.strip()] = value.strip()
    if (
        properties.get("NTP") not in ("yes", "no")
        or properties.get("NTPSynchronized") not in ("yes", "no")
        or not properties.get("Timezone")
    ):
        raise TimeCommandError(f"unexpected timedatectl output: {out[:200]!r}")
    return {
        "ok": True,
        "epoch": int(time.time()),
        "ntp_enabled": properties["NTP"] == "yes",
        "ntp_synced": properties["NTPSynchronized"] == "yes",
        "timezone": properties["Timezone"],
    }


def _set_time_epoch(epoch: int) -> None:
    ntp_was_enabled = _get_status()["ntp_enabled"]
    try:
        # NTP must be off first, otherwise set-time fails with
        # "Automatic time synchronization is enabled".
        _run("set-ntp", "false")
        # "@<seconds>" is parsed as UTC epoch, independent of the local timezone.
        _run("set-time", f"@{int(epoch)}")
    except Exception as set_error:
        if ntp_was_enabled:
            try:
                _run("set-ntp", "true")
            except Exception as restore_error:
                raise TimeCommandError(
                    f"{set_error}; restoring NTP failed: {restore_error}"
                ) from set_error
        raise


def _restore_ntp() -> None:
    """Best-effort NTP re-enable; a safeguard that must never raise.

    Called from every plugin lifecycle hook to attempt recovery after disable,
    reload, uninstall, or a Deck reboot ("set-ntp false" survives reboots).
    Enabling NTP does not guarantee immediate synchronization.
    """
    try:
        _run("set-ntp", "true")
    except Exception:
        decky.logger.exception("NTP restore on lifecycle hook failed")


def _error(e: Exception, refresh_status: bool = False) -> dict:
    decky.logger.exception("timedatectl call failed")
    result = {}
    if refresh_status:
        try:
            result = _get_status()
        except Exception:
            # Preserve the operation's original error if status cannot be read.
            pass
    result.update(ok=False, error=f"{type(e).__name__}: {e}")
    return result


class Plugin:
    async def get_status(self) -> dict:
        """Return current epoch, NTP state and timezone."""
        try:
            return _get_status()
        except Exception as e:
            return _error(e)

    async def set_time(self, epoch: int) -> dict:
        """Set the system clock to an absolute epoch (UTC seconds)."""
        try:
            _set_time_epoch(int(epoch))
            decky.logger.info("System time set to %s", epoch)
            return await self.get_status()
        except Exception as e:
            return _error(e, refresh_status=True)

    async def shift_time(self, delta_seconds: int) -> dict:
        """Shift the system clock by delta_seconds relative to the backend's clock."""
        try:
            target = int(time.time()) + int(delta_seconds)
            _set_time_epoch(target)
            decky.logger.info("System time shifted by %ss to %s", delta_seconds, target)
            return await self.get_status()
        except Exception as e:
            return _error(e, refresh_status=True)

    async def restore_time(self) -> dict:
        """Re-enable NTP so systemd-timesyncd resyncs to real time (needs network)."""
        try:
            _run("set-ntp", "true")
            decky.logger.info("NTP re-enabled")
            return await self.get_status()
        except Exception as e:
            return _error(e, refresh_status=True)

    # The three lifecycle hooks below all restore NTP: _unload also fires when
    # the plugin is disabled or the loader restarts, not every Decky
    # version calls _uninstall, and _main catches stray "set-ntp false" states
    # that survive Deck reboots. Restarting only Steam does not reload the backend.
    # Do not remove these without an equivalent safeguard.

    async def _main(self):
        _restore_ntp()
        decky.logger.info(
            "Time Changer loaded (uid=%s, timedatectl=%s)", os.geteuid(), _TIMEDATECTL
        )

    async def _unload(self):
        _restore_ntp()

    async def _uninstall(self):
        _restore_ntp()
