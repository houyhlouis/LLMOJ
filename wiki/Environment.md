# Environment, builds, and maintenance tools

English | [简体中文](Environment.zh-CN.md) | [Configuration overview](Configuration.md)

Variables are grouped by their consumers. Historical `LIBREOJ_`, `HYHOJ_`, and `OJ_` prefixes remain significant; do not rename them. Exporting a variable in a shell does not change a running systemd service: use a drop-in, daemon-reload, and restart. Keep secret values out of diagnostic output.

## Service environment

| Variable | Meaning and default |
| --- | --- |
| `LIBREOJ_CONFIG_FILE` | Required backend YAML path; installed as `<root>/config/backend.yaml` |
| `LIBREOJ_JUDGE_CONFIG_FILE` | Required judge YAML path; installed as `<root>/config/judge.yaml` |
| `LIBREOJ_JUDGE_LOG_LEVEL` | Judge log level; fallback `info`; Winston levels such as error, warn, info, debug |
| `LIBREOJ_SCHEMA_SYNC` | Exactly `0` disables automatic schema synchronization at backend startup. Unset/other values preserve legacy behavior. The updater applies checked DDL first and installs a dedicated systemd drop-in setting this to 0. Do not enable synchronization to bypass upgrade checks. |
| `LIBREOJ_LOG_SQL` | Backend SQL logging; any nonempty string enables it, including `0` and `false`; remove or empty to disable |
| `NODE_ENV` | Services use `production`; backend production logging selects warn/error; also affects frontend build mode |
| `NODE_OPTIONS` | Generated services use `--max-old-space-size=512`; build scripts use `--max-old-space-size=2300`; MiB of V8 heap, not total process/sandbox memory |
| `UV_THREADPOOL_SIZE` | Judge pool must match slots, at least `2 × slots + 2`; generator uses `max(4, 2N+2)`; see judge configuration |
| `TMPDIR` | Backend generated value `<root>/data/tmp`; must be writable by libreoj |
| `PATH` | systemd puts instance `runtime/node/bin` first; the interactive shell Node version need not match the service |
| `LIBREOJ_MIGRATION_CONFIG_FILE` | When present, backend performs legacy migration instead of HTTP service; one-off offline tool, see below |

For AI runtime variables `HYHOJ_AI_STATE_DIR`, `HYHOJ_AI_GENERATED_DIR`, `HYHOJ_AI_SAMPLE_INPUTS_DIR`, `HYHOJ_AI_RUNNER_SOCKET`, and shared `HYHOJ_ARCHIVE_WORK_DIRECTORY`, see [AI environment](AI-Environment.md) for paths, permissions, and service ownership. `HYHOJ_AI_PRIVATE_HOSTS` has no production consumer and is not a current URL allow switch.

## Installation and generators

These are helper inputs; they do not override existing private configuration.

| Variable | Purpose |
| --- | --- |
| `HYHOJ_ROOT` | Generator instance path; default `/opt/LibreOJ`; does not move existing files |
| `NODE_BINARY` | Generator Node absolute path; default `<root>/runtime/node/bin/node` |
| `HYHOJ_PORT` | Website generator port; default `80`; also read during local judge generation |
| `HYHOJ_PUBLIC_ORIGIN` | Website generator origin; default loopback HTTP with port when not 80; installer passes detected/specified origin |
| `OJ_LISTEN_ADDRESS` | `configure-local.py` default `0.0.0.0`; alternatively `127.0.0.1` |
| `OJ_INSTALL_ROLE` | Generator default `all`, alternative `web`; not an online role-switch flag |
| `OJ_SITE_NAME` | Generator/local frontend title; default `LLMOJ`; existing backend YAML is retained |
| `OJ_JUDGE_REMOTE` | Judge generator uses remote mode only for `1`; default `0` |
| `OJ_JUDGE_SERVER` | Required remote HTTP(S) site origin; local internal connection is generated |
| `OJ_JUDGE_KEY_FILE` | Required remote key-file absolute path; root-owned mode 0600; contains node key |
| `OJ_JUDGE_SLOTS` | Positive initial slot override; absent uses `max(1, effective CPUs-2)`, environment `0` is rejected; CPU/RAM and 511 limit apply; existing YAML is retained |
| `HYHOJ_JUDGE_SLOTS` | Legacy alias read only when `OJ_JUDGE_SLOTS` is absent; same constraints |
| `LLMOJ_INSTALL_LANG` | Installer/helper language: `zh-CN` selects Chinese, otherwise English; entry scripts select it |
| `OJ_SOURCE_REPOSITORY` | Download-entry source repository metadata; internal provenance, not credentials or runtime configuration |
| `OJ_SOURCE_COMMIT` | Resolved source commit metadata; not an installed-version override |
| `LIBREOJ_ROOT` | Administrator bootstrap root fallback only; default `/opt/LibreOJ`; `--root` takes precedence |
| `INVOCATION_ID / JOURNAL_STREAM` | Provided by systemd; administrator helper uses them to avoid printing credentials to background service logs; do not spoof |

## Builds, rootfs, and optional legacy deployment

| Variable | Purpose |
| --- | --- |
| `HYHOJ_PUBLIC_DIR` | Local frontend output, default `<root>/public`; does not change Nginx root |
| `HYHOJ_QUOTE_FILE` | Optional local licensed quotation JSON; omitted means no retired hitokoto asset |
| `PNPM_BINARY` | pnpm command/path used by frontend `--build`; default `pnpm` |
| `CMAKE_BUILD_PARALLEL_LEVEL` | Native build parallelism; installer explicitly sets `2` |
| `npm_config_nodedir` | Native Node headers root; installer sets `<root>/runtime/node` |
| `pnpm_config_verify_deps_before_run` | Installer sets `false` for pnpm dependency verification before script execution |
| `RUNTIME_DIRECTORY` | Rootfs wrapper runtime directory, default `<repo>/runtime` |
| `OUTPUT_DIRECTORY` | Wrapper default `<runtime>/sandbox-archives`; direct infra build default is its `dist` |
| `LIBREOJ_X32_SUPPORTED` | Rootfs host tests accept `0`/`1`; fallback `1`, installer uses `0` to skip host x32 execution; other sandbox tests still run |
| `ARCHIVE / CHECKSUM / DESTINATION_PARENT` | Required absolute archive/checksum/destination-parent paths for rootfs staging; normally supplied by wrapper |
| `BUILDX_BUILDER` | Docker Buildx builder selector used by the remote guide; LLMOJ defines no default |
| `CLOUDFLARE_WORKER_NAME / CLOUDFLARE_ACCOUNT_ID` | Required for optional legacy bootstrap-cloudflare configuration; unused by one-click deployment |
| `ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET / ALIYUN_OSS_BUCKET / ALIYUN_OSS_ENDPOINT` | Required for optional legacy bootstrap-static OSS deployment; executing it uploads to external storage; unused by one-click deployment |

One-click scripts explicitly set `NODE_OPTIONS`, `CMAKE_BUILD_PARALLEL_LEVEL`, `npm_config_nodedir`, and `pnpm_config_verify_deps_before_run`; outer values are not installer override interfaces. `ROOTFS_ID` is derived from recipe content, not an arbitrary version setting. Shell built-ins and every compiler/dependency environment option are not duplicated here; for example, `DEBUG` in a patch belongs to Vite plugin diagnostics. Test-only variables are documented separately in AI environment, not as production settings.

## Deployment-test environment only

`LIBREOJ_ADMIN_TEST_SOCKET` selects a MariaDB socket for administrator bootstrap integration tests; absent means skip, and enabling it accesses the test database. `LIBREOJ_TEST_NODE` selects Node for administrator-output tests, falling back to PATH. `ENTRY_FIXTURE`, `TEST_DOCKER_FAILURE`, and `TEST_DOCKER_EXPORT` are internal deployment-test fixture paths/failure controls/export files, without production effect. AI/backend integration variables are listed in [AI environment](AI-Environment.md).

`HYHOJ_TEST_CHECKER_BINARY` selects the `.node` binary for native token-checker tests, default `../../build/Release/builtin_checkers.node`; it does not change the production judge checker.

The additional backend regression variables below are also test-only. Database suites create and modify randomly prefixed tables, then clean them up. Select a disposable test database explicitly: these CJS suites do not uniformly require the `hyhoj_test_*` naming guard. Result-file parent directories must already exist and be writable; unset output paths mean no corresponding JSON file is written.

| Variable | Default / purpose | Consumer test |
| --- | --- | --- |
| `LLMOJ_REGISTRATION_TEST_DATABASE` | Private JSON for the isolated registration-review database test; unset skips it. See the development guide for socket/database guards. | `registration-review.mariadb.test.cjs` |
| `HYHOJ_DISCUSSION_TEST_DB_CONFIG` | Backend YAML path containing `services.database`; unset skips the real MariaDB discussion-boundary suite | `discussion-boundaries.mariadb.test.cjs` |
| `HYHOJ_DISCUSSION_TEST_EVIDENCE` | Optional JSON evidence path for boundary cases and temporary-table cleanup | Same suite |
| `HYHOJ_COUNT_TEST_SERVICE_BASELINE` | Optional baseline source root preserving the `apps/backend/src/...` layout; substitutes only loaded `discussion.service.ts` and `group.service.ts`. Unset uses current source | `group-discussion-counts.mariadb.test.cjs` |
| `HYHOJ_COUNT_TEST_DB_CONFIG` | YAML path containing `services.database`; unset skips the real MariaDB concurrent-counter suite | Same suite |
| `HYHOJ_COUNT_TEST_RESULTS` | Optional JSON results path for counter cases and temporary-table cleanup | Same suite |
| `HYHOJ_SUBMISSION_TEST_BASELINE` | Optional baseline `submission.service.ts` file; unset uses the current file. Other modules still use current source | `submission-delete.mariadb.test.cjs` |
| `HYHOJ_SUBMISSION_TEST_DB_CONFIG` | YAML path containing `services.database`; unset skips the real MariaDB submission deletion/counter suite | Same suite |
| `HYHOJ_SUBMISSION_TEST_OUTPUT` | Optional JSON results path | Same suite |
| `HYHOJ_PROBLEM_TEST_BASELINE` | Optional baseline `problem.service.ts` file; unset uses the current file. Other modules still use current source | `problem-mutations.mariadb.test.cjs` |
| `HYHOJ_PROBLEM_TEST_DB_CONFIG` | YAML path containing `services.database`; unset skips the real MariaDB problem mutation/file-ownership suite | Same suite |
| `HYHOJ_PROBLEM_TEST_REPORT` | Optional JSON report path | Same suite |
| `TEST_JUDGE_GATEWAY_SOURCE` | Optional gateway source path, defaulting to `judge.gateway.ts` beside the test. Extracts actual method bodies and runs them with mocked sockets/queues, without connecting to live judges or Redis | `judge-gateway.test.cjs` |
| `TEST_JUDGE_GATEWAY_RESULTS` | Optional JSON evidence path, including source hash and case records | Same suite |
| `SWC_NODE_PROJECT` | TypeScript configuration selector for `@swc-node/register`. This repository's privacy test **overwrites it** with `<source-root>/apps/backend/tsconfig.json`; not an external override offered by that test or a production service setting | `config-privacy.test.cjs` |

Sources: [discussion boundaries](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/discussion/discussion-boundaries.mariadb.test.cjs), [discussion/group counters](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/group/group-discussion-counts.mariadb.test.cjs), [submission deletion](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/submission/submission-delete.mariadb.test.cjs), [problem mutations](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/problem/problem-mutations.mariadb.test.cjs), [judge gateway](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/judge/judge-gateway.test.cjs), [private configuration diagnostics](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/config/config-privacy.test.cjs).

## Legacy migration configuration

`LIBREOJ_MIGRATION_CONFIG_FILE` points to legacy settings containing `database.host` (string), `database.port` (number), `database.username`, `database.password`, `database.database` (strings), and `uploads` (string, legacy attachment path). The interface supplies no defaults. Migration converts/writes data; do not leave it enabled in the regular backend service. It is not the current-version upgrade workflow.

## Maintenance argument index

| Tool | Arguments and behavior |
| --- | --- |
| `upgrade.zh-CN.sh` / `upgrade.sh` → `deploy/upgrade.sh` | `--prefix`, `--plan`, `--ref`, `--source`, `--source-sha256`, `--apply --drained`, `--rollback BACKUP --drained`; see [Upgrade](Upgrade.md) for compatibility, maintenance and rollback rules |
| `deploy/resize-judge.sh` (implementation: `resize-judge.py`) | Maintained existing-judge entry: `--prefix` (default `/opt/LibreOJ`), `--slots`, `--plan`, `--apply --drained`, `--rollback PRIVATE_BACKUP --drained`, `--mode auto\|all\|remote`; default Chinese interaction; see [resizing](Judge-Configuration.md) |
| `deploy/judge_capacity.py` | Read-only capacity check: `--remote`, `--json`, `--slots N`; reads affinity/cgroup/RAM, without creating workspaces or changing services |
| `deploy/initialize-mariadb.py` | Internal installer tool, required `--root`; stages initialization as mysql and validates system tables, preserving and checking nonempty existing databases; not an online upgrade/reset interface |
| `deploy/bootstrap-admin.mjs` | `--root`, `--config`, `--email`, `--show-credentials`; root/config flags override their environment fallbacks; email defaults to `admin@localhost.invalid` for initialization; credentials are verified before display, not a password-reset interface |
| `deploy/bootstrap-services.mjs` | Required `--root` and `--phase storage\|judge\|verify-judge`; `--help`; creates storage, registers local judge, or verifies connection |
| `deploy/sandbox/verify-installed.mjs` | Optional `--root` (default `/opt/LibreOJ`); runs real sandbox probes, not a read-only YAML validator |
| `deploy/build-frontend-offline.mjs` | `--assets-only` stages assets; `--build` builds first; no flag publishes existing dist; see frontend reference |
| `deploy/docker-support.py` | `--source` defaults to official source; `--mirrors` empty; `--configure` merges/writes mirror configuration without restarting Docker; otherwise only validates arguments |
| `deploy/install-support.py` | Internal phases `validate`, `preflight`, `claim`, `permissions`, `apparmor`, `database`, `verify-network`, `finish`; required `--root`, `--origin`, `--port`, plus `--listen`, `--role`, `--site-name`, `--docker-source`, `--docker-mirrors`, `--judge-slots` matching installer meanings; not an upgrade interface |
| `deploy/sandbox/build.sh` | Positional `plan` (default), `build`, or `stage ABS_ARCHIVE`; environment above |
| `deploy/export-wiki.py` | Required `--repository OWNER/REPO`, `--output DIR`; local document export only; see Publishing |
| `deploy/prepare-github.py` | Optional `--archive PATH`; source selection/archive helper requiring a readable Git file list; refuses to replace an archive |
| `deploy/backup.sh` | No arguments; currently fixed to `/opt/LibreOJ`; stops services, backs up, restores target; custom prefixes need a matching backup procedure |

Audited sources: [deploy/configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-local.py), [deploy/configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py), [deploy/install.sh](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/install.sh), [deploy/build-frontend-offline.mjs](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/build-frontend-offline.mjs), [apps/backend/src/main.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/main.ts), [apps/backend/src/migration/migration-config.schema.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/migration/migration-config.schema.ts), [apps/judge/src/config.ts](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/config.ts).

The new capacity, database initialization and resize tools belong to the pending revision; verify that their `main` links match the deployed release after publication.
