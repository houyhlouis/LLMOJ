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

**Private addresses** need a site administrator's approval: see [Which addresses accounts may use](#which-addresses-accounts-may-use).

Set up [HTTPS](HTTPS.md) before anyone enters keys on a public site.

## Which addresses accounts may use

Model, search and MCP requests go out from the server, not from the user's browser. A private-network, loopback or link-local address would therefore let a user reach the server's own network, so it needs approval. Site administrators decide in **Site management** → **AI addresses**:

- **Approved addresses.** Each has a name, the API it speaks and a Base URL. An approved Base URL covers every request at or below its path, on the same scheme, host and port. Users see approved addresses first among the presets on the AI configuration page (search and MCP ones on the **Search / MCP** tab). Hosts listed in the server's `HYHOJ_AI_PRIVATE_HOSTS` ([AI environment](AI-Environment.md)) count as approved too.
- **Addresses that aren't approved.** Either public addresses are allowed (the default; private and local ones still need approval), or only approved addresses are. In the second case, a configuration with another address isn't saved (`ENDPOINT_NOT_APPROVED`), and requests to it are refused, also for configurations saved before.
- **Addresses in use.** The section lists the addresses accounts have saved, how many accounts use each and whether they can: approved, a public address, or refused for accounts other than administrators' (a private address, or one not approved where only approved addresses are allowed). **Approve** adds one to the list, ready to save.

Site administrators' own configurations may use any address. A refused private address gives `PRIVATE_ENDPOINT_BLOCKED`. Every resolved address is checked and pinned for the connection, so a host name can't switch to a private address afterwards, and redirects aren't followed. Changes apply within a few seconds and are recorded in the audit log.

A downgrade to a version without approved addresses is refused while only approved addresses are allowed: allow public addresses first.

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

**Room for counterexamples.** Test cases are shared out by subtask points, so a subtask worth little can get only one or two cases: for example, subtasks worth 98 and 2 points with 5 cases requested get 49 cases and 1. The first two cases of a subtask are its minimum and maximum, so a target that applies only to such a subtask would never get an input built for it. Once the quality plan is known, before any program is written, each such subtask gets enough cases for its targets: in the example, 3 instead of 1 (52 in all). The subtask's points don't change; its cases share them, so each of its cases is worth less than the others. The job says which subtasks it changed and why (`CASE_CAPACITY_ADJUSTED`).

**Counterexamples found later.** If a target survives the first final tests, up to 16 further counterexamples are tried. Each one is checked like any final case (input validator, reference solution, second solution) and run against every applicable wrong or slow program, including those already defeated. It then replaces a case in the same subtask, never the minimum or maximum:

- a case that is no target's counterexample, if there is one;
- otherwise a case that is the counterexample of other targets, only if the new input defeats all of those targets too. Their counterexample moves to it, so no target loses its counterexample.

A counterexample that fits neither isn't placed, and the search goes on. The number of cases and subtask scores never change.

**Small counterexamples.** When a wrong program fails one of the small differential inputs but survives the final tests, that small input is tried first, before any new search. It's used only if it's legal for its subtask, the oracle, the reference solution and the second solution all agreed on it, and it defeats the program. It then replaces a case of its subtask by the same rules.

If a target still survives, generation fails and the data isn't published. The job says whether the search ran out of attempts or found no case it could replace.

**What the counts mean.** The job shows the differential counts and how many **distinct** inputs they were, the second solution's checks, each target's verdict, the test case that defeated it, and on how many of the final cases it was run. A target already defeated isn't run on later cases, so those outcomes stay unknown rather than counted. Repeated inputs are reported, not refused: a problem with few legal small inputs repeats them. The job warns when differential inputs or final cases repeat (`DIFFERENTIAL_INPUTS_REPEATED`, `FINAL_CASES_REPEATED`), since a repeat adds no coverage. Replaced cases say whether their counterexample came from the search or from differential testing, and which targets' counterexample moved to them.

`data.yaml` records:

- the plan (`qualityPlan`);
- the results (`qualityValidation`): distinct differential inputs (`fuzzDistinct`); which final cases each target was run on and which defeated it (`matrix`); the replacements and the search (`replacements`, `search`);
- the cases per subtask and any added for counterexamples (`allocation`);
- the number of distinct final inputs (`corpus.distinct`);
- the final case indices (`finalCaseIndices`);
- the SHA-256 hashes of the auxiliary programs (`verificationSources`).

`seed` is a scenario number, not a random seed: the exported input is the evidence. The auxiliary programs stay private to the job and aren't published with the data.

Interactive and communication problems keep their protocol simulation and checks but can't use this independent testing; they get a `TESTDATA_QUALITY_PROTOCOL_UNSUPPORTED` warning. However many tests pass, they can't prove that every wrong or slow program fails, or that the reference solution is correct. All this takes more model calls, money and time; see [AI environment](AI-Environment.md).

## Scoring and judging settings

Generating test data replaces a problem's test cases, not how they're judged.

- **Scoring.** If the problem's judging settings have subtasks of their own, the job keeps them: each subtask's points, how it's scored (the sum of its test cases, its lowest test case, which makes it all or nothing, or their product), the subtasks it depends on, and whether a submission that fails a sample gets no points. The new test cases are shared out by those points. The job stops right after planning, before writing any program, if the statement's subtasks don't match the problem's (another number, order or points), if a subtask has its own time or memory limit, or if test cases have their own points or limits (those belong to the cases being replaced). It then shows **The problem's settings** beside **Published if you approve**, and why. **Approve the new scoring and continue** publishes exactly that change, and the approval is recorded in the audit log; if the problem or the plan has changed since, the change is shown again. To keep the problem's scoring instead, change its subtasks in the judging settings and choose **Retry (subtasks changed)**. A problem without subtasks of its own gets the statement's, each the sum of its test cases.
- **Checkers, interactors and managers.** One the problem already has keeps its compile options (compiler, C++ standard, optimization, architecture) and its time and memory limits, and the job checks the data with exactly those. One the job writes is published with explicit limits, at least 5 seconds and 256 MiB (the problem's limits if they're higher): the ones it was checked with. A checker is never checked with more time or memory than it gets when judging submissions. Settings the job can't check with (limits over 60 seconds or 4,096 MiB) stop it before it starts.
- **Isolation.** Each program of a job (generators, reference solution, input validator, checker, oracle, second solution and challenges) runs seeing only its own compiled program, never another's: a challenge can't pass by running the reference solution.
- **In the job.** A finished job says whether it kept, set or replaced the scoring settings, and how its checker, interactor or manager was compiled and limited. `data.yaml` records the scoring decision with its SHA-256 digest (`scoring`), and each program's settings (`executionProfiles`).

AI test data programs run on judges of protocol version 8; see [Distributed judging](Distributed-Judging.md#ai).

## Uploads, cancelling and failures

- A job is created only after its files have uploaded successfully. **Cancel upload** stops a preparation or upload, and leaving the page cancels them. Once the server has accepted a job, closing the page doesn't stop it: cancel it in **My AI jobs**. If starting a job timed out, look at **My AI jobs** before importing again.
- Cancelling can't undo what the provider has already charged or what the job has already published.
- Cancelling a job that's generating test data stops the program it's running at once (a compiler, a solution, or an interactive problem's solution and interactor together), on this server or on a judge machine, and none of its programs starts afterwards, even one that was waiting for its turn. A cancelled run isn't a failure: none of it is kept as failure evidence, and none of it is published.
- When a program fails while generating test data, the job repairs the one program it wrote that's at fault, runs the same programs again, or stops for your decision: see [When generation fails](#when-generation-fails). Uploaded checkers, interactors, managers and graders are never rewritten, and keep their own compile options and limits.
- Solutions are checked for claims about sources and scoring before they're published; this doesn't replace reviewing their algorithms yourself.
- If a browser can't read a file (for example Firefox installed as a Snap reading files owned by root), copy the file into a folder your desktop user owns. Don't turn off the browser's sandbox.

## When a job is interrupted

If the server restarts while a job generates test data (an upgrade, a crash), the job resumes where it stopped and doesn't start its test data over:

- If its programs were running on a judge machine, the job waits for that same run again. If the judge restarted too, it runs it again with the programs it had already compiled and the inputs it had already generated: the cases made before the restart are kept byte for byte, although generators draw fresh randomness. Their checks are run again.
- If the site's own judge runs them, the run stops with the restart; when the job resumes, it runs again with the compiled programs and inputs the judge kept.
- If the run had finished, its result is taken as it is, not made again, even if the job stopped while publishing it.

A job that fails after its run finished (for example because the problem changed meanwhile) keeps that result for 24 hours: retrying with exactly the same programs and settings publishes it instead of generating new data. Any change to a program, the cases or the settings makes a new run, which never takes the old one's result. It takes the compiled programs that didn't change and, while the generator is the same, the inputs it generated: a repaired reference solution is checked on the inputs the old one failed on.

A finished job says where its data was made: on this server or on a judge machine, whether the job collected a finished result again after it stopped, and how many compiled programs and inputs were reused. `data.yaml` records this (`generation.execution`) with the SHA-256 and size of every case (`generation.corpus`), and the published files are exactly those cases.

What a judge keeps for this (each job's compiled programs and each generator's inputs, in its data store under `ai-builds` and `ai-corpus`) is deleted when the job finishes, or a day after it was last used.

## When generation fails

**When the testing plan is rejected.** Before any program is written, the job asks the model for a differential and adversarial testing plan: correct methods, an oracle for small inputs and the wrong or slow solutions to catch. An answer that is complete JSON can still break the plan's rules, for example a reason over 2,000 characters, a target ID that isn't a lowercase identifier, a subtask written as `"1"` instead of `1`, or a kind that isn't exactly `wrong` or `slow`. The job then fails with **The testing plan has N invalid fields**, lists each field with the rule it broke (its path, the limit and the actual size, never the text), and keeps the rejected plan privately with the job. No program has run. **Retry** asks for a new plan. A provider that cut the answer short (*output truncated*) or an answer that isn't JSON at all are reported as such, not as an invalid plan.

When a program of a test data job fails, the job decides what to do from what failed (see [Failure details](#failure-details)) instead of writing every program again:

- **The infrastructure failed** (the connection to a judge machine, storage or the sandbox, not the programs): the job runs the same programs again, without asking the model, up to 2 times. A correct program (the reference solution, the oracle or the second solution) that went over its time or memory limit is first run again on the kept input; if it doesn't fail again, the job runs everything again instead of rewriting it.
- **One program the job wrote is at fault**: the job asks the model to repair that program, sending it the failure, the evidence and the program's source. Every other program stays as it is, and so do the plan, the cases, the limits and the checks. For example, a second solution that doesn't compile is repaired without touching the generator, the oracle, the input validator, the reference solution or the checker. Which program is at fault:
  - a compilation error: the program that didn't compile;
  - the input validator rejects a statement sample: the validator (samples are legal);
  - the input validator rejects a generated input: the generator that made it (the validator is never loosened to accept it);
  - a program crashes, goes over a limit or writes too much: that program;
  - the reference solution's output differs from an official sample's, compared by a built-in checker: the reference solution;
  - a checker crashes or accepts malformed output: the checker;
  - a challenge program isn't a valid one: that challenge, for the same target;
  - a wrong or slow program wasn't rejected: the generator, given the target to build an input for.
- **The repair is tested first** against the kept failure: the program is compiled again, or run again on the kept input. If it still fails the same way, the job stops there. Otherwise all the programs run again.
- **The job stops for your decision** when nothing trusted says which program is wrong, or when the program isn't the job's to change:
  - the reference solution disagrees with the oracle, or the second solution with the reference solution (all AI-written: none is trusted over the other), or a sample's output with a checker the job wrote: choose the program to repair;
  - the problem's own checker, interactor or manager failed: fix it in the problem's judging settings, then retry (the job never changes them);
  - the reference solution is a tutorial's code: you may have it repaired, and it becomes a separate program; the tutorial stays as it is;
  - no test case could be replaced with a counterexample, the execution budget ran out, or nothing says which program failed;
  - a repair didn't change the failure, the model proposed the same program or one that isn't valid, or the job used its repairs.
- **Limits.** A job makes at most 3 repairs by itself and 8 in all. Restarts and retries don't reset these counts. Each repair is one model request, counted in your budgets like any other.

In **My AI jobs**, a job that stopped says why, with **Repair** for each program involved, and **Write all programs again**, which writes every program again from the same plan (what retrying did before). **Run the same programs again** retries with the programs as they are, for example after the infrastructure recovered. **Repairs** lists each repair: the program, the failure it repaired, whether the job made it or you chose it, whether it passed the kept failure, and how the next run ended; a replay that tested a repair says so under **Failure details**. A finished job says how many repairs its data was made after, and `data.yaml` records the SHA-256 of every program the data was made and checked with, and the repairs (`generation.revision`). Repairs are recorded in the audit log (`ai.job.repair`).

The model is never sent the problem's own sample files, only statement samples and what the job's programs made, and configured keys are removed from what it's sent.

## Failure details

When a run of an AI job's programs fails, the job keeps what failed and the exact data involved, before the run's working files are deleted. **Failure details** under the job in **My AI jobs** (and in a problem's **AI** panel) lists them, latest first:

- **What failed**: a compilation error, a rejected input, outputs that differ, a runtime error, a time or memory limit, too much output, a checker that failed or accepted malformed output, an invalid challenge program, a wrong or slow program that wasn't rejected, the execution budget, or a failure of the judging infrastructure rather than the programs. **Ended the latest run** marks the one that failed the job's latest run.
- **Which program and which case**: for example std.cpp on *differential case 7, subtask 2*, or the alternative solution on a final test case. A case index isn't a random seed: generators draw fresh randomness each time, so only the kept input reproduces a failure.
- **How it ran**: the verdict, exit code, time and memory against their limits.
- **What it was compared with**: an official sample's output, the brute-force oracle's output (also AI-written, so a disagreement isn't proof that the reference solution is wrong), or the reference solution's output. For the built-in comparisons, where the outputs first differ.
- **The evidence**: the input, the program's output, the output it was compared with and the diagnostics (compiler messages, the checker's or the program's error output), each with its size and whether it's a public sample, hidden test data or the author's own. A preview shows the start (diagnostics without the compiler's terminal colours); **Show more** reads 64 KiB at a time, and **Download** gets the whole file, byte for byte, through a link valid for 2 minutes (downloads are recorded in the audit log).
- **A challenge that wasn't rejected** shows whether the extra search for counterexamples ran out of attempts or couldn't run because no test case could be replaced. A small input it failed during differential testing is shown as a related small counterexample: it isn't exported test data, so it doesn't count as rejecting the program.
- **A tutorial's solution** that failed its sample check is kept too, marked as such; the job went on with a model-written reference solution.

**Replay** runs a failure's check again with the exact data that was kept: the reference solution against the oracle (or the official sample's output) on the kept input, the input validator on the kept input, a generator with the same subtask and case index, a program on the kept input, or the checker on the kept files. It runs 3 times (a compilation once), where the job's programs run, with the job's programs as they are now and the problem's current settings. Each replay shows:

- **Reproduced** (every run failed the same way), **Not reproduced** (no run failed), **Unstable** (the runs didn't all end the same way) or **Failed another way**, and each run's outcome.
- Whether it ran the programs that failed or the job's programs as they are now (a retry may have rewritten them: a replay then says whether they still fail on that input), and whether the problem's judging settings changed since.

A failure that isn't about one input (a wrong or slow program that wasn't rejected, the execution budget, the judging infrastructure) or a tutorial's code can't be replayed, nor one whose evidence expired or wasn't kept whole; for interactive and communication problems, only compilations and input validation are. One replay runs at a time for each job and each user, none while the job is queued or running, and the job can't be retried during one. Replays are recorded in the audit log, and a failure keeps its 5 latest.

Only the job's owner sees these, and only while they could still run the job: the AI and test data permissions, and permission to modify the problem. The evidence is kept for **14 days**; the summary stays 90 days without the data. Each kept artifact is at most 16 MiB (only the start of a larger one is kept, and it says so) and 64 MiB per failed run; a job keeps at most 256 MiB and 64 failures, and the whole site 2 GiB. When evidence couldn't be kept (the limits, a storage failure, or a judge machine older than protocol version 6), the failure says so instead of showing data.

The evidence is stored with the site's files, as temporary objects under `temporary/ai-evidence/` that the backend deletes when they expire, and the failures in the `ai_observation` table. On a `web` site, the judge machine uploads the evidence of a failed run before it reports the failure; a failure reported while the backend was restarting is the outcome the job takes when it runs again (the run isn't made again), or the cleanup every 10 minutes records it.

## Job evidence and cost

Each test data job in **My AI jobs** has an **Evidence and cost** line:

- **Model generations**: how many answers the job asked a model for, what each was for (plans, programs, repairs, tutorial, translation, source search…), and how many requests failed. What a request is for is recorded when it's sent, so a request made just before a job failed is still counted under its purpose (jobs from before Part 35 count those as *other*).
  - **Polling requests** are counted apart: with [connection recovery](#connection-recovery), one generation can be checked on many times while the provider works on it, and each check is a request but not a new generation, nor billed as one.
  - **Rejected testing plans**: answers that arrived complete but broke the plan's rules (see [When generation fails](#when-generation-fails)). The provider request succeeded; the plan wasn't accepted.
  - **Tokens** the provider reported, with the cached input and reasoning output tokens when it reports them, the searches, and the generations whose usage no response reported. A background generation's usage arrives with the poll that completes it, so it isn't counted as unreported once that poll reports it, and a response recovered twice is counted once. These are counts, not prices: LLMOJ doesn't know what a provider charges.
- **Runs of the programs:** how many, and how long they took in all. **Show runs** lists each one: how it ended (all programs passed, or the failure), whether it was the run after a repair, or a replay that tested a repair, how long it took, where it ran, and how many compiled programs and inputs it reused. A job keeps its 20 latest runs.

Under **Repairs**, **Show change** shows what a repair changed in its program, as a diff: removed lines, then added lines, with 3 lines around them. A change of more than 64 KiB shows its start only.

When jobs stopped for your decision, **My AI jobs** says how many at the top, and **Show only these** lists just them, each with its decision.

## Where AI runs and where keys are kept

Model and search requests are made by the backend. Compiling and running generated programs uses the judge on the **same server** through a local socket (the `all` role), or, on a `web` site, a remote judge through the judge queue, with the same result. See [Distributed judging](Distributed-Judging.md#ai).

AI configurations are stored in the `ai_configuration` table, each encrypted with AES-256-GCM using the site's master key, `data/ai/master.key` by default (directory mode `0700`, key `0600`, both owned by the backend's user). If saved configurations exist but the key is missing, the backend refuses to start rather than create a new one. **Back up the database and the master key together**: no other key can decrypt them. See [AI environment](AI-Environment.md).

Usage records keep each request's provider, model, timing and reported usage, never keys, prompts or responses. **Usage** shows 1 to 366 days (30 by default); usage a provider didn't report isn't estimated there, and failed and retried requests count as calls.

## Solutions and Self Eval

AI-written solutions appear in the problem's **Solutions** tab and in their author's **My discussions**; see [Solutions](Solutions.md).

A job publishes its tutorial before its test data. While making the test data it runs the tutorial's C++ code on the official samples as the reference solution; code that fails is set aside for a separate, model-written reference solution, which a repair may replace again. The job card says, for each tutorial (题解-AI and Tutorial-AI), what its code is now:

- **its code hasn't been checked** (or **it shows no C++ program the job could run**);
- **its code passed the N official samples; no test data is published yet**;
- **its code failed an official sample check (…)**, with the sample and the message, and the failure under **Failure details**;
- **its code is the reference solution the published test data was made and checked with**;
- **the published test data was made with another reference solution; its code wasn't checked as the reference**.

The tutorial's page shows its readers a short note with the same status, such as **This AI-written tutorial's code failed an official sample check, so it isn't the problem's reference solution.** A note says what the code passed, never that the explanation or proof is verified.

When a tutorial's code was rejected or set aside and the job completed with published test data, **Use the reference solution's code in the tutorials** rewrites both tutorials around the reference solution: the job puts exactly that program in each, rewrites the explanation where it describes another algorithm, and updates the same discussions (same links, titles and visibility). Nothing else of the job runs again, and a rewrite that doesn't show exactly the reference solution changes nothing. A problem judged with named files can't take this correction while its reference solution reads standard input and output.

Publishing official data for a traditional problem also saves the make.cpp, std.cpp and input validator that produced it, for later NOI / OI contests with [Self Eval](Self-Evaluation.md). In **Configure Self Eval**, **AI: generate official data and Self Eval programs** runs the test data action and uses the manager's own AI configuration and permissions. Self Eval runs that generator and validator with the time and memory limits the job checked them with.

## Sources

[ai.dto.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.dto.ts), [ai.types.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.types.ts), [ai-provider.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-provider.ts), [ai-admission.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-admission.service.ts), [ai-responses.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-responses.ts), [ai.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.service.ts), [ai-workflow.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-workflow.service.ts), [ai-job-coordinator.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-job-coordinator.service.ts), [ai-artifact-publisher.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-artifact-publisher.service.ts), [ai-crypto.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-crypto.ts), [ai-testdata-quality.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-testdata-quality.ts), [aiQuality.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiQuality.ts), [aiRunner.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiRunner.ts), [aiEvidence.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiEvidence.ts), [ai-evidence.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-evidence.service.ts), [ai-observation.ts](https://github.com/houyhlouis/LLMOJ/blob/main/packages/judge-protocol/src/ai-observation.ts), [ai-session.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-session.ts), [ai-tutorial-binding.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-tutorial-binding.ts), [cancelScope.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/cancelScope.ts).
