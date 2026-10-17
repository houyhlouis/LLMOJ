#!/usr/bin/env node
// Provision only the disposable GitHub Actions MariaDB service on port 3307.
// Each regression gets a distinct database and a user restricted to that database.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/backend/package.json'));
const mysql = require('mysql2/promise');
const fixtures = [
  ['team', 'llmoj_test_team', 'LLMOJ_TEAM_TEST_DB_CONFIG'],
  ['team_audit', 'llmoj_test_team_audit', 'LLMOJ_TEAM_AUDIT_DB_CONFIG'],
  ['fake', 'llmoj_test_fake', 'LLMOJ_FAKE_TEST_DB_CONFIG'],
  ['discussion', 'llmoj_features_discussion', 'HYHOJ_DISCUSSION_TEST_DB_CONFIG'],
  ['problem', 'llmoj_test_problem', 'HYHOJ_PROBLEM_TEST_DB_CONFIG'],
  ['submission', 'llmoj_test_submission', 'HYHOJ_SUBMISSION_TEST_DB_CONFIG'],
  ['schema', 'llmoj_test_schema', 'LLMOJ_SCHEMA_TEST_DB_CONFIG'],
  ['two_factor', 'llmoj_test_two_factor', 'LLMOJ_TWO_FACTOR_TEST_DB_CONFIG'],
  ['judge_queue', 'llmoj_test_judge_queue', 'LLMOJ_JUDGE_QUEUE_TEST_DB_CONFIG'],
  ['data_version', 'llmoj_test_data_version', 'LLMOJ_DATA_VERSION_TEST_DB_CONFIG'],
  ['ai_budget', 'llmoj_test_ai_budget', 'LLMOJ_AI_BUDGET_TEST_DB_CONFIG'],
  ['access_matrix', 'llmoj_test_access_matrix', 'LLMOJ_ACCESS_MATRIX_TEST_DB_CONFIG']
];

async function main() {
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.LLMOJ_CI_DATABASE_SETUP !== '1' || !process.env.RUNNER_TEMP ||
      !process.env.GITHUB_ENV || !process.env.LLMOJ_CI_MARIADB_PASSWORD)
    throw new Error('Use only the explicit disposable GitHub Actions fixture');
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
    for (const [name, database, variable] of fixtures) {
      const username = 'qa_' + name;
      const password = crypto.randomBytes(24).toString('hex');
      // All identifiers are fixed above; backslashes keep underscores literal in database grants.
      await connection.query('CREATE DATABASE `' + database + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      owned.push([database, username]);
      await connection.query('CREATE USER ?@\'%\' IDENTIFIED BY ?', [username, password]);
      await connection.query('GRANT ALL PRIVILEGES ON `' + database.replaceAll('_', '\\_') + '`.* TO ?@\'%\'', [username]);
      const config = path.join(directory, name + '.json');
      fs.writeFileSync(config, JSON.stringify({ services: { database: {
        type: 'mariadb', host: '127.0.0.1', port: 3307, database, username, password, charset: 'utf8mb4'
      } } }) + '\n', { mode: 0o600, flag: 'wx' });
      environment.push(variable + '=' + config);
      if (name === 'discussion') environment.push('HYHOJ_COMMUNITY_SCHEMA_TEST_DB_CONFIG=' + config, 'LLMOJ_SELF_EVAL_TEST_DB_CONFIG=' + config);
    }
    // Verify the effective grants rather than trusting account-creation syntax.
    for (let index = 0; index < fixtures.length; index++) {
      const [name, database] = fixtures[index];
      const config = JSON.parse(fs.readFileSync(path.join(directory, name + '.json'), 'utf8'));
      const { username, password, host, port } = config.services.database;
      const limited = await mysql.createConnection({ host, port, user: username, password, database });
      try {
        await limited.query('SELECT 1');
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
    process.stdout.write('Provisioned ten disposable, separately authorized regression databases.\n');
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

main().catch(() => {
  // Driver errors and connection options can contain credentials.
  process.stderr.write('Disposable CI database setup failed; connection details withheld.\n');
  process.exitCode = 1;
});
