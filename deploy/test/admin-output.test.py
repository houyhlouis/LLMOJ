#!/usr/bin/env python3
"""Exercise the real controlling-terminal/stdout paths using synthetic credentials."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import termios
import time
import unittest

DEPLOY = Path(__file__).resolve().parents[1]
NODE = os.environ.get("LIBREOJ_TEST_NODE") or shutil.which("node")
PASSWORD = "SYNTHETIC_TEST_PASSWORD_12345678"


@unittest.skipUnless(NODE and os.name == "posix", "Node and POSIX terminals are required")
class AdministratorOutput(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="llmoj-admin-output-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.credentials = self.root / "admin-credentials.json"
        self.fixture = self.root / "show.mjs"
        self.fixture.write_text('''
import { pathToFileURL } from "node:url";
const { fileCredentialStore, showAdminCredentials } = await import(pathToFileURL(process.argv[2]));
const credentialStore = fileCredentialStore(process.argv[4]);
const password = "SYNTHETIC_TEST_PASSWORD_12345678";
await credentialStore.write({ version: 1, username: "admin", userId: 42, password });
const connection = { query: async () => [{ id: 42, username: "admin", isAdmin: 1, password: "synthetic-hash" }] };
const bcrypt = { compare: async (plain, hash) => plain === password && hash === "synthetic-hash" };
await showAdminCredentials({ connection, bcrypt, credentialStore, language: process.argv[3], environment: {} });
''')

    def command(self, language):
        return [NODE, str(self.fixture), str(DEPLOY / "bootstrap-admin.mjs"), language, str(self.credentials)]

    def assert_details(self, output, language):
        self.assertIn("管理员用户名: admin" if language == "zh-CN" else "Administrator username: admin", output)
        self.assertIn(PASSWORD, output)
        self.assertIn(str(self.credentials), output)
        self.assertIn("0600", output)
        stat = self.credentials.stat()
        self.assertEqual(stat.st_uid, os.geteuid())
        self.assertEqual(stat.st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(self.credentials.read_text())["password"], PASSWORD)

    def test_no_controlling_terminal_falls_back_to_stdout_in_both_languages(self):
        for language in ("en", "zh-CN"):
            with self.subTest(language=language):
                result = subprocess.run(self.command(language), stdin=subprocess.DEVNULL,
                                        capture_output=True, text=True, start_new_session=True,
                                        timeout=15, check=True)
                self.assert_details(result.stdout, language)
                self.assertEqual(result.stderr, "")

    def test_controlling_terminal_receives_credentials_while_stdout_is_redirected(self):
        for language in ("en", "zh-CN"):
            with self.subTest(language=language):
                master, slave = pty.openpty()

                def terminal_session():
                    os.setsid()
                    fcntl.ioctl(0, termios.TIOCSCTTY, 0)

                try:
                    process = subprocess.Popen(self.command(language), stdin=slave,
                                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                               preexec_fn=terminal_session)
                    os.close(slave)
                    slave = None
                    output = bytearray()
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        ready, _, _ = select.select([master], [], [], 0.1)
                        if ready:
                            try:
                                chunk = os.read(master, 65536)
                            except OSError:
                                break  # Linux PTYs report EIO after the last slave closes.
                            if not chunk:
                                break
                            output.extend(chunk)
                        elif process.poll() is not None:
                            break
                    stdout, stderr = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 0, stderr.decode())
                    self.assertEqual(stdout, b"")
                    self.assertEqual(stderr, b"")
                    self.assert_details(output.decode(), language)
                finally:
                    if slave is not None:
                        os.close(slave)
                    os.close(master)


if __name__ == "__main__":
    unittest.main()
