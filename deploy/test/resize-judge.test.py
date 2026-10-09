#!/usr/bin/env python3
"""Root-owned temporary fixture integration; all service/mount actions are simulated."""
import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import runpy
import signal
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import yaml

DEPLOY=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(DEPLOY))
from judge_units import render_units,mount_name
from judge_capacity import CapacityError
spec=importlib.util.spec_from_file_location('resize_judge',DEPLOY/'resize-judge.py')
resize=importlib.util.module_from_spec(spec);spec.loader.exec_module(resize)


def capacity(cpus=32,ram=65536):
    return {'cpu_ids':list(range(cpus)),'logical_cpu_count':cpus,'cpu_quota':None,
            'effective_cpu_count':cpus,'memory_mib':ram,'reserve_memory_mib':2048,
            'slot_memory_mib':512,'memory_slots':max(0,(ram-2048)//512),
            'default_slots':max(1,cpus-2),'maximum_slots':min(cpus,max(0,(ram-2048)//512),511),
            'default_fits':max(1,cpus-2)<=min(cpus,max(0,(ram-2048)//512),511),
            'runtime_max_slots':511,'warnings':[]}


class FakeHost:
    def __init__(self,root,units,remote=False):
        self.root=root;self.units=units;self.remote=remote;self.events=[];self.overrides={};self.fail=None
        self.states={resize.SERVICE:True};self.enable={}
    def active(self,unit):return self.states.get(unit,False)
    def enabled(self,unit):return self.enable.get(unit,'not-found')
    def property(self,unit,name):
        if (unit,name) in self.overrides:return self.overrides[(unit,name)]
        if name=='DropInPaths':return ''
        if name=='PartOf':return 'libreoj-judge.target' if self.remote else 'libreoj.target'
        if name=='FragmentPath':return str(self.units/resize.SERVICE)
        if name=='WorkingDirectory':return str(self.root/'apps/judge')
        if name in ('MemoryMax','CPUQuotaPerSecUSec'):return 'infinity'
        if name=='ControlGroup':return ''
        content=(self.units/resize.SERVICE).read_text()
        if name=='Environment':return ' '.join(x.split('=',1)[1] for x in content.splitlines() if x.startswith('Environment='))
        if name in ('AllowedCPUs','EffectiveCPUs'):
            return next(x.split('=',1)[1] for x in content.splitlines() if x.startswith('AllowedCPUs='))
        raise AssertionError(name)
    def run(self,args,check=True):
        args=list(map(str,args));self.events.append(args)
        if self.fail and self.fail(args):self.fail=None;raise resize.MaintenanceError('injected failure')
        if args[0]=='systemctl':
            command=args[1];unit=args[-1]
            if command=='stop':self.states[unit]=False
            elif command=='start':self.states[unit]=True
            elif command=='enable':
                self.enable[unit]='enabled-runtime' if '--runtime' in args else 'enabled'
                if '--now' in args:self.states[unit]=True
            elif command=='disable':
                self.enable[unit]='disabled'
                if '--now' in args:self.states[unit]=False
            elif command!='daemon-reload':raise AssertionError(args)
            return types.SimpleNamespace(returncode=0,stdout='')
        if args[0]=='systemd-analyze':
            assert all(Path(p).is_file() for p in args[2:])
            return types.SimpleNamespace(returncode=0,stdout='')
        if args[0]=='systemd-run':return types.SimpleNamespace(returncode=0,stdout='sandbox verified (mock)')
        if args[0]=='findmnt':
            assert self.active(mount_name(args[-1]))
            return types.SimpleNamespace(returncode=0,stdout='tmpfs\n')
        raise AssertionError('Real service command blocked: '+str(args))


@unittest.skipUnless(os.geteuid()==0,'private ownership fixtures require sudo')
class ResizeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='libreoj-resize-test-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'LibreOJ';self.units=Path(self.temp.name)/'systemd'
        for p in [self.root/'config',self.root/'deploy/systemd',self.root/'data/judge/work',self.root/'apps/judge',self.units]:p.mkdir(parents=True,exist_ok=True)
        self.secret=base64.b64encode(b'X'*30).decode()
        self.prepare(3)
        self.output=io.StringIO();self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(self.output));self.stack.enter_context(contextlib.redirect_stderr(self.output))
        self.stack.enter_context(patch.object(resize.time,'sleep',lambda _:None))

    def prepare(self,old,remote=False):
        cfg=yaml.safe_load((DEPLOY.parent/'apps/judge/config-example.yaml').read_text())
        cfg.update(key=self.secret,serverUrl='https://remote.example.invalid' if remote else 'http://127.0.0.1:2002',
                   maxConcurrentTasks=old,taskWorkingDirectories=[str(self.root/'data/judge/work'/str(i)) for i in range(1,old+1)],
                   aiRunnerSocket=None if remote else str(self.root/'data/judge/ai-runner.sock'),
                   aiGeneratedDirectory=None if remote else str(self.root/'data/ai-generated'),aiRunnerGid=0 if remote else 1234)
        cfg['cpuAffinity']={kind:list(range(1,old+1)) for kind in ('compiler','userProgram','interactor','checker')}
        self.original=yaml.safe_dump(cfg,sort_keys=False).encode();(self.root/'config/judge.yaml').write_bytes(self.original);(self.root/'config/judge.yaml').chmod(0o600)
        for folder in [self.units,self.root/'deploy/systemd']:
            for p in folder.iterdir():p.unlink()
            for name,text in render_units(self.root,self.root/'runtime/node/bin/node',cfg,remote).items():(folder/name).write_text(text)
        self.host=FakeHost(self.root,self.units,remote)
        for i,path in enumerate(cfg['taskWorkingDirectories']):
            Path(path).mkdir(exist_ok=True);name=mount_name(path);self.host.states[name]=True;self.host.enable[name]='enabled' if i%2 else 'disabled'
        self.initial_units={p.name:p.read_bytes() for p in self.units.iterdir()}
        self.initial_generated={p.name:p.read_bytes() for p in (self.root/'deploy/systemd').iterdir()}
        self.initial_enable=copy.deepcopy(self.host.enable)
        self.initial_active=copy.deepcopy(self.host.states)
        return cfg

    def manager(self,cpus=32,ram=65536):return resize.Resize(self.root,self.host,self.units,capacity(cpus,ram))
    def assert_restored(self):
        self.assertEqual((self.root/'config/judge.yaml').read_bytes(),self.original)
        self.assertEqual({p.name:p.read_bytes() for p in self.units.iterdir()},self.initial_units)
        self.assertEqual({p.name:p.read_bytes() for p in (self.root/'deploy/systemd').iterdir()},self.initial_generated)
        for k,v in self.initial_active.items():self.assertEqual(self.host.states[k],v)
        for k,v in self.initial_enable.items():self.assertEqual(self.host.enable[k],v)
        self.assertNotIn(self.secret,self.output.getvalue())

    def test_plan_no_writes_and_default_32_cpu_30_slots(self):
        m=self.manager();p=m.plan();self.assertEqual(p['new']['maxConcurrentTasks'],30)
        self.assertFalse((self.root/'backups').exists());self.assertFalse(self.host.events);self.assert_restored()

    def test_32_and_64_cpu_apply_and_precise_rollback(self):
        for cpus,slots in [(32,30),(64,62),(34,32)]:
            with self.subTest(cpus=cpus):
                m=self.manager(cpus);plan=m.plan();backup=m.apply(plan)
                c=yaml.safe_load((self.root/'config/judge.yaml').read_text())
                self.assertEqual(c['maxConcurrentTasks'],slots);self.assertEqual(c['cpuAffinity']['userProgram'],list(range(2,cpus)))
                for name in ('key','serverUrl','sandbox','aiRunnerSocket','aiGeneratedDirectory','aiRunnerGid'):
                    self.assertEqual(c[name],plan['old'][name])
                self.assertEqual(backup.stat().st_mode&0o777,0o700)
                self.assertEqual((backup/'judge.yaml').stat().st_mode&0o777,0o600)
                m.restore(backup);self.assert_restored()

    def test_shrink_disables_removed_mounts_and_rollback(self):
        self.prepare(12);m=self.manager();backup=m.apply(m.plan(2))
        for i in range(3,13):
            name=mount_name(self.root/'data/judge/work'/str(i))
            self.assertFalse(self.host.active(name));self.assertFalse((self.units/name).exists())
        m.restore(backup);self.assert_restored()

    def test_remote_keeps_key_origin_ai_and_target(self):
        self.prepare(3,True);m=self.manager();backup=m.apply(m.plan(30))
        cfg=yaml.safe_load((self.root/'config/judge.yaml').read_text())
        self.assertEqual(cfg['serverUrl'],'https://remote.example.invalid');self.assertIsNone(cfg['aiRunnerSocket'])
        self.assertIn('libreoj-judge.target',(self.units/resize.SERVICE).read_text())
        m.restore(backup);self.assert_restored()

    def test_low_memory_and_cpu_rejected_before_snapshot(self):
        for m,slots in [(self.manager(ram=8192),30),(self.manager(cpus=4),30)]:
            with self.assertRaises(CapacityError):m.plan(slots)
        self.assertFalse((self.root/'backups').exists());self.assertFalse(self.host.events);self.assert_restored()

    def test_dropin_and_main_unit_resource_limits_are_not_deleted(self):
        for name,value in [('DropInPaths','/etc/systemd/system/libreoj-judge.service.d/custom.conf'),('MemoryMax','1073741824'),('CPUQuotaPerSecUSec','2s')]:
            self.host.overrides[(resize.SERVICE,name)]=value
            with self.assertRaises(resize.MaintenanceError):self.manager().plan(8)
            del self.host.overrides[(resize.SERVICE,name)]
        self.assertFalse(self.host.events);self.assert_restored()

    def test_other_prefix_same_unit_is_rejected(self):
        for name,value in [('FragmentPath','/elsewhere/libreoj-judge.service'),('WorkingDirectory','/other/apps/judge'),('Environment','LIBREOJ_JUDGE_CONFIG_FILE=/other/config/judge.yaml')]:
            self.host.overrides[(resize.SERVICE,name)]=value
            with self.assertRaises(resize.MaintenanceError):self.manager().plan(8)
            del self.host.overrides[(resize.SERVICE,name)]
        self.assert_restored()

    def test_sandbox_failure_after_live_changes_rolls_back(self):
        self.host.fail=lambda a:a[0]=='systemd-run';m=self.manager()
        with self.assertRaises(resize.MaintenanceError):m.apply(m.plan(30))
        self.assert_restored()
        self.assertEqual(json.loads((m.backup/'manifest.json').read_text())['phase'],'rolled_back')

    def test_preflight_verify_failure_never_stops_judge(self):
        self.host.fail=lambda a:a[0]=='systemd-analyze';m=self.manager()
        with self.assertRaises(resize.MaintenanceError):m.apply(m.plan(30))
        self.assertNotIn(['systemctl','stop',resize.SERVICE],self.host.events);self.assert_restored()

    def test_start_failure_rolls_back(self):
        self.host.fail=lambda a:a[:3]==['systemctl','start',resize.SERVICE];m=self.manager()
        with self.assertRaises(resize.MaintenanceError):m.apply(m.plan(30))
        self.assert_restored()

    def test_signal_interruption_rolls_back(self):
        original=self.host.run;once=[True]
        def interrupted(args,check=True):
            if args[0]=='systemd-run' and once.pop():signal.raise_signal(signal.SIGTERM)
            return original(args,check)
        self.host.run=interrupted;m=self.manager()
        previous=signal.signal(signal.SIGTERM,resize.handle_termination)
        try:
            with self.assertRaises(KeyboardInterrupt):m.apply(m.plan(30))
        finally:signal.signal(signal.SIGTERM,previous)
        self.assert_restored()

    def test_insufficient_effective_cpus_after_start_rolls_back(self):
        self.host.overrides[(resize.SERVICE,'EffectiveCPUs')]='0-3';m=self.manager()
        with self.assertRaises(resize.MaintenanceError):m.apply(m.plan(30))
        self.assert_restored()

    def test_originally_stopped_judge_remains_stopped(self):
        self.host.states[resize.SERVICE]=False;m=self.manager();backup=m.apply(m.plan(8))
        self.assertFalse(self.host.active(resize.SERVICE));m.restore(backup);self.assertFalse(self.host.active(resize.SERVICE))

    def test_symlink_workspace_rejected(self):
        path=self.root/'data/judge/work/4';path.symlink_to(self.root/'config')
        with self.assertRaises((resize.MaintenanceError, ValueError)):self.manager().plan(8)
        self.assertFalse(self.host.events);self.assert_restored()

    def test_corrupt_manifest_name_rejected_before_service_action(self):
        m=self.manager();backup=m.apply(m.plan(8));file=backup/'manifest.json';data=json.loads(file.read_text());data['new_mounts'][0]='../../unrelated.service';file.write_text(json.dumps(data))
        before=len(self.host.events)
        with self.assertRaises(resize.MaintenanceError):m.restore(backup)
        self.assertEqual(len(self.host.events),before)

    def test_flock_excludes_concurrent_installer(self):
        directory=Path(self.temp.name)/'lock'
        with resize.maintenance_lock(directory):
            with self.assertRaises(resize.MaintenanceError):
                with resize.maintenance_lock(directory):self.fail('lock was not exclusive')

    def test_interactive_has_only_one_numeric_prompt(self):
        m=self.manager();lock=Path(self.temp.name)/'lock';real_lock=resize.maintenance_lock
        with patch.object(resize,'Resize',lambda *args,**kwargs:m),patch.object(resize,'maintenance_lock',lambda:real_lock(lock)),patch.object(sys,'argv',['resize-judge.py','--prefix',str(self.root)]),patch.object(sys.stdin,'isatty',return_value=True),patch('builtins.input',return_value='30') as prompt:
            resize.main()
        self.assertEqual(prompt.call_count,1);self.assertEqual(yaml.safe_load((self.root/'config/judge.yaml').read_text())['maxConcurrentTasks'],30)


@unittest.skipUnless(os.geteuid()==0,'private ownership fixtures require sudo')
class GeneratorTests(unittest.TestCase):
    def test_new_default_and_existing_large_capacity_generate_without_overwrite(self):
        with tempfile.TemporaryDirectory(prefix='libreoj-configure-test-') as directory:
            root=Path(directory);(root/'config').mkdir();(root/'apps/judge').mkdir(parents=True);(root/'runtime/sandbox-rootfs/etc').mkdir(parents=True)
            (root/'apps/judge/config-example.yaml').write_bytes((DEPLOY.parent/'apps/judge/config-example.yaml').read_bytes())
            (root/'runtime/sandbox-rootfs/etc/libreoj-rootfs-id').write_text('a'*64)
            (root/'config/secrets.json').write_text(json.dumps({'judge':base64.b64encode(b'Y'*30).decode()}))
            env={'HYHOJ_ROOT':str(root),'NODE_BINARY':'/usr/bin/node'}
            def generate(cap):
                with patch.dict(os.environ,env,clear=True),patch('judge_capacity.discover_capacity',return_value=cap),patch('grp.getgrnam',return_value=types.SimpleNamespace(gr_gid=1234)),contextlib.redirect_stdout(io.StringIO()):
                    runpy.run_path(str(DEPLOY/'configure-judge.py'),run_name='__main__')
            generate(capacity(32));config=root/'config/judge.yaml';before=config.read_bytes();c=yaml.safe_load(before)
            self.assertEqual(c['maxConcurrentTasks'],30)
            self.assertEqual(len(list((root/'deploy/systemd').glob('*.mount'))),30)
            self.assertIn('UV_THREADPOOL_SIZE=62',(root/'deploy/systemd/libreoj-judge.service').read_text())
            generate(capacity(64));self.assertEqual(config.read_bytes(),before)
            with self.assertRaises(SystemExit):generate(capacity(32,8192))
            self.assertEqual(config.read_bytes(),before)


if __name__=='__main__':unittest.main()
