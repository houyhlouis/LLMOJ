#!/usr/bin/env node
/**
 * Runs the repository's test suites: `pnpm test` runs all of them, CI runs its groups with `--ci`.
 *
 *   node deploy/test/run-tests.mjs [--ci] [GROUP...]      (groups: ai judge backend frontend deploy wiki)
 *
 * Suites that need something this machine lacks skip those cases themselves; the summary says what was missing:
 * - MariaDB: the *_TEST_DB_CONFIG variables naming disposable databases (see README-DEVELOPMENT.md);
 * - redis-server, for the judge queue and Redis suites;
 * - root (or passwordless sudo), for the deploy suites' cases that create accounts, mount or run services;
 * - Chrome or Chromium, for the service worker test: LLMOJ_TEST_CHROME, or google-chrome or chromium on PATH.
 * Building the backend first (`pnpm build`) is needed by the schema and API contract suites.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const BACKEND_SUITES = [
  'apps/backend/src/access/capability-cache.test.cjs', 'apps/backend/src/access/route-access.test.cjs',
  'apps/backend/src/access/permission-matrix.mariadb.test.cjs', 'apps/backend/src/discussion/*.test.cjs',
  'apps/backend/src/team/*.test.cjs', 'apps/backend/src/hack/*.test.cjs', 'apps/backend/src/self-eval/*.test.cjs',
  'apps/backend/src/submission/submission-progress.test.cjs', 'apps/backend/src/submission/submission-fake.mariadb.test.cjs',
  'apps/backend/src/submission/submission-delete.mariadb.test.cjs',
  'apps/backend/src/submission/submission-data-version.mariadb.test.cjs', 'apps/backend/src/file/file-upload-security.test.cjs',
  'apps/backend/src/contest/*.test.cjs', 'apps/backend/src/problem/problem-statement.test.cjs',
  'apps/backend/src/problem/problem-batch-reads.test.cjs', 'apps/backend/src/problem/problem-boundaries.test.cjs',
  'apps/backend/src/problem/problem-mutations.mariadb.test.cjs', 'apps/backend/src/judge/*.test.cjs',
  'apps/backend/src/submission/submission-priority.test.cjs', 'apps/backend/src/submission/submission-boundaries.test.cjs',
  'apps/backend/src/auth/*.test.cjs', 'apps/backend/src/site-management/*.test.cjs', 'apps/backend/src/database/*.test.cjs',
  'apps/backend/src/study-list/*.test.cjs', 'apps/backend/src/auth/two-factor/*.test.cjs', 'apps/backend/src/health/*.test.cjs',
  'apps/backend/src/common/*.test.cjs', 'apps/backend/src/metrics/*.test.cjs', 'apps/backend/src/redis/*.test.cjs',
  'apps/backend/src/file/file-maintenance.test.cjs', 'apps/backend/src/file/file-content-hash.test.cjs',
  'apps/backend/src/archive/*.test.cjs'
];

const JUDGE_SUITES = [
  'apps/judge/src/aiQuality.test.cjs', 'apps/judge/src/task/hack/hack.test.cjs', 'apps/judge/src/task/self-eval/self-eval.test.cjs',
  'apps/judge/src/rpc.test.cjs', 'apps/judge/src/executionScheduler.test.cjs', 'apps/judge/src/selfTestConfig.test.cjs',
  'apps/judge/src/fileContent.test.cjs', 'apps/judge/src/task/ai-execution/ai-execution.test.cjs',
  'apps/judge/src/launcher/policy.test.cjs', 'apps/judge/src/checkers/builtin.test.cjs',
  'apps/judge/src/checkers/score.test.cjs', 'apps/judge/src/task/submission/submissionFile.test.cjs'
];

// The Python suites of deploy/test. Those CI runs too; the others need Ubuntu 26.04's Python and tools, as installed
// servers have them, so they run with `pnpm test` on such a machine.
const PYTHON_IN_CI = ['install-flow', 'backup', 'doctor', 'verify-backup', 'community-upgrade', 'community-runtime-upgrade'];
// Run as root by CI: their cases that need root are its point
const PYTHON_AS_ROOT_IN_CI = new Set(['community-upgrade', 'community-runtime-upgrade']);

const node = (...args) => ({ program: process.execPath, args });
const python = (name, asRoot) => ({ program: 'python3', args: ['-B', `deploy/test/${name}.test.py`], asRoot });

function pythonSuites(ci) {
  const names = fs.readdirSync(path.join(root, 'deploy/test'))
    .filter(file => file.endsWith('.test.py') && file !== 'wiki-export.test.py')
    .map(file => file.slice(0, -'.test.py'.length))
    .sort();
  // Outside CI every suite runs, as root where possible, so that no case is skipped for want of it
  return (ci ? PYTHON_IN_CI : names).map(name => python(name, ci ? PYTHON_AS_ROOT_IN_CI.has(name) : true));
}

// The AI suites unpack ZIP archives and need 2 GiB free in TMPDIR; /tmp is often a small tmpfs
function aiTemporaryDirectory() {
  if (process.env.TMPDIR) return process.env.TMPDIR;
  const free = directory => {
    try {
      const { bavail, bsize } = fs.statfsSync(directory);
      return bavail * bsize;
    } catch {
      return 0;
    }
  };
  return free(os.tmpdir()) < 2 * 1024 ** 3 && free('/var/tmp') >= 2 * 1024 ** 3 ? '/var/tmp' : undefined;
}

const GROUPS = {
  ai: () => [{ ...node('--test', '--test-concurrency=1', 'apps/backend/src/ai/*.test.cjs'), tmpdir: aiTemporaryDirectory() }],
  judge: () => [node('--test', ...JUDGE_SUITES)],
  backend: () => [
    node('apps/backend/src/access/access-permissions.test.cjs'),
    node('--test', '--test-concurrency=1', ...BACKEND_SUITES)
  ],
  frontend: () => [node('--test', 'packages/frontend/test/*.test.cjs')],
  deploy: ci => [
    node('--test', 'deploy/fake-migration.test.cjs'),
    node('--test', 'deploy/test/upgrade-schema.test.mjs', 'deploy/test/community-schema.test.mjs',
      'deploy/test/team-storage.test.mjs', 'deploy/test/upgrade-registration.test.mjs'),
    node('--test', 'deploy/test/community-schema.mariadb.test.mjs', 'deploy/test/initialize-schema.test.mjs'),
    node('--test', 'deploy/test/backup-keys.test.mjs', 'deploy/test/dependency-audit.test.mjs'),
    // In Chrome or Chromium (LLMOJ_TEST_CHROME, or on PATH); skipped without one
    node('--test', 'deploy/test/service-worker-retirement.test.mjs'),
    // The first administrator's creation, against a temporary database server
    ...(ci ? [] : [node('--test', 'deploy/test/bootstrap-admin.test.mjs')]),
    ...pythonSuites(ci)
  ],
  wiki: () => [python('wiki-export', false)]
};

const argv = process.argv.slice(2);
const ci = argv.includes('--ci');
const requested = argv.filter(arg => arg !== '--ci');
const unknown = requested.filter(group => !(group in GROUPS));
if (unknown.length) {
  console.error(`Unknown group ${unknown.join(', ')}; the groups are ${Object.keys(GROUPS).join(', ')}`);
  process.exit(2);
}
const groups = requested.length ? requested : Object.keys(GROUPS);

const isRoot = process.getuid?.() === 0;
const canSudo = !isRoot && spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;
const missing = [];
const databases = ['LLMOJ_JUDGE_QUEUE_TEST_DB_CONFIG', 'HYHOJ_SUBMISSION_TEST_DB_CONFIG', 'LLMOJ_SCHEMA_TEST_DB_CONFIG'];
if (databases.some(name => !process.env[name])) missing.push('the *_TEST_DB_CONFIG MariaDB databases (their suites skip)');
if (spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status !== 0) missing.push('redis-server');
const chrome = process.env.LLMOJ_TEST_CHROME || ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  .some(name => spawnSync('which', [name], { stdio: 'ignore' }).status === 0);
if (groups.includes('deploy') && !chrome) missing.push('Chrome or Chromium (the service worker test skips)');

const results = [];
for (const group of groups)
  for (const command of GROUPS[group](ci)) {
    let { program, args } = command;
    if (command.asRoot && !isRoot) {
      if (canSudo) {
        // As CI does; the PATH keeps this Node.js, and -B keeps root-owned caches out of the tree
        args = ['-n', 'env', `PATH=${path.dirname(process.execPath)}:${process.env.PATH}`, program, ...args];
        program = 'sudo';
      } else if (!missing.includes('root')) missing.push('root or passwordless sudo (cases needing it skip)');
    }
    const label = `${group}: ${[command.program === process.execPath ? 'node' : command.program, ...command.args].join(' ')}`;
    console.log(`\n▶ ${label}`);
    const started = Date.now();
    const env = command.tmpdir ? { ...process.env, TMPDIR: command.tmpdir } : process.env;
    const { status, signal } = spawnSync(program, args, { cwd: root, stdio: 'inherit', env });
    results.push({ label, ok: status === 0, seconds: Math.round((Date.now() - started) / 1000), status: status ?? signal });
  }

console.log('\nSummary');
for (const result of results)
  console.log(`  ${result.ok ? 'pass' : 'FAIL'}  ${String(result.seconds).padStart(4)} s  ${result.label.slice(0, 150)}`);
if (missing.length) console.log(`\nNot available here: ${missing.join('; ')}.`);
const failed = results.filter(result => !result.ok).length;
const commands = count => `${count} command${count === 1 ? '' : 's'}`;
console.log(failed ? `\n${failed} of ${commands(results.length)} failed.` : `\n${commands(results.length)} passed.`);
process.exit(failed ? 1 : 0);
