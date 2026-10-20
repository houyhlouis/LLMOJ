#!/usr/bin/env python3
"""Targeted upgrade orchestration regression. Root-owned temporary fixtures, no real services or database."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('upgrade_fixtures', HERE/'upgrade.test.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
u = fixtures.u


class CommunityHost(fixtures.FakeHost):
    def __init__(self, *args):
        super().__init__(*args)
        self.feature_tables = set()
        self.feature_columns = {('submission', 'status'), ('discussion', 'type')}
        self.feature_rows = {'team': 0, 'submission': 0, 'discussion': 0}
        self.saved_std_rows = 0
        self.saved_std_io_rows = 0
        self.saved_hack_io_rows = 0
        self.storage_quota_rows = 0
        self.large_file_rows = 0
        self.active_feature_rows = {}
        self.active_judge_jobs = 0
        self.sql_queries = []

    def run(self, args, **kwargs):
        args = list(map(str, args))
        query = kwargs.get('input', b'')
        if args[0] == 'mariadb' and isinstance(query, bytes):
            query = query.decode()
            self.sql_queries.append(query)
            table = re.search(r"TABLE_NAME='(team|file|team_file_upload|submission|discussion|hack|hack_problem|self_eval|self_eval_set|self_eval_quota|user_two_factor|user_passkey|judge_job)'", query)
            output = None
            if table and 'information_schema.TABLES' in query:
                output = int(table[1] in self.feature_tables)
            elif table and 'information_schema.COLUMNS' in query:
                column = re.search(r"COLUMN_NAME='([^']+)'", query)
                output = int((table[1], column[1]) in self.feature_columns)
            elif query.startswith('SELECT COUNT(*) FROM `team` WHERE'):
                output = self.storage_quota_rows if 'quotaLimit=10737418240' in query else self.feature_rows['team']
            elif query.startswith('SELECT COUNT(*) FROM `file` WHERE size>'):
                output = self.large_file_rows
            elif "FROM `submission` WHERE status='Fake'" in query:
                output = self.feature_rows['submission']
            elif "FROM `discussion` WHERE type='Solution'" in query:
                output = self.feature_rows['discussion']
            elif query.startswith("SELECT COUNT(*) FROM `judge_job` WHERE state IN ('Queued','Leased')"):
                output = self.active_judge_jobs
            elif query.startswith('SELECT COUNT(*) FROM `user_two_factor` WHERE totpSecret IS NOT NULL'):
                output = self.feature_rows.get('user_two_factor', 0)
            elif query.startswith('SELECT COUNT(*) FROM `user_passkey` WHERE 1=1'):
                output = self.feature_rows.get('user_passkey', 0)
            else:
                counted = re.match(r'SELECT COUNT\(\*\) FROM `(hack|hack_problem|team_file_upload|self_eval|self_eval_set|self_eval_quota)` WHERE', query)
                if counted:
                    if "status IN ('Pending','Running')" in query:
                        output = self.active_feature_rows.get(counted[1], 0)
                    else:
                        if 'JSON_CONTAINS_PATH(standardContent' in query:
                            output = self.saved_std_io_rows
                        elif 'JSON_CONTAINS_PATH(snapshot' in query:
                            output = self.saved_hack_io_rows
                        else:
                            output = self.saved_std_rows if 'standardContent IS NOT NULL' in query else self.feature_rows.get(counted[1], 0)
            if output is not None:
                self.calls.append(tuple(args))
                return subprocess.CompletedProcess(args, 0, str(output).encode(), b'')
        return super().run(args, **kwargs)


@unittest.skipUnless(os.geteuid() == 0, 'Run with sudo; checks use root-owned temporary fixtures')
class CommunityUpgradeTests(unittest.TestCase):
    def setUp(self):
        fixtures.UpgradeTests.setUp(self)
        self.host = CommunityHost(self.root, self.units)
        self.up = fixtures.FixtureUpgrade(self.root, self.host, self.units)
        # These tiny fixtures test orchestration, not the live machine's disk budget.
        usage = shutil.disk_usage(self.base)
        budget = patch.object(u.shutil, 'disk_usage', return_value=type(usage)(20*u.GIB, 2*u.GIB, 18*u.GIB))
        budget.start()
        self.addCleanup(budget.stop)

    def tearDown(self):
        fixtures.UpgradeTests.tearDown(self)

    def prepare(self):
        fixtures.UpgradeTests.prepare(self)

    def protocol_fixture(self):
        new = (HERE.parents[1]/'packages/judge-protocol/src/index.ts').read_text()
        new = new.replace('  Fake = "Fake",\n  Hacked = "Hacked"\n}', '  Fake = "Fake"\n}')
        old = new.replace('  JudgementFailed = "JudgementFailed",\n  Fake = "Fake"\n}', '  JudgementFailed = "JudgementFailed"\n}')
        self.assertNotEqual(old, new)
        relative = Path('packages/judge-protocol/src/index.ts')
        for root in (self.root, self.source):
            target = root/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(old)
        self.up.preflight()
        return relative, old, new

    def test_protocol_append_only_fake_is_accepted_and_keeps_raw_provenance_digest(self):
        relative, old, new = self.protocol_fixture()
        (self.source/relative).write_text(new)
        result = self.up.compatibility(self.source)
        self.assertEqual(result[str(relative)], u.digest(self.source/relative))
        self.assertNotEqual(result[str(relative)], u.digest(self.root/relative))
        self.assertEqual((self.root/relative).read_text(), old)

    def test_protocol_existing_verdict_task_payload_or_fake_position_changes_are_rejected(self):
        relative, old, new = self.protocol_fixture()
        candidates = [
            new.replace('Pending = "Pending"', 'Pending = "ChangedPending"'),
            new.replace('taskId: string;', 'taskId: number;', 1),
            new.replace('  Fake = "Fake"\n}', '  Fake = "Fake",\n  AnotherStatus = "AnotherStatus"\n}'),
            old.replace('  Canceled = "Canceled",', '  Canceled = "Canceled",\n  Fake = "Fake",'),
            old.replace('  WrongAnswer = "WrongAnswer",\n  Accepted = "Accepted",', '  Accepted = "Accepted",\n  WrongAnswer = "WrongAnswer",')
        ]
        for candidate in candidates:
            with self.subTest(candidate=candidate[:60]):
                (self.source/relative).write_text(candidate)
                with self.assertRaisesRegex(u.UpgradeError, 'frozen runtime contract'):
                    self.up.compatibility(self.source)

    def test_a_preexisting_fake_verdict_cannot_be_removed_through_the_append_exception(self):
        relative, old, new = self.protocol_fixture()
        (self.root/relative).write_text(new)
        (self.source/relative).write_text(old)
        with self.assertRaisesRegex(u.UpgradeError, 'frozen runtime contract|protocol|Fake'):
            self.up.compatibility(self.source)

    def test_real_build_rebuilds_protocol_before_backend_and_frontend(self):
        self.prepare()
        manifest = {'files': [{'path': '/index.html', 'sha256': u.digest(self.up.stage/'public/index.html')}]}
        (self.up.stage/'public/offline-manifest.json').write_text(json.dumps(manifest))
        start = len(self.host.calls)
        u.Upgrade.build(self.up)
        commands = [call for call in self.host.calls[start:] if '--filter' in call]
        self.assertEqual([call[call.index('--filter')+1] for call in commands], ['@libreoj/judge-protocol', '@libreoj/judge', '@libreoj/backend', '@libreoj/frontend'])
        self.assertEqual(stat.S_IMODE((self.up.backup/'build.log').stat().st_mode), 0o600)
        self.assertFalse(any('install' in call for call in commands))

    def test_restored_clone_records_solution_plan_and_requires_a_stable_second_audit(self):
        self.prepare()
        initial = {'compatible': True, 'queries': ['ALTER TABLE `discussion` ADD `type` varchar(16)'], 'migration': {}, 'solutions': {'pending': 2, 'schemaPending': True}}
        stable = {'compatible': True, 'queries': [], 'migration': {}, 'solutions': {'pending': 0, 'schemaPending': False}}
        self.up.schema = Mock(side_effect=[initial, stable, stable])
        self.up.schema_on_clone(self.up.backup/'preflight.sql')
        self.assertEqual(self.up.manifest['solutionMigration'], initial['solutions'])
        self.assertEqual(self.up.manifest['schemaQueries'], initial['queries'])
        calls = self.up.schema.call_args_list
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1].args[1], 'apply')
        self.assertTrue(all(call.args[0].startswith('libreoj_upgrade_') for call in calls))
        self.assertTrue(self.host.sql_queries[-1].startswith('DROP DATABASE `libreoj_upgrade_'))

    def test_clone_solution_pending_or_schema_pending_each_refuses_even_without_ddl_queries(self):
        self.prepare()
        for remaining in ({'pending': 1, 'schemaPending': False}, {'pending': 0, 'schemaPending': True}):
            with self.subTest(remaining=remaining):
                audit = {'compatible': True, 'queries': [], 'migration': {}, 'solutions': remaining}
                self.up.schema = Mock(side_effect=[audit, audit, audit])
                with self.assertRaisesRegex(u.UpgradeError, 'not stable'):
                    self.up.schema_on_clone(self.up.backup/'preflight.sql')
                self.assertTrue(self.host.sql_queries[-1].startswith('DROP DATABASE `libreoj_upgrade_'))

    def assert_changed_live_solution_report_is_refused(self, changed):
        self.prepare()
        expected = {'pending': 2, 'schemaPending': False, 'fingerprint': 'verified-original'}
        def freeze(_dump):
            self.up.manifest.update(schemaQueries=[], registrationMigration={}, solutionMigration=copy.deepcopy(expected))
        self.up.schema_on_clone = freeze
        actual = {'compatible': True, 'queries': [], 'migration': {}, 'solutions': {**expected, **changed}}
        self.up.schema = Mock(return_value=actual)
        with self.assertRaisesRegex(u.UpgradeError, 'changed since'):
            self.up.activate()
        self.assertEqual(self.up.schema.call_count, 1)
        self.assertEqual(self.up.schema.call_args.args, ('libreoj',))
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'old backend')
        self.assertFalse(self.host.states['libreoj-backend.service'])

    def test_final_live_solution_evidence_must_match_the_restored_clone_before_application(self):
        self.assert_changed_live_solution_report_is_refused({'fingerprint': 'changed-live-evidence'})

    def test_final_live_solution_pending_count_must_match_even_when_ddl_is_unchanged(self):
        self.assert_changed_live_solution_report_is_refused({'pending': 3})

    def test_final_live_solution_schema_pending_flag_must_match_even_when_ddl_is_unchanged(self):
        self.assert_changed_live_solution_report_is_refused({'schemaPending': True})

    def activate_fixture(self):
        self.prepare()
        self.up.activate()
        self.host.feature_tables.update(('team', 'submission', 'discussion'))
        self.assertEqual(self.host.pending_accounts, 0)
        self.assertEqual(self.host.pending_applications, 0)

    def candidate_capability(self, relative, content):
        """Describe the preserved prior release, leaving the new active code intact."""
        target = self.up.backup/'previous/apps'/relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def assert_manual_rollback_refused_without_service_changes(self, message):
        before = len(self.host.calls)
        states = self.host.states.copy()
        with self.assertRaisesRegex(u.UpgradeError, message):
            self.up.rollback(manual=True)
        self.assertFalse(any(call[0] == 'service' for call in self.host.calls[before:]))
        self.assertEqual(self.host.states, states)
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'new backend')
        self.assertTrue(self.up.guard.exists())

    def test_existing_teams_block_a_combined_backend_with_a_public_directory(self):
        self.activate_fixture()
        self.candidate_capability('backend/dist/team/team.service.js', 'first combined team backend')
        self.host.feature_rows['team'] = 1
        self.assert_manual_rollback_refused_without_service_changes('private teams require ID-based admission')
        self.assertEqual(self.host.feature_rows['team'], 1)

    def test_private_id_join_team_backend_can_restore_existing_team_data(self):
        self.activate_fixture()
        self.candidate_capability('backend/dist/team/team.service.js', 'private team backend joinPreview')
        self.host.feature_rows['team'] = 1
        self.up.manifest['communitySchemaApplied'] = True
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        self.assertEqual(self.host.feature_rows['team'], 1)
        self.assertEqual(self.up.guard.read_text(), u.GUARD)

    def test_10_gib_team_data_cannot_restore_the_old_single_file_cap(self):
        self.activate_fixture()
        self.candidate_capability('backend/dist/team/team.service.js', 'private team joinPreview')
        self.host.feature_columns.add(('team', 'quotaLimit'))
        self.host.storage_quota_rows = 1
        self.assert_manual_rollback_refused_without_service_changes('10 GiB team storage')

    def test_pending_upload_reservations_require_chunk_upload_support(self):
        self.activate_fixture()
        self.candidate_capability('backend/dist/team/team.service.js', 'private team joinPreview')
        self.host.feature_tables.add('team_file_upload')
        self.host.feature_rows['team_file_upload'] = 1
        self.assert_manual_rollback_refused_without_service_changes('upload reservations')

    def test_large_file_metadata_blocks_an_integer_only_prior_backend(self):
        self.activate_fixture()
        self.host.feature_tables.add('file')
        self.host.feature_columns.add(('file', 'size'))
        self.host.large_file_rows = 1
        self.candidate_capability('backend/dist/file/file.entity.js', 'integer size')
        self.assert_manual_rollback_refused_without_service_changes('bigint file metadata')

    def configure_prior_hack_fixture(self, content, saved_std_rows=0, std_column=True):
        self.activate_fixture()
        self.candidate_capability('backend/dist/hack/hack.service.js', content)
        self.candidate_capability('judge/src/task/hack/index.ts', 'matching prior Hack judge')
        self.host.feature_tables.add('hack_problem')
        if std_column:
            self.host.feature_columns.add(('hack_problem', 'standardContent'))
        self.host.feature_rows['hack_problem'] = 1
        self.host.saved_std_rows = saved_std_rows

    def test_saved_std_source_blocks_a_combined_backend_with_only_reference_ids(self):
        self.configure_prior_hack_fixture('first combined submission-reference backend', saved_std_rows=1)
        self.assert_manual_rollback_refused_without_service_changes('saved STD source requires code-based Hack references')
        self.assertEqual(self.host.saved_std_rows, 1)

    def test_code_based_reference_backend_can_restore_saved_std_without_discarding_it(self):
        self.configure_prior_hack_fixture('independent reference standardContent', saved_std_rows=1)
        self.up.manifest['communitySchemaApplied'] = True
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        self.assertEqual(self.host.saved_std_rows, 1)
        self.assertEqual(self.host.feature_rows['hack_problem'], 1)
        self.assertEqual(self.up.guard.read_text(), u.GUARD)

    def test_std_io_profiles_require_separate_reference_input_output_support(self):
        self.configure_prior_hack_fixture('independent reference standardContent', saved_std_rows=1)
        self.host.saved_std_io_rows = 1
        self.assert_manual_rollback_refused_without_service_changes('saved STD input/output settings')
        self.assertEqual(self.host.saved_std_io_rows, 1)

    def test_std_io_capable_backend_preserves_explicit_stdin_and_named_profiles(self):
        self.configure_prior_hack_fixture('standardContent referenceFileIo', saved_std_rows=2)
        self.candidate_capability('judge/src/task/hack/index.ts', 'referenceFileIo matching prior Hack judge')
        self.host.saved_std_io_rows = 2
        self.up.manifest['communitySchemaApplied'] = True
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        self.assertEqual(self.host.saved_std_io_rows, 2)
        self.assertEqual(self.up.guard.read_text(), u.GUARD)

    def test_std_io_backend_without_matching_judge_is_not_a_supported_rollback(self):
        self.configure_prior_hack_fixture('standardContent referenceFileIo', saved_std_rows=1)
        self.host.saved_std_io_rows = 1
        self.assert_manual_rollback_refused_without_service_changes('saved STD input/output settings')

    def test_new_hack_io_snapshot_prevents_old_runtime_even_if_std_profile_is_legacy(self):
        self.configure_prior_hack_fixture('standardContent', saved_std_rows=1)
        self.host.feature_tables.add('hack')
        self.host.feature_columns.add(('hack', 'snapshot'))
        self.host.saved_hack_io_rows = 1
        self.assert_manual_rollback_refused_without_service_changes('saved STD input/output settings')
        self.assertEqual(self.host.saved_hack_io_rows, 1)

    def test_legacy_reference_configuration_without_saved_std_remains_rollback_compatible(self):
        self.configure_prior_hack_fixture('legacy submission-reference backend', std_column=False)
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        self.assertEqual(self.host.feature_rows['hack_problem'], 1)
        self.assertEqual(self.host.saved_std_rows, 0)
        self.assertNotIn(('hack_problem', 'standardContent'), self.host.feature_columns)

    def test_nullable_std_column_without_saved_sources_does_not_block_legacy_reference_code(self):
        self.configure_prior_hack_fixture('legacy submission-reference backend', std_column=True)
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        self.assertEqual(self.host.feature_rows['hack_problem'], 1)
        self.assertEqual(self.host.saved_std_rows, 0)

    def configure_prior_self_eval_fixture(self, content):
        self.activate_fixture()
        self.candidate_capability('backend/dist/self-eval/self-eval.service.js', content)
        self.candidate_capability('judge/src/task/self-eval/index.ts', 'matching prior Self Eval judge')
        self.host.feature_tables.update(('self_eval', 'self_eval_set', 'self_eval_quota'))

    def test_each_self_eval_record_kind_blocks_the_old_broad_scope_backend(self):
        self.configure_prior_self_eval_fixture('first combined ordinary and contest Self Eval backend')
        for table in ('self_eval', 'self_eval_set', 'self_eval_quota'):
            with self.subTest(table=table):
                self.host.feature_rows[table] = 1
                self.assert_manual_rollback_refused_without_service_changes('enabled-NOI-only access boundary')
                self.assertEqual(self.host.feature_rows[table], 1)
                self.host.feature_rows[table] = 0

    def test_noi_scope_backend_can_restore_pretests_results_and_quotas(self):
        self.configure_prior_self_eval_fixture('Self evaluation is available only in enabled NOI contests')
        for table in ('self_eval', 'self_eval_set', 'self_eval_quota'):
            self.host.feature_rows[table] = 1
        self.up.manifest['communitySchemaApplied'] = True
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        for table in ('self_eval', 'self_eval_set', 'self_eval_quota'):
            self.assertEqual(self.host.feature_rows[table], 1)
        self.assertEqual(self.up.guard.read_text(), u.GUARD)

    def test_empty_self_eval_tables_do_not_block_a_backend_with_legacy_scope(self):
        self.configure_prior_self_eval_fixture('first combined ordinary and contest Self Eval backend')
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        self.assertTrue(all(self.host.feature_rows.get(table, 0) == 0 for table in ('self_eval', 'self_eval_set', 'self_eval_quota')))

    def test_each_community_data_kind_prevents_old_backend_rollback_despite_approved_registration(self):
        self.activate_fixture()
        for table in ('team', 'submission', 'discussion'):
            with self.subTest(table=table):
                self.host.feature_rows[table] = 1
                before = len(self.host.calls)
                with self.assertRaisesRegex(u.UpgradeError, 'team, solution or Fake data'):
                    self.up.rollback(manual=True)
                self.assertFalse(any(call[0] == 'service' for call in self.host.calls[before:]))
                self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'new backend')
                self.assertTrue(self.up.guard.exists())
                self.host.feature_rows[table] = 0

    def test_a_backend_with_all_three_capabilities_may_rollback_without_discarding_feature_data(self):
        for marker in ('team/team.service.js', 'submission/dto/fake-submission-request.dto.js', 'discussion/discussion-type.enum.js'):
            target = self.root/'apps/backend/dist'/marker
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('supported feature capability joinPreview')
        self.activate_fixture()
        self.host.feature_rows.update(team=1, submission=1, discussion=1)
        self.up.manifest['communitySchemaApplied'] = True
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        self.assertEqual(self.host.feature_rows, {'team': 1, 'submission': 1, 'discussion': 1})
        self.assertEqual(self.up.guard.read_text(), u.GUARD)

    def test_rollback_rechecks_feature_data_created_between_precheck_and_backend_stop(self):
        self.activate_fixture()
        original = self.host.service
        def race(action, unit):
            original(action, unit)
            if action == 'stop' and unit == 'libreoj-backend.service':
                self.host.feature_rows['team'] = 1
        self.host.service = race
        with self.assertRaisesRegex(u.UpgradeError, 'team, solution or Fake data'):
            self.up.rollback(manual=True)
        self.assertFalse(self.host.states['libreoj-backend.service'])
        self.assertFalse(self.host.states['libreoj-nginx.service'])
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'new backend')

    def test_automatic_rollback_keeps_new_code_stopped_when_fake_data_requires_it(self):
        self.activate_fixture()
        self.host.feature_rows['submission'] = 1
        with self.assertRaisesRegex(u.UpgradeError, 'team, solution or Fake data'):
            self.up.rollback()
        self.assertFalse(self.host.states['libreoj-backend.service'])
        self.assertFalse(self.host.states['libreoj-nginx.service'])
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'new backend')
        self.assertEqual(self.host.feature_rows['submission'], 1)
        self.assertTrue(self.up.guard.exists())

    def test_queued_or_running_durable_judge_jobs_must_drain_before_rollback(self):
        self.activate_fixture()
        self.host.feature_tables.add('judge_job')
        self.host.active_judge_jobs = 1
        before = len(self.host.calls)
        with self.assertRaisesRegex(u.UpgradeError, 'Active or queued judge work'):
            self.up.rollback(manual=True)
        self.assertFalse(any(call[0] == 'service' for call in self.host.calls[before:]))
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'new backend')
        self.host.active_judge_jobs = 0
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')

    def two_factor_fixture(self):
        self.activate_fixture()
        self.host.feature_tables.update(('user_two_factor', 'user_passkey'))
        self.host.feature_columns.add(('user_two_factor', 'totpSecret'))

    def test_two_factor_accounts_block_a_backend_without_second_factor_checks(self):
        self.two_factor_fixture()
        for table in ('user_two_factor', 'user_passkey'):
            with self.subTest(table=table):
                self.host.feature_rows[table] = 1
                self.assert_manual_rollback_refused_without_service_changes('two-factor sign-in')
                self.assertEqual(self.host.feature_rows[table], 1)
                self.host.feature_rows[table] = 0
        # Empty tables (or factors an administrator turned off) do not block it.
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')

    def test_a_two_factor_backend_may_restore_enrolled_accounts(self):
        self.two_factor_fixture()
        self.candidate_capability('backend/dist/auth/two-factor/two-factor.service.js', 'two-factor backend')
        self.host.feature_rows.update(user_two_factor=1, user_passkey=1)
        self.up.rollback(manual=True)
        self.assertEqual(self.up.manifest['status'], 'rolled-back')
        self.assertEqual((self.host.feature_rows['user_two_factor'], self.host.feature_rows['user_passkey']), (1, 1))

    def test_community_ddl_application_keeps_the_guard_when_empty_feature_data_allows_rollback(self):
        self.prepare()
        queries = ['ALTER TABLE `submission` MODIFY `status` enum(...)', 'CREATE TABLE `team_member` (...)']
        def freeze(_dump):
            self.up.manifest.update(schemaQueries=queries, registrationMigration={}, solutionMigration={'pending': 0, 'schemaPending': False})
        self.up.schema_on_clone = freeze
        self.up.schema = Mock(return_value={'compatible': True, 'queries': queries, 'migration': {}, 'solutions': {'pending': 0, 'schemaPending': False}})
        self.up.activate()
        self.assertTrue(self.up.manifest['communitySchemaApplied'])
        self.up.rollback(manual=True)
        self.assertEqual((self.root/'apps/backend/dist/main.js').read_text(), 'old backend')
        self.assertTrue(self.up.guard.exists())
        self.assertEqual(self.up.guard.read_text(), u.GUARD)
        self.assertIn('LIBREOJ_SCHEMA_SYNC=0', self.host.prop('libreoj-backend.service', 'Environment'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
