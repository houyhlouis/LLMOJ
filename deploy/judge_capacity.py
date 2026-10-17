#!/usr/bin/env python3
"""Read-only, stdlib-only judge capacity policy shared by installer and resize."""
import argparse
import json
import math
import os
from pathlib import Path

MAX_SLOTS = 511  # UV_THREADPOOL_SIZE >= slots * 2 + 2, and <= 1024.
SLOT_MEMORY_MIB = 256


class CapacityError(ValueError):
    pass


def parse_cpu_list(value):
    result = set()
    for part in value.strip().split(','):
        if not part:
            continue
        bounds = part.split('-')
        if len(bounds) == 1:
            result.add(int(bounds[0]))
        elif len(bounds) == 2 and int(bounds[0]) <= int(bounds[1]):
            result.update(range(int(bounds[0]), int(bounds[1]) + 1))
        else:
            raise CapacityError('Invalid effective CPU list')
    return result


def _ancestors(path, mount):
    while path.is_relative_to(mount):
        yield path
        if path == mount:
            break
        path = path.parent


def _cgroup_directory(proc, mount):
    try:
        group = next(line.split(':', 2)[2] for line in (proc/'self/cgroup').read_text().splitlines()
                     if line.startswith('0::'))
    except (OSError, StopIteration):
        return None
    # A cgroup namespace can expose its own root at /sys/fs/cgroup.
    candidate = mount / group.lstrip('/')
    if candidate.is_dir() and candidate.resolve().is_relative_to(mount.resolve()):
        return candidate
    return mount if (mount/'cgroup.controllers').exists() else None


def discover_capacity(remote=False, *, proc_root=Path('/proc'), cgroup_root=Path('/sys/fs/cgroup'),
                      affinity=None, extra_cgroup=None):
    """Return a non-sensitive dict, reserving one CPU and 256 MiB per slot.

    extra_cgroup can be a service's parent slice, excluding its old AllowedCPUs.
    Test-only path arguments are explicit Python parameters, never env overrides.
    """
    proc, mount = Path(proc_root), Path(cgroup_root)
    cpus = set(os.sched_getaffinity(0) if affinity is None else affinity)
    meminfo = dict(line.split(':', 1) for line in (proc/'meminfo').read_text().splitlines())
    memory_bytes = int(meminfo['MemTotal'].split()[0]) * 1024
    quota = None
    warnings = []
    current = _cgroup_directory(proc, mount)
    groups = list(_ancestors(current, mount)) if current else []
    if not current:
        warnings.append('No readable cgroup v2 hierarchy; affinity and host RAM only')
    if extra_cgroup is not None:
        extra = Path(extra_cgroup).resolve()
        if not extra.is_relative_to(mount.resolve()) or not extra.is_dir():
            raise CapacityError('Invalid service parent cgroup')
        groups.extend(_ancestors(extra, mount.resolve()))
    for group in dict.fromkeys(groups):
        for name in ('cpuset.cpus.effective', 'cpu.max', 'memory.max'):
            path = group/name
            if not path.exists():
                continue
            value = path.read_text().strip()
            if name == 'cpuset.cpus.effective' and value:
                cpus &= parse_cpu_list(value)
            elif name == 'cpu.max':
                maximum, period = value.split()
                if maximum != 'max':
                    amount = int(maximum) / int(period)
                    quota = amount if quota is None else min(quota, amount)
            elif name == 'memory.max' and value != 'max':
                memory_bytes = min(memory_bytes, int(value))
    if not cpus or (quota is not None and quota <= 0):
        raise CapacityError('No effective CPU capacity is available')
    effective = min(len(cpus), max(1, math.floor(quota))) if quota is not None else len(cpus)
    memory_mib = memory_bytes // (1024 * 1024)
    cpu_slots = max(0, effective - 1)
    memory_slots = memory_mib // SLOT_MEMORY_MIB
    maximum = min(cpu_slots, memory_slots, MAX_SLOTS)
    return {'cpu_ids': sorted(cpus), 'logical_cpu_count': len(cpus), 'cpu_quota': quota,
            'effective_cpu_count': effective, 'memory_mib': memory_mib,
            'cpu_slots': cpu_slots, 'reserve_memory_mib': 0, 'slot_memory_mib': SLOT_MEMORY_MIB,
            'memory_slots': memory_slots, 'default_slots': maximum, 'maximum_slots': maximum,
            'default_fits': True, 'runtime_max_slots': MAX_SLOTS,
            'remote': remote, 'warnings': warnings}


def say(english, chinese):
    """The message in the language of the entry script: the Chinese ones (install.zh-CN.sh, upgrade.zh-CN.sh,
    resize-judge.zh-CN.sh) set LLMOJ_LANG or LLMOJ_INSTALL_LANG to zh-CN; everything else is English."""
    return chinese if (os.environ.get('LLMOJ_LANG') or os.environ.get('LLMOJ_INSTALL_LANG')) == 'zh-CN' else english


def validate_slots(slots, capacity):
    if capacity['maximum_slots'] < 1:
        raise CapacityError(say(f"No judge capacity: at least 2 effective CPUs and {SLOT_MEMORY_MIB} MiB RAM are required; "
                                f"available {capacity['effective_cpu_count']} CPUs and {capacity['memory_mib']} MiB. "
                                "Add resources, or install only the website (--role web)",
                                f"无可用评测容量：至少需要 2 个有效 CPU 和 {SLOT_MEMORY_MIB} MiB 内存，当前为 "
                                f"{capacity['effective_cpu_count']} 个 CPU 和 {capacity['memory_mib']} MiB；"
                                "请增加资源或仅安装网站（--role web）"))
    if type(slots) is not int or slots < 1:
        raise CapacityError(say('Judge slots must be a positive integer', '评测槽数必须为正整数'))
    if slots > capacity['cpu_slots']:
        raise CapacityError(say(f"Requested {slots} slots exceed the CPU capacity of {capacity['cpu_slots']} "
                                f"({capacity['effective_cpu_count']} effective CPUs minus 1)",
                                f"请求的 {slots} 槽超过 CPU 容量 {capacity['cpu_slots']}（有效 CPU 核心数减 1）"))
    if slots > MAX_SLOTS:
        raise CapacityError(f'Judge slots exceed libuv capacity {MAX_SLOTS}')
    if slots > capacity['memory_slots']:
        raise CapacityError(say(f"Requested {slots} slots need at least {slots*SLOT_MEMORY_MIB} MiB; effective RAM of "
                                f"{capacity['memory_mib']} MiB permits at most {capacity['memory_slots']} slots",
                                f"请求的 {slots} 槽至少需要 {slots*SLOT_MEMORY_MIB} MiB 内存；有效内存 "
                                f"{capacity['memory_mib']} MiB 最多支持 {capacity['memory_slots']} 槽"))
    return slots


def select_cpu_ids(slots, capacity):
    validate_slots(slots, capacity)
    # Leave the first CPUs for other services when the selected count permits it.
    return capacity['cpu_ids'][-slots:]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--remote', action='store_true')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--slots', type=int, help='Validate an explicit slot count')
    args = parser.parse_args()
    try:
        capacity = discover_capacity(args.remote)
        if args.slots is not None:
            validate_slots(args.slots, capacity)
            capacity['selected_slots'] = args.slots
            capacity['selected_cpu_ids'] = select_cpu_ids(args.slots, capacity)
        print(json.dumps(capacity, ensure_ascii=False) if args.json else
              f"Effective CPUs: {capacity['effective_cpu_count']}; default slots: {capacity['default_slots']}; "
              f"RAM: {capacity['memory_mib']} MiB; maximum slots: {capacity['maximum_slots']}")
    except (CapacityError, OSError, ValueError) as error:
        parser.exit(2, str(error)+'\n')


if __name__ == '__main__':
    main()
