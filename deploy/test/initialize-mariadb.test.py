#!/usr/bin/env python3
"""Bootstrap and retry boundaries, without touching any installed instance."""
import importlib.util
import io
import signal
import socket
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

DEPLOY = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("initialize_mariadb", DEPLOY / "initialize-mariadb.py")
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)


class DatabaseInitialization(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "config").mkdir()
        (self.root / "data/mariadb").mkdir(parents=True)
        self.root_uid = mock.patch.object(db.os, "geteuid", return_value=0)
        self.root_uid.start()
        self.addCleanup(self.root_uid.stop)
        # The tests work for non-root developers too, without real ownership changes.
        self.chown = mock.patch.object(db.os, "chown").start()
        self.addCleanup(mock.patch.stopall)
        self.lock = mock.patch.object(db, "instance_lock").start()

    def process(self, code=0):
        process = mock.Mock()
        process.wait.return_value = code
        process.poll.return_value = code
        return process

    def test_empty_target_initializes_as_mysql_and_publishes_only_after_validation(self):
        observed = []
        def validate(stage, **kwargs):
            self.assertTrue(kwargs["fresh"])
            self.assertEqual(list((self.root / "data/mariadb").iterdir()), [])
            (stage / "verified-table").write_text("safe fixture")
            observed.append(stage)
        with mock.patch.object(db.subprocess, "Popen", return_value=self.process()) as launch, \
                mock.patch.object(db, "validate_database", side_effect=validate):
            db.initialize(self.root)
        command = launch.call_args.args[0]
        self.assertEqual(command[:4], ["/usr/sbin/runuser", "-u", "mysql", "--"])
        self.assertEqual(command[4:6], ["/usr/bin/mariadb-install-db", "--no-defaults"])
        self.assertIn("--auth-root-socket-user=mysql", command)
        self.assertIn("--auth-root-authentication-method=socket", command)
        self.assertFalse(any(value.startswith("--user=") for value in command))
        self.assertEqual(launch.call_args.kwargs["cwd"], "/")
        self.assertNotIn("MYSQLD_BOOTSTRAP", launch.call_args.kwargs["env"])
        self.assertEqual((self.root / "data/mariadb/verified-table").read_text(), "safe fixture")
        self.assertFalse(observed[0].exists())

    def test_failed_bootstrap_preserves_stage_and_retry_uses_a_new_stage(self):
        with mock.patch.object(db.subprocess, "Popen", return_value=self.process(1)), \
                mock.patch.object(db, "validate_database") as validate:
            with self.assertRaisesRegex(db.InitializationError, "retained"):
                db.initialize(self.root)
            validate.assert_not_called()
        stage = next((self.root / "data/mariadb-init").iterdir())
        (stage / "retained").write_bytes(b"failed data")
        with mock.patch.object(db.subprocess, "Popen", return_value=self.process()), \
                mock.patch.object(db, "validate_database"):
            db.initialize(self.root)
        self.assertEqual((stage / "retained").read_bytes(), b"failed data")

    def test_partial_mysql_directory_is_not_treated_as_success_or_reinitialized(self):
        partial = self.root / "data/mariadb/mysql"
        partial.mkdir()
        (partial / "global_priv.MAI").write_bytes(b"partial preserve")
        with mock.patch.object(db, "validate_database", side_effect=db.InitializationError("incomplete tables")) as validate, \
                mock.patch.object(db.subprocess, "Popen") as bootstrap:
            with self.assertRaisesRegex(db.InitializationError, "incomplete"):
                db.initialize(self.root)
            validate.assert_called_once_with(self.root / "data/mariadb")
            bootstrap.assert_not_called()
        self.assertEqual((partial / "global_priv.MAI").read_bytes(), b"partial preserve")

    def test_existing_database_is_validated_without_bootstrap_or_authentication_reset(self):
        record = self.root / "data/mariadb/application-data"
        record.write_bytes(b"real data")
        with mock.patch.object(db, "validate_database") as validate, \
                mock.patch.object(db.subprocess, "Popen") as bootstrap:
            db.initialize(self.root)
        validate.assert_called_once_with(self.root / "data/mariadb")
        bootstrap.assert_not_called()
        self.assertEqual(record.read_bytes(), b"real data")

    def test_validation_failure_keeps_empty_target_and_stage(self):
        with mock.patch.object(db.subprocess, "Popen", return_value=self.process()), \
                mock.patch.object(db, "validate_database", side_effect=db.InitializationError("bad system tables")):
            with self.assertRaisesRegex(db.InitializationError, "bad system tables"):
                db.initialize(self.root)
        self.assertEqual(list((self.root / "data/mariadb").iterdir()), [])
        self.assertEqual(len(list((self.root / "data/mariadb-init").iterdir())), 1)

    def test_nonempty_target_appearing_during_validation_is_never_overwritten(self):
        def validate(stage, **kwargs):
            (self.root / "data/mariadb/raced-data").write_bytes(b"preserve")
        with mock.patch.object(db.subprocess, "Popen", return_value=self.process()), \
                mock.patch.object(db, "validate_database", side_effect=validate):
            with self.assertRaisesRegex(db.InitializationError, "target changed"):
                db.initialize(self.root)
        self.assertEqual((self.root / "data/mariadb/raced-data").read_bytes(), b"preserve")

    def test_existing_socket_or_pid_prevents_another_server(self):
        for name in ("mysql.sock", "mysql.pid", ".initialize.sock", ".initialize.pid"):
            with self.subTest(name=name):
                path = self.root / "data/mariadb" / name
                path.touch()
                with mock.patch.object(db, "validate_database") as validate:
                    with self.assertRaisesRegex(db.InitializationError, "stop this instance"):
                        db.initialize(self.root)
                    validate.assert_not_called()
                path.unlink()

    def test_symlink_datadir_and_stage_parent_are_refused(self):
        target = self.root / "other"
        target.mkdir()
        stage_parent = self.root / "data/mariadb-init"
        stage_parent.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(db.InitializationError, "symbolic link"):
            db.initialize(self.root)
        self.assertEqual(list(target.iterdir()), [])
        stage_parent.unlink()
        datadir = self.root / "data/mariadb"
        datadir.rmdir()
        datadir.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(db.InitializationError, "symbolic links"):
            db.initialize(self.root)

    def test_validation_requires_real_system_tables_and_checks_both_fresh_accounts(self):
        process = self.process()
        process.poll.return_value = None
        replies = [subprocess.CompletedProcess([], 0, "root@localhost\n"),
                   subprocess.CompletedProcess([], 0, ""),
                   subprocess.CompletedProcess([], 0, "mysql@localhost\n")]
        with mock.patch.object(db.subprocess, "Popen", return_value=process) as launch, \
                mock.patch.object(db, "query", side_effect=replies) as query, \
                mock.patch.object(db, "stop_process") as stop:
            db.validate_database(self.root / "data/mariadb", fresh=True)
        command = launch.call_args.args[0]
        self.assertIn("--skip-networking", command)
        self.assertEqual(command[:4], ["/usr/sbin/runuser", "-u", "mysql", "--"])
        sql = query.call_args_list[1].args[1]
        for table in db.SYSTEM_TABLES:
            self.assertIn(f"mysql.`{table}`", sql)
        self.assertEqual(query.call_args_list[2].args[2], "mysql")
        stop.assert_called_once_with(process)

    def test_wrong_socket_identity_and_broken_system_tables_are_rejected(self):
        for replies in ([subprocess.CompletedProcess([], 0, "root@localhost\n"),
                         subprocess.CompletedProcess([], 1, "")],
                        [subprocess.CompletedProcess([], 0, "root@localhost\n"),
                         subprocess.CompletedProcess([], 0, ""),
                         subprocess.CompletedProcess([], 0, "unexpected@localhost\n")]):
            with self.subTest(replies=len(replies)):
                process = self.process()
                process.poll.return_value = None
                with mock.patch.object(db.subprocess, "Popen", return_value=process), \
                        mock.patch.object(db, "query", side_effect=replies), \
                        mock.patch.object(db, "stop_process") as stop:
                    with self.assertRaises(db.InitializationError):
                        db.validate_database(self.root / "data/mariadb", fresh=True)
                stop.assert_called_once_with(process)

    def test_termination_escalates_only_the_private_process_group(self):
        process = self.process()
        process.pid = 54321
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("fixture", 15), 0]
        with mock.patch.object(db.os, "killpg") as kill:
            db.stop_process(process)
        self.assertEqual(kill.call_args_list, [mock.call(54321, db.signal.SIGTERM), mock.call(54321, db.signal.SIGKILL)])

    def test_validation_timeout_stops_the_private_process(self):
        process = self.process()
        process.poll.return_value = None
        with mock.patch.object(db.subprocess, "Popen", return_value=process), \
                mock.patch.object(db, "stop_process") as stop:
            with self.assertRaisesRegex(db.InitializationError, "timed out"):
                db.validate_database(self.root / "data/mariadb", timeout=0)
        stop.assert_called_once_with(process)

    def test_interruption_during_bootstrap_stops_private_process_and_keeps_stage(self):
        process = self.process()
        process.wait.side_effect = db.InitializationInterrupted("interrupted")
        with mock.patch.object(db.subprocess, "Popen", return_value=process), \
                mock.patch.object(db, "stop_process") as stop:
            with self.assertRaises(db.InitializationInterrupted):
                db.initialize(self.root)
        stop.assert_called_once_with(process)
        self.assertEqual(list((self.root / "data/mariadb").iterdir()), [])
        self.assertEqual(len(list((self.root / "data/mariadb-init").iterdir())), 1)

    def test_interruption_during_validation_stops_process_and_cleans_its_socket(self):
        process = self.process()
        process.poll.return_value = None
        datadir = self.root / "data/mariadb"
        private_socket = socket.socket(socket.AF_UNIX)
        self.addCleanup(private_socket.close)
        def interrupted(*args):
            private_socket.bind(str(datadir / ".initialize.sock"))
            (datadir / ".initialize.pid").write_text("123456")
            raise db.InitializationInterrupted("interrupted")
        with mock.patch.object(db.subprocess, "Popen", return_value=process), \
                mock.patch.object(db, "query", side_effect=interrupted), \
                mock.patch.object(db, "stop_process") as stop:
            with self.assertRaises(db.InitializationInterrupted):
                db.validate_database(datadir)
        stop.assert_called_once_with(process)
        self.assertFalse((datadir / ".initialize.sock").exists())
        self.assertFalse((datadir / ".initialize.pid").exists())

    def test_main_catches_real_sigterm_and_restores_handlers_without_traceback(self):
        previous = {value: signal.getsignal(value) for value in (signal.SIGTERM, signal.SIGINT)}
        stderr = io.StringIO()
        with mock.patch.object(db, "initialize", side_effect=lambda root: os.kill(os.getpid(), signal.SIGTERM)), \
                mock.patch.object(db.sys, "argv", ["initialize-mariadb.py", "--root", str(self.root)]), \
                mock.patch.object(db.sys, "stderr", stderr):
            self.assertEqual(db.main(), 1)
        self.assertIn("interrupted", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())
        for value, handler in previous.items():
            self.assertEqual(signal.getsignal(value), handler)

    def test_bootstrap_timeout_stops_the_private_process_and_preserves_stage(self):
        process = self.process()
        process.wait.side_effect = subprocess.TimeoutExpired("fixture", 180)
        with mock.patch.object(db.subprocess, "Popen", return_value=process), \
                mock.patch.object(db, "stop_process") as stop:
            with self.assertRaisesRegex(db.InitializationError, "timed out"):
                db.initialize(self.root)
        stop.assert_called_once_with(process)
        self.assertEqual(list((self.root / "data/mariadb").iterdir()), [])


class DatabaseLock(unittest.TestCase):
    def test_concurrent_helper_is_rejected_and_lock_can_be_reused(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent)
            (root / "config").mkdir()
            info = SimpleNamespace(st_mode=0o100600, st_uid=0)
            with mock.patch.object(db.os, "fstat", return_value=info):
                with db.instance_lock(root):
                    with self.assertRaisesRegex(db.InitializationError, "Another MariaDB"):
                        with db.instance_lock(root):
                            self.fail("Second initializer entered the critical section")
                with db.instance_lock(root):
                    pass

    def test_lock_symlink_does_not_modify_target(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent)
            (root / "config").mkdir()
            target = root / "keep"
            target.write_text("do not touch")
            (root / "config/mariadb-initialization.lock").symlink_to(target)
            with self.assertRaises(OSError):
                with db.instance_lock(root):
                    self.fail("Symlink accepted")
            self.assertEqual(target.read_text(), "do not touch")


if __name__ == "__main__":
    unittest.main()
