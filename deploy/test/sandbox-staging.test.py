#!/usr/bin/env python3
"""Exercise staging with a real UID 999 chroot, and archive generation without Docker/network.

Run with sudo for mount/chroot coverage. Staging runs in a private mount namespace
and uses a tiny disposable rootfs; no installed judge rootfs or service is touched.
"""
import gzip
import hashlib
import io
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
STAGING_SCRIPTS = ("deploy/sandbox/stage-host.sh", "infra/sandbox-rootfs/stage.sh")


def write(path, contents, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents)
    path.chmod(mode)


class ArchiveBuild(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="llmoj-archive-test-")
        self.directory = Path(self.temporary.name)
        self.output = self.directory / "output"
        self.commands = self.directory / "bin"
        self.commands.mkdir()
        self.export = self.directory / "docker-export.tar"
        with tarfile.open(self.export, "w") as archive:
            data = b"test rootfs content\n" * 4096
            entry = tarfile.TarInfo("etc/test-content")
            entry.size = len(data)
            entry.mode = 0o644
            archive.addfile(entry, io.BytesIO(data))
        write(self.commands / "docker", """#!/usr/bin/python3
import os, shutil, sys
if os.environ.get('TEST_DOCKER_FAILURE'):
    sys.exit(17)
args = sys.argv[1:]
assert args[:2] == ['buildx', 'build']
output = args[args.index('--output') + 1]
assert output.startswith('type=tar,dest=')
shutil.copyfile(os.environ['TEST_DOCKER_EXPORT'], output.split('dest=', 1)[1])
""", 0o755)
        self.environment = dict(os.environ, OUTPUT_DIRECTORY=str(self.output),
                                TEST_DOCKER_EXPORT=str(self.export),
                                PATH=str(self.commands) + os.pathsep + os.environ["PATH"])

    def tearDown(self):
        self.temporary.cleanup()

    def run_build(self):
        return subprocess.run(["bash", str(ROOT / "infra/sandbox-rootfs/build.sh")],
                              env=self.environment, capture_output=True, text=True, timeout=30)

    def test_gzip_archive_checksum_progress_and_recipe_id(self):
        result = self.run_build()
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = subprocess.run(["bash", str(ROOT / "deploy/sandbox/build.sh"), "plan"],
                              capture_output=True, text=True, check=True)
        expected_id = re.search(r"^ROOTFS_ID=([0-9a-f]{64})$", plan.stdout, re.M)[1]
        self.assertIn("ROOTFS_ID=" + expected_id, result.stdout)
        archive = self.output / f"rootfs-{expected_id}.tar.gz"
        self.assertEqual(gzip.decompress(archive.read_bytes()), self.export.read_bytes())
        self.assertEqual(archive.read_bytes()[4:8], b"\0" * 4, "gzip must not embed a timestamp")
        checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertEqual(Path(str(archive) + ".sha256").read_text(), f"{checksum}  {archive.name}\n")
        self.assertIn("Compressing rootfs archive", result.stderr)
        self.assertIn("bytes", result.stderr)
        self.assertIn("Rootfs compression complete", result.stderr)
        self.assertTrue(all(line.startswith(("ROOTFS_ID=", "ARCHIVE="))
                            for line in result.stdout.splitlines()), result.stdout)
        self.assertEqual(list(self.output.glob(".rootfs-build-*")), [])

    def test_compression_failure_does_not_publish_partial_archive(self):
        write(self.commands / "gzip", "#!/bin/sh\nexit 23\n", 0o755)
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("ARCHIVE=", result.stdout)
        self.assertEqual(list(self.output.glob("rootfs-*")), [])
        self.assertEqual(list(self.output.glob(".rootfs-build-*")), [])

    def test_export_failure_does_not_start_compression(self):
        self.environment["TEST_DOCKER_FAILURE"] = "1"
        result = self.run_build()
        self.assertEqual(result.returncode, 17)
        self.assertNotIn("Compressing rootfs archive", result.stderr)
        self.assertEqual(list(self.output.glob("rootfs-*")), [])
        self.assertEqual(list(self.output.glob(".rootfs-build-*")), [])


@unittest.skipUnless(os.geteuid() == 0, "real mount/chroot test requires root")
class PrivateUmaskStaging(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("unshare"):
            raise unittest.SkipTest("unshare is required for isolated mount validation")
        probe = subprocess.run(["unshare", "--mount", "--propagation", "private", "true"],
                               capture_output=True, text=True)
        if probe.returncode:
            raise unittest.SkipTest("mount namespaces unavailable: " + probe.stderr.strip())

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="llmoj-stage-test-")
        self.directory = Path(self.temporary.name)
        self.repository = self.directory / "repository"
        self.destination = self.directory / "staged"
        self.destination.mkdir()
        self.fixture = self.directory / "fixture"
        for name in ("etc", "bin", "usr/bin", "proc", "dev", "run"):
            (self.fixture / name).mkdir(parents=True, exist_ok=True)
        for binary in ("/bin/bash", "/usr/bin/id"):
            self.copy_binary(binary)
        write(self.fixture / "etc/passwd", "root:x:0:0:root:/root:/bin/bash\nsandbox:x:999:999:sandbox:/:/bin/bash\n")
        write(self.fixture / "etc/group", "root:x:0:\nsandbox:x:999:\n")
        self.rootfs_id = "a" * 64
        write(self.fixture / "etc/libreoj-rootfs-id", self.rootfs_id + "\n")
        for name, minor in {"full": 7, "null": 3, "random": 8, "urandom": 9, "zero": 5}.items():
            target = self.fixture / "dev" / name
            os.mknod(target, stat.S_IFCHR | 0o666, os.makedev(1, minor))
            target.chmod(0o666)
        for name, target in {"fd": "/proc/self/fd", "stdin": "/proc/self/fd/0",
                             "stdout": "/proc/self/fd/1", "stderr": "/proc/self/fd/2"}.items():
            (self.fixture / "dev" / name).symlink_to(target)
        for directory, _, _ in os.walk(self.fixture):
            Path(directory).chmod(0o755)
        self.archive = self.directory / f"rootfs-{self.rootfs_id}.tar.gz"
        with tarfile.open(self.archive, "w:gz") as archive:
            archive.add(self.fixture, arcname=".")
        self.checksum = Path(str(self.archive) + ".sha256")
        self.checksum.write_text(hashlib.sha256(self.archive.read_bytes()).hexdigest() + "  " + self.archive.name + "\n")
        smoke = """#!/bin/bash
set -euo pipefail
[[ "$EUID" == 999 ]]
validation=/run/libreoj-rootfs-validation
[[ -x "$validation" && ! -w "$validation" ]]
[[ -r "$validation/libreoj-rootfs-smoke-test" ]]
readonly_mounts=0
while read -r mount_id parent_id device root point options rest; do
    if [[ "$point" == "$validation/"* ]]; then
        [[ ",$options," == *,ro,* ]]
        readonly_mounts=$((readonly_mounts + 1))
    fi
done < /proc/self/mountinfo
[[ "$readonly_mounts" == 3 ]]
for file in compile-java.sh compile-python.sh; do
    [[ -r "$validation/$file" && ! -w "$validation/$file" ]]
    /bin/bash "$validation/$file"
done
if ( : > "$validation/uid-999-must-not-create-files" ) 2>/dev/null; then
    echo 'validation directory became writable' >&2
    exit 31
fi
printf 'validated real uid=%s, readable helpers, no write access\\n' "$EUID"
"""
        for relative in ("deploy/sandbox/smoke-test-host.sh", "infra/sandbox-rootfs/smoke-test.sh"):
            write(self.repository / relative, smoke)
        for relative in ("apps/judge/src/languages/compile-java.sh", "apps/judge/src/languages/compile-python.sh"):
            write(self.repository / relative, "#!/bin/bash\n[[ \"$EUID\" == 999 ]]\n")

    def tearDown(self):
        self.temporary.cleanup()

    def copy_binary(self, binary):
        paths = {binary}
        dependencies = subprocess.run(["ldd", binary], capture_output=True, text=True, check=True).stdout
        paths.update(re.findall(r"(/[^\s()]+)", dependencies))
        for path in paths:
            destination = self.fixture / path.lstrip("/")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)

    def stage(self, relative, legacy=False):
        contents = (ROOT / relative).read_text()
        if legacy:
            contents = contents.replace('mkdir -m 0755 "$VALIDATION_DIRECTORY_OUTSIDE"',
                                        'mkdir "$VALIDATION_DIRECTORY_OUTSIDE"')
        script = self.repository / relative
        write(script, contents)
        environment = dict(os.environ, ARCHIVE=str(self.archive), CHECKSUM=str(self.checksum),
                           DESTINATION_PARENT=str(self.destination), LIBREOJ_X32_SUPPORTED="0")
        return subprocess.run(["unshare", "--mount", "--propagation", "private",
                               "bash", "-c", 'umask 0077; exec bash "$1"', "stage-test", str(script)],
                              env=environment, capture_output=True, text=True, timeout=30)

    def test_both_profiles_validate_as_uid_999_under_private_umask(self):
        for relative in STAGING_SCRIPTS:
            with self.subTest(profile=relative):
                result = self.stage(relative)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("validated real uid=999", result.stdout)
                staged = self.destination / f"rootfs-{self.rootfs_id}"
                self.assertTrue(staged.is_dir())
                self.assertEqual(staged.stat().st_uid, 0)
                self.assertEqual(staged.stat().st_gid, 0)
                self.assertFalse((staged / "run/libreoj-rootfs-validation").exists())
                self.assertEqual(list(self.destination.glob(".rootfs-staging-*")), [])
                shutil.rmtree(staged)

    def test_original_umask_dependent_mkdir_reproduces_permission_denied(self):
        result = self.stage(STAGING_SCRIPTS[0], legacy=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Permission denied", result.stderr)
        self.assertNotIn("validated real uid=999", result.stdout)
        self.assertEqual(list(self.destination.iterdir()), [], "failed staging must clean temporary mounts/files")

    def test_bad_checksum_is_rejected_before_staging(self):
        self.checksum.write_text("0" * 64 + "  " + self.archive.name + "\n")
        result = self.stage(STAGING_SCRIPTS[0])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Checksum mismatch", result.stderr)
        self.assertEqual(list(self.destination.iterdir()), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
