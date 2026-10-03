#!/usr/bin/env python3
"""Boundary tests for a privileged installer, using only disposable directories."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("install_support", DEPLOY / "install-support.py")
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)


class InstallerBoundaries(unittest.TestCase):
    def plan(self, *args):
        return subprocess.run(["bash", str(DEPLOY / "install.sh"), "--plan", *args],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def test_plan_is_read_only_for_a_new_destination(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / "new-instance"
            result = self.plan("--prefix", str(root), "--public-url", "http://example.invalid:29533")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(root.exists())
            self.assertIn("random-password admin", result.stdout)

    def test_invalid_ports_urls_and_prefixes_fail_before_creating_files(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / "new-instance"
            cases = [
                ("--port", "0"), ("--port", "13306"), ("--port", "65536"),
                ("--public-url", "http://name:invalid"), ("--public-url", "http://user:password@host"),
                ("--public-url", "http://host/path"), ("--prefix", "/"),
                ("--prefix", "/tmp/bad path"),
                ("--listen", "::"), ("--role", "judge"),
                ("--judge-slots", "8"), ("--site-name", ""),
                ("--docker-source", "http://untrusted.invalid"),
                ("--docker-source", "https://host\nSuites: injected"),
                ("--docker-mirrors", "https://user:password@mirror.invalid"),
            ]
            for case in cases:
                with self.subTest(case=case):
                    result = self.plan("--prefix", str(root), *case)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(root.exists())

    def test_public_port_80_and_web_role_plans_do_not_install(self):
        result = self.plan("--public-url", "http://example.invalid", "--site-name", "AI Test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Listen address: 0.0.0.0:80", result.stdout)
        self.assertIn("Site origin: http://example.invalid\n", result.stdout)
        result = self.plan("--role", "web", "--listen", "127.0.0.1", "--port", "8080")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Role: web", result.stdout)
        self.assertIn("Listen address: 127.0.0.1:8080", result.stdout)

    @unittest.skipUnless(os.geteuid() == 0, "private state ownership needs root")
    def test_retry_rejects_changed_listener_role_or_name(self):
        with tempfile.TemporaryDirectory() as parent:
            args = argparse.Namespace(root=Path(parent) / "instance", origin="http://example.invalid", port=80,
                                      listen_address="127.0.0.1", role="all", site_name="AI Test", judge_slots=0)
            support.claim(args)
            for field, value in (("listen_address", "0.0.0.0"), ("role", "web"), ("site_name", "Other"),
                                 ("docker_source", "https://mirror.invalid/docker-ce"),
                                 ("docker_mirrors", "https://mirror.invalid")):
                original = getattr(args, field, support.state_for(args).get(
                    "dockerSource" if field == "docker_source" else "dockerMirrors"))
                setattr(args, field, value)
                with self.assertRaises(support.InstallerError):
                    support.claim(args)
                setattr(args, field, original)

    def test_both_languages_show_selected_docker_sources_without_installing(self):
        for script, language in (("install.sh", "Site name: LLMOJ"), ("install.zh-CN.sh", "站名：LLMOJ")):
            result = subprocess.run(["bash", str(DEPLOY / script), "--plan", "--docker-source",
                                     "https://packages.invalid/docker-ce", "--docker-mirrors",
                                     "https://images.invalid", "--public-url", "http://example.invalid"],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(language, result.stdout)
            self.assertIn("https://packages.invalid/docker-ce/linux/ubuntu", result.stdout)
            self.assertIn("https://images.invalid", result.stdout)

    @unittest.skipUnless(os.geteuid() == 0, "private state ownership needs root")
    def test_retry_preserves_state_and_rejects_changed_arguments(self):
        with tempfile.TemporaryDirectory() as parent:
            args = argparse.Namespace(root=Path(parent) / "instance", origin="http://example.invalid:29533", port=29533)
            support.claim(args)
            state = args.root / "config/install-state.json"
            content = state.read_bytes()
            self.assertEqual(state.stat().st_mode & 0o777, 0o600)
            support.claim(args)
            self.assertEqual(state.read_bytes(), content)
            args.origin = "http://different.invalid:29533"
            with self.assertRaises(ValueError):
                support.claim(args)
            self.assertEqual(state.read_bytes(), content)

    @unittest.skipUnless(os.geteuid() == 0, "private state ownership needs root")
    def test_unknown_database_and_private_config_are_not_adopted(self):
        for kind in ("data", "config"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as parent:
                root = Path(parent) / "instance"
                (root / kind).mkdir(parents=True)
                existing = root / kind / ("database-file" if kind == "data" else "secrets.json")
                existing.write_text("private existing data")
                args = argparse.Namespace(root=root, origin="http://example.invalid:29533", port=29533)
                with self.assertRaises(ValueError):
                    support.claim(args)
                self.assertEqual(existing.read_text(), "private existing data")
                self.assertFalse((root / "config/install-state.json").exists())

    @unittest.skipUnless(os.geteuid() == 0, "private state ownership needs root")
    def test_metadata_symlink_never_writes_outside_destination(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent) / "instance"
            (root / "config").mkdir(parents=True)
            victim = Path(parent) / "victim"
            victim.write_text("keep")
            (root / "config/install-state.json").symlink_to(victim)
            args = argparse.Namespace(root=root, origin="http://example.invalid:29533", port=29533)
            with self.assertRaises(ValueError):
                support.claim(args)
            self.assertEqual(victim.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
