#!/usr/bin/env python3
"""Initialize an instance as mysql, preserving failed work and existing databases."""
import argparse
from contextlib import contextmanager
import fcntl
import grp
import os
from pathlib import Path
import pwd
import signal
import stat
import subprocess
import sys
import tempfile
import time


class InitializationError(ValueError):
    """A diagnostic that contains no SQL or credentials."""


class InitializationInterrupted(InitializationError):
    pass


def interrupt_initialization(signum, frame):
    # One interruption begins cleanup; repeated signals must not interrupt the
    # finally blocks while they stop the private server/process group.
    for value in (signal.SIGTERM, signal.SIGINT):
        signal.signal(value, signal.SIG_IGN)
    raise InitializationInterrupted("MariaDB initialization interrupted; existing and staged data were preserved")


# Needed by MariaDB's privilege, plugin, stored-program and statistics loaders.
SYSTEM_TABLES = (
    "global_priv", "user", "db", "tables_priv", "columns_priv", "procs_priv",
    "proxies_priv", "roles_mapping", "plugin", "servers", "func", "event", "proc",
    "table_stats", "column_stats", "index_stats", "time_zone", "time_zone_name",
    "time_zone_transition", "time_zone_transition_type", "time_zone_leap_second",
)
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C", "LC_ALL": "C"}


def real_directory(path):
    if path.is_symlink() or not path.is_dir() or path.resolve() != path:
        raise InitializationError(f"Expected a real directory without symbolic links: {path}")


@contextmanager
def instance_lock(root):
    """Separate from the installer's outer lock, also protects direct invocation."""
    real_directory(root / "config")
    path = root / "config/mariadb-initialization.lock"
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
            raise InitializationError("The MariaDB initialization lock must be a private root-owned file")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InitializationError("Another MariaDB initialization is running for this instance") from None
        yield
    finally:
        os.close(fd)


def assert_stopped(root):
    # Be conservative, including stale sockets/PIDs. Never start a second server
    # merely because authentication to the existing one is unavailable.
    for name in ("mysql.sock", "mysql.pid", ".initialize.sock", ".initialize.pid"):
        if os.path.lexists(root / "data/mariadb" / name):
            raise InitializationError(
                f"MariaDB socket/PID file exists ({name}); stop this instance and verify stale files before retrying")


def mysql_command(*arguments):
    return ["/usr/sbin/runuser", "-u", "mysql", "--", *arguments]


def client_command(socket, user="root"):
    command = ["/usr/bin/mariadb", "--no-defaults", "--protocol=socket", f"--socket={socket}",
               f"--user={user}", "--batch", "--skip-column-names", "--connect-timeout=2"]
    return mysql_command(*command) if user == "mysql" else command


def query(socket, sql, user="root"):
    return subprocess.run(client_command(socket, user), input=sql, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=5, cwd="/", env=ENV)


def stop_process(process):
    # Signal the private session (runuser and its server), never a saved PID.
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)


def validate_database(datadir, *, fresh=False, timeout=90):
    socket = datadir / ".initialize.sock"
    pid = datadir / ".initialize.pid"
    if len(os.fsencode(socket)) >= 104:
        raise InitializationError("Installation path is too long for the temporary MariaDB Unix socket")
    if os.path.lexists(socket) or os.path.lexists(pid):
        raise InitializationError("MariaDB validation socket/PID already exists; verify the instance is stopped before retrying")
    # Existing diagnostic files are not overwritten, even after interrupted retries.
    descriptor, diagnostic = tempfile.mkstemp(prefix="initialization-", suffix=".log", dir=datadir)
    with os.fdopen(descriptor, "wb") as log:
        command = mysql_command(
            "/usr/sbin/mariadbd", "--no-defaults", f"--datadir={datadir}", f"--socket={socket}",
            f"--pid-file={pid}", "--skip-networking", "--skip-log-bin", "--skip-log-error")
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, cwd="/", env=ENV,
                                   start_new_session=True)
        try:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise InitializationError(f"MariaDB validation server exited; data preserved; inspect {diagnostic}")
                try:
                    ready = query(socket, "SELECT CURRENT_USER();\n")
                    if ready.returncode == 0 and ready.stdout.strip() == "root@localhost":
                        break
                except subprocess.TimeoutExpired:
                    pass
                time.sleep(0.2)
            else:
                raise InitializationError(f"MariaDB validation timed out; data preserved; inspect {diagnostic}")
            sql = "\n".join(f"SELECT 1 FROM mysql.`{name}` LIMIT 0;" for name in SYSTEM_TABLES)
            result = query(socket, sql + "\n")
            if result.returncode:
                raise InitializationError(
                    f"MariaDB system-table validation failed; data preserved in {datadir}; restore/repair a backup before retrying")
            if fresh:
                result = query(socket, "SELECT CURRENT_USER();\n", "mysql")
                if result.returncode or result.stdout.strip() != "mysql@localhost":
                    raise InitializationError("MariaDB mysql socket account validation failed; initialization data preserved")
        finally:
            stop_process(process)
            # These names were absent on entry and belong only to this private
            # validation server. MariaDB can leave a socket after failed startup.
            # Never remove a preexisting DB file or follow a symbolic link.
            if socket.exists() and stat.S_ISSOCK(socket.lstat().st_mode):
                socket.unlink()
            if pid.exists() and stat.S_ISREG(pid.lstat().st_mode) and pid.read_text().strip().isdigit():
                pid.unlink()
    # A clean stop removes these files. Never publish a still-running/unclean stage.
    if os.path.lexists(socket) or os.path.lexists(pid):
        raise InitializationError(f"MariaDB did not remove its validation socket/PID; data preserved in {datadir}")


def create_stage(root):
    parent = root / "data/mariadb-init"
    if parent.is_symlink():
        raise InitializationError("MariaDB initialization directory must not be a symbolic link")
    parent.mkdir(mode=0o750, exist_ok=True)
    real_directory(parent)
    uid, gid = pwd.getpwnam("mysql").pw_uid, grp.getgrnam("mysql").gr_gid
    os.chown(parent, uid, gid)
    parent.chmod(0o750)
    stage = Path(tempfile.mkdtemp(prefix="stage-", dir=parent))
    os.chown(stage, uid, gid)
    stage.chmod(0o750)
    return stage


def initialize(root):
    if os.geteuid() != 0:
        raise InitializationError("Run MariaDB initialization with sudo")
    root = Path(root)
    real_directory(root)
    real_directory(root / "data")
    datadir = root / "data/mariadb"
    real_directory(datadir)
    with instance_lock(root):
        assert_stopped(root)
        if any(datadir.iterdir()):
            # A mysql/ directory (or user.frm) may be left by failed bootstrap.
            # Do not trust it or rerun bootstrap against any existing data.
            validate_database(datadir)
            print("Existing MariaDB system tables and root socket authentication verified; data and credentials preserved.")
            return
        stage = create_stage(root)
        descriptor = os.open(stage / "bootstrap.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as log:
            command = mysql_command(
                "/usr/bin/mariadb-install-db", "--no-defaults", f"--datadir={stage}",
                "--auth-root-authentication-method=socket", "--auth-root-socket-user=mysql", "--skip-test-db")
            # No --user: the process already has mysql's UID before mariadbd
            # first traverses its 0750 datadir under the enforced AppArmor profile.
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, cwd="/", env=ENV,
                                       start_new_session=True)
            try:
                returncode = process.wait(timeout=180)
            except subprocess.TimeoutExpired:
                raise InitializationError(f"MariaDB bootstrap timed out; retained {stage}; no data deleted") from None
            finally:
                stop_process(process)
        if returncode:
            raise InitializationError(f"MariaDB bootstrap failed; retained {stage}; fix the cause and rerun (no data deleted)")
        validate_database(stage, fresh=True)
        assert_stopped(root)
        real_directory(datadir)
        if any(datadir.iterdir()):
            raise InitializationError(f"MariaDB target changed during initialization; retained {stage}; refusing to replace data")
        # rename(2) replaces an empty destination directory atomically. It refuses
        # a nonempty directory; no recursive move/delete or credential reset.
        os.replace(stage, datadir)
        print("MariaDB initialized as mysql; system tables and both socket accounts verified before publication.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    previous = {value: signal.getsignal(value) for value in (signal.SIGTERM, signal.SIGINT)}
    for value in previous:
        signal.signal(value, interrupt_initialization)
    try:
        initialize(args.root)
    except (InitializationError, OSError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        message = str(error) if isinstance(error, InitializationError) else "MariaDB initialization failed or interrupted; existing and staged data were preserved"
        print(message, file=sys.stderr)
        return 1
    finally:
        for value, handler in previous.items():
            signal.signal(value, handler)
    return 0


if __name__ == "__main__":
    sys.exit(main())
