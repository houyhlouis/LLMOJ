// The MariaDB case needs LLMOJ_SCHEMA_TEST_DB_CONFIG naming an empty, disposable database and a built backend.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { auditSchema } from '../upgrade-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'deploy/initialize-schema.mjs');
const configPath = process.env.LLMOJ_SCHEMA_TEST_DB_CONFIG;
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120000 });

test('invalid arguments and completed installations are refused without connecting', () => {
  for (const args of [[], ['--root'], ['--root', root], ['--root', root, '--config'], ['--root', root, '--other', 'x'],
    ['--root', root, '--root', root, '--config', 'x']]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'SCHEMA_INITIALIZATION: INVALID_ARGUMENTS\n');
  }
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoj-installed-'));
  try {
    fs.mkdirSync(path.join(installed, 'config'));
    fs.writeFileSync(path.join(installed, 'config/install-complete.json'), '{}');
    const result = run('--root', installed, '--config', path.join(installed, 'config/backend.yaml'));
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'SCHEMA_INITIALIZATION: INSTALLATION_ALREADY_COMPLETE\n');
  } finally { fs.rmSync(installed, { recursive: true, force: true }); }
});

test('a new database gets the complete current schema, and running again changes nothing',
  { skip: !configPath, timeout: 180000 }, async () => {
  assert.ok(fs.existsSync(path.join(root, 'apps/backend/dist')), 'Build the backend first');
  const require = createRequire(path.join(root, 'apps/backend/package.json'));
  require('reflect-metadata');
  const database = require('js-yaml').load(fs.readFileSync(configPath, 'utf8')).services.database;
  assert.equal(database.database, 'llmoj_test_schema', 'Use only the dedicated disposable schema test database');
  const { DataSource } = require('typeorm');
  const ds = new DataSource({ ...database, entities: [path.join(root, 'apps/backend/dist/**/*.entity.js')],
    synchronize: false, migrationsRun: false, logging: false });
  await ds.initialize();
  let owned = false;
  try {
    const tables = async () => (await ds.query('SHOW TABLES')).length;
    assert.equal(await tables(), 0, 'Test database must be empty; existing tables are never deleted');
    owned = true;
    const first = run('--root', root, '--config', configPath);
    assert.equal(first.status, 0, first.stderr);
    const created = await tables();
    assert.ok(created > 30);
    assert.deepEqual(JSON.parse(first.stdout), { initialized: true, tables: created });
    // The schema matches the entities exactly and needs no upgrade migration.
    assert.equal((await ds.driver.createSchemaBuilder().log()).upQueries.length, 0);
    assert.deepEqual((await auditSchema(ds)).queries, []);
    const second = run('--root', root, '--config', configPath);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await tables(), created);
  } finally {
    if (owned) {
      await ds.query('SET FOREIGN_KEY_CHECKS=0');
      for (const row of await ds.query('SHOW TABLES')) await ds.query('DROP TABLE `' + Object.values(row)[0] + '`');
      await ds.query('SET FOREIGN_KEY_CHECKS=1');
    }
    await ds.destroy();
  }
});
