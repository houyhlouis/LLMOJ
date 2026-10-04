#!/usr/bin/env python3
"""No host sysctl changes: all files are temporary and sysctl is mocked."""
from contextlib import contextmanager
import importlib.util
from pathlib import Path
import os
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("redis_host", Path(__file__).resolve().parents[1] / "configure-redis-host.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RedisHostTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / "sysctl.d"

    def test_persists_and_applies_only_required_key_under_private_umask(self):
        previous = os.umask(0o077)
        try:
            with mock.patch.object(module.subprocess, "run") as run:
                filename = module.configure(self.directory)
        finally:
            os.umask(previous)
        self.assertEqual(filename.read_text(), module.CONTENT)
        self.assertEqual(filename.stat().st_mode & 0o777, 0o644)
        run.assert_called_once_with(["sysctl", "-w", "vm.overcommit_memory=1"], check=True, stdout=subprocess.DEVNULL)

    def test_retry_preserves_file_and_does_not_touch_other_sysctl_settings(self):
        with mock.patch.object(module.subprocess, "run"):
            filename = module.configure(self.directory)
            before = filename.stat().st_mtime_ns
            other = self.directory / "99-administrator.conf"
            other.write_text("net.ipv4.ip_forward = 1\n")
            module.configure(self.directory)
        self.assertEqual(filename.stat().st_mtime_ns, before)
        self.assertEqual(other.read_text(), "net.ipv4.ip_forward = 1\n")

    def test_administrator_edits_are_not_overwritten(self):
        self.directory.mkdir()
        filename = self.directory / "99-libreoj-redis.conf"
        filename.write_text("vm.overcommit_memory = 2\n")
        with mock.patch.object(module.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "differs"):
                module.configure(self.directory)
        run.assert_not_called()
        self.assertEqual(filename.read_text(), "vm.overcommit_memory = 2\n")

    def test_symlink_is_rejected_without_following_it(self):
        self.directory.mkdir()
        target = self.directory / "unrelated.conf"
        target.write_text("preserve\n")
        (self.directory / "99-libreoj-redis.conf").symlink_to(target)
        with mock.patch.object(module.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "symbolic link"):
                module.configure(self.directory)
        run.assert_not_called()
        self.assertEqual(target.read_text(), "preserve\n")

    def test_partial_first_write_is_removed_and_retry_succeeds(self):
        real_fdopen = os.fdopen

        @contextmanager
        def fail_write(fd, mode):
            with real_fdopen(fd, mode) as stream:
                writer = mock.Mock(wraps=stream)

                def partial_write(content):
                    stream.write(content[:16])
                    stream.flush()
                    raise OSError("simulated full disk")

                writer.write.side_effect = partial_write
                yield writer

        with mock.patch.object(module.os, "fdopen", side_effect=fail_write), \
                mock.patch.object(module.subprocess, "run") as run:
            with self.assertRaisesRegex(OSError, "simulated full disk"):
                module.configure(self.directory)
        run.assert_not_called()
        self.assertFalse((self.directory / "99-libreoj-redis.conf").exists())
        with mock.patch.object(module.subprocess, "run") as run:
            filename = module.configure(self.directory)
        self.assertEqual(filename.read_text(), module.CONTENT)
        run.assert_called_once()

    def test_failed_first_fsync_is_removed_and_retry_succeeds(self):
        with mock.patch.object(module.os, "fsync", side_effect=OSError("simulated fsync failure")), \
                mock.patch.object(module.subprocess, "run") as run:
            with self.assertRaisesRegex(OSError, "simulated fsync failure"):
                module.configure(self.directory)
        run.assert_not_called()
        self.assertFalse((self.directory / "99-libreoj-redis.conf").exists())
        with mock.patch.object(module.subprocess, "run"):
            filename = module.configure(self.directory)
        self.assertEqual(filename.read_text(), module.CONTENT)
        self.assertEqual(filename.stat().st_mode & 0o777, 0o644)

    def test_failed_write_does_not_remove_an_administrator_replacement(self):
        filename = self.directory / "99-libreoj-redis.conf"
        administrator_content = "vm.overcommit_memory = 2\n"

        def replace_before_failure(fd):
            filename.rename(self.directory / "original-incomplete.conf")
            filename.write_text(administrator_content)
            raise OSError("simulated fsync failure after replacement")

        with mock.patch.object(module.os, "fsync", side_effect=replace_before_failure), \
                mock.patch.object(module.subprocess, "run") as run:
            with self.assertRaisesRegex(OSError, "simulated fsync failure after replacement"):
                module.configure(self.directory)
        run.assert_not_called()
        self.assertEqual(filename.read_text(), administrator_content)

    def test_failed_kernel_update_is_reported(self):
        with mock.patch.object(module.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "sysctl")):
            with self.assertRaises(subprocess.CalledProcessError):
                module.configure(self.directory)
            filename = self.directory / "99-libreoj-redis.conf"
            self.assertEqual(filename.read_text(), module.CONTENT)
            before = filename.stat().st_mtime_ns
            with self.assertRaises(subprocess.CalledProcessError):
                module.configure(self.directory)
            self.assertEqual(filename.read_text(), module.CONTENT)
            self.assertEqual(filename.stat().st_mtime_ns, before)

    def test_non_root_command_is_rejected(self):
        with mock.patch.object(module.os, "geteuid", return_value=1000):
            with self.assertRaisesRegex(SystemExit, "sudo"):
                module.main()


if __name__ == "__main__":
    unittest.main()
