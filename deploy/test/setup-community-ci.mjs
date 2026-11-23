#!/usr/bin/env node
// Provision only the disposable GitHub Actions MariaDB service on port 3307.
// Each regression gets a distinct database and user. The schema user also owns the temporary upgrade namespace.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Each variable names the runner groups whose suites consume that configuration.
const fixtures = [
  ['team', 'llmoj_test_team', { LLMOJ_TEAM_TEST_DB_CONFIG: ['backend'] }],
  ['team_audit', 'llmoj_test_team_audit', { LLMOJ_TEAM_AUDIT_DB_CONFIG: ['backend'] }],
  ['fake', 'llmoj_test_fake', { LLMOJ_FAKE_TEST_DB_CONFIG: ['backend', 'deploy'] }],
  ['discussion', 'llmoj_features_discussion', {
    HYHOJ_DISCUSSION_TEST_DB_CONFIG: ['backend'],
    HYHOJ_COMMUNITY_SCHEMA_TEST_DB_CONFIG: ['deploy'],
    LLMOJ_SELF_EVAL_TEST_DB_CONFIG: ['backend']
  }],
  ['counts', 'llmoj_test_counts', { HYHOJ_COUNT_TEST_DB_CONFIG: ['backend'] }],
  ['problem', 'llmoj_test_problem', { HYHOJ_PROBLEM_TEST_DB_CONFIG: ['backend'] }],
  ['submission', 'llmoj_test_submission', { HYHOJ_SUBMISSION_TEST_DB_CONFIG: ['backend'] }],
  ['schema', 'llmoj_test_schema', { LLMOJ_SCHEMA_TEST_DB_CONFIG: ['deploy'] }],
  ['two_factor', 'llmoj_test_two_factor', { LLMOJ_TWO_FACTOR_TEST_DB_CONFIG: ['backend'] }],
  ['judge_queue', 'llmoj_test_judge_queue', { LLMOJ_JUDGE_QUEUE_TEST_DB_CONFIG: ['backend'] }],
  ['lock_lease', 'llmoj_test_lock_lease', { LLMOJ_LOCK_LEASE_TEST_DB_CONFIG: ['backend'] }],
  ['data_version', 'llmoj_test_data_version', { LLMOJ_DATA_VERSION_TEST_DB_CONFIG: ['backend'] }],
  ['ai', 'llmoj_test_ai', { HYHOJ_AI_TEST_DB_CONFIG: ['ai'] }],
  ['ai_budget', 'llmoj_test_ai_budget', { LLMOJ_AI_BUDGET_TEST_DB_CONFIG: ['ai'] }],
  ['access_matrix', 'llmoj_test_access_matrix', { LLMOJ_ACCESS_MATRIX_TEST_DB_CONFIG: ['backend'] }],
  ['operations', 'llmoj_test_operations', { LLMOJ_OPERATIONS_TEST_DB_CONFIG: ['ai', 'backend'] }],
  ['narrow_writes', 'llmoj_test_narrow_writes', { LLMOJ_NARROW_WRITES_TEST_DB_CONFIG: ['backend'] }],
  ['judge_info_cache', 'llmoj_test_judge_info_cache', { LLMOJ_JUDGE_INFO_CACHE_TEST_DB_CONFIG: ['backend'] }],
  ['statistics_cache', 'llmoj_test_statistics_cache', { LLMOJ_STATISTICS_CACHE_TEST_DB_CONFIG: ['backend'] }],
  ['contest_virtual', 'llmoj_test_contest_virtual', { LLMOJ_CONTEST_VIRTUAL_TEST_DB_CONFIG: ['backend'] }],
  ['contest_admission', 'llmoj_test_contest_admission', { LLMOJ_CONTEST_ADMISSION_TEST_DB_CONFIG: ['backend'] }],
  ['diagnostic_bundle', 'llmoj_test_diagnostic_bundle', { LLMOJ_DIAGNOSTIC_BUNDLE_TEST_DB_CONFIG: ['backend'] }]
];

export function requiredDatabaseConfigs(groups) {
  return fixtures.flatMap(([, , variables]) => Object.keys(variables)
    .filter(name => variables[name].some(group => groups.includes(group)))).sort();
}

async function main() {
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.LLMOJ_CI_DATABASE_SETUP !== '1' || !process.env.RUNNER_TEMP ||
      !process.env.GITHUB_ENV || !process.env.LLMOJ_CI_MARIADB_PASSWORD)
    throw new Error('Use only the explicit disposable GitHub Actions fixture');
  const require = createRequire(path.join(root, 'apps/backend/package.json'));
  const mysql = require('mysql2/promise');
  const temporary = fs.realpathSync(process.env.RUNNER_TEMP);
  const directory = fs.mkdtempSync(path.join(temporary, 'llmoj-community-db-'));
  fs.chmodSync(directory, 0o700);
  const connection = await mysql.createConnection({ host: '127.0.0.1', port: 3307,
    user: 'root', password: process.env.LLMOJ_CI_MARIADB_PASSWORD, connectTimeout: 10000 });
  const owned = [];
  let complete = false;
  try {
    // Refuse an already initialized fixture instead of deleting existing data.
    for (const [name, database] of fixtures) {
      const [databases] = await connection.execute(
        'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [database]);
      const [users] = await connection.execute('SELECT User FROM mysql.user WHERE User=?', ['qa_' + name]);
      if (databases.length || users.length) throw new Error('Test fixture must start empty');
    }
    const environment = [];
    for (const [name, database, variables] of fixtures) {
      const username = 'qa_' + name;
      const password = crypto.randomBytes(24).toString('hex');
      // All identifiers are fixed above; backslashes keep underscores literal in database grants.
      await connection.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      owned.push([database, username]);
      await connection.query('CREATE USER ?@\'%\' IDENTIFIED BY ?', [username, password]);
      await connection.query('GRANT ALL PRIVILEGES ON `' + database.replaceAll('_', '\\_') + '`.* TO ?@\'%\'', [username]);
      // The lifecycle regressions create/drop only collision-resistant libreoj_upgrade_<16 hex> databases.
      if (name === 'schema')
        await connection.query('GRANT ALL PRIVILEGES ON `libreoj\\_upgrade\\_%`.* TO ?@\'%\'', [username]);
      const config = path.join(directory, name + '.json');
      fs.writeFileSync(config, JSON.stringify({ services: { database: {
        type: 'mariadb', host: '127.0.0.1', port: 3307, database, username, password, charset: 'utf8mb4'
      } } }) + '\n', { mode: 0o600, flag: 'wx' });
      for (const variable of Object.keys(variables)) environment.push(variable + '=' + config);
    }
    // Verify the effective grants rather than trusting account-creation syntax.
    for (let index = 0; index < fixtures.length; index++) {
      const [name, database] = fixtures[index];
      const config = JSON.parse(fs.readFileSync(path.join(directory, name + '.json'), 'utf8'));
      const { username, password, host, port } = config.services.database;
      const limited = await mysql.createConnection({ host, port, user: username, password, database });
      try {
        await limited.query('SELECT 1');
        if (name === 'schema') {
          const upgradeDatabase = 'libreoj_upgrade_' + crypto.randomBytes(8).toString('hex');
          let created = false;
          try {
            await limited.query('CREATE DATABASE `' + upgradeDatabase + '`');
            created = true;
            await limited.query('CREATE TABLE `' + upgradeDatabase + '`.`probe` (`id` int)');
          } finally {
            if (created) {
              try { await limited.query('DROP DATABASE `' + upgradeDatabase + '`'); }
              finally { await connection.query('DROP DATABASE IF EXISTS `' + upgradeDatabase + '`'); }
            }
          }
        }
        const otherDatabase = fixtures[(index + 1) % fixtures.length][1];
        try {
          await limited.query('USE `' + otherDatabase + '`');
          throw new Error('A fixture account can access another regression database');
        } catch (error) {
          if (error.code !== 'ER_DBACCESS_DENIED_ERROR') throw error;
        }
      } finally { await limited.end(); }
    }
    fs.appendFileSync(process.env.GITHUB_ENV, environment.join('\n') + '\n');
    complete = true;
    process.stdout.write('Provisioned disposable regression databases and the isolated schema-upgrade namespace.\n');
  } finally {
    if (!complete) {
      for (const [database, username] of owned.reverse()) {
        await connection.query('DROP USER IF EXISTS ?@\'%\'', [username]);
        await connection.query('DROP DATABASE `' + database + '`');
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
    await connection.end();
  }
}

if (import.meta.main) main().catch(() => {
  // Driver errors and connection options can contain credentials.
  process.stderr.write('Disposable CI database setup failed; connection details withheld.\n');
  process.exitCode = 1;
});
