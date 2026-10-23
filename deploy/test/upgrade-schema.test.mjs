import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQueries, validatePrivilegeSchema, LEGACY_PRIVILEGES, REVIEW_PRIVILEGE, CURRENT_PRIVILEGES, PRIVILEGE_EXPANSION_SQL } from '../upgrade-schema.mjs';
const create = "CREATE TABLE `registration_review` (`userId` int NOT NULL, `status` enum ('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending', `createdAt` datetime NOT NULL, `reviewedAt` datetime NULL, `reviewedBy` int NULL, `reason` varchar(500) NULL, INDEX `IDX_a74ed8c7d42252b6ece8a0833c` (`status`, `createdAt`), UNIQUE INDEX `REL_9ae4f649115581773289397754` (`userId`), PRIMARY KEY (`userId`)) ENGINE=InnoDB";
const foreign = 'ALTER TABLE `registration_review` ADD CONSTRAINT `FK_9ae4f6491155817732893977546` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION';
test('exact new table and FK accepted; no-op accepted',()=>{assert.deepEqual(validateQueries([{query:create},{query:foreign}]),[create,foreign]);assert.deepEqual(validateQueries([]),[])});
for(const [name,sql] of Object.entries({drop:'DROP TABLE `user`', alter:'ALTER TABLE `user` ADD COLUMN `a` int', other:create.replaceAll('registration_review','another_table'), wrongColumn:create.replace('varchar(500)','varchar(1000)'), wrongStatus:create.replace("'rejected'","'active'"), wrongTarget:foreign.replace('`user`','`user_auth`'), removeGate:foreign.replace('CASCADE','SET NULL'), injection:create+'; DROP TABLE `user`', comments:create+' -- comment'})) {
 test('reject '+name,()=>assert.throws(()=>validateQueries([{query:sql}])));
}
test('parameterized or partially destructive batch rejected',()=>{assert.throws(()=>validateQueries([{query:create,parameters:['value']}]));assert.throws(()=>validateQueries([{query:create},{query:'DROP TABLE `user`'}]));});

const application = "CREATE TABLE `registration_application` (`id` int NOT NULL AUTO_INCREMENT, `username` varchar(24) NOT NULL, `email` varchar(255) NOT NULL, `reservedUsername` varchar(24) NULL, `reservedEmail` varchar(255) NULL, `passwordHash` varchar(60) NULL, `legacyAccountAudit` longtext NULL, `status` enum ('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending', `createdAt` datetime NOT NULL, `reviewedAt` datetime NULL, `reviewedBy` int NULL, `reason` varchar(500) NULL, `userId` int NULL, UNIQUE INDEX `IDX_f2fc8c69d04804ba9ae7c56105` (`reservedUsername`), UNIQUE INDEX `IDX_adc509d1634e2666f777efe841` (`reservedEmail`), INDEX `IDX_2659d12875dd85c716f4c10649` (`status`, `createdAt`), UNIQUE INDEX `REL_79bad6b8ec15830e8d666eaf05` (`userId`), PRIMARY KEY (`id`)) ENGINE=InnoDB";
const applicationForeign = "ALTER TABLE `registration_application` ADD CONSTRAINT `FK_79bad6b8ec15830e8d666eaf05d` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION";
test('exact independent application table and nullable user link accepted',()=>{assert.deepEqual(validateQueries([application,applicationForeign]),[application,applicationForeign]);});
for(const [name,sql] of Object.entries({requiredUser:application.replace('`userId` int NULL','`userId` int NOT NULL'),requiredPassword:application.replace('`passwordHash` varchar(60) NULL','`passwordHash` varchar(60) NOT NULL'),missingAuditArchive:application.replace('`legacyAccountAudit` longtext NULL, ',''),nonUniqueReservation:application.replace('UNIQUE INDEX `IDX_f2fc8c69d04804ba9ae7c56105`','INDEX `IDX_f2fc8c69d04804ba9ae7c56105`'),cascadeDeletion:applicationForeign.replace('SET NULL','CASCADE'),wrongApplicationTarget:applicationForeign.replace('`user`','`user_auth`')})) {
 test('reject application '+name,()=>assert.throws(()=>validateQueries([sql])));
}

const enumColumn = values => ({columnType:"enum("+values.map(x=>"'"+x+"'").join(',')+")",isNullable:'NO',defaultValue:null,columnKey:'PRI',collation:'utf8mb4_unicode_ci',extra:'',comment:''});
const fakeColumn = row => ({query:async()=>row ? [row] : []});
test('only exact append-only review privilege DDL is accepted',()=>assert.deepEqual(validateQueries([PRIVILEGE_EXPANSION_SQL]),[PRIVILEGE_EXPANSION_SQL]));
for (const [name,sql] of Object.entries({removedValue:PRIVILEGE_EXPANSION_SQL.replace("'ManageUser', ",''),renamedValue:PRIVILEGE_EXPANSION_SQL.replace("'ManageUser'","'ManagePeople'"),reordered:PRIVILEGE_EXPANSION_SQL.replace("'EditHomepage', 'ManageUser'","'ManageUser', 'EditHomepage'"),extraValue:PRIVILEGE_EXPANSION_SQL.replace("'ManageRegistrationReviews'","'ManageRegistrationReviews', 'Unexpected'"),nullable:PRIVILEGE_EXPANSION_SQL.replace('NOT NULL','NULL'),otherColumn:PRIVILEGE_EXPANSION_SQL.replaceAll('`privilegeType`','`other`')})) test('reject privilege '+name,()=>assert.throws(()=>validateQueries([sql])));
test('existing old privilege enum requires exactly one expansion; new enum requires none',async()=>{
 await validatePrivilegeSchema(fakeColumn(enumColumn(LEGACY_PRIVILEGES)),[PRIVILEGE_EXPANSION_SQL]);
 await validatePrivilegeSchema(fakeColumn(enumColumn([...LEGACY_PRIVILEGES,REVIEW_PRIVILEGE])),[PRIVILEGE_EXPANSION_SQL]);
 await validatePrivilegeSchema(fakeColumn(enumColumn(CURRENT_PRIVILEGES)),[]);
 await assert.rejects(()=>validatePrivilegeSchema(fakeColumn(enumColumn(LEGACY_PRIVILEGES)),[]));
 await assert.rejects(()=>validatePrivilegeSchema(fakeColumn(enumColumn(CURRENT_PRIVILEGES)),[PRIVILEGE_EXPANSION_SQL]));
 await assert.rejects(()=>validatePrivilegeSchema(fakeColumn(enumColumn(LEGACY_PRIVILEGES)),[PRIVILEGE_EXPANSION_SQL,PRIVILEGE_EXPANSION_SQL]));
});
test('unknown existing privilege values/order or custom column properties cannot be overwritten',async()=>{
 const old=enumColumn(LEGACY_PRIVILEGES);
 for (const column of [null,enumColumn([...LEGACY_PRIVILEGES,'CustomPrivilege']),enumColumn([...LEGACY_PRIVILEGES].reverse()),enumColumn(CURRENT_PRIVILEGES.slice(0,-1)),{...old,isNullable:'YES'},{...old,defaultValue:'ManageUser'},{...old,collation:'utf8mb4_bin'},{...old,columnKey:''},{...old,comment:'custom'}]) await assert.rejects(()=>validatePrivilegeSchema(fakeColumn(column),[PRIVILEGE_EXPANSION_SQL]));
});

test('exact two-factor tables and their user foreign keys accepted', async () => {
  const { TWO_FACTOR_SQL } = await import('../upgrade-schema.mjs');
  assert.deepEqual(validateQueries(TWO_FACTOR_SQL.map(query => ({ query }))), [...TWO_FACTOR_SQL]);
  const [settings, settingsForeign, passkey] = TWO_FACTOR_SQL;
  for (const sql of [settings.replace('`totpSecret` varchar(255) NULL', '`totpSecret` varchar(255) NOT NULL'),
    passkey.replace('UNIQUE INDEX `IDX_abafa7c255ab9f20d3398fbe5b`', 'INDEX `IDX_abafa7c255ab9f20d3398fbe5b`'),
    settingsForeign.replace('ON DELETE CASCADE', 'ON DELETE SET NULL'), settings.replaceAll('user_two_factor', 'user_other')])
    assert.throws(() => validateQueries([sql]));
});
test('two-factor tables are created with their foreign keys exactly when absent', async () => {
  const { validateTwoFactorSchema, TWO_FACTOR_SQL } = await import('../two-factor-schema.mjs');
  const existing = names => ({ query: async () => names.map(name => ({ name })) });
  await validateTwoFactorSchema(existing([]), TWO_FACTOR_SQL);
  await validateTwoFactorSchema(existing(['user_two_factor', 'user_passkey']), []);
  await validateTwoFactorSchema(existing(['user_two_factor']), TWO_FACTOR_SQL.slice(2));
  await assert.rejects(() => validateTwoFactorSchema(existing([]), []));
  await assert.rejects(() => validateTwoFactorSchema(existing([]), TWO_FACTOR_SQL.filter((_, index) => index !== 3)));
  await assert.rejects(() => validateTwoFactorSchema(existing(['user_passkey']), TWO_FACTOR_SQL));
  await assert.rejects(() => validateTwoFactorSchema(existing([]), [...TWO_FACTOR_SQL, TWO_FACTOR_SQL[0]]));
});

test('exact durable judge queue tables accepted; altered definitions refused', async () => {
  const { JUDGE_QUEUE_SQL } = await import('../upgrade-schema.mjs');
  assert.deepEqual(validateQueries(JUDGE_QUEUE_SQL.map(query => ({ query }))), [...JUDGE_QUEUE_SQL]);
  const [jobs, attempts] = JUDGE_QUEUE_SQL;
  for (const sql of [jobs.replace('`fence` int UNSIGNED NOT NULL', '`fence` int NOT NULL'),
    jobs.replace('PRIMARY KEY (`taskId`)', 'PRIMARY KEY (`type`)'),
    attempts.replace('UNIQUE INDEX `IDX_4a6ad01ae52602fbc78c82bba4`', 'INDEX `IDX_4a6ad01ae52602fbc78c82bba4`'),
    jobs.replaceAll('judge_job', 'judge_other')])
    assert.throws(() => validateQueries([sql]));
});
test('judge queue tables are created exactly when absent', async () => {
  const { validateJudgeQueueSchema, JUDGE_QUEUE_SQL } = await import('../judge-queue-schema.mjs');
  // An existing draining column, so only the tables are checked here
  const draining = { columnType: 'tinyint(4)', isNullable: 'NO', defaultValue: '0', extra: '', comment: '' };
  const existing = names => ({ query: async sql => sql.includes('information_schema.COLUMNS') ? [draining] : names.map(name => ({ name })) });
  await validateJudgeQueueSchema(existing([]), JUDGE_QUEUE_SQL);
  await validateJudgeQueueSchema(existing(['judge_job', 'judge_job_attempt']), []);
  await validateJudgeQueueSchema(existing(['judge_job']), JUDGE_QUEUE_SQL.slice(1));
  await assert.rejects(() => validateJudgeQueueSchema(existing([]), []));
  await assert.rejects(() => validateJudgeQueueSchema(existing(['judge_job']), JUDGE_QUEUE_SQL));
  await assert.rejects(() => validateJudgeQueueSchema(existing([]), [...JUDGE_QUEUE_SQL, JUDGE_QUEUE_SQL[0]]));
});

test('the judge client draining flag is added exactly once, and only when absent', async () => {
  const { validateJudgeQueueSchema, JUDGE_QUEUE_SQL, JUDGE_CLIENT_DRAINING_SQL } = await import('../judge-queue-schema.mjs');
  assert.deepEqual(validateQueries([JUDGE_CLIENT_DRAINING_SQL]), [JUDGE_CLIENT_DRAINING_SQL]);
  assert.throws(() => validateQueries([JUDGE_CLIENT_DRAINING_SQL.replace('DEFAULT 0', 'DEFAULT 1')]));
  const tables = ['judge_job', 'judge_job_attempt'].map(name => ({ name }));
  const fixture = column => ({ query: async sql => sql.includes('information_schema.COLUMNS') ? (column ? [column] : []) : tables });
  const column = { columnType: 'tinyint(4)', isNullable: 'NO', defaultValue: '0', extra: '', comment: '' };
  await validateJudgeQueueSchema(fixture(null), [JUDGE_CLIENT_DRAINING_SQL]);
  await validateJudgeQueueSchema(fixture(column), []);
  await validateJudgeQueueSchema(fixture({ ...column, defaultValue: "'0'" }), []);
  await assert.rejects(() => validateJudgeQueueSchema(fixture(null), []));
  await assert.rejects(() => validateJudgeQueueSchema(fixture(column), [JUDGE_CLIENT_DRAINING_SQL]));
  for (const changed of [{ isNullable: 'YES' }, { defaultValue: '1' }, { columnType: 'int(11)' }])
    await assert.rejects(() => validateJudgeQueueSchema(fixture({ ...column, ...changed }), []), /Unsupported existing judge client/);
  assert.equal(JUDGE_QUEUE_SQL.length, 2);
});

test('reproducible judging tables and the submission data version column are added exactly once', async () => {
  const { validateDataVersionSchema, DATA_VERSION_SQL, DATA_VERSION_TABLES, SUBMISSION_DATA_VERSION_SQL,
    STATISTICS_OUTBOX_CREATE_SQL } = await import('../data-version-schema.mjs');
  assert.deepEqual(validateQueries([...DATA_VERSION_SQL]), [...DATA_VERSION_SQL]);
  assert.throws(() => validateQueries([STATISTICS_OUTBOX_CREATE_SQL.replace('`accepted` int', '`accepted` bigint')]));
  assert.throws(() => validateQueries([SUBMISSION_DATA_VERSION_SQL.replace('NULL', 'NOT NULL')]));
  const column = { columnType: 'int(11)', isNullable: 'YES', defaultValue: 'NULL', extra: '', comment: '' };
  const fixture = (tables, columnRow) => ({
    query: async sql => sql.includes('information_schema.COLUMNS') ? (columnRow ? [columnRow] : []) : tables.map(name => ({ name }))
  });
  await validateDataVersionSchema(fixture([], null), [...DATA_VERSION_SQL]);
  await validateDataVersionSchema(fixture(DATA_VERSION_TABLES, column), []);
  await validateDataVersionSchema(fixture(DATA_VERSION_TABLES, { ...column, defaultValue: null }), []);
  // Partially applied: each remaining statement exactly once
  const remaining = DATA_VERSION_SQL.filter(sql => !sql.includes('`problem_data_version`') && sql !== SUBMISSION_DATA_VERSION_SQL);
  await validateDataVersionSchema(fixture(['problem_data_version'], column), remaining);
  await assert.rejects(() => validateDataVersionSchema(fixture([], null), DATA_VERSION_SQL.slice(1)));
  await assert.rejects(() => validateDataVersionSchema(fixture(DATA_VERSION_TABLES, column), [SUBMISSION_DATA_VERSION_SQL]));
  await assert.rejects(() => validateDataVersionSchema(fixture(DATA_VERSION_TABLES, null), []));
  for (const changed of [{ isNullable: 'NO' }, { defaultValue: '0' }, { columnType: 'bigint(20)' }, { extra: 'auto_increment' }])
    await assert.rejects(() => validateDataVersionSchema(fixture(DATA_VERSION_TABLES, { ...column, ...changed }), []),
      /Unsupported existing submission data version/);
  assert.equal(DATA_VERSION_SQL.length, 7);
});

test('the AI budget reservation table is added exactly once', async () => {
  const { validateAiBudgetSchema, AI_BUDGET_SQL, AI_RESERVATION_CREATE_SQL } = await import('../ai-budget-schema.mjs');
  assert.deepEqual(validateQueries([...AI_BUDGET_SQL]), [...AI_BUDGET_SQL]);
  assert.throws(() => validateQueries([AI_RESERVATION_CREATE_SQL.replace('`tokens` bigint', '`tokens` int')]));
  assert.throws(() => validateQueries([AI_RESERVATION_CREATE_SQL.replace('`settledAt` datetime NULL', '`settledAt` datetime NOT NULL')]));
  const fixture = present => ({ query: async () => [{ count: present ? 1 : 0 }] });
  await validateAiBudgetSchema(fixture(false), [...AI_BUDGET_SQL]);
  await validateAiBudgetSchema(fixture(true), []);
  await assert.rejects(() => validateAiBudgetSchema(fixture(false), []), /AI budget table/);
  await assert.rejects(() => validateAiBudgetSchema(fixture(true), [...AI_BUDGET_SQL]), /AI budget table/);
  await assert.rejects(() => validateAiBudgetSchema(fixture(false), [...AI_BUDGET_SQL, ...AI_BUDGET_SQL]), /AI budget table/);
  assert.equal(AI_BUDGET_SQL.length, 1);
});

test('file content hashes and judge runtimes are added exactly once, and only when absent', async () => {
  const { validateRuntimeIdentitySchema, RUNTIME_IDENTITY_SQL, RUNTIME_IDENTITY_COLUMNS, JUDGE_RUNTIME_CREATE_SQL,
    FILE_SHA256_SQL, SUBMISSION_RUNTIME_SQL } = await import('../runtime-identity-schema.mjs');
  assert.deepEqual(validateQueries([...RUNTIME_IDENTITY_SQL]), [...RUNTIME_IDENTITY_SQL]);
  assert.throws(() => validateQueries([FILE_SHA256_SQL.replace('char(64)', 'varchar(64)')]));
  assert.throws(() => validateQueries([SUBMISSION_RUNTIME_SQL.replace('NULL', 'NOT NULL')]));
  assert.throws(() => validateQueries([JUDGE_RUNTIME_CREATE_SQL.replace('`judgeClientId` int NOT NULL', '`judgeClientId` int NULL')]));
  const column = (tableName, columnName) => ({ tableName, columnName, columnType: columnName === 'sha256' ? 'char(64)' : 'int(11)',
    isNullable: 'YES', defaultValue: 'NULL', extra: '', comment: '' });
  const present = RUNTIME_IDENTITY_COLUMNS.map(([table, name]) => column(table, name));
  const existing = ['file', 'judge_job_attempt', 'submission', 'submission_result_history'];
  const fixture = (table, columns, tables = existing) => ({
    query: async sql => (sql.includes('information_schema.TABLES')
      ? [...tables, ...(table ? ['judge_runtime'] : [])].map(name => ({ name })) : columns)
  });
  await validateRuntimeIdentitySchema(fixture(false, []), [...RUNTIME_IDENTITY_SQL]);
  await validateRuntimeIdentitySchema(fixture(true, present), []);
  await validateRuntimeIdentitySchema(fixture(true, present.map(row => ({ ...row, defaultValue: null }))), []);
  // Partially applied: each remaining statement exactly once
  await validateRuntimeIdentitySchema(fixture(true, present.slice(0, 2)), RUNTIME_IDENTITY_SQL.slice(3));
  await assert.rejects(() => validateRuntimeIdentitySchema(fixture(false, []), RUNTIME_IDENTITY_SQL.slice(1)), /Judge runtime table/);
  await assert.rejects(() => validateRuntimeIdentitySchema(fixture(true, present), [FILE_SHA256_SQL]), /file sha256/);
  await assert.rejects(() => validateRuntimeIdentitySchema(fixture(true, present.slice(1)), []), /file sha256/);
  await assert.rejects(() => validateRuntimeIdentitySchema(fixture(false, []), [...RUNTIME_IDENTITY_SQL, SUBMISSION_RUNTIME_SQL]),
    /submission judgeRuntimeId/);
  for (const changed of [{ isNullable: 'NO' }, { defaultValue: '0' }, { columnType: 'bigint(20)' }, { extra: 'auto_increment' }, { comment: 'x' }])
    await assert.rejects(() => validateRuntimeIdentitySchema(fixture(true, present.map((row, i) => i === 2 ? { ...row, ...changed } : row)), []),
      /Unsupported existing submission judgeRuntimeId/);
  await assert.rejects(() => validateRuntimeIdentitySchema(fixture(true, [{ ...present[0], columnType: 'char(40)' }, ...present.slice(1)]), []),
    /Unsupported existing file sha256/);
  // From a release before the judge queue and data versions: those tables are created with the column
  const created = RUNTIME_IDENTITY_SQL.filter(sql => !/`(judge_job_attempt|submission_result_history)`/.test(sql));
  await validateRuntimeIdentitySchema(fixture(false, [], ['file', 'submission']), created);
  await assert.rejects(() => validateRuntimeIdentitySchema(fixture(false, [], ['file', 'submission']), [...RUNTIME_IDENTITY_SQL]),
    /judge_job_attempt judgeRuntimeId/);
  const { JUDGE_JOB_ATTEMPT_CREATE_SQL } = await import('../judge-queue-schema.mjs');
  const { SUBMISSION_RESULT_HISTORY_CREATE_SQL } = await import('../data-version-schema.mjs');
  for (const sql of [JUDGE_JOB_ATTEMPT_CREATE_SQL, SUBMISSION_RESULT_HISTORY_CREATE_SQL]) assert.match(sql, /`judgeRuntimeId` int NULL/);
  assert.equal(RUNTIME_IDENTITY_SQL.length, 5);
});

test('sealed uploads add the file uploadUuid column and its unique index exactly once', async () => {
  const { validateSealedUploadSchema, SEALED_UPLOAD_SQL, FILE_UPLOAD_UUID_SQL, FILE_UPLOAD_UUID_INDEX_SQL,
    FILE_UPLOAD_UUID_INDEX } = await import('../sealed-upload-schema.mjs');
  assert.deepEqual(validateQueries([...SEALED_UPLOAD_SQL]), [...SEALED_UPLOAD_SQL]);
  assert.throws(() => validateQueries([FILE_UPLOAD_UUID_SQL.replace('NULL', 'NOT NULL')]));
  assert.throws(() => validateQueries([FILE_UPLOAD_UUID_INDEX_SQL.replace('UNIQUE INDEX', 'INDEX')]));
  const column = { columnType: 'char(36)', isNullable: 'YES', defaultValue: 'NULL', extra: '', comment: '' };
  const index = { name: FILE_UPLOAD_UUID_INDEX, nonUnique: 0, position: 1, columnName: 'uploadUuid' };
  const fixture = (columns, indexes) => ({
    query: async sql => (sql.includes('information_schema.COLUMNS') ? columns : indexes)
  });
  await validateSealedUploadSchema(fixture([], []), [...SEALED_UPLOAD_SQL]);
  await validateSealedUploadSchema(fixture([column], [index]), []);
  await validateSealedUploadSchema(fixture([{ ...column, defaultValue: null }], [index]), []);
  // Partially applied: the index alone remains
  await validateSealedUploadSchema(fixture([column], []), [FILE_UPLOAD_UUID_INDEX_SQL]);
  await assert.rejects(() => validateSealedUploadSchema(fixture([], []), [FILE_UPLOAD_UUID_SQL]), /uploadUuid index addition/);
  await assert.rejects(() => validateSealedUploadSchema(fixture([column], [index]), [FILE_UPLOAD_UUID_SQL]), /uploadUuid column addition/);
  await assert.rejects(() => validateSealedUploadSchema(fixture([], []), [...SEALED_UPLOAD_SQL, FILE_UPLOAD_UUID_SQL]), /column addition/);
  for (const changed of [{ isNullable: 'NO' }, { defaultValue: "''" }, { columnType: 'varchar(36)' }, { extra: 'x' }, { comment: 'x' }])
    await assert.rejects(() => validateSealedUploadSchema(fixture([{ ...column, ...changed }], [index]), []),
      /Unsupported existing file uploadUuid column/);
  for (const indexes of [[{ ...index, nonUnique: 1 }], [index, { ...index, position: 2, columnName: 'uuid' }],
    [{ ...index, name: 'IDX_other' }], [index, { ...index, name: 'IDX_other' }]])
    await assert.rejects(() => validateSealedUploadSchema(fixture([column], indexes), []), /Unsupported existing file uploadUuid index/);
  assert.equal(SEALED_UPLOAD_SQL.length, 2);
});

test('the AI execution table is added exactly once', async () => {
  const { validateAiExecutionSchema, AI_EXECUTION_SQL, AI_EXECUTION_CREATE_SQL } = await import('../ai-execution-schema.mjs');
  assert.deepEqual(validateQueries([...AI_EXECUTION_SQL]), [...AI_EXECUTION_SQL]);
  assert.throws(() => validateQueries([AI_EXECUTION_CREATE_SQL.replace('`jobId` varchar(36) NOT NULL', '`jobId` varchar(36) NULL')]));
  assert.throws(() => validateQueries([AI_EXECUTION_CREATE_SQL.replace(', PRIMARY KEY (`taskId`)', '')]));
  const fixture = present => ({ query: async () => [{ count: present ? 1 : 0 }] });
  await validateAiExecutionSchema(fixture(false), [...AI_EXECUTION_SQL]);
  await validateAiExecutionSchema(fixture(true), []);
  await assert.rejects(() => validateAiExecutionSchema(fixture(false), []), /AI execution table/);
  await assert.rejects(() => validateAiExecutionSchema(fixture(true), [...AI_EXECUTION_SQL]), /AI execution table/);
  assert.equal(AI_EXECUTION_SQL.length, 1);
});
