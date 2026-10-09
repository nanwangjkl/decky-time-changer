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
    # Strip loader-injected dynamic-linker variables before spawning.
    return {
        k: v
        for k, v in os.environ.items()
        if not k.startswith("LD_") and not k.startswith("_MEI")
    }


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


def _set_time_epoch(epoch: int) -> None:
    # NTP must be off first, otherwise set-time fails with
    # "Automatic time synchronization is enabled"
    _run("set-ntp", "false")
    # "@<seconds>" is parsed as UTC epoch, independent of the local timezone
    _run("set-time", f"@{int(epoch)}")


def _error(e: Exception) -> dict:
    decky.logger.exception("timedatectl call failed")
    return {"ok": False, "error": f"{type(e).__name__}: {e}"}


class Plugin:
    async def get_status(self) -> dict:
        """Return current epoch, NTP state and timezone."""
        try:
            out = _run("show", "--value", "-p", "NTP", "-p", "NTPSynchronized", "-p", "Timezone")
            values = [line.strip() for line in out.splitlines() if line.strip()]
            if len(values) < 3:
                raise TimeCommandError(f"unexpected timedatectl output: {out[:200]!r}")
            return {
                "ok": True,
                "epoch": int(time.time()),
                "ntp_enabled": values[0] == "yes",
                "ntp_synced": values[1] == "yes",
                "timezone": values[2],
            }
        except Exception as e:
            return _error(e)

    async def set_time(self, epoch: int) -> dict:
        """Set the system clock to an absolute epoch (UTC seconds)."""
        try:
            _set_time_epoch(int(epoch))
            decky.logger.info("System time set to %s", epoch)
            return await self.get_status()
        except Exception as e:
            return _error(e)

    async def shift_time(self, delta_seconds: int) -> dict:
        """Shift the system clock by delta_seconds relative to the backend's clock."""
        try:
            target = int(time.time()) + int(delta_seconds)
            _set_time_epoch(target)
            decky.logger.info("System time shifted by %ss to %s", delta_seconds, target)
            return await self.get_status()
        except Exception as e:
            return _error(e)

    async def restore_time(self) -> dict:
        """Re-enable NTP so systemd-timesyncd resyncs to real time (needs network)."""
        try:
            _run("set-ntp", "true")
            decky.logger.info("NTP re-enabled")
            return await self.get_status()
        except Exception as e:
            return _error(e)

    async def _main(self):
        decky.logger.info(
            "Time Changer loaded (uid=%s, timedatectl=%s)", os.geteuid(), _TIMEDATECTL
        )

    async def _unload(self):
        pass

    async def _uninstall(self):
        pass
