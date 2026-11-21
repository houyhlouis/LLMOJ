#!/usr/bin/env python3
"""Check source archives offline, using temporary Git indexes for synthetic fixtures."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "deploy/prepare-github.py"
SPEC = importlib.util.spec_from_file_location("prepare_github", SCRIPT)
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)


class SourcePackage(unittest.TestCase):
    def setUp(self):
        # Hook callers may have selected another work tree, object store or index.
        self.fixture_env = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
        self.fixture_env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")

    def test_checkout_archive_contains_tracked_sources_and_resolves_eslint_imports(self):
        listing = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z", "--cached", "--recurse-submodules"])
        tracked = {Path(raw.decode("utf-8")) for raw in listing.split(b"\0") if raw}
        expected = {path for path in tracked if package.exclusion_rule(path) is None}
        with tempfile.TemporaryDirectory(prefix="llmoj-source-package-") as temporary:
            directory = Path(temporary)
            archive = directory / "source.tar.gz"
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--archive", str(archive)],
                                    cwd=ROOT, capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)
            extracted = directory / "extracted"
            archived = set()
            with tarfile.open(archive, "r:gz") as source:
                for member in source:
                    self.assertTrue(member.isfile(), member.name)
                    relative = Path(member.name)
                    self.assertFalse(relative.is_absolute())
                    self.assertNotIn("..", relative.parts)
                    self.assertEqual(relative.parts[0], "LibreOJ")
                    relative = Path(*relative.parts[1:])
                    self.assertNotIn(relative, archived)
                    archived.add(relative)
                    target = extracted / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(source.extractfile(member).read())
                    target.chmod(member.mode)

            self.assertEqual(archived, expected)
            self.assertEqual(archived, set(package.source_paths()))
            for relative in expected:
                if (ROOT / relative).is_file():
                    self.assertEqual((extracted / relative).read_bytes(), (ROOT / relative).read_bytes(), str(relative))
            for name in ("upgrade.sh", "upgrade.zh-CN.sh", "eslint.airbnb-base.mjs"):
                self.assertIn(Path(name), archived)
            for name in ("upgrade.sh", "upgrade.zh-CN.sh"):
                self.assertEqual(os.access(extracted / name, os.X_OK), os.access(ROOT / name, os.X_OK))
                subprocess.run(["bash", "-n", str(extracted / name)], check=True, capture_output=True)
            self.assertTrue((extracted / "deploy/upgrade.sh").is_file())

            configs = set(extracted.rglob("eslint.config.mjs")) | set(extracted.glob("*eslint*.mjs"))
            self.assertTrue(configs)
            relative_import = re.compile(r'''(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["'](\.[^"']+)["']''')
            checked = 0
            for config in configs:
                for specifier in relative_import.findall(config.read_text()):
                    resolved = (config.parent / specifier).resolve()
                    self.assertTrue(resolved.is_relative_to(extracted), str(config))
                    self.assertTrue(resolved.is_file(), f"{config.relative_to(extracted)} imports missing {specifier}")
                    checked += 1
            self.assertGreaterEqual(checked, 2, "Check both backend and judge shared ESLint imports")

    def source_fixture(self, root, tracked):
        def paths(directory, include_untracked):
            self.assertEqual(directory, root)
            self.assertFalse(include_untracked)
            return dict.fromkeys(map(Path, tracked), b"100644")
        return mock.patch.object(package, "ROOT", root), mock.patch.object(package, "git_paths", paths)

    def git(self, root, *arguments):
        subprocess.run(["git", "-C", str(root), *arguments], env=self.fixture_env, check=True, capture_output=True)

    def copy_script(self, root):
        script = root / "deploy/prepare-github.py"
        script.parent.mkdir(parents=True)
        script.write_bytes(SCRIPT.read_bytes())
        return script

    def test_new_tracked_root_or_directory_requires_manifest_review(self):
        for name in ("new-tool.mjs", "new-package/source.ts"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("synthetic source\n")
                root_patch, listing_patch = self.source_fixture(root, [name])
                with root_patch, listing_patch:
                    with self.assertRaisesRegex(ValueError, "Unclassified tracked source path"):
                        package.source_paths()

    def test_named_exclusions_cover_secrets_runtime_data_and_build_output(self):
        examples = {
            "config/backend.yaml": "instance-configuration",
            "apps/backend/.env.local": "environment-secrets",
            "deploy/ADMIN-CREDENTIALS.txt": "private-installation-state",
            "deploy/private.pem": "private-keys",
            "runtime/node/bin/node": "instance-data",
            "data/submissions/1.txt": "instance-data",
            "apps/backend/dist/main.js": "build-output",
            "apps/backend/node_modules/example/index.js": "installed-dependencies",
            "release/source.tar.gz": "local-release-output",
            "deploy/noi/judge.yaml": "local-deployment-artifacts",
            "deploy/verification/report.json": "local-verification-output",
        }
        for name, reason in examples.items():
            with self.subTest(name=name):
                self.assertEqual(package.exclusion_rule(Path(name)), reason)
                self.assertFalse(package.included(Path(name)))
        with tempfile.TemporaryDirectory() as temporary:
            root_patch, listing_patch = self.source_fixture(Path(temporary), examples)
            with root_patch, listing_patch:
                self.assertEqual(package.source_paths(), [])
        self.assertTrue(package.included(Path("config/backend.yaml.example")))
        self.assertTrue(package.included(Path("infra/sandbox-rootfs/Dockerfile")))

    def test_missing_tracked_source_is_an_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            root_patch, listing_patch = self.source_fixture(Path(temporary), ["apps/backend/src/missing.ts"])
            with root_patch, listing_patch:
                with self.assertRaisesRegex(ValueError, "Tracked source file missing"):
                    package.source_paths()

    def test_source_symlinks_are_rejected_including_submodule_contents(self):
        for submodule in (False, True):
            with self.subTest(submodule=submodule), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.git(root, "init", "-q")
                directory = root / "apps/fixture"
                directory.mkdir(parents=True)
                if submodule:
                    self.git(directory, "init", "-q")
                    self.git(root, "update-index", "--add", "--cacheinfo", "160000," + "1" * 40 + ",apps/fixture")
                (directory / "target.ts").write_text("synthetic source\n")
                (directory / "link.ts").symlink_to("target.ts")
                self.git(directory, "add", "link.ts")
                with mock.patch.object(package, "ROOT", root), mock.patch.dict(os.environ, self.fixture_env, clear=True):
                    with self.assertRaisesRegex(ValueError, "Source symlink requires manual review"):
                        package.source_paths()

    def test_untracked_sources_require_explicit_cli_option_including_submodule_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "checkout"
            script = self.copy_script(root)
            self.git(root, "init", "-q")
            for name in (*package.SOURCE_FILES, "apps/judge/vendor/testlib/LICENSE"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            (root / ".gitignore").write_text("*.ignored\n")
            self.git(root, "add", "-f", ".")
            submodule = root / "apps/fixture"
            submodule.mkdir()
            self.git(submodule, "init", "-q")
            (submodule / "tracked.ts").touch()
            self.git(submodule, "add", "tracked.ts")
            self.git(root, "update-index", "--add", "--cacheinfo", "160000," + "1" * 40 + ",apps/fixture")
            eligible = {"deploy/new-tool.py", "apps/fixture/new.ts"}
            excluded = {"deploy/file.ignored", "deploy/.env.local", "personal-notes.txt"}
            for name in eligible | excluded:
                (root / name).write_text("synthetic fixture\n")
            for include_untracked in (False, True):
                with self.subTest(include_untracked=include_untracked):
                    archive = Path(temporary) / f"source-{include_untracked}.tar.gz"
                    arguments = ["--include-untracked"] if include_untracked else []
                    result = subprocess.run([sys.executable, "-B", str(script), *arguments, "--archive", str(archive)],
                                            env=self.fixture_env, check=True, capture_output=True, text=True)
                    self.assertIn("tracked and eligible untracked files" if include_untracked else "tracked files only", result.stdout)
                    with tarfile.open(archive) as source:
                        names = {name.removeprefix("LibreOJ/") for name in source.getnames()}
                    self.assertIn("apps/fixture/tracked.ts", names)
                    self.assertEqual(eligible & names, eligible if include_untracked else set())
                    self.assertTrue(excluded.isdisjoint(names))

    def test_installed_copy_directs_to_checkout_and_never_creates_an_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            # The installed tree must not borrow an ancestor checkout's index.
            self.git(Path(temporary), "init", "-q")
            root = Path(temporary) / "installed"
            script = self.copy_script(root)
            config = root / "config"
            config.mkdir()
            original = "1" * 40
            (config / "install-complete.json").write_text(json.dumps({"sourceRepository": "fixture-owner/project",
                                                                     "sourceCommit": original}))
            archive = root / "release/source.tar.gz"
            result = subprocess.run([sys.executable, "-B", str(script), "--archive", str(archive)],
                                    env=self.fixture_env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Use a clean checkout of the installed revision", result.stderr)
            self.assertIn("cd ~ &&\n  git clone", result.stderr)
            self.assertIn("git clone https://github.com/fixture-owner/project.git", result.stderr)
            self.assertIn(f"git checkout --detach {original}", result.stderr)
            self.assertNotIn("Traceback", result.stderr)
            self.assertFalse(archive.parent.exists())

    def test_installed_copy_matches_active_tree_after_upgrade_or_rollback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = self.copy_script(root)
            upgrade = script.with_name("upgrade.py")
            upgrade.write_bytes((ROOT / "deploy/upgrade.py").read_bytes())
            source = root / "LICENSE"

            def tree(version):
                source.write_text(version)
                return subprocess.check_output([sys.executable, "-B", str(upgrade), "--source-digest", "--source", str(root)],
                                               env=self.fixture_env, text=True).strip()

            repo = "fixture-owner/project"
            initial, previous, latest = "1" * 40, "2" * 40, "3" * 40
            (root / "config").mkdir()
            (root / "config/install-complete.json").write_text(json.dumps({
                "sourceRepository": repo, "sourceCommit": initial, "treeSha256": tree(initial),
            }))
            for name, commit, version in (("01", previous, previous), ("02", latest, latest), ("03", None, "local")):
                backup = root / "backups/upgrade" / name
                backup.mkdir(parents=True)
                (backup / "manifest.json").write_text(json.dumps({
                    "status": "complete", "provenance": {"repository": repo, "commit": commit, "treeSha256": tree(version)},
                }))
            for live, expected in ((previous, previous), (latest, latest), (initial, initial), ("local", None), ("edited", None)):
                with self.subTest(live=live):
                    source.write_text(live)
                    result = subprocess.run([sys.executable, "-B", str(script)], env=self.fixture_env, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertNotIn("Traceback", result.stderr)
                    if expected:
                        self.assertIn(f"git checkout --detach {expected}", result.stderr)
                    else:
                        self.assertIn("original release checkout", result.stderr)
                        self.assertNotIn("git checkout --detach", result.stderr)

    def test_secret_scan_still_rejects_source_without_printing_the_value(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            secret = "sk-" + "synthetic" * 5
            (root / "LICENSE").write_text(secret)
            vendor = root / "apps/judge/vendor/testlib/LICENSE"
            vendor.parent.mkdir(parents=True)
            vendor.write_text("synthetic license\n")
            paths = [Path("LICENSE"), vendor.relative_to(root)]
            with mock.patch.object(package, "ROOT", root), mock.patch.object(package, "SOURCE_FILES", {"LICENSE"}), \
                    mock.patch.object(package, "source_paths", return_value=paths), \
                    mock.patch.object(sys, "argv", [str(SCRIPT)]), contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaisesRegex(ValueError, "Possible secret in LICENSE; value withheld") as raised:
                    package.main()
                self.assertNotIn(secret, str(raised.exception) + output.getvalue())


if __name__ == "__main__":
    unittest.main()
