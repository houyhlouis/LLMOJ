#!/usr/bin/env python3
"""deploy/doctor.py against a synthetic installation and a substitute host.

Nothing on this machine is read or changed apart from the temporary directory: services, HTTP answers, Redis,
MariaDB, disks and file owners all come from the fake host.
"""
import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1]/'doctor.py'
spec = importlib.util.spec_from_file_location('doctor', MODULE)
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

SECRETS = ('session-secret-7f3a', 'database-password-91c2', 'redis-password-55d0', 'minio-secret-key-e81b',
           'maintenance-key-0c9d', 'judge-key-a4f6', 'master-key-bytes-3b2e')
ROOTFS = 'a' * 64
USERS = {0: 'root', 1001: 'libreoj', 1002: 'mysql', 1003: 'redis'}
UID = {name: uid for uid, name in USERS.items()}
GIB = 1024 ** 3

HEALTHY_METRICS = '''# HELP libreoj_judge_clients libreoj_judge_clients
# TYPE libreoj_judge_clients gauge
libreoj_judge_clients{state="accepting"} 1
libreoj_judge_clients{state="draining"} 0
libreoj_judge_jobs{state="Queued"} 0
libreoj_judge_jobs{state="Leased"} 0
libreoj_judge_oldest_queued_job_seconds 0
libreoj_judge_expired_leases 0
libreoj_judge_failed_jobs_last_day 0
libreoj_statistics_outbox_pending 0
libreoj_statistics_outbox_oldest_seconds 0
libreoj_ai_jobs{state="queued"} 0
libreoj_ai_jobs{state="running"} 0
libreoj_ai_oldest_queued_job_seconds 0
libreoj_ai_paused 0
process_resident_memory_bytes 123456789
'''


def metrics(**changes):
    text = HEALTHY_METRICS
    for series, value in changes.items():
        lines = [line for line in text.splitlines() if not line.startswith(series + ' ') and not line.startswith(series + '{')]
        text = '\n'.join(lines) + '\n' + value + '\n'
    return text


class FakeHost(d.Host):
    def __init__(self, root):
        self.root = root
        self.units = {name: {'LoadState': 'loaded', 'ActiveState': 'active', 'UnitFileState': 'enabled', 'NRestarts': '0',
                             'ControlGroup': '/system.slice/' + name}
                      for name in (*d.WEB_SERVICES, d.JUDGE_SERVICE, 'libreoj.target')}
        self.answers = {
            'http://127.0.0.1:2002/api/health/live': (200, b'{"status":"ok"}'),
            'http://127.0.0.1:2002/api/health/ready': (200, json.dumps({'status': 'ready', 'checks': {
                'database': 'ok', 'redis': 'ok', 'storage': 'ok'}}).encode()),
            'http://127.0.0.1:80/api/auth/getSessionInfo': (200, b'{}'),
            'http://127.0.0.1:19000/minio/health/live': (200, b''),
            'http://127.0.0.1:2020/metrics': (200, HEALTHY_METRICS.encode()),
        }
        self.redis = {'redis_version': '8.0.2', 'aof_enabled': '1', 'aof_last_write_status': 'ok',
                      'rdb_last_bgsave_status': 'ok', 'used_memory': str(10 * 1024 ** 2),
                      'maxmemory': str(192 * 1024 ** 2), 'maxmemory_policy': 'noeviction', 'connected_clients': '20',
                      'rejected_connections': '0'}
        self.database = '11.8.6-MariaDB-5ubuntu0.1\t60\t6\t3250000'
        self.certificate_end = None
        self.disk = SimpleNamespace(f_bavail=400 * GIB // 4096, f_frsize=4096, f_bsize=4096, f_blocks=500 * GIB // 4096,
                                    f_files=10 ** 7, f_favail=9 * 10 ** 6)
        self.files = {}
        self.texts = {
            '/proc/meminfo': 'MemTotal:        3500000 kB\nMemAvailable:    2000000 kB\n',
            f'/sys/fs/cgroup/system.slice/{d.JUDGE_SERVICE}/cgroup.controllers': 'cpuset cpu io memory pids\n',
        }
        self.mounts = set()
        self.clock = time.time()
        self.maintenance = False
        self.commands = []
        self.urls = []
        self.synchronized = 'yes'

    def run(self, args, env=None, timeout=20):
        args = list(map(str, args))
        self.commands.append((args, env))
        if args[0] == 'redis-cli':
            ok = env == {'REDISCLI_AUTH': 'redis-password-55d0'}
            return subprocess.CompletedProcess(args, 0 if ok else 1, '# Server\r\n' + ''.join(f'{k}:{v}\r\n' for k, v in self.redis.items()) if ok else '', '')
        if args[0] == 'mariadb':
            return subprocess.CompletedProcess(args, 0, self.database + '\n', '')
        if args[0] == 'openssl' and '-enddate' in args:
            return subprocess.CompletedProcess(args, 0, f'notAfter={self.certificate_end}\n', '')
        if args[0] == 'openssl':
            return subprocess.CompletedProcess(args, 0, f'Hostname {args[args.index("-checkhost") + 1]} does match certificate\n', '')
        if args[0] == 'timedatectl':
            return subprocess.CompletedProcess(args, 0, self.synchronized + '\n', '')
        if args[0] == 'du':
            return subprocess.CompletedProcess(args, 0, ''.join(f'{1500 * 1024 ** 2}\t{path}\n' for path in args[3:]), '')
        raise AssertionError(f'unexpected command {args[0]}')

    def which(self, name):
        return '/usr/bin/' + name

    def http(self, url, timeout=5):
        self.urls.append(url)
        return self.answers.get(url, (None, None))

    def unit(self, name):
        return self.units.get(name, {'LoadState': 'not-found', 'ActiveState': 'inactive'})

    def lstat(self, path):
        return self.files.get(str(path)) or os.lstat(path)

    def user(self, uid):
        return USERS.get(uid, str(uid))

    def group(self, gid):
        return USERS.get(gid, str(gid))

    def statvfs(self, path):
        return self.disk

    def ismount(self, path):
        return str(path) in self.mounts

    def read(self, path):
        return self.texts[str(path)] if str(path) in self.texts else Path(path).read_text()

    def now(self):
        return self.clock

    def maintenance_running(self):
        return self.maintenance


class Installation:
    """A synthetic all-in-one installation in a temporary directory."""

    def __init__(self, directory, role='all', origin='http://192.168.1.20'):
        self.root = Path(directory)/'LLMOJ'
        root = self.root
        for name in ('config', 'data/ai', 'data/mariadb', 'data/minio', 'data/redis', 'backups/upgrade/20261017T144437Z-cae047f2',
                     f'runtime/rootfs-{ROOTFS}', 'deploy/sandbox'):
            (root/name).mkdir(parents=True, exist_ok=True)
        (root/'runtime/sandbox-rootfs').symlink_to(f'rootfs-{ROOTFS}')
        state = {'version': 3, 'root': str(root), 'publicOrigin': origin, 'port': 80, 'listenAddress': '0.0.0.0',
                 'role': role, 'rootfsId': ROOTFS, 'sourceCommit': '1234567890abcdef'}
        (root/'config/install-complete.json').write_text(json.dumps(state))
        (root/'config/install-state.json').write_text(json.dumps(state))
        (root/'config/backend.yaml').write_text(f'''server:
  hostname: 127.0.0.1
  port: 2002
metrics:
  hostname: 127.0.0.1
  basePort: 2020
services:
  database:
    type: mariadb
    database: libreoj
    username: libreoj
    password: database-password-91c2
  minio:
    default:
      endpoint: http://127.0.0.1:19000
    accessKey: minio-access
    secretKey: minio-secret-key-e81b
    bucket: libreoj-files
  redis: redis://:redis-password-55d0@127.0.0.1:16379/0
security:
  sessionSecret: session-secret-7f3a
  maintainceKey: maintenance-key-0c9d
''')
        self.workspaces = [str(root/f'data/judge/work/{i}') for i in (1, 2)]
        (root/'config/judge.yaml').write_text(json.dumps({
            'key': 'judge-key-a4f6', 'taskWorkingDirectories': self.workspaces,
            'sandbox': {'rootfs': str(root/'runtime/sandbox-rootfs'), 'rootfsId': ROOTFS},
            'aiRunnerSocket': str(root/'data/judge/ai-runner.sock')}))
        for name in ('secrets.json', 'minio.env', 'mariadb.cnf', 'redis.conf', 'nginx.conf'):
            (root/'config'/name).write_text('# private\n')
        (root/'data/ai/master.key').write_text('master-key-bytes-3b2e')
        (root/'backups/upgrade/20261017T144437Z-cae047f2/manifest.json').write_text(json.dumps(
            {'status': 'complete', 'provenance': {'commit': '3397a39883e0381bb7180056a071c51bccba2edf'}}))
        self.backup = root/'backups/libreoj-20261017T150000Z.tar.gz'
        self.backup.write_bytes(b'backup')
        Path(str(self.backup) + '.sha256').write_text('digest\n')

    def host(self):
        host = FakeHost(self.root)
        host.mounts.update(self.workspaces)
        root = str(self.root)
        expected = {
            'config/backend.yaml': ('root', 'libreoj', 0o640), 'config/secrets.json': ('root', 'root', 0o600),
            'config/minio.env': ('root', 'root', 0o600), 'config/install-state.json': ('root', 'root', 0o600),
            'config/install-complete.json': ('root', 'root', 0o600), 'config/mariadb.cnf': ('root', 'mysql', 0o640),
            'config/redis.conf': ('root', 'redis', 0o640), 'config/judge.yaml': ('root', 'root', 0o600),
            'data/ai': ('libreoj', 'libreoj', 0o700), 'data/ai/master.key': ('libreoj', 'libreoj', 0o600),
            'data/mariadb': ('mysql', 'mysql', 0o750), 'data/minio': ('libreoj', 'libreoj', 0o750),
            'data/redis': ('redis', 'redis', 0o750),
        }
        for relative, (user, group, mode) in expected.items():
            kind = stat.S_IFDIR if (self.root/relative).is_dir() else stat.S_IFREG
            host.files[f'{root}/{relative}'] = SimpleNamespace(st_mode=kind | mode, st_uid=UID[user], st_gid=UID[group],
                                                                st_mtime=host.clock)
        host.files[str(self.backup)] = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_mtime=host.clock - 3600)
        host.files[f'{root}/data/judge/ai-runner.sock'] = SimpleNamespace(st_mode=stat.S_IFSOCK | 0o660, st_uid=0, st_gid=0, st_mtime=0)
        return host


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='doctor-test-')
        self.addCleanup(self.tmp.cleanup)
        self.install = Installation(self.tmp.name)
        self.host = self.install.host()

    def run_doctor(self, language='en', host=None):
        with patch.dict(os.environ, {'LLMOJ_LANG': language}):
            report = d.Doctor(self.install.root, host or self.host).run()
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                d.print_report(report, self.install.root)
        return report, output.getvalue()

    def found(self, report, level, pattern):
        return [item for item in report.items if item['status'] == level and __import__('re').search(pattern, item['message'])]

    def assertReported(self, report, level, pattern):
        self.assertTrue(self.found(report, level, pattern),
                        f'no {level} matching {pattern!r} in:\n' + '\n'.join(f'{i["status"]} {i["message"]}' for i in report.items))

    def test_healthy_installation(self):
        report, text = self.run_doctor()
        problems = [item for item in report.items if item['status'] in (d.WARN, d.FAIL)]
        self.assertEqual(problems, [])
        for section in ('Installation', 'Services', 'Backend', 'Redis', 'Database', 'Object storage', 'Judging on this server',
                        'Work queues', 'This server', 'Files and permissions', 'Backups'):
            self.assertIn('\n' + section + '\n', text)
        self.assertReported(report, d.INFO, r'site and judge; version 3397a39883e0, upgraded 2026-10-17 14:44 UTC')
        self.assertReported(report, d.OK, r'The backend is ready')
        self.assertReported(report, d.OK, r'1 judge machines take submissions')
        self.assertReported(report, d.INFO, r'192\.168\.1\.20 uses plain HTTP')
        self.assertIn('Summary: ', text)

    def test_no_secret_is_printed_or_put_on_a_command_line(self):
        for language in ('en', 'zh-CN'):
            report, text = self.run_doctor(language)
            dumped = json.dumps(report.items, ensure_ascii=False)
            for secret in SECRETS:
                self.assertNotIn(secret, text)
                self.assertNotIn(secret, dumped)
        for args, env in self.host.commands:
            for secret in SECRETS:
                self.assertFalse(any(secret in arg for arg in args), args)
        self.assertTrue(any(args[0] == 'redis-cli' and env == {'REDISCLI_AUTH': 'redis-password-55d0'} for args, env in self.host.commands))

    def test_unready_backend_and_failed_services(self):
        self.host.answers['http://127.0.0.1:2002/api/health/ready'] = (503, json.dumps(
            {'status': 'unavailable', 'checks': {'database': 'ok', 'redis': 'failed', 'storage': 'ok'}}).encode())
        self.host.units['libreoj-minio.service']['ActiveState'] = 'failed'
        self.host.units['libreoj-backend.service']['NRestarts'] = '4'
        self.host.units['libreoj.target']['UnitFileState'] = 'disabled'
        report, _ = self.run_doctor()
        self.assertReported(report, d.FAIL, r"The backend can't reach Redis")
        self.assertReported(report, d.FAIL, r"libreoj-minio.service isn't running \(failed\)")
        self.assertReported(report, d.WARN, r'restarted itself 4 times')
        self.assertReported(report, d.WARN, r"libreoj.target isn't enabled")

    def test_backend_down_or_older(self):
        self.host.answers.pop('http://127.0.0.1:2002/api/health/live')
        report, _ = self.run_doctor()
        self.assertReported(report, d.FAIL, r"The backend doesn't answer on port 2002")
        host = self.install.host()
        host.answers['http://127.0.0.1:2002/api/health/live'] = (404, b'{}')
        host.answers['http://127.0.0.1:2002/api/health/ready'] = (404, b'{}')
        host.answers['http://127.0.0.1:2020/metrics'] = (200, b'process_resident_memory_bytes 1\n')
        report, _ = self.run_doctor(host=host)
        self.assertReported(report, d.WARN, r'no readiness check \(an older version\)')
        self.assertReported(report, d.INFO, r'reports no queue details')
        self.assertFalse(self.found(report, d.FAIL, '.'))

    def test_judging_and_queues(self):
        self.host.answers['http://127.0.0.1:2020/metrics'] = (200, metrics(**{
            'libreoj_judge_clients': 'libreoj_judge_clients{state="accepting"} 0\nlibreoj_judge_clients{state="draining"} 0',
            'libreoj_judge_jobs': 'libreoj_judge_jobs{state="Queued"} 12\nlibreoj_judge_jobs{state="Leased"} 0',
            'libreoj_judge_oldest_queued_job_seconds': 'libreoj_judge_oldest_queued_job_seconds 2400',
            'libreoj_judge_expired_leases': 'libreoj_judge_expired_leases 2',
            'libreoj_judge_failed_jobs_last_day': 'libreoj_judge_failed_jobs_last_day 3',
            'libreoj_statistics_outbox_oldest_seconds': 'libreoj_statistics_outbox_oldest_seconds 900',
            'libreoj_ai_jobs': 'libreoj_ai_jobs{state="queued"} 2\nlibreoj_ai_jobs{state="running"} 1',
            'libreoj_ai_oldest_queued_job_seconds': 'libreoj_ai_oldest_queued_job_seconds 7200',
            'libreoj_ai_worker_errors': 'libreoj_ai_worker_errors{stage="worker"} 5',
        }).encode())
        report, _ = self.run_doctor()
        self.assertReported(report, d.FAIL, r'No judge machine is connected')
        self.assertReported(report, d.FAIL, r'12 submissions wait; the oldest for 40 min')
        self.assertReported(report, d.WARN, r'2 judging tasks lost their judge machine')
        self.assertReported(report, d.WARN, r'3 judging tasks failed in the last day')
        self.assertReported(report, d.WARN, r'counts are 15 min behind')
        self.assertReported(report, d.WARN, r'2 AI jobs wait; the oldest for 2 h 0 min')
        self.assertReported(report, d.WARN, r'5 errors since the backend started')

        # Unknown values (a failed reading) aren't taken as healthy
        self.host.answers['http://127.0.0.1:2020/metrics'] = (200, metrics(**{
            'libreoj_judge_oldest_queued_job_seconds': 'libreoj_judge_oldest_queued_job_seconds Nan'}).encode())
        report, _ = self.run_doctor()
        self.assertReported(report, d.WARN, r"judge queue couldn't be read")

        # All judges draining; AI paused
        self.host.answers['http://127.0.0.1:2020/metrics'] = (200, metrics(**{
            'libreoj_judge_clients': 'libreoj_judge_clients{state="accepting"} 0\nlibreoj_judge_clients{state="draining"} 2',
            'libreoj_ai_paused': 'libreoj_ai_paused 1'}).encode())
        report, _ = self.run_doctor()
        self.assertReported(report, d.WARN, r'All 2 connected judge machines are draining')
        self.assertReported(report, d.INFO, r'AI is paused')

    def test_sandbox_cgroups_and_workspaces(self):
        (self.install.root/'runtime/sandbox-rootfs').unlink()
        (self.install.root/'runtime/rootfs-other').mkdir()
        (self.install.root/'runtime/sandbox-rootfs').symlink_to('rootfs-other')
        self.host.texts[f'/sys/fs/cgroup/system.slice/{d.JUDGE_SERVICE}/cgroup.controllers'] = 'cpuset cpu io pids\n'
        self.host.mounts.discard(self.install.workspaces[1])
        self.host.files.pop(f'{self.install.root}/data/judge/ai-runner.sock')
        report, _ = self.run_doctor()
        self.assertReported(report, d.FAIL, r"sandbox image doesn't match")
        self.assertReported(report, d.FAIL, r"can't limit memory")
        self.assertReported(report, d.FAIL, r"1 judge workspaces aren't mounted")
        self.assertReported(report, d.WARN, r'AI runner socket is missing')

    def test_redis_problems(self):
        self.host.redis.update(rdb_last_bgsave_status='err', used_memory=str(180 * 1024 ** 2), connected_clients='4321',
                               rejected_connections='17', maxmemory_policy='allkeys-lru')
        report, _ = self.run_doctor()
        self.assertReported(report, d.FAIL, r"Redis couldn't write its data to disk")
        self.assertReported(report, d.WARN, r'Redis uses 180\.0 MiB of 192\.0 MiB \(94%\)')
        self.assertReported(report, d.WARN, r'Redis has 4321 connections')
        self.assertReported(report, d.WARN, r'refused 17 connections')
        self.assertReported(report, d.WARN, r'evicts keys')

    def test_disk_memory_and_clock(self):
        self.host.disk.f_bavail = 512 * 1024 ** 2 // 4096
        self.host.texts['/proc/meminfo'] = 'MemTotal:        3500000 kB\nMemAvailable:     200000 kB\n'
        self.host.synchronized = 'no'
        report, _ = self.run_doctor()
        self.assertReported(report, d.FAIL, r'512\.0 MiB free \(0%\)')
        self.assertReported(report, d.WARN, r'memory available')
        self.assertReported(report, d.WARN, r"clock isn't synchronized")

    def test_permissions(self):
        root = str(self.install.root)
        self.host.files[f'{root}/config/secrets.json'].st_mode = stat.S_IFREG | 0o644
        self.host.files[f'{root}/data/ai/master.key'].st_uid = 0
        self.host.files[f'{root}/config/redis.conf'].st_mode = stat.S_IFREG | 0o660
        self.host.files[f'{root}/config/minio.env'] = SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0, st_gid=0, st_mtime=0)
        self.host.files[f'{root}/config/install-state.json'].st_mode = stat.S_IFREG | 0o640
        self.host.files[str(self.install.backup)].st_mode = stat.S_IFREG | 0o644
        report, _ = self.run_doctor()
        self.assertReported(report, d.FAIL, r'config/secrets\.json can be read or changed by other users \(mode 644, expected 600\)')
        self.assertReported(report, d.FAIL, r'config/redis\.conf can be read or changed by other users')
        self.assertReported(report, d.FAIL, r'config/minio\.env is a symbolic link')
        self.assertReported(report, d.FAIL, r'backups/libreoj-20261017T150000Z\.tar\.gz can be read')
        self.assertReported(report, d.WARN, r'config/install-state\.json has broader permissions')
        self.assertReported(report, d.WARN, r'data/ai/master\.key belongs to root:libreoj, expected libreoj:libreoj')

    def test_backups(self):
        self.host.files[str(self.install.backup)].st_mtime = self.host.clock - 10 * 86400
        report, _ = self.run_doctor()
        self.assertReported(report, d.WARN, r'The latest backup is 10 d 0 h old')
        self.assertReported(report, d.INFO, r'verify-backup\.sh')
        os.unlink(self.install.backup)
        report, _ = self.run_doctor()
        self.assertReported(report, d.WARN, r'No backup was made with deploy/backup\.sh')
        # Upgrade backups that hold a reclaimable build copy are pointed out; a lot of them, compared with free space, warn
        (self.install.root/'backups/upgrade/20261017T144437Z-cae047f2/staging/node_modules').mkdir(parents=True)
        report, _ = self.run_doctor()
        self.assertReported(report, d.INFO, r'1 upgrade backups use 1\.5 GiB.*1 still hold a build copy')
        self.host.disk.f_bavail = 4 * GIB // 4096
        report, _ = self.run_doctor()
        self.assertReported(report, d.WARN, r'1 upgrade backups use 1\.5 GiB')

    def test_interrupted_upgrade(self):
        directory = self.install.root/'backups/upgrade/20261017T160000Z-00000000'
        directory.mkdir()
        (directory/'manifest.json').write_text(json.dumps({'status': 'maintenance'}))
        report, _ = self.run_doctor()
        self.assertReported(report, d.FAIL, r'stopped halfway \(maintenance\)')
        self.host.maintenance = True
        report, _ = self.run_doctor()
        self.assertFalse(self.found(report, d.FAIL, 'stopped halfway'))
        self.assertReported(report, d.INFO, r'upgrade, judge resize or backup is running now')

    def test_https_certificate(self):
        install = Installation(Path(self.tmp.name)/'tls', origin='https://oj.example.com')
        (install.root/'config/nginx.conf').write_text('server {\n  ssl_certificate /etc/ssl/oj.pem;\n  # ssl_certificate /old.pem;\n}\n')
        host = install.host()
        expiry = time.gmtime(host.clock + 5 * 86400)
        host.certificate_end = time.strftime('%b %e %H:%M:%S %Y GMT', expiry)
        with patch.dict(os.environ, {'LLMOJ_LANG': 'en'}):
            report = d.Doctor(install.root, host).run()
        self.assertReported(report, d.WARN, r'The certificate /etc/ssl/oj\.pem expires in [45] days')
        self.assertFalse(any('/old.pem' in ' '.join(args) for args, _ in host.commands))
        host.certificate_end = time.strftime('%b %e %H:%M:%S %Y GMT', time.gmtime(host.clock + 90 * 86400))
        with patch.dict(os.environ, {'LLMOJ_LANG': 'en'}):
            report = d.Doctor(install.root, host).run()
        self.assertReported(report, d.OK, r'The certificate /etc/ssl/oj\.pem is valid until')
        # A public address without HTTPS warns
        install = Installation(Path(self.tmp.name)/'plain', origin='http://oj.example.com')
        with patch.dict(os.environ, {'LLMOJ_LANG': 'en'}):
            report = d.Doctor(install.root, install.host()).run()
        self.assertReported(report, d.WARN, r'oj\.example\.com uses plain HTTP')

    def test_web_installation(self):
        install = Installation(Path(self.tmp.name)/'web', role='web')
        host = install.host()
        host.units.pop(d.JUDGE_SERVICE)
        host.answers['http://127.0.0.1:2020/metrics'] = (200, metrics(**{
            'libreoj_judge_clients': 'libreoj_judge_clients{state="accepting"} 0\nlibreoj_judge_clients{state="draining"} 0'}).encode())
        with patch.dict(os.environ, {'LLMOJ_LANG': 'en'}):
            report = d.Doctor(install.root, host).run()
        self.assertFalse(any(item['section'] == 'Judging on this server' for item in report.items))
        self.assertFalse(any(d.JUDGE_SERVICE in item['message'] for item in report.items))
        self.assertReported(report, d.WARN, r'No judge machine is connected')
        self.assertFalse(self.found(report, d.FAIL, '.'))

    def test_a_failing_check_does_not_hide_the_others(self):
        with patch.object(d.Doctor, 'redis', side_effect=KeyError('boom')):
            report, _ = self.run_doctor()
        self.assertReported(report, d.WARN, r'This check failed unexpectedly \(KeyError\)')
        self.assertReported(report, d.OK, r'MinIO answers')

    def test_not_an_installation(self):
        with patch.dict(os.environ, {'LLMOJ_LANG': 'en'}):
            report = d.Doctor(Path(self.tmp.name)/'missing', FakeHost(None)).run()
        self.assertReported(report, d.FAIL, r'Not a completed installation')
        self.assertEqual(len(report.items), 1)

    def test_chinese(self):
        self.host.redis['connected_clients'] = '5000'
        report, text = self.run_doctor('zh-CN')
        self.assertIn('LLMOJ 健康检查：', text)
        self.assertIn('\n服务\n', text)
        self.assertReported(report, d.WARN, r'Redis 有 5000 个连接')
        self.assertIn('汇总：', text)


class HelperTests(unittest.TestCase):
    def test_metrics_parser(self):
        parsed = d.parse_metrics('# HELP x\nlibreoj_a{state="Queued",type="x\\"y"} 2\nlibreoj_b 1.5e3\nlibreoj_c Nan\n'
                                 'libreoj_d{le="+Inf"} 4 1700000000\nnot a metric line\n')
        self.assertEqual(parsed['libreoj_a'][(('state', 'Queued'), ('type', 'x\\"y'))], 2)
        self.assertEqual(parsed['libreoj_b'][()], 1500)
        self.assertNotEqual(parsed['libreoj_c'][()], parsed['libreoj_c'][()])
        self.assertEqual(parsed['libreoj_d'][(('le', '+Inf'),)], 4)

    def test_maintenance_lock_is_only_tried(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory)/'lock'
            host = d.Host()
            self.assertFalse(host.maintenance_running(lock))
            lock.touch()
            self.assertFalse(host.maintenance_running(lock))
            with open(lock, 'w') as held:
                fcntl.flock(held, fcntl.LOCK_EX)
                self.assertTrue(host.maintenance_running(lock))
            self.assertFalse(host.maintenance_running(lock))

    def test_entry_scripts_differ_only_in_language(self):
        english = (MODULE.parent/'doctor.sh').read_text().splitlines()
        chinese = (MODULE.parent/'doctor.zh-CN.sh').read_text().splitlines()
        self.assertEqual(len(english), len(chinese))
        differing = [(a, b) for a, b in zip(english, chinese) if a != b]
        self.assertEqual([b for _, b in differing if not b.startswith('#')], ['export LLMOJ_LANG=zh-CN'])
        self.assertIn('export LLMOJ_LANG=en', english)

    def test_requires_root(self):
        if os.geteuid() == 0:
            self.skipTest('running as root')
        error = io.StringIO()
        with contextlib.redirect_stderr(error):
            self.assertEqual(d.main(['--prefix', '/nonexistent']), 2)
        self.assertIn('Run as root', error.getvalue())


if __name__ == '__main__':
    unittest.main(verbosity=2)
