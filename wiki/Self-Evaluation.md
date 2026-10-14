# Self Eval for NOI / OI contests

[简体中文](Self-Evaluation.zh-CN.md) | English | [Wiki home](Home.en.md)

Self Eval is available **only in NOI / OI contests** whose manager enables it. It is disabled by default. IOI, Strict IOI, ICPC / ACM, ordinary problem pages and submission pages do not offer Self Eval.

During the contest, open a contest problem and select **Self Eval**. Enter code, choose an allowed language and compiler options, and select **Run Self Eval**. The fixed hidden pretest set returns status, score, subtask scores, runtime and memory only. Test input, expected output, execution output, compiler diagnostics and checker messages remain private. Self Eval creates no official submission and does not change official scores, acceptance counts or standings. Official NOI submission results retain the format's normal concealment.

## Enable and prepare

1. Edit the contest, select **NOI / OI**, enable **Self Eval**, set the contest-wide attempt allowance and save. The default is 30 per participant; supported limits are 1–1000, shared across every contest problem.
2. Add a traditional code problem. Open its contest problem page, select **Self Eval**, and locate **Configure Self Eval**.
3. Enter **make.cpp** and **std.cpp** in the code editors. These must be the programs used for the current official data. Both compile as C++17; each source is limited to 1 MiB.
4. Verify the subtask IDs. If std.cpp uses file I/O, enter its actual input and output filenames.
5. Confirm that the programs generated the current official data, then select **Save make.cpp / std.cpp**.
6. Select **Prepare pretest data** and refresh until the set is Ready. Saving the programs and preparing the set must finish before the contest starts.

Configuration requires contest management, problem modification and test-data editing permissions. Participants need contest participation, problem submission and self-evaluation permissions. Existing contest, problem and team access checks remain effective.

The server hashes the sources and stores immutable versions. Pretests use the same official generator and standard solution. **They reuse the problem's official checker / SPJ automatically; no separate SPJ entry is needed.** An input validator bound by AI official-data generation is reused when present. Manual configuration requires only make.cpp and std.cpp.

The generator receives `subtaskId seed` as command-line arguments and as a line on standard input, then outputs one complete test input. The standard solution reads that input and produces the expected answer. Each contest/problem context receives one fixed set shared by all participants.

## AI generation

The configuration section includes **AI: generate official data and Self Eval programs**. It requires AI-use and test-data-generation permissions, a configured AI API and a working judge. It runs the existing official-data generation pipeline, **updates this problem's official judging data**, and binds matching immutable make.cpp, std.cpp and validator versions.

After completion, the configuration section reloads the generated sources. Select **Prepare pretest data** to prepare the contest's set. Official-data generation from the ordinary problem editor also binds matching programs for future NOI contests; it does not enable ordinary problem-bank Self Eval.

## Allowances and limits

- The default allowance is 30 per participant for the entire contest. Managers can change it; all problems share the allowance, which does not reset daily.
- Runs are accepted only during the contest. Creating a record consumes one attempt, including later compilation errors, wrong answers, timeouts and runtime infrastructure errors.
- Invalid parameters, denied access, unavailable data and failed preparation consume no attempt.
- An account can have at most three pending runs. Atomic quota updates prevent concurrent requests from exceeding the allowance.
- At most twenty subtasks are supported, with one generated case per configured subtask. Each input and expected output is limited to 4 MiB. The whole base64-encoded JSON set must fit within 16 MiB.

These are LLMOJ's configurable implementation limits, not a claim that every NOI event uses the same allowance. Passing Self Eval does not guarantee a full official score.

Changing the formal judge configuration or program versions invalidates the prepared set. A set already used in the same contest context cannot be replaced, ensuring that participants do not receive different tests. Use a new context when necessary. Sets cannot be configured or prepared after the contest begins.
