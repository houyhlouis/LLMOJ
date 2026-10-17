import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { auditSchema, applySchema, COMMUNITY_TABLES, LEGACY_SUBMISSION_STATUSES, LEGACY_PRIVILEGES, HACK_STANDARD_CONTENT_SQL,
  FILE_SIZE_BIGINT_SQL, TEAM_FILE_SIZE_BIGINT_SQL, TEAM_QUOTA_DEFAULT_SQL, TWO_FACTOR_SQL, TWO_FACTOR_TABLES, JUDGE_QUEUE_SQL, JUDGE_QUEUE_TABLES, JUDGE_CLIENT_DRAINING_SQL, DATA_VERSION_SQL, DATA_VERSION_TABLES, AI_BUDGET_SQL, AI_BUDGET_TABLES } from '../upgrade-schema.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/backend/package.json'));
const configPath = process.env.HYHOJ_COMMUNITY_SCHEMA_TEST_DB_CONFIG;

test('real metadata: mature legacy upgrade, new-schema no-op, preserved data, repeat and drift rejection',
  { skip: !configPath, timeout: 90000 }, async () => {
  require('reflect-metadata');
  const ts = require('typescript');
  require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
      experimentalDecorators: true, emitDecoratorMetadata: true }
  }).outputText, filename);
  const database = require('js-yaml').load(fs.readFileSync(configPath, 'utf8')).services.database;
  assert.ok(['llmoj_features_discussion', 'llmoj_features_team'].includes(database.database), 'Use only a dedicated disposable community test database');
  const { DataSource } = require('typeorm');
  const ds = new DataSource({ ...database, entities: [path.join(root, 'apps/backend/src/**/*.entity.ts')],
    synchronize: false, migrationsRun: false, logging: false });
  let owned = false;
  const enumSql = values => 'enum (' + values.map(value => "'" + value + "'").join(', ') + ')';
  try {
    await ds.initialize();
    const initial = await ds.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    assert.equal(initial.length, 0, 'Test database must be empty; existing tables are never deleted');
    owned = true;
    await assert.rejects(() => auditSchema(ds), /compatibility contract|schema change|table definition/i);
    // Creating the full schema is a test fixture setup only. The upgrader refuses empty databases.
    await ds.synchronize(false);
    const fresh = await auditSchema(ds);
    assert.deepEqual(fresh.queries, []); assert.deepEqual(fresh.solutions, { pending: 0, schemaPending: false });
    const noop = await applySchema(ds);
    assert.deepEqual(noop.queries, []); assert.equal(noop.solutions.classified, 0);
    for (const table of COMMUNITY_TABLES) await ds.query('DROP TABLE `' + table + '`');
    for (const table of [...TWO_FACTOR_TABLES].reverse()) await ds.query('DROP TABLE `' + table + '`');
    for (const table of JUDGE_QUEUE_TABLES) await ds.query('DROP TABLE `' + table + '`');
    await ds.query('ALTER TABLE `judge_client` DROP COLUMN `draining`');
    for (const table of DATA_VERSION_TABLES) await ds.query('DROP TABLE `' + table + '`');
    await ds.query('ALTER TABLE `submission` DROP COLUMN `problemDataVersionId`');
    for (const table of AI_BUDGET_TABLES) await ds.query('DROP TABLE `' + table + '`');
    await ds.query('ALTER TABLE `file` CHANGE `size` `size` int NOT NULL');
    await ds.query('ALTER TABLE `contest` DROP COLUMN `ruleOptions`');
    await ds.query('ALTER TABLE `contest` CHANGE `rule` `rule` varchar(8) NOT NULL');
    await ds.query('DROP INDEX `IDX_discussion_type` ON `discussion`');
    await ds.query('ALTER TABLE `discussion` DROP COLUMN `type`');
    await ds.query('ALTER TABLE `submission` CHANGE `status` `status` ' + enumSql(LEGACY_SUBMISSION_STATUSES) + ' NOT NULL');
    await ds.query('DROP TABLE `registration_application`');
    await ds.query('DROP TABLE `registration_review`');
    await ds.query('ALTER TABLE `user_privilege` CHANGE `privilegeType` `privilegeType` ' + enumSql(LEGACY_PRIVILEGES) + ' NOT NULL');
    await ds.query("INSERT INTO user (id,username,email,nickname,bio,avatarInfo,isAdmin,acceptedProblemCount,submissionCount,rating,publicEmail,registrationTime) VALUES (1,'schema_fixture','schema@example.invalid','','','gravatar:',0,1,1,0,0,'2026-10-10')");
    await ds.query("INSERT INTO problem (id,type,isPublic,ownerId,locales,submissionCount,acceptedSubmissionCount) VALUES (20,'Traditional',1,1,'[\"zh_CN\"]',1,1)");
    await ds.query("INSERT INTO discussion (id,title,publishTime,sortTime,replyCount,isPublic,publisherId,problemId) VALUES (101,'题解','2026-10-10','2026-10-10',0,1,1,20),(102,'AI proof','2026-10-10','2026-10-10',0,1,1,20)");
    await ds.query("INSERT INTO ai_job (id,ownerId,problemId,action,status,input,state) VALUES ('11111111-1111-4111-8111-111111111111',1,20,'tutorial','completed','{}',?)", [JSON.stringify({ discussionIds: { zh_CN: 102 } })]);
    await ds.query("INSERT INTO submission (id,isPublic,score,status,submitTime,problemId,submitterId) VALUES (501,1,100,'Accepted','2026-10-10',20,1)");
    for (const rule of ['noi','ioi','acm']) await ds.query(
      "INSERT INTO contest(title,subtitle,description,rule,startTime,endTime,ownerId,adminIds,isPublic,hideStatistics,languages,createdAt) VALUES (?,'','',?,'2026-10-10','2026-10-11',1,'[]',1,0,'[\"cpp:c++17\"]','2026-10-10')",['Preserved '+rule,rule]);
    const submissions = await ds.query('SELECT * FROM submission ORDER BY id');
    const accounts = await ds.query('SELECT * FROM user ORDER BY id');
    const contests = await ds.query('SELECT id,title,rule,startTime,endTime FROM contest ORDER BY id');
    let legacy;
    try { legacy = await auditSchema(ds); }
    catch (error) {
      console.error('Rejected legacy schema proposal:', (await ds.driver.createSchemaBuilder().log()).upQueries.map(query => query.query));
      throw error;
    }
    assert.equal(legacy.queries.length, 39);
    for (const sql of [...TWO_FACTOR_SQL, ...JUDGE_QUEUE_SQL, JUDGE_CLIENT_DRAINING_SQL, ...DATA_VERSION_SQL, ...AI_BUDGET_SQL]) assert(legacy.queries.includes(sql), sql);
    assert.deepEqual(legacy.solutions, { pending: 0, schemaPending: true });
    assert(!legacy.queries.some(query => /DROP|TRUNCATE/.test(query)));
    const applied = await applySchema(ds);
    assert.equal(applied.queries.length, 39);
    assert.equal(applied.solutions.classified, 1); assert.equal(applied.solutions.pending, 0);
    // Existing submissions have no data version
    assert.deepEqual(await ds.query('SELECT * FROM submission ORDER BY id'),
      submissions.map(submission => ({ ...submission, problemDataVersionId: null })));
    assert.deepEqual(await ds.query('SELECT * FROM user ORDER BY id'), accounts);
    assert.deepEqual(await ds.query('SELECT id,title,rule,startTime,endTime FROM contest ORDER BY id'), contests);
    assert.deepEqual((await ds.query('SELECT id,type FROM discussion ORDER BY id')).map(row => [row.id, row.type]), [[101, 'Discussion'], [102, 'Solution']]);
    const repeat = await applySchema(ds);
    assert.deepEqual(repeat.queries, []); assert.equal(repeat.solutions.classified, 0);
    assert.equal((await ds.driver.createSchemaBuilder().log()).upQueries.length, 0);
    // Upgrade the already-deployed reference-ID schema without changing its data.
    await ds.query('ALTER TABLE `hack_problem` DROP COLUMN `standardContent`');
    await ds.query("INSERT INTO hack_problem(problemId,referenceSubmissionId,validatorLanguage,validatorCode,configuredById,updateTime) VALUES (20,501,'cpp','int main(){return 0;}',1,'2026-10-10')");
    const referenceBefore = await ds.query('SELECT problemId,referenceSubmissionId,validatorLanguage,validatorCode,configuredById,updateTime FROM hack_problem');
    assert.deepEqual((await auditSchema(ds)).queries,[HACK_STANDARD_CONTENT_SQL]);
    assert.deepEqual((await applySchema(ds)).queries,[HACK_STANDARD_CONTENT_SQL]);
    assert.deepEqual(await ds.query('SELECT problemId,referenceSubmissionId,validatorLanguage,validatorCode,configuredById,updateTime FROM hack_problem'),referenceBefore);
    assert.equal((await ds.query('SELECT standardContent FROM hack_problem'))[0].standardContent,null);
    assert.deepEqual((await applySchema(ds)).queries,[]);
    // The deployed community schema retains files, membership and used bytes while
    // widening both size columns and updating every team's configured quota.
    await ds.query("INSERT INTO team(id,name,description,announcement,ownerId,permissionGroupId,memberCount,quotaLimit,quotaUsed,createdAt) VALUES (9,'storage fixture','private','notice',1,99,1,536870912,128,'2026-10-10')");
    await ds.query("INSERT INTO file(id,uuid,size,uploadTime) VALUES (900,'00000000-0000-4000-8000-000000000900',128,'2026-10-10')");
    await ds.query("INSERT INTO team_file(teamId,name,uuid,size,uploaderId,archived,createdAt) VALUES (9,'saved.bin','00000000-0000-4000-8000-000000000900',128,1,0,'2026-10-10')");
    await ds.query('DROP TABLE `team_file_upload`');
    await ds.query('ALTER TABLE `file` CHANGE `size` `size` int NOT NULL');
    await ds.query('ALTER TABLE `team_file` CHANGE `size` `size` int NOT NULL');
    await ds.query("ALTER TABLE `team` CHANGE `quotaLimit` `quotaLimit` bigint NOT NULL DEFAULT '536870912'");
    const storageBefore = await ds.query('SELECT id,name,description,announcement,ownerId,permissionGroupId,memberCount,quotaUsed,createdAt FROM team');
    const storedFileBefore = await ds.query('SELECT id,uuid,uploadTime FROM file');
    const storagePlan=await auditSchema(ds);
    assert.equal(storagePlan.queries.length,4);
    for(const sql of [FILE_SIZE_BIGINT_SQL,TEAM_FILE_SIZE_BIGINT_SQL,TEAM_QUOTA_DEFAULT_SQL])assert(storagePlan.queries.includes(sql));
    assert(storagePlan.queries.some(sql=>sql.startsWith('CREATE TABLE `team_file_upload`')));
    assert.deepEqual(storagePlan.teamStorage,{pending:1,schemaPending:false});
    const widened=await applySchema(ds);
    assert.equal(widened.teamStorage.migrated,1);
    assert.equal(Number((await ds.query('SELECT quotaLimit FROM team'))[0].quotaLimit),10737418240);
    assert.deepEqual(await ds.query('SELECT id,name,description,announcement,ownerId,permissionGroupId,memberCount,quotaUsed,createdAt FROM team'),storageBefore);
    assert.deepEqual(await ds.query('SELECT id,uuid,uploadTime FROM file'),storedFileBefore);
    assert.equal(Number((await ds.query('SELECT size FROM file'))[0].size),128);
    assert.equal(Number((await ds.query('SELECT size FROM team_file'))[0].size),128);
    assert.deepEqual((await applySchema(ds)).queries,[]);
    assert.deepEqual((await auditSchema(ds)).teamStorage,{pending:0,schemaPending:false});
    // A later release adding passkeys keeps every saved authenticator secret and recovery code.
    await ds.query("INSERT INTO user_two_factor(userId,totpSecret,totpEnabledAt,recoveryCodes,updatedAt) VALUES (1,'v1.a.b.c','2026-10-10','[\"hash\"]','2026-10-10')");
    const twoFactorBefore = await ds.query('SELECT * FROM user_two_factor');
    await ds.query('DROP TABLE `user_passkey`');
    assert.deepEqual((await auditSchema(ds)).queries, TWO_FACTOR_SQL.slice(2));
    assert.deepEqual((await applySchema(ds)).queries, TWO_FACTOR_SQL.slice(2));
    assert.deepEqual(await ds.query('SELECT * FROM user_two_factor'), twoFactorBefore);
    await ds.query('ALTER TABLE `user_passkey` ADD `futureField` int NULL');
    await assert.rejects(() => auditSchema(ds), /Unsupported schema change/);
    await ds.query('ALTER TABLE `user_passkey` DROP COLUMN `futureField`');
    assert.deepEqual((await auditSchema(ds)).queries, []);
    await ds.query('ALTER TABLE `submission` CHANGE `status` `status` ' + enumSql([...LEGACY_SUBMISSION_STATUSES, 'Fake', 'Hacked', 'FutureVerdict']) + ' NOT NULL');
    await assert.rejects(() => auditSchema(ds), /Unsupported existing submission status enum/);
    const unknown = (await ds.query("SELECT COLUMN_TYPE AS value FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='submission' AND COLUMN_NAME='status'"))[0].value;
    assert(unknown.includes('FutureVerdict'), 'Rejected audit must not rewrite the enum');
    await ds.query('ALTER TABLE `submission` CHANGE `status` `status` ' + enumSql([...LEGACY_SUBMISSION_STATUSES, 'Fake', 'Hacked']) + ' NULL');
    await assert.rejects(() => auditSchema(ds), /Unsupported existing submission status enum/);
    await ds.query('ALTER TABLE `submission` CHANGE `status` `status` ' + enumSql([...LEGACY_SUBMISSION_STATUSES, 'Fake', 'Hacked']) + ' NOT NULL');
    await ds.query('ALTER TABLE `discussion` CHANGE `type` `type` varchar(40) NOT NULL DEFAULT \'Discussion\'');
    await assert.rejects(() => auditSchema(ds), /compatibility contract|discussion type|Unsupported schema change/);
    await ds.query('ALTER TABLE `discussion` CHANGE `type` `type` varchar(20) NOT NULL DEFAULT \'Discussion\'');
    await ds.query('ALTER TABLE `team` ADD `futureField` int NULL');
    await assert.rejects(() => auditSchema(ds), /Unsupported schema change/);
    assert.equal(Number((await ds.query("SELECT COUNT(*) AS total FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='team' AND COLUMN_NAME='futureField'"))[0].total), 1);
  } finally {
    if (ds.isInitialized && owned) {
      const runner = ds.createQueryRunner();
      await runner.connect();
      try {
        await runner.query('SET FOREIGN_KEY_CHECKS=0');
        const tables = await runner.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
        for (const table of tables) await runner.query('DROP TABLE `' + table.name.replaceAll('`', '``') + '`');
      } finally { await runner.query('SET FOREIGN_KEY_CHECKS=1'); await runner.release(); }
    }
    if (ds.isInitialized) await ds.destroy();
  }
});
