import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { requiredDatabaseConfigs } from './setup-community-ci.mjs';

// These files have test names or live under a test directory. Keep their other entry point or purpose visible.
export const SUITE_EXCLUSIONS = {
  'apps/backend/src/ai/ai-browser.test.mjs': 'Host acceptance with Playwright, a disposable backend, a fixture user and a mock provider.',
  'apps/backend/src/ai/ai-integration.test.mjs': 'Host acceptance with a disposable backend, database, sandbox runner and mock provider.',
  'apps/backend/src/ai/ai-lifecycle.test.mjs': 'Host acceptance using the disposable AI integration fixture and its completed job.',
  'apps/backend/src/ai/ai-commit.fixture.cjs': 'In-memory dependencies imported by the AI commit suites.',
  'apps/backend/src/ai/ai-fixture-utils.mjs': 'Shared fixture configuration for the AI host acceptance scripts.',
  'apps/backend/src/ai/ai-quality.fixture.cjs': 'Synthetic receipts for the AI quality suites.',
  'apps/backend/src/ai/ai-quality-integration.fixture.mjs': 'Shared sample programs and model responses tested by ai-quality-integration.fixture.test.cjs.',
  'apps/backend/test/integration-client.mjs': 'Disposable backend client for the AI host acceptance scripts.',
  'apps/backend/test/temporary-redis.cjs': 'Redis fixture started and stopped by its consuming suites.',
  'apps/judge/src/task/ai-execution/ai-execution-worker.fixture.cjs': 'Worker dependencies supplied by the AI execution tests.',
  'apps/judge/native/builtin_checkers/smoke-test.mjs': 'The Native CI job runs this entry point against the compiled checker on both architectures.',
  'apps/judge/native/builtin_checkers/tokens.test.mjs': 'Imported by the native checker smoke test after the checker is built.',
  'apps/judge/test/launcher-server.root.cjs': 'The Native CI job runs this launcher test as root with delegated cgroups.',
  'apps/judge/test/launcher-fixture.c': 'Helper executable compiled by launcher-server.root.cjs.',
  'apps/judge/self-test.mjs': 'Judge host acceptance using the installed launcher, language toolchains and judge configuration.',
  'deploy/sandbox/self-test.sh': 'Starts the installed judge self-test in a root systemd unit with delegated cgroups.',
  'deploy/sandbox/smoke-test-host.sh': 'Probes installed rootfs toolchains during build and staging.',
  'deploy/test/fixtures/legacy-service-worker.js': 'Browser fixture served by service-worker-retirement.test.mjs.',
  'deploy/test/run-tests.mjs': 'Repository test runner.',
  'deploy/test/setup-community-ci.mjs': 'Provisions the disposable MariaDB service for CI.',
  'deploy/test/suite-inventory.mjs': 'Suite registration and CI service checks used by the runner.',
  'deploy/test/suite-report.mjs': 'Collects case counts and skip reasons for the runner summary.',
  'infra/sandbox-rootfs/arm64/smoke-test.sh': 'Build and staging acceptance inside the arm64 rootfs.',
  'infra/sandbox-rootfs/smoke-test.sh': 'Build and staging acceptance inside the amd64 rootfs.',
  'packages/frontend/test/helpers/component-harness.cjs': 'Component loader shared by the frontend suites.',
  'packages/simple-sandbox/demo/demo.js': 'The Native CI job runs the sandbox demo as root with delegated cgroups.',
  'packages/simple-sandbox/demo/fixture.c': 'Helper executable compiled by the sandbox demo.',
  'packages/simple-sandbox/test/cgroup-events.cc': 'C++ probe compiled and run by cgroup-events.test.mjs.',
  'packages/simple-sandbox/test/io-redirection.cc': 'C++ probe compiled and run by io-redirection.test.mjs.',
  'packages/simple-sandbox/test/io-redirection.test.mjs': 'The Native CI job supplies g++ and libfmt for this compiled probe.'
};

// Installed packages, compiler output and caches can contain their own suites or copies of ours.
const generatedDirectories = new Set(['node_modules', '.pnpm-store', 'dist', 'build', 'lib', 'coverage', '__pycache__', '.cache', '.git']);
// Local installation, account and tool state, exports, and the bundled testlib sources are outside the inventory.
const localDirectories = new Set(['runtime', 'data', 'backups', 'logs', 'cache', 'public', 'release', 'config', '.dev-stack',
  '.aws', '.gnupg', '.ssh', '.codex', '.agents', 'deploy/verification', 'deploy/noi', 'deploy/september20', 'deploy/rootfs',
  'apps/judge/vendor']);

function isSuiteCandidate(relative) {
  const name = path.posix.basename(relative);
  if (/\.(?:test|spec|root|integration)\.[^.]+$/.test(name)) return true;
  if (/^test_.+\.py$|_test\.py$/.test(name)) return true;
  if (!/\.(?:[cm]?[jt]sx?|py|sh|c|cc|cpp)$/.test(name)) return false;
  return relative === 'packages/simple-sandbox/demo/demo.js' || /(?:^|\/)(?:tests?|__tests__)\//.test(relative) ||
    /(?:^|[.-])(?:self-test|smoke-test|fixture)(?:[.-]|$)/.test(name);
}

function discoverSuites(root) {
  const files = [];
  function directoryIgnored(name) {
    return generatedDirectories.has(name) || name.startsWith('dist-');
  }
  // In a checkout use Git's tracked and untracked source inventory. This includes new suites under hidden
  // source directories while respecting local ignore rules for private working files and release evidence.
  if (fs.existsSync(path.join(root, '.git'))) {
    const listing = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
      ...Array.from(localDirectories, directory => ':(top,exclude)' + directory)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const file of listing.split('\0')) {
      if (!isSuiteCandidate(file) || file.split('/').slice(0, -1).some(directoryIgnored)) continue;
      // A locally deleted tracked file is absent from the working tree and must not satisfy a selector.
      const stat = fs.lstatSync(path.join(root, file), { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error(`Test file must be a regular file: ${file}`);
      if (stat?.isFile()) files.push(file);
    }
    return files.sort();
  }
  // An extracted source archive has no Git metadata. Walk the same source paths directly.
  function visit(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (directoryIgnored(entry.name) || localDirectories.has(relative)) continue;
        visit(relative);
      } else if (isSuiteCandidate(relative)) {
        if (entry.isSymbolicLink()) throw new Error(`Test file must be a regular file: ${relative}`);
        if (entry.isFile()) files.push(relative);
      }
    }
  }
  visit('');
  return files.sort();
}

// Resolve the same selectors that supply the actual execution plan. Count every match, even within a group.
export function validateSuiteInventory(root, groups, exclusions = SUITE_EXCLUSIONS) {
  const files = discoverSuites(root);
  const owners = new Map(files.map(file => [file, []]));
  const expanded = {};
  const errors = [];
  for (const [group, selectors] of Object.entries(groups)) {
    const selected = [];
    for (const selector of selectors) {
      const matches = files.filter(file => path.posix.matchesGlob(file, selector));
      if (!matches.length) errors.push(`${group} selector matches no suite: ${selector}`);
      for (const file of matches) {
        owners.get(file).push(group);
        selected.push(file);
      }
    }
    expanded[group] = selected.sort();
  }
  for (const [file, reason] of Object.entries(exclusions)) {
    if (typeof reason !== 'string' || !reason.trim()) errors.push(`Exclusion needs a reason: ${file}`);
    if (!owners.has(file)) errors.push(`Excluded file not found in the inventory: ${file}`);
    else owners.get(file).push('excluded');
  }
  for (const [file, matches] of owners) {
    if (!matches.length) errors.push(`Unregistered test file: ${file}`);
    if (matches.length > 1) errors.push(`Multiple registrations for ${file}: ${matches.join(', ')}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return expanded;
}

export function missingRequiredServices(groups, env = process.env) {
  const missing = requiredDatabaseConfigs(groups).filter(name => !env[name]?.trim());
  if (groups.includes('backend') && spawnSync('redis-server', ['--version'], { env, stdio: 'ignore' }).status !== 0)
    missing.push('redis-server');
  return missing;
}
