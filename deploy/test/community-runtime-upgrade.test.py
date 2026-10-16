#!/usr/bin/env python3
"""Frozen runtime and rollback regression; disposable fixtures, no live state."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('community_fixtures', HERE/'community-upgrade.test.py')
community = importlib.util.module_from_spec(spec)
spec.loader.exec_module(community)
fixtures, u = community.fixtures, community.u


class RuntimeHost(community.CommunityHost):
    def __init__(self, *args):
        super().__init__(*args)
        self.extension_rows = {}
        self.active_work = {}
        self.hacked_rows = 0
        self.strict_rows = 0
        self.option_rows = 0

    def run(self, args, **kwargs):
        args = list(map(str, args))
        query = kwargs.get('input', b'')
        if args[0] == 'mariadb' and isinstance(query, bytes):
            query = query.decode()
            table = re.search(r"TABLE_NAME='(hack|hack_problem|self_eval|self_eval_set|self_eval_quota|contest|user_privilege|user_permission_rule)'", query)
            output = None
            if table and 'information_schema.TABLES' in query:
                output = int(table[1] in self.feature_tables)
            elif table and 'information_schema.COLUMNS' in query:
                output = int(table[1] in self.feature_tables)
            else:
                counted = re.match(r'SELECT COUNT\(\*\) FROM `(hack|hack_problem|self_eval|self_eval_set|self_eval_quota|contest|user_privilege|user_permission_rule)` WHERE', query)
                if counted:
                    name = counted[1]
                    if name == 'contest':
                        output = self.option_rows if 'ruleOptions' in query else self.strict_rows
                    else:
                        output = self.active_work.get(name, 0) if "status IN ('Pending','Running')" in query else self.extension_rows.get(name, 0)
                elif "FROM `submission` WHERE status='Hacked'" in query:
                    output = self.hacked_rows
            if output is not None:
                self.calls.append(tuple(args))
                self.sql_queries.append(query)
                return subprocess.CompletedProcess(args, 0, str(output).encode(), b'')
        return super().run(args, **kwargs)


@unittest.skipUnless(os.geteuid() == 0, 'Run with sudo; uses root-owned temporary fixtures')
class RuntimeUpgradeTests(unittest.TestCase):
    def setUp(self):
        fixtures.UpgradeTests.setUp(self)
        self.host = RuntimeHost(self.root, self.units)
        self.up = fixtures.FixtureUpgrade(self.root, self.host, self.units)

    def tearDown(self):
        fixtures.UpgradeTests.tearDown(self)

    def prepare(self):
        fixtures.UpgradeTests.prepare(self)

    def runtime_fixture(self):
        paths = sorted(u.COMMUNITY_RUNTIME_PATHS)
        entries = []
        for name in paths:
            relative = Path(name)
            before = None if '/hack/' in name or '/self-eval/' in name else ('old reviewed '+name).encode()
            after = ('new reviewed '+name).encode()
            if before is not None:
                old = self.root/relative
                old.parent.mkdir(parents=True, exist_ok=True)
                old.write_bytes(before)
            target = self.source/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(after)
            entries.append({'path': name, 'oldSha256': [hashlib.sha256(before).hexdigest() if before is not None else None], 'newSha256': hashlib.sha256(after).hexdigest()})
        self.contract = {'version': 1, 'files': entries}
        self.contract_path = self.source/'deploy/community-runtime-contract.json'
        self.contract_path.write_text(json.dumps(self.contract))
        pin = patch.object(u, 'COMMUNITY_RUNTIME_CONTRACT_SHA256', u.digest(self.contract_path))
        pin.start()
        self.addCleanup(pin.stop)
        self.up.preflight()

    def repin_test_contract(self):
        self.contract_path.write_text(json.dumps(self.contract))
        u.COMMUNITY_RUNTIME_CONTRACT_SHA256 = u.digest(self.contract_path)

    def test_only_reviewed_hashes_upgrade_and_raw_provenance_is_preserved(self):
        self.runtime_fixture()
        before = u.snapshot(self.root)
        verified = self.up.compatibility(self.source)
        for entry in self.contract['files']:
            self.assertEqual(verified[entry['path']], entry['newSha256'])
        self.assertEqual(before, u.snapshot(self.root))
        self.assertFalse(any(call[0] == 'service' for call in self.host.calls))

    def test_explicit_second_reviewed_baseline_is_accepted(self):
        self.runtime_fixture()
        entry = next(item for item in self.contract['files'] if item['path'].startswith('packages/'))
        previous = b'first delivery with moderation-only Fake'
        entry['oldSha256'].append(hashlib.sha256(previous).hexdigest())
        (self.root/entry['path']).write_bytes(previous)
        self.repin_test_contract()
        self.up.compatibility(self.source)

    def test_repository_contract_accepts_every_exact_reviewed_baseline(self):
        source = HERE.parents[1]
        contract = json.loads((source/'deploy/community-runtime-contract.json').read_text())
        after = {entry['path']: entry['newSha256'] for entry in contract['files']}
        for entry in contract['files']:
            self.assertEqual(u.digest(source/entry['path']), entry['newSha256'])
        for baseline in range(3):
            before = {entry['path']: entry['oldSha256'][min(baseline, len(entry['oldSha256']) - 1)]
                      for entry in contract['files']}
            self.assertEqual(u.community_runtime_transition(source, before, after), u.COMMUNITY_RUNTIME_PATHS)

    def test_fourth_baseline_is_rejected_even_with_a_fixture_pin(self):
        self.runtime_fixture()
        entry = self.contract['files'][0]
        entry['oldSha256'] = [hashlib.sha256(str(index).encode()).hexdigest() for index in range(4)]
        self.repin_test_contract()
        with self.assertRaisesRegex(u.UpgradeError, 'Invalid runtime contract digest'):
            self.up.compatibility(self.source)

    def test_unknown_deployed_runtime_bytes_are_rejected(self):
        self.runtime_fixture()
        for entry in self.contract['files']:
            with self.subTest(path=entry['path']):
                file = self.root/entry['path']
                existed = file.exists()
                original = file.read_bytes() if existed else None
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'unreviewed deployed custom task')
                with self.assertRaisesRegex(u.UpgradeError, 'supported community baselines'):
                    self.up.compatibility(self.source)
                if existed:
                    file.write_bytes(original)
                else:
                    file.unlink()

    def test_unknown_target_runtime_bytes_or_partial_task_upgrade_are_rejected(self):
        self.runtime_fixture()
        for entry in self.contract['files']:
            with self.subTest(path=entry['path']):
                file = self.source/entry['path']
                original = file.read_bytes()
                file.write_bytes(b'unreviewed target task')
                with self.assertRaisesRegex(u.UpgradeError, 'Target runtime code'):
                    self.up.compatibility(self.source)
                file.unlink()
                with self.assertRaisesRegex(u.UpgradeError, 'Target runtime code'):
                    self.up.compatibility(self.source)
                file.write_bytes(original)

    def test_contract_cannot_authorize_itself_by_rewriting_hashes(self):
        self.runtime_fixture()
        entry = self.contract['files'][0]
        (self.source/entry['path']).write_bytes(b'unreviewed')
        entry['newSha256'] = u.digest(self.source/entry['path'])
        self.contract_path.write_text(json.dumps(self.contract))
        with self.assertRaisesRegex(u.UpgradeError, 'reviewed frozen digest'):
            self.up.compatibility(self.source)

    def test_even_a_trusted_fixture_contract_cannot_add_paths_or_drop_required_entries(self):
        self.runtime_fixture()
        original = json.loads(json.dumps(self.contract))
        variants = [original['files'][:-1], original['files']+[original['files'][0]],
                    [{**original['files'][0], 'path': '../outside.ts'}, *original['files'][1:]]]
        for files in variants:
            with self.subTest(files=files):
                self.contract['files'] = files
                self.repin_test_contract()
                with self.assertRaisesRegex(u.UpgradeError, 'contract path|Incomplete'):
                    self.up.compatibility(self.source)

    def test_dependencies_infrastructure_and_other_shared_packages_remain_rejected(self):
        self.runtime_fixture()
        for relative in ('pnpm-lock.yaml', 'apps/judge/package.json', 'packages/simple-sandbox/package.json',
                         'packages/shared/src/index.ts', 'infra/unreviewed.txt'):
            with self.subTest(path=relative):
                path = self.source/relative
                existed = path.exists()
                original = path.read_bytes() if existed else None
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'{"dependencies": {"unreviewed": "1.0.0"}}' if relative.endswith('.json') else b'unreviewed change')
                try:
                    with self.assertRaisesRegex(u.UpgradeError, 'outside the frozen runtime contract'):
                        self.up.compatibility(self.source)
                finally:
                    if existed:
                        path.write_bytes(original)
                    else:
                        path.unlink()

    def deployed_reviewed_runtime(self):
        """An installation that already runs the reviewed community runtime."""
        self.runtime_fixture()
        for entry in self.contract['files']:
            (self.root/entry['path']).parent.mkdir(parents=True, exist_ok=True)
            (self.root/entry['path']).write_bytes((self.source/entry['path']).read_bytes())
        self.up.compatibility(self.source)
        self.assertEqual((self.up.runtime_changes, self.up.native_rebuild, self.up.sandbox_changed), ([], [], False))

    def change(self, relative, content=b'reviewed later runtime change'):
        path = self.source/relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def test_later_judge_source_changes_need_no_contract_entry(self):
        self.deployed_reviewed_runtime()
        for relative in ('apps/judge/src/rpc.ts', 'apps/judge/src/task/index.ts', 'packages/simple-sandbox/demo/demo.js'):
            self.change(relative)
        self.up.compatibility(self.source)
        self.assertEqual(self.up.runtime_changes, ['apps/judge/src/rpc.ts', 'apps/judge/src/task/index.ts',
                                                   'packages/simple-sandbox/demo/demo.js'])
        self.assertEqual(self.up.native_rebuild, [])
        self.assertTrue(self.up.sandbox_changed)

    def test_native_changes_select_exactly_the_packages_to_rebuild(self):
        self.deployed_reviewed_runtime()
        self.change('apps/judge/native/builtin_checkers/tokens.h')
        self.up.compatibility(self.source)
        self.assertEqual((self.up.native_rebuild, self.up.sandbox_changed), (['apps/judge'], False))
        self.change('packages/simple-sandbox/native/sandbox.cc')
        self.up.compatibility(self.source)
        self.assertEqual((self.up.native_rebuild, self.up.sandbox_changed), (['apps/judge', 'packages/simple-sandbox'], True))

    def test_a_web_installation_accepts_judge_changes_without_native_work(self):
        self.deployed_reviewed_runtime()
        self.up.role = 'web'
        self.change('packages/simple-sandbox/native/sandbox.cc')
        self.change('apps/judge/src/rpc.ts')
        self.up.compatibility(self.source)
        self.assertEqual(len(self.up.runtime_changes), 2)
        self.assertEqual((self.up.native_rebuild, self.up.sandbox_changed), ([], False))

    def test_protocol_values_may_be_added_but_never_removed_or_changed(self):
        self.deployed_reviewed_runtime()
        relative = 'packages/judge-protocol/src/index.ts'
        deployed = 'export enum JudgeTaskType {\n  Submission = "Submission",\n  Hack = "Hack"\n}\n'
        (self.root/relative).write_text(deployed)
        next(entry for entry in self.contract['files'] if entry['path'] == relative)['newSha256'] = u.digest(self.root/relative)
        self.repin_test_contract()
        self.change(relative, deployed.replace('"Hack"\n', '"Hack",\n  Durable = "Durable"\n').encode())
        self.up.compatibility(self.source)
        for candidate in (deployed.replace('  Hack = "Hack"\n', ''), deployed.replace('"Hack"\n}', '"Hacks"\n}'),
                          deployed.replace('JudgeTaskType', 'RenamedTaskType')):
            with self.subTest(candidate=candidate):
                self.change(relative, candidate.encode())
                with self.assertRaisesRegex(u.UpgradeError, 'judge protocol values'):
                    self.up.compatibility(self.source)

    def build_fixture(self, *changes):
        self.deployed_reviewed_runtime()
        for relative in changes:
            self.change(relative)
        self.prepare()
        manifest = {'files': [{'path': '/index.html', 'sha256': u.digest(self.up.stage/'public/index.html')}]}
        (self.up.stage/'public/offline-manifest.json').write_text(json.dumps(manifest))
        (self.up.stage/'apps/backend/dist/database/database.providers.js').write_text('LIBREOJ_SCHEMA_SYNC')
        stale = self.up.stage/'packages/simple-sandbox/build/CMakeCache.txt'
        stale.parent.mkdir(parents=True, exist_ok=True)
        stale.write_text('configured for the live tree')
        addons = []

        def run(args, **kwargs):
            if 'build:native' in map(str, args):
                package = next(path for path, native in u.NATIVE_PACKAGES.items() if native['name'] in map(str, args))
                self.assertFalse((self.up.stage/package/'build/CMakeCache.txt').exists(), 'a stale CMake cache is reused')
                if package not in addons:
                    for addon in u.NATIVE_PACKAGES[package]['addons']:
                        target = self.up.stage/package/'build/Release'/addon
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text('addon')
            return original(args, **kwargs)
        original = self.host.run
        self.host.run = run
        return addons

    def build_commands(self):
        start = len(self.host.calls)
        u.Upgrade.build(self.up)
        return [call for call in self.host.calls[start:] if call and 'build.log' not in call]

    def test_native_changes_are_rebuilt_offline_and_tested_before_the_backend(self):
        self.build_fixture('packages/simple-sandbox/native/sandbox.cc', 'apps/judge/native/posix/posix.cc')
        commands = self.build_commands()
        scripts = [' '.join(call[call.index('--filter')+1:]) for call in commands if '--filter' in call]
        self.assertEqual(scripts[:5], ['@libreoj/judge-protocol run build', 'simple-sandbox run build',
                                       '@libreoj/judge run build:native', 'simple-sandbox run build:native',
                                       '@libreoj/judge run test:native'])
        self.assertLess(scripts.index('@libreoj/judge run check-types'), scripts.index('@libreoj/backend run build'))
        self.assertFalse(any('install' in call for call in commands))

    def test_a_native_rebuild_without_its_addons_fails_before_downtime(self):
        addons = self.build_fixture('apps/judge/native/posix/posix.cc')
        addons.append('apps/judge')
        with self.assertRaisesRegex(u.UpgradeError, 'Native rebuild'):
            u.Upgrade.build(self.up)
        self.assertFalse(any(call[0] == 'service' for call in self.host.calls))

    def test_staged_judge_regressions_run_when_present(self):
        self.build_fixture('apps/judge/src/rpc.ts')
        for relative in u.JUDGE_REGRESSIONS:
            (self.up.stage/relative).parent.mkdir(parents=True, exist_ok=True)
            (self.up.stage/relative).write_text('test')
        commands = self.build_commands()
        tested = [call[-1] for call in commands if '--test' in call]
        self.assertEqual(tested, [str(self.up.stage/relative) for relative in u.JUDGE_REGRESSIONS])

    def test_a_changed_sandbox_is_verified_in_the_maintenance_window_before_schema_changes(self):
        self.deployed_reviewed_runtime()
        self.change('packages/simple-sandbox/native/sandbox.cc')
        self.prepare()
        self.up.activate()
        checks = [index for index, call in enumerate(self.host.calls) if call and call[0] == 'systemd-run']
        self.assertEqual(len(checks), 1)
        check = self.host.calls[checks[0]]
        self.assertIn('--unit=libreoj-install-sandbox-check', check)
        self.assertEqual(check[check.index('--sandbox')+1], str(self.up.stage/'packages/simple-sandbox'))
        stopped = self.host.calls.index(('service', 'stop', 'libreoj-judge.service'))
        dumps = [index for index, call in enumerate(self.host.calls) if call and call[0] == 'mariadb-dump']
        self.assertLess(stopped, checks[0])
        self.assertLess(checks[0], dumps[-1])

    def test_an_unchanged_sandbox_is_not_reverified(self):
        self.deployed_reviewed_runtime()
        self.change('apps/judge/src/rpc.ts')
        self.prepare()
        self.up.activate()
        self.assertFalse(any(call and call[0] == 'systemd-run' for call in self.host.calls))

    def test_new_runtime_cannot_be_downgraded_through_the_forward_contract(self):
        self.runtime_fixture()
        for entry in self.contract['files']:
            (self.root/entry['path']).parent.mkdir(parents=True, exist_ok=True)
            (self.root/entry['path']).write_bytes((self.source/entry['path']).read_bytes())
        old = self.source/'packages/judge-protocol/src/index.ts'
        old.write_bytes(b'old reviewed packages/judge-protocol/src/index.ts')
        with self.assertRaisesRegex(u.UpgradeError, 'Target runtime code'):
            self.up.compatibility(self.source)

    def test_web_install_requires_a_separate_remote_judge_coordination(self):
        self.runtime_fixture()
        self.up.role = 'web'
        with self.assertRaisesRegex(u.UpgradeError, 'remote judges'):
            self.up.compatibility(self.source)

    def test_pending_hack_eval_or_generation_tasks_prevent_maintenance(self):
        self.up.preflight()
        self.host.feature_tables.update(('hack', 'self_eval', 'self_eval_set'))
        for table in ('hack', 'self_eval', 'self_eval_set'):
            with self.subTest(table=table):
                self.host.active_work[table] = 1
                with self.assertRaisesRegex(u.UpgradeError, 'Hack/SelfEval work'):
                    self.up.assert_drained()
                self.host.active_work[table] = 0
        self.up.assert_drained()
        self.assertFalse(any(call[0] == 'service' for call in self.host.calls))

    def activate_fixture(self):
        self.prepare()
        self.up.activate()
        self.host.feature_tables.update(('submission', 'contest', 'hack', 'hack_problem', 'self_eval', 'self_eval_set', 'self_eval_quota', 'user_privilege', 'user_permission_rule'))

    def test_each_hack_self_eval_quota_or_permission_kind_blocks_old_code_before_stop(self):
        self.activate_fixture()
        for table in ('hack', 'hack_problem', 'self_eval', 'self_eval_set', 'self_eval_quota', 'user_privilege', 'user_permission_rule'):
            with self.subTest(table=table):
                self.host.extension_rows[table] = 1
                before = len(self.host.calls)
                with self.assertRaisesRegex(u.UpgradeError, 'Rollback refused'):
                    self.up.rollback(manual=True)
                self.assertFalse(any(call[0] == 'service' for call in self.host.calls[before:]))
                self.host.extension_rows[table] = 0

    def test_hacked_status_strict_contest_and_saved_feature_switches_block_old_code(self):
        self.activate_fixture()
        for field in ('hacked_rows', 'strict_rows', 'option_rows'):
            with self.subTest(field=field):
                setattr(self.host, field, 1)
                with self.assertRaisesRegex(u.UpgradeError, 'Rollback refused'):
                    self.up.rollback(manual=True)
                setattr(self.host, field, 0)

    def test_rollback_rechecks_self_eval_data_created_while_stopping_backend(self):
        self.activate_fixture()
        original = self.host.service
        def race(action, unit):
            original(action, unit)
            if action == 'stop' and unit == 'libreoj-backend.service':
                self.host.extension_rows['self_eval_quota'] = 1
        self.host.service = race
        with self.assertRaisesRegex(u.UpgradeError, 'SelfEval data'):
            self.up.rollback(manual=True)
        self.assertFalse(self.host.states['libreoj-backend.service'])
        self.assertFalse(self.host.states['libreoj-nginx.service'])
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'new backend')

    def test_previous_backend_without_matching_judge_handler_cannot_restore_hack_data(self):
        target = self.root/'apps/backend/dist/hack/hack.service.js'
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('supported backend')
        self.activate_fixture()
        self.host.extension_rows['hack'] = 1
        with self.assertRaisesRegex(u.UpgradeError, 'backend and judge'):
            self.up.rollback(manual=True)

    def test_schema_guard_is_installed_before_partial_ddl_and_survives_apply_failure(self):
        self.prepare()
        query = 'CREATE TABLE `self_eval_quota` (...)'
        def freeze(_dump):
            self.up.manifest.update(schemaQueries=[query], registrationMigration={}, solutionMigration={})
        self.up.schema_on_clone = freeze
        def schema(_database, action='audit'):
            if action == 'apply':
                self.assertEqual(self.up.guard.read_text(), u.GUARD)
                self.assertTrue(self.up.manifest['communitySchemaApplied'])
                raise u.UpgradeError('synthetic failure after one committed DDL')
            return {'compatible': True, 'queries': [query], 'migration': {}, 'solutions': {}}
        self.up.schema = schema
        with self.assertRaisesRegex(u.UpgradeError, 'committed DDL'):
            self.up.activate()
        self.up.rollback()
        self.assertEqual(self.up.guard.read_text(), u.GUARD)
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'old backend')

    def assert_guard_survives(self, query):
        self.prepare()
        def freeze(_dump):
            self.up.manifest.update(schemaQueries=[query], registrationMigration={}, solutionMigration={})
        self.up.schema_on_clone = freeze
        self.up.schema = Mock(return_value={'compatible': True, 'queries': [query], 'migration': {}, 'solutions': {}})
        self.up.activate()
        self.assertTrue(self.up.manifest['communitySchemaApplied'])
        self.up.rollback(manual=True)
        self.assertEqual(self.up.guard.read_text(), u.GUARD)

    def test_hack_ddl_preserves_schema_sync_guard_on_empty_data_rollback(self):
        self.assert_guard_survives('CREATE TABLE `hack_problem` (...)')

    def test_two_factor_ddl_preserves_schema_sync_guard_on_empty_data_rollback(self):
        self.assert_guard_survives('CREATE TABLE `user_passkey` (...)')

    def test_self_eval_ddl_preserves_schema_sync_guard_on_empty_data_rollback(self):
        self.assert_guard_survives('CREATE TABLE `self_eval_quota` (...)')

    def test_contest_ddl_preserves_schema_sync_guard_on_empty_data_rollback(self):
        self.assert_guard_survives('ALTER TABLE `contest` ADD `ruleOptions` json NULL')

    def test_permission_enum_ddl_preserves_schema_sync_guard_on_empty_data_rollback(self):
        self.assert_guard_survives('ALTER TABLE `user_privilege` CHANGE `privilegeType` `privilegeType` enum(...)')


if __name__ == '__main__':
    unittest.main(verbosity=2)
