#!/usr/bin/env python3
"""Persist the host memory setting required by Redis background saves."""
from pathlib import Path
import os
import subprocess


CONTENT = "# Managed by the LibreOJ installer for Redis background saves.\nvm.overcommit_memory = 1\n"


def configure(directory=Path("/etc/sysctl.d")):
    directory.mkdir(parents=True, exist_ok=True)
    filename = directory / "99-libreoj-redis.conf"
    if filename.is_symlink():
        raise ValueError(f"Refusing symbolic link: {filename}")
    try:
        fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    except FileExistsError:
        if not filename.is_file() or filename.read_text() != CONTENT:
            raise ValueError(f"Existing Redis host configuration differs; review {filename}")
        filename.chmod(0o644)
    else:
        created = os.fstat(fd)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(CONTENT)
                stream.flush()
                os.fchmod(stream.fileno(), 0o644)
                os.fsync(stream.fileno())
        except BaseException:
            # A partial first write must not poison retries. Remove only the
            # file created above, never an administrator's replacement file.
            try:
                current = filename.lstat()
                if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                    filename.unlink()
            except FileNotFoundError:
                pass
            raise
    # Apply only this key; do not reload unrelated administrator sysctl settings.
    subprocess.run(["sysctl", "-w", "vm.overcommit_memory=1"], check=True, stdout=subprocess.DEVNULL)
    return filename


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run configure-redis-host.py with sudo")
    try:
        filename = configure()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"Redis host configuration failed: {error}") from error
    print(f"Redis host setting applied and saved: vm.overcommit_memory=1 ({filename})")


if __name__ == "__main__":
    main()
