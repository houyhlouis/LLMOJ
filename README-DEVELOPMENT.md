# Development

English | [简体中文](README-DEVELOPMENT.zh-CN.md)

LLMOJ is based on [LibreOJ](https://github.com/libreoj/libreoj) and released under the MIT license; keep the notices of every component. For what LLMOJ does and how to install it, see the [README](README.en.md) and the [wiki](wiki/Home.en.md).

## Toolchain

- Node.js 22.13 or later (installations use 24.21.0) and pnpm 11.13.1, as set in `package.json`.
- For the judge's native code: Linux on amd64, CMake, a C++ compiler and libfmt.
- To actually run programs in the sandbox: namespaces and cgroup v2.

## Building

```bash
pnpm install --frozen-lockfile
pnpm build:artifacts            # shared protocol and bootstrap packages
pnpm --filter simple-sandbox build
pnpm build:native               # the sandbox and judge's native add-ons
pnpm build
pnpm check-types
```

testlib is included in source archives. Run `git submodule update --init --recursive` only if `apps/judge/vendor/testlib/testlib.h` is missing.

`pnpm check` runs what CI's first step runs: the build, type checks, lint and formatting checks.

### The frontend's API client

`packages/frontend/src/api-generated` is generated from the backend's controllers and DTOs, and `packages/frontend/test/api-contract.test.cjs` fails when it's out of date. After changing a controller or a DTO, build the backend and regenerate the client. No running server is needed:

```bash
pnpm --filter @libreoj/backend build
node packages/frontend/scripts/generate-api.js --from-backend-build
```

## Layout and configuration

| Directory | Contents |
| --- | --- |
| `apps/backend` | NestJS backend |
| `apps/judge` | Judge |
| `packages/frontend` | React frontend |
| `packages/judge-protocol` | Messages shared by the backend and the judge |
| `packages/simple-sandbox` | Native sandbox |
| `deploy` | Installer, upgrader and maintenance scripts, and their tests |
| `wiki` | Documentation, published to the GitHub wiki (see [Publishing](wiki/Publishing.md)) |

`config/*.example` are templates. Real configuration, passwords, data, dependencies, the sandbox image and build output never go into the repository; the installer creates them. Services keep their `libreoj-*` names and the `HYHOJ_*` variables keep their names for compatibility. The site's display name comes from `--site-name` (`OJ_SITE_NAME`).

The judge's sandbox image is built with Docker, and submissions run in the native `simple-sandbox`. The English and Chinese installers share the same code and differ only in their messages; a test checks that their download scripts stay identical apart from that. See [Docker sources](wiki/Docker-Sources.md).

## Tests

Tests are run with `node --test` or `python3` from the repository root. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the following on every push; run the parts you touch before committing.

```bash
# backend, by area
node --test --test-concurrency=1 apps/backend/src/ai/*.test.cjs
node apps/backend/src/access/access-permissions.test.cjs
node --test --test-concurrency=1 apps/backend/src/access/capability-cache.test.cjs \
  apps/backend/src/access/route-access.test.cjs apps/backend/src/access/permission-matrix.mariadb.test.cjs \
  apps/backend/src/site-management/*.test.cjs
node --test --test-concurrency=1 apps/backend/src/discussion/*.test.cjs apps/backend/src/team/*.test.cjs \
  apps/backend/src/hack/*.test.cjs apps/backend/src/self-eval/*.test.cjs apps/backend/src/contest/*.test.cjs \
  apps/backend/src/judge/*.test.cjs apps/backend/src/auth/*.test.cjs apps/backend/src/auth/two-factor/*.test.cjs \
  apps/backend/src/submission/*.test.cjs apps/backend/src/problem/*.test.cjs apps/backend/src/file/*.test.cjs \
  apps/backend/src/database/database-providers.test.cjs

# judge
node --test apps/judge/src/aiQuality.test.cjs apps/judge/src/task/hack/hack.test.cjs \
  apps/judge/src/task/self-eval/self-eval.test.cjs apps/judge/src/rpc.test.cjs \
  apps/judge/src/executionScheduler.test.cjs apps/judge/src/selfTestConfig.test.cjs

# frontend
node --test packages/frontend/test/*.test.cjs

# database schema and migrations
node --test deploy/test/upgrade-schema.test.mjs deploy/test/community-schema.test.mjs \
  deploy/test/team-storage.test.mjs deploy/test/upgrade-registration.test.mjs
node --test deploy/test/community-schema.mariadb.test.mjs deploy/test/initialize-schema.test.mjs
node --test deploy/fake-migration.test.cjs

# installer, upgrader and wiki
python3 deploy/test/install-flow.test.py
python3 deploy/test/backup.test.py
sudo python3 deploy/test/community-upgrade.test.py
sudo python3 deploy/test/community-runtime-upgrade.test.py
python3 deploy/test/wiki-export.test.py
```

Other deployment tests aren't in CI because they need root, systemd or a real installation layout:

```bash
sudo python3 deploy/test/upgrade.test.py
sudo python3 deploy/test/install-support.test.py
sudo python3 deploy/test/install-network.test.py
sudo python3 deploy/test/judge-config.test.py      # needs node on sudo's PATH
sudo python3 deploy/test/resize-judge.test.py
sudo python3 deploy/test/admin-output.test.py
sudo python3 deploy/test/redis-host.test.py
sudo python3 deploy/test/sandbox-staging.test.py
python3 deploy/test/judge-capacity.test.py
python3 deploy/test/judge-prompt.test.py
python3 deploy/test/github-entry.test.py
python3 deploy/test/docker-support.test.py
node --test deploy/test/bootstrap-admin.test.mjs
```

These use temporary directories and simulated services: they don't replace trying an installation or upgrade on a real Ubuntu server.

### Database tests

Tests named `*.mariadb.test.*` (and a few others) use a real MariaDB. Each is skipped unless its variable names a private YAML file with a `services.database` section, or for registration a JSON file. A skipped test proves nothing.

**Only ever point them at a disposable database**: they create and drop tables, and some require an empty database. Never use a production database, data or sessions. Run suites that share a database one after another.

| Variable | Tests |
| --- | --- |
| `HYHOJ_DISCUSSION_TEST_DB_CONFIG` | `discussion/discussion-{boundaries,visibility,solutions}.mariadb.test.cjs` |
| `HYHOJ_PROBLEM_TEST_DB_CONFIG` | `problem/problem-mutations.mariadb.test.cjs` |
| `HYHOJ_SUBMISSION_TEST_DB_CONFIG` | `submission/submission-delete.mariadb.test.cjs` |
| `HYHOJ_COUNT_TEST_DB_CONFIG` | `group/group-discussion-counts.mariadb.test.cjs` |
| `HYHOJ_COMMUNITY_SCHEMA_TEST_DB_CONFIG` | `deploy/test/community-schema.mariadb.test.mjs` |
| `HYHOJ_AI_TEST_DB_CONFIG` | `ai/ai-*.mariadb.test.cjs` (see the [AI test guide](apps/backend/src/ai/README.md)) |
| `LLMOJ_TEAM_TEST_DB_CONFIG` | `team/team-workflows.mariadb.test.cjs` (empty database) |
| `LLMOJ_TEAM_AUDIT_DB_CONFIG` | `team/team-permission-audit.mariadb.test.cjs` (empty database) |
| `LLMOJ_FAKE_TEST_DB_CONFIG` | `submission/submission-fake.mariadb.test.cjs`, `deploy/fake-migration.test.cjs` |
| `LLMOJ_SELF_EVAL_TEST_DB_CONFIG` | `hack/hack-list.mariadb.test.cjs`, `self-eval/self-eval.mariadb.test.cjs` |
| `LLMOJ_TWO_FACTOR_TEST_DB_CONFIG` | `auth/two-factor/two-factor.mariadb.test.cjs` |
| `LLMOJ_JUDGE_QUEUE_TEST_DB_CONFIG` | `judge/judge-queue.test.cjs` |
| `LLMOJ_DATA_VERSION_TEST_DB_CONFIG` | `submission/submission-data-version.mariadb.test.cjs` |
| `LLMOJ_AI_BUDGET_TEST_DB_CONFIG` | `ai/ai-budget.mariadb.test.cjs` (empty database) |
| `LLMOJ_ACCESS_MATRIX_TEST_DB_CONFIG` | `access/permission-matrix.mariadb.test.cjs` (empty database) |
| `LLMOJ_SCHEMA_TEST_DB_CONFIG` | `deploy/test/initialize-schema.test.mjs` |
| `LLMOJ_REGISTRATION_TEST_DATABASE` | `auth/registration-review.mariadb.test.cjs`, `site-management/registration-settings.mariadb.test.cjs` |

Paths under `apps/backend/src/` are shortened. `LLMOJ_REGISTRATION_TEST_DATABASE` names a JSON file with `socketPath`, `database`, `username` and optionally `password`; the socket must match `/tmp/llmoj-registration-*/data/mariadb/mysql.sock` or `/var/tmp/llmoj-registration-*/mariadb/mysql.sock`, and the database name must start with `llmoj_registration_test` or `test_registration_v2`.

Some suites also accept an output file for their results (`HYHOJ_DISCUSSION_TEST_EVIDENCE`, `HYHOJ_COUNT_TEST_RESULTS`, `HYHOJ_SUBMISSION_TEST_OUTPUT`, `HYHOJ_PROBLEM_TEST_REPORT`, `LLMOJ_TEAM_TEST_REPORT`, `HYHOJ_AI_TEST_RESULTS`), whose directory must already exist, or a baseline source file to compare against (`HYHOJ_COUNT_TEST_SERVICE_BASELINE`, `HYHOJ_SUBMISSION_TEST_BASELINE`, `HYHOJ_PROBLEM_TEST_BASELINE`). Other test-only variables: `TEST_JUDGE_GATEWAY_SOURCE` and `TEST_JUDGE_GATEWAY_RESULTS` (judge gateway test), `HYHOJ_TEST_CHECKER_BINARY` (native checker test), `HYHOJ_TEST_EVIDENCE_DIR` (AI browser test screenshots), `LIBREOJ_ADMIN_TEST_SOCKET` and `LIBREOJ_TEST_NODE` (administrator script tests), `LLMOJ_MARIADB_BINARY` (the `mariadb` client used by the Fake migration test), and `ENTRY_FIXTURE`, `TEST_DOCKER_FAILURE` and `TEST_DOCKER_EXPORT` (installer test fixtures).

In CI, a disposable MariaDB service runs on port 3307 and `deploy/test/setup-community-ci.mjs` creates a separate database and restricted account for each suite, writing their configuration under `RUNNER_TEMP`. It refuses to run outside CI; locally, create your own disposable databases.

### Upgrade migration test

`deploy/test/upgrade-migration.integration.mjs` tests the registration data migration on a real database. Build the backend, prepare a disposable MariaDB and a single-database SQL dump from before registration applications existed, then:

```bash
UPGRADE_TEST_ALLOW_DATABASE_CREATION=1 \
UPGRADE_TEST_MARIADB_SOCKET=/var/tmp/llmoj-registration-test/mariadb/mysql.sock \
UPGRADE_TEST_BASELINE_SQL=/path/to/dump.sql \
node deploy/test/upgrade-migration.integration.mjs
```

The socket must match the pattern above, and dumps that switch databases or run client commands are refused. It creates and drops databases named `libreoj_upgrade_<16 hex digits>`. Without its variables it prints SKIP.

### Judge and sandbox

```bash
pnpm --filter @libreoj/judge test:native
```

To run the sandbox's own checks, and the judge self-test against an installation:

```bash
sudo systemd-run --wait --pipe --collect --property="Delegate=cpu memory pids" \
  --property=DelegateSubgroup=supervisor --property=OOMPolicy=continue \
  --working-directory="$PWD" "$(command -v node)" packages/simple-sandbox/demo/demo.js
sudo bash /opt/LLMOJ/deploy/sandbox/self-test.sh
```

CI runs the native tests and the demo whenever native code changes.

### AI

Default AI tests use simulated models, databases and sandboxes, and need no credentials or sandbox image. The fixture checks compile small programs with the local C++ compiler. Real compilation, resource limits and protocol execution need a disposable backend and judge. See the [AI test guide](apps/backend/src/ai/README.md) and [test data validation](wiki/AI.md#test-data-validation-and-coverage).

### In a browser

Check pages you change at desktop and mobile widths, in both languages, including empty lists, long content and horizontal scrolling of wide tables.

## Source archives

```bash
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
```

This only creates a local file from what Git tracks; it never commits, pushes or publishes. See [Publishing](wiki/Publishing.md).
