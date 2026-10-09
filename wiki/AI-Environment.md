# AI runtime environment and fixed limits

English | [简体中文](AI-Environment.zh-CN.md) | [Account AI configuration](AI.md) | [All environment variables](Environment.md) | [Judge configuration](Judge-Configuration.md)

This page was checked against source revision `43a88bdd62fbf200889b36932fa921439a293190`. These runtime variables control directories and communication between the backend and its local AI runner. Provider keys, base URLs, models, output budgets and per-user concurrency belong to the encrypted account configuration at `/ai/configuration`. No AI provider environment variable such as `OPENAI_API_KEY` replaces that configuration page.

## Complete production runtime list

Fallbacks below apply when the program receives no value or an empty string. The installer writes the selected installation root into systemd `Environment=` entries. For a custom installation root, use the generated service configuration rather than copying `/opt/LibreOJ` literally.

| Variable | Reader | Source fallback | Purpose and required alignment |
| --- | --- | --- | --- |
| `HYHOJ_AI_STATE_DIR` | backend | `/opt/LibreOJ/data/ai` | Encryption state directory containing `master.key`; read during backend initialization. Do not remove or regenerate the key while retaining the database's encrypted account configurations. |
| `HYHOJ_AI_GENERATED_DIR` | backend | `/opt/LibreOJ/data/ai-generated` | Reads, validates and publishes runner output; must match the local judge YAML `aiGeneratedDirectory`. The judge does not read this environment variable. |
| `HYHOJ_AI_SAMPLE_INPUTS_DIR` | backend and judge | `/opt/LibreOJ/data/ai-sample-inputs` | Private samples, input snapshots and controlled helper-file staging; the runner reads bounded files there. Both processes must use the same directory. The judge reads it once when loading its module. |
| `HYHOJ_AI_RUNNER_SOCKET` | backend | `/opt/LibreOJ/data/judge/ai-runner.sock` | Local AI runner UNIX socket; must match judge YAML `aiRunnerSocket`. The judge does not read this environment variable, and this is not a remote TCP runner address. |
| `HYHOJ_ARCHIVE_WORK_DIRECTORY` | backend | `/opt/LibreOJ/data/backend-archives` | Shared archive workspace. AI ZIP processing creates an `ai-attachment-*` temporary directory here before size, path and content validation. Other archive operations also use it. |

These values are filesystem paths, not URLs. Use absolute paths and preserve traversal permissions on parent directories. Setting a variable neither moves existing data nor updates another process's YAML. `HYHOJ_ROOT` is input to installer/configuration scripts; it does not dynamically replace these backend fallback paths at runtime.

The backend makes model requests; the local judge runs generators, reference solutions and checkers within its restricted environment. Remote submission judging uses a separate path from this UNIX socket workflow. `--role all` configures the local runner, `--role web` alone provides no runner, and the remote judge generator uses `OJ_JUDGE_REMOTE=1` and disables its AI socket/output directory when creating judge YAML (installer `--role` accepts only `all` and `web`). See [distributed judging](Distributed-Judging.md).

## Directory, key and socket permissions

Standard installation expects the following, with `libreoj` as the backend service user/group:

| Path or object | Ownership / mode | Meaning |
| --- | --- | --- |
| `data/ai` | `libreoj:libreoj`, `0700` | Backend encryption state directory; initialization checks ownership and tightens its permissions. |
| `data/ai/master.key` | Backend service user, `0600` | A regular 32-byte file with one hard link; symbolic links are rejected. Startup fails if encrypted configurations already exist but the key is missing. |
| `data/ai-generated` | `root:libreoj`, `0750` | Runner creates and verifies a non-symlink directory. Root writes results and the backend group reads them. Do not make it writable by arbitrary users. |
| `data/ai-sample-inputs` | `libreoj:libreoj`, `0700` | Backend writes files; the privileged runner reads them after checking paths, ownership, size and other bounds. |
| `data/judge/ai-runner.sock` | `root:libreoj`, `0660` | Runner assigns the positive numeric YAML `aiRunnerGid`; not an open network endpoint. |
| AI temporary subdirectories in `backend-archives` | Backend service user, `0700` | Staged uploads; temporary directories are removed after the operation. The workspace also serves other archive operations. |

Do not solve access failures with `0777` or accidentally change a copied `master.key` to root ownership. Key migration must preserve the matching database, exact bytes, service-user ownership and permissions. Keep backups separately secured; see [AI key backup](AI.md#execution-and-encrypted-configuration).

### Applying changes

1. Let running jobs finish and back up the existing configuration. Stop affected processes during directory migration so jobs cannot mix old and new paths.
2. Change service environment settings. For output directory/socket changes, update judge YAML too. For sample-directory changes, update `HYHOJ_AI_SAMPLE_INPUTS_DIR` in both services. Create destination directories with correct owners/modes before migrating required data.
3. Reload systemd configuration and restart affected services. An `export` in your shell or `daemon-reload` alone does not change an existing process's environment.
4. Check service health, error types and directory/socket metadata. Do not publish key contents, full configurations, sessions or signed upload URLs in logs/reports. Verify ordinary judging and a small task before increasing load.

For example, to move only the backend archive workspace to a prepared `/srv/libreoj/backend-archives`, use `sudo systemctl edit libreoj-backend.service` and add:

```ini
[Service]
Environment=HYHOJ_ARCHIVE_WORK_DIRECTORY=/srv/libreoj/backend-archives
```

After ensuring the service user can access that directory and its parents:

```sh
sudo systemctl daemon-reload
sudo systemctl restart libreoj-backend.service
sudo systemctl is-active libreoj-backend.service
```

This example relocates shared temporary archive storage; it is not a migration script for all AI data. The configuration generators rewrite their managed main systemd units. Existing private YAML is retained and checked for consistency, not replaced with new values automatically. Update YAML explicitly during migration and review custom settings after upgrades, because direct edits to main units can be overwritten. For CPU or execution-slot changes, use [judge configuration](Judge-Configuration.md); AI task concurrency does not configure CPUs.

## Common configuration misconceptions

| Name | Current behavior |
| --- | --- |
| `HYHOJ_AI_PRIVATE_HOSTS` | **Legacy name; production code no longer reads it.** Some tests still set/restore it. Setting it does not create an allowlist, and clearing it does not block private networks. The implementation permits HTTP/HTTPS domains, private and local addresses, pins resolved addresses to connections, and refuses redirects. Control who may configure providers through account privileges. |
| `autoOnSave` | Account API compatibility field, not an environment variable. Saving and reading force `false`; legacy `automatic: true` requests are skipped. |
| `llm.maxTokens` / `maxConcurrentJobs` | Account settings, not `NODE_OPTIONS` or judge slots. They control output budget and running AI jobs per user respectively. |
| `aiRunnerSocket` / `aiGeneratedDirectory` / `aiRunnerGid` | Judge YAML fields, not environment variables; see [judge configuration](Judge-Configuration.md). |
| `LIBREOJ_CONFIG_FILE` / `LIBREOJ_JUDGE_CONFIG_FILE` | General configuration-file selectors; see [all environment variables](Environment.md). `NODE_ENV`, `NODE_OPTIONS`, `PATH`, `TMPDIR` and `UV_THREADPOOL_SIZE` also affect processes rather than selecting provider features or AI credits. |
| Browser read/upload timeouts | Frontend source constants with no supported environment override. Setting similarly named variables has no effect. |

## Fixed limits, not configurable environment variables

These explain timeout and throughput boundaries. Do not put source constants into systemd expecting to override them. Values below apply to this revision only.

| Stage | Current behavior |
| --- | --- |
| Browser file reads | `readBrowserFile` defaults to 60 seconds. Read/permission errors are visible and do not continue to upload. |
| Import preparation and start | `prepareAttachment` and `ai/start` each use 30 seconds. ZIP upload uses 120 seconds and one attempt. Cancel/navigation stops unfinished asynchronous work before submission; cancel already accepted jobs from the job list. |
| Generic file uploads | The shared helper still defaults to timeout 0 (no timeout); AI explicitly overrides it. The 120-second AI limit does not apply to every large-file upload on the site. |
| Model / model discovery | A generation request allows up to 30 minutes; model-list requests use 30 seconds. Provider limits and network failures still apply. |
| Search / MCP | 60 seconds per request. MCP initialization, listing and invocation are separate requests, so this is not a 60-second cap on the whole workflow. |
| Responses recovery | Default polling interval 2 seconds, transient-error backoff up to 10 seconds; each poll 30 seconds, temporary recovery window 120 seconds, overall deadline 30 minutes from checkpoint creation. |
| Scheduling | At most 8 running jobs globally, 100 queued plus running per user. Per-user running limit defaults to 3 and accepts 1–8. One job per problem. Local runner admission is 8, generation queue concurrency is 3, and actual judge slots are shared. |
| Runner socket | Requests at most 16 MiB; backend unprocessed response buffer at most 1048576 characters. At most 32 connections, with a 30-second idle timeout before the first request. |
| Runner output and disk | Ordinary output file at most 16 MiB, sample input file at most 256 MiB, aggregate output at most 8 GiB. Generation reserves 2 GiB of free disk space. |
| Runner wait budget | Backend computes a budget from case count and reference time limits, capped at 4 hours. This is neither the model request timeout nor permission for one generated program to run for 4 hours. |
| Temporary generated results | 24-hour retention; hourly cleanup checks ownership, inactivity and other conditions. Published problem data has separate persistent storage. |
| Generator repair | A clear compilation failure in AI-generated `make.cpp` permits one automatic repair, with a persisted budget; user-provided judging programs are not retried indefinitely. |

Browser reads also depend on OS policy. Snap Firefox was observed rejecting root-owned test files while byte-identical copies owned by the desktop user were readable. Use copies the desktop user can access, without disabling AppArmor or the browser sandbox. The fix makes errors and cancellation explicit; it cannot grant additional system permissions.

## Test-only variables

Do not add these to production units. They select isolated resources for explicitly invoked repository tests, not product features. Tests can write databases, create problems/jobs and replace their dedicated fixture account's configuration; use a disposable environment. No such tests were run for this documentation update.

| Variable | Default / purpose | Scope and constraints |
| --- | --- | --- |
| `HYHOJ_AI_TEST_DB_CONFIG` | Relevant MariaDB suites skip when unset; otherwise a YAML path containing `services.database` | `ai-*.mariadb.test.cjs`, using a real database and temporary tables. Not every CJS suite enforces a `hyhoj_test_*` name: select a disposable database yourself rather than assuming the MJS guards below apply. |
| `HYHOJ_AI_TEST_RESULTS` | Optional JSON result path | Some MariaDB CJS suites write results; some temporary directories also use its parent. That parent must exist and be writable. |
| `HYHOJ_TEST_CONFIG` | Required backend YAML path for MJS integration tests | Shared `integration-client.mjs`: database must be named `hyhoj_test_*` with a numeric loopback host. Redis requires an explicit URL, numeric loopback host and dedicated nonzero database; port 16379 is rejected. |
| `HYHOJ_TEST_STATE` | Required JSON state path for MJS integration tests | Contains dedicated fixture `users` and `tokens`. Keep this session-bearing file private and out of public evidence. |
| `HYHOJ_TEST_BASE` | Required API origin for MJS integration tests | Numeric loopback HTTP/HTTPS only, without credentials, query, fragment or subpath. Ports 2002 and 29533 are rejected; use a dedicated test API. |
| `HYHOJ_AI_FIXTURE_USER` | `ai_fixture` | MJS mock-provider account. Rejects `admin`; user/token must already exist in test state. Refuses to replace existing real-provider configuration; only the fixed `127.0.0.1:2230` mock endpoint passes the check. |
| `HYHOJ_TEST_SPJ` | Only literal `1` enables it; off by default | SPJ path in `ai-integration.test.mjs`. |
| `HYHOJ_TEST_INVALID_INPUT` | Only literal `1` enables it; off by default | Invalid-input path in the same integration test. |
| `HYHOJ_TEST_EVIDENCE_DIR` | Optional screenshot directory | `ai-browser.test.mjs` saves browser evidence there; no such screenshots are saved when unset. |
| `BACKEND_ROOT` | Backend directory containing the current test | Locates backend dependencies in `ai-network-policy.test.cjs`; does not relocate a production installation. |
| `LAN_HOST` | Prefer a local private IPv4, then another non-loopback IPv4 | The same network-policy test selects a bound local interface. Other hosts are rejected; relevant tests skip if no interface is available. |

Tests also temporarily override production variables to point at isolated directories; that does not make those variables test-only. Mock providers validate protocols/failure branches, not external service quality. Real database, sandbox and browser tests each prove their own covered layer. See [verification scope](AI.md#validation-scope) for historical real DeepSeek/Tavily workflows and this documentation update's limits.

## Source references

- [Backend AI paths/socket and scheduling](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai.service.ts), [encryption file constraints](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-crypto.ts)
- [AI runner](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/aiRunner.ts), [backend units](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-local.py), [judge configuration/units](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-judge.py), [directory permissions](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/install-support.py)
- [File reads](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/utils/readBrowserFile.ts), [AI upload calls](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/pages/ai/api.ts), [import cancellation/start](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/pages/ai/AiImportPage.tsx), [shared uploader](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/utils/callApiWithFileUpload.ts)
- [Provider timeouts/protocols](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-provider.ts), [Responses recovery](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-responses.ts)
- [MJS test isolation](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/test/integration-client.mjs), [fixture account guards](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-fixture-utils.mjs), [network-test variables](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-network-policy.test.cjs)
