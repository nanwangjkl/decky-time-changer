import asyncio
import time

import decky

#timedatectl property names -> friendly keys
_PROPS = ("NTP", "NTPSynchronized", "Timezone")


class TimeCommandError(Exception):
    pass


async def _run(*args: str) -> str:
    """Run a command as root and return its stdout, raising TimeCommandError on failure."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        err = stderr.decode(errors="replace").strip() or f"{args[0]} exited with {proc.returncode}"
        raise TimeCommandError(err)
    return stdout.decode(errors="replace").strip()


async def _set_time_epoch(epoch: int) -> None:
    # NTP must be off first, otherwise set-time fails with
    # "Automatic time synchronization is enabled"
    await _run("timedatectl", "set-ntp", "false")
    # "@<seconds>" is parsed as UTC epoch, independent of the local timezone
    await _run("timedatectl", "set-time", f"@{int(epoch)}")


class Plugin:
    async def get_status(self) -> dict:
        """Return current epoch, NTP state and timezone."""
        try:
            out = await _run("timedatectl", "show", "--value", *("-p" + p for p in _PROPS))
            ntp, ntp_synced, timezone = (line.strip() for line in out.splitlines())
            return {
                "ok": True,
                "epoch": int(time.time()),
                "ntp_enabled": ntp == "yes",
                "ntp_synced": ntp_synced == "yes",
                "timezone": timezone,
            }
        except Exception as e:
            decky.logger.exception("get_status failed")
            return {"ok": False, "error": str(e)}

    async def set_time(self, epoch: int) -> dict:
        """Set the system clock to an absolute epoch (UTC seconds)."""
        try:
            await _set_time_epoch(int(epoch))
            decky.logger.info("System time set to %s", epoch)
            return await self.get_status()
        except Exception as e:
            decky.logger.exception("set_time failed")
            return {"ok": False, "error": str(e)}

    async def shift_time(self, delta_seconds: int) -> dict:
        """Shift the system clock by delta_seconds relative to the backend's clock."""
        try:
            target = int(time.time()) + int(delta_seconds)
            await _set_time_epoch(target)
            decky.logger.info("System time shifted by %ss to %s", delta_seconds, target)
            return await self.get_status()
        except Exception as e:
            decky.logger.exception("shift_time failed")
            return {"ok": False, "error": str(e)}

    async def restore_time(self) -> dict:
        """Re-enable NTP so systemd-timesyncd resyncs to real time (needs network)."""
        try:
            await _run("timedatectl", "set-ntp", "true")
            decky.logger.info("NTP re-enabled")
            return await self.get_status()
        except Exception as e:
            decky.logger.exception("restore_time failed")
            return {"ok": False, "error": str(e)}

    async def _main(self):
        decky.logger.info("Time Changer loaded")

    async def _unload(self):
        pass

    async def _uninstall(self):
        pass
