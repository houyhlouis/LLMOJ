#!/usr/bin/env python3
"""Check that a backup made by deploy/backup.sh can be restored, without touching the running site.

The archive is checked against its .sha256 file and unpacked into a private temporary directory. A separate MariaDB
is started on that copy of the database (no network, its own socket) to check every table, then the stored files
are compared with the database, and the key files are tried on the encrypted values they protect. Finally the
temporary MariaDB is stopped and the copy deleted. Nothing secret is printed.
"""
import argparse
import hashlib
import json
import os
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


class Verifier:
    def __init__(self, backup, prefix, work_dir, keep=False, mysql_user='mysql', out=print):
        self.backup = Path(backup)
        self.prefix = Path(prefix)
        self.work_dir = Path(work_dir)
        self.keep = keep
        self.mysql_user = mysql_user
        self.out = out
        self.items = []
        self.directory = None
        self.server = None

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

    def unpack(self):
        self.directory = Path(tempfile.mkdtemp(prefix='llmoj-verify-', dir=self.work_dir))
        # The temporary MariaDB (as its own user) must be able to reach its copy of the database inside.
        os.chmod(self.directory, 0o711)
        self.unpacked, self.files = 0, 0
        try:
            with tarfile.open(self.backup, 'r:gz') as archive:
                archive.extractall(self.directory, numeric_owner=True, filter=self.member_filter)
        except (tarfile.TarError, EOFError, OSError, ValueError) as error:
            raise Refused(say(f'The archive can\'t be unpacked ({type(error).__name__})', f'无法解开归档（{type(error).__name__}）'))
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
        if missing:
            self.add(FAIL, say(f'{len(missing)} of {len(uuids)} files are missing from storage, e.g. {", ".join(missing[:3])}',
                               f'存储中缺少 {len(uuids)} 个文件中的 {len(missing)} 个，例如 {", ".join(missing[:3])}'))
        else:
            self.add(OK, say(f'All {len(uuids)} files the database lists are in storage', f'数据库列出的 {len(uuids)} 个文件都在存储中'))
        unused = len(present - set(uuids))
        if unused:
            self.add(INFO, say(f'{unused} stored objects belong to no file (unfinished uploads; maintenance deletes them)',
                               f'{unused} 个存储对象不属于任何文件（未完成的上传；维护任务会删除它们）'))

    # 4. Keys

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
            for step in (self.checksum, self.unpack, self.configuration, self.start_database, self.tables, self.objects, self.keys):
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
    parser.add_argument('backup', help=say('the .tar.gz file', '.tar.gz 文件'))
    here = Path(__file__).resolve().parents[1]
    parser.add_argument('--prefix', default=os.environ.get('HYHOJ_ROOT') or (str(here) if (here/'runtime').is_dir() else '/opt/LLMOJ'),
                        help=say('the installation whose MariaDB and Node.js are used', '使用其 MariaDB 和 Node.js 的安装目录'))
    # AppArmor lets the system MariaDB use its own files and those under /var/tmp and /tmp only.
    parser.add_argument('--work-dir', default='/var/tmp', help=say('where the temporary copy goes (default /var/tmp)',
                                                                  '临时副本的位置（默认 /var/tmp）'))
    parser.add_argument('--keep', action='store_true', help=say('keep the unpacked copy for inspection', '保留解开的副本以便检查'))
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        print(say('Run as root: the backup is private, and the temporary database runs as the mysql user.',
                  '请以 root 运行：备份是私有的，临时数据库以 mysql 用户运行。'), file=sys.stderr)
        return 2
    os.umask(0o077)
    verifier = Verifier(args.backup, args.prefix, args.work_dir, keep=args.keep)

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
