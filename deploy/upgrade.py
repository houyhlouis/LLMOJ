#!/usr/bin/env python3
"""Conservative, dependency-preserving upgrades of official all/web installations.

No installer, configuration generator, rootfs builder, or automatic schema sync is
run. Database migration is restricted to frozen additive registration/community
contracts. A rollback never restores a stale SQL dump over user data.
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
import urllib.error
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
PERSISTENT = {'config', 'runtime', 'data', 'logs', 'backups', 'release', 'public', 'node_modules', '.git', 'changes'}
GUARD = '[Service]\nEnvironment=LIBREOJ_SCHEMA_SYNC=0\n'
GUARD_NAME = '90-libreoj-schema-sync.conf'
SERVICES = ('mariadb', 'redis', 'minio', 'backend', 'nginx')
GIB = 1024 ** 3
# This digest is reviewed together with the code changes, never learned from the
# target archive. Updating the contract requires updating this frozen pin too.
COMMUNITY_RUNTIME_CONTRACT_SHA256 = '65b3db3d76ca4062b88a99296553e136aac8cc9eff21e326d834a1a5ecc9379a'
COMMUNITY_RUNTIME_PATHS = frozenset({
    'packages/judge-protocol/src/index.ts',
    'apps/judge/src/task/index.ts',
    'apps/judge/src/task/hack/index.ts',
    'apps/judge/src/task/hack/hack.test.cjs',
    'apps/judge/src/task/self-eval/index.ts',
    'apps/judge/src/task/self-eval/self-eval.test.cjs'
})
# Judge runtime source an upgrade may change once the reviewed community runtime is deployed. Dependencies
# (package manifests and the lockfile), infrastructure and other shared packages stay frozen, because the
# installed node_modules and rootfs are reused. Changes are verified by the staged build, the judge regression
# tests, a native rebuild and a real sandbox run instead of a hash list.
RUNTIME_SOURCE_PREFIXES = ('apps/judge/', 'packages/judge-protocol/', 'packages/simple-sandbox/')
# Native inputs of each package rebuilt with cmake-js, and the addons the rebuild must produce.
NATIVE_PACKAGES = {
    'packages/simple-sandbox': {
        'name': 'simple-sandbox',
        'inputs': ('packages/simple-sandbox/native/', 'packages/simple-sandbox/CMakeLists.txt'),
        'addons': ('sandbox.node',)
    },
    'apps/judge': {
        'name': '@libreoj/judge',
        'inputs': ('apps/judge/native/', 'apps/judge/CMakeLists.txt', 'apps/judge/vendor/'),
        'addons': ('builtin_checkers.node', 'fs_native.node', 'posix.node')
    }
}
JUDGE_REGRESSIONS = ('apps/judge/src/task/hack/hack.test.cjs', 'apps/judge/src/task/self-eval/self-eval.test.cjs',
                     'apps/judge/src/rpc.test.cjs', 'apps/judge/src/executionScheduler.test.cjs',
                     'apps/judge/src/selfTestConfig.test.cjs', 'apps/judge/src/fileContent.test.cjs',
                     'apps/judge/src/task/ai-execution/ai-execution.test.cjs')
COMMUNITY_PERMISSIONS = (
    'ViewTeam', 'CreateTeam', 'ManageTeams', 'FakeSubmission',
    'ViewHack', 'CreateHack', 'ManageHack', 'CreateSelfEval'
)


def say(english, chinese):
    """A message for people in the entry script's language: upgrade.zh-CN.sh sets LLMOJ_LANG=zh-CN."""
    return chinese if os.environ.get('LLMOJ_LANG') == 'zh-CN' else english


class UpgradeError(RuntimeError):
    """Only deliberately non-sensitive messages may reach the terminal."""


def fail(message):
    raise UpgradeError(message)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def compatibility_digest(relative, path):
    if relative == 'packages/judge-protocol/src/index.ts':
        # The sole wire-compatible protocol change accepted by this release:
        # append the moderation-only status after every existing enum value.
        # No task/progress payload, existing status or other source may change.
        content = Path(path).read_text()
        content = content.replace(
            '  JudgementFailed = "JudgementFailed",\n  Fake = "Fake"\n}',
            '  JudgementFailed = "JudgementFailed"\n}'
        )
        return hashlib.sha256(content.encode()).hexdigest()
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


def community_runtime_transition(source, before, after, deployed_by_upgrade=False):
    """Accept one pinned runtime transition from older baselines; no wildcard or unreviewed hash.

    Paths already at the reviewed target are not part of the transition; later runtime changes to them
    follow the general runtime policy, but may not revert them to an older baseline. A path an earlier
    upgrade already moved past the target is likewise left to the general policy, but only when
    `deployed_by_upgrade` proves that the installed source is exactly what a completed upgrade deployed.
    """
    contract_path = Path(source)/'deploy/community-runtime-contract.json'
    if not contract_path.is_file() or contract_path.is_symlink() or contract_path.stat().st_size > 32768:
        fail('Dependencies changed without the frozen community runtime contract')
    if digest(contract_path) != COMMUNITY_RUNTIME_CONTRACT_SHA256:
        fail('Community runtime contract differs from the reviewed frozen digest')
    try:
        contract = json.loads(contract_path.read_text())
        if not isinstance(contract, dict):
            fail('Invalid community runtime contract')
        entries = contract['files']
    except (OSError, UnicodeError, ValueError, KeyError):
        fail('Invalid community runtime contract')
    if not isinstance(contract, dict) or contract.get('version') != 1 or not isinstance(entries, list):
        fail('Invalid community runtime contract')
    paths = set()
    approved = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'path', 'oldSha256', 'newSha256'}:
            fail('Invalid runtime contract entry')
        relative = entry['path']
        old_hashes, target_hash = entry['oldSha256'], entry['newSha256']
        if not isinstance(relative, str) or relative not in COMMUNITY_RUNTIME_PATHS or relative in paths:
            fail('Unreviewed runtime contract path')
        paths.add(relative)
        if not isinstance(old_hashes, list) or not old_hashes or len(old_hashes) > 3 or any(
            value is not None and (not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value))
            for value in old_hashes
        ) or not isinstance(target_hash, str) or not re.fullmatch(r'[0-9a-f]{64}', target_hash):
            fail('Invalid runtime contract digest')
        if before.get(relative) == target_hash or (deployed_by_upgrade and before.get(relative) not in old_hashes):
            if after.get(relative) != target_hash and after.get(relative) in old_hashes:
                fail('Target runtime code reverts the reviewed community runtime')
            continue
        if before.get(relative) not in old_hashes:
            fail('Deployed runtime code differs from the supported community baselines')
        if after.get(relative) != target_hash:
            fail('Target runtime code differs from the reviewed frozen contract')
        approved.add(relative)
    if paths != COMMUNITY_RUNTIME_PATHS:
        fail('Incomplete community runtime contract')
    return approved


def runtime_source(relative):
    return relative.startswith(RUNTIME_SOURCE_PREFIXES) and Path(relative).name != 'package.json'


def protocol_enums(text):
    """Exported enums of the shared judge protocol, as {enum: {member: value}}."""
    return {match[1]: dict(re.findall(r'^\s*(\w+)\s*=\s*("[^"]*"|-?\d+)\s*,?\s*$', match[2], re.M))
            for match in re.finditer(r'export enum (\w+)\s*\{([^}]*)\}', text)}


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
            if rel == Path('packages/bootstrap-config/config.json') or name.endswith(('.pyc', '.tsbuildinfo')) or name in ('.DS_Store', 'stats.html', '.eslintcache') or (not relative.parts and name in PERSISTENT):
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


def fetch(url, maximum=256*1024*1024, accept='application/vnd.github+json'):
    request = urllib.request.Request(url, headers={'User-Agent': 'LLMOJ-safe-upgrade', 'Accept': accept})
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
    commit = fetch(f'https://api.github.com/repos/{REPOSITORY}/commits/{urllib.parse.quote(ref, safe="")}', 1024*1024, 'application/vnd.github.sha').decode().strip()
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
        self.runtime_changes = []
        self.native_rebuild = []
        self.sandbox_changed = False

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
                'services': self.states, 'databaseBytes': self.database_bytes, 'scope': 'dependency/native-preserving code + frozen community/contest/permission schema + reviewed Hack/SelfEval runtime + verified data migration'}

    def deployed_by_upgrade(self):
        """Whether the installed source is exactly what one of this installation's completed upgrades deployed."""
        installed = None
        for manifest in sorted((self.root/'backups/upgrade').glob('*/manifest.json')):
            try:
                record = json.loads(manifest.read_text())
            except (OSError, UnicodeError, ValueError):
                continue
            if not isinstance(record, dict) or not isinstance(record.get('provenance'), dict):
                continue
            tree = record['provenance'].get('treeSha256')
            if record.get('status') != 'complete' or not isinstance(tree, str):
                continue
            if installed is None:
                installed = tree_digest(self.root)
            if tree == installed:
                return True
        return False

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
        changed = {name for name in set(source_dependencies) | set(old_dependencies)
                   if source_dependencies.get(name) != old_dependencies.get(name)}
        approved_runtime = (community_runtime_transition(source, old_map, source_map, self.deployed_by_upgrade())
                            if changed else set())
        runtime_changes = changed - approved_runtime
        if any(not runtime_source(name) for name in runtime_changes):
            fail('Dependencies, infrastructure or unsupported shared packages changed outside the frozen runtime contract')
        if approved_runtime and self.role != 'all':
            fail('The new Hack/SelfEval runtime requires an all installation; remote judges need a separately coordinated upgrade')
        self.runtime_changes = sorted(runtime_changes)
        # A web installation runs no local judge or sandbox, so there is nothing native to rebuild.
        self.native_rebuild = sorted(package for package, native in NATIVE_PACKAGES.items()
                                     if self.role == 'all' and any(name.startswith(native['inputs']) for name in runtime_changes))
        self.sandbox_changed = self.role == 'all' and any(name.startswith('packages/simple-sandbox/') for name in runtime_changes)
        protocol = 'packages/judge-protocol/src/index.ts'
        if protocol in source_map and protocol in old_map:
            # Judges and the backend may run different releases (remote judges, rollback), so deployed protocol
            # values may only be added to, never removed or changed.
            before = protocol_enums((self.root/protocol).read_text())
            after = protocol_enums((source/protocol).read_text())
            if any(after.get(enum, {}).get(member) != value for enum, members in before.items() for member, value in members.items()):
                fail('Removing or changing deployed judge protocol values is unsupported; use a reviewed rollback')
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
        for name in ('apps/backend/src', 'apps/judge/src', 'packages/frontend/src'):
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
                   pnpm_config_verify_deps_before_run='false', PNPM_BINARY=str(self.pnpm), HYHOJ_PUBLIC_DIR=str(self.stage/'public'), OJ_SITE_NAME=self.site_name,
                   # Native addons build offline against the installed Node headers, as the installer does.
                   npm_config_nodedir=str(self.root/'runtime/node'))
        fd = os.open(self.backup/'build.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as log:
            commands = [[self.node, self.pnpm, '--filter', '@libreoj/judge-protocol', 'run', 'build']]
            if self.role == 'all':
                if self.sandbox_changed:
                    # The sandbox's compiled TypeScript (lib) is not part of the source tree.
                    commands.append([self.node, self.pnpm, '--filter', 'simple-sandbox', 'run', 'build'])
                for package in self.native_rebuild:
                    # The copied build directory belongs to the live tree; configure from scratch.
                    shutil.rmtree(self.stage/package/'build', ignore_errors=True)
                    commands.append([self.node, self.pnpm, '--filter', NATIVE_PACKAGES[package]['name'], 'run', 'build:native'])
                if 'apps/judge' in self.native_rebuild:
                    commands.append([self.node, self.pnpm, '--filter', '@libreoj/judge', 'run', 'test:native'])
            commands.append([self.node, self.pnpm, '--filter', '@libreoj/judge', 'run', 'check-types'])
            for regression in JUDGE_REGRESSIONS:
                if (self.stage/regression).is_file():
                    commands.append([self.node, '--test', self.stage/regression])
            commands.extend([
                [self.node, self.pnpm, '--filter', '@libreoj/backend', 'run', 'build'],
                [self.node, self.pnpm, '--filter', '@libreoj/frontend', 'run', 'build'],
                [self.node, self.stage/'deploy/build-frontend-offline.mjs']
            ])
            for command in commands:
                self.host.run(command, cwd=self.stage, env=env, output=log, error_output=log, timeout=1800, umask=0o022)
        if not (self.stage/'apps/backend/dist/main.js').is_file() or not (self.stage/'public/index.html').is_file() or not (self.stage/'public/offline-manifest.json').is_file():
            fail('Build did not produce required artifacts')
        for package in self.native_rebuild:
            if not all((self.stage/package/'build/Release'/addon).is_file() for addon in NATIVE_PACKAGES[package]['addons']):
                fail('Native rebuild did not produce the required addons')
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
                'SCHEMA_CHANGE_UNSUPPORTED': ('the database structure change is not supported', '数据库结构变更不在支持范围'),
                'LEGACY_NONDEFAULT_PROFILE': ('an unactivated old account has a non-default or incomplete profile',
                                              '旧未激活账号有非默认资料或缺失账户记录'),
                'LEGACY_CREDENTIALS_OR_PREFERENCES': ('old credentials or preferences need a manual review', '旧凭据或偏好需要人工审查'),
                'LEGACY_REVIEW_METADATA': ('old registration review records are inconsistent', '旧审核记录不一致'),
                'LEGACY_INVALID_ACCOUNT': ('an old registration review refers to an invalid account', '旧审核引用无效账号'),
                'APPLICATION_CONFLICT': ("a registration application's username, email or account conflicts with another",
                                         '已有申请的用户名、邮箱或账号关联冲突'),
                'UNKNOWN_TABLE': ('unknown database tables may refer to old accounts', '未知数据库表可能引用旧账号'),
                'UNKNOWN_FOREIGN_KEY': ('an unknown foreign key needs a manual review', '未知外键需要人工审查'),
                'LEGACY_BUSINESS_REFERENCES': ('an unactivated old account already has content, privileges or links',
                                               '旧未激活账号已有业务内容、权限或关联'),
                'LEGACY_UNSUPPORTED_AUDIT': ('an old account has audit history the migration does not support',
                                             '旧账号有注册白名单之外的审计历史'),
                'AUDIT_COPY_VERIFICATION': ('reading back the archived audit records failed', '审计归档回读校验失败'),
                'MIGRATION_CONCURRENT_CHANGE': ('records changed during the migration', '迁移期间记录变化'),
                'MIGRATION_WRITE_VERIFICATION': ('verifying the migrated records failed', '迁移写入校验失败')
            }
            reason = reasons.get(code, ('the database operation failed (connection details are not shown)',
                                        '数据库操作失败（未输出连接信息）'))
            fail(say('Database upgrade refused ('+code+'): ', '数据库升级被拒绝（'+code+'）：')+say(*reason))
        return json.loads(result.stdout)

    def schema_on_clone(self, dump):
        database = 'libreoj_upgrade_'+secrets.token_hex(8)
        self.sql(f'CREATE DATABASE `{database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
        try:
            self.host.run(['mariadb', '--protocol=socket', f'--socket={self.root}/data/mariadb/mysql.sock', '--user=root', database], input=dump, timeout=1800)
            audit = self.schema(database)
            self.schema(database, 'apply')
            verified = self.schema(database)
            if verified['queries'] or any(verified.get('migration', {}).get(key, 0) for key in ('pending', 'rejected', 'approvedHistory')) or verified.get('solutions', {}).get('pending', 0) or verified.get('solutions', {}).get('schemaPending', False) or verified.get('teamStorage', {}).get('pending', 0) or verified.get('teamStorage', {}).get('schemaPending', False):
                fail('Restored database migration is not stable')
            self.manifest['schemaQueries'] = audit['queries']
            self.manifest['registrationMigration'] = audit.get('migration', {})
            self.manifest['solutionMigration'] = audit.get('solutions', {})
            self.manifest['teamStorageMigration'] = audit.get('teamStorage', {})
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
        for table in ('hack', 'self_eval', 'self_eval_set'):
            exists = self.sql(f"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='libreoj' AND TABLE_NAME='{table}'")
            if exists == '1' and int(self.sql(f"SELECT COUNT(*) FROM `{table}` WHERE status IN ('Pending','Running') OR taskId IS NOT NULL", 'libreoj')):
                fail('Active or queued Hack/SelfEval work remains; drain it before maintenance')
        # The durable judge queue's own record of queued and running tasks
        exists = self.sql("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='libreoj' AND TABLE_NAME='judge_job'")
        if exists == '1' and int(self.sql("SELECT COUNT(*) FROM `judge_job` WHERE state IN ('Queued','Leased')", 'libreoj')):
            fail('Active or queued judge work remains; drain it before maintenance')
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

    def verify_sandbox(self):
        """Check the staged sandbox and judge on this host, while the judge is stopped."""
        if self.sandbox_changed:
            # The installer's sandbox check, with the staged sandbox
            self.host.run(['systemd-run', '--unit=libreoj-install-sandbox-check', '--wait', '--pipe', '--collect',
                           '--property=Delegate=cpu memory pids', '--property=DelegateSubgroup=supervisor',
                           '--property=LimitCORE=0', '--property=RuntimeMaxSec=120', '--property=TimeoutStopSec=15',
                           '--property=WorkingDirectory='+str(self.stage/'apps/judge'),
                           self.node, self.stage/'deploy/sandbox/verify-installed.mjs', '--root', self.root,
                           '--sandbox', self.stage/'packages/simple-sandbox'], timeout=180)
        if self.role == 'all' and self.runtime_changes and (self.stage/'apps/judge/self-test.mjs').is_file():
            # Every language compiled and run through the staged judge and sandbox, and the syscall filter probed
            self.host.run(['systemd-run', '--unit=libreoj-judge-self-test', '--wait', '--pipe', '--collect',
                           '--property=Delegate=cpu memory pids', '--property=DelegateSubgroup=supervisor',
                           '--property=LimitCORE=0', '--property=RuntimeMaxSec=900', '--property=TimeoutStopSec=15',
                           '--property=WorkingDirectory='+str(self.stage/'apps/judge'),
                           '--setenv=UV_THREADPOOL_SIZE=16',
                           '--setenv=PATH='+str(Path(self.node).parent)+':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                           self.node, '-r', '@swc-node/register', 'self-test.mjs',
                           '--config', self.root/'config/judge.yaml'], timeout=960)

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
        """Waits until the backend reports that its database, Redis and storage answer (`/api/health/ready`). A
        backend from before the readiness check (a rollback to it) answers 404 there; its API description is checked
        instead."""
        legacy = False
        for _ in range(60):
            try:
                if legacy:
                    with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/docs-json', timeout=2) as response:
                        value = json.load(response)
                    if response.status == 200 and value.get('openapi') and value.get('paths'):
                        return
                else:
                    with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/api/health/ready', timeout=5) as response:
                        if response.status == 200 and json.load(response).get('status') == 'ready':
                            return
            except urllib.error.HTTPError as error:
                legacy = legacy or error.code == 404
                error.close()
            except Exception:
                pass
            time.sleep(1)
        fail('New backend health check failed')

    def discard_staged_dependencies(self):
        """The build's copy of the dependencies isn't used after a completed upgrade: the installed ones stay in place
        and a rollback restores only what `previous/` holds. Without this, every upgrade backup keeps about 1 GiB."""
        staged = self.stage/'node_modules'
        try:
            if staged.is_dir() and not staged.is_symlink():
                shutil.rmtree(staged)
        except OSError:
            print(say('Note: could not delete the build copy of dependencies in ', '提示：未能删除构建用的依赖副本 ')+str(staged), file=sys.stderr)

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
        # Before any database change: a sandbox that fails its check leaves nothing to undo but service states.
        self.verify_sandbox()
        self.dump(self.backup/'database.sql')
        self.schema_on_clone(self.backup/'database.sql')
        # Audit and apply before swapping stage paths; only additive compatible DDL.
        live_audit = self.schema('libreoj')
        if live_audit['queries'] != self.manifest['schemaQueries'] or live_audit.get('migration', {}) != self.manifest['registrationMigration'] or live_audit.get('solutions', {}) != self.manifest.get('solutionMigration', {}) or live_audit.get('teamStorage', {}) != self.manifest.get('teamStorageMigration', {}):
            fail('Database schema changed since the restored-copy audit')
        # MariaDB DDL can commit before a later statement fails. Install and
        # record the guard before the first mutation so rollback cannot let an
        # older backend synchronize away a partially applied schema.
        self.manifest['communitySchemaApplied'] = any(
            re.search(r'`(?:team(?:_[a-z]+)*|file|discussion|submission|hack(?:_[a-z]+)*|self_eval(?:_[a-z]+)*|contest|user_privilege|user_permission_rule|user_two_factor|user_passkey|judge_job(?:_attempt)?|judge_client|problem_data_version|deferred_file_deletion|submission_result_history|statistics_outbox|ai_reservation)`', query)
            for query in self.manifest['schemaQueries']
        )
        self.save()
        self.guard_install()
        self.manifest['registrationMigrationApplied'] = True
        self.save()
        applied = self.schema('libreoj', 'apply')
        self.manifest['teamStorageMigrationResult'] = applied.get('teamStorage', {})
        self.save()
        self.switch()
        self.assert_preserved()
        self.restore_states(verify=True)
        self.manifest['status'] = 'complete'
        self.save()
        self.paused = False
        self.discard_staged_dependencies()

    def assert_safe_downgrade(self):
        # Old backends only read YAML and would silently ignore a saved website
        # registration policy. Check before stopping and again after draining.
        previous_backend = self.backup/'previous/apps/backend'
        # Old code has no team access floor and cannot honor moderation or the
        # separate solution category. Never expose private resources by restoring
        # it once these features have data, even if all registrations are approved.
        candidate = previous_backend if previous_backend.exists() else self.root/'apps/backend'
        for table, column, condition, capability in (
            ('team', None, '1=1', 'dist/team/team.service.js'),
            ('submission', 'status', "status='Fake'", 'dist/submission/dto/fake-submission-request.dto.js'),
            ('discussion', 'type', "type='Solution'", 'dist/discussion/discussion-type.enum.js')
        ):
            if (candidate/capability).is_file():
                continue
            table_exists = self.sql(f"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='libreoj' AND TABLE_NAME='{table}'")
            if table_exists != '1':
                continue
            if column and self.sql(f"SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='libreoj' AND TABLE_NAME='{table}' AND COLUMN_NAME='{column}'") != '1':
                continue
            if int(self.sql(f'SELECT COUNT(*) FROM `{table}` WHERE {condition}', 'libreoj')):
                fail('Rollback refused: team, solution or Fake data requires the current access and moderation rules; repair this release without importing a stale SQL backup')
        def supports(capability, token=None):
            path = candidate/capability
            return path.is_file() and (token is None or token in path.read_text())

        def requires(table, condition='1=1', column=None):
            exists = self.sql(f"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='libreoj' AND TABLE_NAME='{table}'")
            if exists != '1':
                return False
            if column and self.sql(f"SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='libreoj' AND TABLE_NAME='{table}' AND COLUMN_NAME='{column}'") != '1':
                return False
            return int(self.sql(f'SELECT COUNT(*) FROM `{table}` WHERE {condition}', 'libreoj')) > 0

        # Reverting backend code while retaining a newer judge protocol can still
        # ignore zero scores, quotas or explicit permission denies. Capabilities
        # are checked independently; no migration SQL is replayed backwards.
        judge = candidate.parent/'judge/src/task'
        hack_supported = supports('dist/hack/hack.service.js') and (self.role != 'all' or (judge/'hack/index.ts').is_file())
        self_eval_supported = supports('dist/self-eval/self-eval.service.js') and (self.role != 'all' or (judge/'self-eval/index.ts').is_file())
        extensions = (
            ('hack', hack_supported), ('hack_problem', hack_supported),
            ('self_eval', self_eval_supported), ('self_eval_set', self_eval_supported), ('self_eval_quota', self_eval_supported)
        )
        if any(not supported and requires(table) for table, supported in extensions):
            fail('Rollback refused: Hack or SelfEval data requires the current backend and judge; repair this release without replaying stale SQL')
        if requires('team') and not supports('dist/team/team.service.js', 'joinPreview'):
            fail('Rollback refused: private teams require ID-based admission and personal-only listings')
        if (requires('team', 'quotaLimit=10737418240', 'quotaLimit') or requires('team_file_upload')) and not supports('dist/team/team.service.js', 'cancelFileUpload'):
            fail('Rollback refused: 10 GiB team storage and upload reservations require the current upload backend')
        if requires('file', 'size>2147483647', 'size') and not supports('dist/file/file.entity.js', 'bigint'):
            fail('Rollback refused: large stored files require the current bigint file metadata')
        if requires('hack_problem', 'standardContent IS NOT NULL', 'standardContent') and not supports('dist/hack/hack.service.js', 'standardContent'):
            fail('Rollback refused: saved STD source requires code-based Hack references')
        hack_io_supported = supports('dist/hack/hack.service.js', 'referenceFileIo') and (
            self.role != 'all' or ((judge/'hack/index.ts').is_file() and 'referenceFileIo' in (judge/'hack/index.ts').read_text()))
        if not hack_io_supported and (
            requires('hack_problem', "JSON_CONTAINS_PATH(standardContent, 'one', '$.fileIo') = 1", 'standardContent') or
            requires('hack', "JSON_CONTAINS_PATH(snapshot, 'one', '$.referenceFileIo') = 1", 'snapshot')):
            fail('Rollback refused: saved STD input/output settings require the corrected Hack backend')
        if any(requires(table) for table in ('self_eval', 'self_eval_set', 'self_eval_quota')) and not supports(
                'dist/self-eval/self-eval.service.js', 'Self evaluation is available only in enabled NOI contests'):
            fail('Rollback refused: Self Eval records require the enabled-NOI-only access boundary')
        if not supports('dist/submission/submission.service.js', 'Hacked') and requires('submission', "status='Hacked'", 'status'):
            fail('Rollback refused: Hacked submissions require the current effective-zero scoring rules')
        if not supports('dist/contest/contest-rules.js', 'strictioi') and requires('contest', "rule='strictioi'", 'rule'):
            fail('Rollback refused: Strict IOI contests require the current per-subtask scoring rules')
        feature_options = "ruleOptions IS NOT NULL AND JSON_CONTAINS_PATH(ruleOptions, 'one', '$.hackEnabled', '$.hackStartTime', '$.hackEndTime', '$.selfEvalEnabled', '$.selfEvalMaxAttempts')"
        if not (supports('dist/contest/contest-rules.js', 'selfEvalEnabled') and supports('dist/contest/contest-rules.js', 'hackEnabled')) and requires('contest', feature_options, 'ruleOptions'):
            fail('Rollback refused: saved contest Hack/SelfEval settings require this release')
        # An older backend would sign these accounts in with the password alone.
        if not supports('dist/auth/two-factor/two-factor.service.js') and (
            requires('user_two_factor', 'totpSecret IS NOT NULL', 'totpSecret') or requires('user_passkey')):
            fail('Rollback refused: accounts with two-factor sign-in would be signed in by password alone; an administrator can turn it off for those accounts first, or repair this release')
        permission_catalog = candidate/'dist/access/permission-catalog.js'
        understands_permissions = permission_catalog.is_file() and all(value in permission_catalog.read_text() for value in COMMUNITY_PERMISSIONS)
        permissions = ','.join("'"+value+"'" for value in COMMUNITY_PERMISSIONS)
        if not understands_permissions and (
            requires('user_privilege', 'privilegeType IN ('+permissions+')', 'privilegeType') or
            requires('user_permission_rule', 'permission IN ('+permissions+')', 'permission')
        ):
            fail('Rollback refused: new community permission grants or explicit denies require the current permission catalog')
        if previous_backend.exists() and not (previous_backend/'dist/settings/registration-settings.service.js').is_file():
            overrides = self.sql("SELECT COUNT(*) FROM `settings` WHERE `key`='registration-policy' AND (COALESCE(JSON_TYPE(`value`), '') <> 'OBJECT' OR COALESCE(JSON_TYPE(JSON_EXTRACT(`value`, '$.registrationMode')), 'MISSING') <> 'NULL')", 'libreoj')
            if int(overrides):
                fail('Rollback refused: the saved website registration policy requires this release; restore server configuration in Website Management before downgrading, or recover the new release')
        # An older backend ignores the AI pause and budgets: AI would resume, unlimited, after the downgrade.
        if previous_backend.exists() and not (previous_backend/'dist/settings/ai-policy.service.js').is_file():
            limited = self.sql("SELECT COUNT(*) FROM `settings` WHERE `key`='ai-policy' AND (COALESCE(JSON_TYPE(`value`), '') <> 'OBJECT' OR COALESCE(JSON_EXTRACT(`value`, '$.paused'), 'false') <> 'false' OR COALESCE(JSON_EXTRACT(`value`, '$.userDailyTokens'), '0') <> '0' OR COALESCE(JSON_EXTRACT(`value`, '$.userDailyRequests'), '0') <> '0')", 'libreoj')
            if int(limited):
                fail(say('Rollback refused: the older release would ignore the AI pause and budgets saved in Site management; turn them off there before downgrading, or repair this release',
                         '拒绝回滚：旧版本会忽略在网站管理中保存的 AI 暂停和预算；请先在网站管理中关闭它们再回滚，或修复当前版本'))
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
        if not self.manifest['guardBefore'] and not self.manifest.get('communitySchemaApplied') and self.guard.exists():
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
    result = argparse.ArgumentParser(allow_abbrev=False, description=say(
        'Upgrade an official all/web installation, keeping its configuration, judge capacity and data. '
        'Only the supported upgrade paths are accepted.',
        '官方 all/web 保守升级：保留配置、评测容量和数据；不支持任意历史版本。'))
    result.add_argument('--prefix', type=Path, default=Path('/opt/LLMOJ'))
    result.add_argument('--ref', default='main')
    result.add_argument('--source', type=Path)
    result.add_argument('--source-sha256')
    result.add_argument('--verified-commit', help=argparse.SUPPRESS)
    result.add_argument('--source-digest', action='store_true', help=say('Print the SHA-256 of a local source tree, read-only',
                                                                          '只读输出本地完整源码树 SHA256'))
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
        fail(say('Run with sudo: root is required to read the private installation metadata',
                 '请使用 sudo 运行：需要 root 权限读取私有安装信息'))
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
        print(say('Code rollback complete; the database, including tables added since, is kept.',
                  '代码回滚完成；数据库及新增兼容审核表保留。'))
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
        info['runtimeChanges'] = len(upgrade.runtime_changes)
        info['nativeRebuild'] = upgrade.native_rebuild
        if upgrade.runtime_changes and upgrade.role == 'web':
            info['remoteJudges'] = 'Judge runtime changed: update remote judges separately (wiki/Remote-Judge.md)'
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
        print(say('Pause new submissions and imports, and wait until judging (local and remote) and AI jobs have '
                  'finished. The upgrade stops the website briefly and keeps all configuration and data.',
                  '请先暂停新提交/导入，排空本机及远程评测、AI 作业。升级将短暂停止网站并保留全部配置与数据。'))
        if input(say('Type UPGRADE to confirm that everything has finished and start: ',
                     '确认已排空并开始升级？输入 UPGRADE：')).strip() != 'UPGRADE':
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
            print(say('Upgrade complete; configuration and data kept. Private backup: ',
                      '升级完成；配置和数据保留。私有备份：')+str(upgrade.backup))
            print(say('Automatic schema synchronization stays disabled by ', '数据库结构自动同步保持关闭：')+str(upgrade.guard))
        finally:
            if temporary:
                shutil.rmtree(temporary)


if __name__ == '__main__':
    try:
        main()
    except UpgradeError as error:
        print(say('Upgrade not completed: ', '升级未完成：')+str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print(say('Upgrade not completed (private configuration and command output are not shown).',
                  '升级未完成（未输出私有配置和命令输出）。'), file=sys.stderr)
        sys.exit(1)
