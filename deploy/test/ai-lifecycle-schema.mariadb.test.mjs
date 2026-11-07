// Real TypeORM proposals, never the contract's own strings fed back as a fake schema builder.
// LLMOJ_SCHEMA_TEST_DB_CONFIG supplies credentials for the disposable 127.0.0.1:33079 server.
// LLMOJ_AI_LIFECYCLE_TEST_SCHEMA optionally supplies an external schema-only pre-Part-38 dump.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { auditSchema, applySchema } from '../upgrade-schema.mjs';
import { AI_LIFECYCLE_COLUMNS, AI_LIFECYCLE_SQL, validateAiLifecycleSchema } from '../ai-lifecycle-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/backend/package.json'));
const configPath = process.env.LLMOJ_SCHEMA_TEST_DB_CONFIG;
const schemaPath = process.env.LLMOJ_AI_LIFECYCLE_TEST_SCHEMA;

async function loadSchemaOnly(ds, filename) {
  const sql = fs.readFileSync(filename, 'utf8');
  assert.doesNotMatch(sql, /^\s*(INSERT|REPLACE|UPDATE|DELETE|LOAD DATA)\b/im, 'Only a structure-only fixture is accepted');
  // Import only table definitions into our new database; never execute the dump's DROP/USE/session commands.
  const tables = [...sql.matchAll(/^CREATE TABLE `([a-z][a-z0-9_]*)` \([\s\S]*?^\) ENGINE=InnoDB[^;]*;/gm)];
  assert.equal(tables.length, 65, 'The supplied pre-Part-38 fixture contains all 65 tables');
  assert.equal(new Set(tables.map(table => table[1])).size, 65);
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    await runner.query('SET FOREIGN_KEY_CHECKS=0');
    for (const table of tables) await runner.query(table[0]);
  } finally {
    await runner.query('SET FOREIGN_KEY_CHECKS=1');
    await runner.release();
  }
  return tables.map(table => table[1]);
}

for (const external of [false, true]) {
  test(`real TypeORM Part 38 audit/apply/no-op: ${external ? 'external 65-table schema-only fixture' : 'generated pre-Part-38 schema'}`, {
    skip: !configPath ? 'needs LLMOJ_SCHEMA_TEST_DB_CONFIG' : external && !schemaPath ? 'needs LLMOJ_AI_LIFECYCLE_TEST_SCHEMA' : false,
    timeout: 120000
  }, async t => {
    assert.ok(fs.existsSync(path.join(root, 'apps/backend/dist/ai/ai.entity.js')), 'Build the backend first');
    require('reflect-metadata');
    const { DataSource } = require('typeorm');
    const mysql = require('mysql2/promise');
    const config = require('js-yaml').load(fs.readFileSync(configPath, 'utf8')).services.database;
    assert.equal(config.host, '127.0.0.1', 'Use only the authorized disposable server');
    assert.equal(Number(config.port), 33079, 'Use only the authorized disposable server');
    const database = `libreoj_upgrade_${randomBytes(8).toString('hex')}`;
    assert.match(database, /^libreoj_upgrade_[0-9a-f]{16}$/);
    const control = await mysql.createConnection({ host: config.host, port: Number(config.port), user: config.username, password: config.password });
    const ds = new DataSource({ type: 'mariadb', host: config.host, port: Number(config.port),
      username: config.username, password: config.password, database, charset: 'utf8mb4',
      entities: [path.join(root, 'apps/backend/dist/**/*.entity.js')], synchronize: false, migrationsRun: false, logging: false });
    let owned = false;
    try {
      // A collision must fail without ever dropping or changing someone else's database.
      await control.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      owned = true;
      await ds.initialize();
      assert.equal((await ds.query('SHOW TABLES')).length, 0);
      assert.equal(AI_LIFECYCLE_COLUMNS.length, 18);
      assert.equal(AI_LIFECYCLE_SQL.length, 19);
      assert.equal(new Set(AI_LIFECYCLE_SQL).size, 19);
      let tables;
      if (external) {
        tables = await loadSchemaOnly(ds, schemaPath);
      } else {
        // A portable fixture for CI: retain all earlier entities, remove only the Part 38 additions.
        await ds.synchronize(false);
        assert.deepEqual((await ds.driver.createSchemaBuilder().log()).upQueries, []);
        await ds.query('DROP INDEX `IDX_ai_job_owner_status_created` ON `ai_job`');
        for (const [table, column] of AI_LIFECYCLE_COLUMNS)
          await ds.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        tables = (await ds.query('SHOW TABLES')).map(row => Object.values(row)[0]);
      }
      assert.equal((await ds.query('SHOW TABLES')).length, 65);
      for (const table of tables)
        assert.equal(Number((await ds.query(`SELECT COUNT(*) AS count FROM \`${table}\``))[0].count), 0, 'The fixture has no data');

      const proposed = (await ds.driver.createSchemaBuilder().log()).upQueries;
      assert.equal(proposed.length, 19);
      // Compare every SQL byte, including default quoting; only statement order is immaterial.
      assert.deepEqual(proposed.map(query => query.query).sort(), [...AI_LIFECYCLE_SQL].sort());
      assert(proposed.every(query => !query.parameters?.length));
      const audit = await auditSchema(ds);
      assert.equal(audit.compatible, true);
      assert.equal(audit.queries.length, 19);
      assert.deepEqual(audit.queries, proposed.map(query => query.query));
      await validateAiLifecycleSchema(ds, proposed);

      const applied = await applySchema(ds);
      assert.equal(applied.compatible, true);
      assert.deepEqual(applied.queries, audit.queries);
      const after = await auditSchema(ds);
      assert.equal(after.compatible, true);
      assert.deepEqual(after.queries, []);
      assert.deepEqual((await ds.driver.createSchemaBuilder().log()).upQueries, []);
      await validateAiLifecycleSchema(ds, []);
      assert.deepEqual((await applySchema(ds)).queries, []);

      // Correct DDL quoting must not relax the existing-column checks after installation.
      for (const [table, column, expected] of [
        ['ai_response_checkpoint', 'requestAttempts', 0], ['ai_job', 'revision', 1], ['ai_job', 'attempt', 0]
      ]) {
        await ds.query(`ALTER TABLE \`${table}\` ALTER COLUMN \`${column}\` SET DEFAULT '7'`);
        await assert.rejects(validateAiLifecycleSchema(ds, []), /Unsupported existing/);
        await assert.rejects(auditSchema(ds), /Unsupported|outside.*compatibility/);
        assert.equal(Number((await ds.query(`SELECT COLUMN_DEFAULT AS value FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`, [table, column]))[0].value), 7);
        await ds.query(`ALTER TABLE \`${table}\` ALTER COLUMN \`${column}\` SET DEFAULT '${expected}'`);
      }
      assert.deepEqual((await auditSchema(ds)).queries, []);
      t.diagnostic(`Verified ${tables.length} empty tables, all 18 additions and the index, then an empty re-audit`);
    } finally {
      try { if (ds.isInitialized) await ds.destroy(); }
      finally {
        try {
          if (owned) {
            await control.query(`DROP DATABASE \`${database}\``);
            const [rows] = await control.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [database]);
            assert.equal(rows.length, 0, 'Owned disposable database was removed');
          }
        } finally { await control.end(); }
      }
    }
  });
}
