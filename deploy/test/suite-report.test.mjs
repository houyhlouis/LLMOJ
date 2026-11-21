import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { planSuites, suiteGroups } from './run-tests.mjs';
import { runSuite } from './suite-report.mjs';

test('CI includes portable deployment regressions and the complete upgrade suite', () => {
  const planned = planSuites(suiteGroups, ['deploy'], true);
  for (const name of ['admin-output', 'docker-support', 'github-entry', 'install-support', 'judge-capacity', 'judge-prompt', 'redis-host', 'upgrade']) {
    const file = `deploy/test/${name}.test.py`;
    const suite = planned.find(entry => entry.file === file);
    assert.ok(suite && !suite.exclusion, file);
    assert.deepEqual(suite.args, ['-B', file, '-v'], file);
  }
  assert.equal(planned.find(entry => entry.file === 'deploy/test/upgrade.test.py').asRoot, true);
  const migration = 'deploy/test/upgrade-migration.integration.mjs';
  assert.match(planned.find(entry => entry.file === migration).exclusion, /dedicated MariaDB fixture/);
  assert.equal(planSuites({ deploy: [migration] }, ['deploy'], false)[0].exclusion, undefined);
});

function fixture(t, name, contents) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoj-report-fixture-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, name), contents);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return { cwd, env, stdout: new Writable({ write(chunk, encoding, done) { done(); } }) };
}

test('a failing TAP suite reports its executed cases and its skipped prerequisite', async t => {
  const options = fixture(t, 'checks.mjs', `
    import test from 'node:test';
    test('ran', () => {});
    test('needs a fixture', { skip: 'fixture is unavailable' }, () => {});
    test('failed', () => { throw new Error('fixture assertion'); });
  `);
  const result = await runSuite(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', 'checks.mjs'],
    { ...options, format: 'tap' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.equal(result.executed, 2);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.reasons, ['fixture is unavailable']);
});

test('verbose unittest reports skipped tests and class setup separately from executed tests', async t => {
  const options = fixture(t, 'checks.py', `
import unittest
class Checks(unittest.TestCase):
    def test_ran(self): pass
    @unittest.skip('optional fixture')
    def test_skipped(self): pass
class Missing(unittest.TestCase):
    @classmethod
    def setUpClass(cls): raise unittest.SkipTest('class fixture')
    def test_case(self): pass
unittest.main()
`);
  const result = await runSuite('python3', ['-B', 'checks.py', '-v'], { ...options, format: 'python' });
  assert.equal(result.ok, true);
  assert.equal(result.executed, 1);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.reasons, ['optional fixture', 'class fixture']);
});

test('a standalone host harness can report a missing fixture without claiming to execute cases', async t => {
  const options = fixture(t, 'host.cjs', "console.log('SKIP: needs an isolated socket');");
  const result = await runSuite(process.execPath, ['host.cjs'], { ...options, format: 'script' });
  assert.equal(result.ok, true);
  assert.equal(result.executed, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.reasons, ['needs an isolated socket']);
});
