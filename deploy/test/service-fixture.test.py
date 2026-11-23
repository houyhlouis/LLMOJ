import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('fixture', Path(__file__).with_name('with-service-fixture.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class ServiceFixtureTests(unittest.TestCase):
    def test_refuses_other_layouts_and_nonprivate_directories(self):
        for name in ('registration', 'admin', 'migration', 'unexpected'):
            with self.assertRaises(ValueError):
                fixture.socket_for(name, Path('/var/lib/mysql'))
        root = Mock(spec=Path)
        root.__str__ = lambda self: '/tmp/libreoj-admin-test-private'
        root.__truediv__ = lambda self, child: Path(str(self))/child
        root.resolve.return_value = root
        root.stat.return_value = Mock(st_uid=os.getuid(), st_mode=0o700)
        self.assertEqual(fixture.socket_for('admin', root), Path(str(root))/'mysql.sock')
        with self.assertRaises(ValueError):
            fixture.socket_for('registration', root)
        root.stat.return_value.st_mode = 0o755
        with self.assertRaises(ValueError):
            fixture.socket_for('admin', root)
        root.stat.return_value.st_mode = 0o700
        root.resolve.return_value = Path('/another/directory')
        with self.assertRaises(ValueError):
            fixture.socket_for('admin', root)

    def test_bootstrap_and_daemon_get_a_private_tmpdir_even_with_an_inaccessible_caller_tmpdir(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            tmpdir = directory/'tmp'
            caller_tmp = str(directory/'nonexistent')
            with (patch.dict(os.environ, TMPDIR=caller_tmp),
                  patch.object(fixture.subprocess, 'run') as bootstrap,
                  patch.object(fixture.subprocess, 'Popen') as daemon):
                fixture.start_server(directory/'mysql.sock', directory/'db', tmpdir)
                self.assertEqual(os.environ['TMPDIR'], caller_tmp)
            for call, program in [(bootstrap.call_args, 'mariadb-install-db'), (daemon.call_args, 'mariadbd')]:
                self.assertEqual(call.args[0][0], program)
                self.assertIn('--tmpdir='+str(tmpdir), call.args[0])
                self.assertEqual(call.kwargs['env']['TMPDIR'], str(tmpdir))
            self.assertTrue(tmpdir.is_dir())
            self.assertEqual(tmpdir.stat().st_mode & 0o777, 0o700)

    def test_sql_requires_the_expected_datadir_socket_tmpdir_and_networking_disabled(self):
        socket = Mock()
        socket.__str__ = lambda self: '/private/mysql.sock'
        socket.is_socket.return_value = True
        data, tmpdir = Path('/private/db'), Path('/private/tmp')
        identity = '/private/mysql.sock\t/private/db/\t1\t/private/tmp\n'
        fixture.check_server(socket, data, tmpdir, identity)
        fixture.check_server(socket, data, tmpdir, identity.replace('/private/tmp', '/private/tmp/'))
        for wrong in (identity.replace('/db/', '/elsewhere/'), identity.replace('mysql.sock', 'other.sock'),
                      identity.replace('1', '0'), identity.replace('/private/tmp', '/caller/tmp'),
                      identity.replace('/private/tmp', '/private/tmp:/caller/tmp')):
            with self.assertRaises(ValueError):
                fixture.check_server(socket, data, tmpdir, wrong)
        socket.is_socket.return_value = False
        with self.assertRaises(ValueError):
            fixture.check_server(socket, data, tmpdir, identity)

    def test_ci_minio_publication_and_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tools = root/'test'
            tools.mkdir()
            script = tools/'build-minio.sh'
            shutil.copyfile(Path(__file__).with_name(script.name), script)
            # Exercise the CI wrapper with a small build product. Observe the flags in a child of the build.
            (root/'minio-source.sh').write_text('''build_minio() {
                printenv GOFLAGS > "$RUNNER_TEMP/flags"
                printf 'completed build' > "$1/minio"
            }
''')
            target = root/'cache/minio'
            env = {**os.environ, 'RUNNER_TEMP': tmp, 'GOFLAGS': '-trimpath', 'PATH': str(tools)+':'+os.environ['PATH']}
            command = ['bash', str(script), str(target)]
            subprocess.run(command, env=env, check=True)
            self.assertEqual((root/'flags').read_text().split(), ['-trimpath', '-modcacherw'])
            self.assertEqual(target.read_text(), 'completed build')
            self.assertTrue(os.access(target, os.X_OK))
            self.assertEqual(list(root.glob('llmoj-minio-build.*')), [])

            # Fail scratch cleanup even when the output and any staging file can still be managed.
            rm = tools/'rm'
            rm.write_text('#!/bin/bash\n[[ "${!#}" != */llmoj-minio-build.* ]] || exit 42\nexec /usr/bin/rm "$@"\n')
            rm.chmod(0o755)
            target.write_text('previous build')
            install = tools/'install'
            install.write_text('#!/bin/bash\nprintf partial > "${!#}"\nexit 23\n')
            install.chmod(0o755)
            failure = subprocess.run(command, env=env, capture_output=True)
            self.assertEqual(failure.returncode, 23)
            self.assertEqual(target.read_text(), 'previous build')
            self.assertEqual(list(target.parent.iterdir()), [target])

            install.unlink()
            success = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(success.returncode, 0, success.stderr)
            self.assertIn('Could not remove MinIO build directory', success.stderr)
            self.assertEqual(target.read_text(), 'completed build')
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_pinned_download_uses_only_bytes_matching_the_checksum(self):
        helper = Path(__file__).resolve().parents[1]/'minio-source.sh'
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp)/'archive'
            sha = hashlib.sha256(b'pinned source').hexdigest()
            script = """
set -eu
source "$1"
die() { exit 1; }
curl() { printf 'other source' > "$archive.partial"; }
download https://fixture.invalid/archive "$2" "$3"
"""
            command = ['bash', '-c', script, 'fixture', str(helper), sha, str(archive)]
            archive.write_bytes(b'pinned source')
            subprocess.run(command, check=True)
            self.assertFalse(Path(str(archive)+'.partial').exists())
            archive.write_bytes(b'invalid cached source')
            self.assertNotEqual(subprocess.run(command).returncode, 0)
            self.assertEqual(archive.read_bytes(), b'invalid cached source')
            self.assertEqual(Path(str(archive)+'.partial').read_bytes(), b'other source')


if __name__ == '__main__':
    unittest.main()
