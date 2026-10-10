#!/usr/bin/env python3
"""Temporary fixtures only. No real service, configuration or database is changed."""
import contextlib
import grp
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import tempfile
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
        self.fail_start = None
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
        if args[0]=='mariadb':
            query=kwargs.get('input',b'')
            if isinstance(query,Path):
                assert query.is_file()
                query=b''
            query=query.decode()
            if 'SELECT IS_USED_LOCK' in query: output=str(int(self.worker_locked)).encode()
            elif 'DATA_LENGTH+INDEX_LENGTH' in query: output=b'1024'
            elif "TABLE_TYPE <> 'BASE TABLE'" in query: output=b''
            elif 'TABLE_NAME=\'registration_review\'' in query: output=str(int(self.review_table)).encode()
            elif 'TABLE_NAME=\'registration_application\'' in query: output=str(int(self.application_table)).encode()
            elif 'FROM `registration_review`' in query: output=str(self.pending_accounts).encode()
            elif 'FROM `registration_application`' in query: output=str(self.pending_applications).encode()
            elif 'FROM `submission`' in query or 'FROM `ai_job`' in query: output=str(self.queued).encode()
            elif query.startswith('SELECT COUNT'): output=b'0'
        elif args[0]=='mariadb-dump': kwargs['output'].write(b'-- synthetic logical SQL backup\n'+b'x'*200)
        elif args[0]=='cp':
            source,target=Path(args[-2]),Path(args[-1]); shutil.copytree(source,target,symlinks=True)
        elif args[-1]=='--version': output=b'11.13.1' if 'pnpm' in args[-2] else b'v24.21.0'
        return subprocess.CompletedProcess(args,0,output,b'')


class FixtureUpgrade(u.Upgrade):
    def build(self):
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


@unittest.skipUnless(os.geteuid()==0, 'Run with sudo; ownership checks use root-owned temporary fixtures')
class UpgradeTests(unittest.TestCase):
    def setUp(self):
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
    def test_dependency_change_rejected(self):
        self.up.preflight(); (self.source/'pnpm-lock.yaml').write_text('different')
        with self.assertRaises(u.UpgradeError): self.up.compatibility(self.source)
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
        self.repository_link_fixtures(); self.up.preflight()
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
                    with self.assertRaisesRegex(u.UpgradeError,'Dependencies'): self.up.compatibility(self.source)
                    target.write_text(original)

    def test_bootstrap_branding_exception_keeps_network_and_substitutions_strict(self):
        self.repository_link_fixtures(); self.up.preflight()
        target=self.source/u.BOOTSTRAP_SETTINGS; original=target.read_text()
        for section,key,value in [('env','title','Custom unrelated title'),('env','apiEndpoint','https://changed.invalid/api'),
                                  ('env','cdnRoot','https://changed.invalid/cdn'),('substitution','__default_title__','changed')]:
            with self.subTest(section=section,key=key):
                changed=json.loads(original); changed[section][key]=value; target.write_text(json.dumps(changed))
                with self.assertRaisesRegex(u.UpgradeError,'Dependencies'): self.up.compatibility(self.source)
                target.write_text(original)

    def test_repository_link_exception_does_not_extend_to_other_manifests(self):
        self.up.preflight()
        for tree,url in ((self.root,u.LEGACY_PACKAGE_REPOSITORY),(self.source,u.PACKAGE_REPOSITORY)):
            (tree/'package.json').write_text(json.dumps({'repository':{'url':url}}))
        with self.assertRaisesRegex(u.UpgradeError,'Dependencies'): self.up.compatibility(self.source)

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
            with self.assertRaisesRegex(u.UpgradeError,'LEGACY_BUSINESS_REFERENCES.*business data'):
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
        import sys
        wrapper=(MODULE.parents[1]/'upgrade.sh').read_text().split("<<'PY'\n",1)[1].rsplit('\nPY',1)[0]
        prefix=wrapper.split('try:\n    sha =',1)[0]
        with patch.object(sys,'argv',['bootstrap','--ref=abc123','--plan']):
            scope={}; exec(prefix,scope); self.assertEqual(scope['ref'],'abc123')
        for args in (['--ref','abc','--ref=def'],['--typo'],['--source=/tmp/no']):
            with patch.object(sys,'argv',['bootstrap',*args]),contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit): exec(prefix,{})
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


if __name__=='__main__': unittest.main(verbosity=2)
