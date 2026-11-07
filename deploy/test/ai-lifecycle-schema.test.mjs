import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_LIFECYCLE_COLUMNS, AI_LIFECYCLE_SQL, validateAiLifecycleSchema } from '../ai-lifecycle-schema.mjs';
import { AI_USAGE_IDENTITY_SQL, validateAiUsageIdentitySchema } from '../ai-usage-identity-schema.mjs';
import { validateQueries } from '../upgrade-schema.mjs';

const metadata = (present = false, corrupt = false) => ({ query: async sql => {
  if (sql.includes('information_schema.TABLES')) return [{ count: 1 }];
  if (sql.includes('information_schema.STATISTICS')) return present ? ['ownerId','status','createdAt','id'].map((name, i) => ({ name, position: i + 1, nonUnique: 1, subPart: null, indexType: 'BTREE' })) : [];
  const table = /TABLE_NAME='([^']+)'/.exec(sql)[1];
  return present ? AI_LIFECYCLE_COLUMNS.filter(([name]) => table === name).map(([, name, type, nullable, value]) => ({
    columnName: name, columnType: corrupt && name === 'generationId' ? 'varchar(10)' : type,
    isNullable: nullable ? 'YES' : 'NO', defaultValue: value, extra: '', comment: ''
  })) : [];
} });

test('all Part 38 changes are exact additive DDL and accept no removals or type substitutions', async () => {
  assert.deepEqual(validateQueries(AI_LIFECYCLE_SQL), AI_LIFECYCLE_SQL);
  await validateAiLifecycleSchema(metadata(), AI_LIFECYCLE_SQL);
  await validateAiLifecycleSchema(metadata(true), []);
  await assert.rejects(validateAiLifecycleSchema(metadata(), AI_LIFECYCLE_SQL.slice(1)), /addition/);
  await assert.rejects(validateAiLifecycleSchema(metadata(true, true), []), /Unsupported/);
  assert.throws(() => validateQueries(['ALTER TABLE `ai_job` DROP COLUMN `state`']), /Unsupported/);
});

test('purpose/generationId migration remains mandatory and old unlinked rows stay nullable', async () => {
  const db = { query: async sql => sql.includes('information_schema.TABLES') ? [{ count: 1 }] : [] };
  await validateAiUsageIdentitySchema(db, AI_USAGE_IDENTITY_SQL);
  await assert.rejects(validateAiUsageIdentitySchema(db, []), /does not match/);
  assert(AI_USAGE_IDENTITY_SQL.every(sql => sql.endsWith(' NULL')));
});

test('numeric defaults match the exact quoted MariaDB DDL, without accepting alternate SQL', () => {
  const numeric = [
    "ALTER TABLE `ai_response_checkpoint` ADD `requestAttempts` int NOT NULL DEFAULT '0'",
    "ALTER TABLE `ai_job` ADD `revision` int NOT NULL DEFAULT '1'",
    "ALTER TABLE `ai_job` ADD `attempt` int NOT NULL DEFAULT '0'"
  ];
  for (const sql of numeric) {
    assert(AI_LIFECYCLE_SQL.includes(sql));
    assert.throws(() => validateQueries([sql.replace(/DEFAULT '([01])'$/, 'DEFAULT $1')]), /compatibility contract/);
  }
});

const changedMetadata = change => ({ query: async sql => change(sql, await metadata(true).query(sql)) });

test('all 18 existing lifecycle columns still reject type, nullability, default, extra and comment drift', async () => {
  for (const [table, column] of AI_LIFECYCLE_COLUMNS) {
    const matching = (sql, row) => sql.includes('information_schema.COLUMNS') && sql.includes(`TABLE_NAME='${table}'`) && row.columnName === column;
    for (const change of [
      { columnType: 'varchar(1)' }, { isNullable: 'flip' }, { defaultValue: "'unexpected'" },
      { extra: 'auto_increment' }, { comment: 'unexpected' }
    ]) {
      const ds = changedMetadata((sql, rows) => rows.map(row => matching(sql, row) ? { ...row, ...change,
        ...('isNullable' in change ? { isNullable: row.isNullable === 'YES' ? 'NO' : 'YES' } : {}) } : row));
      await assert.rejects(validateAiLifecycleSchema(ds, []), /Unsupported existing/, `${table}.${column} ${Object.keys(change)[0]}`);
    }
    const duplicate = changedMetadata((sql, rows) => rows.flatMap(row => matching(sql, row) ? [row, { ...row }] : [row]));
    await assert.rejects(validateAiLifecycleSchema(duplicate, []), /Unsupported existing/);
  }
});

test('existing queue index still requires the exact columns, uniqueness, prefix and BTREE contract', async () => {
  for (const change of [{ name: 'other' }, { nonUnique: 0 }, { subPart: 1 }, { indexType: 'HASH' }]) {
    const ds = changedMetadata((sql, rows) => sql.includes('information_schema.STATISTICS')
      ? rows.map((row, i) => i === 1 ? { ...row, ...change } : row) : rows);
    await assert.rejects(validateAiLifecycleSchema(ds, []), /Unsupported existing ai_job queue index/);
  }
  for (const change of [rows => rows.slice(1), rows => [...rows, rows[0]]]) {
    const ds = changedMetadata((sql, rows) => sql.includes('information_schema.STATISTICS') ? change(rows) : rows);
    await assert.rejects(validateAiLifecycleSchema(ds, []), /Unsupported existing ai_job queue index/);
  }
});
