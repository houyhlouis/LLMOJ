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

config/*.example are templates. Real config, credentials, data, dependencies, rootfs and build output stay out of source releases. The installer generates them, defaulting to 0.0.0.0:80; internal services stay local. Services retain libreoj-* names and /opt/LibreOJ paths. HYHOJ_* variables remain for existing code compatibility; display names use --site-name / OJ_SITE_NAME.

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
