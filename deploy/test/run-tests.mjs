#!/usr/bin/env node
/**
 * Checks the complete source inventory before running the requested groups.
 *
 *   node deploy/test/run-tests.mjs [--ci] [GROUP...]      (groups: ai judge backend frontend deploy wiki)
 *
 * CI requires its provisioned MariaDB fixtures, redis-server and root for the groups that use them.
 * Local runs report missing prerequisites alongside the affected cases.
 * - MariaDB: the *_TEST_DB_CONFIG variables naming disposable databases (see README-DEVELOPMENT.md);
 * - redis-server, for the judge queue and Redis suites;
 * - root (or passwordless sudo), for the deploy suites' cases that create accounts, mount or run services;
 *   set LLMOJ_TEST_NO_SUDO=1 to forbid even probing sudo in restricted test environments;
 * - Chrome or Chromium, for the service worker test: LLMOJ_TEST_CHROME, or google-chrome or chromium on PATH;
 * - MinIO (LLMOJ_MINIO_BINARY, or an installation's runtime/minio), for the upload sealing test and the backup
 *   verifier's content check.
 * Building the backend first (`pnpm build`) is needed by the schema and API contract suites.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSuiteInventory, missingRequiredServices } from './suite-inventory.mjs';
import { runSuite } from './suite-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const BACKEND_SUITES = [
  'apps/backend/src/access/access-permissions.test.cjs', 'apps/backend/src/config/config-privacy.test.cjs',
  'apps/backend/src/group/group-discussion-counts.mariadb.test.cjs', 'apps/backend/src/problem-type/common/checker.test.cjs',
  'apps/backend/src/problem-type/judge-info-defaults.test.cjs',
  'apps/backend/src/access/capability-cache.test.cjs', 'apps/backend/src/access/route-access.test.cjs',
  'apps/backend/src/access/permission-matrix.mariadb.test.cjs', 'apps/backend/src/discussion/*.test.cjs',
  'apps/backend/src/team/*.test.cjs', 'apps/backend/src/hack/*.test.cjs', 'apps/backend/src/self-eval/*.test.cjs',
  'apps/backend/src/submission/submission-progress.test.cjs', 'apps/backend/src/submission/submission-fake.mariadb.test.cjs',
  'apps/backend/src/submission/submission-delete.mariadb.test.cjs',
  'apps/backend/src/submission/submission-statistics-cache.mariadb.test.cjs',
  'apps/backend/src/submission/submission-data-version.mariadb.test.cjs', 'apps/backend/src/file/file-upload-security.test.cjs',
  'apps/backend/src/submission/submission-visibility.test.cjs', 'apps/backend/src/submission/submission-visibility.mariadb.test.cjs',
  'apps/backend/src/user/user-narrow-writes.test.cjs', 'apps/backend/src/user/user-narrow-writes.mariadb.test.cjs',
  'apps/backend/src/event-report/*.test.cjs', 'apps/backend/src/cluster/cluster.service.test.cjs',
  'apps/backend/src/contest/*.test.cjs', 'apps/backend/src/problem/problem-statement.test.cjs',
  'apps/backend/src/problem/problem-batch-reads.test.cjs', 'apps/backend/src/problem/problem-boundaries.test.cjs',
  'apps/backend/src/problem/problem-mutations.mariadb.test.cjs', 'apps/backend/src/problem/problem-judge-info-cache.mariadb.test.cjs',
  'apps/backend/src/judge/*.test.cjs',
  'apps/backend/src/submission/submission-priority.test.cjs', 'apps/backend/src/submission/submission-boundaries.test.cjs',
  'apps/backend/src/auth/*.test.cjs', 'apps/backend/src/site-management/*.test.cjs', 'apps/backend/src/database/*.test.cjs',
  'apps/backend/src/study-list/*.test.cjs', 'apps/backend/src/auth/two-factor/*.test.cjs', 'apps/backend/src/health/*.test.cjs',
  'apps/backend/src/common/*.test.cjs', 'apps/backend/src/metrics/*.test.cjs',
  'apps/backend/src/redis/generation-cache.test.cjs', 'apps/backend/src/redis/redis-connections.test.cjs',
  'apps/backend/src/redis/read-write-lock.test.cjs', 'apps/backend/src/redis/lock-lifecycle.test.cjs',
  'apps/backend/src/redis/lock-pause.test.cjs', 'apps/backend/src/redis/lock-lease.mariadb.test.cjs',
  'apps/backend/src/redis/lock-caller-recovery.test.cjs',
  'apps/backend/src/file/file-maintenance.test.cjs', 'apps/backend/src/file/file-content-hash.test.cjs',
  'apps/backend/src/file/file-sealing.minio.test.cjs',
  'apps/backend/src/archive/*.test.cjs', 'apps/backend/src/statement-export/*.test.cjs'
];

const JUDGE_SUITES = [
  'apps/judge/src/systemInfo.test.cjs', 'apps/judge/test/audit-regressions.cjs', 'apps/judge/test/submit-answer-ownership.cjs',
  'apps/judge/src/aiProtocolDiagnostics.test.cjs',
  'apps/judge/src/aiQuality.test.cjs', 'apps/judge/src/aiEvidence.test.cjs', 'apps/judge/src/aiProfile.test.cjs',
  'apps/judge/src/aiCheckpoint.test.cjs', 'apps/judge/src/aiReceipts.test.cjs', 'apps/judge/src/cancelScope.test.cjs',
  'apps/judge/src/task/hack/hack.test.cjs',
  'apps/judge/src/task/self-eval/self-eval.test.cjs',
  'apps/judge/src/rpc.test.cjs', 'apps/judge/src/executionScheduler.test.cjs', 'apps/judge/src/selfTestConfig.test.cjs',
  'apps/judge/src/fileContent.test.cjs', 'apps/judge/src/task/ai-execution/ai-execution.test.cjs',
  'apps/judge/src/launcher/policy.test.cjs', 'apps/judge/src/checkers/builtin.test.cjs',
  'apps/judge/src/checkers/score.test.cjs', 'apps/judge/src/task/submission/submissionFile.test.cjs',
  'apps/judge/src/task/submission/testcaseResources.test.cjs', 'apps/judge/src/architecture.test.cjs',
  'packages/simple-sandbox/test/sandbox-process.test.cjs', 'packages/simple-sandbox/test/cgroup-events.test.mjs'
];

// CI runs each portable suite as the runner account and each ci-as-root suite on the disposable VM.
// Individual tests report missing optional prerequisites. Host acceptance requires a separately prepared fixture.
const portable = reason => ({ group: 'deploy', classification: 'portable', reason });
const asRoot = reason => ({ group: 'deploy', classification: 'ci-as-root', reason });
const wiki = reason => ({ group: 'wiki', classification: 'portable', reason });

const DEPLOYMENT_SUITES = {
  'deploy/test/admin-output.test.py': portable('Exercises Node output through a temporary file and a POSIX pseudo-terminal.'),
  'deploy/test/backup.test.py': portable('Archives a temporary tree with a substitute systemctl and a private GPG keyring.'),
  'deploy/test/community-runtime-upgrade.test.py': asRoot('Uses root-owned upgrade fixtures and a simulated service manager.'),
  'deploy/test/community-upgrade.test.py': asRoot('Checks ownership of the temporary upgrade tree and simulates SQL and services.'),
  'deploy/test/docker-support.test.py': portable('Checks package sources and daemon settings in temporary files; dockerd can validate the configuration when installed.'),
  'deploy/test/doctor.test.py': portable('Uses a simulated installation and exercises the refusal to run without root.'),
  'deploy/test/github-entry.test.py': portable('Substitutes curl and serves its commit and archive from local fixtures.'),
  'deploy/test/initialize-mariadb.test.py': portable('Simulates MariaDB bootstrap, account ownership and subprocesses; uses a private Unix socket for cleanup.'),
  'deploy/test/install-flow.test.py': portable('Exercises installer shell fragments with substitute commands.'),
  'deploy/test/install-network.test.py': asRoot('Writes temporary configuration owned by service accounts and checks it with nginx on loopback.'),
  'deploy/test/install-support.test.py': asRoot('Runs installer plan and AppArmor fixtures alongside checks on root-owned private state.'),
  'deploy/test/judge-capacity.test.py': portable('Calculates slot limits from simulated CPU and memory availability.'),
  'deploy/test/judge-config.test.py': asRoot('Creates a root-owned private judge configuration and verifies its units with systemd-analyze.'),
  'deploy/test/judge-prompt.test.py': portable('Feeds scripted answers to the installer capacity prompt.'),
  'deploy/test/redis-host.test.py': portable('Simulates the package Redis service and its state.'),
  'deploy/test/resize-judge.test.py': asRoot('Checks root-owned workspaces while simulating service and mount operations.'),
  'deploy/test/sandbox-staging.test.py': asRoot('Tests archive assembly and stages a disposable chroot in a private mount namespace when available.'),
  'deploy/test/source-package.test.py': portable('Builds a source archive from the checkout and inspects it in a temporary directory.'),
  'deploy/test/upgrade.test.py': asRoot('Exercises the schema-plan comparison and health checks alongside the root-owned installation fixtures.'),
  'deploy/test/service-fixture.test.py': portable('Checks the private MariaDB directory and server identity guards.'),
  'deploy/test/verify-backup.test.py': asRoot('Checks archives and restores a private MariaDB as the mysql user; object content checks also use MinIO when installed.'),
  'deploy/test/wiki-export.test.py': wiki('Exports and compares local Markdown trees in temporary directories.'),

  'deploy/fake-migration.test.cjs': portable('Uses the MariaDB client and the disposable fake-migration database.'),
  'deploy/test/ai-lifecycle-schema.mariadb.test.mjs': portable('Uses the disposable schema database and its isolated upgrade namespace.'),
  'deploy/test/ai-lifecycle-schema.test.mjs': portable('Validates the AI schema contract against synthetic plans and metadata.'),
  'deploy/test/release-manifest.test.mjs': portable('Checks clean, dirty and source-less builds and the GitHub release handoff.'),
  'deploy/test/backup-keys.test.mjs': portable('Verifies temporary key files against values encrypted by the backend.'),
  'deploy/test/benchmark-load.test.mjs': portable('Measures scheduled arrivals, page requests, errors and metrics with a simulated backend.'),
  'deploy/test/benchmark-seed.test.mjs': portable('Checks the deterministic SQL fixtures and disposable database guard.'),
  'deploy/test/benchmark-strict-ioi.test.mjs': portable('Runs both scoring projections on the seeded fixture with the built backend and an in-memory SQL database.'),
  'deploy/test/bootstrap-admin.test.mjs': portable('Uses bcrypt and simulated transactions; one case requires a dedicated local administrator-test socket.'),
  'deploy/test/community-schema.mariadb.test.mjs': portable('Applies the schema contract to the disposable community database.'),
  'deploy/test/community-schema.test.mjs': portable('Checks the community schema allowlist with recorded SQL shapes.'),
  'deploy/test/contest-virtual-schema.test.mjs': portable('Checks the compiled virtual participation entity and resumable MariaDB DDL contract.'),
  'deploy/test/dependency-audit.test.mjs': portable('Classifies synthetic audit reports and reads the repository toolchain pins.'),
  'deploy/test/dev-stack.test.mjs': portable('Checks local stack configuration, port conflicts and process ownership without starting services.'),
  'deploy/test/docs-contract.test.mjs': wiki('Checks bilingual documentation against the protocol constants and the testcase allocator.'),
  'deploy/test/initialize-schema.test.mjs': portable('Checks the initializer CLI and builds the current schema in a disposable database.'),
  'deploy/test/service-worker-retirement.test.mjs': {
    ...portable('Runs a headless browser against a temporary loopback site when Chrome or Chromium is available.'),
    timeout: 420000
  },
  'deploy/test/suite-inventory.test.mjs': portable('Checks registrations, exclusions and prerequisites against synthetic fixtures and the checkout.'),
  'deploy/test/suite-report.test.mjs': portable('Checks the per-suite test counts and skip reasons.'),
  'deploy/test/team-storage.test.mjs': portable('Checks the storage migration with simulated queries.'),
  'deploy/test/upgrade-migration.integration.mjs': {
    group: 'deploy', classification: 'host-acceptance', format: 'script',
    reason: 'Release acceptance uses a trusted pre-registration dump independent of current TypeORM entities. Run with-service-fixture.py --baseline DUMP migration on its dedicated MariaDB fixture.'
  },
  'deploy/test/upgrade-registration.test.mjs': portable('Checks registration migration with simulated database metadata and rows.'),
  'deploy/test/upgrade-schema.test.mjs': portable('Checks exact SQL plans and privilege metadata against the upgrade allowlist.')
};

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

const deploymentGroup = group => Object.keys(DEPLOYMENT_SUITES).filter(file => DEPLOYMENT_SUITES[file].group === group);

export const suiteGroups = {
  ai: ['apps/backend/src/ai/*.test.cjs'],
  judge: JUDGE_SUITES,
  backend: BACKEND_SUITES,
  frontend: ['packages/frontend/test/*.test.cjs'],
  deploy: deploymentGroup('deploy'),
  wiki: deploymentGroup('wiki')
};

const requiredServiceSuites = new Set([
  'apps/backend/src/auth/registration-review.mariadb.test.cjs',
  'apps/backend/src/site-management/registration-settings.mariadb.test.cjs',
  'apps/backend/src/file/file-sealing.minio.test.cjs', 'deploy/test/bootstrap-admin.test.mjs',
  'deploy/test/verify-backup.test.py'
]);

// These predate node:test and report assertions through the process exit status.
const scripts = new Set(['apps/backend/src/access/access-permissions.test.cjs', 'apps/backend/src/contest/contest-scoring.test.cjs']);

function commandFor(file, ci) {
  if (file.endsWith('.py'))
    return { program: ci ? '/usr/bin/python3' : 'python3', args: ['-B', file, '-v'], format: 'python' };
  if (scripts.has(file) || DEPLOYMENT_SUITES[file]?.format === 'script')
    return { program: process.execPath, args: [file], format: 'script' };
  // Each suite already gets its own process. Report its individual cases directly.
  return { program: process.execPath, args: ['--test', '--test-isolation=none', '--test-reporter=tap', file], format: 'tap' };
}

export function planSuites(registered, groups, ci) {
  return groups.flatMap(group => registered[group].map(file => {
    const suite = DEPLOYMENT_SUITES[file];
    return {
      group, file, ...commandFor(file, ci), timeout: suite?.timeout,
      asRoot: suite?.classification === 'ci-as-root',
      exclusion: ci && suite?.classification === 'host-acceptance' ? suite.reason : undefined
    };
  }));
}

async function main(argv) {
  const ci = argv.includes('--ci');
  const requested = argv.filter(arg => arg !== '--ci');
  const unknown = requested.filter(group => !Object.hasOwn(suiteGroups, group));
  if (unknown.length) {
    console.error(`Unknown group ${unknown.join(', ')}; the groups are ${Object.keys(suiteGroups).join(', ')}`);
    return 2;
  }
  const groups = requested.length ? requested : Object.keys(suiteGroups);
  const registered = validateSuiteInventory(root, suiteGroups);
  const plan = planSuites(registered, groups, ci);
  const missing = missingRequiredServices(groups);
  const needsRoot = plan.some(suite => suite.asRoot);
  const isRoot = process.getuid?.() === 0;
  const canSudo = needsRoot && !isRoot && process.env.LLMOJ_TEST_NO_SUDO !== '1' &&
    spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;
  if (needsRoot && !isRoot && !canSudo) missing.push('root or passwordless sudo');
  if (ci && missing.length) {
    console.error(`CI setup missing: ${missing.join(', ')}`);
    return 1;
  }

  const results = [];
  for (const suite of plan) {
    const { group, file, format, timeout } = suite;
    if (suite.exclusion) {
      results.push({ file, excluded: true, executed: 0, skipped: 1, reasons: [suite.exclusion] });
      continue;
    }
    let { program, args } = suite;
    if (suite.asRoot && canSudo) {
      // The root-owned fixtures need the pinned Node and must leave the checkout writable by the runner.
      const storage = file === 'deploy/test/verify-backup.test.py' && process.env.LLMOJ_MINIO_BINARY
        ? [`LLMOJ_MINIO_BINARY=${process.env.LLMOJ_MINIO_BINARY}`] : [];
      args = ['-n', 'env', ...storage, `PATH=${path.dirname(process.execPath)}:${process.env.PATH}`, 'PYTHONDONTWRITEBYTECODE=1', program, ...args];
      program = 'sudo';
    }
    console.log(`\n▶ ${group}: ${file}`);
    const started = Date.now();
    const tmpdir = group === 'ai' && aiTemporaryDirectory();
    const env = { ...process.env };
    if (tmpdir) env.TMPDIR = tmpdir;
    if (format === 'python') env.PYTHONDONTWRITEBYTECODE = '1';
    const result = await runSuite(program, args, { cwd: root, env, format, timeout });
    if (ci && result.ok && requiredServiceSuites.has(file) && (result.skipped || !result.executed)) {
      result.ok = false;
      result.error = new Error('Promised service cases must execute without skips');
    }
    if (!result.ok) console.error(`${file}: ${result.error?.message || `exited with ${result.status}`}`);
    results.push({ ...result, file, seconds: Math.round((Date.now() - started) / 1000) });
  }

  console.log('\nSummary');
  for (const result of results) {
    const status = result.excluded ? 'excluded' : result.ok ? 'pass' : 'FAIL';
    const time = result.excluded ? '' : ` (${result.seconds} s)`;
    const skipped = result.excluded ? '1 suite skipped' : `${result.skipped} skipped`;
    console.log(`  ${status}  ${result.file}  ${result.executed} executed, ${skipped}${time}`);
    for (const reason of result.reasons) console.log(`         ${reason}`);
  }
  if (missing.length) console.log(`\nNot available here: ${missing.join(', ')}.`);
  const ran = results.filter(result => !result.excluded);
  const failed = ran.filter(result => !result.ok).length;
  console.log(`\n${ran.length - failed} suites passed, ${failed} failed, ${results.length - ran.length} excluded.`);
  return failed ? 1 : 0;
}

if (import.meta.main) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
