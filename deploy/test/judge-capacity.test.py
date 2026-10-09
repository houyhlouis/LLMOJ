#!/usr/bin/env python3
"""Capacity policy tests: pure temporary proc/cgroup fixtures, no host mutation."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from judge_capacity import discover_capacity, validate_slots, select_cpu_ids, CapacityError


class Capacity(unittest.TestCase):
    def discover(self, count=32, memory=65536, remote=False, quota=None, cpuset=None, parent_memory=None):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);proc=root/'proc';cg=root/'cgroup';group=cg/'test.scope'
            (proc/'self').mkdir(parents=True);group.mkdir(parents=True)
            (proc/'meminfo').write_text(f'MemTotal: {memory*1024} kB\n')
            (proc/'self/cgroup').write_text('0::/test.scope\n')
            (cg/'cgroup.controllers').write_text('cpu cpuset memory')
            if quota:(cg/'cpu.max').write_text(quota)
            if cpuset:(group/'cpuset.cpus.effective').write_text(cpuset)
            if parent_memory:(cg/'memory.max').write_text(str(parent_memory*1024*1024))
            return discover_capacity(remote, proc_root=proc,cgroup_root=cg,affinity=set(range(count)))

    def test_large_hosts_use_cpu_minus_two_without_seven_cap(self):
        for cpus,slots in [(16,14),(32,30),(34,32),(64,62)]:
            c=self.discover(cpus)
            self.assertEqual(c['default_slots'],slots)
            self.assertEqual(validate_slots(slots,c),slots)
            self.assertEqual(select_cpu_ids(slots,c),list(range(2,cpus)))

    def test_remote_uses_same_cpu_default_and_different_memory_reserve(self):
        c=self.discover(remote=True)
        self.assertEqual(c['default_slots'],30)
        self.assertEqual(c['reserve_memory_mib'],1024)

    def test_one_and_two_cpus_have_one_slot(self):
        for cpus in [1,2]:self.assertEqual(self.discover(cpus)['default_slots'],1)

    def test_ram_does_not_silently_reduce_cpu_default(self):
        c=self.discover(32,memory=8192)
        self.assertEqual(c['default_slots'],30)
        self.assertEqual(c['maximum_slots'],12)
        self.assertFalse(c['default_fits'])
        with self.assertRaises(CapacityError):validate_slots(30,c)
        self.assertEqual(validate_slots(12,c),12)

    def test_ancestor_cpu_quota_and_cpuset_apply(self):
        c=self.discover(32,quota='280000 100000',cpuset='2-4,9')
        self.assertEqual(c['cpu_ids'],[2,3,4,9])
        self.assertEqual(c['effective_cpu_count'],2)
        self.assertEqual(c['default_slots'],1)
        with self.assertRaises(CapacityError):validate_slots(3,c)

    def test_effective_memory_uses_cgroup_limit(self):
        c=self.discover(32,parent_memory=4096)
        self.assertEqual(c['memory_mib'],4096)
        self.assertEqual(c['memory_slots'],4)

    def test_fractional_quota_still_allows_one_slot(self):
        c=self.discover(32,quota='50000 100000')
        self.assertEqual(c['effective_cpu_count'],1)

    def test_runtime_threadpool_ceiling_and_invalid_values(self):
        c=self.discover(600,memory=1024*1024)
        self.assertEqual(c['default_slots'],598)
        self.assertEqual(c['maximum_slots'],511)
        for value in [0,-1,True,1.2,512]:
            with self.assertRaises(CapacityError):validate_slots(value,c)


if __name__=='__main__':unittest.main()
