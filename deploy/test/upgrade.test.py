#!/usr/bin/env python3
"""Temporary fixtures only. No real service, configuration or database is changed."""
import contextlib
import errno
import grp
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import pty
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1]/'upgrade.py'
spec = importlib.util.spec_from_file_location('upgrade', MODULE)
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


class FakeHost:
    def __init__(self, root, units, role='all'):
        self.root, self.units = root, units
        self.calls = []
        self.states = {'libreoj-'+n+'.service': True for n in (*u.SERVICES, *(['judge'] if role=='all' else []))}
        self.override = {}
        self.queued = 0
        self.worker_locked = False
        self.pending_accounts = 0
        self.review_table = False
        self.application_table = False
        self.pending_applications = 0
        self.registration_override = None
        self.registration_policy_corrupt = False
        self.ai_policy_limited = False
        self.ai_endpoints_restricted = False
        self.queries = []
        self.fail_start = None
        self.fail_install = False
        self.config_refused = False
        # A command whose text contains this fails, as a failed build step would
        self.fail_command = None
    def prop(self, unit, name):
        if (unit,name) in self.override:
            return self.override[(unit,name)]
        role=unit.removeprefix('libreoj-').removesuffix('.service')
        if name=='FragmentPath': return str(self.units/unit)
        if name=='EnvironmentFiles': return ''
        if name=='DropInPaths':
            guard=self.units/'libreoj-backend.service.d'/u.GUARD_NAME
            return str(guard) if role=='backend' and guard.exists() else ''
        if name=='Environment':
            value = ('LIBREOJ_CONFIG_FILE=' if role=='backend' else 'LIBREOJ_JUDGE_CONFIG_FILE=')+str(self.root/'config'/f'{role}.yaml')
            if role=='backend':
                for key,path in {'HYHOJ_AI_STATE_DIR':'data/ai','HYHOJ_AI_GENERATED_DIR':'data/ai-generated','HYHOJ_AI_SAMPLE_INPUTS_DIR':'data/ai-sample-inputs','HYHOJ_AI_RUNNER_SOCKET':'data/judge/ai-runner.sock','HYHOJ_ARCHIVE_WORK_DIRECTORY':'data/backend-archives','TMPDIR':'data/tmp'}.items():
                    value+=' '+key+'='+str(self.root/path)
            if role=='backend' and (self.units/'libreoj-backend.service.d'/u.GUARD_NAME).exists(): value+=' LIBREOJ_SCHEMA_SYNC=0'
            return value
        if name=='WorkingDirectory': return str(self.root/'apps'/role)
        if name=='ExecStart': return str(self.root/'runtime/node/bin/node')+' '+str(self.root/'config'/f'{role}.conf')+' '+str(self.root/'config/mariadb.cnf')+' '+str(self.root/'data/minio')
        if name=='ActiveState': return 'active' if self.states[unit] else 'inactive'
        raise AssertionError((unit,name))
    def active(self,unit): return self.states.get(unit,False)
    def service(self,action,unit):
        self.calls.append(('service',action,unit))
        if action=='start' and self.fail_start==unit:
            self.fail_start=None
            raise u.UpgradeError('synthetic start failure')
        self.states[unit]=action=='start'
    def run(self,args,**kwargs):
        args=list(map(str,args)); self.calls.append(tuple(args)); output=b''
        if self.fail_command and self.fail_command in ' '.join(args):
            raise u.UpgradeError(f'{Path(args[0]).name} operation failed (exit 1; private output withheld)')
        if args[0]=='mariadb':
            query=kwargs.get('input',b'')
            if isinstance(query,Path):
                assert query.is_file()
                query=b''
            query=query.decode()
            self.queries.append(query)
            if 'SELECT IS_USED_LOCK' in query: output=str(int(self.worker_locked)).encode()
            elif 'DATA_LENGTH+INDEX_LENGTH' in query: output=b'1024'
            elif "TABLE_TYPE <> 'BASE TABLE'" in query: output=b''
            elif 'TABLE_NAME=\'registration_review\'' in query: output=str(int(self.review_table)).encode()
            elif 'TABLE_NAME=\'registration_application\'' in query: output=str(int(self.application_table)).encode()
            elif 'FROM `registration_review`' in query: output=str(self.pending_accounts).encode()
            elif 'FROM `registration_application`' in query: output=str(self.pending_applications).encode()
            elif "FROM `settings`" in query and "'registration-policy'" in query: output=str(int(self.registration_override is not None or self.registration_policy_corrupt)).encode()
            elif "FROM `settings`" in query and "'ai-policy'" in query: output=str(int(self.ai_policy_limited)).encode()
            elif "FROM `settings`" in query and "'ai-endpoints'" in query: output=str(int(self.ai_endpoints_restricted)).encode()
            elif 'FROM `submission`' in query or 'FROM `ai_job`' in query: output=str(self.queued).encode()
            elif query.startswith('SELECT COUNT'): output=b'0'
        elif args[0]=='mariadb-dump': kwargs['output'].write(b'-- synthetic logical SQL backup\n'+b'x'*200)
        elif args[0]=='cp':
            source,target=Path(args[-2]),Path(args[-1]); shutil.copytree(source,target,symlinks=True)
        elif len(args) > 1 and args[1] == '-e' and args[2] == u.BACKEND_CONFIGURATION_CHECK:
            assert kwargs['env']['LIBREOJ_CONFIG_FILE'] == str(self.root/'config/backend.yaml')
            return subprocess.CompletedProcess(args, int(self.config_refused), b'', b'')
        elif 'install' in args and '--frozen-lockfile' in args:
            # pnpm installing the target's lockfile into the staged copy: it records where it installed
            if self.fail_install: raise u.UpgradeError('pnpm operation failed (exit 1; private output withheld)')
            stage=Path(kwargs['cwd'])
            (stage/'node_modules/old-dependency').unlink(missing_ok=True)
            (stage/'node_modules/new-dependency').write_text('installed from the new lockfile')
            shim=stage/'apps/backend/node_modules/.bin/tool'; shim.parent.mkdir(parents=True,exist_ok=True)
            shim.write_text('#!/bin/sh\nexport NODE_PATH="'+str(stage)+'/node_modules/.pnpm/node_modules"\nexec node "$basedir/../tool/cli.js"\n'); shim.chmod(0o755)
            (stage/'node_modules/.pnpm-workspace-state-v1.json').write_text(json.dumps({'projects':{str(stage):{},str(stage)+'/apps/backend':{}}}))
            package=stage/'node_modules/.pnpm/tool@2.0.0/node_modules/tool/index.js'; package.parent.mkdir(parents=True,exist_ok=True)
            package.write_text('// built in '+str(stage)+'\n')
        elif args[-1]=='--version': output=b'11.13.1' if 'pnpm' in args[-2] else b'v24.21.0'
        elif args[-2:]==['run','build'] and '@libreoj/backend' in args:
            dist=Path(kwargs['cwd'])/'apps/backend/dist'
            (dist/'database').mkdir(parents=True,exist_ok=True)
            (dist/'main.js').write_text('new backend')
            (dist/'database/database.providers.js').write_text('LIBREOJ_SCHEMA_SYNC')
        elif args[-2:]==['run','build'] and '@libreoj/frontend' in args:
            (Path(kwargs['cwd'])/'public/index.html').write_text('new frontend')
        elif args[-1].endswith('deploy/build-frontend-offline.mjs'):
            public=Path(kwargs['cwd'])/'public'
            (public/'offline-manifest.json').write_text(json.dumps({'files':[{'path':'/index.html','sha256':u.digest(public/'index.html')}]}))
        return subprocess.CompletedProcess(args,0,output,b'')


class FixtureUpgrade(u.Upgrade):
    def build(self):
        if self.dependency_changes:
            with open(os.devnull,'wb') as log: self.install_dependencies({},log)
            self.relocate_dependencies()
        (self.stage/'apps/backend/dist/database').mkdir(parents=True,exist_ok=True)
        (self.stage/'apps/backend/dist/main.js').write_text('new backend')
        (self.stage/'apps/backend/dist/database/database.providers.js').write_text('LIBREOJ_SCHEMA_SYNC')
        (self.stage/'public/index.html').write_text('new frontend')
        (self.stage/'public/new-hash.js').write_text('new chunk')
    def health(self): self.host.calls.append(('health',))
    def schema(self,database,action='audit'):
        if not hasattr(self,'schemas'): self.schemas={}
        queries=[] if self.schemas.get(database) else ['add registration_review']
        if action=='apply': self.schemas[database]=True; self.host.review_table=True
        return {'compatible':True,'queries':queries}


class BuildingUpgrade(u.Upgrade):
    """Builds with the upgrader's own build steps; the fake host makes what each command would."""
    health = FixtureUpgrade.health
    schema = FixtureUpgrade.schema


@unittest.skipUnless(os.geteuid()==0, 'Run with sudo; ownership checks use root-owned temporary fixtures')
class UpgradeTests(unittest.TestCase):
    def setUp(self):
        # This is a tiny synthetic fixture, not a deployment disk-budget check.
        # Keep the suite independent of the host's available storage; the low-disk
        # case below explicitly overrides this and exercises the real guard.
        disk = patch.object(u.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(32*u.GIB, 8*u.GIB, 24*u.GIB))
        disk.start()
        self.addCleanup(disk.stop)
        self.tmp=tempfile.TemporaryDirectory(prefix='upgrade-test-')
        self.base=Path(self.tmp.name); self.root=self.base/'instance'; self.source=self.base/'source'; self.units=self.base/'units'
        for path in (self.root,self.source,self.units): path.mkdir()
        for name in ('config','runtime/node/bin','runtime/tooling/node_modules/.bin','data/ai','data/mariadb','data/minio','apps/backend/src/database','apps/judge/src','packages/frontend/src','packages/shared/src','deploy/systemd','public','node_modules','infra'):
            (self.root/name).mkdir(parents=True,exist_ok=True)
        state={'version':3,'root':str(self.root),'role':'all','sourceRepository':u.REPOSITORY}
        for name in ('install-state.json','install-complete.json','secrets.json'):
            (self.root/'config'/name).write_text(json.dumps(state)); (self.root/'config'/name).chmod(0o600)
        backend=self.root/'config/backend.yaml'
        backend.write_text('server:\n  hostname: 127.0.0.1\n  port: 2002\n  clusters: null\nservices:\n  database:\n    type: mariadb\n    host: 127.0.0.1\n    port: 13306\n    database: libreoj\n    username: libreoj\n')
        backend.chmod(0o640); os.chown(backend,0,grp.getgrnam('libreoj').gr_gid)
        (self.root/'config/judge.yaml').write_text('preserve key and slots'); (self.root/'config/judge.yaml').chmod(0o600)
        for name in ('runtime/node/bin/node','runtime/tooling/node_modules/.bin/pnpm'): (self.root/name).write_text('runtime')
        (self.root/'data/ai/master.key').write_text('synthetic key'); (self.root/'data/ai/master.key').chmod(0o600)
        (self.root/'public/index.html').write_text('old frontend'); (self.root/'public/old-hash.js').write_text('old chunk')
        (self.root/'apps/backend/src/auth').mkdir()
        (self.root/'apps/backend/src/auth/auth.service.ts').write_text('old code')
        (self.root/'apps/backend/dist').mkdir(); (self.root/'apps/backend/dist/main.js').write_text('old backend')
        (self.root/'apps/judge/src/index.ts').write_text('unchanged judge')
        (self.root/'packages/frontend/src/index.ts').write_text('old ui')
        (self.root/'packages/shared/src/index.ts').write_text('shared')
        (self.root/'packages/bootstrap-config').mkdir(); (self.root/'packages/bootstrap-config/config.json').write_text('generated')
        for name in ('package.json','pnpm-lock.yaml','pnpm-workspace.yaml'): (self.root/name).write_text('{}')
        (self.root/'node_modules/old-dependency').write_text('installed from the old lockfile')
        for name in (*u.SERVICES,'judge'):
            (self.units/('libreoj-'+name+'.service')).write_text('[Service]\n# '+str(self.root)+'/\n')
        # A source archive contains no build outputs or generated bootstrap config.
        for relative,path in u.source_files(self.root):
            target=self.source/relative; target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(path,target)
        (self.source/'deploy').mkdir(exist_ok=True)
        (self.source/'apps/backend/src/database').mkdir(parents=True,exist_ok=True)
        (self.source/'deploy/install.sh').write_text('NODE_VERSION=24.21.0\n')
        (self.source/'deploy/upgrade-schema.mjs').write_text('schema helper')
        (self.source/'deploy/upgrade-registration.mjs').write_text('data migration helper')
        (self.source/'deploy/build-frontend-offline.mjs').write_text('builder')
        (self.source/'apps/backend/src/database/database.providers.ts').write_text('LIBREOJ_SCHEMA_SYNC')
        (self.source/'apps/backend/src/auth/registration-review.entity.ts').write_text('new entity')
        (self.source/'apps/backend/src/auth/registration-application.entity.ts').write_text('new application entity')
        (self.source/'apps/backend/src/auth/auth.service.ts').write_text('new code')
        (self.source/'packages/frontend/src/index.ts').write_text('new ui')
        self.host=FakeHost(self.root,self.units)
        self.up=FixtureUpgrade(self.root,self.host,self.units)
    def tearDown(self): self.tmp.cleanup()
    def prepare(self):
        self.up.preflight()
        self.up.prepare(self.source,{'treeSha256':u.tree_digest(self.source),'kind':'fixture'})
    def run_main(self,*args,stream=None):
        """The upgrader's command line on the fixture: what it printed, and the error it ended with."""
        output=stream or io.StringIO()
        lock=u.maintenance_lock
        hangup=u.signal.getsignal(u.signal.SIGHUP)
        self.addCleanup(u.signal.signal,u.signal.SIGHUP,hangup)
        upgrade=lambda root,progress=None: BuildingUpgrade(root,self.host,self.units,progress=progress)
        with patch.object(u,'Upgrade',upgrade),patch.object(u,'maintenance_lock',lambda: lock(self.base/'lock')),\
             patch.object(u,'maintenance_running',return_value=False),contextlib.redirect_stdout(output):
            try:
                u.main(['--prefix',str(self.root),'--source',str(self.source),'--source-sha256',u.tree_digest(self.source),*args])
            except u.UpgradeError as error:
                return output.getvalue(),error
        return output.getvalue(),None
    def backup_directory(self):
        return next((self.root/'backups/upgrade').iterdir())
    def test_an_upgrade_shows_each_step_while_it_runs_and_records_it(self):
        text,error=self.run_main('--apply','--drained')
        self.assertIsNone(error,text)
        lines=text.splitlines()
        self.assertRegex(lines[0],r'^Upgrading .* to [0-9a-f]{12}\. The website keeps running until step 9 of 17\.$')
        self.assertRegex(lines[1],r'from another terminal: sudo bash \S+upgrade\.sh --prefix \S+ --status$')
        # Every step in order: started, then done or not needed
        ends=[line for line in lines if re.match(r'\[\s*\d+/17\] .*: (done \(\d+ s\)|not needed)$',line)]
        self.assertEqual([int(re.match(r'\[\s*(\d+)/',line)[1]) for line in ends],list(range(1,18)))
        self.assertEqual([line.split('] ')[1] for line in ends if line.endswith('not needed')],
                         ['Installing the changed dependencies: not needed',
                          "Rebuilding the sandbox and the judge's native programs: not needed",
                          'Testing the new judge and sandbox on this server: not needed'])
        self.assertIn('[ 6/17] Building the backend …',lines)
        stop=lines.index(next(line for line in lines if line.startswith('[ 9/17] Stopping the website, the backend and the judge: done')))
        self.assertEqual(lines[stop+1],'The website is offline from now on.')
        self.assertRegex(lines[stop+2],r'^\[10/17\]')
        site=lines.index(next(line for line in lines if line.startswith('[17/17] Starting the website: done')))
        self.assertRegex(lines[site+1],r'^The website is back online \(it was offline for \d+ s\)\.$')
        self.assertRegex(text,r'Upgrade complete in \d+ s; the website was offline for \d+ s\.\nConfiguration and data kept\. Private backup: ')
        backup=self.backup_directory()
        record=json.loads((backup/'progress.json').read_text())
        self.assertEqual(record['state'],'complete')
        self.assertEqual([step['key'] for step in record['steps']],list(u.STEP_KEYS))
        self.assertEqual(record['target']['treeSha256'],u.tree_digest(self.source))
        self.assertTrue(record['offlineAt'] and record['onlineAt'])
        self.assertEqual(stat.S_IMODE((backup/'progress.json').stat().st_mode),0o600)
        log=(backup/'progress.log').read_text()
        # Lines from before the backup directory existed are kept too
        self.assertRegex(log,r'^\d{4}-\d\d-\d\dT[\d:]+Z Upgrading ')
        self.assertIn('[ 1/17] Checking the installation and the new version: done',log)
        self.assertIn('Upgrade complete in',log)
        report='\n'.join(u.status_report(self.root,running=False))
        self.assertRegex(report,r'State: complete in \d+ s; the website was offline for \d+ s\.')
        self.assertRegex(report,r'\n   6  done\s+\d+ s  Building the backend\n')
        self.assertRegex(report,r'\n   3  not needed\s+Installing the changed dependencies\n')
    def test_a_failed_build_step_says_which_step_and_that_nothing_changed(self):
        self.host.fail_command='@libreoj/backend'
        text,error=self.run_main('--apply','--drained')
        self.assertRegex(str(error),r'node operation failed .*private preparation evidence: ')
        self.assertRegex(text,r'\n\[ 6/17\] Building the backend: failed after \d+ s\n')
        self.assertNotIn('[ 7/17]',text)
        self.assertIn('Nothing was changed; the website runs as before.',text)
        self.assertRegex(text,r'What happened: \S+/progress\.log; the output of the build and its tests: \S+/build\.log')
        self.assertTrue(all(self.host.states.values()))
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'old backend')
        record=json.loads((self.backup_directory()/'progress.json').read_text())
        self.assertEqual((record['state'],record['message']),('failed','node operation failed (exit 1; private output withheld)'))
        report='\n'.join(u.status_report(self.root,running=False))
        self.assertIn('State: failed at step 6 (Building the backend): node operation failed (exit 1; private output withheld). '
                      'Nothing was changed; the website kept running.',report)
        self.assertRegex(report,r'\n   6  failed\s+\d+ s  Building the backend\n   7  \s+  Building the website\n')
        self.assertIn('Output of the build and its tests: ',report)
    def test_a_failure_after_switching_shows_the_rollback(self):
        self.host.fail_start='libreoj-backend.service'
        text,error=self.run_main('--apply','--drained')
        self.assertEqual(str(error),'synthetic start failure')
        for line in ('[15/17] Starting the backend and waiting until it is ready: failed after',
                     'The upgrade failed: synthetic start failure','Putting the previous version back:',
                     '  ↺ Stopping the website, the backend and the judge: done','  ↺ Putting the previous version back: done',
                     '  ↺ Starting the backend and waiting until it is ready: done','  ↺ Starting the judge and waiting until it connects: done',
                     '  ↺ Starting the website: done','The website is back online (it was offline for',
                     'The previous version runs again.'):
            self.assertIn('\n'+line,text)
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'old backend')
        self.assertTrue(all(self.host.states.values()))
        record=json.loads((self.backup_directory()/'progress.json').read_text())
        self.assertEqual(record['state'],'rolled-back')
        report='\n'.join(u.status_report(self.root,running=False))
        self.assertIn('State: failed at step 15 (Starting the backend and waiting until it is ready): synthetic start failure. '
                      'The previous version was put back and runs again.',report)
        self.assertRegex(report,r'\n   ↺  done\s+\d+ s  Putting the previous version back\n')
    def test_the_upgrade_goes_on_when_its_terminal_goes_away(self):
        class HungUp(io.StringIO):
            writes=0
            def write(self,text):
                HungUp.writes+=1
                if HungUp.writes>4: raise OSError(errno.EIO,'Input/output error')
                return super().write(text)
        text,error=self.run_main('--apply','--drained',stream=HungUp())
        self.assertIsNone(error)
        self.assertNotIn('[ 2/17]',text)
        # After the confirmation, a hangup (a dropped SSH connection) doesn't stop it
        self.assertEqual(u.signal.getsignal(u.signal.SIGHUP),u.signal.SIG_IGN)
        record=json.loads((self.backup_directory()/'progress.json').read_text())
        self.assertEqual(record['state'],'complete')
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'new backend')
        self.assertIn('Upgrade complete in',(self.backup_directory()/'progress.log').read_text())
    def test_status_tells_a_running_upgrade_from_one_that_stopped(self):
        directory=self.root/'backups/upgrade/20261024T100000Z-00000001'; directory.mkdir(parents=True)
        (directory/'manifest.json').write_text(json.dumps({'status':'building'}))
        dead=subprocess.Popen(['true']); dead.wait()
        record={'version':1,'pid':dead.pid,'state':'running','startedAt':'2026-10-24T10:00:00Z','target':{'commit':'ab'*20},
                'steps':[{'key':'check','state':'done','seconds':2},{'key':'copy','state':'running','startedAt':'2026-10-24T10:00:02Z'}]}
        (directory/'progress.json').write_text(json.dumps(record))
        now=u.datetime.datetime(2026,10,24,10,1,32,tzinfo=u.datetime.timezone.utc)
        report='\n'.join(u.status_report(self.root,running=False,now=now))
        self.assertIn('Upgrade 20261024T100000Z-00000001 to abababababab, started 2026-10-24 10:00 UTC',report)
        self.assertIn('State: stopped at step 2 (Copying the installation to a staging area) during preparation, without finishing',report)
        self.assertIn('Nothing was changed; the website kept running. You can run the upgrade again.',report)
        self.assertRegex(report,r'\n   2  stopped\s+Copying the installation to a staging area\n')
        # Running: this process holds the record, and the maintenance lock is held
        record['pid']=os.getpid(); (directory/'progress.json').write_text(json.dumps(record))
        report='\n'.join(u.status_report(self.root,running=True,now=now))
        self.assertIn('State: running, step 2 of 17: Copying the installation to a staging area (1 min 30 s so far)',report)
        self.assertIn('The website is online; it goes offline at step 9.',report)
        self.assertRegex(report,r'\n   2  running\s+1 min 30 s  Copying the installation to a staging area\n')
        # Stopped while the website was offline: roll it back
        record.update(pid=dead.pid,offlineAt='2026-10-24T10:05:00Z')
        record['steps']=[*({'key':key,'state':'done','seconds':1} for key in u.STEP_KEYS[:12]),{'key':'database','state':'running','startedAt':'2026-10-24T10:06:00Z'}]
        (directory/'progress.json').write_text(json.dumps(record))
        (directory/'manifest.json').write_text(json.dumps({'status':'maintenance'}))
        report='\n'.join(u.status_report(self.root,running=False,now=now))
        self.assertIn(f'State: stopped at step 13 (Changing the database) while the website was offline, without finishing '
                      f'(the upgrader was stopped, or the server restarted). Roll it back: sudo bash {self.root}/deploy/upgrade.sh '
                      f'--prefix {self.root} --rollback {directory} --drained',report)
        # Another maintenance holds the lock, but not this upgrade
        self.assertIn('An install, upgrade, judge resize or backup holds the maintenance lock now.','\n'.join(u.status_report(self.root,running=True,now=now)))
    def test_status_without_records(self):
        self.assertEqual(u.status_report(self.root,running=False),
                         ['No upgrade has recorded its progress here yet; upgraders record it from this version on.'])
    def test_upgrade_refuses_to_start_on_top_of_one_that_stopped_halfway(self):
        base=self.root/'backups/upgrade'; base.mkdir(parents=True)
        def record(name,status):
            (base/name).mkdir(exist_ok=True); (base/name/'manifest.json').write_text(json.dumps({'status':status}))
        # A failure followed by a completed upgrade is history
        record('20261020T000000Z-0000000a','rollback-failed'); record('20261021T000000Z-0000000b','complete')
        record('20261021T120000Z-0000000c','building')
        with patch.object(u,'maintenance_running',return_value=False): self.up.preflight()
        record('20261022T000000Z-0000000d','maintenance')
        with patch.object(u,'maintenance_running',return_value=False):
            with self.assertRaisesRegex(u.UpgradeError,r'stopped halfway \(maintenance\).* --rollback \S+0000000d --drained'):
                self.up.preflight()
        # While another process holds the maintenance lock, that may be the same upgrade, still running
        with patch.object(u,'maintenance_running',return_value=True): self.up.preflight()
        self.up.locked=True
        with patch.object(u,'maintenance_running',return_value=True):
            with self.assertRaisesRegex(u.UpgradeError,'stopped halfway'): self.up.preflight()
        record('20261022T000000Z-0000000d','rolled-back')
        self.up.preflight()
    def test_official_0640_config_and_generated_bootstrap_accepted(self):
        self.up.preflight(); self.up.compatibility(self.source)
    def test_preflight_is_read_only(self):
        before=u.snapshot(self.root); self.up.preflight(); self.up.compatibility(self.source)
        self.assertEqual(before,u.snapshot(self.root)); self.assertFalse(any(c[0]=='service' for c in self.host.calls))
    def test_wrong_prefix_effective_unit_rejected(self):
        self.host.override[('libreoj-backend.service','WorkingDirectory')]='/other/apps/backend'
        with self.assertRaises(u.UpgradeError): self.up.preflight()
    def test_custom_ai_master_key_directory_is_rejected(self):
        unit='libreoj-backend.service'
        self.host.override[(unit,'Environment')]=self.host.prop(unit,'Environment').replace(str(self.root/'data/ai')+' ',str(self.base/'custom-ai')+' ')
        with self.assertRaisesRegex(u.UpgradeError,'state location'): self.up.preflight()
    def test_custom_environment_file_is_rejected(self):
        self.host.override[('libreoj-backend.service','EnvironmentFiles')]=str(self.base/'custom.env')
        with self.assertRaisesRegex(u.UpgradeError,'EnvironmentFile'): self.up.preflight()
    def test_wrong_exec_override_rejected(self):
        self.host.override[('libreoj-nginx.service','ExecStart')]='/other/nginx'
        with self.assertRaises(u.UpgradeError): self.up.preflight()
    def test_unsafe_secret_mode_rejected(self):
        (self.root/'config/secrets.json').chmod(0o644)
        with self.assertRaises(u.UpgradeError): self.up.preflight()
    LOCK_BEFORE={'lockfileVersion':'9.0','importers':{'apps/backend':{'dependencies':{'tool':{'specifier':'^1.0.0','version':'1.0.0'},
                  'kept':{'specifier':'1.0.0','version':'1.0.0'}}},'apps/bootstrap-azure':{'devDependencies':{'esbuild':{'specifier':'0.12.24','version':'0.12.24'}}}},
                  'packages':{'tool@1.0.0':{},'kept@1.0.0':{},'esbuild@0.12.24':{}}}
    LOCK_AFTER={'lockfileVersion':'9.0','importers':{'apps/backend':{'dependencies':{'tool':{'specifier':'^2.0.0','version':'2.0.0(peer@1.0.0)'},
                 'kept':{'specifier':'1.0.0','version':'1.0.0'}}},'apps/bootstrap-azure':{'devDependencies':{'esbuild':{'specifier':'0.28.2','version':'0.28.2'}}}},
                 'packages':{'tool@2.0.0':{},'kept@1.0.0':{},'peer@1.0.0':{},'esbuild@0.28.2':{}}}
    def dependency_fixture(self,manager='pnpm@11.13.1'):
        """An installation and a target that differ only in their dependencies"""
        for tree,lock in ((self.root,self.LOCK_BEFORE),(self.source,self.LOCK_AFTER)):
            (tree/'package.json').write_text(json.dumps({'name':'@libreoj/monorepo','packageManager':'pnpm@11.13.1'}))
            (tree/'pnpm-lock.yaml').write_text(json.dumps(lock))
            (tree/'pnpm-workspace.yaml').write_text(json.dumps({'packages':['apps/*'],'allowBuilds':{'bcrypt':True,'core-js':False}}))
        (self.source/'package.json').write_text(json.dumps({'name':'@libreoj/monorepo','packageManager':manager}))
        (self.source/'pnpm-workspace.yaml').write_text(json.dumps({'packages':['apps/*'],'allowBuilds':{'bcrypt':True,'core-js':False,'esbuild':True}}))
    def test_dependency_change_is_planned_with_its_packages_and_build_scripts(self):
        self.dependency_fixture(); self.up.preflight(); self.up.compatibility(self.source)
        self.assertEqual(self.up.dependency_changes,['pnpm-lock.yaml','pnpm-workspace.yaml'])
        # Every native addon and the sandbox are rebuilt and checked with the new dependencies
        self.assertEqual(self.up.native_rebuild,sorted(u.NATIVE_PACKAGES)); self.assertTrue(self.up.sandbox_changed)
        summary=u.dependency_summary(self.root,self.source)
        self.assertEqual((summary['packages'],summary['added'],summary['removed']),(4,3,2))
        # Only the deployed projects' direct dependencies are listed, without peer suffixes
        self.assertEqual(summary['directChanges'],['apps/backend: tool 1.0.0 -> 2.0.0'])
        self.assertEqual((summary['buildScripts'],summary['buildScriptsChanged']),(['bcrypt','esbuild'],True))
    def test_dependency_change_installs_the_lockfile_into_the_stage_and_switches_the_dependencies(self):
        self.dependency_fixture(); self.prepare()
        install=[c for c in self.host.calls if 'install' in c and '--frozen-lockfile' in c]
        self.assertEqual(len(install),1)
        self.assertEqual(install[0][install[0].index('--store-dir')+1],str(self.root/'runtime/pnpm-store'))
        # The live dependencies are untouched until the switch
        self.assertTrue((self.root/'node_modules/old-dependency').exists())
        # pnpm's shims and workspace state name the installation, not the staging directory; packages are left alone
        shim=(self.up.stage/'apps/backend/node_modules/.bin/tool').read_text()
        self.assertIn(str(self.root)+'/node_modules/.pnpm/node_modules',shim); self.assertNotIn(str(self.up.stage),shim)
        self.assertTrue(os.access(self.up.stage/'apps/backend/node_modules/.bin/tool',os.X_OK))
        state=json.loads((self.up.stage/'node_modules/.pnpm-workspace-state-v1.json').read_text())
        self.assertEqual(sorted(state['projects']),[str(self.root),str(self.root)+'/apps/backend'])
        self.assertIn(str(self.up.stage),(self.up.stage/'node_modules/.pnpm/tool@2.0.0/node_modules/tool/index.js').read_text())
        self.up.activate()
        self.assertEqual(self.up.manifest['status'],'complete')
        self.assertEqual(self.up.manifest['entries'][-1]['name'],'node_modules')
        self.assertTrue((self.root/'node_modules/new-dependency').exists()); self.assertFalse((self.root/'node_modules/old-dependency').exists())
        # The old dependencies are what a rollback restores
        self.assertTrue((self.up.backup/'previous/node_modules/old-dependency').exists())
        self.assertIn(str(self.root),(self.root/'apps/backend/node_modules/.bin/tool').read_text())
    def test_rollback_restores_the_previous_dependencies(self):
        self.dependency_fixture(); self.prepare(); self.up.activate()
        rollback=FixtureUpgrade(self.root,self.host,self.units); rollback.preflight()
        u.validate_manifest(self.up.manifest)
        rollback.backup=self.up.backup; rollback.stage=self.up.stage; rollback.manifest=self.up.manifest
        rollback.rollback(manual=True)
        self.assertTrue((self.root/'node_modules/old-dependency').exists()); self.assertFalse((self.root/'node_modules/new-dependency').exists())
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'old backend')
    def test_failed_start_after_a_dependency_change_rolls_the_dependencies_back(self):
        self.dependency_fixture(); self.prepare(); self.host.fail_start='libreoj-backend.service'
        with self.assertRaises(u.UpgradeError): self.up.activate()
        self.up.rollback()
        self.assertTrue((self.root/'node_modules/old-dependency').exists()); self.assertFalse((self.root/'node_modules/new-dependency').exists())
        self.assertEqual(self.up.manifest['status'],'rolled-back')
    def test_failed_dependency_install_keeps_services_running(self):
        self.dependency_fixture(); self.up.preflight(); self.host.fail_install=True
        with self.assertRaisesRegex(u.UpgradeError,'operation failed'): self.up.prepare(self.source,{'treeSha256':u.tree_digest(self.source)})
        self.assertFalse(any(c[0]=='service' for c in self.host.calls))
        self.assertTrue((self.root/'node_modules/old-dependency').exists())
    def test_new_backend_checks_the_installed_configuration_before_maintenance(self):
        self.prepare()
        check=[c for c in self.host.calls if len(c) > 2 and c[1:3]==('-e',u.BACKEND_CONFIGURATION_CHECK)]
        self.assertEqual([c[3] for c in check],[str(self.up.stage/'apps/backend/package.json')])
    def test_configuration_the_new_backend_refuses_keeps_services_running(self):
        self.dependency_fixture(); self.up.preflight(); self.host.config_refused=True
        with self.assertRaisesRegex(u.UpgradeError,'refuses the installed config/backend.yaml'):
            self.up.prepare(self.source,{'treeSha256':u.tree_digest(self.source)})
        self.assertFalse(any(c[0]=='service' for c in self.host.calls))
        self.assertTrue((self.root/'node_modules/old-dependency').exists())
    def test_web_dependency_change_installs_without_native_rebuild(self):
        for name in ('install-state.json','install-complete.json'):
            p=self.root/'config'/name; value=json.loads(p.read_text()); value['role']='web'; p.write_text(json.dumps(value))
        self.host.states.pop('libreoj-judge.service')
        self.dependency_fixture(); self.prepare()
        self.assertEqual((self.up.native_rebuild,self.up.sandbox_changed),([],False))
        self.up.activate()
        self.assertTrue((self.root/'node_modules/new-dependency').exists())
    def test_dependency_change_cannot_change_the_pinned_pnpm_or_lockfile_format(self):
        self.dependency_fixture(manager='pnpm@11.28.6'); self.up.preflight()
        with self.assertRaisesRegex(u.UpgradeError,'pnpm version'): self.up.compatibility(self.source)
        self.dependency_fixture(); (self.source/'pnpm-lock.yaml').write_text(json.dumps({**self.LOCK_AFTER,'lockfileVersion':'10.0'}))
        with self.assertRaisesRegex(u.UpgradeError,'lockfile format'): self.up.compatibility(self.source)
        (self.source/'pnpm-lock.yaml').write_text('packages: [unterminated')
        with self.assertRaisesRegex(u.UpgradeError,'Invalid pnpm lockfile'): self.up.compatibility(self.source)
    def test_without_dependency_changes_the_installed_dependencies_stay(self):
        self.prepare(); self.up.activate()
        self.assertFalse(any('install' in c for c in self.host.calls))
        self.assertNotIn('node_modules',[entry['name'] for entry in self.up.manifest['entries']])
        self.assertTrue((self.root/'node_modules/old-dependency').exists())
    def test_tooling_configuration_may_change_but_shared_code_may_not(self):
        self.up.preflight()
        for relative in ('packages/shared/tsconfig.json','packages/shared/eslint.config.mjs','infra/tsconfig.json'):
            with self.subTest(path=relative):
                (self.source/relative).parent.mkdir(parents=True,exist_ok=True)
                (self.source/relative).write_text('{"compilerOptions": {"module": "nodenext"}}')
                self.up.compatibility(self.source)
        (self.source/'packages/shared/src/index.ts').write_text('changed shared code')
        with self.assertRaisesRegex(u.UpgradeError,'frozen runtime contract'): self.up.compatibility(self.source)
    def test_frontend_build_inputs_may_change_but_other_bootstrap_packages_may_not(self):
        self.up.preflight()
        for relative in ('packages/service-worker/retire-service-worker.js','packages/service-worker/src/installer.ts'):
            (self.source/relative).parent.mkdir(parents=True,exist_ok=True)
            (self.source/relative).write_text('// retires the old worker')
        self.up.compatibility(self.source)
        self.assertEqual((self.up.runtime_changes,self.up.native_rebuild),([],[]))
        (self.source/'packages/bootstrap-core/src').mkdir(parents=True)
        (self.source/'packages/bootstrap-core/src/index.ts').write_text('changed bootstrap code')
        with self.assertRaisesRegex(u.UpgradeError,'frozen runtime contract'): self.up.compatibility(self.source)
    def test_rollback_manifest_may_name_the_dependencies_but_no_other_persistent_entry(self):
        for name in ('node_modules','public'):
            u.validate_manifest({'guardBefore':False,'entries':[{'name':name,'hadOld':True,'oldMoved':True,'newMoved':True}]})
        for name in ('config','data','runtime','backups'):
            with self.subTest(name=name),self.assertRaisesRegex(u.UpgradeError,'Unsafe rollback manifest entry'):
                u.validate_manifest({'guardBefore':False,'entries':[{'name':name,'hadOld':True,'oldMoved':True,'newMoved':True}]})
    def repository_link_fixtures(self):
        for relative in u.REPOSITORY_LINK_MANIFESTS:
            directory=relative.rsplit('/',1)[0]
            manifest={'name':'@libreoj/'+directory.split('/')[-1], 'version':'1.0.0',
                      'repository':{'type':'git','url':u.LEGACY_PACKAGE_REPOSITORY,'directory':directory},
                      'scripts':{'build':'node build.js'}, 'dependencies':{'example':'1.0.0'},
                      'engines':{'node':'>=22'}, 'packageManager':'pnpm@11.13.1'}
            for tree in (self.root,self.source):
                target=tree/relative; target.parent.mkdir(parents=True,exist_ok=True)
                value=json.loads(json.dumps(manifest))
                if relative in u.LEGACY_PACKAGE_DESCRIPTIONS:
                    value['description']=u.LEGACY_PACKAGE_DESCRIPTIONS[relative]
                if tree==self.source:
                    value['repository']['url']=u.PACKAGE_REPOSITORY
                    if 'description' in value: value['description']=value['description'].replace('LibreOJ','LLMOJ')
                target.write_text(json.dumps(value,indent=2)+'\n')
        for tree in (self.root,self.source):
            (tree/'package.json').write_text(json.dumps({'name':'@libreoj/monorepo','packageManager':'pnpm@11.13.1'}))
        for tree,title in ((self.root,'LibreOJ'),(self.source,'LLMOJ')):
            (tree/u.BOOTSTRAP_SETTINGS).parent.mkdir(parents=True,exist_ok=True)
            (tree/u.BOOTSTRAP_SETTINGS).write_text(json.dumps({'env':{'title':title,'apiEndpoint':'https://example.invalid/api','cdnRoot':'https://example.invalid/assets'},'substitution':{'__default_title__':'${title}'}}))

    def test_repository_metadata_only_upgrade_preserves_raw_source_verification(self):
        self.repository_link_fixtures()
        expected={name:u.digest(self.source/name) for name in (*u.REPOSITORY_LINK_MANIFESTS,u.BOOTSTRAP_SETTINGS)}
        self.up.preflight()
        verified=self.up.compatibility(self.source)
        self.assertTrue(all(verified[name]==value for name,value in expected.items()))
        self.assertNotEqual(u.digest(self.root/'apps/judge/package.json'),expected['apps/judge/package.json'])
        self.prepare(); self.up.activate()
        self.assertEqual(self.up.manifest['status'],'complete')
        for name,value in expected.items(): self.assertEqual(u.digest(self.root/name),value)

    def test_repository_link_exception_does_not_hide_executable_or_other_metadata_changes(self):
        # A branding-only manifest difference is no dependency change; any other difference is one, which installs
        self.repository_link_fixtures(); self.up.preflight()
        self.up.compatibility(self.source); self.assertEqual(self.up.dependency_changes,[])
        changes=[('description','arbitrary new description'),('dependencies',{'example':'2.0.0'}),('scripts',{'build':'node changed.js'}),
                 ('name','@another/package'),('engines',{'node':'>=26'}),('packageManager','pnpm@12.0.0'),
                 ('repository',{'type':'git','url':'https://github.com/another/project.git','directory':'apps/judge'}),
                 ('repository',{'type':'git','url':u.PACKAGE_REPOSITORY,'directory':'another/path'}),
                 ('repository',{'type':'svn','url':u.PACKAGE_REPOSITORY,'directory':'apps/judge'})]
        for relative in u.REPOSITORY_LINK_MANIFESTS:
            target=self.source/relative; original=target.read_text()
            for field,value in changes:
                with self.subTest(manifest=relative,field=field,value=value):
                    changed=json.loads(original); changed[field]=value; target.write_text(json.dumps(changed))
                    self.up.compatibility(self.source); self.assertEqual(self.up.dependency_changes,[relative])
                    target.write_text(original)

    def test_bootstrap_branding_exception_keeps_network_and_substitutions_strict(self):
        self.repository_link_fixtures(); self.up.preflight()
        target=self.source/u.BOOTSTRAP_SETTINGS; original=target.read_text()
        for section,key,value in [('env','title','Custom unrelated title'),('env','apiEndpoint','https://changed.invalid/api'),
                                  ('env','cdnRoot','https://changed.invalid/cdn'),('substitution','__default_title__','changed')]:
            with self.subTest(section=section,key=key):
                changed=json.loads(original); changed[section][key]=value; target.write_text(json.dumps(changed))
                with self.assertRaisesRegex(u.UpgradeError,'frozen runtime contract'): self.up.compatibility(self.source)
                target.write_text(original)

    def test_repository_link_exception_does_not_extend_to_other_manifests(self):
        self.up.preflight()
        for tree,url in ((self.root,u.LEGACY_PACKAGE_REPOSITORY),(self.source,u.PACKAGE_REPOSITORY)):
            (tree/'package.json').write_text(json.dumps({'packageManager':'pnpm@11.13.1','repository':{'url':url}}))
        self.up.compatibility(self.source); self.assertEqual(self.up.dependency_changes,['package.json'])

    def test_judge_change_rejected(self):
        self.up.preflight(); (self.source/'apps/judge/src/index.ts').write_text('different')
        with self.assertRaises(u.UpgradeError): self.up.compatibility(self.source)
    def test_new_dropin_during_build_refuses_cutover(self):
        self.prepare()
        self.host.override[('libreoj-backend.service','DropInPaths')]=str(self.units/'new-custom.conf')
        with self.assertRaisesRegex(u.UpgradeError,'drop-ins'): self.up.activate()
        self.assertFalse(any(c[0]=='service' for c in self.host.calls))
    def test_space_exhausted_during_build_keeps_services_running(self):
        self.prepare()
        with patch.object(u.shutil,'disk_usage',return_value=shutil._ntuple_diskusage(100,90,10)):
            with self.assertRaisesRegex(u.UpgradeError,'final database'): self.up.activate()
        self.assertFalse(any(c[0]=='service' for c in self.host.calls))
    def test_runtime_change_rejected(self):
        self.up.preflight(); (self.source/'deploy').mkdir(exist_ok=True)
        (self.source/'apps/backend/src/database').mkdir(parents=True,exist_ok=True)
        (self.source/'deploy/install.sh').write_text('NODE_VERSION=25.0.0\n')
        with self.assertRaises(u.UpgradeError): self.up.compatibility(self.source)
    def test_missing_sync_guard_rejected(self):
        self.up.preflight(); (self.source/'apps/backend/src/database/database.providers.ts').write_text('synchronize true')
        with self.assertRaises(u.UpgradeError): self.up.compatibility(self.source)
    def test_low_disk_before_backup(self):
        self.up.preflight()
        with patch.object(u.shutil,'disk_usage',return_value=shutil._ntuple_diskusage(100,90,10)):
            with self.assertRaises(u.UpgradeError): self.up.prepare(self.source,{'treeSha256':u.tree_digest(self.source)})
        self.assertFalse((self.root/'backups').exists())
    def test_all_upgrade_preserves_config_key_judge_and_old_assets(self):
        self.prepare(); before=u.snapshot(self.root/'config'); key=(self.root/'data/ai/master.key').read_bytes()
        self.up.activate()
        self.assertEqual(self.up.manifest['status'],'complete')
        self.assertEqual(before,u.snapshot(self.root/'config')); self.assertEqual(key,(self.root/'data/ai/master.key').read_bytes())
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'new backend')
        self.assertTrue((self.root/'public/old-hash.js').exists()); self.assertTrue((self.root/'public/new-hash.js').exists())
        self.assertTrue(all(self.host.states.values())); self.assertEqual(self.up.guard.read_text(),u.GUARD)
        self.assertEqual(stat.S_IMODE(self.up.backup.stat().st_mode),0o700)
        self.assertEqual(stat.S_IMODE((self.up.backup/'database.sql').stat().st_mode),0o600)
        # The build's copy of the dependencies is gone; what a rollback needs stays
        self.assertFalse((self.up.stage/'node_modules').exists()); self.assertTrue((self.root/'node_modules').is_dir())
        self.assertTrue((self.up.backup/'previous/apps').is_dir())
    def test_web_inactive_backend_and_nginx_remain_stopped(self):
        for name in ('install-state.json','install-complete.json'):
            p=self.root/'config'/name; value=json.loads(p.read_text()); value['role']='web'; p.write_text(json.dumps(value))
        self.host.states.pop('libreoj-judge.service'); self.host.states['libreoj-backend.service']=False; self.host.states['libreoj-nginx.service']=False
        self.prepare(); self.up.activate()
        self.assertFalse(self.host.states['libreoj-backend.service']); self.assertFalse(self.host.states['libreoj-nginx.service'])
        self.assertFalse(any(c[:2]==('service','start') and 'judge' in c[2] for c in self.host.calls))
    def test_build_failure_keeps_services_running(self):
        self.up.preflight()
        with patch.object(self.up,'build',side_effect=u.UpgradeError('build failed')):
            with self.assertRaises(u.UpgradeError): self.up.prepare(self.source,{'treeSha256':u.tree_digest(self.source)})
        self.assertTrue(all(self.host.states.values())); self.assertFalse(any(c[0]=='service' for c in self.host.calls))
    def test_live_schema_preflight_rejects_external_reference_before_stopping(self):
        audit_calls=[]
        def audit(database,action='audit'):
            audit_calls.append((database,action))
            if database=='libreoj': raise u.UpgradeError('UNKNOWN_FOREIGN_KEY')
            return {'queries':[],'migration':{}}
        with patch.object(self.up,'schema',side_effect=audit):
            with self.assertRaisesRegex(u.UpgradeError,'UNKNOWN_FOREIGN_KEY'):
                self.prepare()
        self.assertEqual(audit_calls,[('libreoj','audit')])
        self.assertFalse(any(call[0]=='service' for call in self.host.calls))

    def test_migration_refusal_reason_is_safe_and_useful(self):
        self.up.preflight()
        self.up.stage=self.source
        response=subprocess.CompletedProcess([],1,b'',b'UPGRADE_COMPATIBILITY: LEGACY_BUSINESS_REFERENCES\n')
        with patch.object(self.host,'run',return_value=response):
            with self.assertRaisesRegex(u.UpgradeError,'LEGACY_BUSINESS_REFERENCES.*content, privileges or links'):
                u.Upgrade.schema(self.up,'libreoj')
        response=subprocess.CompletedProcess([],1,b'',b'SQL secret-should-not-leak password=value')
        with patch.object(self.host,'run',return_value=response):
            with self.assertRaises(u.UpgradeError) as result:
                u.Upgrade.schema(self.up,'libreoj')
        self.assertNotIn('secret-should-not-leak',str(result.exception))
        self.assertNotIn('password=value',str(result.exception))

    def test_unknown_schema_before_stop(self):
        self.up.preflight()
        with patch.object(self.up,'schema',side_effect=u.UpgradeError('unknown schema')):
            with self.assertRaises(u.UpgradeError): self.up.prepare(self.source,{'treeSha256':u.tree_digest(self.source)})
        self.assertFalse(any(c[0]=='service' for c in self.host.calls))
    def test_active_jobs_refuse_before_stopping(self):
        self.prepare(); self.host.queued=1
        with self.assertRaises(u.UpgradeError): self.up.activate()
        self.assertFalse(any(c[0]=='service' for c in self.host.calls))
    def test_cancelled_worker_still_holding_lease_prevents_cutover(self):
        self.prepare(); self.host.worker_locked=True
        with patch.object(u.time,'sleep'),self.assertRaisesRegex(u.UpgradeError,'lease'): self.up.activate()
        self.assertFalse(any(c[0]=='service' for c in self.host.calls))
    def test_changed_config_refuses_cutover(self):
        self.prepare(); (self.root/'config/judge.yaml').write_text('administrator edit')
        with self.assertRaises(u.UpgradeError): self.up.activate()
        self.assertTrue(all(self.host.states.values()))
    def test_start_failure_rolls_back_code_and_guard_without_importing_db(self):
        self.prepare(); self.host.fail_start='libreoj-backend.service'
        with self.assertRaises(u.UpgradeError): self.up.activate()
        self.up.rollback()
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'old backend')
        self.assertFalse(self.up.guard.exists()); self.assertTrue(all(self.host.states.values()))
        # No ALTER/DROP or restore on the original database in rollback.
        self.assertEqual(self.up.manifest['status'],'rolled-back')
    def test_partial_rename_signal_recovery(self):
        self.prepare(); real=u.os.replace; count=0
        def interrupted(src,dst):
            nonlocal count
            result=real(src,dst)
            if Path(src)==self.root/'apps':
                count+=1
                raise KeyboardInterrupt('synthetic signal between rename and save')
            return result
        with patch.object(u.os,'replace',side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt): self.up.activate()
        self.up.rollback(); self.assertEqual(count,1)
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'old backend')
    def test_manual_rollback_removes_own_guard_without_hash_failure(self):
        self.prepare(); self.up.activate()
        rollback=FixtureUpgrade(self.root,self.host,self.units); rollback.preflight()
        rollback.backup=self.up.backup; rollback.stage=self.up.stage; rollback.manifest=self.up.manifest
        rollback.rollback(manual=True)
        self.assertFalse(rollback.guard.exists()); self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'old backend')
    def test_manual_rollback_with_unapproved_accounts_rejected(self):
        self.prepare(); self.up.activate(); self.host.pending_accounts=1
        before=len(self.host.calls)
        with self.assertRaisesRegex(u.UpgradeError,'approval gate'): self.up.rollback(manual=True)
        self.assertFalse(any(c[0]=='service' for c in self.host.calls[before:])); self.assertTrue(self.up.guard.exists())
    def test_manual_rollback_to_yaml_only_backend_refuses_each_saved_registration_mode(self):
        self.prepare(); self.up.activate()
        before=len(self.host.calls)
        for mode in ('open', 'approval', 'closed'):
            with self.subTest(mode=mode):
                self.host.registration_override=mode
                with self.assertRaisesRegex(u.UpgradeError, 'saved website registration policy'):
                    self.up.rollback(manual=True)
        self.assertFalse(any(c[0]=='service' for c in self.host.calls[before:]))
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'new backend')
    def test_reset_registration_policy_allows_existing_safe_rollback(self):
        self.prepare(); self.up.activate(); self.host.registration_override='closed'
        with self.assertRaisesRegex(u.UpgradeError, 'saved website registration policy'):
            self.up.rollback(manual=True)
        self.host.registration_override=None
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'old backend')
    def test_corrupted_registration_policy_is_not_treated_as_an_explicit_reset(self):
        self.prepare(); self.up.activate(); self.host.registration_policy_corrupt=True
        before=len(self.host.calls)
        with self.assertRaisesRegex(u.UpgradeError, 'saved website registration policy'):
            self.up.rollback(manual=True)
        self.assertFalse(any(c[0]=='service' for c in self.host.calls[before:]))
    def test_rollback_to_backend_without_ai_policy_refuses_a_saved_pause_or_budget(self):
        self.prepare(); self.up.activate(); self.host.ai_policy_limited=True
        before=len(self.host.calls)
        with self.assertRaisesRegex(u.UpgradeError, 'AI pause and budgets'):
            self.up.rollback(manual=True)
        self.assertFalse(any(c[0]=='service' for c in self.host.calls[before:]))
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'new backend')
        self.host.ai_policy_limited=False
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
    def test_rollback_to_ai_policy_aware_backend_keeps_the_policy(self):
        previous_service=self.root/'apps/backend/dist/settings/ai-policy.service.js'
        previous_service.parent.mkdir(parents=True)
        previous_service.write_text('old policy-aware backend')
        self.prepare(); self.up.activate(); self.host.ai_policy_limited=True
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
    def test_ai_policy_rollback_query_counts_only_a_pause_or_budget(self):
        self.prepare(); self.up.activate()
        self.up.rollback(manual=True)
        query=next(c for c in self.host.queries if "'ai-policy'" in c)
        for clause in ("JSON_TYPE(`value`)", "'$.paused'", "'$.userDailyTokens'", "'$.userDailyRequests'"):
            self.assertIn(clause, query)
        self.assertNotIn('jobRequests', query)
    def test_rollback_to_backend_without_approved_ai_addresses_refuses_an_approved_only_site(self):
        self.prepare(); self.up.activate(); self.host.ai_endpoints_restricted=True
        before=len(self.host.calls)
        with self.assertRaisesRegex(u.UpgradeError, 'only approved AI addresses'):
            self.up.rollback(manual=True)
        self.assertFalse(any(c[0]=='service' for c in self.host.calls[before:]))
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'new backend')
        self.host.ai_endpoints_restricted=False
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        query=next(c for c in self.host.queries if "'ai-endpoints'" in c)
        for clause in ("JSON_TYPE(`value`)", "'$.customEndpoints'", "<> 'public'"):
            self.assertIn(clause, query)
    def test_rollback_to_endpoint_aware_backend_keeps_the_approved_only_setting(self):
        previous_service=self.root/'apps/backend/dist/settings/ai-endpoint-policy.service.js'
        previous_service.parent.mkdir(parents=True)
        previous_service.write_text('old endpoint-aware backend')
        self.prepare(); self.up.activate(); self.host.ai_endpoints_restricted=True
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
    def test_rollback_to_policy_aware_backend_retains_override(self):
        previous_service=self.root/'apps/backend/dist/settings/registration-settings.service.js'
        previous_service.parent.mkdir(parents=True)
        previous_service.write_text('old policy-aware backend')
        self.prepare(); self.up.activate(); self.host.registration_override='approval'
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        self.assertEqual(self.host.registration_override, 'approval')
        self.assertEqual(previous_service.read_text(), 'old policy-aware backend')
    def test_automatic_rollback_keeps_new_code_when_saved_policy_would_be_ignored(self):
        self.prepare(); self.up.activate(); self.host.registration_override='closed'
        with self.assertRaisesRegex(u.UpgradeError, 'saved website registration policy'):
            self.up.rollback()
        self.assertFalse(self.host.states['libreoj-backend.service'])
        self.assertFalse(self.host.states['libreoj-nginx.service'])
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'new backend')
    def test_manual_rollback_rechecks_new_saved_policy_after_stop(self):
        self.prepare(); self.up.activate()
        stop_apps=self.up.stop_apps
        def stop_with_concurrent_policy_change():
            self.host.registration_override='closed'
            stop_apps()
        with patch.object(self.up, 'stop_apps', side_effect=stop_with_concurrent_policy_change):
            with self.assertRaisesRegex(u.UpgradeError, 'saved website registration policy'):
                self.up.rollback(manual=True)
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'new backend')
        self.assertFalse(self.host.states['libreoj-backend.service'])
    def test_automatic_rollback_refuses_after_new_pending_account(self):
        self.prepare(); self.up.activate(); self.host.pending_accounts=1
        with self.assertRaisesRegex(u.UpgradeError,'approval gate'): self.up.rollback()
        self.assertFalse(self.host.states['libreoj-backend.service']); self.assertFalse(self.host.states['libreoj-nginx.service'])
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'new backend')
    def test_application_only_pending_prevents_auth_downgrade(self):
        self.prepare(); self.up.activate(); self.host.application_table=True; self.host.pending_applications=1
        with self.assertRaisesRegex(u.UpgradeError,'approval gate'): self.up.rollback(manual=True)
        self.assertTrue(self.host.states['libreoj-backend.service'])
    def test_moved_account_migration_does_not_claim_automatic_data_rollback(self):
        self.prepare(); self.up.activate()
        self.up.manifest['registrationMigration']={'pending':1,'rejected':0}
        self.up.manifest['registrationMigrationApplied']=True
        with self.assertRaisesRegex(u.UpgradeError,'moved legacy'): self.up.rollback()
        self.assertFalse(self.host.states['libreoj-backend.service'])
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'new backend')
    def test_manual_rollback_rechecks_after_stop_race(self):
        self.prepare(); self.up.activate()
        original=self.host.service
        def racing(action,unit):
            original(action,unit)
            if action=='stop' and unit=='libreoj-backend.service': self.host.pending_accounts=1
        self.host.service=racing
        with self.assertRaisesRegex(u.UpgradeError,'approval gate'): self.up.rollback(manual=True)
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'new backend')
    def test_fresh_process_can_recover_missing_apps_after_rename_gap(self):
        self.prepare(); self.up.stop_apps(); self.up.manifest['status']='maintenance'
        previous=self.up.backup/'previous'; previous.mkdir()
        self.up.manifest['entries']=[{'name':'apps','hadOld':True,'oldMoved':False,'newMoved':False}]
        self.up.save(); os.replace(self.root/'apps',previous/'apps')
        recovered=FixtureUpgrade(self.root,self.host,self.units)
        u.validate_manifest(self.up.manifest)
        recovered.preflight(recovery=(self.up.backup,self.up.manifest))
        recovered.backup=self.up.backup; recovered.stage=self.up.stage; recovered.manifest=self.up.manifest; recovered.states=self.up.manifest['states']
        recovered.rollback(manual=True)
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(),'old backend')
        self.assertTrue(all(self.host.states.values()))
    def test_restrictive_umask_does_not_make_published_artifacts_private(self):
        old=os.umask(0o077)
        try: self.prepare()
        finally: os.umask(old)
        self.up.activate()
        self.assertTrue((self.root/'apps/backend/dist/main.js').stat().st_mode & 0o004)
        self.assertTrue((self.root/'apps/backend/dist').stat().st_mode & 0o001)
        self.assertEqual(stat.S_IMODE(self.up.backup.stat().st_mode),0o700)
        self.assertEqual(stat.S_IMODE((self.up.backup/'ai-master.key').stat().st_mode),0o600)
    def test_bootstrap_ref_equals_and_duplicate_unknown_rejection(self):
        wrapper=(MODULE.parents[1]/'upgrade.sh').read_text().split("<<'PY'\n",1)[1].rsplit('\nPY',1)[0]
        prefix=wrapper.split('try:\n    sha =',1)[0]
        with patch.object(sys,'argv',['bootstrap','--ref=abc123','--plan']):
            scope={}; exec(prefix,scope); self.assertEqual(scope['ref'],'abc123')
        with patch.object(sys,'argv',['bootstrap','--prefix','/opt/LLMOJ','--status']):
            scope={}; exec(prefix,scope); self.assertTrue(scope['parsed'].status)
        for args in (['--ref','abc','--ref=def'],['--typo'],['--source=/tmp/no']):
            with patch.object(sys,'argv',['bootstrap',*args]),contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit): exec(prefix,{})
    def test_entry_scripts_differ_only_in_language(self):
        english=(MODULE.parents[1]/'upgrade.sh').read_text()
        chinese=(MODULE.parents[1]/'upgrade.zh-CN.sh').read_text()
        self.assertIn("LANGUAGE = 'en'\n", english)
        self.assertEqual(chinese, english.replace("LANGUAGE = 'en'\n", "LANGUAGE = 'zh-CN'\n"))
        # The upgrader prints in the entry script's language
        for language, expected in (('en', 'Upgrade not completed: '), ('zh-CN', '升级未完成：')):
            with patch.dict(os.environ, {'LLMOJ_LANG': language}):
                self.assertEqual(u.say('Upgrade not completed: ', '升级未完成：'), expected)
    def test_modified_guard_not_overwritten(self):
        self.up.guard.parent.mkdir(); self.up.guard.write_text('custom secret setting')
        with self.assertRaises(u.UpgradeError): self.up.preflight()
    def test_symlink_source_rejected(self):
        (self.source/'surprise').symlink_to('/etc/passwd')
        with self.assertRaises(u.UpgradeError): u.tree_digest(self.source)
    def test_maintenance_lock_conflict(self):
        lock=self.base/'lock'
        with u.maintenance_lock(lock):
            with self.assertRaises(u.UpgradeError):
                with u.maintenance_lock(lock): pass
    def test_manifest_traversal_rejected(self):
        self.prepare(); self.up.manifest['entries']=[{'name':'../outside','hadOld':False}]
        with self.assertRaisesRegex(u.UpgradeError,'manifest'): self.up.rollback()
    def test_unsafe_archive_link_or_parent_rejected_before_extract(self):
        for name,kind in [('root/../../escaped',tarfile.REGTYPE),('root/link',tarfile.SYMTYPE)]:
            data=io.BytesIO()
            with tarfile.open(fileobj=data,mode='w:gz') as tar:
                member=tarfile.TarInfo('root'); member.type=tarfile.DIRTYPE; tar.addfile(member)
                member=tarfile.TarInfo(name); member.type=kind; member.linkname='/etc/passwd'; tar.addfile(member)
            output=self.base/'extracted'
            with self.assertRaises(u.UpgradeError): u.extract_archive(data.getvalue(),output)
            self.assertFalse(output.exists())


class ProgressTests(unittest.TestCase):
    """What the person running an upgrade sees while a step runs."""
    def test_a_terminal_shows_the_running_step_with_its_time(self):
        stream=io.StringIO(); progress=u.Progress(stream,live=True)
        with progress.step('backend'): time.sleep(1.3)
        text=stream.getvalue()
        self.assertTrue(text.startswith('[ 6/17] Building the backend …\r\x1b[K[ 6/17] Building the backend … 1 s'),text)
        self.assertTrue(text.endswith('\r\x1b[K[ 6/17] Building the backend: done (1 s)\n'),text)
    def test_lines_said_during_a_live_step_keep_the_step_on_screen(self):
        stream=io.StringIO(); progress=u.Progress(stream,live=True)
        with progress.step('stop'):
            progress.offline()
            progress.say('A line','A line')
        self.assertEqual(stream.getvalue(),'[ 9/17] Stopping the website, the backend and the judge …'
                         '\r\x1b[KA line\n[ 9/17] Stopping the website, the backend and the judge …'
                         '\r\x1b[K[ 9/17] Stopping the website, the backend and the judge: done (0 s)\n'
                         'The website is offline from now on.\n')
    def test_without_a_terminal_a_long_step_says_it_still_runs(self):
        stream=io.StringIO(); progress=u.Progress(stream,live=False,heartbeat=1)
        with progress.step('frontend'): time.sleep(2.3)
        self.assertIn('\n[ 7/17] Building the website: still running (1 s)\n',stream.getvalue())
        self.assertNotIn('\r',stream.getvalue())
    def test_chinese(self):
        stream=io.StringIO()
        with patch.dict(os.environ,{'LLMOJ_LANG':'zh-CN'}):
            progress=u.Progress(stream,live=False)
            with progress.step('backend'): pass
            progress.skip('native')
        self.assertEqual(stream.getvalue(),'[ 6/17] 构建后端 …\n[ 6/17] 构建后端：完成（0 秒）\n[ 4/17] 重新构建沙箱和评测机的本地程序：不需要\n')
    def test_a_terminal_that_cant_show_a_character_still_shows_the_rest(self):
        raw=io.BytesIO(); stream=io.TextIOWrapper(raw,encoding='ascii')
        progress=u.Progress(stream,live=False)
        with progress.step('copy'): pass
        self.assertEqual(raw.getvalue(),b'[ 2/17] Copying the installation to a staging area ?\n[ 2/17] Copying the installation to a staging area: done (0 s)\n')
    def test_durations(self):
        self.assertEqual([u.duration(x) for x in (0,59,61,3600,3725)],['0 s','59 s','1 min 1 s','1 h 0 min','1 h 2 min'])
    @unittest.skipUnless(os.geteuid()==0,'Run with sudo; the record is written as the upgrader writes it')
    def test_a_real_hangup_ends_only_the_printing(self):
        # As after the confirmation: the terminal closes (the SSH connection drops) while a step runs
        directory=Path(tempfile.mkdtemp(prefix='progress-hangup-')); self.addCleanup(shutil.rmtree,directory)
        child=('import importlib.util, signal, sys, time\n'
               'spec = importlib.util.spec_from_file_location("upgrade", sys.argv[1]); u = importlib.util.module_from_spec(spec)\n'
               'spec.loader.exec_module(u)\n'
               'signal.signal(signal.SIGHUP, signal.SIG_IGN)\n'
               'progress = u.Progress(sys.stdout); progress.attach(sys.argv[2])\n'
               'with progress.step("backend"): time.sleep(2)\n'
               'progress.finish("complete"); progress.say("Finished", "Finished")\n')
        pid,fd=pty.fork()
        if pid==0:
            os.execv(sys.executable,[sys.executable,'-B','-c',child,str(MODULE),str(directory)])
        seen=b''
        while b'Building the backend' not in seen: seen+=os.read(fd,1024)
        os.close(fd)
        _,status=os.waitpid(pid,0)
        self.assertEqual(os.waitstatus_to_exitcode(status),0)
        self.assertEqual(json.loads((directory/'progress.json').read_text())['state'],'complete')
        log=(directory/'progress.log').read_text()
        self.assertRegex(log,r'Building the backend: done \(2 s\)\n.*Finished\n$')


class HealthTests(unittest.TestCase):
    """The backend counts as started once /api/health/ready reports ready; one without that endpoint (a rollback to an
    older release) once its API description is served."""
    class Response(io.BytesIO):
        def __init__(self, status, value):
            super().__init__(json.dumps(value).encode()); self.status=status
        def __enter__(self): return self
        def __exit__(self, *args): self.close()

    def run_health(self, answers):
        up=u.Upgrade.__new__(u.Upgrade); up.port=2002; urls=[]
        def urlopen(url, timeout):
            urls.append(url.removeprefix('http://127.0.0.1:2002'))
            answer=answers.pop(0) if answers else ConnectionRefusedError()
            if isinstance(answer, BaseException): raise answer
            return self.Response(*answer)
        with patch.object(u.urllib.request,'urlopen',urlopen), patch.object(u.time,'sleep'):
            try:
                up.health(); return urls, None
            except u.UpgradeError as error:
                return urls, error

    @staticmethod
    def http_error(code):
        return u.urllib.error.HTTPError('http://127.0.0.1:2002/api/health/ready', code, 'status', {}, None)

    def test_ready_backend(self):
        urls, error=self.run_health([ConnectionRefusedError(), self.http_error(503), (200, {'status': 'ready'})])
        self.assertIsNone(error); self.assertEqual(urls, ['/api/health/ready']*3)

    def test_backend_that_never_gets_ready_fails(self):
        urls, error=self.run_health([self.http_error(503)]*60)
        self.assertIsNotNone(error); self.assertEqual(len(urls), 60); self.assertNotIn('/docs-json', urls)

    def test_older_backend_without_readiness_is_checked_by_its_api_description(self):
        urls, error=self.run_health([self.http_error(404), ConnectionRefusedError(), (200, {'openapi': '3.0.0', 'paths': {'/api/x': {}}})])
        self.assertIsNone(error); self.assertEqual(urls, ['/api/health/ready', '/docs-json', '/docs-json'])
        urls, error=self.run_health([self.http_error(404)]+[(200, {'openapi': '3.0.0', 'paths': {}})]*59)
        self.assertIsNotNone(error)


class JudgeConnectionTests(unittest.TestCase):
    """After starting the judge, the upgrade (and a rollback) waits for it to connect instead of checking once: its
    session ends when it stops, and its launcher takes some seconds before it connects again."""
    class Host:
        def __init__(self, failures):
            self.failures, self.checks = failures, 0
        def run(self, args, **kwargs):
            assert kwargs.get('check') is False and str(args[-1]) == 'verify-judge'
            self.checks += 1
            return subprocess.CompletedProcess(args, 1 if self.checks <= self.failures else 0, b'', b'')

    def wait(self, failures):
        up=u.Upgrade.__new__(u.Upgrade); up.host=self.Host(failures); up.node=Path('/node'); up.root=Path('/opt/LLMOJ')
        clock=[0.0]
        def sleep(seconds): clock[0]+=seconds
        with patch.object(u.time,'sleep',sleep), patch.object(u.time,'monotonic',lambda: clock[0]):
            try:
                up.wait_for_judge(); return up.host.checks, None
            except u.UpgradeError as error:
                return up.host.checks, error

    def test_a_judge_that_connects_after_a_few_seconds_passes(self):
        checks, error=self.wait(5)
        self.assertIsNone(error); self.assertEqual(checks, 6)

    def test_a_judge_that_never_connects_fails_after_the_wait(self):
        checks, error=self.wait(10**6)
        self.assertIn('did not connect', str(error)); self.assertEqual(checks, u.JUDGE_CONNECT_SECONDS//2+1)


if __name__=='__main__': unittest.main(verbosity=2)
