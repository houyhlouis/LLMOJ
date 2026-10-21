#!/usr/bin/env python3
"""Read-only health report of an LLMOJ installation.

Checks the services, the backend and what it depends on, judging, the work queues, the host, file permissions and
backups. It changes nothing (it starts, stops and writes nothing) and prints no secret: no key, password, token or
configuration value other than addresses, ports, paths, versions, counts and sizes.
"""
import argparse
import datetime
import fcntl
import glob
import grp
import ipaddress
import json
import math
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

OK, INFO, WARN, FAIL = 'ok', 'info', 'warn', 'fail'
GIB = 1024 ** 3
WEB_SERVICES = ('libreoj-mariadb.service', 'libreoj-redis.service', 'libreoj-minio.service',
                'libreoj-backend.service', 'libreoj-nginx.service')
JUDGE_SERVICE = 'libreoj-judge.service'


def say(english, chinese):
    """A message in the entry script's language: doctor.zh-CN.sh sets LLMOJ_LANG=zh-CN."""
    return chinese if os.environ.get('LLMOJ_LANG') == 'zh-CN' else english


def size_text(value):
    for unit, factor in (('GiB', GIB), ('MiB', 1024 ** 2), ('KiB', 1024)):
        if value >= factor:
            return f'{value / factor:.1f} {unit}'
    return f'{value} B'


def duration_text(seconds):
    seconds = int(seconds)
    if seconds >= 86400:
        return say(f'{seconds // 86400} d {seconds % 86400 // 3600} h', f'{seconds // 86400} 天 {seconds % 86400 // 3600} 小时')
    if seconds >= 3600:
        return say(f'{seconds // 3600} h {seconds % 3600 // 60} min', f'{seconds // 3600} 小时 {seconds % 3600 // 60} 分钟')
    if seconds >= 60:
        return say(f'{seconds // 60} min', f'{seconds // 60} 分钟')
    return say(f'{seconds} s', f'{seconds} 秒')


class Host:
    """Everything the checks read from the host, so that tests can substitute it."""

    def run(self, args, env=None, timeout=20):
        try:
            return subprocess.run(list(map(str, args)), capture_output=True, text=True, timeout=timeout,
                                  env={**os.environ, **(env or {})})
        except (OSError, subprocess.TimeoutExpired):
            return subprocess.CompletedProcess(args, 127, '', '')

    def which(self, name):
        return shutil.which(name)

    def http(self, url, timeout=5):
        """(status, body) of a GET, or (None, None) without an answer."""
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'llmoj-doctor'}),
                                        timeout=timeout) as response:
                return response.status, response.read(4 * 1024 * 1024)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.read(64 * 1024)
        except Exception:
            return None, None

    def unit(self, name):
        result = self.run(['systemctl', 'show', name, '-p', 'LoadState,ActiveState,SubState,UnitFileState,NRestarts,'
                           'ControlGroup'])
        return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)

    def lstat(self, path):
        return os.lstat(path)

    def user(self, uid):
        try:
            return pwd.getpwuid(uid).pw_name
        except KeyError:
            return str(uid)

    def group(self, gid):
        try:
            return grp.getgrgid(gid).gr_name
        except KeyError:
            return str(gid)

    def statvfs(self, path):
        return os.statvfs(path)

    def ismount(self, path):
        return os.path.ismount(path)

    def read(self, path):
        return Path(path).read_text()

    def now(self):
        return time.time()

    def maintenance_running(self, path=Path('/run/libreoj-installer/lock')):
        """Whether the installer, upgrader, judge resize or backup holds the maintenance lock (tried, never kept)."""
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            return False
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
            return False
        except OSError:
            return True
        finally:
            os.close(fd)


class Report:
    def __init__(self):
        self.items = []
        self.section = ''

    def start(self, section):
        self.section = section

    def add(self, level, check, message):
        self.items.append({'section': self.section, 'status': level, 'check': check, 'message': message})

    def counts(self):
        return {level: sum(item['status'] == level for item in self.items) for level in (OK, INFO, WARN, FAIL)}


def parse_metrics(text):
    """`{name: {labels: value}}` from the Prometheus text format; labels as a sorted tuple of pairs."""
    result = {}
    for line in text.splitlines():
        match = re.fullmatch(r'([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)(?: \d+)?', line.strip())
        if not match or line.startswith('#'):
            continue
        name, labels, value = match.groups()
        pairs = tuple(sorted(re.findall(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"', labels or '')))
        try:
            result.setdefault(name, {})[pairs] = float(value)
        except ValueError:
            continue
    return result


class Doctor:
    def __init__(self, root, host=None):
        self.root = Path(root)
        self.host = host or Host()
        self.report = Report()

    # Reading the installation

    def load(self):
        import yaml
        self.install = json.loads(self.host.read(self.root/'config/install-complete.json'))
        self.role = self.install.get('role')
        self.config = yaml.safe_load(self.host.read(self.root/'config/backend.yaml')) or {}
        self.judge = None
        if self.role == 'all':
            try:
                self.judge = yaml.safe_load(self.host.read(self.root/'config/judge.yaml')) or {}
            except (OSError, yaml.YAMLError):
                self.judge = None

    def run(self):
        r = self.report
        r.start(say('Installation', '安装'))
        try:
            self.load()
        except (OSError, ValueError) as error:
            r.add(FAIL, 'installation', say(f'Not a completed installation at {self.root} ({type(error).__name__})',
                                            f'{self.root} 不是已完成的安装（{type(error).__name__}）'))
            return r
        except Exception as error:
            r.add(FAIL, 'installation', say(f'The configuration in {self.root}/config can\'t be read ({type(error).__name__})',
                                            f'无法读取 {self.root}/config 中的配置（{type(error).__name__}）'))
            return r
        for name in ('installation', 'services', 'backend', 'redis', 'database', 'storage', 'judging', 'queues',
                     'machine', 'permissions', 'backups'):
            try:
                getattr(self, name)()
            except Exception as error:  # A failing check must not hide the others.
                r.add(WARN, name, say(f'This check failed unexpectedly ({type(error).__name__})',
                                               f'此项检查意外失败（{type(error).__name__}）'))
        return r

    def installation(self):
        r = self.report
        role = {'all': say('site and judge', '网站和评测'), 'web': say('site only', '仅网站')}.get(self.role, self.role)
        version, when = None, None
        manifests = sorted(glob.glob(str(self.root/'backups/upgrade/*/manifest.json')))
        latest_complete = None
        for path in manifests:
            try:
                record = json.loads(self.host.read(path))
            except (OSError, ValueError):
                continue
            if record.get('status') == 'complete':
                latest_complete = path
                version = (record.get('provenance') or {}).get('commit')
                try:
                    when = datetime.datetime.strptime(Path(path).parent.name.split('-')[0], '%Y%m%dT%H%M%SZ').strftime('%Y-%m-%d %H:%M UTC')
                except ValueError:
                    when = None
        version = version or self.install.get('sourceCommit')
        r.add(INFO, 'version', say(f'{role}; version {str(version or "unknown")[:12]}', f'{role}；版本 {str(version or "未知")[:12]}')
              + (say(f', upgraded {when}', f'，升级于 {when}') if when else ''))
        running = self.host.maintenance_running()
        if running:
            r.add(INFO, 'maintenance', say('An installation, upgrade, judge resize or backup is running now; '
                                           'services may be stopped on purpose',
                                           '安装、升级、评测扩缩容或备份正在进行，服务可能是有意停止的'))
        for path in manifests:
            if latest_complete and path < latest_complete:
                continue
            try:
                status = json.loads(self.host.read(path)).get('status')
            except (OSError, ValueError):
                continue
            if status == 'rollback-failed' or (status == 'maintenance' and not running):
                r.add(FAIL, 'upgrade', say(f'The upgrade in {Path(path).parent} stopped halfway ({status}); '
                                           'see "Rolling back" in the upgrade guide',
                                           f'{Path(path).parent} 的升级中途停止（{status}）；见升级说明中的“回滚”'))

    def services(self):
        r = self.report
        r.start(say('Services', '服务'))
        units = [*WEB_SERVICES, *([JUDGE_SERVICE] if self.role == 'all' else [])]
        for name in units:
            unit = self.host.unit(name)
            if unit.get('LoadState') != 'loaded':
                r.add(FAIL, name, say(f'{name} isn\'t installed', f'{name} 未安装'))
            elif unit.get('ActiveState') != 'active':
                r.add(FAIL, name, say(f'{name} isn\'t running ({unit.get("ActiveState")}); see: sudo journalctl -u {name} -n 50',
                                      f'{name} 未运行（{unit.get("ActiveState")}）；查看：sudo journalctl -u {name} -n 50'))
            elif int(unit.get('NRestarts') or 0):
                r.add(WARN, name, say(f'{name} runs, but restarted itself {unit["NRestarts"]} times after failures; see its log',
                                      f'{name} 在运行，但曾因故障自动重启 {unit["NRestarts"]} 次；请查看其日志'))
            else:
                r.add(OK, name, say(f'{name} runs', f'{name} 正在运行'))
        target = self.host.unit('libreoj.target')
        if target.get('UnitFileState') not in ('enabled', 'static'):
            r.add(WARN, 'libreoj.target', say('libreoj.target isn\'t enabled: the site won\'t start after a reboot '
                                              '(sudo systemctl enable libreoj.target)',
                                              'libreoj.target 未启用：重启服务器后网站不会自动启动（sudo systemctl enable libreoj.target）'))

    def backend(self):
        r = self.report
        r.start(say('Backend', '后端'))
        port = int((self.config.get('server') or {}).get('port') or 2002)
        status, _ = self.host.http(f'http://127.0.0.1:{port}/api/health/live')
        # A backend from before the health checks answers 404 there
        if status not in (200, 404):
            r.add(FAIL, 'live', say(f'The backend doesn\'t answer on port {port}', f'后端在端口 {port} 无响应'))
            return
        status, body = self.host.http(f'http://127.0.0.1:{port}/api/health/ready')
        names = {'database': say('the database', '数据库'), 'redis': 'Redis', 'storage': say('object storage (MinIO)', '对象存储（MinIO）')}
        if status == 404:
            r.add(WARN, 'ready', say('The backend answers, but has no readiness check (an older version)',
                                     '后端有响应，但没有就绪检查（旧版本）'))
        else:
            try:
                readiness = json.loads(body)
            except (TypeError, ValueError):
                readiness = {}
            checks = readiness.get('checks') or {}
            failed = [name for name, state in checks.items() if state != 'ok']
            if status == 200 and readiness.get('status') == 'ready':
                r.add(OK, 'ready', say('The backend is ready: the database, Redis and object storage answer',
                                       '后端已就绪：数据库、Redis 和对象存储均有响应'))
            elif failed:
                for name in failed:
                    r.add(FAIL, 'ready', say(f'The backend can\'t reach {names.get(name, name)}', f'后端无法连接{names.get(name, name)}'))
            else:
                r.add(FAIL, 'ready', say('The backend isn\'t ready', '后端未就绪'))
        listen = str(self.install.get('listenAddress') or '0.0.0.0')
        address = '127.0.0.1' if listen in ('0.0.0.0', '::', '[::]', '') else listen
        address = f'[{address}]' if ':' in address and not address.startswith('[') else address
        public_port = int(self.install.get('port') or 80)
        # A route every version has, answered for visitors too
        status, _ = self.host.http(f'http://{address}:{public_port}/api/auth/getSessionInfo')
        if status == 200:
            r.add(OK, 'nginx', say(f'Nginx passes requests to the backend (port {public_port})', f'Nginx 正常把请求转发给后端（端口 {public_port}）'))
        elif status and 300 <= status < 400:
            r.add(INFO, 'nginx', say(f'Nginx redirects plain HTTP on port {public_port}; not checked through it',
                                     f'Nginx 将端口 {public_port} 的 HTTP 请求重定向，未经它检查'))
        else:
            r.add(FAIL, 'nginx', say(f'Nginx doesn\'t pass requests to the backend on port {public_port}',
                                     f'Nginx 在端口 {public_port} 未把请求转发给后端'))
        self.tls()

    def tls(self):
        r = self.report
        origin = str(self.install.get('publicOrigin') or '')
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme != 'https':
            try:
                address = ipaddress.ip_address(parsed.hostname or '')
                local = address.is_private or address.is_loopback
            except ValueError:
                local = parsed.hostname == 'localhost'
            r.add(INFO if local else WARN, 'https',
                  say(f'The site address {origin} uses plain HTTP: passwords travel unencrypted (see the HTTPS guide)',
                      f'网站地址 {origin} 使用明文 HTTP：密码以明文传输（见 HTTPS 说明）'))
            return
        try:
            nginx = self.host.read(self.root/'config/nginx.conf')
        except OSError:
            nginx = ''
        certificates = sorted(set(re.findall(r'^\s*ssl_certificate\s+([^;\s]+)\s*;', nginx, re.M)))
        if not certificates:
            r.add(INFO, 'https', say(f'{origin}: HTTPS is provided in front of this server; its certificate isn\'t checked here',
                                     f'{origin}：HTTPS 由此服务器之前的设备提供，此处不检查其证书'))
            return
        for certificate in certificates:
            result = self.host.run(['openssl', 'x509', '-noout', '-enddate', '-in', certificate])
            match = re.search(r'notAfter=(.+)', result.stdout)
            if result.returncode or not match:
                r.add(FAIL, 'https', say(f'The certificate {certificate} can\'t be read', f'无法读取证书 {certificate}'))
                continue
            expires = datetime.datetime.strptime(match[1].strip().replace('  ', ' '), '%b %d %H:%M:%S %Y %Z')
            days = (expires.replace(tzinfo=datetime.timezone.utc).timestamp() - self.host.now()) / 86400
            covered = self.host.run(['openssl', 'x509', '-noout', '-checkhost', parsed.hostname, '-in', certificate])
            if days < 0:
                r.add(FAIL, 'https', say(f'The certificate {certificate} expired on {expires:%Y-%m-%d}', f'证书 {certificate} 已于 {expires:%Y-%m-%d} 过期'))
            elif days < 14:
                r.add(WARN, 'https', say(f'The certificate {certificate} expires in {int(days)} days', f'证书 {certificate} 将在 {int(days)} 天后过期'))
            elif covered.returncode == 0 and 'does NOT match' in covered.stdout:
                r.add(WARN, 'https', say(f'The certificate {certificate} isn\'t for {parsed.hostname}', f'证书 {certificate} 不适用于 {parsed.hostname}'))
            else:
                r.add(OK, 'https', say(f'The certificate {certificate} is valid until {expires:%Y-%m-%d}', f'证书 {certificate} 有效期至 {expires:%Y-%m-%d}'))

    def redis(self):
        r = self.report
        r.start('Redis')
        url = urllib.parse.urlsplit(str((self.config.get('services') or {}).get('redis') or ''))
        if not url.port or not self.host.which('redis-cli'):
            r.add(WARN, 'redis', say('Redis not checked (no redis-cli or no Redis address)', '未检查 Redis（没有 redis-cli 或 Redis 地址）'))
            return
        password = urllib.parse.unquote(url.password or '')
        # The password is passed in the environment, never on the command line.
        result = self.host.run(['redis-cli', '-h', url.hostname or '127.0.0.1', '-p', url.port, '--no-auth-warning', 'INFO'],
                               env={'REDISCLI_AUTH': password} if password else None)
        info = dict(line.split(':', 1) for line in result.stdout.replace('\r', '').splitlines() if ':' in line and not line.startswith('#'))
        if result.returncode or 'redis_version' not in info:
            r.add(FAIL, 'redis', say('Redis doesn\'t answer', 'Redis 无响应'))
            return
        if info.get('rdb_last_bgsave_status', 'ok') != 'ok' or info.get('aof_last_write_status', 'ok') != 'ok':
            r.add(FAIL, 'persistence', say('Redis couldn\'t write its data to disk (full disk?): sessions and queued work may be lost',
                                           'Redis 无法把数据写入磁盘（磁盘已满？）：会话和排队的工作可能丢失'))
        elif info.get('aof_enabled') != '1':
            r.add(WARN, 'persistence', say('Redis keeps no append-only file: a crash loses recent sessions',
                                           'Redis 未开启 AOF：崩溃会丢失最近的会话'))
        else:
            r.add(OK, 'persistence', say('Redis saves its data to disk', 'Redis 正常将数据保存到磁盘'))
        used, limit = int(info.get('used_memory', 0)), int(info.get('maxmemory', 0))
        if limit:
            share = used / limit
            level = FAIL if share >= 0.95 else WARN if share >= 0.8 else OK
            r.add(level, 'memory', say(f'Redis uses {size_text(used)} of {size_text(limit)} ({share:.0%})'
                                       + (': when full, writes fail' if level != OK else ''),
                                       f'Redis 已用 {size_text(used)}，上限 {size_text(limit)}（{share:.0%}）'
                                       + ('：用满后写入会失败' if level != OK else '')))
        if info.get('maxmemory_policy', 'noeviction') != 'noeviction':
            r.add(WARN, 'memory', say(f'Redis evicts keys when full ({info["maxmemory_policy"]}): it can drop sessions and queued work',
                                      f'Redis 用满后会淘汰键（{info["maxmemory_policy"]}）：可能丢失会话和排队的工作'))
        clients = int(info.get('connected_clients', 0))
        if clients >= 1000:
            r.add(WARN, 'clients', say(f'Redis has {clients} connections: something keeps opening them (restart the backend and '
                                       'report it)', f'Redis 有 {clients} 个连接：有程序不断新建连接（请重启后端并报告此问题）'))
        else:
            r.add(OK, 'clients', say(f'Redis has {clients} connections', f'Redis 有 {clients} 个连接'))
        if int(info.get('rejected_connections', 0)):
            r.add(WARN, 'clients', say(f'Redis refused {info["rejected_connections"]} connections since it started',
                                       f'Redis 启动以来拒绝了 {info["rejected_connections"]} 个连接'))

    def database(self):
        r = self.report
        r.start(say('Database', '数据库'))
        socket = self.root/'data/mariadb/mysql.sock'
        name = str(((self.config.get('services') or {}).get('database') or {}).get('database') or 'libreoj')
        if not re.fullmatch(r'[A-Za-z0-9_]+', name):
            return
        query = ("SELECT @@version, @@max_connections, "
                 "(SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'THREADS_CONNECTED'), "
                 f"(SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '{name}')")
        result = self.host.run(['mariadb', '--protocol=socket', f'--socket={socket}', '--user=root', '--batch',
                                '--skip-column-names', '-e', query])
        fields = result.stdout.strip().split('\t')
        if result.returncode or len(fields) != 4:
            r.add(FAIL, 'database', say('MariaDB doesn\'t answer on its socket', 'MariaDB 未在其套接字上响应'))
            return
        version, maximum, connected, size = fields
        r.add(OK, 'database', say(f'MariaDB {version.split("-")[0]}; the site\'s data uses {size_text(int(size))}',
                                  f'MariaDB {version.split("-")[0]}；网站数据占用 {size_text(int(size))}'))
        share = int(connected) / max(1, int(maximum))
        if share >= 0.8:
            r.add(WARN, 'connections', say(f'MariaDB has {connected} of {maximum} connections in use', f'MariaDB 已使用 {connected}/{maximum} 个连接'))
        # Judges check test data against these hashes; files from before them are hashed in the background
        result = self.host.run(['mariadb', '--protocol=socket', f'--socket={socket}', '--user=root', '--batch',
                                '--skip-column-names', '-e', f'SELECT COUNT(*), COALESCE(SUM(sha256 IS NULL), 0) FROM `{name}`.`file`'])
        counts = result.stdout.strip().split('\t')
        if result.returncode == 0 and len(counts) == 2 and all(count.isdigit() for count in counts):
            total, missing = map(int, counts)
            if missing:
                r.add(INFO, 'content hashes', say(f'{missing} of {total} stored files have no content hash yet; the backend '
                                                  'computes them in the background, up to 1 GiB a minute',
                                                  f'{total} 个已存文件中有 {missing} 个尚无内容哈希；后端在后台计算，每分钟最多 1 GiB'))
            elif total:
                r.add(OK, 'content hashes', say(f'All {total} stored files have a content hash', f'全部 {total} 个已存文件都有内容哈希'))

    def storage(self):
        r = self.report
        r.start(say('Object storage', '对象存储'))
        endpoint = str((((self.config.get('services') or {}).get('minio') or {}).get('default') or {}).get('endpoint') or '')
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
            r.add(INFO, 'minio', say('Object storage is on another server; checked through the backend only',
                                     '对象存储在其他服务器上；仅通过后端检查'))
            return
        status, _ = self.host.http(f'{parsed.scheme}://{parsed.netloc}/minio/health/live')
        if status == 200:
            r.add(OK, 'minio', say('MinIO answers', 'MinIO 有响应'))
        else:
            r.add(FAIL, 'minio', say('MinIO doesn\'t answer', 'MinIO 无响应'))

    def judging(self):
        r = self.report
        if self.role != 'all':
            return
        r.start(say('Judging on this server', '本机评测'))
        if not self.judge:
            r.add(FAIL, 'judge.yaml', say('config/judge.yaml can\'t be read', '无法读取 config/judge.yaml'))
            return
        sandbox = self.judge.get('sandbox') or {}
        rootfs = Path(str(sandbox.get('rootfs') or ''))
        expected = 'rootfs-' + str(sandbox.get('rootfsId') or '')
        try:
            resolved = rootfs.resolve(strict=True)
        except OSError:
            resolved = None
        if resolved and resolved.name == expected and resolved.is_dir():
            r.add(OK, 'rootfs', say(f'The sandbox image is the configured one ({str(sandbox.get("rootfsId"))[:12]})',
                                    f'沙箱镜像与配置一致（{str(sandbox.get("rootfsId"))[:12]}）'))
        else:
            r.add(FAIL, 'rootfs', say('The sandbox image doesn\'t match config/judge.yaml', '沙箱镜像与 config/judge.yaml 不一致'))
        unit = self.host.unit(JUDGE_SERVICE)
        group = unit.get('ControlGroup') or ''
        if group:
            try:
                controllers = set(self.host.read(f'/sys/fs/cgroup{group}/cgroup.controllers').split())
            except OSError:
                controllers = set()
            missing = {'cpu', 'memory', 'pids'} - controllers
            if missing:
                r.add(FAIL, 'cgroup', say(f'The judge can\'t limit {", ".join(sorted(missing))} (cgroup delegation)',
                                          f'评测无法限制 {", ".join(sorted(missing))}（cgroup 委派）'))
            else:
                r.add(OK, 'cgroup', say('The judge can limit CPU, memory and processes', '评测可以限制 CPU、内存和进程'))
            self.judge_account(group)
        workspaces = [path for path in self.judge.get('taskWorkingDirectories') or [] if not self.host.ismount(path)]
        if workspaces:
            r.add(FAIL, 'workspaces', say(f'{len(workspaces)} judge workspaces aren\'t mounted, e.g. {workspaces[0]}',
                                          f'{len(workspaces)} 个评测工作目录未挂载，例如 {workspaces[0]}'))
        else:
            r.add(OK, 'workspaces', say(f'All {len(self.judge.get("taskWorkingDirectories") or [])} judge workspaces are mounted',
                                        f'全部 {len(self.judge.get("taskWorkingDirectories") or [])} 个评测工作目录已挂载'))
        socket = self.judge.get('aiRunnerSocket')
        if socket:
            try:
                runner = stat.S_ISSOCK(self.host.lstat(socket).st_mode)
            except OSError:
                runner = False
            if not runner:
                r.add(WARN, 'ai-runner', say('The AI runner socket is missing: AI jobs can\'t run programs',
                                             'AI 运行器套接字不存在：AI 任务无法运行程序'))
        r.add(INFO, 'self-test', say(f'For a full sandbox and language check: sudo bash {self.root}/deploy/sandbox/self-test.sh',
                                     f'完整检查沙箱和各语言：sudo bash {self.root}/deploy/sandbox/self-test.sh'))

    def judge_account(self, group):
        """Which accounts the running judge's processes have: its sandbox launcher is root, the judge itself isn't."""
        r = self.report
        try:
            pids = self.host.read(f'/sys/fs/cgroup{group}/supervisor/cgroup.procs').split()
        except OSError:
            return
        users = set()
        for pid in pids:
            try:
                uid = re.search(r'^Uid:\s+\d+\s+(\d+)', self.host.read(f'/proc/{pid}/status'), re.M)
            except OSError:
                continue
            if uid:
                users.add(int(uid[1]))
        if not users:
            return
        others = sorted(self.host.user(uid) for uid in users if uid != 0)
        if others:
            r.add(OK, 'judge account', say(f'The judge runs as {", ".join(others)}; only its sandbox launcher runs as root',
                                           f'评测以 {", ".join(others)} 身份运行；只有其沙箱启动器以 root 运行'))
        else:
            r.add(WARN, 'judge account', say('The whole judge runs as root: this release separates it from its sandbox '
                                             'launcher, and the judge restarts as libreoj-judge after an upgrade',
                                             '整个评测以 root 运行：本版本将其与沙箱启动器分开，升级后评测以 libreoj-judge 身份重启'))

    def queues(self):
        r = self.report
        r.start(say('Work queues', '工作队列'))
        metrics = self.config.get('metrics') or {}
        if not metrics.get('basePort'):
            r.add(INFO, 'metrics', say('Metrics are off in backend.yaml; queues aren\'t checked', 'backend.yaml 未开启指标；未检查队列'))
            return
        host = str(metrics.get('hostname') or '127.0.0.1')
        host = '127.0.0.1' if host in ('0.0.0.0', '::', '') else host
        status, body = self.host.http(f'http://{host}:{int(metrics["basePort"])}/metrics')
        if status != 200:
            r.add(WARN, 'metrics', say('The backend\'s metrics can\'t be read; queues aren\'t checked', '无法读取后端指标；未检查队列'))
            return
        m = parse_metrics(body.decode(errors='replace'))

        def value(name, **labels):
            return m.get(name, {}).get(tuple(sorted(labels.items())))

        def known(*values):
            return all(isinstance(v, float) and not math.isnan(v) for v in values)

        if 'libreoj_judge_oldest_queued_job_seconds' not in m:
            r.add(INFO, 'metrics', say('This backend reports no queue details (an older version)', '此后端不报告队列详情（旧版本）'))
            return
        accepting, draining = value('libreoj_judge_clients', state='accepting'), value('libreoj_judge_clients', state='draining')
        if known(accepting, draining):
            if accepting + draining == 0:
                r.add(FAIL if self.role == 'all' else WARN, 'judges',
                      say('No judge machine is connected: submissions wait until one connects',
                          '没有已连接的评测机：提交会一直等待，直到有评测机连接'))
            elif accepting == 0:
                r.add(WARN, 'judges', say(f'All {int(draining)} connected judge machines are draining: no new submissions are judged',
                                          f'已连接的 {int(draining)} 台评测机均在排空：不会评测新的提交'))
            else:
                r.add(OK, 'judges', say(f'{int(accepting)} judge machines take submissions', f'{int(accepting)} 台评测机正在接收提交')
                      + (say(f', {int(draining)} draining', f'，{int(draining)} 台正在排空') if draining else ''))
        queued, oldest = value('libreoj_judge_jobs', state='Queued'), value('libreoj_judge_oldest_queued_job_seconds')
        if not known(queued, oldest):
            r.add(WARN, 'queue', say('The judge queue couldn\'t be read (see the backend log)', '无法读取评测队列（见后端日志）'))
        elif queued and oldest >= 300:
            r.add(FAIL if oldest >= 1800 else WARN, 'queue',
                  say(f'{int(queued)} submissions wait; the oldest for {duration_text(oldest)}',
                      f'{int(queued)} 个提交在等待；最早的已等待 {duration_text(oldest)}'))
        else:
            r.add(OK, 'queue', say(f'{int(queued)} submissions wait', f'{int(queued)} 个提交在等待')
                  + (say(f', the oldest for {duration_text(oldest)}', f'，最早的已等待 {duration_text(oldest)}') if queued else ''))
        changed = value('libreoj_database_schema_differences', kind='changed')
        if known(changed) and changed:
            r.add(WARN, 'schema', say(f'The database differs from this release\'s definitions in {int(changed)} ways it works with, such as a column type or a missing index (the backend log names them when it starts)',
                                      f'数据库与当前版本的定义有 {int(changed)} 处不同（例如列类型或缺少的索引），后端仍可运行（后端启动时会在日志中列出）'))
        contest = value('libreoj_judge_queued_jobs_by_class', **{'class': 'live_contest'})
        if known(contest) and contest >= 10:
            r.add(WARN, 'contest', say(f'{int(contest)} submissions to running contests wait; see "Judging" in Site management to keep task threads for them',
                                       f'{int(contest)} 个进行中比赛的提交在等待；可在网站管理的“评测”中为它们保留任务线程'))
        expired = value('libreoj_judge_expired_leases')
        if known(expired) and expired:
            r.add(WARN, 'leases', say(f'{int(expired)} judging tasks lost their judge machine and weren\'t queued again yet',
                                      f'{int(expired)} 个评测任务失去了评测机，尚未重新排队'))
        failed = value('libreoj_judge_failed_jobs_last_day')
        if known(failed) and failed:
            r.add(WARN, 'failed', say(f'{int(failed)} judging tasks failed in the last day (see Judge queue on the Judge Machine page)',
                                      f'过去一天有 {int(failed)} 个评测任务失败（见“评测机状态”页面的“评测队列”）'))
        lag = value('libreoj_statistics_outbox_oldest_seconds')
        if known(lag) and lag >= 300:
            r.add(WARN, 'statistics', say(f'Problem and user counts are {duration_text(lag)} behind the submissions',
                                          f'题目和用户的统计数据落后提交 {duration_text(lag)}'))
        ai_queued, ai_oldest = value('libreoj_ai_jobs', state='queued'), value('libreoj_ai_oldest_queued_job_seconds')
        if value('libreoj_ai_paused') == 1:
            r.add(INFO, 'ai', say('AI is paused in Site management', 'AI 已在网站管理中暂停'))
        elif known(ai_queued, ai_oldest) and ai_queued and ai_oldest >= 1800:
            r.add(WARN, 'ai', say(f'{int(ai_queued)} AI jobs wait; the oldest for {duration_text(ai_oldest)}',
                                  f'{int(ai_queued)} 个 AI 任务在等待；最早的已等待 {duration_text(ai_oldest)}'))
        approved, approved_only = value('libreoj_ai_approved_endpoints'), value('libreoj_ai_approved_endpoints_only')
        if known(approved, approved_only) and approved_only == 1:
            r.add(INFO, 'ai-addresses', say(f'Accounts can use only the {int(approved)} AI addresses approved in Site management',
                                            f'账号只能使用网站管理中批准的 {int(approved)} 个 AI 地址'))
        elif known(approved) and approved:
            r.add(INFO, 'ai-addresses', say(f'{int(approved)} AI addresses are approved in Site management; other public addresses are allowed',
                                            f'网站管理中批准了 {int(approved)} 个 AI 地址；其他公网地址也允许使用'))
        unreported = value('libreoj_ai_unreported_usage_last_day')
        if known(unreported) and unreported:
            r.add(INFO, 'ai-usage', say(f'{int(unreported)} AI requests in the last day had no usage reported; they count at their maximum',
                                        f'过去一天有 {int(unreported)} 个 AI 请求没有报告用量，按最大值计入'))
        errors = sum(m.get('libreoj_ai_worker_errors', {}).values())
        if errors:
            r.add(WARN, 'ai', say(f'The AI job scheduler had {int(errors)} errors since the backend started (see its log)',
                                  f'后端启动以来 AI 任务调度出错 {int(errors)} 次（见后端日志）'))

    def machine(self):
        r = self.report
        r.start(say('This server', '本服务器'))
        seen = set()
        for path in (self.root, self.root/'data/mariadb', self.root/'data/minio', self.root/'backups'):
            try:
                info = self.host.statvfs(path)
            except OSError:
                continue
            key = (info.f_blocks, info.f_files, info.f_bsize)
            if key in seen:
                continue
            seen.add(key)
            free, total = info.f_bavail * info.f_frsize, info.f_blocks * info.f_frsize
            share = free / max(1, total)
            level = FAIL if free < GIB or share < 0.03 else WARN if free < 5 * GIB or share < 0.1 else OK
            r.add(level, 'disk', say(f'{size_text(free)} free ({share:.0%}) on the disk of {path}', f'{path} 所在磁盘剩余 {size_text(free)}（{share:.0%}）'))
            if info.f_files and info.f_favail / info.f_files < 0.1:
                r.add(WARN, 'inodes', say(f'Few file entries (inodes) left on the disk of {path}', f'{path} 所在磁盘的 inode 所剩无几'))
        try:
            meminfo = dict(line.split(':', 1) for line in self.host.read('/proc/meminfo').splitlines() if ':' in line)
            available, total = (int(meminfo[name].split()[0]) * 1024 for name in ('MemAvailable', 'MemTotal'))
            share = available / max(1, total)
            r.add(WARN if share < 0.1 else OK, 'memory', say(f'{size_text(available)} of {size_text(total)} memory available',
                                                             f'可用内存 {size_text(available)}，共 {size_text(total)}'))
        except (OSError, KeyError, ValueError):
            pass
        result = self.host.run(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value'])
        if result.returncode == 0 and result.stdout.strip() != 'yes':
            r.add(WARN, 'time', say('The clock isn\'t synchronized: authenticator codes and session times may be wrong',
                                    '系统时间未同步：验证器代码和会话时间可能出错'))

    def permissions(self):
        r = self.report
        r.start(say('Files and permissions', '文件与权限'))
        expected = [
            ('config/backend.yaml', 'root', 'libreoj', 0o640), ('config/secrets.json', 'root', 'root', 0o600),
            ('config/minio.env', 'root', 'root', 0o600), ('config/install-state.json', 'root', 'root', 0o600),
            ('config/install-complete.json', 'root', 'root', 0o600), ('config/admin-credentials.json', 'root', 'root', 0o600),
            ('config/mariadb.cnf', 'root', 'mysql', 0o640), ('config/redis.conf', 'root', 'redis', 0o640),
            ('data/ai', 'libreoj', 'libreoj', 0o700), ('data/ai/master.key', 'libreoj', 'libreoj', 0o600),
            ('data/ai/two-factor.key', 'libreoj', 'libreoj', 0o600), ('data/mariadb', 'mysql', 'mysql', 0o750),
            ('data/minio', 'libreoj', 'libreoj', 0o750), ('data/redis', 'redis', 'redis', 0o750),
            *([('config/judge.yaml', 'root', 'root', 0o600)] if self.role == 'all' else []),
        ]
        backups = sorted(glob.glob(str(self.root/'backups/libreoj-*.tar.gz')))
        expected += [(os.path.relpath(path, self.root), 'root', 'root', 0o600) for path in backups[-10:]]
        problems = 0
        for relative, user, group, mode in expected:
            path = self.root/relative
            try:
                info = self.host.lstat(path)
            except FileNotFoundError:
                continue
            actual = stat.S_IMODE(info.st_mode)
            extra = actual & ~mode
            if stat.S_ISLNK(info.st_mode):
                r.add(FAIL, relative, say(f'{relative} is a symbolic link', f'{relative} 是符号链接'))
                problems += 1
            elif extra & 0o027:
                r.add(FAIL, relative, say(f'{relative} can be read or changed by other users (mode {actual:o}, expected {mode:o})',
                                          f'{relative} 可被其他用户读取或修改（权限 {actual:o}，应为 {mode:o}）'))
                problems += 1
            elif extra:
                r.add(WARN, relative, say(f'{relative} has broader permissions than expected (mode {actual:o}, expected {mode:o})',
                                          f'{relative} 的权限比预期宽（权限 {actual:o}，应为 {mode:o}）'))
                problems += 1
            elif (self.host.user(info.st_uid), self.host.group(info.st_gid)) != (user, group):
                r.add(WARN, relative, say(f'{relative} belongs to {self.host.user(info.st_uid)}:{self.host.group(info.st_gid)}, '
                                          f'expected {user}:{group}',
                                          f'{relative} 属于 {self.host.user(info.st_uid)}:{self.host.group(info.st_gid)}，应为 {user}:{group}'))
                problems += 1
        if not problems:
            r.add(OK, 'permissions', say('Configuration, keys and data have their expected owners and permissions',
                                         '配置、密钥和数据的所有者与权限正确'))

    def backups(self):
        r = self.report
        r.start(say('Backups', '备份'))
        backups = sorted(glob.glob(str(self.root/'backups/libreoj-*.tar.gz')))
        if not backups:
            r.add(WARN, 'backup', say(f'No backup was made with deploy/backup.sh (sudo bash {self.root}/deploy/backup.sh)',
                                      f'没有用 deploy/backup.sh 做过备份（sudo bash {self.root}/deploy/backup.sh）'))
        else:
            latest = Path(backups[-1])
            age = self.host.now() - self.host.lstat(latest).st_mtime
            checksum = Path(str(latest)+'.sha256')
            try:
                self.host.lstat(checksum)
                summed = True
            except OSError:
                summed = False
            level = WARN if age > 7 * 86400 or not summed else OK
            r.add(level, 'backup', say(f'The latest backup is {duration_text(age)} old: {latest.name}', f'最新备份已有 {duration_text(age)}：{latest.name}')
                  + ('' if summed else say(' (its .sha256 checksum is missing)', '（缺少 .sha256 校验文件）')))
            r.add(INFO, 'verify', say(f'To check it can be restored: sudo bash {self.root}/deploy/verify-backup.sh {latest}',
                                      f'检查它能否恢复：sudo bash {self.root}/deploy/verify-backup.sh {latest}'))
        upgrades = sorted(glob.glob(str(self.root/'backups/upgrade/*/')))
        if upgrades:
            result = self.host.run(['du', '-s', '--block-size=1', *upgrades], timeout=120)
            sizes = [int(line.split()[0]) for line in result.stdout.splitlines() if line.split() and line.split()[0].isdigit()]
            staged = [path for path in upgrades if os.path.isdir(os.path.join(path, 'staging/node_modules'))]
            if sizes:
                total = sum(sizes)
                try:
                    info = self.host.statvfs(self.root/'backups')
                    free = info.f_bavail * info.f_frsize
                except OSError:
                    free = 0
                level = WARN if free and total > free / 4 else INFO
                r.add(level, 'upgrade-backups', say(f'{len(upgrades)} upgrade backups use {size_text(total)} in {self.root}/backups/upgrade',
                                                    f'{len(upgrades)} 份升级备份占用 {size_text(total)}（{self.root}/backups/upgrade）')
                      + (say(f'; {len(staged)} still hold a build copy of the dependencies that can be deleted (see the upgrade guide)',
                             f'；其中 {len(staged)} 份仍有可删除的构建依赖副本（见升级说明）') if staged else ''))


def print_report(report, root):
    labels = {OK: say('OK', '正常'), INFO: say('INFO', '信息'), WARN: say('WARN', '警告'), FAIL: say('FAIL', '失败')}
    width = max(len(label) for label in labels.values())
    print(say(f'LLMOJ doctor: {root}', f'LLMOJ 健康检查：{root}'))
    section = None
    for item in report.items:
        if item['section'] != section:
            section = item['section']
            print(f'\n{section}')
        print(f'  {labels[item["status"]]:<{width}}  {item["message"]}')
    counts = report.counts()
    print('\n' + say(f'Summary: {counts[OK]} OK, {counts[WARN]} warnings, {counts[FAIL]} failures',
                     f'汇总：{counts[OK]} 项正常，{counts[WARN]} 项警告，{counts[FAIL]} 项失败'))


def main(argv=None):
    parser = argparse.ArgumentParser(description=say('Read-only health report of an LLMOJ installation',
                                                     'LLMOJ 安装的只读健康检查'))
    # By default the installation this script belongs to
    here = Path(__file__).resolve().parents[1]
    default = os.environ.get('HYHOJ_ROOT') or (str(here) if (here/'config/install-complete.json').exists() else '/opt/LLMOJ')
    parser.add_argument('--prefix', default=default)
    parser.add_argument('--json', action='store_true', help=say('machine-readable output', '机器可读输出'))
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        print(say('Run as root: the checks read the private configuration.', '请以 root 运行：检查需要读取私有配置。'), file=sys.stderr)
        return 2
    report = Doctor(args.prefix).run()
    if args.json:
        print(json.dumps({'prefix': str(args.prefix), 'summary': report.counts(), 'checks': report.items}, ensure_ascii=False, indent=2))
    else:
        print_report(report, args.prefix)
    return 1 if report.counts()[FAIL] else 0


if __name__ == '__main__':
    sys.exit(main())
