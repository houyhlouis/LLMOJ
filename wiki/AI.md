# AI

[简体中文](AI.zh-CN.md) | English | [Wiki home](Home.en.md) | [Configuration overview](Configuration.md) | [AI environment](AI-Environment.md)

LLMOJ can use an AI model to import problems, translate and tag them, estimate difficulty, write solutions, find a problem's original source, and generate and check test data. Each user sets up AI with **their own** provider account and key: the site supplies no model, key or credits.

- **AI API Configuration** (`/ai/configuration`): your provider, model, web search and usage.
- **AI import** (`/ai/import`): create a problem from a statement.
- The **AI** panel on a problem's edit page: run AI actions on an existing problem.

The instructions LLMOJ sends to models are in English, but what the model writes follows the language asked for: imported statements keep their original language, `zh_CN` content is written in Chinese and `en_US` content in English. Your own text, problems and search results are sent as they are.

## Setting up

1. Ask an administrator for the permissions you need (see [Permissions](#permissions-and-jobs)), then open **AI API Configuration**.
2. Choose a **Provider preset**, or enter the **API format**, Base URL, key and model yourself. A preset fills in only the format and Base URL.
3. **Fetch models** saves the form and loads the provider's model list; choose a model and save again. If the provider can't list models, type the model ID.
4. If you want web search (used to find original sources), configure **Search / MCP**.
5. **Save and test connection** saves, then makes a real request: a short model reply or a search. This may cost provider credits. A failed test doesn't undo the save.

Saving doesn't start any AI work; start actions from the import page or a problem's AI panel.

**Base URLs** must use HTTP or HTTPS, be 1 to 2000 characters and contain no user name, password, query or fragment. LLMOJ adds the path itself, so don't include `/chat/completions`, `/responses`, `/messages` or `/models`; for MCP, give the full endpoint.

**Private addresses.** Requests go out from the server, so private-network, loopback and link-local addresses would let users reach the server's own network. Only site administrators' own configurations, and hosts the server administrator lists in `HYHOJ_AI_PRIVATE_HOSTS` (see [AI environment](AI-Environment.md)), may use them; other users get `PRIVATE_ENDPOINT_BLOCKED`. Every resolved address is checked and pinned for the connection, and redirects aren't followed.

Set up [HTTPS](HTTPS.md) before anyone enters keys on a public site.

## Configuration fields

These are the fields the configuration page saves. Both the model and the search settings are checked on every save, even if you changed only one.

| Field | Default | Meaning |
| --- | --- | --- |
| `llm.type` | `chat` | API format: `chat`, `responses` or `anthropic` (see below) |
| `llm.baseUrl` | `https://api.openai.com/v1` | Provider address |
| `llm.apiKey` | none | Up to 4096 characters. Leaving it empty keeps the saved key only if the Base URL is exactly the same; any change to the URL, even a trailing slash, clears it. |
| `llm.model` | empty | Model ID, up to 200 characters. Required to generate or test. |
| `llm.reasoning` | empty | Reasoning effort or token budget, up to 50 characters; empty uses the provider's default (see below) |
| `llm.maxTokens` | `16384` | **Maximum output tokens**, 512 to 1000000: the output limit, not the context length. For `api.deepseek.com` it's capped at 393216, and the page says so. |
| `llm.responsesRecovery` | `auto` | **Connection recovery** for the `responses` format: `auto`, `off` or `background` |
| `search.type` | `tavily` | `tavily` or `mcp` |
| `search.baseUrl` | `https://api.tavily.com` | Tavily adds `/search`; MCP uses the address as given. Choosing MCP fills in `https://mcp.tavily.com/mcp/`. |
| `search.apiKey` | none | Kept or cleared like the model key. Both Tavily and MCP need one. |
| `search.tool` | empty | MCP only: the tool to call, exactly as `tools/list` names it. Empty uses the first tool whose name contains `search`. |
| `maxConcurrentJobs` | `3` | **Maximum concurrent AI jobs** of yours that run at once, 1 to 8 |

Saved keys are never sent back to the browser; the page only shows whether one is saved. **Delete saved key** removes the key of the current tab.

### API formats and presets

| Format | Endpoint and authentication | Output limit and reasoning |
| --- | --- | --- |
| `chat` | `/chat/completions`, Bearer key | `max_completion_tokens` on `api.openai.com`, `max_tokens` elsewhere; reasoning as `reasoning_effort` |
| `responses` | `/responses`, Bearer key | `max_output_tokens`; reasoning as `reasoning.effort` |
| `anthropic` | `/messages`, `x-api-key` and `anthropic-version: 2023-06-01` | `max_tokens`; thinking as described below |

Models are listed from `/models` under the Base URL (for Anthropic, up to 20 pages). The presets are:

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

A preset only fills in the format and address: it doesn't mean every model of that provider has been tested with LLMOJ.

**Reasoning** is passed on as follows; your model must support what it receives.
- **DeepSeek** (`api.deepseek.com`): `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. `none` turns thinking off; anything else turns it on with that effort.
- **Anthropic:** empty or `none` leaves thinking off. A number is a thinking budget in tokens: at least 1024 and less than the maximum output tokens. Any other value requests adaptive thinking with that effort.
- **Alibaba Cloud** (`dashscope.aliyuncs.com`, `chat`): `none` turns thinking off; anything else turns it on, and a number also sets the thinking budget.
- **OpenRouter** (`chat`): `none` turns reasoning off; anything else sets its effort.
- **Other `chat` providers** receive `reasoning_effort` as given.

### Connection recovery

With **Connection recovery**, a `responses` request runs in the background at the provider (`background: true`, `store: false`), and LLMOJ saves the response ID and polls for the result. If the connection drops, the job can pick up the same response instead of paying for a new one; LLMOJ never resends the original request when only its reply was lost. `auto` uses this only with the official `api.openai.com`; `background` turns it on for another provider that supports it (not `api.deepseek.com`); `off` turns it off. Changing the key, address or request means a new request.

### Search and MCP

Tavily is asked for up to five results with `advanced` search. MCP servers are reached over Streamable HTTP (JSON or event streams) with `initialize`, `notifications/initialized`, `tools/list` and `tools/call`; local stdio MCP servers aren't supported. The query is passed as `query`, `search_query` or `q`, whichever the tool accepts, with `max_results=5` when it's accepted; tools that need other parameters may not work. For Tavily's hosted MCP, LLMOJ adds the key to the address itself: don't put keys in Base URLs.

Without a search key, the **source** action fails with `SEARCH_NOT_CONFIGURED`, and combined actions skip source discovery and carry on. A source that couldn't be verified is never presented as the original problem.

## Permissions and jobs

| To | You need |
| --- | --- |
| Change your AI configuration, list models, test the connection | `ManageAiConfiguration`, for your own configuration only |
| Start or retry AI actions on a problem | `UseAi` and permission to modify the problem |
| Generate test data (`testdata`, `all`) | also `GenerateTestdata`, and permission to edit the problem's data |
| Import a problem, including its ZIP attachment | `UseAi`, `ImportProblem`, `GenerateTestdata` and permission to create problems |
| See or cancel jobs and usage | Your own only. Administrators can't see other users' keys. |

Permissions are checked again before anything is written. If someone edits the statement, samples or judge settings, or your permission is removed, while a job runs, the job stops with a conflict or permission error instead of overwriting the changes.

- A job reads your configuration when it starts, and uses it throughout. Changes apply to jobs started (or retried) afterwards.
- At most 8 jobs run on the site at once, and one per problem. Each user has up to **Maximum concurrent AI jobs** running and at most 100 running or queued. Lowering your limit doesn't stop jobs already running.
- Generated programs are compiled and run by the local judge, which runs at most three AI pipelines at once and shares its judge slots with ordinary judging; see [Judge configuration](Judge-Configuration.md).
- **Import** runs: statement recognition, source, translation, tags, difficulty, solution, test data. **All** does the same without creating the problem; **metadata** runs source, translation, tags and difficulty only.
- You can ask for 5 to 1000 test cases (20 by default). The number may be raised, up to 1000, so that subtask scores divide evenly; the page says when this happens. Import supports traditional, interactive and communication problems (communication mode `run-twice` or C++ `grader`, detected or chosen); create answer-only problems by hand.
- Import accepts statement files up to 10 MiB (Markdown or text, or PNG, JPEG, WebP or GIF images) and a ZIP attachment up to 64 MiB.

## Site limits

Site administrators can limit AI use in **Site management** (`/site-management`), under **AI**. Changes apply at once, to every account, and are recorded in the audit log.

| Setting | Default | Meaning |
| --- | --- | --- |
| **Pause AI** | off | While AI is paused, no AI request starts: no model calls, searches, model lists or connection tests. Requests already running finish. Queued and running jobs wait, and continue where they stopped when AI is resumed. |
| **Tokens per account in 24 hours** | 0 (no limit) | Input and output tokens the provider reports, over any 24 hours |
| **Model and search requests per account in 24 hours** | 0 (no limit) | Model generations and web searches, over any 24 hours |
| **Model and search requests per job** | 500 | Across all attempts of one job, including retries (0 for no limit) |
| **AI requests at the same time** | 16 | For the whole site (per backend process). Jobs wait for a free place; model lists and connection tests are refused when none is free. |

The limits count against the account whose configuration, and so whose provider key, a request uses. Model lists, progress checks of background responses and MCP handshakes aren't counted as requests, though they stop when AI is paused and wait for a free place like everything else. Connection tests do count: they make a real model request or search.

**How tokens are counted.** Before a model request is sent, it holds the most tokens it could use: its output limit plus a generous estimate of its input (about three English characters, or one Chinese character, per token, and 4096 per image). When the provider reports what the request used, the reported figure replaces the hold. If the provider reports nothing, or the request is interrupted, the hold keeps counting at that maximum. A request that the provider refused with an error status isn't counted. So a request is refused when what's already used plus what it might use would exceed the limit, and a single request whose output limit alone exceeds the limit is refused with a request to lower **Maximum output tokens**.

Under **Usage**, each user sees what they've used of the limits in the last 24 hours, including tokens still held.

When a limit stops a job, the job fails with a message saying which limit, and keeps its progress: retry it once the limit allows. Budgets aren't money: LLMOJ doesn't know providers' prices, and a provider may still charge for a request that was interrupted.

Pausing AI doesn't empty the queue: the [upgrader](Upgrade.md) still waits for queued AI jobs, so cancel them or let them finish before upgrading.

## Test data validation and coverage

For traditional problems, generated test data passes these checks before it's published:

1. **Plan.** The model analyses the limits, degenerate cases and complexity, and plans the coverage: correct algorithms, an exact checker for small inputs (the "oracle"), and one to four plausible wrong or too-slow programs to defeat, at least one of them wrong.
2. **Independent programs.** A small-input generator, the oracle and a second efficient solution are each written separately, from the statement, limits and plan only, without seeing the main generator or reference solution. The oracle prefers simple exhaustive methods; if no tiny inputs are legal, it uses an exact method that's feasible at the smallest legal size.
3. **Differential testing.** At least 64 legal small inputs (more if there are more than 64 subtasks), covering every subtask, are checked by an independent validator; the reference and second solution must then agree with the oracle on all of them.
4. **Cross-check.** Every final test case is checked with the second solution, using the real checker, so problems with several correct answers or floating-point output aren't compared literally.
5. **Challenges.** The planned wrong and slow programs are compiled and run, and each must fail on one of the exported final test cases.

Data is published only when all of these pass.

A challenge program must pass every official sample. A wrong program must pass at least one small input in each subtask it targets, and a slow one every small input it applies to. A wrong program is defeated by a wrong answer, runtime error, time limit or memory limit on a final test case; a slow program only by exceeding the real time or memory limit (a wrong answer or crash disqualifies the probe). Compile errors, checker failures and infrastructure errors never count as defeating a program.

The generator builds specific legal inputs for each target rather than relying on large random ones. For example, SPFA on a shortest-path problem is a "slow" target only if the limits allow a graph that really makes it time out; programs are never rejected by algorithm name, and valid alternative algorithms are accepted by the real checker.

If a target survives the first final tests, up to 16 further counterexamples are tried. A useful one replaces an ordinary case in the same subtask; the minimum and maximum boundary cases and every existing counterexample are kept, and the number of cases and subtask scores don't change. If a target still survives, generation fails and the data isn't published.

The job shows the differential counts, the second solution's checks, each target's verdict and the test cases that defeated it; `result.testdataQuality.extraAttemptsUsed` records extra attempts. `data.yaml` records the plan (`qualityPlan`), results (`qualityValidation`), final case indices (`finalCaseIndices`) and SHA-256 hashes of the auxiliary programs (`verificationSources`). `seed` is a scenario number, not a random seed: the exported input is the evidence. The auxiliary programs stay private to the job and aren't published with the data.

Interactive and communication problems keep their protocol simulation and checks but can't use this independent testing; they get a `TESTDATA_QUALITY_PROTOCOL_UNSUPPORTED` warning. However many tests pass, they can't prove that every wrong or slow program fails, or that the reference solution is correct. All this takes more model calls, money and time; see [AI environment](AI-Environment.md).

## Uploads, cancelling and failures

- A job is created only after its files have uploaded successfully. **Cancel upload** stops a preparation or upload, and leaving the page cancels them. Once the server has accepted a job, closing the page doesn't stop it: cancel it in **My AI jobs**. If starting a job timed out, look at **My AI jobs** before importing again.
- Cancelling can't undo what the provider has already charged or what the job has already published.
- If the generated `make.cpp` doesn't compile, the model gets one chance to repair it. Uploaded checkers, interactors, managers and graders are never rewritten. A second failure, a sample failure or a failed data check fails the job.
- Solutions are checked for claims about sources and scoring before they're published; this doesn't replace reviewing their algorithms yourself.
- If a browser can't read a file (for example Firefox installed as a Snap reading files owned by root), copy the file into a folder your desktop user owns. Don't turn off the browser's sandbox.

## Where AI runs and where keys are kept

Model and search requests are made by the backend. Compiling and running generated programs uses the judge on the **same server** through a local socket (the `all` role), or, on a `web` site, a remote judge through the judge queue, with the same result. See [Distributed judging](Distributed-Judging.md#ai).

AI configurations are stored in the `ai_configuration` table, each encrypted with AES-256-GCM using the site's master key, `data/ai/master.key` by default (directory mode `0700`, key `0600`, both owned by the backend's user). If saved configurations exist but the key is missing, the backend refuses to start rather than create a new one. **Back up the database and the master key together**: no other key can decrypt them. See [AI environment](AI-Environment.md).

Usage records keep each request's provider, model, timing and reported usage, never keys, prompts or responses. **Usage** shows 1 to 366 days (30 by default); usage a provider didn't report isn't estimated there, and failed and retried requests count as calls.

## Solutions and Self Eval

AI-written solutions appear in the problem's **Solutions** tab and in their author's **My discussions**; see [Solutions](Solutions.md).

Publishing official data for a traditional problem also saves the make.cpp, std.cpp and input validator that produced it, for later NOI / OI contests with [Self Eval](Self-Evaluation.md). In **Configure Self Eval**, **AI: generate official data and Self Eval programs** runs the test data action and uses the manager's own AI configuration and permissions.

## Sources

[ai.dto.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.dto.ts), [ai.types.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.types.ts), [ai-provider.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-provider.ts), [ai-admission.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-admission.service.ts), [ai-responses.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-responses.ts), [ai.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.service.ts), [ai-crypto.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-crypto.ts), [ai-testdata-quality.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-testdata-quality.ts), [aiQuality.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiQuality.ts), [aiRunner.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiRunner.ts).
