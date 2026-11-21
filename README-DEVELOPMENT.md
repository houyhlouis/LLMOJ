# Development

English | [简体中文](README-DEVELOPMENT.zh-CN.md)

LLMOJ is based on [LibreOJ](https://github.com/libreoj/libreoj) and released under the MIT license; keep the notices of every component. For what LLMOJ does and how to install it, see the [README](README.en.md) and the [wiki](wiki/Home.en.md).

## Toolchain

- Node.js 24.21 (`.node-version`; installations use exactly 24.21.0) and pnpm 11.13.1 (`packageManager` in `package.json`). The other pinned versions, what isn't upgraded yet, and how to check the dependencies for advisories are in [Dependencies](wiki/Dependencies.md).
- For the judge's native code: Linux on amd64 or arm64, CMake, a C++ compiler and libfmt. C and C++ submissions build for the judge machine's architecture (`apps/judge/src/architecture.ts`); arm64 has no 32-bit toolchain.
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

## Running it locally

`deploy/dev/stack.mjs` starts a disposable MariaDB, Redis and MinIO for the backend and the frontend's development server, adds sample data if you want, and removes it all again, without root: see [Local development](wiki/Development.md). [Using the API](wiki/API.md) describes the HTTP API's conventions, and [Capacity](wiki/Capacity.md#repeating-the-measurement) the benchmark kit in `deploy/benchmark`.

## Tests

```bash
pnpm test
```

runs every suite, through [deploy/test/run-tests.mjs](deploy/test/run-tests.mjs), and ends with a summary. Name groups to run only those, for example `pnpm test backend frontend`: `ai`, `judge`, `backend`, `frontend`, `deploy` and `wiki`. Build first (`pnpm build`): the schema and API contract suites read the built backend. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the same groups with `--ci`.

Before any suite starts, the runner checks that every test file in the repository belongs to exactly one group or to an exclusion with a written reason ([deploy/test/suite-inventory.mjs](deploy/test/suite-inventory.mjs)): a new test file that isn't registered, or one registered twice, stops the run. Register a new suite in `deploy/test/run-tests.mjs` (a MariaDB suite also needs its database in `deploy/test/setup-community-ci.mjs`). The deployment suites are classified there, each with its reason: portable ones run as a normal user, those that need root run through `sudo` (in CI too), and host acceptance tests that need a real installation stay out of CI. With `--ci`, a missing database variable or `redis-server` that CI provides stops the run instead of letting suites skip. The summary lists, for each suite, how many cases ran and were skipped, and why.

Suites that need something this machine lacks skip those cases, and the summary says what was missing:

- **MariaDB:** the [database tests](#database-tests) below need their variables;
- **redis-server**, for the judge queue and Redis suites;
- **root**, for the deployment suites' cases that create accounts, mount file systems or run services. The runner uses passwordless `sudo` when it can, as CI does (set `LLMOJ_TEST_NO_SUDO=1` to stop it even trying), and runs Python with `-B` so that no root-owned cache files appear in the tree;
- **MinIO** (`LLMOJ_MINIO_BINARY`, or an installation's `runtime/minio`), for the upload sealing test and the backup verifier's content check;
- **2 GiB in `TMPDIR`**, for the AI suites' ZIP archives. The runner uses `/var/tmp` when the temporary directory is smaller;
- **Chrome or Chromium** (`LLMOJ_TEST_CHROME`, or `google-chrome` or `chromium` on `PATH`), for the test that the site removes the old bootstrap service worker. It runs the browser headless and without its sandbox, on local test pages only.

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
| `LLMOJ_JUDGE_INFO_CACHE_TEST_DB_CONFIG` | `problem/problem-judge-info-cache.mariadb.test.cjs` (cached judge settings after a type change; also needs `redis-server`) |
| `LLMOJ_STATISTICS_CACHE_TEST_DB_CONFIG` | `submission/submission-statistics-cache.mariadb.test.cjs` (practice statistics cache against late reads; also needs `redis-server`) |
| `LLMOJ_CONTEST_VIRTUAL_TEST_DB_CONFIG` | `contest/contest-virtual-start.mariadb.test.cjs` (starting virtual runs against concurrent submissions and edits; database `llmoj_test_contest_virtual`, empty) |
| `LLMOJ_DIAGNOSTIC_BUNDLE_TEST_DB_CONFIG` | `site-management/diagnostic-bundle.mariadb.test.cjs` (the diagnostic bundle's stored jobs, queue and judge state; database `llmoj_test_diagnostic_bundle`, empty; also needs `redis-server`) |
| `LLMOJ_NARROW_WRITES_TEST_DB_CONFIG` | `user/user-narrow-writes.mariadb.test.cjs`, `submission/submission-visibility.mariadb.test.cjs` (concurrent changes during profile, email and visibility updates; their own random tables) |
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
node --test packages/simple-sandbox/test/cgroup-events.test.mjs
```

The second builds a small C++ program around the sandbox's cgroup event waiter and checks that it closes its descriptors, also when the events file is malformed (it needs g++ and libfmt, and skips without them). The judge group of `pnpm test` runs it too, with `packages/simple-sandbox/test/sandbox-process.test.cjs`, which checks the sandbox's cleanup when its native calls fail.

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

### Passkeys

[webauthn-conformance.test.cjs](apps/backend/src/auth/two-factor/webauthn-conformance.test.cjs) runs the site's WebAuthn verifier on the W3C test vectors, on changed copies of them that must be refused, and on a software authenticator's ceremonies ([webauthn-fixtures.cjs](apps/backend/src/auth/two-factor/webauthn-fixtures.cjs)). To weigh another implementation, such as a maintained library, write an adapter for the `WebAuthnVerifier` interface in [webauthn.ts](apps/backend/src/auth/two-factor/webauthn.ts) and run it on the same cases. Replace the verifier only when the answers agree, or each difference is understood: libraries also check attestation, which this site doesn't request, and may accept ceremonies in another site's frame, which this site refuses.

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
