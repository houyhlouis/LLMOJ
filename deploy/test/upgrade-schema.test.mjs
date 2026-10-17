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
