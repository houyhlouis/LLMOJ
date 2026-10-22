# Development

English | [简体中文](README-DEVELOPMENT.zh-CN.md)

LLMOJ is based on [LibreOJ](https://github.com/libreoj/libreoj) and released under the MIT license; keep the notices of every component. For what LLMOJ does and how to install it, see the [README](README.en.md) and the [wiki](wiki/Home.en.md).

## Toolchain

- Node.js 24.21 (`.node-version`; installations use exactly 24.21.0) and pnpm 11.13.1 (`packageManager` in `package.json`). The other pinned versions, what isn't upgraded yet, and how to check the dependencies for advisories are in [Dependencies](wiki/Dependencies.md).
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

```bash
pnpm test
```

runs every suite, through [deploy/test/run-tests.mjs](deploy/test/run-tests.mjs), and ends with a summary. Name groups to run only those, for example `pnpm test backend frontend`: `ai`, `judge`, `backend`, `frontend`, `deploy` and `wiki`. Build first (`pnpm build`): the schema and API contract suites read the built backend. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the same lists with `--ci`, except the deployment suites that need Ubuntu 26.04's Python and system tools; those run with `pnpm test` on such a machine.

Suites that need something this machine lacks skip those cases, and the summary says what was missing:

- **MariaDB:** the [database tests](#database-tests) below need their variables;
- **redis-server**, for the judge queue and Redis suites;
- **root**, for the deployment suites' cases that create accounts, mount file systems or run services. The runner uses passwordless `sudo` when it can, as CI does, and runs Python with `-B` so that no root-owned cache files appear in the tree;
- **MinIO** (`LLMOJ_MINIO_BINARY`, or an installation's `runtime/minio`), for the backup verifier's content check;
- **2 GiB in `TMPDIR`**, for the AI suites' ZIP archives. The runner uses `/var/tmp` when the temporary directory is smaller.

These use temporary directories and simulated services: they don't replace trying an installation or upgrade on a real Ubuntu server.

### Database tests

Tests named `*.mariadb.test.*` (and a few others) use a real MariaDB. Each is skipped unless its variable names a private YAML file with a `services.database` section, or for registration a JSON file. A skipped test proves nothing.

**Only ever point them at a disposable database**: they create and drop tables, and some require an empty database. Never use a production database, data or sessions. Run suites that share a database one after another.

| Variable | Tests |
| --- | --- |
| `HYHOJ_DISCUSSION_TEST_DB_CONFIG` | `discussion/discussion-{boundaries,visibility,solutions}.mariadb.test.cjs` |
| `HYHOJ_PROBLEM_TEST_DB_CONFIG` | `problem/problem-mutations.mariadb.test.cjs`, `study-list/study-list.mariadb.test.cjs` |
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
| `LLMOJ_OPERATIONS_TEST_DB_CONFIG` | `metrics/operational-metrics.mariadb.test.cjs`, `contest/contest-score-revision.mariadb.test.cjs`, `ai/ai-execution.mariadb.test.cjs` (drops all its tables) |
| `LLMOJ_SCHEMA_TEST_DB_CONFIG` | `deploy/test/initialize-schema.test.mjs` |
| `LLMOJ_REGISTRATION_TEST_DATABASE` | `auth/registration-review.mariadb.test.cjs`, `site-management/registration-settings.mariadb.test.cjs` |

Paths under `apps/backend/src/` are shortened. `LLMOJ_REGISTRATION_TEST_DATABASE` names a JSON file with `socketPath`, `database`, `username` and optionally `password`; the socket must match `/tmp/llmoj-registration-*/data/mariadb/mysql.sock` or `/var/tmp/llmoj-registration-*/mariadb/mysql.sock`, and the database name must start with `llmoj_registration_test` or `test_registration_v2`.

Some suites also accept an output file for their results (`HYHOJ_DISCUSSION_TEST_EVIDENCE`, `HYHOJ_COUNT_TEST_RESULTS`, `HYHOJ_SUBMISSION_TEST_OUTPUT`, `HYHOJ_PROBLEM_TEST_REPORT`, `LLMOJ_TEAM_TEST_REPORT`, `HYHOJ_AI_TEST_RESULTS`), whose directory must already exist, or a baseline source file to compare against (`HYHOJ_COUNT_TEST_SERVICE_BASELINE`, `HYHOJ_SUBMISSION_TEST_BASELINE`, `HYHOJ_PROBLEM_TEST_BASELINE`). Other test-only variables: `TEST_JUDGE_GATEWAY_SOURCE` and `TEST_JUDGE_GATEWAY_RESULTS` (judge gateway test), `HYHOJ_TEST_CHECKER_BINARY` (native checker test: another built `builtin_checker` program), `HYHOJ_TEST_EVIDENCE_DIR` (AI browser test screenshots), `LIBREOJ_ADMIN_TEST_SOCKET` and `LIBREOJ_TEST_NODE` (administrator script tests), `LLMOJ_MARIADB_BINARY` (the `mariadb` client used by the Fake migration test), and `ENTRY_FIXTURE`, `TEST_DOCKER_FAILURE` and `TEST_DOCKER_EXPORT` (installer test fixtures).

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

Check pages you change at desktop and mobile widths, in both languages, including empty lists, long content and horizontal scrolling of wide tables. The pages are built for the [supported browsers](wiki/Dependencies.md#supported-browsers).

Every control must also work with the keyboard alone (see [Keyboard and screen readers](wiki/Accessibility.md)):

- **Clickable items:** Semantic UI renders a `Menu.Item`, `Label` or `Icon` that only has an `onClick` as an element that Tab never reaches. Spread `actsAsButton` from `@/utils/keyboard` on it, and give an icon an `aria-label`.
- **Dropdowns built from `Dropdown.Item` children** (instead of `options`) need `keyboardMenu`, so the arrow keys and Enter can choose their items.
- **Messages for screen readers:** `announce()` from `@/utils/announce` reads one out. Toasts already are.

`packages/frontend/test/keyboard-access.test.cjs` fails on clickable elements that have neither. `locale-parity.test.cjs` fails on a message missing from one language, or a translation that drops a placeholder.

## Source archives

```bash
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
```

This only creates a local file from what Git tracks; it never commits, pushes or publishes. See [Publishing](wiki/Publishing.md).
