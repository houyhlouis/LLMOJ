#!/usr/bin/env python3
"""Read-only, stdlib-only judge capacity policy shared by installer and resize."""
import argparse
import json
import math
import os
from pathlib import Path

MAX_SLOTS = 511  # UV_THREADPOOL_SIZE >= slots * 2 + 2, and <= 1024.
SLOT_MEMORY_MIB = 512


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
    """Return a non-sensitive dict. Default is CPU-2; RAM never silently lowers it.

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
    reserve = 1024 if remote else 2048
    memory_mib = memory_bytes // (1024 * 1024)
    memory_slots = max(0, (memory_mib - reserve) // SLOT_MEMORY_MIB)
    default = max(1, effective - 2)
    maximum = min(effective, memory_slots, MAX_SLOTS)
    return {'cpu_ids': sorted(cpus), 'logical_cpu_count': len(cpus), 'cpu_quota': quota,
            'effective_cpu_count': effective, 'memory_mib': memory_mib,
            'reserve_memory_mib': reserve, 'slot_memory_mib': SLOT_MEMORY_MIB,
            'memory_slots': memory_slots, 'default_slots': default, 'maximum_slots': maximum,
            'default_fits': default <= maximum, 'runtime_max_slots': MAX_SLOTS,
            'remote': remote, 'warnings': warnings}


def validate_slots(slots, capacity):
    if type(slots) is not int or slots < 1:
        raise CapacityError('Judge slots must be a positive integer / 评测槽数必须为正整数')
    if slots > capacity['effective_cpu_count']:
        raise CapacityError(f"Requested {slots} slots exceed effective CPU capacity {capacity['effective_cpu_count']} / 槽数超过有效 CPU 容量")
    if slots > MAX_SLOTS:
        raise CapacityError(f'Judge slots exceed libuv capacity {MAX_SLOTS}')
    if slots > capacity['memory_slots']:
        raise CapacityError(f"Requested {slots} slots need at least {capacity['reserve_memory_mib'] + slots*SLOT_MEMORY_MIB} MiB; effective RAM {capacity['memory_mib']} MiB permits at most {capacity['memory_slots']} slots / 内存预算不足，请明确选择较少槽数")
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
