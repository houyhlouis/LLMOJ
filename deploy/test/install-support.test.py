#!/usr/bin/env python3
"""Boundary tests for a privileged installer, using only disposable directories."""
import argparse
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

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
                ("--judge-slots", "-1"), ("--judge-slots", "512"), ("--site-name", ""),
                ("--docker-source", "http://untrusted.invalid"),
                ("--docker-source", "https://host\nSuites: injected"),
                ("--docker-mirrors", "https://user:password@mirror.invalid"),
            ]
            for case in cases:
                with self.subTest(case=case):
                    result = self.plan("--prefix", str(root), *case)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(root.exists())

    def test_plan_accepts_auto_and_thirty_slots_without_creating_files(self):
        with tempfile.TemporaryDirectory() as parent:
            for slots in ("0", "30"):
                with self.subTest(slots=slots):
                    root = Path(parent) / "new-instance"
                    result = self.plan("--prefix", str(root), "--judge-slots", slots)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertFalse(root.exists())

    def test_validation_does_not_query_machine_capacity(self):
        module = support.judge_capacity_module()
        with mock.patch.object(module, "discover_capacity", side_effect=AssertionError("validation queried resources")), \
                mock.patch.object(support, "judge_capacity_module", return_value=module), \
                mock.patch.object(support.sys, "argv", ["install-support.py", "validate", "--root", "/tmp/llmoj-plan",
                                                     "--origin", "http://example.invalid", "--port", "80", "--judge-slots", "30"]):
            support.main()

    def test_initial_capacity_failure_is_reported_without_silently_lowering_default(self):
        module = support.judge_capacity_module()
        capacity = {"default_slots": 30, "effective_cpu_count": 32, "memory_slots": 2,
                    "reserve_memory_mib": 2048, "memory_mib": 3072}
        args = argparse.Namespace(root=Path("/tmp/no-libreoj-capacity-fixture"), role="all", judge_slots=0)
        with mock.patch.object(module, "discover_capacity", return_value=capacity), \
                mock.patch.object(support, "judge_capacity_module", return_value=module):
            with self.assertRaisesRegex(support.InstallerError, "Requested 30 slots"):
                support.check_initial_judge_capacity(args)
            args.judge_slots = 2
            support.check_initial_judge_capacity(args)

    def test_existing_judge_config_and_web_do_not_reapply_initial_default(self):
        with tempfile.TemporaryDirectory() as parent:
            root = Path(parent)
            (root / "config").mkdir()
            (root / "config/judge.yaml").write_text("preserve existing slots")
            with mock.patch.object(support, "judge_capacity_module", side_effect=AssertionError("unexpected resource query")):
                support.check_initial_judge_capacity(argparse.Namespace(root=root, role="all", judge_slots=0))
                support.check_initial_judge_capacity(argparse.Namespace(root=root, role="web", judge_slots=0))

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


# Verbatim 730-byte comment-only file shipped as usr.sbin.mariadbd by Ubuntu's
# MariaDB package, observed during the installer regression. It is not a profile.
MARIADB_PLACEHOLDER = """# This file is intentionally empty to disable apparmor by default for newer
# versions of MariaDB, while providing seamless upgrade from older versions
# and from mysql, where apparmor is used.
#
# By default, we do not want to have any apparmor profile for the MariaDB
# server. It does not provide much useful functionality/security, and causes
# several problems for users who often are not even aware that apparmor
# exists and runs on their system.
#
# Users can modify and maintain their own profile, and in this case it will
# be used.
#
# When upgrading from previous version, users who modified the profile
# will be prompted to keep or discard it, while for default installs
# we will automatically disable the profile.
"""


class AppArmorProfiles(unittest.TestCase):
    @contextmanager
    def fixture(self, content, filename="usr.sbin.mariadbd"):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            profiles = parent / "apparmor.d"
            profiles.mkdir()
            profile = profiles / filename
            profile.write_text(content)
            module = parent / "apparmor-module"
            module.mkdir()
            args = argparse.Namespace(root=parent / "instance")

            def isolated_path(value):
                # Any accidental access to another host path fails the test.
                self.assertIn(value, ("/etc/apparmor.d", "/sys/module/apparmor"))
                return profiles if value == "/etc/apparmor.d" else module

            with mock.patch.object(support, "Path", side_effect=isolated_path), \
                    mock.patch.object(support.shutil, "which", return_value="/usr/sbin/apparmor_parser"), \
                    mock.patch.object(support.subprocess, "run") as parser:
                yield args, profiles, profile, parser

    def test_blank_and_ubuntu_comment_only_placeholders_are_untouched(self):
        self.assertEqual(len(MARIADB_PLACEHOLDER.encode()), 730)
        for content in ("", " \t\n\r\n", "  # ordinary comment\n\t# second comment\n", MARIADB_PLACEHOLDER):
            with self.subTest(content=content[:40]), self.fixture(content) as (args, profiles, profile, parser):
                original = profile.read_bytes()
                support.apparmor(args)
                self.assertEqual(profile.read_bytes(), original)
                self.assertFalse((profiles / "local").exists())
                parser.assert_not_called()

    def test_hash_includes_are_active_policy_even_without_a_profile_block(self):
        for directive in ("#include <tunables/global>", "# include <tunables/global>",
                          "  #\tinclude if exists <tunables/global>", "include <tunables/global>"):
            with self.subTest(directive=directive), self.fixture(directive + "\n") as (args, profiles, profile, parser):
                with self.assertRaisesRegex(support.InstallerError, "has no local include"):
                    support.apparmor(args)
                self.assertFalse((profiles / "local").exists())
                self.assertEqual(profile.read_text(), directive + "\n")
                parser.assert_not_called()

    def test_real_profile_without_local_include_still_refuses_installation(self):
        for misleading_comment in ("", "# Example: #include <local/usr.sbin.mariadbd>\n",
                                   "# Disabled: include <local/usr.sbin.mariadbd>\n",
                                   "##include <local/usr.sbin.mariadbd>\n"):
            content = "profile mariadbd /usr/sbin/mariadbd {\n" + misleading_comment + "  /etc/mysql/ r,\n}\n"
            with self.subTest(comment=misleading_comment), self.fixture(content) as (args, profiles, profile, parser):
                with self.assertRaisesRegex(support.InstallerError, "has no local include"):
                    support.apparmor(args)
                self.assertEqual(profile.read_text(), content)
                self.assertFalse((profiles / "local").exists())
                parser.assert_not_called()

    def test_real_profiles_accept_local_include_directive_spellings(self):
        for directive in ('include <local/usr.sbin.mariadbd>', '#include <local/usr.sbin.mariadbd>',
                          '# include <local/usr.sbin.mariadbd>', '#\tinclude if exists "local/usr.sbin.mariadbd"'):
            content = "profile mariadbd /usr/sbin/mariadbd {\n  " + directive + "\n}\n"
            with self.subTest(directive=directive), self.fixture(content) as (args, profiles, profile, parser):
                support.apparmor(args)
                self.assertEqual(profile.read_text(), content)
                local = profiles / "local/usr.sbin.mariadbd"
                self.assertIn(f'"{args.root}/config/mariadb.cnf" r,', local.read_text())
                parser.assert_called_once_with(["apparmor_parser", "-r", str(profile)], check=True)

    def test_existing_local_rules_are_preserved_and_retries_do_not_duplicate(self):
        content = 'profile mariadbd {\n  # include if exists <local/usr.sbin.mariadbd>\n}\n'
        with self.fixture(content) as (args, profiles, profile, parser):
            local = profiles / "local/usr.sbin.mariadbd"
            local.parent.mkdir()
            existing = '# existing administrator policy\n/existing/path r,\n'
            local.write_text(existing)
            support.apparmor(args)
            first = local.read_bytes()
            support.apparmor(args)
            self.assertEqual(local.read_bytes(), first)
            self.assertTrue(local.read_text().startswith(existing))
            self.assertEqual(local.read_text().count(f"# LibreOJ installer: {args.root}"), 1)
            self.assertEqual(parser.call_count, 2)
            self.assertEqual(profile.read_text(), content)

    def test_ubuntu26_named_profile_gets_scoped_staging_rules_without_capabilities(self):
        content = 'include <tunables/global>\nprofile mariadbd /usr/sbin/mariadbd flags=(attach_disconnected) {\n include if exists <local/mariadbd>\n}\n'
        with self.fixture(content, "mariadbd") as (args, profiles, profile, parser):
            support.apparmor(args)
            local = (profiles / "local/mariadbd").read_text()
            self.assertIn(f'"{args.root}/data/mariadb-init/" r,', local)
            self.assertIn(f'"{args.root}/data/mariadb-init/**" rwk,', local)
            self.assertNotIn("capability", local)
            self.assertNotIn("complain", local)
            self.assertEqual(profile.read_text(), content)

    def test_previous_installer_marker_is_upgraded_without_duplicate_old_rules(self):
        content = 'profile mariadbd {\n include if exists <local/mariadbd>\n}\n'
        with self.fixture(content, "mariadbd") as (args, profiles, profile, parser):
            local = profiles / "local/mariadbd"
            local.parent.mkdir()
            old_rule = f'"{args.root}/data/mariadb/**" rwk,'
            old = f'# LibreOJ installer: {args.root}\n{old_rule}\n# administrator\n/keep r,\n'
            local.write_text(old)
            support.apparmor(args)
            first = local.read_bytes()
            support.apparmor(args)
            self.assertEqual(local.read_bytes(), first)
            self.assertEqual(local.read_text().count(old_rule), 1)
            self.assertIn(f'"{args.root}/data/mariadb-init/**" rwk,', local.read_text())
            self.assertTrue(local.read_text().startswith(old))

    def test_local_include_symlink_is_rejected_without_changing_its_target(self):
        with self.fixture('#include <local/usr.sbin.mariadbd>\n') as (args, profiles, profile, parser):
            victim = profiles.parent / "unrelated-policy"
            victim.write_text("keep existing unrelated policy\n")
            local = profiles / "local/usr.sbin.mariadbd"
            local.parent.mkdir()
            local.symlink_to(victim)
            with self.assertRaisesRegex(support.InstallerError, "Refusing symbolic link"):
                support.apparmor(args)
            self.assertEqual(victim.read_text(), "keep existing unrelated policy\n")
            self.assertTrue(local.is_symlink())
            parser.assert_not_called()

    def test_placeholder_does_not_hide_another_active_candidate(self):
        with self.fixture(MARIADB_PLACEHOLDER) as (args, profiles, placeholder, parser):
            active = profiles / "usr.sbin.mysqld"
            active.write_text('profile mysqld {\n  #include <local/usr.sbin.mysqld>\n}\n')
            support.apparmor(args)
            self.assertEqual(placeholder.read_text(), MARIADB_PLACEHOLDER)
            self.assertFalse((profiles / "local/usr.sbin.mariadbd").exists())
            self.assertTrue((profiles / "local/usr.sbin.mysqld").is_file())
            parser.assert_called_once_with(["apparmor_parser", "-r", str(active)], check=True)


if __name__ == "__main__":
    unittest.main()
