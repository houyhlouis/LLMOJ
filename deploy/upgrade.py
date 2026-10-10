#!/usr/bin/env python3
"""Conservative, dependency-preserving upgrades of official all/web installations.

No installer, configuration generator, rootfs builder, or automatic schema sync is
run. Database migration is deliberately restricted to the registration-review
additive contract. A rollback never restores a stale SQL dump over user data.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import grp
import io
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

REPOSITORY = 'houyhlouis/LLMOJ'
# Permit only the known branding-only values below during dependency checks;
# every script, dependency, package name and other setting still must match.
REPOSITORY_LINK_MANIFESTS = frozenset({
    'apps/backend/package.json', 'apps/judge/package.json',
    'packages/frontend/package.json', 'packages/simple-sandbox/package.json',
    'infra/frontend-cdn/package.json'
})
LEGACY_PACKAGE_REPOSITORY = 'https://github.com/LibreOJ/LibreOJ.git'
PACKAGE_REPOSITORY = 'https://github.com/'+REPOSITORY+'.git'
LEGACY_PACKAGE_DESCRIPTIONS = {
    'apps/backend/package.json': 'The backend service of LibreOJ',
    'apps/judge/package.json': 'The judge service of LibreOJ',
    'packages/frontend/package.json': 'The web frontend of LibreOJ',
    'packages/simple-sandbox/package.json': 'The native Linux process sandbox used by LibreOJ.'
}
BOOTSTRAP_SETTINGS = 'packages/bootstrap-config/settings.json'
SKIP = {'.git', 'node_modules', '__pycache__', 'dist', 'build', 'lib', '.cache', '.vite'}
PERSISTENT = {'config', 'runtime', 'data', 'logs', 'backups', 'release', 'public', 'node_modules', '.git'}
GUARD = '[Service]\nEnvironment=LIBREOJ_SCHEMA_SYNC=0\n'
GUARD_NAME = '90-libreoj-schema-sync.conf'
SERVICES = ('mariadb', 'redis', 'minio', 'backend', 'nginx')
GIB = 1024 ** 3


class UpgradeError(RuntimeError):
    """Only deliberately non-sensitive messages may reach the terminal."""


def fail(message):
    raise UpgradeError(message)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def compatibility_digest(relative, path):
    if relative not in REPOSITORY_LINK_MANIFESTS and relative != BOOTSTRAP_SETTINGS:
        return digest(path)
    try:
        manifest = json.loads(Path(path).read_text())
    except (OSError, UnicodeError, ValueError):
        fail('Invalid source metadata in dependency compatibility check')
    if not isinstance(manifest, dict):
        fail('Invalid source metadata in dependency compatibility check')
    if relative in REPOSITORY_LINK_MANIFESTS:
        repository = manifest.get('repository')
        if isinstance(repository, dict) and repository.get('url') in (LEGACY_PACKAGE_REPOSITORY, PACKAGE_REPOSITORY):
            repository['url'] = PACKAGE_REPOSITORY
        old_description = LEGACY_PACKAGE_DESCRIPTIONS.get(relative)
        if old_description is not None and manifest.get('description') == old_description:
            manifest['description'] = old_description.replace('LibreOJ', 'LLMOJ')
    elif isinstance(manifest.get('env'), dict) and manifest['env'].get('title') == 'LibreOJ':
        manifest['env']['title'] = 'LLMOJ'
    # Provenance/staging verification continues to use the original byte digest.
    return hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def source_files(root):
    root = Path(root)
    for directory, dirs, names in os.walk(root, followlinks=False):
        current = Path(directory)
        relative = current.relative_to(root)
        dirs[:] = sorted(d for d in dirs if d not in SKIP and not (not relative.parts and d in PERSISTENT) and not (relative == Path('deploy') and d == 'systemd'))
        for name in dirs:
            if (current/name).is_symlink():
                fail('Source contains a symbolic-link directory')
        for name in sorted(names):
            path = current/name
            rel = path.relative_to(root)
            if rel == Path('packages/bootstrap-config/config.json') or name.endswith(('.pyc', '.tsbuildinfo')) or name == '.DS_Store' or (not relative.parts and name in PERSISTENT):
                continue
            if not stat.S_ISREG(path.lstat().st_mode):
                fail('Source contains a non-regular file')
            if not relative.parts and name.startswith('.') and name not in ('.npmrc', '.nvmrc', '.gitignore', '.prettierignore', '.prettierrc', '.prettierrc.json', '.eslintrc', '.eslintrc.json', '.eslintrc.js'):
                continue
            yield rel, path


def tree_digest(root):
    result = hashlib.sha256()
    for rel, path in source_files(root):
        result.update(str(rel).encode()+b'\0'+digest(path).encode()+b'\n')
    return result.hexdigest()


def snapshot(root):
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory)/name
            rel = str(path.relative_to(root))
            st = path.lstat()
            if stat.S_ISLNK(st.st_mode):
                fail('Configuration contains a symbolic link; manual review required')
            if stat.S_ISREG(st.st_mode):
                result[rel] = [digest(path), st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode)]
            elif not stat.S_ISDIR(st.st_mode):
                fail('Configuration contains a special file')
    return result


def safe_dir(path, private=False):
    path = Path(path)
    if not path.is_absolute() or str(path) == '/' or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)) or '..' in path.parts:
        fail('Use a safe absolute path without spaces')
    for p in [*reversed(path.parents), path]:
        if p.is_symlink():
            fail('Symbolic-link directory is unsupported')
    st = path.stat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & (0o077 if private else 0o022):
        fail('Directory must be root-owned and not writable by other users')
    return path


def private_file(path, group_read=False):
    st = Path(path).lstat()
    forbidden = 0o037 if group_read else 0o077
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & forbidden or st.st_nlink != 1 or (group_read and st.st_gid != grp.getgrnam('libreoj').gr_gid):
        fail('Unsafe private configuration or manifest file')


def write_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.upgrade-', dir=Path(path).parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(Path(path).parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextlib.contextmanager
def maintenance_lock(directory=Path('/run/libreoj-installer')):
    if not directory.exists():
        directory.mkdir(mode=0o700)
    safe_dir(directory, private=True)
    fd = os.open(directory/'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid or st.st_mode & 0o077 or st.st_nlink != 1:
            fail('Unsafe maintenance lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('Another install, resize or upgrade is running')
        yield
    finally:
        os.close(fd)


class Host:
    def run(self, args, *, check=True, input=None, output=None, error_output=None, cwd=None, env=None, timeout=300, umask=-1):
        try:
            with contextlib.ExitStack() as stack:
                options = {'stdin': stack.enter_context(input.open('rb'))} if isinstance(input, Path) else {'input': input}
                result = subprocess.run([str(x) for x in args], **options, stdout=output or subprocess.PIPE,
                                        stderr=error_output or subprocess.PIPE, cwd=cwd, env=env, timeout=timeout, umask=umask)
        except (subprocess.TimeoutExpired, OSError):
            fail('External operation failed or timed out (private output withheld)')
        if check and result.returncode:
            fail(f'{Path(args[0]).name} operation failed (exit {result.returncode}; private output withheld)')
        return result

    def prop(self, unit, prop):
        return self.run(['systemctl', 'show', unit, '-p', prop, '--value']).stdout.decode().strip()

    def active(self, unit):
        return self.run(['systemctl', 'is-active', '--quiet', unit], check=False).returncode == 0

    def service(self, action, unit):
        self.run(['systemctl', action, unit], timeout=180)


def fetch(url, maximum=256*1024*1024):
    request = urllib.request.Request(url, headers={'User-Agent': 'LLMOJ-safe-upgrade', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        if urllib.parse.urlsplit(response.url).hostname not in ('api.github.com', 'codeload.github.com', 'raw.githubusercontent.com'):
            fail('Unexpected source download redirect')
        data = response.read(maximum+1)
    if len(data) > maximum:
        fail('Source response exceeds size limit')
    return data


def resolve_commit(ref):
    if not re.fullmatch(r'[A-Za-z0-9._/-]{1,200}', ref) or '..' in ref:
        fail('Invalid source reference')
    value = json.loads(fetch(f'https://api.github.com/repos/{REPOSITORY}/commits/{urllib.parse.quote(ref, safe="")}', 1024*1024))
    commit = value.get('sha', '')
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or (re.fullmatch(r'[0-9a-f]{40}', ref) and commit != ref):
        fail('GitHub did not return an immutable commit')
    return commit


def extract_archive(data, destination):
    total = 0
    seen = set()
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        if not members or len(members) > 30000:
            fail('Source archive file count exceeds limit')
        archive_root = Path(members[0].name).parts[0]
        for member in members:
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != archive_root or member.name in seen or not (member.isfile() or member.isdir()):
                fail('Unsafe source archive path or member')
            seen.add(member.name)
            total += member.size
            if total > 256*1024*1024:
                fail('Expanded source archive exceeds limit')
        destination.mkdir(mode=0o700)
        for member in members:
            relative = Path(*Path(member.name).parts[1:])
            if relative == Path('.'):
                continue
            target = destination/relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with archive.extractfile(member) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    return destination


class Upgrade:
    def __init__(self, root, host=None, units=Path('/etc/systemd/system')):
        self.root = safe_dir(Path(root))
        self.host = host or Host()
        self.units = Path(units)
        self.guard = self.units/'libreoj-backend.service.d'/GUARD_NAME
        self.backup = None
        self.manifest = None
        self.stage = None
        self.paused = False

    def sql(self, query, database=None):
        args = ['mariadb', '--protocol=socket', f'--socket={self.root}/data/mariadb/mysql.sock', '--user=root', '--batch', '--skip-column-names']
        if database:
            args.append(database)
        return self.host.run(args, input=query.encode()).stdout.decode().strip()

    def preflight(self, recovery=None):
        import yaml
        for name in ('config', 'runtime', 'data', 'apps', 'packages', 'deploy', 'public'):
            path = self.root/name
            if recovery and not path.exists() and name in ('apps', 'packages', 'deploy', 'public'):
                backup, manifest = recovery
                recorded = any(entry['name'] == name and entry['hadOld'] for entry in manifest['entries'])
                if not recorded:
                    fail('Missing installation directory is not covered by this rollback manifest')
                safe_dir(backup/'previous'/name)
            else:
                safe_dir(path)
        for name in ('install-state.json', 'install-complete.json', 'backend.yaml', 'secrets.json'):
            private_file(self.root/'config'/name, group_read=name == 'backend.yaml')
        state = json.loads((self.root/'config/install-complete.json').read_text())
        initial = json.loads((self.root/'config/install-state.json').read_text())
        if state.get('version') != 3 or state.get('root') != str(self.root) or state.get('role') not in ('all', 'web') or any(initial.get(k) != state.get(k) for k in ('version', 'root', 'role')):
            fail('Only completed official version-3 all/web installations are supported')
        if state.get('sourceRepository') not in (None, REPOSITORY, 'https://github.com/'+REPOSITORY):
            fail('Installer metadata refers to another source repository')
        if (self.root/'.git').exists():
            fail('Git-managed deployments require manual upgrade')
        self.role = state['role']
        self.names = [*SERVICES, *(['judge'] if self.role == 'all' else [])]
        self.states = {}
        self.unit_fingerprint = {}
        self.dropins = {}
        for name in self.names:
            unit = 'libreoj-'+name+'.service'
            fragment = self.host.prop(unit, 'FragmentPath')
            if fragment != str(self.units/unit) or not Path(fragment).is_file() or Path(fragment).is_symlink():
                fail('Service unit is missing or belongs to an unsupported layout: '+unit)
            if str(self.root)+'/' not in Path(fragment).read_text():
                fail('Service belongs to another installation: '+unit)
            self.dropins[unit] = shlex.split(self.host.prop(unit, 'DropInPaths'))
            for path in [Path(fragment), *map(Path, self.dropins[unit])]:
                st = path.lstat()
                if not stat.S_ISREG(st.st_mode) or st.st_uid or st.st_mode & 0o022:
                    fail('Unsafe service definition')
                self.unit_fingerprint[str(path)] = digest(path)
            if name in ('backend', 'judge'):
                env = dict(x.split('=', 1) for x in shlex.split(self.host.prop(unit, 'Environment')) if '=' in x)
                key = 'LIBREOJ_CONFIG_FILE' if name == 'backend' else 'LIBREOJ_JUDGE_CONFIG_FILE'
                if self.host.prop(unit, 'WorkingDirectory') != str(self.root/'apps'/name) or env.get(key) != str(self.root/'config'/f'{name}.yaml'):
                    fail('Effective service configuration belongs to another prefix')
                if self.host.prop(unit, 'EnvironmentFiles'):
                    fail('Custom backend/judge EnvironmentFile requires manual configuration review')
                if name == 'backend':
                    for variable, suffix in {
                        'HYHOJ_AI_STATE_DIR': 'data/ai', 'HYHOJ_AI_GENERATED_DIR': 'data/ai-generated',
                        'HYHOJ_AI_SAMPLE_INPUTS_DIR': 'data/ai-sample-inputs',
                        'HYHOJ_AI_RUNNER_SOCKET': 'data/judge/ai-runner.sock',
                        'HYHOJ_ARCHIVE_WORK_DIRECTORY': 'data/backend-archives', 'TMPDIR': 'data/tmp'
                    }.items():
                        if env.get(variable) != str(self.root/suffix):
                            fail('Custom AI/archive/runtime state location requires a separate reviewed backup procedure')
            command = self.host.prop(unit, 'ExecStart')
            expected_command_path = {
                'backend': str(self.root/'runtime/node/bin/node'),
                'judge': str(self.root/'runtime/node/bin/node'),
                'nginx': str(self.root/'config/nginx.conf'),
                'mariadb': str(self.root/'config/mariadb.cnf'),
                'redis': str(self.root/'config/redis.conf'),
                'minio': str(self.root/'data/minio')
            }[name]
            if expected_command_path not in command:
                fail('Effective service command does not match the installation: '+unit)
            active = self.host.prop(unit, 'ActiveState')
            if active not in ('active', 'inactive'):
                fail('Services must be stable (active or inactive): '+unit)
            self.states[unit] = active == 'active'
        if not all(self.states['libreoj-'+x+'.service'] for x in ('mariadb', 'redis', 'minio')):
            fail('Local MariaDB, Redis and MinIO must be active for a verified upgrade')
        if self.guard.exists() or self.guard.is_symlink():
            if self.guard.is_symlink() or self.guard.read_text() != GUARD:
                fail('Schema guard name is already used by custom configuration')
        self.guard_before = self.guard.exists()
        backend = yaml.safe_load((self.root/'config/backend.yaml').read_text())
        db = backend['services']['database']
        if db.get('type') not in ('mariadb', 'mysql') or db.get('host') != '127.0.0.1' or db.get('port') != 13306 or db.get('database') != 'libreoj' or db.get('username') != 'libreoj':
            fail('Only the official local MariaDB connection is supported')
        if backend['server'].get('hostname') != '127.0.0.1' or backend['server'].get('clusters') not in (None, 1):
            fail('Only the official single local backend is supported')
        self.port = int(backend['server']['port'])
        self.site_name = backend.get('preference', {}).get('siteName', state.get('siteName', 'LLMOJ'))
        self.config_before = snapshot(self.root/'config')
        self.key_before = digest(self.root/'data/ai/master.key') if (self.root/'data/ai/master.key').exists() else None
        self.node = self.root/'runtime/node/bin/node'
        self.pnpm = self.root/'runtime/tooling/node_modules/.bin/pnpm'
        if not self.node.is_file() or not self.pnpm.is_file():
            fail('Installed Node/pnpm runtime is missing')
        self.node_version = self.host.run([self.node, '--version']).stdout.decode().strip()
        self.pnpm_version = self.host.run([self.node, self.pnpm, '--version']).stdout.decode().strip()
        if not self.node_version.startswith('v24.') or self.pnpm_version != '11.13.1':
            fail('This upgrader supports Node 24 and pnpm 11.13.1 only')
        tables = self.sql("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='libreoj' AND TABLE_TYPE <> 'BASE TABLE'")
        extras = self.sql("SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='libreoj'")+self.sql("SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='libreoj'")+self.sql("SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='libreoj'")
        nontransactional = self.sql("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='libreoj' AND TABLE_TYPE='BASE TABLE' AND ENGINE <> 'InnoDB'")
        if tables or extras != '000' or nontransactional != '0':
            fail('Custom database views, triggers, routines or events require manual upgrade')
        self.database_bytes = int(self.sql("SELECT COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) FROM information_schema.TABLES WHERE TABLE_SCHEMA='libreoj'"))
        return {'role': self.role, 'prefix': str(self.root), 'node': self.node_version, 'pnpm': self.pnpm_version,
                'services': self.states, 'databaseBytes': self.database_bytes, 'scope': 'dependency-preserving code + registration application schema + strictly validated legacy empty-account migration'}

    def compatibility(self, source):
        required = ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'deploy/upgrade-schema.mjs', 'deploy/build-frontend-offline.mjs', 'apps/backend/src/auth/registration-review.entity.ts', 'apps/backend/src/auth/registration-application.entity.ts', 'deploy/upgrade-registration.mjs')
        for name in required:
            if not (source/name).is_file():
                fail('Source is incomplete or predates the supported upgrade contract')
        source_map = {str(rel): digest(path) for rel, path in source_files(source)}
        old_map = {str(rel): digest(path) for rel, path in source_files(self.root)}
        shared = lambda name: (name.startswith(('packages/', 'apps/judge/', 'infra/')) and not name.startswith('packages/frontend/')) or name.endswith('/package.json') or name in ('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc')
        source_dependencies = {name: compatibility_digest(name, source/name) for name in source_map if shared(name)}
        old_dependencies = {name: compatibility_digest(name, self.root/name) for name in old_map if shared(name)}
        if source_dependencies != old_dependencies:
            fail('Dependencies, shared packages, judge or infrastructure changed; this release requires a separate migration procedure')
        runtime_pin = re.search(r'^NODE_VERSION=([0-9.]+)$', (source/'deploy/install.sh').read_text(), re.M)
        if not runtime_pin or self.node_version != 'v'+runtime_pin[1]:
            fail('Target Node runtime differs; runtime upgrades require a separate procedure')
        if 'LIBREOJ_SCHEMA_SYNC' not in (source/'apps/backend/src/database/database.providers.ts').read_text():
            fail('Target backend cannot disable automatic schema synchronization')
        return source_map

    def check_space(self, source):
        def size(path):
            return sum(p.stat().st_size for p in path.rglob('*') if p.is_file() and not p.is_symlink())
        estimate = sum(size(self.root/name) for name in ('apps', 'packages', 'node_modules', 'public')) + sum(p.stat().st_size for _, p in source_files(source)) + self.database_bytes*4 + 2*GIB
        if shutil.disk_usage(self.root).free < estimate:
            fail(f'Insufficient free space: at least {estimate//(1024**2)} MiB required for staging and backups')
        return estimate

    def save(self):
        write_json(self.backup/'manifest.json', self.manifest)

    def prepare(self, source, provenance):
        self.compatibility(source)
        self.check_space(source)
        base = self.root/'backups'
        if not base.exists():
            base.mkdir(mode=0o700)
        safe_dir(base)
        base = base/'upgrade'
        if not base.exists():
            base.mkdir(mode=0o700)
        safe_dir(base, private=True)
        self.backup = base/(datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+secrets.token_hex(4))
        self.backup.mkdir(mode=0o700)
        self.stage = self.backup/'staging'
        self.stage.mkdir(mode=0o755)
        # Independent copies: builds must never write through into running dependencies.
        for name in ('apps', 'packages', 'node_modules', 'public'):
            self.host.run(['cp', '-a', '--reflink=auto', self.root/name, self.stage/name], timeout=1800)
        for relative, path in source_files(source):
            target = self.stage/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
        if any(digest(self.stage/relative) != expected for relative, expected in self.compatibility(source).items()):
            fail('Source changed while preparing staging')
        if (self.root/'deploy/systemd').exists():
            shutil.copytree(self.root/'deploy/systemd', self.stage/'deploy/systemd', dirs_exist_ok=True)
        # Delete removed backend/frontend source modules; stale compiled entities are
        # erased by the backend's own prebuild before target compilation.
        for name in ('apps/backend/src', 'packages/frontend/src'):
            shutil.rmtree(self.stage/name)
            shutil.copytree(source/name, self.stage/name)
        if tree_digest(source) != provenance['treeSha256']:
            fail('Source changed during staging')
        self.host.run(['cp', '-a', '--reflink=auto', self.root/'config', self.backup/'config'], timeout=300)
        if self.key_before:
            shutil.copy2(self.root/'data/ai/master.key', self.backup/'ai-master.key')
            (self.backup/'ai-master.key').chmod(0o600)
        self.manifest = {'version': 1, 'prefix': str(self.root), 'provenance': provenance, 'status': 'building', 'states': self.states,
                         'config': self.config_before, 'aiMasterKeySha256': self.key_before, 'unitHashes': self.unit_fingerprint,
                         'guardBefore': self.guard_before, 'entries': [], 'port': self.port}
        self.save()
        self.build()
        self.make_publish_readable()
        self.assert_preserved()
        # External databases can reference this instance; these incoming keys are
        # absent from a restored clone, so audit the live schema read-only first.
        self.schema('libreoj')
        self.dump(self.backup/'preflight.sql')
        self.schema_on_clone(self.backup/'preflight.sql')
        self.manifest['status'] = 'ready'
        self.save()

    def build(self):
        env = dict(os.environ, PATH=str(self.root/'runtime/node/bin')+':'+os.environ.get('PATH', ''), NODE_OPTIONS='--max-old-space-size=1200',
                   pnpm_config_verify_deps_before_run='false', PNPM_BINARY=str(self.pnpm), HYHOJ_PUBLIC_DIR=str(self.stage/'public'), OJ_SITE_NAME=self.site_name)
        fd = os.open(self.backup/'build.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as log:
            for command in ([self.node, self.pnpm, '--filter', '@libreoj/backend', 'run', 'build'],
                            [self.node, self.pnpm, '--filter', '@libreoj/frontend', 'run', 'build'],
                            [self.node, self.stage/'deploy/build-frontend-offline.mjs']):
                self.host.run(command, cwd=self.stage, env=env, output=log, error_output=log, timeout=1800, umask=0o022)
        if not (self.stage/'apps/backend/dist/main.js').is_file() or not (self.stage/'public/index.html').is_file() or not (self.stage/'public/offline-manifest.json').is_file():
            fail('Build did not produce required artifacts')
        if 'LIBREOJ_SCHEMA_SYNC' not in (self.stage/'apps/backend/dist/database/database.providers.js').read_text():
            fail('Built backend does not support the schema guard')
        manifest = json.loads((self.stage/'public/offline-manifest.json').read_text())
        if not manifest.get('files'):
            fail('Frontend asset manifest is empty')
        for entry in manifest['files']:
            relative = Path(entry['path'].lstrip('/'))
            if relative.is_absolute() or '..' in relative.parts or not (self.stage/'public'/relative).is_file() or digest(self.stage/'public'/relative) != entry['sha256']:
                fail('Frontend asset manifest integrity check failed')
        # Runtime paths remain at the installation prefix; stage dependencies are
        # temporary copies. No generated service or private configuration is used.

    def make_publish_readable(self):
        # Match installer code permissions, never touching private backup/config.
        # Do not follow pnpm symlinks (including any administrator-local link).
        for directory, dirs, files in os.walk(self.stage, followlinks=False):
            path = Path(directory)
            path.chmod(stat.S_IMODE(path.stat().st_mode) | 0o555)
            for name in files:
                child = path/name
                if not child.is_symlink():
                    child.chmod(stat.S_IMODE(child.stat().st_mode) | 0o444)

    def dump(self, output):
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            self.host.run(['mariadb-dump', '--protocol=socket', f'--socket={self.root}/data/mariadb/mysql.sock', '--user=root', '--single-transaction', '--quick', '--skip-lock-tables', '--hex-blob', '--skip-add-locks', 'libreoj'], output=stream, timeout=1800)
            stream.flush()
            os.fsync(stream.fileno())
        if output.stat().st_size < 100:
            fail('Database backup is unexpectedly empty')

    def schema(self, database, action='audit'):
        result = self.host.run([self.node, self.stage/'deploy/upgrade-schema.mjs', '--root', self.stage, '--socket', self.root/'data/mariadb/mysql.sock', '--database', database, '--action', action], timeout=300, check=False)
        if result.returncode:
            match = re.fullmatch(r'UPGRADE_COMPATIBILITY: ([A-Z_]+)\n?', result.stderr.decode(errors='replace'))
            code = match[1] if match else 'DATABASE_OPERATION_FAILED'
            reasons = {
                'SCHEMA_CHANGE_UNSUPPORTED': '数据库结构变更不在支持范围 / unsupported schema change',
                'LEGACY_NONDEFAULT_PROFILE': '旧未激活账号有非默认资料或缺失账户记录 / non-default or incomplete legacy profile',
                'LEGACY_CREDENTIALS_OR_PREFERENCES': '旧凭据或偏好需要人工审查 / legacy credentials/preferences require review',
                'LEGACY_REVIEW_METADATA': '旧审核记录不一致 / inconsistent legacy review metadata',
                'LEGACY_INVALID_ACCOUNT': '旧审核引用无效账号 / invalid legacy review account',
                'APPLICATION_CONFLICT': '已有申请的用户名、邮箱或账号关联冲突 / application reservation/link conflict',
                'UNKNOWN_TABLE': '未知数据库表可能引用旧账号 / unknown tables may reference legacy accounts',
                'UNKNOWN_FOREIGN_KEY': '未知外键需要人工审查 / unknown foreign key',
                'LEGACY_BUSINESS_REFERENCES': '旧未激活账号已有业务内容、权限或关联 / legacy account has business data or privileges',
                'LEGACY_UNSUPPORTED_AUDIT': '旧账号有注册白名单之外的审计历史 / unsupported legacy audit history',
                'AUDIT_COPY_VERIFICATION': '审计归档回读校验失败 / audit archive verification failed',
                'MIGRATION_CONCURRENT_CHANGE': '迁移期间记录变化 / data changed during migration',
                'MIGRATION_WRITE_VERIFICATION': '迁移写入校验失败 / migration write verification failed'
            }
            fail('Database upgrade refused ('+code+'): '+reasons.get(code, 'database operation failed; private connection details withheld'))
        return json.loads(result.stdout)

    def schema_on_clone(self, dump):
        database = 'libreoj_upgrade_'+secrets.token_hex(8)
        self.sql(f'CREATE DATABASE `{database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
        try:
            self.host.run(['mariadb', '--protocol=socket', f'--socket={self.root}/data/mariadb/mysql.sock', '--user=root', database], input=dump, timeout=1800)
            audit = self.schema(database)
            self.schema(database, 'apply')
            verified = self.schema(database)
            if verified['queries'] or any(verified.get('migration', {}).get(key, 0) for key in ('pending', 'rejected', 'approvedHistory')):
                fail('Restored database migration is not stable')
            self.manifest['schemaQueries'] = audit['queries']
            self.manifest['registrationMigration'] = audit.get('migration', {})
            self.save()
        finally:
            self.sql(f'DROP DATABASE `{database}`')

    def assert_preserved(self):
        if snapshot(self.root/'config') != self.config_before:
            fail('Configuration changed during preparation; refusing cutover')
        key = digest(self.root/'data/ai/master.key') if (self.root/'data/ai/master.key').exists() else None
        if key != self.key_before:
            fail('AI master key changed during preparation')
        for unit, expected in self.dropins.items():
            current = shlex.split(self.host.prop(unit, 'DropInPaths'))
            if set(current)-{str(self.guard)} != set(expected)-{str(self.guard)}:
                fail('Service drop-ins changed during preparation')
        for path, expected in self.unit_fingerprint.items():
            if not Path(path).is_file() or digest(path) != expected:
                fail('Service customization changed during preparation')

    def assert_drained(self):
        for table, condition in (('submission', "status='Pending' OR taskId IS NOT NULL"), ('ai_job', "status IN ('queued','running')")):
            count = self.sql(f'SELECT COUNT(*) FROM `{table}` WHERE {condition}', 'libreoj')
            if int(count):
                fail('Active or queued judge/AI work remains; drain it before maintenance')
        # A cancelled/completed AI row may still be unwinding its worker. Its
        # existing database-scoped advisory lease spans those final side effects.
        lock = 'hyhoj_ai_worker:'+hashlib.sha256(b'libreoj').hexdigest()[:48]
        for attempt in range(5):
            if self.sql(f"SELECT IS_USED_LOCK('{lock}') IS NOT NULL") == '0':
                break
            if attempt == 4:
                fail('AI worker is still releasing its lease; wait for it to finish')
            time.sleep(0.2)

    def stop_apps(self, require_drained=False):
        self.paused = True
        self.host.service('stop', 'libreoj-nginx.service')
        if require_drained:
            try:
                self.assert_drained()
            except BaseException:
                if self.states['libreoj-nginx.service']:
                    self.host.service('start', 'libreoj-nginx.service')
                self.paused = False
                raise
        if self.role == 'all':
            self.host.service('stop', 'libreoj-judge.service')
        self.host.service('stop', 'libreoj-backend.service')
        for name in ('nginx', 'backend', *(['judge'] if self.role == 'all' else [])):
            if self.host.active('libreoj-'+name+'.service'):
                fail('Application service did not stop')

    def guard_install(self):
        if not self.guard.parent.exists():
            self.guard.parent.mkdir(mode=0o755)
        safe_dir(self.guard.parent)
        if not self.guard.exists():
            fd = os.open(self.guard, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(fd, 'w') as stream:
                stream.write(GUARD)
        elif self.guard.read_text() != GUARD:
            fail('Schema guard changed during preparation')
        self.host.run(['systemctl', 'daemon-reload'])
        env = dict(x.split('=',1) for x in shlex.split(self.host.prop('libreoj-backend.service', 'Environment')) if '=' in x)
        if env.get('LIBREOJ_SCHEMA_SYNC') != '0':
            fail('Another service override defeats the schema synchronization guard')

    def switch(self):
        names = sorted({rel.parts[0] for rel, _ in source_files(self.stage)} - PERSISTENT)
        names = [name for name in names if not name.startswith('.')] + [name for name in names if name.startswith('.')]
        names.append('public')
        old = self.backup/'previous'
        old.mkdir(mode=0o700)
        for name in names:
            if not re.fullmatch(r'[A-Za-z0-9_.-]+', name) or name in PERSISTENT-{'public'}:
                fail('Unsafe deployment entry')
            record = {'name': name, 'hadOld': (self.root/name).exists(), 'oldMoved': False, 'newMoved': False}
            self.manifest['entries'].append(record)
            self.save()
            if record['hadOld']:
                os.replace(self.root/name, old/name)
                sync_directory(self.root)
                sync_directory(old)
                record['oldMoved'] = True
                self.save()
            os.replace(self.stage/name, self.root/name)
            sync_directory(self.root)
            sync_directory(self.stage)
            record['newMoved'] = True
            self.save()

    def health(self):
        for _ in range(60):
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/docs-json', timeout=2) as response:
                    value = json.load(response)
                if response.status == 200 and value.get('openapi') and value.get('paths'):
                    return
            except Exception:
                pass
            time.sleep(1)
        fail('New backend health check failed')

    def restore_states(self, verify=False):
        if self.states['libreoj-backend.service']:
            self.host.service('start', 'libreoj-backend.service')
            if verify:
                self.health()
        if self.role == 'all' and self.states['libreoj-judge.service']:
            self.host.service('start', 'libreoj-judge.service')
            if verify:
                self.host.run([self.node, self.root/'deploy/bootstrap-services.mjs', '--root', self.root, '--phase', 'verify-judge'], timeout=180)
        # Start nginx last, so a failed migration/build health check cannot admit users.
        if self.states['libreoj-nginx.service']:
            self.host.service('start', 'libreoj-nginx.service')
        for unit, expected in self.states.items():
            if self.host.active(unit) != expected:
                if not expected:
                    self.host.service('stop', unit)
                else:
                    fail('Service state restoration failed: '+unit)

    def activate(self):
        self.assert_preserved()
        if shutil.disk_usage(self.root).free < self.database_bytes*3 + 512*1024**2:
            fail('Insufficient free space for final database snapshot; services remain running')
        self.assert_drained()
        self.stop_apps(require_drained=True)
        self.assert_drained()
        self.manifest['status'] = 'maintenance'
        self.save()
        self.dump(self.backup/'database.sql')
        self.schema_on_clone(self.backup/'database.sql')
        # Audit and apply before swapping stage paths; only additive compatible DDL.
        live_audit = self.schema('libreoj')
        if live_audit['queries'] != self.manifest['schemaQueries'] or live_audit.get('migration', {}) != self.manifest['registrationMigration']:
            fail('Database schema changed since the restored-copy audit')
        self.schema('libreoj', 'apply')
        self.manifest['registrationMigrationApplied'] = True
        self.save()
        self.guard_install()
        self.switch()
        self.assert_preserved()
        self.restore_states(verify=True)
        self.manifest['status'] = 'complete'
        self.save()
        self.paused = False

    def assert_safe_downgrade(self):
        for table in ('registration_review', 'registration_application'):
            exists = self.sql(f"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='libreoj' AND TABLE_NAME='{table}'")
            if exists == '1' and int(self.sql(f"SELECT COUNT(*) FROM `{table}` WHERE status <> 'approved'", 'libreoj')):
                fail('Rollback refused: unapproved accounts/applications require the new approval gate; recover the new release without replaying stale SQL')
        # Even all-approved migrated history must not be silently orphaned by a
        # later downgrade to a version that does not understand applications.
        if self.manifest.get('registrationMigrationApplied') and (self.manifest.get('registrationMigration', {}).get('pending', 0) or self.manifest.get('registrationMigration', {}).get('rejected', 0)):
            fail('Rollback refused: this upgrade moved legacy account records; use a separately reviewed recovery procedure')

    def rollback(self, manual=False):
        # Refuse a downgrade that could turn pending/rejected accounts into active
        # users under the older authentication code. This check runs before stop.
        if manual:
            self.assert_safe_downgrade()
            self.assert_drained()
        # Tables added by this release are intentionally retained. No stale backup
        # is imported, and no account, submission or AI state is discarded.
        self.stop_apps()
        # Recheck only after nginx and backend (including in-flight requests) are
        # stopped. This also closes the automatic rollback race after reopening.
        self.assert_safe_downgrade()
        previous = self.backup/'previous'
        retired = self.backup/'retired'
        retired.mkdir(mode=0o700, exist_ok=True)
        for record in reversed(self.manifest['entries']):
            name = record['name']
            if not re.fullmatch(r'[A-Za-z0-9_.-]+', name) or name in ('.', '..') or name in PERSISTENT-{'public'}:
                fail('Unsafe rollback manifest entry')
            # Presence detects a crash between rename and manifest fsync.
            if (previous/name).exists():
                if (self.root/name).exists():
                    os.replace(self.root/name, retired/(name+'-'+secrets.token_hex(4)))
                os.replace(previous/name, self.root/name)
            elif not record['hadOld'] and (self.root/name).exists() and (record['newMoved'] or not (self.stage/name).exists()):
                os.replace(self.root/name, retired/(name+'-'+secrets.token_hex(4)))
        if not self.manifest['guardBefore'] and self.guard.exists():
            if self.guard.is_symlink() or self.guard.read_text() != GUARD:
                fail('Cannot safely remove a changed schema guard')
            self.guard.unlink()
            self.unit_fingerprint.pop(str(self.guard), None)
            self.host.run(['systemctl', 'daemon-reload'])
        self.assert_preserved()
        self.restore_states(verify=True)
        self.manifest['status'] = 'rolled-back'
        self.save()
        self.paused = False


def validate_manifest(manifest):
    entries = manifest.get('entries')
    if not isinstance(entries, list) or not isinstance(manifest.get('guardBefore'), bool):
        fail('Invalid rollback manifest')
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict):
            fail('Invalid rollback manifest entry')
        name = entry.get('name', '')
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+', name) or name in ('.', '..') or name in PERSISTENT-{'public'} or name in seen:
            fail('Unsafe rollback manifest entry')
        if any(not isinstance(entry.get(key), bool) for key in ('hadOld', 'oldMoved', 'newMoved')):
            fail('Invalid rollback manifest progress')
        seen.add(name)


def parser():
    result = argparse.ArgumentParser(allow_abbrev=False, description='官方 all/web 保守升级：保留配置、评测容量和数据；不支持任意历史版本。')
    result.add_argument('--prefix', type=Path, default=Path('/opt/LibreOJ'))
    result.add_argument('--ref', default='main')
    result.add_argument('--source', type=Path)
    result.add_argument('--source-sha256')
    result.add_argument('--verified-commit', help=argparse.SUPPRESS)
    result.add_argument('--source-digest', action='store_true', help='只读输出本地完整源码树 SHA256')
    result.add_argument('--plan', action='store_true')
    result.add_argument('--apply', action='store_true')
    result.add_argument('--drained', action='store_true')
    result.add_argument('--rollback', type=Path)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    if args.source_digest:
        if not args.source:
            fail('--source-digest requires --source')
        print(tree_digest(args.source.resolve()))
        return
    if os.geteuid() != 0:
        fail('请使用 sudo / root is required to inspect private installation metadata')
    if args.plan and (args.apply or args.rollback):
        fail('--plan cannot be combined with --apply or --rollback')
    upgrade = Upgrade(args.prefix)
    if args.rollback:
        if not args.drained:
            fail('--rollback requires --drained after pausing submissions, remote judges and AI jobs')
        backup = safe_dir(args.rollback, private=True)
        if backup.parent != args.prefix/'backups/upgrade':
            fail('Rollback path does not belong to this installation')
        private_file(backup/'manifest.json')
        manifest = json.loads((backup/'manifest.json').read_text())
        if manifest.get('version') != 1 or manifest.get('prefix') != str(args.prefix) or manifest.get('status') not in ('complete', 'maintenance', 'rollback-failed'):
            fail('Unsupported rollback manifest or state')
        validate_manifest(manifest)
        upgrade.preflight(recovery=(backup, manifest))
        upgrade.backup, upgrade.stage, upgrade.manifest = backup, backup/'staging', manifest
        if manifest['status'] != 'complete':
            saved_states = manifest.get('states')
            if not isinstance(saved_states, dict) or set(saved_states) != set(upgrade.states) or any(not isinstance(value, bool) for value in saved_states.values()):
                fail('Invalid recovery service-state manifest')
            upgrade.states = saved_states
        # Manual rollback preserves current config, key, unit customizations and
        # current service activity; only our own guard and recorded code are reverted.
        with maintenance_lock():
            upgrade.rollback(manual=True)
        print('代码回滚完成；数据库及新增兼容审核表保留。 / Code rollback complete; database retained.')
        return
    info = upgrade.preflight()
    source = args.source.resolve() if args.source else None
    provenance = {'repository': REPOSITORY}
    if source:
        source_hash = tree_digest(source)
        provenance.update(kind='local', treeSha256=source_hash)
        if args.verified_commit:
            if not re.fullmatch(r'[0-9a-f]{40}', args.verified_commit):
                fail('Invalid verified commit')
            provenance.update(kind='github-bootstrap', commit=args.verified_commit)
        if args.source_sha256 and args.source_sha256 != source_hash:
            fail('Local source digest differs from the supplied trusted release digest')
        upgrade.compatibility(source)
        info['sourceSha256'] = source_hash
        info['requiredFreeBytes'] = upgrade.check_space(source)
    else:
        provenance.update(kind='github', commit=resolve_commit(args.ref))
        info['sourceCommit'] = provenance['commit']
    if args.plan:
        info['pendingChecks'] = [*(['target source compatibility and disk budget'] if not source else []), 'isolated build', 'restored database schema audit', 'fresh maintenance-window database backup', 'health and original service states']
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return
    if source and not re.fullmatch(r'[0-9a-f]{64}', args.source_sha256 or ''):
        fail('Local apply requires --source-sha256 from a trusted release; --source-digest or --plan displays the local digest')
    if args.apply:
        if not args.drained:
            fail('--apply requires --drained; pause new requests and drain all local/remote judge and AI jobs first')
    else:
        if not sys.stdin.isatty():
            fail('Non-interactive use requires --apply --drained')
        print('请先暂停新提交/导入，排空本机及远程评测、AI 作业。升级将短暂停止网站并保留全部配置与数据。')
        if input('确认已排空并开始升级？输入 UPGRADE：').strip() != 'UPGRADE':
            fail('Upgrade cancelled before modification')
    with maintenance_lock():
        temporary = None
        try:
            # Refresh after lock acquisition; another maintenance may have completed.
            upgrade.preflight()
            if not source:
                temporary = Path(tempfile.mkdtemp(prefix='libreoj-upgrade-', dir='/var/tmp'))
                data = fetch(f'https://codeload.github.com/{REPOSITORY}/tar.gz/{provenance["commit"]}')
                provenance['archiveSha256'] = hashlib.sha256(data).hexdigest()
                source = extract_archive(data, temporary/'source')
                provenance['treeSha256'] = tree_digest(source)
            elif tree_digest(source) != provenance['treeSha256']:
                fail('Local source changed after verification')
            upgrade.assert_drained()
            try:
                upgrade.prepare(source, provenance)
            except UpgradeError as error:
                if upgrade.backup:
                    fail(str(error)+'; private preparation evidence: '+str(upgrade.backup))
                raise
            def interrupted(signum, frame):
                raise UpgradeError('Upgrade interrupted; restoring original code and service state')
            old_handlers = {s: signal.signal(s, interrupted) for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
            try:
                upgrade.activate()
            except BaseException:
                if upgrade.paused:
                    for s in old_handlers:
                        signal.signal(s, signal.SIG_IGN)
                    try:
                        upgrade.rollback()
                    except BaseException:
                        upgrade.manifest['status'] = 'rollback-failed'
                        upgrade.save()
                        # Do not claim recovery or admit requests on a broken release.
                        for unit in ('libreoj-nginx.service', 'libreoj-judge.service', 'libreoj-backend.service'):
                            upgrade.host.run(['systemctl', 'stop', unit], check=False)
                        fail('Automatic rollback failed; application services remain stopped. Private recovery backup: '+str(upgrade.backup))
                raise
            finally:
                for s, handler in old_handlers.items():
                    signal.signal(s, handler)
            print('升级完成；配置和数据保留。私有备份：'+str(upgrade.backup))
            print('Upgrade complete; configuration and data preserved. Schema auto-sync is disabled by '+str(upgrade.guard))
        finally:
            if temporary:
                shutil.rmtree(temporary)


if __name__ == '__main__':
    try:
        main()
    except UpgradeError as error:
        print('升级未完成 / Upgrade not completed: '+str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('升级未完成 / Upgrade not completed; private configuration and command output withheld.', file=sys.stderr)
        sys.exit(1)
