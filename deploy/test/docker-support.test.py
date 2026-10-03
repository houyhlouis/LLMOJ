#!/usr/bin/env python3
"""Test Docker mirror configuration using only disposable files."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("docker_support", DEPLOY / "docker-support.py")
docker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docker)


class DockerSources(unittest.TestCase):
    @unittest.skipUnless(shutil.which("dockerd"), "Docker's configuration validator is optional")
    def test_real_dockerd_accepts_mirrors_without_starting_daemon(self):
        with tempfile.TemporaryDirectory() as parent:
            file = Path(parent) / "daemon.json"
            file.write_text('{"log-driver":"local","live-restore":true}')
            def validate(candidate):
                result = subprocess.run([shutil.which("dockerd"), "--validate", "--config-file", str(candidate)],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(docker.configure_mirrors(file, ["https://mirror.example.invalid"], validate))

    def test_urls_reject_credentials_http_and_configuration_injection(self):
        self.assertEqual(docker.validate_url("https://example.invalid/docker-ce/"), "https://example.invalid/docker-ce")
        self.assertEqual(docker.mirrors_from("https://one.invalid, https://two.invalid/"),
                         ["https://one.invalid", "https://two.invalid"])
        for value in ("http://example.invalid", "https://user:secret@example.invalid", "https://host/path?token=x",
                      "https://host/#frag", "https://host\nSuites: evil", "https://host:bad", "https://host/{}"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                docker.validate_url(value)

    def test_default_does_not_create_or_parse_host_configuration(self):
        with tempfile.TemporaryDirectory() as parent:
            file = Path(parent) / "daemon.json"
            validate = lambda _: self.fail("Default mode should not call dockerd")
            self.assertFalse(docker.configure_mirrors(file, [], validate))
            self.assertFalse(file.exists())
            file.write_text("existing non-JSON config retained")
            self.assertFalse(docker.configure_mirrors(file, [], validate))
            self.assertEqual(file.read_text(), "existing non-JSON config retained")

    def test_merges_backs_up_and_does_not_reapply_identical_mirrors(self):
        with tempfile.TemporaryDirectory() as parent:
            file = Path(parent) / "daemon.json"
            original = b'{"log-driver":"local","live-restore":true,"registry-mirrors":["https://old.invalid"]}'
            file.write_bytes(original)
            file.chmod(0o600)
            validated = []
            def validate(candidate):
                config = json.loads(candidate.read_text())
                self.assertTrue(config["live-restore"])
                self.assertEqual(config["registry-mirrors"], ["https://new.invalid"])
                validated.append(candidate)
            self.assertTrue(docker.configure_mirrors(file, ["https://new.invalid"], validate))
            self.assertEqual(json.loads(file.read_text())["log-driver"], "local")
            backups = list(Path(parent).glob("daemon.json.llmoj-backup-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)
            self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertFalse(docker.configure_mirrors(file, ["https://new.invalid"], validate))
            self.assertEqual(len(validated), 1)
            self.assertEqual(list(Path(parent).glob('.llmoj-docker-*')), [])

    def test_failed_daemon_validation_retains_original_without_backup(self):
        with tempfile.TemporaryDirectory() as parent:
            file = Path(parent) / "daemon.json"
            file.write_text('{"log-driver":"local"}')
            original = file.read_bytes()
            def reject(_):
                raise ValueError("Candidate rejected")
            with self.assertRaises(ValueError):
                docker.configure_mirrors(file, ["https://new.invalid"], reject)
            self.assertEqual(file.read_bytes(), original)
            self.assertEqual(list(Path(parent).glob("daemon.json.llmoj-backup-*")), [])
            self.assertEqual(list(Path(parent).glob('.llmoj-docker-*')), [])

    def test_symlink_is_rejected_before_touching_target(self):
        with tempfile.TemporaryDirectory() as parent:
            target = Path(parent) / "target"
            target.write_text("keep")
            file = Path(parent) / "daemon.json"
            file.symlink_to(target)
            with self.assertRaises(ValueError):
                docker.configure_mirrors(file, ["https://mirror.invalid"], lambda _: None)
            self.assertEqual(target.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
