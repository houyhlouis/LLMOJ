# AI configuration, permissions and execution

English | [简体中文](AI.zh-CN.md) | [All configuration](Configuration.md) | [AI environment](AI-Environment.md)

This page describes source revision `43a88bdd62fbf200889b36932fa921439a293190`. AI configuration belongs to the signed-in account, not a shared site account. No model, public key or service credits are supplied. Configure providers at `/ai/configuration`, import at `/ai/import`, or use the AI panel on an existing problem's edit page.

## Configure through the UI

1. Have an administrator grant the permissions below, then open AI API Configuration using your own account.
2. Select a preset or enter the API format, Base URL, key and model ID. A preset fills only the format/URL and clears the model selection; it does not establish model capabilities.
3. Fetch models saves the entire form before requesting the list. You may enter an ID manually if model discovery is unavailable. Save again after choosing the model.
4. Configure Search / MCP if needed. Search can remain without a key, but its Base URL must still be valid.
5. Save and test connection saves first, then makes a real request for the current tab: an `OK` model response or a search. This may consume provider credits. A failed test does not roll back saved settings or erase a saved key.
6. Saving configuration does not start problem editing, tutorials or data generation. Explicitly start the required action from the import or problem page.

Base URLs must use HTTP/HTTPS and contain no username, password, query or fragment; length is 1–2000 characters. Model endpoints have paths appended, so do not include `/chat/completions`, `/responses`, `/messages` or `/models` in a model Base URL. MCP takes the full MCP endpoint path instead. Hostnames, private networks and loopback are allowed; DNS results are pinned to each connection and HTTP redirects are not followed. Configure [HTTPS](HTTPS.md) before entering keys through a public OJ.

## All account configuration fields

These are `saveConfiguration` fields, not environment variables. The UI submits both `llm` and `search`, and both are validated even when you edit only one tab.

| Field | Initial value / omission behavior | Validation and meaning |
| --- | --- | --- |
| `llm.type` | `chat` | `chat`, `responses` or `anthropic`; protocol mapping is below. |
| `llm.baseUrl` | `https://api.openai.com/v1` | HTTP/HTTPS, 1–2000 characters, subject to the URL rules above. |
| `llm.apiKey` | Unconfigured | Optional, 0–4096 characters. Empty/omitted preserves the old key only if the Base URL is **exactly the same string**. A changed URL without a replacement key clears the old key, including a trailing-slash-only change. Model requests require a nonempty key. |
| `llm.model` | Empty | 0–200 characters. May be saved empty before fetching models; generation and connection tests require a model ID. |
| `llm.reasoning` | Empty | Optional, 0–50 characters. Blank uses provider defaults; surrounding whitespace is trimmed before use. Protocol/host-specific mappings are below. |
| `llm.maxTokens` | `16384` | Integer 512–1000000. This is an output budget, not context length; the model may support less. Saving for `api.deepseek.com` caps it at 393216 and reports the adjustment. |
| `llm.responsesRecovery` | `auto` | `auto`, `off` or `background`; meaningful only for the `responses` format. |
| `search.type` | `tavily` | `tavily` or `mcp`. |
| `search.baseUrl` | `https://api.tavily.com` | Same URL/length restrictions. Tavily appends `/search`; MCP uses the full supplied endpoint. Switching the UI to MCP fills `https://mcp.tavily.com/mcp/`. |
| `search.apiKey` | Unconfigured | Optional, 0–4096 characters; same retention/clearing rules as the model key. Both Tavily and MCP searches currently require a nonempty key. |
| `search.tool` | Empty | Optional, 0–200 characters. MCP only: an explicit name must exactly match `tools/list`; empty selects the first name containing `search`, case-insensitively. |
| `maxConcurrentJobs` | `3` | Per-user running job limit, integer 1–8. Omission preserves the old setting, then falls back to 3; invalid legacy values read back as 3. Does not change judge slots. |
| `autoOnSave` | `false` | Legacy compatibility boolean still required by the DTO. Saves and responses force `false`, as does the UI; sending `true` does not restore automatic execution. |
| `clearLlmKey` | Omitted / `false` | Boolean save control; `true` clears the model key even if a new key was supplied. Not a persisted configuration field. |
| `clearSearchKey` | Omitted / `false` | Clears the search key. Delete saved key sets only the current tab's corresponding flag. |

`llm.hasKey` and `search.hasKey` are read-only indicators, not key values. `presets` and `parallelism` are UI metadata, not save parameters. Keys are never returned to the inputs. `parallelism` reports `min=1`, `max=8`, `globalMax=8`, `maxQueuedJobs=100`; despite its name, the last limit counts the user's **queued plus running** jobs.

### Formats and provider presets

| `type` | Generation path / authentication | Output and reasoning mapping |
| --- | --- | --- |
| `chat` | `/chat/completions`; Bearer key | `api.openai.com` uses `max_completion_tokens`; other hosts use `max_tokens`. Generic compatible providers receive `reasoning_effort`. |
| `responses` | `/responses`; Bearer key | Uses `max_output_tokens` and, if supplied, `reasoning.effort`. |
| `anthropic` | `/messages`; `x-api-key`, `anthropic-version: 2023-06-01` | Uses `max_tokens`; thinking mapping is described below. |

All formats discover models through `/models` below the Base URL. Anthropic discovery follows up to 20 pages, then deduplicates and sorts. These built-in presets do not mean every listed provider/model has passed a live acceptance test:

| Preset | Format | Base URL |
| --- | --- | --- |
| OpenAI | `responses` | `https://api.openai.com/v1` |
| Anthropic | `anthropic` | `https://api.anthropic.com/v1` |
| DeepSeek | `chat` | `https://api.deepseek.com/v1` |
| Google Gemini | `chat` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq | `chat` | `https://api.groq.com/openai/v1` |
| Mistral | `chat` | `https://api.mistral.ai/v1` |
| OpenRouter | `chat` | `https://openrouter.ai/api/v1` |
| SiliconFlow | `chat` | `https://api.siliconflow.cn/v1` |
| Alibaba Cloud | `chat` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Moonshot | `chat` | `https://api.moonshot.cn/v1` |

Reasoning is mapped by implementation; the selected model must still support the resulting parameters:

- Official DeepSeek host: accepts only `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. For `chat`, `none` disables `thinking`; other values enable it and set `reasoning_effort`. The 393216 output cap is also host-based, not automatically applied to proxies.
- Anthropic: blank or `none` leaves thinking disabled. A digits-only budget must be at least 1024 and strictly below `maxTokens`; generation/connection testing validates it before sending `thinking.budget_tokens`. Other nonempty values send adaptive thinking and `output_config.effort`, without locally enumerating every model's supported values.
- Alibaba `*dashscope.aliyuncs.com` with `chat`: `none` disables `enable_thinking`; other values enable it, and digits-only values also set `thinking_budget`.
- OpenRouter with `chat`: `none` sends `reasoning.enabled=false`; other values send `reasoning.effort`.
- Other `chat` hosts receive `reasoning_effort` directly. Compatibility with chat formatting does not establish support for reasoning parameters or image input.

### Responses recovery

`auto` enables background recovery only for `responses` on official `api.openai.com`. It stays off for other compatible hosts. `off` disables it explicitly. `background` opts another supporting endpoint into background Responses; the official DeepSeek host rejects this combination.

Requests use `background: true` and `store: false`. Once available, response IDs are checkpointed per owner, job and request fingerprint so polling can continue. A lost acknowledgement of the initial creation request is not blindly retried with another POST. Changing the key, address or request changes its fingerprint; recovery of the previous request is not guaranteed. Polling/recovery limits are source constants documented under [AI environment and fixed limits](AI-Environment.md). This is not generic recovery for every OpenAI-compatible API.

### Search and MCP

Tavily requests up to five results with `advanced` search, without an aggregate answer, and records reported usage. MCP supports Streamable HTTP JSON/event-stream responses, using `initialize`, `notifications/initialized`, `tools/list` and `tools/call` with the server's session header. It is not a local stdio launcher and does not read a user's desktop MCP configuration.

Tool arguments adapt only `query`, `search_query` or `q`, in that priority order; `max_results=5` is included when present in the schema. Arbitrary tools with additional required parameters are not guaranteed to work. The backend inserts Tavily hosted MCP's key query parameter itself; do not put keys in Base URLs. Without a search key, a standalone source action fails with `SEARCH_NOT_CONFIGURED`; a composite job skips discovery and records an unconfigured state while other steps may continue. An unverified source must not be described as an established original problem.

## Permissions, jobs and when settings apply

| Operation | Permission / ownership boundary |
| --- | --- |
| Read/save AI configuration, list models, test connection | `ManageAiConfiguration`; own configuration only. |
| Start or retry jobs | `UseAi`; existing problems also require problem `Modify` permission. |
| Import a problem or prepare its ZIP attachment | `UseAi`, `ImportProblem`, `GenerateTestdata`, and permission to create problems. |
| `testdata`, `all`, `import` | Also requires `GenerateTestdata`; data writes check the `EditProblemData` decision and problem permissions. |
| List jobs/usage or cancel | Signed-in users can access only their own records/jobs. Administrator status does not expose another user's provider key. |

Global allow/deny rules and problem ACLs participate in authorization. Writes recheck current permissions, job state and the problem snapshot. Editing statements, samples or judge settings, or revoking permission while a job runs, can cause a conflict/permission failure instead of overwriting the user's changes.

- Saving persists immediately; models and connection tests load the latest configuration. A job loads configuration when execution begins and does not switch keys/models at every stage. Newly executed or retried jobs use the configuration current at that time.
- The scheduler uses updated per-user limits when admitting later jobs: globally at most 8 running jobs, no simultaneous AI jobs for the same problem, and at most 100 queued-plus-running jobs per owner. Lowering the limit does not cancel jobs already running.
- The local AI runner admits up to 8 jobs and runs a fixed 3 generation pipelines, sharing judge execution slots with ordinary submissions. Raising `maxConcurrentJobs` does not replace [judge CPU/slot configuration](Judge-Configuration.md).
- Import runs statement recognition → source → translation → tags → difficulty → tutorial → test data. `all` omits problem creation; `metadata` runs only source, translation, tags and difficulty. Legacy `automatic: true` requests return skipped and do not restore automatic-on-save execution.
- Requested test count defaults to 20 and accepts 5–1000. It can be increased, up to 1000, to represent equal case points for subtask scores exactly, with a notice. Imports support traditional, interactive and communication problems; output-only problems must be created manually. Communication mode can be detected or specified as `run-twice` or C++ `grader`.
- The UI accepts statement files up to 10 MiB: Markdown/text and PNG/JPEG/WebP/GIF. Backend Markdown is capped at 500000 characters and image data URLs at 15000000 characters. ZIP maximum is 64 MiB; preparation also requires at least 22 bytes and validates owner-bound upload credentials, valid for admission for 24 hours. Accepted size does not establish valid content.

## File reading, cancellation and generation failure

File inputs stay mounted until reading finishes, then reset; ZIPs become browser-memory-backed file copies. Read failures are visible and do not proceed to upload. A previously reproduced Snap Firefox failure was caused by AppArmor denying root-owned fixture files. Use a copy owned by the desktop user in a directory that user can access. Do not disable the browser sandbox or broadly relax AppArmor to upload a file.

Only confirmed HTTP 2xx upload responses allow job creation. Cancel upload is available during preparation/upload. Leaving the page cancels pending reads/preparation/uploads and prevents them from later issuing a start request. Once the server has accepted a job, closing the page cannot revoke it; cancel it in My AI jobs. After a start timeout, inspect the job list before importing again. Cancellation cannot undo completed provider charges or already published stages.

Only the AI-generated `make.cpp` receives one automatic repair after a recognized compiler failure; the repair budget is persisted. There is no repair loop, and uploaded checker/interactor/manager/grader sources are not rewritten. A second failure, sample failure or data-validation failure remains a failure. Repair adds a model call. Tutorial source/scoring claims undergo factual checks that can block publication with a retryable message; this does not replace reviewing all algorithmic claims.

## Execution and encrypted configuration

The backend makes model/search requests; compilation, execution and data validation use a **same-machine** judge worker over a UNIX socket. Ordinary judging can use remote judges, but there is no remote AI runner protocol. `--role all` provides the local worker; `--role web` alone does not provide generated-program execution. Keep a local runner on the web node for full AI data generation, then add remote judges for ordinary submissions. See [AI environment](AI-Environment.md) for matching paths, socket and permissions.

The `ai_configuration` database table stores the whole configuration encrypted per `userId` with AES-256-GCM. The master key defaults to `data/ai/master.key`; the directory is `0700` and key `0600`. Both must be owned by the backend service user. The key must be a single-link regular 32-byte file; symlinks and invalid files are rejected. If encrypted configurations exist but the original key is missing, backend startup fails instead of silently replacing it.

Back up the database together with its matching master key; another key cannot decrypt the saved configuration. Do not include databases, master keys, sessions or provider keys in source/report packages. Configuration responses contain only `hasKey`. Usage records store request metadata and provider-reported usage, without keys or prompt/response bodies. The default period is 30 days; the API accepts 1–366 days. Unreported token usage is not estimated, and failed/retried calls still count as requests.

## Validation scope

A prior real Ubuntu 24.04 amd64 deployment used real DeepSeek/Tavily and Firefox for selected configuration, search, image/text import, content/data generation, submission judging and multi-user permission paths. The upload changes also passed actual Firefox component regressions for unreadable files, upload HTTP errors/timeouts, cancellation and navigation; simulated servers controlled response timing. This does not certify every provider, MCP service, output-quality case or a remote AI worker deployment.

Later changes have also used isolated unit, simulated-provider, real-database or real-sandbox regressions. Each establishes only its tested scope. This Wiki update checks source configuration; it does not repeat a clean installation or a complete paid-provider acceptance test.

## Source references

- [DTOs and request ranges](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai.dto.ts), [defaults and presets](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai.types.ts)
- [Provider implementation](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-provider.ts), [budget validation](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-validation.ts), [Responses recovery](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-responses.ts)
- [Permissions, scheduling and writes](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai.service.ts), [key lifecycle](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-crypto.ts)
- [Configuration UI](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/pages/ai/AiConfigurationPage.tsx), [import UI](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/pages/ai/AiImportPage.tsx)
