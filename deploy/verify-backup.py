#!/usr/bin/env python3
"""Check that a backup made by deploy/backup.sh can be restored, without touching the running site.

The archive is checked against its .sha256 file, decrypted if backup.sh encrypted it (with the private key in the
GnuPG keyring), and unpacked into a private temporary directory. A separate MariaDB is started on that copy of the
database (no network, its own socket) to check every table, then the stored files are compared with the database,
and a temporary MinIO on the copy of the storage reads every file whose content hash is recorded to compare it.
The key files are tried on the encrypted values they protect. Finally the temporary servers are stopped and the copy
deleted. Nothing secret is printed.
"""
import argparse
import datetime
import hashlib
import hmac
import http.client
import json
import os
import socket
import urllib.parse
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

OK, INFO, WARN, FAIL = 'ok', 'info', 'warn', 'fail'
GIB = 1024 ** 3
# Free space kept while unpacking
RESERVE = GIB
TOP_LEVEL = {'config', 'data', 'deploy'}
CORE_TABLES = ('user', 'problem', 'submission', 'file')


def say(english, chinese):
    """A message in the entry script's language: verify-backup.zh-CN.sh sets LLMOJ_LANG=zh-CN."""
    return chinese if os.environ.get('LLMOJ_LANG') == 'zh-CN' else english


def size_text(value):
    for unit, factor in (('GiB', GIB), ('MiB', 1024 ** 2), ('KiB', 1024)):
        if value >= factor:
            return f'{value / factor:.1f} {unit}'
    return f'{value} B'


class Refused(Exception):
    """The backup failed a check that the following checks depend on."""


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class Storage:
    """Reads objects from a MinIO server with S3 signature version 4 (path style, region us-east-1)."""

    def __init__(self, port, access_key, secret_key):
        self.host = f'127.0.0.1:{port}'
        self.access_key = access_key
        self.secret_key = secret_key

    def signed_headers(self, path, method='GET', body=b''):
        now = datetime.datetime.now(datetime.timezone.utc)
        stamp, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
        empty = hashlib.sha256(body).hexdigest()
        names = 'host;x-amz-content-sha256;x-amz-date'
        canonical = f'{method}\n{path}\n\nhost:{self.host}\nx-amz-content-sha256:{empty}\nx-amz-date:{stamp}\n\n{names}\n{empty}'
        scope = f'{day}/us-east-1/s3/aws4_request'
        to_sign = f'AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}'
        key = ('AWS4' + self.secret_key).encode()
        for part in (day, 'us-east-1', 's3', 'aws4_request'):
            key = hmac.new(key, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
        return {'Host': self.host, 'x-amz-content-sha256': empty, 'x-amz-date': stamp,
                'Authorization': f'AWS4-HMAC-SHA256 Credential={self.access_key}/{scope}, SignedHeaders={names}, Signature={signature}'}

    def digest(self, bucket, key):
        """The SHA-256 and size of an object's content, or None if it can't be read."""
        path = f'/{bucket}/{urllib.parse.quote(key, safe="")}'
        connection = http.client.HTTPConnection(self.host, timeout=300)
        try:
            connection.request('GET', path, headers=self.signed_headers(path))
            response = connection.getresponse()
            if response.status != 200:
                response.read()
                return None
            digest, size = hashlib.sha256(), 0
            for block in iter(lambda: response.read(1024 * 1024), b''):
                digest.update(block)
                size += len(block)
            return digest.hexdigest(), size
        except (OSError, http.client.HTTPException):
            return None
        finally:
            connection.close()


class Verifier:
    def __init__(self, backup, prefix, work_dir, keep=False, mysql_user='mysql', out=print, contents=True,
                 storage_user='nobody'):
        self.backup = Path(backup)
        self.prefix = Path(prefix)
        self.work_dir = Path(work_dir)
        self.keep = keep
        self.mysql_user = mysql_user
        self.storage_user = storage_user
        self.check_contents = contents
        self.out = out
        self.items = []
        self.directory = None
        self.server = None
        self.minio = None

    def add(self, level, message):
        self.items.append((level, message))
        labels = {OK: say('OK', '正常'), INFO: say('INFO', '信息'), WARN: say('WARN', '警告'), FAIL: say('FAIL', '失败')}
        self.out(f'  {labels[level]:<4}  {message}')

    def failures(self):
        return sum(level == FAIL for level, _ in self.items)

    # 1. The archive

    def checksum(self):
        if not self.backup.is_file():
            raise Refused(say(f'{self.backup} isn\'t a file', f'{self.backup} 不是文件'))
        summed = Path(str(self.backup) + '.sha256')
        digest = hashlib.sha256()
        with self.backup.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        if not summed.is_file():
            self.add(WARN, say(f'{summed.name} is missing: the archive can\'t be checked for damage',
                               f'缺少 {summed.name}：无法检查归档是否损坏'))
            return
        expected = summed.read_text().split()[:1]
        if expected != [digest.hexdigest()]:
            raise Refused(say('The archive doesn\'t match its .sha256 checksum: it\'s damaged or incomplete',
                              '归档与其 .sha256 校验值不符：已损坏或不完整'))
        self.add(OK, say(f'The archive matches its checksum ({size_text(self.backup.stat().st_size)})',
                         f'归档与校验值一致（{size_text(self.backup.stat().st_size)}）'))

    def member_filter(self, member, destination):
        """Unpack only what backup.sh writes, never outside the temporary directory, and never device files."""
        parts = Path(member.name).parts
        if not parts or parts[0] not in TOP_LEVEL or member.name.startswith('/') or '..' in parts:
            raise Refused(say(f'The archive contains an unexpected entry: {member.name[:80]}',
                              f'归档包含意外条目：{member.name[:80]}'))
        if not (member.isreg() or member.isdir() or member.issym() or member.islnk()):
            raise Refused(say(f'The archive contains a device or special file: {member.name[:80]}',
                              f'归档包含设备或特殊文件：{member.name[:80]}'))
        try:
            # Also refuses links to absolute paths or outside the directory; owners aren't restored.
            member = tarfile.data_filter(member, destination)
        except tarfile.FilterError:
            raise Refused(say(f'The archive contains a link that leaves it: {member.name[:80]}',
                              f'归档包含指向外部的链接：{member.name[:80]}'))
        if member.isreg():
            info = os.statvfs(destination)
            if info.f_bavail * info.f_frsize < member.size + RESERVE:
                raise Refused(say(f'Not enough free space in {self.work_dir} to unpack the backup (use --work-dir)',
                                  f'{self.work_dir} 空间不足，无法解开备份（可用 --work-dir 指定其他目录）'))
            self.unpacked += member.size
        self.files += member.isreg()
        return member

    def decrypt(self):
        """An encrypted backup (.gpg) is decrypted into the private directory, with the keyring's private key."""
        gpg = shutil.which('gpg')
        if not gpg:
            raise Refused(say('The backup is encrypted, and gpg isn\'t installed here', '备份已加密，但本机未安装 gpg'))
        decrypted = self.directory/'.archive.tar.gz'
        result = subprocess.run([gpg, '--batch', '--quiet', '--yes', '--decrypt', '--output', str(decrypted), str(self.backup)],
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=3600)
        if result.returncode or not decrypted.is_file():
            decrypted.unlink(missing_ok=True)
            raise Refused(say('The encrypted backup can\'t be decrypted: import the private key it was encrypted for '
                              '(gpg --import) on this machine first', '无法解密已加密的备份：请先在本机导入其加密所用的私钥（gpg --import）'))
        self.add(OK, say('The encrypted backup was decrypted with the private key', '已用私钥解密加密的备份'))
        return decrypted

    def unpack(self):
        self.directory = Path(tempfile.mkdtemp(prefix='llmoj-verify-', dir=self.work_dir))
        # The temporary MariaDB (as its own user) must be able to reach its copy of the database inside.
        os.chmod(self.directory, 0o711)
        self.unpacked, self.files = 0, 0
        archive_file = self.decrypt() if self.backup.name.endswith('.gpg') else self.backup
        try:
            with tarfile.open(archive_file, 'r:gz') as archive:
                archive.extractall(self.directory, numeric_owner=True, filter=self.member_filter)
        except (tarfile.TarError, EOFError, OSError, ValueError) as error:
            raise Refused(say(f'The archive can\'t be unpacked ({type(error).__name__})', f'无法解开归档（{type(error).__name__}）'))
        finally:
            if archive_file != self.backup:
                archive_file.unlink(missing_ok=True)
        for required in ('config/backend.yaml', 'data/mariadb'):
            if not (self.directory/required).exists():
                raise Refused(say(f'The backup has no {required}', f'备份中没有 {required}'))
        os.chmod(self.directory/'data', 0o711)
        self.add(OK, say(f'Unpacked {self.files} files ({size_text(self.unpacked)}) into a temporary directory',
                         f'已将 {self.files} 个文件（{size_text(self.unpacked)}）解到临时目录'))

    def configuration(self):
        import yaml
        try:
            config = yaml.safe_load((self.directory/'config/backend.yaml').read_text()) or {}
        except (OSError, yaml.YAMLError):
            raise Refused(say('config/backend.yaml in the backup can\'t be read', '备份中的 config/backend.yaml 无法读取'))
        self.database_name = str(((config.get('services') or {}).get('database') or {}).get('database') or '')
        self.bucket = str(((config.get('services') or {}).get('minio') or {}).get('bucket') or '')
        if not re.fullmatch(r'[A-Za-z0-9_]+', self.database_name) or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,62}', self.bucket):
            raise Refused(say('config/backend.yaml in the backup names no database or bucket',
                              '备份中的 config/backend.yaml 没有数据库名或存储桶名'))
        missing = [name for name in ('config/minio.env', 'config/secrets.json') if not (self.directory/name).is_file()]
        if not ((config.get('security') or {}).get('sessionSecret')) or missing:
            self.add(WARN, say('The backup\'s configuration is incomplete: ' + ', '.join(missing or ['security.sessionSecret']),
                               '备份中的配置不完整：' + '、'.join(missing or ['security.sessionSecret'])))
        else:
            self.add(OK, say('The configuration is complete', '配置完整'))
        try:
            state = json.loads((self.directory/'config/install-complete.json').read_text())
            commit = str(state.get('sourceCommit') or '')[:12]
            self.add(INFO, say(f'Made on a {state.get("role")} installation at {state.get("root")}, installed from {commit or "?"}',
                               f'来自 {state.get("root")} 的 {state.get("role")} 安装，安装版本 {commit or "?"}'))
        except (OSError, ValueError):
            pass
        redis = self.directory/'data/redis'
        if redis.is_dir() and any(redis.iterdir()):
            self.add(OK, say('Redis data is included: sessions and queued work as of the backup',
                             '包含 Redis 数据：备份时的会话和排队的工作'))
        else:
            self.add(WARN, say('No Redis data: everyone has to sign in again after a restore', '没有 Redis 数据：恢复后所有人需要重新登录'))

    # 2. The database, in a temporary MariaDB

    def start_database(self):
        mariadbd = shutil.which('mariadbd') or '/usr/sbin/mariadbd'
        if not os.access(mariadbd, os.X_OK):
            raise Refused(say('MariaDB (mariadbd) isn\'t installed on this machine', '本机未安装 MariaDB（mariadbd）'))
        account = pwd.getpwnam(self.mysql_user)
        datadir = self.directory/'data/mariadb'
        run = self.directory/'mariadb-run'
        run.mkdir(mode=0o700)
        # The copy may come from another machine, where the database user has another ID.
        for path in [run, datadir, *datadir.rglob('*')]:
            if not path.is_symlink():
                os.chown(path, account.pw_uid, account.pw_gid)
        self.socket = run/'mysql.sock'
        arguments = [mariadbd, '--no-defaults', f'--datadir={datadir}', f'--socket={self.socket}', f'--pid-file={run}/mysql.pid',
                     f'--log-error={run}/error.log', '--skip-networking', '--skip-grant-tables', '--innodb-buffer-pool-size=64M',
                     '--max-connections=10']
        # Started as the database user: AppArmor doesn't let MariaDB use root's override of file permissions.
        account_options = {'user': account.pw_uid, 'group': account.pw_gid, 'extra_groups': []} if os.geteuid() == 0 else {}
        self.server = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       start_new_session=True, **account_options)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if self.server.poll() is not None:
                break
            if self.socket.exists() and self.sql('SELECT 1', database=None, check=False).returncode == 0:
                self.add(OK, say('A temporary MariaDB started on the copy of the database', '已在数据库副本上启动临时 MariaDB'))
                return
            time.sleep(0.5)
        log = run/'error.log'
        tail = log.read_text(errors='replace').splitlines()[-5:] if log.exists() else []
        raise Refused(say('MariaDB can\'t start on the backup\'s database', '无法在备份的数据库上启动 MariaDB')
                      + ''.join('\n        ' + line[:200] for line in tail))

    def sql(self, query, database='', check=True):
        args = ['mariadb', '--protocol=socket', f'--socket={self.socket}', '--user=root', '--batch', '--skip-column-names',
                '-e', query]
        if database is not None:
            args.append(database or self.database_name)
        result = subprocess.run(args, capture_output=True, text=True, timeout=1800)
        if check and result.returncode:
            raise Refused(say('A query on the copy of the database failed', '在数据库副本上查询失败'))
        return result

    def rows(self, query):
        return [line.split('\t') for line in self.sql(query).stdout.splitlines()]

    def tables(self):
        databases = self.sql('SHOW DATABASES', database=None).stdout.split()
        if self.database_name not in databases:
            raise Refused(say(f'The backup has no database {self.database_name}', f'备份中没有数据库 {self.database_name}'))
        self.table_names = {row[0] for row in self.rows('SHOW TABLES')}
        missing = [name for name in CORE_TABLES if name not in self.table_names]
        if missing:
            raise Refused(say(f'The database lacks the tables {", ".join(missing)}', f'数据库缺少数据表 {"、".join(missing)}'))
        counts = self.rows('SELECT (SELECT COUNT(*) FROM `user`), (SELECT COUNT(*) FROM problem), '
                           '(SELECT COUNT(*) FROM submission), (SELECT COUNT(*) FROM `file`)')[0]
        users, problems, submissions, files = map(int, counts)
        self.add(OK, say(f'{len(self.table_names)} tables: {users} users, {problems} problems, {submissions} submissions, {files} files',
                         f'{len(self.table_names)} 张数据表：{users} 个用户、{problems} 道题目、{submissions} 个提交、{files} 个文件'))
        damaged = set()
        names = sorted(self.table_names)
        for start in range(0, len(names), 50):
            listed = ', '.join(f'`{name}`' for name in names[start:start + 50])
            for row in self.rows(f'CHECK TABLE {listed}'):
                # Table, Op, Msg_type, Msg_text
                if len(row) >= 4 and (row[2].lower() == 'error' or (row[2].lower() == 'status' and row[3] != 'OK')):
                    damaged.add(row[0].split('.', 1)[-1])
        if damaged:
            self.add(FAIL, say(f'Damaged tables: {", ".join(sorted(damaged))}', f'已损坏的数据表：{"、".join(sorted(damaged))}'))
        else:
            self.add(OK, say('Every table passes CHECK TABLE', '所有数据表均通过 CHECK TABLE'))

    # 3. Stored files

    def objects(self):
        bucket = self.directory/'data/minio'/self.bucket
        uuids = [row[0] for row in self.rows('SELECT uuid FROM `file`')]
        if not bucket.is_dir():
            if uuids:
                self.add(FAIL, say(f'The backup has no stored files, but the database lists {len(uuids)}',
                                   f'备份中没有存储的文件，但数据库列出了 {len(uuids)} 个'))
            return
        present = {entry.name for entry in os.scandir(bucket)
                   if (entry.is_dir(follow_symlinks=False) and os.path.isfile(os.path.join(entry.path, 'xl.meta')))
                   or entry.is_file(follow_symlinks=False)}
        missing = [uuid for uuid in uuids if uuid not in present]
        self.missing_files = set(missing)
        if missing:
            self.add(FAIL, say(f'{len(missing)} of {len(uuids)} files are missing from storage, e.g. {", ".join(missing[:3])}',
                               f'存储中缺少 {len(uuids)} 个文件中的 {len(missing)} 个，例如 {", ".join(missing[:3])}'))
        else:
            self.add(OK, say(f'All {len(uuids)} files the database lists are in storage', f'数据库列出的 {len(uuids)} 个文件都在存储中'))
        unused = len(present - set(uuids))
        if unused:
            self.add(INFO, say(f'{unused} stored objects belong to no file (unfinished uploads; maintenance deletes them)',
                               f'{unused} 个存储对象不属于任何文件（未完成的上传；维护任务会删除它们）'))

    # 4. The stored files' contents, read from a temporary MinIO on the copy

    def start_storage(self):
        minio = self.prefix/'runtime/minio'
        if not os.access(minio, os.X_OK):
            return say(f'MinIO isn\'t installed at {minio}', f'{minio} 没有安装 MinIO')
        environment = {}
        try:
            for line in (self.directory/'config/minio.env').read_text().splitlines():
                key, separator, value = line.partition('=')
                if separator and key.strip().startswith('MINIO_'):
                    environment[key.strip()] = value.strip()
        except OSError:
            pass
        if not environment.get('MINIO_ROOT_USER') or not environment.get('MINIO_ROOT_PASSWORD'):
            return say('config/minio.env has no storage credentials', 'config/minio.env 中没有存储凭据')
        data = self.directory/'data/minio'
        account = pwd.getpwnam(self.storage_user)
        if os.geteuid() == 0:
            for path in [data, *data.rglob('*')]:
                if not path.is_symlink():
                    os.chown(path, account.pw_uid, account.pw_gid)
        port, console = free_port(), free_port()
        account_options = {'user': account.pw_uid, 'group': account.pw_gid, 'extra_groups': []} if os.geteuid() == 0 else {}
        self.minio = subprocess.Popen(
            [str(minio), 'server', '--quiet', '--address', f'127.0.0.1:{port}', '--console-address', f'127.0.0.1:{console}', str(data)],
            env={'PATH': '/usr/bin:/bin', 'HOME': str(data), 'MINIO_BROWSER': 'off', **environment},
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, **account_options)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline and self.minio.poll() is None:
            connection = http.client.HTTPConnection(f'127.0.0.1:{port}', timeout=5)
            try:
                connection.request('GET', '/minio/health/ready')
                if connection.getresponse().status == 200:
                    self.storage = Storage(port, environment['MINIO_ROOT_USER'], environment['MINIO_ROOT_PASSWORD'])
                    return None
            except (OSError, http.client.HTTPException):
                pass
            finally:
                connection.close()
            time.sleep(0.5)
        return say('MinIO can\'t start on the copy of the storage', '无法在存储副本上启动 MinIO')

    def contents(self):
        if not self.check_contents:
            self.add(INFO, say('The files\' contents weren\'t read (--no-contents)', '未读取文件内容（--no-contents）'))
            return
        if not (self.directory/'data/minio'/self.bucket).is_dir():
            return
        if not self.rows("SHOW COLUMNS FROM `file` LIKE 'sha256'"):
            self.add(INFO, say('This backup records no content hashes (it was made before they were); the files\' contents weren\'t compared',
                               '此备份没有记录内容哈希（在开始记录之前生成）；未比较文件内容'))
            return
        # A file already reported missing isn't reported again
        rows = [row for row in self.rows('SELECT uuid, sha256, size FROM `file` WHERE sha256 IS NOT NULL')
                if row[0] not in getattr(self, 'missing_files', set())]
        unrecorded = int(self.rows('SELECT COUNT(*) FROM `file` WHERE sha256 IS NULL')[0][0])
        if unrecorded:
            self.add(INFO, say(f'{unrecorded} files have no recorded content hash yet (the backend computes them); their contents weren\'t compared',
                               f'{unrecorded} 个文件尚未记录内容哈希（后端会计算）；未比较其内容'))
        if not rows:
            return
        problem = self.start_storage()
        if problem:
            self.add(WARN, problem + say(': the files\' contents weren\'t read', '：未读取文件内容'))
            return
        total = sum(int(size) for _, _, size in rows)
        self.out(say(f'        Reading {len(rows)} files ({size_text(total)})…', f'        正在读取 {len(rows)} 个文件（{size_text(total)}）…'))
        unreadable, different = [], []
        for uuid, recorded, size in rows:
            result = self.storage.digest(self.bucket, uuid)
            if result is None:
                unreadable.append(uuid)
            elif result != (recorded, int(size)):
                different.append(uuid)
        if unreadable:
            self.add(FAIL, say(f'{len(unreadable)} files can\'t be read from the copy of the storage, e.g. {", ".join(unreadable[:3])}',
                               f'{len(unreadable)} 个文件无法从存储副本读取，例如 {", ".join(unreadable[:3])}'))
        if different:
            self.add(FAIL, say(f'{len(different)} files differ from their recorded content hash or size, e.g. {", ".join(different[:3])}',
                               f'{len(different)} 个文件与记录的内容哈希或大小不符，例如 {", ".join(different[:3])}'))
        if not unreadable and not different:
            self.add(OK, say(f'The contents of all {len(rows)} files match their recorded hashes ({size_text(total)} read)',
                             f'全部 {len(rows)} 个文件的内容与记录的哈希一致（读取了 {size_text(total)}）'))

    def stop_storage(self):
        if not self.minio or self.minio.poll() is not None:
            return
        self.minio.send_signal(signal.SIGTERM)
        try:
            self.minio.wait(timeout=60)
        except subprocess.TimeoutExpired:
            self.minio.kill()
            self.minio.wait()

    # 5. Keys

    def keys(self):
        ai = [row[0] for row in self.rows('SELECT encrypted FROM ai_configuration LIMIT 20')] if 'ai_configuration' in self.table_names else []
        two_factor = ([{'userId': int(row[0]), 'value': row[1]} for row in
                       self.rows('SELECT userId, totpSecret FROM user_two_factor WHERE totpSecret IS NOT NULL LIMIT 20')]
                      if 'user_two_factor' in self.table_names else [])
        node = self.prefix/'runtime/node/bin/node'
        node = str(node) if os.access(node, os.X_OK) else shutil.which('node')
        helper = Path(__file__).resolve().parent/'backup-keys.mjs'
        if not node or not helper.is_file():
            self.add(WARN, say('Node.js isn\'t available: the keys weren\'t checked', '没有 Node.js：未检查密钥'))
            return
        request = {'aiKey': str(self.directory/'data/ai/master.key'), 'twoFactorKey': str(self.directory/'data/ai/two-factor.key'),
                   'ai': ai, 'twoFactor': two_factor}
        result = subprocess.run([node, str(helper)], input=json.dumps(request), capture_output=True, text=True, timeout=120)
        try:
            checked = json.loads(result.stdout)
        except ValueError:
            self.add(FAIL, say('The keys couldn\'t be checked', '无法检查密钥'))
            return
        for name, label, file in (('ai', say('saved AI settings', '保存的 AI 设置'), 'master.key'),
                                  ('twoFactor', say('authenticator secrets', '验证器密钥'), 'two-factor.key')):
            outcome = checked[name]
            if not outcome['checked']:
                self.add(INFO, say(f'No {label} to decrypt', f'没有需要解密的{label}'))
            elif outcome['key'] != 'ok':
                self.add(FAIL, say(f'data/ai/{file} is {outcome["key"]}: the {label} in this backup can\'t be decrypted',
                                   f'data/ai/{file} {"缺失" if outcome["key"] == "missing" else "无效"}：此备份中的{label}无法解密'))
            elif outcome['failed']:
                self.add(FAIL, say(f'data/ai/{file} doesn\'t decrypt {outcome["failed"]} of {outcome["checked"]} {label}: '
                                   'it belongs to another database', f'data/ai/{file} 无法解密 {outcome["checked"]} 项{label}中的 '
                                   f'{outcome["failed"]} 项：它属于另一个数据库'))
            else:
                self.add(OK, say(f'data/ai/{file} decrypts the {label} ({outcome["checked"]} checked)',
                                 f'data/ai/{file} 能解密{label}（检查了 {outcome["checked"]} 项）'))

    def stop_database(self):
        if not self.server or self.server.poll() is not None:
            return
        self.server.send_signal(signal.SIGTERM)
        try:
            self.server.wait(timeout=120)
        except subprocess.TimeoutExpired:
            self.server.kill()
            self.server.wait()

    def cleanup(self):
        self.stop_storage()
        self.stop_database()
        if self.directory and self.directory.exists():
            if self.keep:
                self.out(say(f'\nThe unpacked copy is kept in {self.directory}; delete it when done (it holds secrets).',
                             f'\n解开的副本保留在 {self.directory}；用完请删除（其中含有密钥）。'))
            else:
                shutil.rmtree(self.directory)

    def run(self):
        self.out(say(f'Checking {self.backup}', f'检查 {self.backup}'))
        try:
            for step in (self.checksum, self.unpack, self.configuration, self.start_database, self.tables, self.objects,
                         self.contents, self.keys):
                step()
        except Refused as refusal:
            self.add(FAIL, str(refusal))
        finally:
            self.cleanup()
        failures = self.failures()
        self.out('\n' + (say(f'The backup can\'t be restored as it is: {failures} problems', f'此备份无法直接恢复：{failures} 个问题')
                         if failures else say('The backup can be restored: database, files and keys are complete',
                                              '此备份可以恢复：数据库、文件和密钥完整')))
        return 1 if failures else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=say('Check that a backup made by deploy/backup.sh can be restored',
                                                     '检查 deploy/backup.sh 生成的备份能否恢复'))
    parser.add_argument('backup', help=say('the .tar.gz (or encrypted .tar.gz.gpg) file', '.tar.gz（或加密的 .tar.gz.gpg）文件'))
    here = Path(__file__).resolve().parents[1]
    parser.add_argument('--prefix', default=os.environ.get('HYHOJ_ROOT') or (str(here) if (here/'runtime').is_dir() else '/opt/LLMOJ'),
                        help=say('the installation whose MariaDB and Node.js are used', '使用其 MariaDB 和 Node.js 的安装目录'))
    # AppArmor lets the system MariaDB use its own files and those under /var/tmp and /tmp only.
    parser.add_argument('--work-dir', default='/var/tmp', help=say('where the temporary copy goes (default /var/tmp)',
                                                                  '临时副本的位置（默认 /var/tmp）'))
    parser.add_argument('--keep', action='store_true', help=say('keep the unpacked copy for inspection', '保留解开的副本以便检查'))
    parser.add_argument('--no-contents', action='store_true', help=say('don\'t read the stored files to compare their contents',
                                                                       '不读取存储的文件来比较其内容'))
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        print(say('Run as root: the backup is private, and the temporary database runs as the mysql user.',
                  '请以 root 运行：备份是私有的，临时数据库以 mysql 用户运行。'), file=sys.stderr)
        return 2
    os.umask(0o077)
    verifier = Verifier(args.backup, args.prefix, args.work_dir, keep=args.keep, contents=not args.no_contents)

    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        return verifier.run()
    except KeyboardInterrupt:
        verifier.cleanup()
        return 130


if __name__ == '__main__':
    sys.exit(main())
