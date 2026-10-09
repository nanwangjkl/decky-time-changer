import json
import os
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile


REPO = Path(__file__).resolve().parents[1]
REAL_RSYNC = shutil.which("rsync")
STUB = """#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
tool = Path(sys.argv[0]).name
entry = {"tool": tool, "args": sys.argv[1:]}
if tool == "ssh":
    entry["stdin"] = sys.stdin.read() if "sudo -S" in sys.argv[-1] else ""
if tool == "rsync":
    entry["rsh"] = os.environ["RSYNC_RSH"]
with open(os.environ["DEPLOY_TEST_LOG"], "a") as log:
    log.write(json.dumps(entry) + "\\n")
if tool == "sshpass":
    assert sys.argv[1] == "-e"
    assert os.environ["SSHPASS"] == os.environ["DECK_PASS"]
    os.execvp(sys.argv[2], sys.argv[2:])
"""


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="time-changer-deploy-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copy(REPO / "deploy.sh", self.root / "deploy.sh")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for tool in ("pnpm", "ssh", "sshpass", "rsync"):
            executable = self.bin / tool
            executable.write_text(STUB)
            executable.chmod(0o755)
        self.log = self.root / "commands.jsonl"
        self.env = {
            key: value for key, value in os.environ.items()
            if not key.startswith("DECK_") and key not in ("SSHPASS", "RSYNC_RSH")
        }
        self.env.update(
            PATH=f"{self.bin}{os.pathsep}{self.env['PATH']}",
            DEPLOY_TEST_LOG=str(self.log),
            DECK_IP="fake-host",
            DECK_PORT="2222",
        )

    def invoke(self, mode="deploy", **settings):
        self.env.update(settings)
        result = subprocess.run(
            ["bash", str(self.root / "deploy.sh"), mode],
            env=self.env, capture_output=True, text=True, timeout=20,
        )
        entries = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, entries

    def test_deploy_starts_remote_rsync_and_uses_key_auth_for_both_steps(self):
        key = str(self.root / 'key with spaces and "quotes"')
        result, entries = self.invoke(DECK_KEY=key)
        self.assertEqual(result.returncode, 0, result.stderr)
        rsync = next(entry for entry in entries if entry["tool"] == "rsync")
        self.assertIn("--rsync-path=mkdir -p homebrew/plugins/decky-time-changer && rsync", rsync["args"])
        self.assertIn("deck@fake-host:homebrew/plugins/decky-time-changer/", rsync["args"])
        ssh = next(entry for entry in entries if entry["tool"] == "ssh")
        self.assertEqual(ssh["args"][:4], ["-p", "2222", "-i", key])
        self.assertEqual(ssh["args"][-1], "sudo -n systemctl restart plugin_loader")
        self.assertFalse(any(entry["tool"] == "sshpass" for entry in entries))

    def test_password_auth_is_shared_and_sudo_password_is_sent_as_input(self):
        password = "test ' password $(literal)"
        result, entries = self.invoke(DECK_PASS=password)
        self.assertEqual(result.returncode, 0, result.stderr)
        rsync = next(entry for entry in entries if entry["tool"] == "rsync")
        self.assertEqual(shlex.split(rsync["rsh"])[:3], ["sshpass", "-e", "ssh"])
        ssh = next(entry for entry in entries if entry["tool"] == "ssh")
        self.assertEqual(ssh["stdin"], password + "\n")
        self.assertNotIn(password, ssh["args"][-1])

    @unittest.skipUnless(REAL_RSYNC, "rsync is not installed")
    def test_real_rsync_parser_preserves_quoted_ssh_key_arguments(self):
        key = str(self.root / 'key with spaces and "quotes"')
        result, entries = self.invoke(DECK_KEY=key)
        self.assertEqual(result.returncode, 0, result.stderr)
        rsh = next(entry["rsh"] for entry in entries if entry["tool"] == "rsync")
        source = self.root / "sample.txt"
        source.write_text("test")
        # The SSH executable is still the local stub; this never contacts a host.
        subprocess.run(
            [REAL_RSYNC, "-an", "-e", rsh, str(source), "fake-host:homebrew/plugins/"],
            env=self.env, capture_output=True, text=True, timeout=20,
        )
        ssh = [json.loads(line) for line in self.log.read_text().splitlines()][-1]
        self.assertEqual(ssh["tool"], "ssh")
        self.assertEqual(ssh["args"][:4], ["-p", "2222", "-i", key])
        self.assertIn("--server", ssh["args"])

    def test_missing_host_fails_before_build_or_remote_commands(self):
        self.env.pop("DECK_IP")
        for mode in ("deploy", "restart"):
            with self.subTest(mode=mode):
                result, entries = self.invoke(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Set DECK_IP", result.stderr)
                self.assertEqual(entries, [])

    def test_packaging_does_not_load_deploy_credentials(self):
        (self.root / ".deploy.env").write_text("exit 99\n")
        (self.root / "package.json").write_text(json.dumps({"version": "0.1.9"}))
        for name in ("plugin.json", "main.py", "README.md", "LICENSE"):
            (self.root / name).write_text("fixture")
        (self.root / "dist").mkdir()
        (self.root / "dist/index.js").write_text("fixture bundle")
        (self.root / "py_modules").mkdir()
        result, entries = self.invoke("zip")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(entry["tool"] == "pnpm" for entry in entries))
        self.assertIn(["install", "--frozen-lockfile", "--silent"], [entry["args"] for entry in entries])
        with ZipFile(self.root / "out/decky-time-changer-v0.1.9.zip") as archive:
            self.assertIsNone(archive.testzip())
            self.assertIn("decky-time-changer/dist/index.js", archive.namelist())


if __name__ == "__main__":
    unittest.main()
