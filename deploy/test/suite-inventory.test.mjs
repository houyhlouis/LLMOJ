import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suiteGroups } from './run-tests.mjs';
import { requiredDatabaseConfigs } from './setup-community-ci.mjs';
import { missingRequiredServices, SUITE_EXCLUSIONS, validateSuiteInventory } from './suite-inventory.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

function fixture(t, files = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoj-suite-inventory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const file of files) {
    const absolute = path.join(directory, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, '');
  }
  return directory;
}

test('all source trees are checked for unregistered test files', t => {
  const directory = fixture(t, ['backend/one.test.cjs', 'elsewhere/.nested/new.test.py']);
  assert.throws(() => validateSuiteInventory(directory, { backend: ['backend/*.test.cjs'] }, {}),
    /Unregistered test file: elsewhere\/\.nested\/new\.test\.py/);
});

test('every file has exactly one registration, including overlaps within a group and with exclusions', t => {
  const name = 'backend/one.test.cjs';
  const directory = fixture(t, [name]);
  for (const groups of [{ backend: [name], ai: [name] }, { backend: ['backend/*.test.cjs', name] }])
    assert.throws(() => validateSuiteInventory(directory, groups, {}), /Multiple registrations for backend\/one\.test\.cjs/);
  assert.throws(() => validateSuiteInventory(directory, { backend: [name] }, { [name]: 'Host fixture.' }),
    /Multiple registrations for backend\/one\.test\.cjs/);
});

test('exclusions need a written reason and stale selectors and exclusions are errors', t => {
  const file = 'only.root.cjs';
  const directory = fixture(t, [file]);
  assert.throws(() => validateSuiteInventory(directory, {}, { [file]: '  ' }), /Exclusion needs a reason: only\.root\.cjs/);
  const exclusions = { [file]: 'The Native job runs this inside its delegated unit.' };
  assert.deepEqual(validateSuiteInventory(directory, {}, exclusions), {});
  assert.throws(() => validateSuiteInventory(directory, { judge: ['removed/*.test.mjs'] }, exclusions),
    /selector matches no suite: removed/);
  assert.throws(() => validateSuiteInventory(directory, {}, { ...exclusions, 'removed.root.cjs': 'Root fixture.' }),
    /Excluded file not found in the inventory: removed\.root\.cjs/);
});

test('discovery covers nonstandard entry points, ignores generated and vendor copies and sorts filenames', t => {
  const files = ['new/test/first.cjs', 'python/test_sample.py', '.github/tools/workflow.test.mjs',
    'scripts/host.integration.mjs', 'new/test/second.test.cjs'];
  const directory = fixture(t, [...files, 'node_modules/dep/extra.test.js', 'apps/judge/vendor/testlib/extra.test.py',
    'backend/dist/unit.test.js', 'build/nested/extra.root.cjs', 'runtime/test/dependency.cjs', '.dev-stack/tmp/fixture.test.js']);
  assert.deepEqual(validateSuiteInventory(directory, { all: ['**/test/*.cjs', ...files.slice(1, 4)] }, {}),
    { all: files.toSorted() });
});

test('the requested groups require the same database variables CI provisions and the backend requires Redis', t => {
  const directory = fixture(t);
  const env = { PATH: directory };
  assert.deepEqual(missingRequiredServices(['judge', 'wiki', 'frontend'], env), []);
  assert.deepEqual(missingRequiredServices(['ai'], env),
    ['HYHOJ_AI_TEST_DB_CONFIG', 'LLMOJ_AI_BUDGET_TEST_DB_CONFIG', 'LLMOJ_OPERATIONS_TEST_DB_CONFIG']);
  assert.deepEqual(missingRequiredServices(['deploy'], env),
    ['HYHOJ_COMMUNITY_SCHEMA_TEST_DB_CONFIG', 'LLMOJ_FAKE_TEST_DB_CONFIG', 'LLMOJ_SCHEMA_TEST_DB_CONFIG',
      'LIBREOJ_ADMIN_TEST_SOCKET', 'LLMOJ_MINIO_BINARY']);
  const backend = requiredDatabaseConfigs(['backend']);
  assert.ok(backend.includes('HYHOJ_COUNT_TEST_DB_CONFIG'));
  const services = ['redis-server', 'LLMOJ_REGISTRATION_TEST_DATABASE', 'LLMOJ_MINIO_BINARY'];
  assert.deepEqual(missingRequiredServices(['backend'], env), [...backend, ...services]);
  for (const name of backend) env[name] = 'synthetic-config';
  assert.deepEqual(missingRequiredServices(['backend'], env), services);
  env.LLMOJ_REGISTRATION_TEST_DATABASE = 'synthetic-registration';
  env.LLMOJ_MINIO_BINARY = path.join(directory, 'minio');
  fs.writeFileSync(env.LLMOJ_MINIO_BINARY, '', { mode: 0o600 });
  assert.deepEqual(missingRequiredServices(['backend'], env), ['redis-server', 'LLMOJ_MINIO_BINARY']);
  fs.chmodSync(env.LLMOJ_MINIO_BINARY, 0o755);
  fs.writeFileSync(path.join(directory, 'redis-server'), '#!/bin/sh\n[ "$1" = "--version" ]\n', { mode: 0o755 });
  assert.deepEqual(missingRequiredServices(['backend'], env), []);
});

test('the real runner owns every repository suite and CI provisions its MariaDB configuration', () => {
  const registered = validateSuiteInventory(root, suiteGroups);
  for (const name of ['config/config-privacy.test.cjs', 'group/group-discussion-counts.mariadb.test.cjs',
    'problem-type/common/checker.test.cjs', 'contest/contest-admission.mariadb.test.cjs'])
    assert.ok(registered.backend.includes('apps/backend/src/' + name), name);
  for (const [group, files] of Object.entries(registered)) {
    const required = requiredDatabaseConfigs([group]);
    for (const file of files) {
      const suite = fs.readFileSync(path.join(root, file), 'utf8');
      for (const [, variable] of suite.matchAll(/\bprocess\.env\.([A-Z0-9_]+_DB_CONFIG)\b/g))
        assert.ok(required.includes(variable), `${file} needs CI to provision ${variable} for ${group}`);
    }
  }
});

test('the runner fails before starting suites on inventory errors or missing CI services', t => {
  const registered = validateSuiteInventory(root, suiteGroups);
  // Leave the suites empty in this copy. Even a regressed preflight cannot run a real service here.
  const directory = fixture(t, [...Object.values(registered).flat(), ...Object.keys(SUITE_EXCLUSIONS)]);
  for (const name of ['run-tests.mjs', 'suite-inventory.mjs', 'suite-report.mjs', 'setup-community-ci.mjs']) {
    const relative = path.join('deploy/test', name);
    fs.copyFileSync(path.join(root, relative), path.join(directory, relative));
  }
  const env = { PATH: directory, LLMOJ_TEST_NO_SUDO: '1' };
  function failedOutput(argv) {
    const log = path.join(directory, 'preflight.log');
    const fd = fs.openSync(log, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, ['deploy/test/run-tests.mjs', ...argv], { cwd: directory, env, stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
    const output = fs.readFileSync(log, 'utf8');
    assert.equal(result.status, 1, result.error?.message || output);
    return output;
  }
  function failure(argv) {
    const output = failedOutput(argv);
    assert.doesNotMatch(output, /^▶ |^Summary$/m);
    return output;
  }
  assert.match(failure(['--ci', 'ai']), /CI setup missing: .*HYHOJ_AI_TEST_DB_CONFIG/);
  for (const name of requiredDatabaseConfigs(['backend'])) env[name] = 'synthetic-unused-path';
  assert.match(failure(['--ci', 'backend']), /CI setup missing: redis-server, LLMOJ_REGISTRATION_TEST_DATABASE, LLMOJ_MINIO_BINARY/);
  assert.match(failure(['--ci', 'deploy']), /LIBREOJ_ADMIN_TEST_SOCKET, LLMOJ_MINIO_BINARY/);
  fs.writeFileSync(path.join(directory, 'redis-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  env.LLMOJ_MINIO_BINARY = process.execPath;
  assert.match(failure(['--ci', 'backend']), /^CI setup missing: LLMOJ_REGISTRATION_TEST_DATABASE$/m);
  env.LLMOJ_REGISTRATION_TEST_DATABASE = 'synthetic-unused-path';
  delete env.LLMOJ_MINIO_BINARY;
  assert.match(failure(['--ci', 'backend']), /^CI setup missing: LLMOJ_MINIO_BINARY$/m);
  env.LLMOJ_MINIO_BINARY = process.execPath;
  // Exercise the real CI exit status for a promised case that skipped despite a successful process.
  fs.writeFileSync(path.join(directory, 'deploy/test/suite-report.mjs'), `
export async function runSuite(_program, args) {
  return { ok: true, status: 0, executed: 1, skipped: Number(args.at(-1).endsWith('file-sealing.minio.test.cjs')), reasons: [] };
}
`);
  const report = failedOutput(['--ci', 'backend']);
  assert.match(report, /FAIL {2}apps\/backend\/src\/file\/file-sealing.minio.test.cjs/);
  assert.match(report, /Promised service cases must execute without skips/);
  fs.writeFileSync(path.join(directory, 'stray.test.cjs'), '');
  for (const args of [['wiki'], ['--ci', 'wiki']])
    assert.match(failure(args), /Unregistered test file: stray\.test\.cjs/);
});
