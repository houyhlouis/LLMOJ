#!/usr/bin/env node
// Deliberately imports entity metadata only: no Nest application or background jobs.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { inspectLegacyRegistration, migrateLegacyRegistration, RegistrationMigrationError } from './upgrade-registration.mjs';

export class SchemaCompatibilityError extends Error {}

// Frozen v3 privilege order: the sole supported change appends one value. This
// list must not follow the target enum automatically, or removals could slip in.
export const LEGACY_PRIVILEGES = ["EditHomepage", "ManageUser", "ManageUserGroup", "ManageProblem", "ManageContest", "ManageDiscussion", "ViewSite", "ViewUsers", "EditOwnProfile", "ViewPrivateUserInfo", "CreateGroup", "ViewProblem", "ViewHiddenProblem", "CreateProblem", "EditOwnProblem", "EditAnyProblem", "DeleteOwnProblem", "DeleteAnyProblem", "ManageProblemPermissions", "ManageProblemVisibility", "ManageProblemTags", "ReadProblemData", "EditProblemData", "DownloadProblemAttachments", "SubmitProblem", "ViewSubmission", "ReadAnySubmissionCode", "ReadCodeAfterAccepted", "RejudgeSubmission", "DeleteSubmission", "ViewDiscussion", "CreateDiscussion", "EditOwnDiscussion", "EditAnyDiscussion", "DeleteOwnDiscussion", "DeleteAnyDiscussion", "ReplyDiscussion", "ReactDiscussion", "EditOwnReply", "ManageDiscussionReplies", "ViewContest", "ViewHiddenContest", "CreateContest", "EditContest", "ParticipateContest", "ViewContestScoreboard", "ViewHiddenContestScoreboard", "ExportContest", "ManageSummaries", "ManageStudyLists", "ManageAiConfiguration", "UseAi", "GenerateTestdata", "ImportProblem", "ManagePermissions", "SkipRecaptcha"];
export const REVIEW_PRIVILEGE = 'ManageRegistrationReviews';
const privilegeValues = [...LEGACY_PRIVILEGES, REVIEW_PRIVILEGE];
const enumType = values => "enum("+values.map(value => "'"+value+"'").join(',')+")";
export const PRIVILEGE_EXPANSION_SQL = 'ALTER TABLE `user_privilege` CHANGE `privilegeType` `privilegeType` enum ('+
  privilegeValues.map(value => "'"+value+"'").join(', ')+') NOT NULL';

export async function validatePrivilegeSchema(connection, queries) {
  const rows = await connection.query(`SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
    COLUMN_DEFAULT AS defaultValue, COLUMN_KEY AS columnKey, COLLATION_NAME AS collation,
    EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='user_privilege' AND COLUMN_NAME='privilegeType'`);
  const column = rows[0];
  if (rows.length !== 1 || !column || ![enumType(LEGACY_PRIVILEGES), enumType(privilegeValues)].includes(column.columnType) ||
      column.isNullable !== 'NO' || column.defaultValue !== null || column.columnKey !== 'PRI' ||
      column.collation !== 'utf8mb4_unicode_ci' || column.extra !== '' || column.comment !== '') {
    throw new SchemaCompatibilityError('Unsupported existing privilege enum');
  }
  const expansions = queries.filter(query => (typeof query === 'string' ? query : query.query) === PRIVILEGE_EXPANSION_SQL).length;
  if (expansions !== (column.columnType === enumType(LEGACY_PRIVILEGES) ? 1 : 0)) {
    throw new SchemaCompatibilityError('Privilege expansion does not match the existing schema');
  }
}

export function validateQueries(queries) {
  for (const query of queries) {
    const sql = typeof query === 'string' ? query : query.query;
    if (typeof sql !== 'string' || /;|--|\/\*|\b(DROP|TRUNCATE|INSERT|DELETE FROM|RENAME)\b/i.test(sql) || (query.parameters?.length)) {
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
    } else if (!foreign && !applicationForeign && sql !== PRIVILEGE_EXPANSION_SQL) {
      throw new SchemaCompatibilityError('Existing schema is outside this upgrader compatibility contract');
    }
  }
  return queries.map(q => typeof q === 'string' ? q : q.query);
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
    const queries = validateQueries((await ds.driver.createSchemaBuilder().log()).upQueries);
    await validatePrivilegeSchema(ds, queries);
    let migration = await inspectLegacyRegistration(ds);
    if (action === 'apply') {
      // SQL and the current privilege enum were checked before the first DDL statement.
      for (const query of queries) await ds.query(query);
      if ((await ds.driver.createSchemaBuilder().log()).upQueries.length) throw new SchemaCompatibilityError('Post-migration schema verification failed');
      migration = await migrateLegacyRegistration(ds);
      const remaining = await inspectLegacyRegistration(ds);
      if (remaining.pending || remaining.rejected || remaining.approvedHistory) throw new SchemaCompatibilityError('Legacy data migration did not finish');
    }
    process.stdout.write(JSON.stringify({ queries, migration, compatible: true }) + '\n');
  } finally { if (ds.isInitialized) await ds.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = error instanceof RegistrationMigrationError ? error.code : error instanceof SchemaCompatibilityError ? 'SCHEMA_CHANGE_UNSUPPORTED' : 'DATABASE_OPERATION_FAILED';
    process.stderr.write('UPGRADE_COMPATIBILITY: '+code+'\n');
    process.exitCode = 1;
  });
}
