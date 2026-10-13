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

    def test_large_hosts_reserve_one_cpu_without_seven_cap(self):
        for cpus,slots in [(16,15),(32,31),(34,33),(64,63)]:
            c=self.discover(cpus)
            self.assertEqual(c['default_slots'],slots)
            self.assertEqual(validate_slots(slots,c),slots)
            self.assertEqual(select_cpu_ids(slots,c),list(range(1,cpus)))
            with self.assertRaises(CapacityError):validate_slots(cpus,c)

    def test_remote_and_local_use_the_same_memory_budget(self):
        for remote in (False,True):
            c=self.discover(remote=remote,memory=512)
            self.assertEqual(c['default_slots'],2)
            self.assertEqual(c['memory_slots'],2)
            self.assertEqual(c['reserve_memory_mib'],0)

    def test_one_cpu_has_no_slots_and_two_cpus_have_one(self):
        c=self.discover(1)
        self.assertEqual(c['default_slots'],0)
        self.assertEqual(c['maximum_slots'],0)
        for slots in (0,1):
            with self.assertRaisesRegex(CapacityError,'at least 2 effective CPUs'):validate_slots(slots,c)
        self.assertEqual(self.discover(2)['default_slots'],1)

    def test_memory_limits_default_and_maximum_without_fixed_reserve(self):
        for memory,slots in [(256,1),(511,1),(512,2),(768,3),(2048,8),(8192,31)]:
            with self.subTest(memory=memory):
                c=self.discover(32,memory=memory)
                self.assertEqual(c['default_slots'],slots)
                self.assertEqual(c['maximum_slots'],slots)
                self.assertTrue(c['default_fits'])
                self.assertEqual(validate_slots(slots,c),slots)
                with self.assertRaises(CapacityError):validate_slots(slots+1,c)
        self.assertEqual(self.discover(2,memory=512)['maximum_slots'],1)
        self.assertEqual(self.discover(3,memory=512)['maximum_slots'],2)

    def test_memory_below_one_slot_does_not_create_fake_capacity(self):
        c=self.discover(32,memory=255)
        self.assertEqual(c['default_slots'],0)
        self.assertEqual(c['maximum_slots'],0)
        for slots in (0,1):
            with self.assertRaisesRegex(CapacityError,'256 MiB RAM'):validate_slots(slots,c)

    def test_ancestor_cpu_quota_and_cpuset_apply(self):
        c=self.discover(32,quota='280000 100000',cpuset='2-4,9')
        self.assertEqual(c['cpu_ids'],[2,3,4,9])
        self.assertEqual(c['effective_cpu_count'],2)
        self.assertEqual(c['default_slots'],1)
        with self.assertRaises(CapacityError):validate_slots(2,c)

    def test_effective_memory_uses_cgroup_limit(self):
        c=self.discover(32,parent_memory=4096)
        self.assertEqual(c['memory_mib'],4096)
        self.assertEqual(c['memory_slots'],16)
        self.assertEqual(c['default_slots'],16)

    def test_fractional_quota_reserves_the_only_effective_cpu(self):
        c=self.discover(32,quota='50000 100000')
        self.assertEqual(c['effective_cpu_count'],1)
        self.assertEqual(c['maximum_slots'],0)
        with self.assertRaises(CapacityError):validate_slots(1,c)

    def test_runtime_threadpool_ceiling_and_invalid_values(self):
        c=self.discover(600,memory=1024*1024)
        self.assertEqual(c['default_slots'],511)
        self.assertEqual(c['maximum_slots'],511)
        for value in [0,-1,True,1.2,512]:
            with self.assertRaises(CapacityError):validate_slots(value,c)


if __name__=='__main__':unittest.main()
