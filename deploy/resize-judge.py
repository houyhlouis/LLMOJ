#!/usr/bin/env python3
"""Resize an installed judge, with private snapshots and automatic rollback."""
import argparse
import base64
import contextlib
import copy
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time

import yaml
from judge_capacity import discover_capacity, select_cpu_ids, validate_slots, MAX_SLOTS
from judge_units import mount_name, render_units, workspace_paths

SERVICE = 'libreoj-judge.service'


class MaintenanceError(RuntimeError):
    pass


class Host:
    def run(self, args, check=True):
        result = subprocess.run(list(map(str, args)), capture_output=True, text=True, timeout=180)
        if check and result.returncode:
            # Neither a full command/environment nor private YAML is printed on failure.
            raise MaintenanceError(f'{args[0]} {args[1] if len(args)>1 else ""} failed (exit {result.returncode})')
        return result

    def property(self, unit, name):
        return self.run(['systemctl', 'show', unit, '-p', name, '--value']).stdout.strip()

    def active(self, unit):
        return self.run(['systemctl', 'is-active', '--quiet', unit], check=False).returncode == 0

    def enabled(self, unit):
        result = self.run(['systemctl', 'is-enabled', unit], check=False)
        state = result.stdout.strip()
        if state not in ('enabled', 'enabled-runtime', 'disabled', 'static', 'not-found', ''):
            raise MaintenanceError('Unsupported or masked unit state: '+unit)
        return state


def safe_directory(path, create=False, private=False):
    path = Path(path)
    if not path.is_absolute() or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)) or '..' in path.parts:
        raise MaintenanceError('目录必须为无空格的安全绝对路径 / unsafe directory')
    for p in [*reversed(path.parents), path]:
        if p.is_symlink():
            raise MaintenanceError('拒绝符号链接目录 / symlink directory: '+str(p))
    if create:
        path.mkdir(parents=True, exist_ok=True, mode=0o700 if private else 0o755)
    if path.exists():
        st = path.stat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise MaintenanceError('目录必须由 root 所有且不可由其他用户写入 / unsafe directory ownership: '+str(path))
        if private and st.st_mode & 0o077:
            raise MaintenanceError('备份/锁目录必须为 root 私有 / private directory required: '+str(path))
    return path


def regular(path, private=False, missing=False):
    path = Path(path)
    if missing and not path.exists() and not path.is_symlink():
        return
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_nlink != 1 or st.st_mode & (0o077 if private else 0o022):
        raise MaintenanceError('拒绝不安全的文件 / unsafe file: '+str(path))


def atomic_write(path, data, mode=0o600):
    path = Path(path)
    regular(path, missing=True)
    fd, temporary = tempfile.mkstemp(prefix='.'+path.name+'.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_config(root):
    safe_directory(root/'config')
    file = root/'config/judge.yaml'
    regular(file, private=True)
    try:
        config = yaml.safe_load(file.read_text())
        key = config['key']
        if len(key) != 40 or len(base64.b64decode(key, validate=True)) != 30:
            raise ValueError()
        paths = workspace_paths(root, config)
        if paths != [root/'data/judge/work'/str(i) for i in range(1, len(paths)+1)]:
            raise MaintenanceError('自定义工作目录需人工维护；仅支持 work/1..N / custom workspace layout')
        if config['maxConcurrentTasks'] != len(paths):
            raise MaintenanceError('现有并发数与工作目录数不一致 / inconsistent existing capacity')
        for path in [root/'data', root/'data/judge', root/'data/judge/work', *paths]:
            safe_directory(path)
        return config
    except MaintenanceError:
        raise
    except Exception:
        raise MaintenanceError('judge.yaml 无效；私有内容未输出 / invalid private judge configuration') from None


@contextlib.contextmanager
def maintenance_lock(directory=Path('/run/libreoj-installer')):
    directory = safe_directory(directory, create=True, private=True)
    fd = os.open(directory/'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o077 or st.st_nlink != 1:
            raise MaintenanceError('Unsafe installer maintenance lock')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise MaintenanceError('已有安装/维护任务运行，请稍后重试 / another installer or resize is running') from None
        yield
    finally:
        os.close(fd)


class Resize:
    def __init__(self, root, host=None, unit_directory=Path('/etc/systemd/system'), capacity=None):
        self.root = safe_directory(Path(root))
        if self.root == Path('/'):
            raise MaintenanceError('Installation prefix cannot be /')
        self.host = host or Host()
        self.units = safe_directory(Path(unit_directory))
        self.generated = safe_directory(self.root/'deploy/systemd')
        self.capacity_override = capacity  # Python tests only, no CLI/env capacity bypass.
        self.backup = None
        self.changed = False
        self.probe_started = False

    def mode(self, requested):
        membership = self.host.property(SERVICE, 'PartOf').split()
        actual = 'remote' if 'libreoj-judge.target' in membership else ('all' if 'libreoj.target' in membership else None)
        if actual is None or (requested != 'auto' and requested != actual):
            raise MaintenanceError('无法确认现有节点模式，或 --mode 不匹配 / judge target/mode mismatch')
        return actual

    def capacity(self, remote):
        if self.capacity_override is not None:
            return self.capacity_override
        control = self.host.property(SERVICE, 'ControlGroup')
        extra = None
        if control:
            # Ignore the judge's own old AllowedCPUs, but honor its parent slice.
            extra = Path('/sys/fs/cgroup')/str(Path(control).parent).lstrip('/')
        else:
            parent_slice = self.host.property(SERVICE, 'Slice')
            if parent_slice:
                parent_control = self.host.property(parent_slice, 'ControlGroup')
                if parent_control:
                    extra = Path('/sys/fs/cgroup')/parent_control.lstrip('/')
        return discover_capacity(remote, extra_cgroup=extra)

    def verify_instance(self):
        if (self.host.property(SERVICE, 'FragmentPath') != str(self.units/SERVICE) or
                self.host.property(SERVICE, 'WorkingDirectory') != str(self.root/'apps/judge')):
            raise MaintenanceError('同名服务不属于指定 prefix，拒绝覆盖 / service belongs to another prefix')
        env = dict(x.split('=', 1) for x in shlex.split(self.host.property(SERVICE, 'Environment')) if '=' in x)
        if env.get('LIBREOJ_JUDGE_CONFIG_FILE') != str(self.root/'config/judge.yaml'):
            raise MaintenanceError('生效配置路径不属于指定 prefix / configuration path differs')
        for name in ('MemoryMax', 'CPUQuotaPerSecUSec'):
            if self.host.property(SERVICE, name) not in ('infinity', 'max'):
                raise MaintenanceError('主单元已有自定义 '+name+'，请人工审查；不会静默删除 / custom service resource limit')

    def plan(self, slots=None, mode='auto'):
        self.verify_instance()
        config = read_config(self.root)
        mode = self.mode(mode)
        if mode == 'remote' and config.get('aiRunnerSocket'):
            raise MaintenanceError('远程节点仍启用本机 AI socket，请先人工检查 / remote AI socket is unexpected')
        capacity = self.capacity(mode == 'remote')
        chosen = capacity['default_slots'] if slots is None else slots
        validate_slots(chosen, capacity)
        updated = copy.deepcopy(config)
        updated.update(maxConcurrentTasks=chosen,
                       taskWorkingDirectories=[str(self.root/'data/judge/work'/str(i)) for i in range(1, chosen+1)],
                       taskConsumingThreads=min(3, max(1, chosen//2)), maxConcurrentDownloads=min(4, chosen))
        updated['cpuAffinity'] = {name:select_cpu_ids(chosen, capacity)
                                  for name in ('compiler', 'userProgram', 'interactor', 'checker')}
        for path in workspace_paths(self.root, updated):
            safe_directory(path)
        old_mounts = [mount_name(path) for path in workspace_paths(self.root, config)]
        new_units = render_units(self.root, self.root/'runtime/node/bin/node', updated, mode == 'remote')
        names = sorted(set(new_units) | set(old_mounts))
        for name in names:
            regular(self.units/name, missing=True)
            if self.host.property(name, 'DropInPaths'):
                raise MaintenanceError('存在 systemd drop-in，未覆盖或删除；请先审查：'+name)
        # Missing or unrelated installed units must not be silently taken over.
        regular(self.units/SERVICE)
        for name in old_mounts:
            regular(self.units/name)
            if 'Description=LibreOJ judge workspace\n' not in (self.units/name).read_text():
                raise MaintenanceError('现有 mount 不是本项目生成单元 / unmanaged mount: '+name)
        for name in set(new_units)-set(old_mounts)-{SERVICE, 'libreoj-judge.target'}:
            if (self.units/name).exists() or self.host.active(name):
                raise MaintenanceError('新增工作目录已有 mount 单元 / new mount already exists: '+name)
        return {'old':config, 'new':updated, 'capacity':capacity, 'mode':mode,
                'old_mounts':old_mounts, 'new_mounts':[n for n in new_units if n.endswith('.mount')],
                'units':new_units, 'names':names}

    def snapshot(self, plan):
        parent = safe_directory(self.root/'backups', create=True, private=True)
        parent = safe_directory(parent/'judge-resize', create=True, private=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        self.backup = safe_directory(parent/stamp, create=True, private=True)
        manifest = {'version':1, 'root':str(self.root), 'phase':'prepared', 'mode':plan['mode'],
                    'old_mounts':plan['old_mounts'], 'new_mounts':plan['new_mounts'],
                    'service_was_active':self.host.active(SERVICE), 'installed':{}, 'generated':{},
                    'mount_states':{}, 'new_unit_names':list(plan['units'])}
        raw = (self.root/'config/judge.yaml').read_bytes()
        if read_config(self.root) != plan['old']:
            raise MaintenanceError('配置在计划后发生变化，请重新运行 / stale plan')
        atomic_write(self.backup/'judge.yaml', raw)
        manifest['config_sha256'] = hashlib.sha256(raw).hexdigest()
        for kind, directory, names in [
            ('installed', self.units, plan['names']),
            ('generated', self.generated, sorted(set(plan['names']) | {
                p.name for p in self.generated.glob('*.mount')
                if p.is_file() and 'Description=LibreOJ judge workspace\n' in p.read_text()}))]:
            saved = safe_directory(self.backup/kind, create=True, private=True)
            for name in names:
                source = directory/name
                regular(source, missing=True)
                if source.exists():
                    content = source.read_bytes()
                    atomic_write(saved/name, content)
                    manifest[kind][name] = {'sha256':hashlib.sha256(content).hexdigest(),
                                            'mode':stat.S_IMODE(source.stat().st_mode), 'gid':source.stat().st_gid}
                else:
                    manifest[kind][name] = None
        for name in sorted(set(plan['old_mounts']) | set(plan['new_mounts'])):
            manifest['mount_states'][name] = {'active':self.host.active(name), 'enabled':self.host.enabled(name)}
        atomic_write(self.backup/'new-judge.yaml', yaml.safe_dump(plan['new'], sort_keys=False).encode())
        stage = safe_directory(self.backup/'new-units', create=True, private=True)
        for name, text in plan['units'].items():
            atomic_write(stage/name, text.encode(), 0o644)
        self.save_manifest(manifest)
        return manifest

    def save_manifest(self, manifest):
        atomic_write(self.backup/'manifest.json', (json.dumps(manifest, indent=2)+'\n').encode())

    def verify_running(self, plan):
        for path in workspace_paths(self.root, plan['new']):
            fs_type = self.host.run(['findmnt', '-n', '-o', 'FSTYPE', '--mountpoint', path]).stdout.strip()
            if fs_type != 'tmpfs':
                raise MaintenanceError('工作目录没有正确挂载 tmpfs / workspace is not tmpfs')
        if not self.host.active(SERVICE):
            raise MaintenanceError('Judge service did not become active')
        values = dict(x.split('=', 1) for x in shlex.split(self.host.property(SERVICE, 'Environment')) if '=' in x)
        if (int(values.get('UV_THREADPOOL_SIZE', '0')) < plan['new']['maxConcurrentTasks']*2+2 or
                values.get('LIBREOJ_JUDGE_CONFIG_FILE') != str(self.root/'config/judge.yaml')):
            raise MaintenanceError('生效线程池或配置路径被覆盖 / effective environment differs')
        actual = self.host.property(SERVICE, 'AllowedCPUs')
        from judge_capacity import parse_cpu_list
        expected = set(plan['new']['cpuAffinity']['userProgram'])
        if parse_cpu_list(actual.replace(' ', ',')) != expected:
            raise MaintenanceError('生效 CPU 集合被覆盖 / effective AllowedCPUs differs')
        effective = self.host.property(SERVICE, 'EffectiveCPUs')
        if not expected <= parse_cpu_list(effective.replace(' ', ',')):
            raise MaintenanceError('父 cgroup/在线 CPU 无法满足预期 CPU 集合 / effective CPUs are insufficient')
        self.verify_instance()

    def apply(self, plan):
        manifest = self.snapshot(plan)
        print('私有备份 / Private backup:', self.backup, flush=True)
        self.host.run(['systemd-analyze', 'verify', *[self.backup/'new-units'/n for n in plan['units']]])
        try:
            self.changed = True  # Include partial/failed stop in automatic rollback.
            manifest['phase'] = 'stopping'
            self.save_manifest(manifest)
            self.host.run(['systemctl', 'stop', SERVICE])
            if self.host.active(SERVICE):
                raise MaintenanceError('Judge did not stop')
            # Detect unrelated edits made after planning before replacing private config.
            if hashlib.sha256((self.root/'config/judge.yaml').read_bytes()).hexdigest() != manifest['config_sha256']:
                raise MaintenanceError('配置在计划后发生变化 / configuration changed after planning')
            atomic_write(self.root/'config/judge.yaml', (self.backup/'new-judge.yaml').read_bytes())
            for path in workspace_paths(self.root, plan['new']):
                safe_directory(path, create=True)
            for name in set(plan['old_mounts'])-set(plan['new_mounts']):
                self.host.run(['systemctl', 'disable', '--now', name])
                (self.units/name).unlink()
            for name, content in plan['units'].items():
                atomic_write(self.units/name, content.encode(), 0o644)
            # Keep deploy/systemd consistent with the new installed units.
            for name, previous in manifest['generated'].items():
                if name.endswith('.mount') and name not in plan['units'] and previous is not None:
                    (self.generated/name).unlink(missing_ok=True)
            for name, content in plan['units'].items():
                atomic_write(self.generated/name, content.encode(), 0o644)
            self.host.run(['systemctl', 'daemon-reload'])
            for name in plan['new_mounts']:
                self.host.run(['systemctl', 'enable', '--now', name])
            self.probe_started = True
            self.host.run(['systemd-run', '--unit=libreoj-resize-check', '--wait', '--pipe', '--collect',
                           '--property=Delegate=cpu memory pids', '--property=DelegateSubgroup=supervisor',
                           '--property=LimitCORE=0', '--property=RuntimeMaxSec=120', '--property=TimeoutStopSec=15',
                           '--property=WorkingDirectory='+str(self.root/'apps/judge'),
                           self.root/'runtime/node/bin/node', self.root/'deploy/sandbox/verify-installed.mjs',
                           '--root', self.root])
            self.probe_started = False
            if manifest['service_was_active']:
                self.host.run(['systemctl', 'start', SERVICE])
                time.sleep(3)
                self.verify_running(plan)
            manifest['phase'] = 'complete'
            self.save_manifest(manifest)
            print('调整完成；请确认节点在线和提交评测。原来停止的 judge 保持停止。 / Resize complete; verify judging.')
            return self.backup
        except BaseException:
            print('调整失败，正在恢复私有备份 / Resize failed; rolling back', file=sys.stderr)
            try:
                if self.probe_started:
                    self.host.run(['systemctl', 'stop', 'libreoj-resize-check.service'], check=False)
                    self.probe_started = False
                self.restore(self.backup)
            except BaseException:
                self.host.run(['systemctl', 'stop', SERVICE], check=False)
                print('自动回滚未完成；judge 保持停止，请使用 --rollback：'+str(self.backup), file=sys.stderr)
            raise

    def load_snapshot(self, backup):
        parent = self.root/'backups/judge-resize'
        backup = Path(backup)
        if backup.parent != parent:
            raise MaintenanceError('备份必须位于本实例 backups/judge-resize 的直接子目录')
        safe_directory(backup, private=True)
        regular(backup/'manifest.json', private=True)
        manifest = json.loads((backup/'manifest.json').read_text())
        if manifest.get('version') != 1 or manifest.get('root') != str(self.root):
            raise MaintenanceError('Backup belongs to another instance/version')
        if type(manifest.get('service_was_active')) is not bool or manifest.get('mode') not in ('all', 'remote'):
            raise MaintenanceError('Invalid backup service state')
        mount_lists = [manifest.get('old_mounts'), manifest.get('new_mounts')]
        if any(not isinstance(names, list) or not 1 <= len(names) <= MAX_SLOTS or
               len(names) != len(set(names)) for names in mount_lists):
            raise MaintenanceError('Invalid backup mount list')
        # Every list/key is validated before it becomes a filename or systemctl argument.
        old, new = mount_lists
        if any(names != [mount_name(self.root/'data/judge/work'/str(i)) for i in range(1, len(names)+1)]
               for names in mount_lists):
            raise MaintenanceError('Backup mount paths do not belong to this instance')
        target = {'libreoj-judge.target'} if manifest['mode'] == 'remote' else set()
        expected = set(old) | set(new) | {SERVICE} | target
        if set(manifest['installed']) != expected or set(manifest['new_unit_names']) != set(new) | {SERVICE} | target:
            raise MaintenanceError('Invalid backup installed unit list')
        mount_prefix = mount_name(self.root/'data/judge/work'/'0')[:-len('0.mount')]
        def allowed_generated(name):
            if name in {SERVICE} | target:
                return True
            match = re.fullmatch(re.escape(mount_prefix)+r'([1-9][0-9]*)\.mount', name)
            return bool(match and int(match.group(1)) <= MAX_SLOTS)
        if not all(allowed_generated(name) for name in manifest['generated']) or set(manifest['mount_states']) != set(old) | set(new):
            raise MaintenanceError('Invalid backup generated unit/state list')
        for state in manifest['mount_states'].values():
            if type(state.get('active')) is not bool or state.get('enabled') not in ('enabled', 'enabled-runtime', 'disabled', 'static', 'not-found', ''):
                raise MaintenanceError('Invalid backup mount state')
        regular(backup/'judge.yaml', private=True)
        if hashlib.sha256((backup/'judge.yaml').read_bytes()).hexdigest() != manifest['config_sha256']:
            raise MaintenanceError('Backup configuration checksum mismatch')
        for kind in ('installed', 'generated'):
            for name, info in manifest[kind].items():
                if Path(name).name != name or not name.endswith(('.mount', '.service', '.target')):
                    raise MaintenanceError('Invalid backup unit name')
                if info is not None:
                    file = backup/kind/name
                    regular(file, private=True)
                    if hashlib.sha256(file.read_bytes()).hexdigest() != info['sha256']:
                        raise MaintenanceError('Backup unit checksum mismatch')
        self.backup = backup
        return manifest

    def restore(self, backup):
        manifest = self.load_snapshot(backup)
        self.host.run(['systemctl', 'stop', SERVICE])
        for name in set(manifest['new_mounts'])-set(manifest['old_mounts']):
            if (self.units/name).exists():
                self.host.run(['systemctl', 'disable', '--now', name])
        atomic_write(self.root/'config/judge.yaml', (self.backup/'judge.yaml').read_bytes())
        for kind, directory in [('installed', self.units), ('generated', self.generated)]:
            for name, info in manifest[kind].items():
                regular(directory/name, missing=True)
                if info is None:
                    (directory/name).unlink(missing_ok=True)
                else:
                    atomic_write(directory/name, (self.backup/kind/name).read_bytes(), info['mode'])
                    os.chown(directory/name, 0, info['gid'])
        self.host.run(['systemctl', 'daemon-reload'])
        for name, state in manifest['mount_states'].items():
            if manifest['installed'].get(name) is None:
                continue
            if state['enabled'] in ('enabled', 'enabled-runtime'):
                command = ['systemctl', 'enable']
                if state['enabled'] == 'enabled-runtime':
                    command.append('--runtime')
                self.host.run([*command, name])
            elif state['enabled'] == 'disabled':
                self.host.run(['systemctl', 'disable', name])
            self.host.run(['systemctl', 'start' if state['active'] else 'stop', name])
        if manifest['service_was_active']:
            self.host.run(['systemctl', 'start', SERVICE])
            if not self.host.active(SERVICE):
                raise MaintenanceError('Restored judge is not active')
        manifest['phase'] = 'rolled_back'
        self.save_manifest(manifest)
        print('已恢复原配置与服务状态 / Original configuration and service state restored')


def main():
    parser = argparse.ArgumentParser(description='现有评测机扩缩容：默认有效 CPU 数减 2；私有备份，失败自动回滚。')
    parser.add_argument('--prefix', default='/opt/LibreOJ')
    parser.add_argument('--mode', choices=('auto', 'all', 'remote'), default='auto')
    parser.add_argument('--slots', type=int)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--plan', action='store_true', help='只读显示计划，不停止服务')
    action.add_argument('--apply', action='store_true', help='应用 --slots 指定容量')
    action.add_argument('--rollback', type=Path, help='恢复本实例私有备份')
    parser.add_argument('--drained', action='store_true', help='确认已暂停新提交/AI且所有用户任务已排空')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('请使用 sudo / root is required')
    try:
        if args.rollback:
            if not args.drained:
                raise MaintenanceError('--rollback 需要 --drained；请先暂停新任务并排空')
            with maintenance_lock():
                Resize(args.prefix).restore(args.rollback)
            return
        manager = Resize(args.prefix)
        # Show CPU-derived default even when insufficient RAM requires a smaller explicit count.
        mode = manager.mode(args.mode)
        capacity = manager.capacity(mode == 'remote')
        current = read_config(manager.root)['maxConcurrentTasks']
        print(f"当前 {current} 槽；有效 CPU {capacity['effective_cpu_count']}；默认 {capacity['default_slots']} 槽（CPU-2）；"
              f"有效内存 {capacity['memory_mib']} MiB；资源允许最多 {capacity['maximum_slots']} 槽。")
        if not capacity['default_fits']:
            print('默认容量超过资源预算；请明确选择较少槽数，不会静默降低。')
        for warning in capacity['warnings']:
            print('注意 / Notice:', warning)
        slots = args.slots
        interactive = not args.plan and not args.apply
        if interactive:
            if not sys.stdin.isatty():
                raise MaintenanceError('非交互请使用 --plan，或 --slots N --apply --drained')
            print('请先暂停新提交、重测、测试运行和 AI，并排空所有用户任务。输入数量后将立即维护；未排空请 Ctrl+C 退出。')
            answer = input(f"目标执行槽数量 [{capacity['default_slots']}]：").strip()
            slots = int(answer) if answer else capacity['default_slots']
        plan = manager.plan(slots, args.mode)
        print(f"计划：{current} → {plan['new']['maxConcurrentTasks']} 槽；CPU {plan['new']['cpuAffinity']['userProgram']}；"
              f"UV_THREADPOOL_SIZE={plan['new']['maxConcurrentTasks']*2+2}；只调整 judge。")
        if args.plan:
            return
        if interactive:
            args.drained = True  # The single numeric prompt explicitly describes immediate maintenance.
        if not args.drained or (args.apply and args.slots is None):
            raise MaintenanceError('未应用：请先排空任务；非交互应用需 --slots N --apply --drained')
        with maintenance_lock():
            # Recompute under the same lock as installer; never apply a stale pre-lock plan.
            manager = Resize(args.prefix)
            plan = manager.plan(plan['new']['maxConcurrentTasks'], args.mode)
            manager.apply(plan)
    except (Exception, KeyboardInterrupt) as error:
        if isinstance(error, (MaintenanceError, ValueError)):
            print('未完成 / Not completed: '+str(error), file=sys.stderr)
        else:
            print('未完成；请检查权限、备份和服务状态（私有配置未输出） / Maintenance failed', file=sys.stderr)
        sys.exit(1)


def handle_termination(signum, frame):
    raise KeyboardInterrupt()


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, handle_termination)
    main()
