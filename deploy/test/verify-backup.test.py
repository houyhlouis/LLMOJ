#!/usr/bin/env python3
"""deploy/verify-backup.py on synthetic backups; never on a real site's data.

The archive checks run anywhere. The full check (run with sudo, needs MariaDB's mariadbd and mariadb-install-db)
builds a small database in a temporary directory under /var/tmp, archives it the way backup.sh does, and verifies
the archive and damaged copies of it. The site's own MariaDB is never contacted.
"""
import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1]/'verify-backup.py'
spec = importlib.util.spec_from_file_location('verify_backup', MODULE)
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

NODE = next((str(path) for path in (Path('/opt/LLMOJ/runtime/node/bin/node'),) if os.access(path, os.X_OK)), None) or shutil.which('node')
SECRETS = ('session-secret-5e1d', 'database-password-0a7b', 'minio-secret-9f22')


def checksum(path):
    Path(str(path) + '.sha256').write_text(hashlib.sha256(Path(path).read_bytes()).hexdigest() + f'  {path}\n')


def archive(path, entries):
    """A .tar.gz of (name, content or None for a directory, extra TarInfo fields)."""
    with tarfile.open(path, 'w:gz') as tar:
        for name, content, fields in entries:
            info = tarfile.TarInfo(name)
            for key, value in fields.items():
                setattr(info, key, value)
            if content is None and info.type == tarfile.REGTYPE:
                info.type = tarfile.DIRTYPE
            data = content.encode() if isinstance(content, str) else content
            if data is not None:
                info.size = len(data)
            tar.addfile(info, io.BytesIO(data) if data is not None else None)
    checksum(path)


class ArchiveTests(unittest.TestCase):
    """What's refused before anything is unpacked outside the temporary directory."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='verify-backup-test-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        (self.base/'work').mkdir()

    def verify(self, path):
        lines = []
        verifier = v.Verifier(path, '/nonexistent', self.base/'work', out=lines.append)
        # Only the archive steps: the database steps need root
        try:
            verifier.checksum()
            verifier.unpack()
        except v.Refused as refusal:
            verifier.add(v.FAIL, str(refusal))
        finally:
            verifier.cleanup()
        return verifier, '\n'.join(lines)

    def test_damaged_or_incomplete_archives(self):
        path = self.base/'libreoj-1.tar.gz'
        archive(path, [('config', None, {}), ('config/backend.yaml', 'x: 1\n', {}), ('data', None, {}), ('data/mariadb', None, {})])
        verifier, text = self.verify(path)
        self.assertEqual(verifier.failures(), 0, text)
        self.assertIn('matches its checksum', text)
        # Damaged: the checksum no longer matches
        with path.open('r+b') as stream:
            stream.seek(20)
            stream.write(b'\0\0\0\0')
        verifier, text = self.verify(path)
        self.assertIn("doesn't match its .sha256 checksum", text)
        # Without the database
        archive(path, [('config/backend.yaml', 'x: 1\n', {})])
        verifier, text = self.verify(path)
        self.assertIn('The backup has no data/mariadb', text)
        # Missing checksum file: a warning, then checked anyway
        os.unlink(str(path) + '.sha256')
        verifier, text = self.verify(path)
        self.assertIn('.sha256 is missing', text)

    def test_unsafe_entries_are_refused_and_nothing_leaves_the_directory(self):
        outside = self.base/'outside'
        for entries, message in [
            ([('../outside', 'x', {})], 'unexpected entry'),
            ([('/etc/evil', 'x', {})], 'unexpected entry'),
            ([('other/file', 'x', {})], 'unexpected entry'),
            ([('data/x', None, {'type': tarfile.SYMTYPE, 'linkname': '../../outside'})], 'link that leaves it'),
            ([('data/x', None, {'type': tarfile.SYMTYPE, 'linkname': '/etc/shadow'})], 'link that leaves it'),
            ([('data/dev', None, {'type': tarfile.CHRTYPE, 'devmajor': 1, 'devminor': 3})], 'device or special file'),
            ([('data/fifo', None, {'type': tarfile.FIFOTYPE})], 'device or special file'),
        ]:
            path = self.base/'unsafe.tar.gz'
            archive(path, entries)
            verifier, text = self.verify(path)
            self.assertIn(message, text, entries)
            self.assertEqual(verifier.failures(), 1)
            self.assertFalse(outside.exists())
        self.assertEqual(list((self.base/'work').iterdir()), [], 'the temporary directory is removed')

    def test_not_enough_space(self):
        path = self.base/'libreoj-2.tar.gz'
        archive(path, [('config/backend.yaml', 'x: 1\n', {}), ('data/mariadb/ibdata1', 'rows', {})])
        with patch.object(v, 'RESERVE', 10 ** 18):
            verifier, text = self.verify(path)
        self.assertIn('Not enough free space', text)

    def test_entry_scripts_differ_only_in_language(self):
        english = (MODULE.parent/'verify-backup.sh').read_text().splitlines()
        chinese = (MODULE.parent/'verify-backup.zh-CN.sh').read_text().splitlines()
        differing = [b for a, b in zip(english, chinese) if a != b and not b.startswith('#')]
        self.assertEqual(len(english), len(chinese))
        self.assertEqual(differing, ['export LLMOJ_LANG=zh-CN'])


def encrypt_ai(key, text):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = os.urandom(12)
    sealed = AESGCM(key).encrypt(iv, text.encode(), None)
    return '.'.join(base64.b64encode(part).decode() for part in (iv, sealed[-16:], sealed[:-16]))


def encrypt_two_factor(key, user_id, secret):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    iv = os.urandom(12)
    sealed = AESGCM(key).encrypt(iv, secret, f'user_two_factor:{user_id}'.encode())
    return 'v1.' + '.'.join(base64.urlsafe_b64encode(part).decode().rstrip('=') for part in (iv, sealed[-16:], sealed[:-16]))


def can_run_database():
    try:
        import cryptography  # noqa: F401  (only to build the fixture's encrypted values)
    except ImportError:
        return False
    return (os.geteuid() == 0 and shutil.which('mariadb-install-db') and os.access('/usr/sbin/mariadbd', os.X_OK)
            and shutil.which('mariadb') and NODE)


@unittest.skipUnless(can_run_database(), 'Run with sudo where MariaDB, Node.js and python3-cryptography are installed')
class FullCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Under /var/tmp, where AppArmor lets MariaDB use files of its own user
        cls.base = Path(tempfile.mkdtemp(prefix='llmoj-verify-test-', dir='/var/tmp'))
        cls.addClassCleanup(shutil.rmtree, cls.base, ignore_errors=True)
        os.chmod(cls.base, 0o711)
        cls.prefix = cls.base/'prefix'
        (cls.prefix/'runtime/node/bin').mkdir(parents=True)
        (cls.prefix/'runtime/node/bin/node').symlink_to(NODE)
        cls.site = cls.base/'site'
        site = cls.site
        for name in ('config', 'data/ai', 'data/redis', 'data/minio/oj-files', 'deploy'):
            (site/name).mkdir(parents=True)
        os.chmod(site/'data', 0o711)
        cls.ai_key, cls.two_factor_key = os.urandom(32), os.urandom(32)
        (site/'data/ai/master.key').write_bytes(cls.ai_key)
        (site/'data/ai/two-factor.key').write_bytes(cls.two_factor_key)
        (site/'data/redis/appendonly.aof').write_text('*1\r\n')
        (site/'config/backend.yaml').write_text(f'''services:
  database:
    type: mariadb
    database: oj_site
    password: {SECRETS[1]}
  minio:
    bucket: oj-files
    secretKey: {SECRETS[2]}
security:
  sessionSecret: {SECRETS[0]}
''')
        for name in ('minio.env', 'secrets.json'):
            (site/'config'/name).write_text('private\n')
        (site/'config/install-complete.json').write_text(json.dumps({'role': 'all', 'root': '/opt/LLMOJ', 'sourceCommit': 'abc123def4567'}))
        cls.files = [f'0000000{i}-0000-4000-8000-000000000000' for i in range(3)]
        for uuid in cls.files + ['ffffffff-0000-4000-8000-000000000000']:
            (site/'data/minio/oj-files'/uuid).mkdir()
            (site/'data/minio/oj-files'/uuid/'xl.meta').write_bytes(b'XL2 ')
        datadir = site/'data/mariadb'
        run = cls.base/'build-run'
        mysql = pwd.getpwnam('mysql')
        as_mysql = {'user': mysql.pw_uid, 'group': mysql.pw_gid, 'extra_groups': []}
        for directory in (datadir, run):
            directory.mkdir()
            os.chown(directory, mysql.pw_uid, mysql.pw_gid)
        subprocess.run(['mariadb-install-db', '--no-defaults', f'--datadir={datadir}', '--skip-test-db',
                        '--auth-root-authentication-method=normal'], check=True, capture_output=True, **as_mysql)
        server = subprocess.Popen(['/usr/sbin/mariadbd', '--no-defaults', f'--datadir={datadir}',
                                   f'--socket={run}/s', f'--pid-file={run}/p', f'--log-error={run}/e', '--skip-networking',
                                   '--innodb-buffer-pool-size=32M'], **as_mysql)
        sql = lambda query: subprocess.run(['mariadb', '--protocol=socket', f'--socket={run}/s', '--user=root', '-e', query],
                                           check=True, capture_output=True, text=True)
        for _ in range(120):
            if Path(f'{run}/s').exists() and subprocess.run(['mariadb', '--protocol=socket', f'--socket={run}/s', '--user=root',
                                                             '-e', 'SELECT 1'], capture_output=True).returncode == 0:
                break
            time.sleep(0.5)
        ai = [encrypt_ai(cls.ai_key, json.dumps({'apiKey': 'sk-model-key'})) for _ in range(2)]
        totp = encrypt_two_factor(cls.two_factor_key, 1, b'totp-secret-bytes')
        files = ', '.join(f"('{uuid}', 10)" for uuid in cls.files)
        sql(f'''CREATE DATABASE oj_site; USE oj_site;
CREATE TABLE `user` (id INT PRIMARY KEY); INSERT INTO `user` VALUES (1), (2);
CREATE TABLE problem (id INT PRIMARY KEY); INSERT INTO problem VALUES (1);
CREATE TABLE submission (id INT PRIMARY KEY, problemId INT); INSERT INTO submission VALUES (1, 1), (2, 1), (3, 1);
CREATE TABLE `file` (uuid CHAR(36) PRIMARY KEY, size INT); INSERT INTO `file` VALUES {files};
CREATE TABLE ai_configuration (userId INT PRIMARY KEY, encrypted LONGTEXT);
INSERT INTO ai_configuration VALUES (1, '{ai[0]}'), (2, '{ai[1]}');
CREATE TABLE user_two_factor (userId INT PRIMARY KEY, totpSecret VARCHAR(255));
INSERT INTO user_two_factor VALUES (1, '{totp}'), (2, NULL);''')
        server.terminate()
        server.wait(timeout=120)
        shutil.rmtree(run)

    def backup(self, name, change=None):
        """An archive of the site as backup.sh writes it, after `change(copy)` on a copy."""
        copy = self.base/('copy-' + name)
        if copy.exists():
            shutil.rmtree(copy)
        shutil.copytree(self.site, copy, symlinks=True)
        if change:
            change(copy)
        path = self.base/f'libreoj-{name}.tar.gz'
        subprocess.run(['tar', '--numeric-owner', '-czf', path, '-C', copy, 'config', 'data', 'deploy'], check=True)
        shutil.rmtree(copy)
        checksum(path)
        return path

    def verify(self, path, language='en'):
        work = self.base/'work'
        work.mkdir(exist_ok=True)
        lines = []
        with patch.dict(os.environ, {'LLMOJ_LANG': language}):
            code = v.Verifier(path, self.prefix, work, out=lines.append).run()
        self.assertEqual(list(work.iterdir()), [], 'the temporary copy is removed')
        text = '\n'.join(lines)
        for secret in (*SECRETS, 'sk-model-key', 'totp-secret-bytes'):
            self.assertNotIn(secret, text)
        return code, text

    def test_complete_backup(self):
        code, text = self.verify(self.backup('complete'))
        self.assertEqual(code, 0, text)
        for expected in ('matches its checksum', 'The configuration is complete', 'Redis data is included',
                         'A temporary MariaDB started', '6 tables: 2 users, 1 problems, 3 submissions, 3 files',
                         'Every table passes CHECK TABLE', 'All 3 files the database lists are in storage',
                         '1 stored objects belong to no file', 'data/ai/master.key decrypts the saved AI settings (2 checked)',
                         'data/ai/two-factor.key decrypts the authenticator secrets (1 checked)', 'The backup can be restored'):
            self.assertIn(expected, text)
        code, text = self.verify(self.backup('chinese'), 'zh-CN')
        self.assertEqual(code, 0, text)
        self.assertIn('此备份可以恢复', text)

    def test_missing_file_and_wrong_keys(self):
        def damage(copy):
            shutil.rmtree(copy/'data/minio/oj-files'/self.files[1])
            (copy/'data/ai/master.key').write_bytes(os.urandom(32))
            (copy/'data/ai/two-factor.key').unlink()
        code, text = self.verify(self.backup('damaged', damage))
        self.assertEqual(code, 1)
        self.assertIn(f'1 of 3 files are missing from storage, e.g. {self.files[1]}', text)
        self.assertIn("data/ai/master.key doesn't decrypt 2 of 2 saved AI settings", text)
        self.assertIn('data/ai/two-factor.key is missing', text)
        self.assertIn("can't be restored as it is: 3 problems", text)

    def test_damaged_database(self):
        def damage(copy):
            # The database's system tablespace overwritten
            with (copy/'data/mariadb/ibdata1').open('r+b') as stream:
                stream.seek(0)
                stream.write(os.urandom(64 * 1024))
        code, text = self.verify(self.backup('broken', damage))
        self.assertEqual(code, 1)
        self.assertRegex(text, r"MariaDB can't start on the backup's database|Damaged tables|query on the copy")


if __name__ == '__main__':
    unittest.main(verbosity=2)
