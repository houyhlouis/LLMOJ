#!/usr/bin/env node
// Deliberately imports entity metadata only: no Nest application or background jobs.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inspectLegacyRegistration, migrateLegacyRegistration, RegistrationMigrationError } from './upgrade-registration.mjs';
import { inspectVerifiedSolutions, migrateVerifiedSolutions } from './community-solutions.mjs';
import { TEAM_STORAGE_SQL, validateTeamStorageSchema, normalizeTeamStorageQueries, inspectTeamStorage, migrateTeamStorage } from './team-storage.mjs';
import { TWO_FACTOR_SQL, validateTwoFactorSchema } from './two-factor-schema.mjs';
import { JUDGE_QUEUE_SQL, JUDGE_CLIENT_DRAINING_SQL, validateJudgeQueueSchema } from './judge-queue-schema.mjs';
import { DATA_VERSION_SQL, validateDataVersionSchema } from './data-version-schema.mjs';
import { AI_BUDGET_SQL, validateAiBudgetSchema } from './ai-budget-schema.mjs';
import { RUNTIME_IDENTITY_SQL, validateRuntimeIdentitySchema } from './runtime-identity-schema.mjs';
export { FILE_SIZE_BIGINT_SQL, TEAM_FILE_SIZE_BIGINT_SQL, TEAM_QUOTA_DEFAULT_SQL } from './team-storage.mjs';
export { TWO_FACTOR_SQL, TWO_FACTOR_TABLES } from './two-factor-schema.mjs';
export { JUDGE_QUEUE_SQL, JUDGE_QUEUE_TABLES, JUDGE_CLIENT_DRAINING_SQL } from './judge-queue-schema.mjs';
export { DATA_VERSION_SQL, DATA_VERSION_TABLES } from './data-version-schema.mjs';
export { AI_BUDGET_SQL, AI_BUDGET_TABLES } from './ai-budget-schema.mjs';
export { RUNTIME_IDENTITY_SQL, RUNTIME_IDENTITY_TABLES, RUNTIME_IDENTITY_COLUMNS } from './runtime-identity-schema.mjs';

export class SchemaCompatibilityError extends Error {}

// Frozen v3 privilege order: supported changes append known values. This
// list must not follow the target enum automatically, or removals could slip in.
export const LEGACY_PRIVILEGES = ["EditHomepage", "ManageUser", "ManageUserGroup", "ManageProblem", "ManageContest", "ManageDiscussion", "ViewSite", "ViewUsers", "EditOwnProfile", "ViewPrivateUserInfo", "CreateGroup", "ViewProblem", "ViewHiddenProblem", "CreateProblem", "EditOwnProblem", "EditAnyProblem", "DeleteOwnProblem", "DeleteAnyProblem", "ManageProblemPermissions", "ManageProblemVisibility", "ManageProblemTags", "ReadProblemData", "EditProblemData", "DownloadProblemAttachments", "SubmitProblem", "ViewSubmission", "ReadAnySubmissionCode", "ReadCodeAfterAccepted", "RejudgeSubmission", "DeleteSubmission", "ViewDiscussion", "CreateDiscussion", "EditOwnDiscussion", "EditAnyDiscussion", "DeleteOwnDiscussion", "DeleteAnyDiscussion", "ReplyDiscussion", "ReactDiscussion", "EditOwnReply", "ManageDiscussionReplies", "ViewContest", "ViewHiddenContest", "CreateContest", "EditContest", "ParticipateContest", "ViewContestScoreboard", "ViewHiddenContestScoreboard", "ExportContest", "ManageSummaries", "ManageStudyLists", "ManageAiConfiguration", "UseAi", "GenerateTestdata", "ImportProblem", "ManagePermissions", "SkipRecaptcha"];
export const REVIEW_PRIVILEGE = 'ManageRegistrationReviews';
export const EXTENSION_PRIVILEGES = Object.freeze(['ViewTeam','CreateTeam','ManageTeams','FakeSubmission','ViewHack','CreateHack','ManageHack','CreateSelfEval']);
export const CURRENT_PRIVILEGES = Object.freeze([...LEGACY_PRIVILEGES, REVIEW_PRIVILEGE, ...EXTENSION_PRIVILEGES]);
const privilegeValues = CURRENT_PRIVILEGES;
const enumType = values => "enum("+values.map(value => "'"+value+"'").join(',')+")";
// Frozen historical order. A later target enum may not silently widen this list.
export const LEGACY_SUBMISSION_STATUSES = [
  'Pending', 'ConfigurationError', 'SystemError', 'Canceled', 'CompilationError',
  'FileError', 'RuntimeError', 'TimeLimitExceeded', 'MemoryLimitExceeded',
  'OutputLimitExceeded', 'PartiallyCorrect', 'WrongAnswer', 'Accepted', 'JudgementFailed'
];
export const SUBMISSION_FAKE_EXPANSION_SQL = 'ALTER TABLE `submission` CHANGE `status` `status` enum (' +
  [...LEGACY_SUBMISSION_STATUSES, 'Fake', 'Hacked'].map(value => "'" + value + "'").join(', ') + ') NOT NULL';
export const CONTEST_RULE_EXPANSION_SQL = 'ALTER TABLE `contest` CHANGE `rule` `rule` varchar(16) NOT NULL';
export const CONTEST_RULE_OPTIONS_SQL = 'ALTER TABLE `contest` ADD `ruleOptions` longtext NULL';
export const HACK_STANDARD_CONTENT_SQL = 'ALTER TABLE `hack_problem` ADD `standardContent` longtext NULL';
export const DISCUSSION_TYPE_ADD_SQL = "ALTER TABLE `discussion` ADD `type` varchar(20) NOT NULL DEFAULT 'Discussion'";
export const DISCUSSION_TYPE_INDEX_SQL = "CREATE INDEX `IDX_discussion_type` ON `discussion` (`type`)";
export const COMMUNITY_TABLES = Object.freeze([
  'team', 'team_member', 'team_member_group', 'team_resource',
  'team_invitation', 'team_assignment', 'team_file', 'team_file_upload', 'hack', 'hack_problem',
  'self_eval_set', 'self_eval', 'self_eval_quota'
]);
const contracts = JSON.parse(fs.readFileSync(new URL('./community-schema-contract.json', import.meta.url), 'utf8'));
if (contracts.version !== 1 || !Array.isArray(contracts.tables) ||
    contracts.tables.length !== COMMUNITY_TABLES.length ||
    new Set(contracts.tables.map(table => table.name)).size !== COMMUNITY_TABLES.length ||
    contracts.tables.some(table => !COMMUNITY_TABLES.includes(table.name) ||
      typeof table.createSql !== 'string' || !table.createSql.startsWith('CREATE TABLE `' + table.name + '` ('))) {
  throw new SchemaCompatibilityError('Invalid frozen community schema contract');
}
const normalizeGeneratedIndexes = sql => sql.replace(/INDEX `IDX_[0-9a-f]+`/g, 'INDEX `IDX_GENERATED`');
const communityCreateSql = new Set(contracts.tables.map(table => normalizeGeneratedIndexes(table.createSql)));
const sqlOf = query => typeof query === 'string' ? query : query.query;
const countSql = (queries, sql) => queries.filter(query => sqlOf(query) === sql).length;
const defaultText = value => typeof value === 'string' && /^'[^']*'$/.test(value) ? value.slice(1, -1) : value;
// TypeORM redundantly rebuilds these unchanged composite indexes for enum
// expansion. Native MariaDB CHANGE preserves them, so never execute those DROP
// statements. Both the complete fixed SQL pairs and current index definitions
// must match before this no-op normalization is admitted.
export const SUBMISSION_ENUM_INDEXES = Object.freeze([
  { name: 'IDX_c118835938e59caeaaf07e94a0', columns: ['submitterId', 'status'] },
  { name: 'IDX_dabad4d6c14a960a04c5689ab5', columns: ['isPublic', 'status', 'codeLanguage'] },
  { name: 'IDX_e5d8ffe28e4e2297f1cf7d37b2', columns: ['isPublic', 'submitterId', 'status', 'codeLanguage'] },
  { name: 'IDX_b8c9400add938e8a99ba691ee6', columns: ['isPublic', 'problemId', 'status', 'codeLanguage'] },
  { name: 'IDX_f4523bac8a7a22b5b3330893c0', columns: ['isPublic', 'problemId', 'submitterId', 'status', 'codeLanguage'] }
]);
export async function normalizeCommunitySchemaQueries(connection, queries) {
  for (const query of queries) {
    if (query.parameters != null && (!Array.isArray(query.parameters) || query.parameters.length))
      throw new SchemaCompatibilityError('Unsupported schema parameters');
  }
  // TypeORM proposes DROP/ADD when widening varchar. Preserve all saved rules
  // with native CHANGE, only after validating the exact historical column and
  // every stored rule. Never accept arbitrary destructive column changes.
  const ruleDrop = 'ALTER TABLE `contest` DROP COLUMN `rule`';
  const ruleAdd = 'ALTER TABLE `contest` ADD `rule` varchar(16) NOT NULL';
  if (countSql(queries, ruleDrop) === 1 && countSql(queries, ruleAdd) === 1) {
    const normalized = queries.filter(query => sqlOf(query) !== ruleDrop && sqlOf(query) !== ruleAdd);
    normalized.push(CONTEST_RULE_EXPANSION_SQL);
    await validateContestSchema(connection, normalized);
    queries = normalized;
  }
  if (countSql(queries, SUBMISSION_FAKE_EXPANSION_SQL) !== 1) return queries;
  const pairs = SUBMISSION_ENUM_INDEXES.map(index => ({
    ...index,
    drop: 'DROP INDEX `' + index.name + '` ON `submission`',
    create: 'CREATE INDEX `' + index.name + '` ON `submission` (' +
      index.columns.map(column => '`' + column + '`').join(', ') + ')'
  }));
  if (!pairs.every(index => countSql(queries, index.drop) === 1 && countSql(queries, index.create) === 1))
    return queries;
  const rows = await connection.query(`SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
    SEQ_IN_INDEX AS sequence, COLUMN_NAME AS columnName, SUB_PART AS subPart, INDEX_TYPE AS indexType
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='submission'
    AND INDEX_NAME IN (${pairs.map(index => "'" + index.name + "'").join(', ')})
    ORDER BY INDEX_NAME, SEQ_IN_INDEX`);
  for (const index of pairs) {
    const actual = rows.filter(row => row.indexName === index.name);
    if (actual.length !== index.columns.length || actual.some((row, position) =>
        Number(row.nonUnique) !== 1 || Number(row.sequence) !== position + 1 ||
        row.columnName !== index.columns[position] || row.subPart !== null || row.indexType !== 'BTREE'))
      throw new SchemaCompatibilityError('Submission enum index normalization does not match the existing schema');
  }
  const redundant = new Set(pairs.flatMap(index => [index.drop, index.create]));
  return queries.filter(query => !redundant.has(sqlOf(query)));
}

export async function validateCommunitySchema(connection, queries) {
  const statusRows = await connection.query(`SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
    COLUMN_DEFAULT AS defaultValue, COLLATION_NAME AS collation, EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='submission' AND COLUMN_NAME='status'`);
  const status = statusRows[0];
  const oldStatus = enumType(LEGACY_SUBMISSION_STATUSES);
  const fakeStatus = enumType([...LEGACY_SUBMISSION_STATUSES, 'Fake']);
  const newStatus = enumType([...LEGACY_SUBMISSION_STATUSES, 'Fake', 'Hacked']);
  if (statusRows.length !== 1 || ![oldStatus, fakeStatus, newStatus].includes(status?.columnType) ||
      status.isNullable !== 'NO' || status.defaultValue !== null ||
      status.collation !== 'utf8mb4_unicode_ci' || status.extra !== '' || status.comment !== '') {
    throw new SchemaCompatibilityError('Unsupported existing submission status enum');
  }
  if (countSql(queries, SUBMISSION_FAKE_EXPANSION_SQL) !== (status.columnType !== newStatus ? 1 : 0)) {
    throw new SchemaCompatibilityError('Fake verdict expansion does not match the existing schema');
  }
  const typeRows = await connection.query(`SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
    COLUMN_DEFAULT AS defaultValue, COLLATION_NAME AS collation, EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='discussion' AND COLUMN_NAME='type'`);
  if (typeRows.length > 1 || (typeRows.length && (
      typeRows[0].columnType !== 'varchar(20)' || typeRows[0].isNullable !== 'NO' ||
      defaultText(typeRows[0].defaultValue) !== 'Discussion' ||
      typeRows[0].collation !== 'utf8mb4_unicode_ci' || typeRows[0].extra !== '' || typeRows[0].comment !== ''))) {
    throw new SchemaCompatibilityError('Unsupported existing discussion type column');
  }
  if (countSql(queries, DISCUSSION_TYPE_ADD_SQL) !== (typeRows.length ? 0 : 1)) {
    throw new SchemaCompatibilityError('Discussion type addition does not match the existing schema');
  }
  const indexes = await connection.query(`SELECT NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
    COLUMN_NAME AS columnName, SUB_PART AS subPart, INDEX_TYPE AS indexType
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='discussion' AND INDEX_NAME='IDX_discussion_type' ORDER BY SEQ_IN_INDEX`);
  if (indexes.length && (indexes.length !== 1 || Number(indexes[0].nonUnique) !== 1 ||
      Number(indexes[0].sequence) !== 1 || indexes[0].columnName !== 'type' ||
      indexes[0].subPart !== null || indexes[0].indexType !== 'BTREE')) {
    throw new SchemaCompatibilityError('Unsupported existing discussion type index');
  }
  if (countSql(queries, DISCUSSION_TYPE_INDEX_SQL) !== (indexes.length ? 0 : 1)) {
    throw new SchemaCompatibilityError('Discussion type index addition does not match the existing schema');
  }
}
export const PRIVILEGE_EXPANSION_SQL = 'ALTER TABLE `user_privilege` CHANGE `privilegeType` `privilegeType` enum ('+
  privilegeValues.map(value => "'"+value+"'").join(', ')+') NOT NULL';

export async function validatePrivilegeSchema(connection, queries) {
  const rows = await connection.query(`SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
    COLUMN_DEFAULT AS defaultValue, COLUMN_KEY AS columnKey, COLLATION_NAME AS collation,
    EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='user_privilege' AND COLUMN_NAME='privilegeType'`);
  const column = rows[0];
  if (rows.length !== 1 || !column || ![enumType(LEGACY_PRIVILEGES), enumType([...LEGACY_PRIVILEGES, REVIEW_PRIVILEGE]), enumType(privilegeValues)].includes(column.columnType) ||
      column.isNullable !== 'NO' || column.defaultValue !== null || column.columnKey !== 'PRI' ||
      column.collation !== 'utf8mb4_unicode_ci' || column.extra !== '' || column.comment !== '') {
    throw new SchemaCompatibilityError('Unsupported existing privilege enum');
  }
  const expansions = queries.filter(query => (typeof query === 'string' ? query : query.query) === PRIVILEGE_EXPANSION_SQL).length;
  if (expansions !== (column.columnType !== enumType(privilegeValues) ? 1 : 0)) {
    throw new SchemaCompatibilityError('Privilege expansion does not match the existing schema');
  }
}

export function validateQueries(queries) {
  for (const query of queries) {
    const sql = typeof query === 'string' ? query : query.query;
    if (typeof sql !== 'string' || /;|--|\/\*|\b(DROP|TRUNCATE|INSERT|DELETE FROM|RENAME)\b/i.test(sql) ||
        (query.parameters != null && (!Array.isArray(query.parameters) || query.parameters.length))) {
      throw new SchemaCompatibilityError('Unsupported schema change');
    }
    const create = /^CREATE TABLE `registration_review` \((.*)\) ENGINE=InnoDB$/i.exec(sql);
    const application = /^CREATE TABLE `registration_application` \((.*)\) ENGINE=InnoDB$/i.exec(sql);
    const applicationForeign = /^ALTER TABLE `registration_application` ADD CONSTRAINT `FK_[0-9a-f]+` FOREIGN KEY \(`userId`\) REFERENCES `user`\(`id`\) ON DELETE SET NULL ON UPDATE NO ACTION$/i.test(sql);
    const foreign = /^ALTER TABLE `registration_review` ADD CONSTRAINT `FK_[0-9a-f]+` FOREIGN KEY \(`userId`\) REFERENCES `user`\(`id`\) ON DELETE CASCADE ON UPDATE NO ACTION$/i.test(sql);
    if (create) {
      // Exact column contract, allowing only TypeORM-generated index names to vary.
      const body = create[1];
      const expected = "`userId` int NOT NULL, `status` enum ('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending', `createdAt` datetime NOT NULL, `reviewedAt` datetime NULL, `reviewedBy` int NULL, `reason` varchar(500) NULL, INDEX `INDEX` (`status`, `createdAt`), UNIQUE INDEX `REL` (`userId`), PRIMARY KEY (`userId`)";
      if (body.replace(/INDEX `IDX_[0-9a-f]+`/g, 'INDEX `INDEX`').replace(/UNIQUE INDEX `REL_[0-9a-f]+`/g, 'UNIQUE INDEX `REL`') !== expected) throw new SchemaCompatibilityError('Unexpected registration review table definition');
    } else if (application) {
      const expected = "`id` int NOT NULL AUTO_INCREMENT, `username` varchar(24) NOT NULL, `email` varchar(255) NOT NULL, `reservedUsername` varchar(24) NULL, `reservedEmail` varchar(255) NULL, `passwordHash` varchar(60) NULL, `legacyAccountAudit` longtext NULL, `status` enum ('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending', `createdAt` datetime NOT NULL, `reviewedAt` datetime NULL, `reviewedBy` int NULL, `reason` varchar(500) NULL, `userId` int NULL, UNIQUE INDEX `IDX` (`reservedUsername`), UNIQUE INDEX `IDX` (`reservedEmail`), INDEX `IDX` (`status`, `createdAt`), UNIQUE INDEX `REL` (`userId`), PRIMARY KEY (`id`)";
      const normalized = application[1].replace(/INDEX `IDX_[0-9a-f]+`/g, 'INDEX `IDX`').replace(/INDEX `REL_[0-9a-f]+`/g, 'INDEX `REL`');
      if (normalized !== expected) throw new SchemaCompatibilityError('Unexpected application table definition');
    } else if (!foreign && !applicationForeign && sql !== PRIVILEGE_EXPANSION_SQL &&
        sql !== SUBMISSION_FAKE_EXPANSION_SQL && sql !== CONTEST_RULE_EXPANSION_SQL && sql !== CONTEST_RULE_OPTIONS_SQL && sql !== HACK_STANDARD_CONTENT_SQL && sql !== DISCUSSION_TYPE_ADD_SQL &&
        sql !== DISCUSSION_TYPE_INDEX_SQL && !TEAM_STORAGE_SQL.includes(sql) && !TWO_FACTOR_SQL.includes(sql) && !JUDGE_QUEUE_SQL.includes(sql) && sql !== JUDGE_CLIENT_DRAINING_SQL &&
        !DATA_VERSION_SQL.includes(sql) && !AI_BUDGET_SQL.includes(sql) && !RUNTIME_IDENTITY_SQL.includes(sql) &&
        !communityCreateSql.has(normalizeGeneratedIndexes(sql))) {
      throw new SchemaCompatibilityError('Existing schema is outside this upgrader compatibility contract');
    }
  }
  return queries.map(q => typeof q === 'string' ? q : q.query);
}

export async function validateContestSchema(connection, queries) {
  const rows = await connection.query(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS columnType,
    IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS defaultValue, COLLATION_NAME AS collation,
    EXTRA AS extra, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='contest' AND COLUMN_NAME IN ('rule','ruleOptions')`);
  const rule = rows.find(column => column.name === 'rule');
  const options = rows.find(column => column.name === 'ruleOptions');
  if (!rule || !['varchar(8)','varchar(16)'].includes(rule.columnType) || rule.isNullable !== 'NO' ||
      rule.defaultValue !== null || rule.collation !== 'utf8mb4_unicode_ci' || rule.extra !== '' || rule.comment !== '' ||
      countSql(queries, CONTEST_RULE_EXPANSION_SQL) !== (rule.columnType === 'varchar(8)' ? 1 : 0))
    throw new SchemaCompatibilityError('Unsupported existing contest rule column');
  if (options && (!['longtext','json'].includes(options.columnType) || options.isNullable !== 'YES' ||
      ![null,'NULL'].includes(options.defaultValue) || options.extra !== '' || options.comment !== '' ||
      !['utf8mb4_bin','utf8mb4_unicode_ci',null].includes(options.collation)))
    throw new SchemaCompatibilityError('Unsupported existing contest rule options');
  if (countSql(queries, CONTEST_RULE_OPTIONS_SQL) !== (options ? 0 : 1))
    throw new SchemaCompatibilityError('Contest options addition does not match schema');
  const invalid = await connection.query("SELECT COUNT(*) AS count FROM contest WHERE rule NOT IN ('noi','ioi','acm','strictioi')");
  if (Number(invalid[0]?.count)) throw new SchemaCompatibilityError('Unsupported existing contest rule values');
}

export async function validateHackStandardSchema(connection, queries) {
  const tables = await connection.query("SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='hack_problem'");
  const exists = Number(tables[0]?.count);
  if (![0,1].includes(exists)) throw new SchemaCompatibilityError('Unsupported Hack reference table metadata');
  if (!exists) {
    if (countSql(queries, HACK_STANDARD_CONTENT_SQL)) throw new SchemaCompatibilityError('Hack reference addition requires the existing table');
    return;
  }
  const rows = await connection.query(`SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
    COLUMN_DEFAULT AS defaultValue, COLLATION_NAME AS collation, EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='hack_problem' AND COLUMN_NAME='standardContent'`);
  if (rows.length > 1 || (rows.length && (rows[0].columnType !== 'longtext' || rows[0].isNullable !== 'YES' ||
      ![null,'NULL'].includes(rows[0].defaultValue) || rows[0].collation !== 'utf8mb4_unicode_ci' ||
      rows[0].extra !== '' || rows[0].comment !== '')))
    throw new SchemaCompatibilityError('Unsupported existing Hack standard content column');
  if (countSql(queries, HACK_STANDARD_CONTENT_SQL) !== (rows.length ? 0 : 1))
    throw new SchemaCompatibilityError('Hack standard content addition does not match the existing schema');
}

export async function auditSchema(connection) {
  const proposed = (await connection.driver.createSchemaBuilder().log()).upQueries;
  const queries = validateQueries(await normalizeTeamStorageQueries(connection,
    await normalizeCommunitySchemaQueries(connection, proposed), SchemaCompatibilityError));
  await validatePrivilegeSchema(connection, queries);
  await validateCommunitySchema(connection, queries);
  await validateContestSchema(connection, queries);
  await validateHackStandardSchema(connection, queries);
  await validateTeamStorageSchema(connection, queries, SchemaCompatibilityError);
  await validateTwoFactorSchema(connection, queries, SchemaCompatibilityError);
  await validateJudgeQueueSchema(connection, queries, SchemaCompatibilityError);
  await validateDataVersionSchema(connection, queries, SchemaCompatibilityError);
  await validateAiBudgetSchema(connection, queries, SchemaCompatibilityError);
  await validateRuntimeIdentitySchema(connection, queries, SchemaCompatibilityError);
  const migration = await inspectLegacyRegistration(connection);
  const solutions = await inspectVerifiedSolutions(connection);
  const teamStorage = await inspectTeamStorage(connection);
  return { queries, migration, solutions, teamStorage, compatible: true };
}

export async function applySchema(connection) {
  // Validate all schema and legacy account data before the first DDL statement.
  const plan = await auditSchema(connection);
  for (const query of plan.queries) await connection.query(query);
  if ((await connection.driver.createSchemaBuilder().log()).upQueries.length)
    throw new SchemaCompatibilityError('Post-migration schema verification failed');
  await validatePrivilegeSchema(connection, []);
  await validateCommunitySchema(connection, []);
  await validateContestSchema(connection, []);
  await validateHackStandardSchema(connection, []);
  await validateTeamStorageSchema(connection, [], SchemaCompatibilityError);
  await validateTwoFactorSchema(connection, [], SchemaCompatibilityError);
  await validateJudgeQueueSchema(connection, [], SchemaCompatibilityError);
  await validateDataVersionSchema(connection, [], SchemaCompatibilityError);
  await validateAiBudgetSchema(connection, [], SchemaCompatibilityError);
  await validateRuntimeIdentitySchema(connection, [], SchemaCompatibilityError);
  const migration = await migrateLegacyRegistration(connection);
  const remaining = await inspectLegacyRegistration(connection);
  if (remaining.pending || remaining.rejected || remaining.approvedHistory)
    throw new SchemaCompatibilityError('Legacy data migration did not finish');
  const classified = await migrateVerifiedSolutions(connection);
  const solutions = { ...classified, ...await inspectVerifiedSolutions(connection) };
  if (solutions.schemaPending || solutions.pending)
    throw new SchemaCompatibilityError('Verified solution migration did not finish');
  const teamStorage = await migrateTeamStorage(connection);
  if ((await connection.driver.createSchemaBuilder().log()).upQueries.length)
    throw new SchemaCompatibilityError('Post-data-migration schema verification failed');
  return { queries: plan.queries, migration, solutions, teamStorage, compatible: true };
}

async function main() {
  const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[i * 2 + 2], process.argv[i * 2 + 3]]));
  const root = path.resolve(args['--root'] || '');
  const database = args['--database'];
  const action = args['--action'];
  if (!/^libreoj(?:_upgrade_[0-9a-f]{16})?$/.test(database || '') || !['audit', 'apply'].includes(action)) throw new SchemaCompatibilityError('Invalid schema helper arguments');
  const require = createRequire(path.join(root, 'apps/backend/package.json'));
  require('reflect-metadata');
  const { DataSource } = require('typeorm');
  const ds = new DataSource({ type: 'mariadb', username: 'root', database, extra: { socketPath: args['--socket'] },
    entities: [path.join(root, 'apps/backend/dist/**/*.entity.js')], synchronize: false, logging: false });
  try {
    await ds.initialize();
    const result = action === 'apply' ? await applySchema(ds) : await auditSchema(ds);
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { if (ds.isInitialized) await ds.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = error instanceof RegistrationMigrationError ? error.code : error instanceof SchemaCompatibilityError ? 'SCHEMA_CHANGE_UNSUPPORTED' : 'DATABASE_OPERATION_FAILED';
    process.stderr.write('UPGRADE_COMPATIBILITY: '+code+'\n');
    process.exitCode = 1;
  });
}
