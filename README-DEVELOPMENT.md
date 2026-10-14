# Development and builds

English | [简体中文](README-DEVELOPMENT.zh-CN.md)

LLMOJ is based on LibreOJ and keeps the main MIT license and component notices. See the [README](README.en.md) and [Wiki](wiki/Home.md).

## Toolchain

Node >=22.13; the installer pins 24.21.0. Use package.json's pnpm 11.13.1. Native builds need Linux amd64, CMake, C++, libfmt; execution also needs namespaces and cgroup v2.

```bash
pnpm install --frozen-lockfile
pnpm build:artifacts
pnpm --filter simple-sandbox build
pnpm build:native
pnpm build
pnpm check-types
```

Source archives include testlib. Run `git submodule update --init --recursive` only if its files are missing.

## Runtime configuration

config/*.example are templates. Real config, credentials, data, dependencies, rootfs and build output stay out of source releases. The installer generates them, defaulting to 0.0.0.0:80; internal services stay local. Services retain libreoj-* names; new installations default to /opt/LLMOJ, while an explicit prefix supports existing instance paths. HYHOJ_* variables remain for existing code compatibility; display names use --site-name / OJ_SITE_NAME.

Docker builds rootfs; native simple-sandbox executes submissions. Both installer entry points share the same backend logic, selecting English or Chinese messages. Their standalone bootstrap code is checked for equivalence. See [Docker sources](wiki/Docker-Sources.md).

## Checks and source packaging

```bash
node --test deploy/test/bootstrap-admin.test.mjs
python3 deploy/test/github-entry.test.py
python3 deploy/test/docker-support.test.py
sudo python3 deploy/test/install-support.test.py
sudo python3 deploy/test/install-network.test.py
sudo python3 deploy/test/judge-config.test.py
sudo python3 deploy/test/admin-output.test.py
python3 deploy/test/install-flow.test.py
sudo python3 deploy/test/redis-host.test.py
sudo python3 deploy/test/sandbox-staging.test.py
python3 deploy/prepare-github.py --archive release/llmoj-source.tar.gz
```

Use disposable instances for database/browser integration tests, respecting the constraints in apps/backend/src/ai/README.md. Never use production data or sessions as fixtures. Packaging/exporting only creates local files; it never commits, pushes or publishes.

## Test-data validation checks

From the repository root, run the backend workflow and judge quality suites:

```bash
node --test --test-concurrency=1 apps/backend/src/ai/*.test.cjs
node --test apps/judge/src/aiQuality.test.cjs
```

CI runs both suites and the existing Wiki export/navigation checks. Default tests use mock model, database or sandbox interfaces and require neither production credentials nor a rootfs; optional database tests skip when unconfigured. Backend cases cover quality plans, old job recovery, independent generation requests and publication gates. Judge cases cover differential testing, checker failures, multiple valid outputs, slow-algorithm verdicts and counterexample replacement. The integration-fixture offline checks compile fixed synthetic programs in temporary directories using the local C++ compiler, without connecting to a database or model service.

Real compilation, resource enforcement and protocol execution require a separately configured disposable backend and judge. Mock results do not replace those checks. Exercise independently solvable small inputs, incorrect references, surviving candidates, multiple-answer problems and worst-case constructions. Slow candidates must be correct on small inputs and fail full cases through actual time or memory limits. See the [module test requirements](apps/backend/src/ai/README.md) and the [generation and validation guide](wiki/AI.md#test-data-validation-and-coverage).

## Registration review and upgrade regression checks

Run from the repository root using the required Node version:

```bash
node --test apps/backend/src/auth/registration-review.test.cjs
node --test packages/frontend/test/registration-review.test.cjs
sudo python3 deploy/test/upgrade.test.py
node --test deploy/test/upgrade-schema.test.mjs deploy/test/upgrade-registration.test.mjs
python3 deploy/test/wiki-export.test.py
```

`apps/backend/src/auth/registration-review.mariadb.test.cjs` opts in via `LLMOJ_REGISTRATION_TEST_DATABASE`, a private JSON containing `socketPath`, `database`, `username` and optional `password`. It requires a disposable socket matching `/tmp/llmoj-registration-*/data/mariadb/mysql.sock` or `/var/tmp/llmoj-registration-*/mariadb/mysql.sock`, plus a database matching the test file's `llmoj_registration_test*` / `test_registration_v2*` allowlist, then creates and removes randomly prefixed tables. Do not supply production connections. An unset variable skips this test and is not database validation.

Python upgrade tests use temporary directories and mocked service control; they do not replace a real Ubuntu/systemd upgrade rehearsal. See [Upgrade](wiki/Upgrade.md) for scope, read-only planning and rollback limits.

Check that registration and rejection leave formal user rows and the user-ID sequence unchanged; approval commits all four account tables with the review audit atomically; concurrent/repeated approval creates only one account; pending/rejected applications are absent from public user search and profiles. Targeted review cases should also cover rejected-to-approved, default-denied/delegated access, revocation, denial of permission-management access to reviewers, and blocked `ViewSite` access. Upgrade regression checks cover legacy empty-account/audit archival migration, approved-account preservation, unsafe-reference refusal and repeatability.

The real upgrade migration suite is `deploy/test/upgrade-migration.integration.mjs`. Build the backend first and prepare a dedicated disposable MariaDB plus a synthetic single-database dump from before the review/application tables. Explicitly set `UPGRADE_TEST_ALLOW_DATABASE_CREATION=1`, `UPGRADE_TEST_MARIADB_SOCKET` and `UPGRADE_TEST_BASELINE_SQL`, then run `node deploy/test/upgrade-migration.integration.mjs`. The resolved socket must match the isolated directory allowlist above; dumps containing database switches, cross-database qualifiers or client commands are refused. The suite creates and removes randomly named `libreoj_upgrade_<16 hex digits>` databases and tests credential/audit migration, repeatability, unsafe-reference refusal, cross-database cascades and transaction failures. It also verifies the append-only `ManageRegistrationReviews` enum migration, preservation of existing grants/numeric indexes, and refusal of unknown enum values or order. Missing configuration prints SKIP, which is not an integration pass. Never provide production sockets or dumps.

## Private teams, solutions, Hacks and NOI Self Eval regressions

Build/check the shared protocol, judge handlers, backend and frontend together. The combined release supports exactly NOI / OI, IOI, ICPC and Strict IOI; Self Eval appears only on problem pages in enabled NOI / OI contests. CI covers discussion, progress, file, scoring and strict migration regressions. Tests are under apps/backend/src/team, src/discussion, src/submission, src/file and deploy/test/community-*. Upgrade orchestration uses temporary directories and mocked services.

The default CI Code job starts a disposable MariaDB service on port 3307. `deploy/test/setup-community-ci.mjs` creates separate test databases and accounts restricted to their own database, writes private configurations under `RUNNER_TEMP`, and enables the real database regressions for teams, solutions, Fake moderation, problem/submission mutations and migrations. Database suites run sequentially; the service is discarded after the job. CI also creates the `libreoj` group required by root-owned upgrade fixtures. This does not run an installation, a live systemd cutover or native judging.

Run the following build and isolated orchestration checks from the repository root:

```bash
pnpm --filter @libreoj/judge-protocol run build
pnpm --filter @libreoj/judge run check-types
node apps/judge/src/task/hack/hack.test.cjs
node apps/judge/src/task/self-eval/self-eval.test.cjs
node --test apps/backend/src/hack/hack-reference.test.cjs
node --test apps/backend/src/self-eval/self-eval-noi.test.cjs apps/backend/src/self-eval/self-eval-list.test.cjs
node --test apps/backend/src/contest/contest-rules.test.cjs
pnpm --filter @libreoj/backend run build
pnpm --filter @libreoj/frontend run check-types
node --test deploy/test/community-schema.test.mjs
sudo python3 deploy/test/community-upgrade.test.py
sudo python3 deploy/test/community-runtime-upgrade.test.py
node --test apps/backend/src/self-eval/self-eval.mariadb.test.cjs
python3 deploy/test/wiki-export.test.py
```

For local development, explicitly prepare disposable databases and restricted test accounts, never production connections. The CI setup helper refuses ordinary local invocation; it does not create local fixtures automatically. Private YAML/JSON uses services.database. Enable suites through LLMOJ_TEAM_TEST_DB_CONFIG, LLMOJ_TEAM_AUDIT_DB_CONFIG, LLMOJ_FAKE_TEST_DB_CONFIG, HYHOJ_DISCUSSION_TEST_DB_CONFIG, HYHOJ_COMMUNITY_SCHEMA_TEST_DB_CONFIG, HYHOJ_PROBLEM_TEST_DB_CONFIG or HYHOJ_SUBMISSION_TEST_DB_CONFIG. Complete metadata tests require an empty test database from their source allowlist and clean it afterward; Team workflows also require an empty database and must not share it concurrently with other suites. Skipped tests are not database validation.

Cover personal-only team lists, denial of outsider detail links, nonpublic approval-free teams, limited applicant views and withdrawal, post-departure/archive privacy, publisher/public-flag bypasses, transaction-time revocation and lock ordering, deadlines/Fake scoring, stale judge callbacks, independent copied data, actual file sizes/quota, pagination, My discussions, repeatable migrations and drift refusal. Mocked orchestration and isolated databases do not replace a real Ubuntu/systemd maintenance-cutover rehearsal.

Hack-list and fixed-prediction self-evaluation database regressions opt in with LLMOJ_SELF_EVAL_TEST_DB_CONFIG pointing to a dedicated disposable YAML connection; suites sharing a connection must run sequentially. They check contest-wide quotas, concurrent accounting, hidden prediction sets, NOI-only and pre-contest preparation restrictions, privacy, idempotent callbacks and failure recovery. A skipped suite is not validation.

Isolated browser checks should cover My teams from the own profile, ID-based admission and limited applicant views, embedded problem solutions and My discussions. For Hack, check the eight columns, filters, My hacks, an empty table, ordinary and contest submission detail entries, no list action buttons, the STD editor and the accepted-submission reference shortcut. For Self Eval, check that only NOI contests expose the switch and problem button, ordinary/submission pages have no entry, make/std code editors reuse the formal SPJ, AI regeneration binds matching official-data source versions, and whole-contest quotas and result privacy work. Check centering, spacing, horizontal scrolling and editor width on desktop and mobile.

Reviewed runtime changes are pinned by old/new hashes in deploy/community-runtime-contract.json, whose own digest is fixed by the upgrader. Only individually reviewed protocol/judge files listed in the contract can transition; native programs, dependencies and rootfs remain under the original compatibility checks. Twelve community tables, the nullable STD-content addition to the first Hack table, two contest fields and eight appended permissions have a strict contract; see [Community upgrade](wiki/Community-Upgrade.md). Editing the contract arbitrarily or reordering old enums does not bypass a refusal.
