# AI environment and fixed limits

[简体中文](AI-Environment.zh-CN.md) | English | [Wiki home](Home.en.md) | [AI](AI.md) | [Environment variables](Environment.md) | [Judge configuration](Judge-Configuration.md)

This page is for server administrators: the directories, keys and socket the AI features use, and their fixed limits. Each user's provider, key, model, output limit and number of jobs are set on the **AI API Configuration** page (see [AI](AI.md)); no environment variable such as `OPENAI_API_KEY` replaces it. The site-wide pause and budgets are set in **Site management** (see [AI](AI.md#site-limits)).

## Environment variables

The installer sets these in the services' systemd units, using your installation directory; the defaults below apply only when a variable is missing or empty.

| Variable | Read by | Default | Purpose |
| --- | --- | --- | --- |
| `HYHOJ_AI_STATE_DIR` | backend | `/opt/LLMOJ/data/ai` | Holds `master.key` (and `two-factor.key`). Never delete or replace the key while the database holds configurations encrypted with it. |
| `HYHOJ_AI_GENERATED_DIR` | backend | `/opt/LLMOJ/data/ai-generated` | Where the backend reads the AI worker's results. Must match `aiGeneratedDirectory` in the local `judge.yaml`. |
| `HYHOJ_AI_SAMPLE_INPUTS_DIR` | backend and judge | `/opt/LLMOJ/data/ai-sample-inputs` | Private samples and input files handed to the AI worker. Both services must use the same directory. |
| `HYHOJ_AI_RUNNER_SOCKET` | backend | `/opt/LLMOJ/data/judge/ai-runner.sock` | The local AI worker's socket. Must match `aiRunnerSocket` in the local `judge.yaml`. |
| `LLMOJ_AI_EXECUTION` | backend | automatic | Where AI jobs run their programs: `local` (the local AI worker's socket) or `judges` (the judge queue, on any judge of protocol version 4; see [Distributed judging](Distributed-Judging.md#ai)). Without it, `local` when the socket exists, otherwise `judges`. Files a judge generates are downloaded to the backend's `TMPDIR` (`data/tmp`) before they're published, up to 8 GiB for a job. |
| `HYHOJ_ARCHIVE_WORK_DIRECTORY` | backend | `/opt/LLMOJ/data/backend-archives` | Temporary space for archives, including AI ZIP attachments while they're checked |
| `HYHOJ_AI_PRIVATE_HOSTS` | backend | none | Private or local provider hosts every user may use, separated by commas or spaces, each with an optional port, for example `llm.lan, 10.0.0.5:8000, [fd00::5]:8080`. Without it, private, loopback and link-local addresses are limited to site administrators' own configurations. Public addresses need no listing. |

These are absolute file system paths, not URLs. Setting one doesn't move existing data or change the other service's configuration, and `HYHOJ_ROOT` doesn't change them at runtime.

Model and search requests are made by the backend; the local judge compiles and runs generated programs. Only the `all` role has the local AI worker: remote judges have it turned off, and a `web` site has none. See [Distributed judging](Distributed-Judging.md).

## Directories, keys and the socket

With `libreoj` as the backend's user and group, an installation has:

| Path | Owner and mode | Notes |
| --- | --- | --- |
| `data/ai` | `libreoj:libreoj`, `0700` | The backend checks the owner and tightens the mode when it starts. |
| `data/ai/master.key` | backend's user, `0600` | A regular 32-byte file with a single link; symbolic links are refused. If encrypted configurations exist but the key is missing, the backend won't start. |
| `data/ai/two-factor.key` | backend's user, `0600` | The same rules. Encrypts authenticator secrets of [two-factor sign-in](Two-Factor-Sign-In.md); created when first needed. If users have authenticator apps set up, a missing key is never replaced and their codes stop working. |
| `data/ai-generated` | `root:libreoj`, `0750` | Written by the AI worker (root) and read by the backend. Must be a real directory, not a link. |
| `data/ai-sample-inputs` | `libreoj:libreoj`, `0700` | Written by the backend; the worker checks paths, owners and sizes before reading. |
| `data/judge/ai-runner.sock` | `root:libreoj`, `0660` | Its group is `aiRunnerGid` from `judge.yaml`. It's a local socket, not a network port. |
| AI folders under `backend-archives` | backend's user, `0700` | Temporary; removed when the operation ends. |

Don't fix access problems with `0777`, and don't let a copied `master.key` end up owned by root. When moving a key, keep it with its database, byte for byte, with the same owner and mode, and keep its backups secure. See [AI](AI.md#where-ai-runs-and-where-keys-are-kept).

### Changing a directory

1. Let running AI jobs finish, back up the configuration, and stop the services involved, so that no job uses both the old and the new path.
2. Change the services' environment. For the results directory or the socket, change `judge.yaml` too; for the sample directory, change both services. Create the new directory with the right owner and mode, and move the data it needs.
3. Run `systemctl daemon-reload` and restart the services. Setting the variable in your shell, or `daemon-reload` alone, doesn't change running services.
4. Check that the services are healthy and the directories and socket look right, then try ordinary judging and a small AI job. Never paste keys, configurations, sessions or signed upload links into logs or reports.

For example, to move only the archive workspace to a prepared `/srv/libreoj/backend-archives`, run `sudo systemctl edit libreoj-backend.service` and add:

```ini
[Service]
Environment=HYHOJ_ARCHIVE_WORK_DIRECTORY=/srv/libreoj/backend-archives
```

Once the backend's user can reach that directory and its parents:

```sh
sudo systemctl daemon-reload
sudo systemctl restart libreoj-backend.service
sudo systemctl is-active libreoj-backend.service
```

Use a drop-in like this rather than editing the main unit files, which the configuration scripts rewrite. To change CPUs or judge slots, use [Judge configuration](Judge-Configuration.md); AI settings don't configure CPUs.

## Common mix-ups

| Name | What it is |
| --- | --- |
| `llm.maxTokens`, `maxConcurrentJobs` | Each user's settings on the AI configuration page: the output limit of one request, and how many of their jobs run at once. Not `NODE_OPTIONS`, and not judge slots. |
| Pause, budgets, AI requests at the same time | Site-wide settings in **Site management**, stored in the database; see [AI](AI.md#site-limits). Not environment variables. |
| `aiRunnerSocket`, `aiGeneratedDirectory`, `aiRunnerGid` | Settings in `judge.yaml`; see [Judge configuration](Judge-Configuration.md). |
| `autoOnSave` | Kept for compatibility and always `false`; requests with `automatic: true` are ignored. |
| Browser read and upload time limits | Fixed in the frontend; no variable changes them. |

## Fixed limits

These are fixed in the code; setting variables with similar names has no effect.

| Stage | Limit |
| --- | --- |
| Reading a file in the browser | 60 seconds. A read or permission error is shown, and nothing is uploaded. |
| Starting an import | 30 seconds each for preparing the attachment and starting the job; 120 seconds and one attempt for the ZIP upload. These limits apply only to AI uploads. |
| Model requests | Up to 30 minutes for a generation; 30 seconds for a model list |
| Search and MCP | 60 seconds per request (MCP's initialization, listing and call are separate requests) |
| Connection recovery | Polls every 2 seconds, backing off to 10 seconds after errors; 30 seconds per poll; gives up after 120 seconds without a connection, or 30 minutes after the request started |
| Jobs | 8 running on the site; 100 running or queued per user; 1 to 8 running per user (3 by default); one per problem. The local worker accepts 8 requests and runs 3 pipelines at once, sharing judge slots. |
| Worker socket | Requests up to 16 MiB; the backend buffers up to 1048576 characters of an answer; 32 connections, closed after 30 seconds without a request |
| Worker output and disk | 16 MiB per output file, 256 MiB per sample input, 8 GiB in total; generation needs 2 GiB of free disk |
| Test data checks | At least 64 small inputs (the worker accepts 64 to 1000), one second solution (the worker accepts 1 to 3), 1 to 4 challenge programs, and up to 16 extra counterexamples (the worker accepts 32) |
| Auxiliary programs | 5 seconds and 512 MiB for each run of the small-input generator and the oracle; second solutions and challenges use the problem's own limits |
| Waiting for the worker | Scales with the number of cases and checks, up to 4 hours in total. Not a limit on how long a generated program may run. |
| Temporary results | Kept for 24 hours; cleaned up hourly. Published problem data is stored separately. |
| Budget holds | Kept 48 hours, then deleted; they count only within the last 24 hours |
| `make.cpp` repair | One automatic repair after a compile error |

Browser reads also depend on the operating system: Firefox installed as a Snap couldn't read test files owned by root, while copies owned by the desktop user worked. Use such copies; don't turn off AppArmor or the browser's sandbox.

## Test-only variables

Never set these in production services. They point tests at disposable resources, and the tests write to databases, create problems and jobs, and replace their fixture account's configuration.

| Variable | Purpose |
| --- | --- |
| `HYHOJ_AI_TEST_DB_CONFIG` | YAML file with `services.database` for the `ai-*.mariadb.test.cjs` tests, which use a real database and temporary tables. Point it at a disposable database. Without it, they're skipped. Their ZIP cases need 2 GiB free in the temporary directory (`TMPDIR`). |
| `LLMOJ_AI_BUDGET_TEST_DB_CONFIG` | YAML file with `services.database` for `ai-budget.mariadb.test.cjs`, which needs an empty disposable database |
| `HYHOJ_AI_TEST_RESULTS` | Optional JSON results file for some database tests; its directory must exist |
| `HYHOJ_TEST_CONFIG` | Backend YAML for the integration tests: the database name must start with `hyhoj_test_`, the host must be a loopback address, and Redis must be a dedicated non-zero database on loopback (not port 16379) |
| `HYHOJ_TEST_STATE` | JSON file with the integration tests' fixture `users` and `tokens`; keep it private |
| `HYHOJ_TEST_BASE` | The test API's address: loopback HTTP or HTTPS only, without credentials, query or path; ports 2002 and 29533 are refused |
| `HYHOJ_AI_FIXTURE_USER` | The account the mock-provider tests use (`ai_fixture` by default, never `admin`); its configuration is replaced only if it points at the mock at `127.0.0.1:2230` |
| `HYHOJ_TEST_SPJ`, `HYHOJ_TEST_INVALID_INPUT` | `1` turns on the special-judge and invalid-input cases of `ai-integration.test.mjs` |
| `HYHOJ_TEST_EVIDENCE_DIR` | Where `ai-browser.test.mjs` saves screenshots; none are saved without it |
| `BACKEND_ROOT`, `LAN_HOST` | Used by `ai-network-policy.test.cjs` to find the backend's dependencies and pick a local network interface |

Mock providers test protocols and error handling, not the quality of a real service. More test variables are listed in the [development guide](../README-DEVELOPMENT.md#database-tests).

## Sources

[ai.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.service.ts), [ai-crypto.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-crypto.ts), [ai-admission.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-admission.service.ts), [aiRunner.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiRunner.ts), [configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-local.py), [configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py), [install-support.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/install-support.py), [readBrowserFile.ts](https://github.com/houyhlouis/LLMOJ/blob/main/packages/frontend/src/utils/readBrowserFile.ts), [ai-provider.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-provider.ts), [ai-responses.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-responses.ts), [ai-testdata-quality.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-testdata-quality.ts), [aiQuality.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiQuality.ts).
