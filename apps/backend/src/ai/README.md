# AI integration

`AiModule` provides authenticated, owner-scoped LLM and search/MCP configuration and durable jobs under `/api/ai/`. Supported actions include statement import and translation, source discovery, tags, difficulty, tutorials and sandboxed test-data generation. Generated problems remain private, and every write rechecks the current user's permissions and problem snapshot.

## Prompt and content languages

Repository-maintained system instructions, task prompts and injected formatting/protocol/scoring rules use English. This includes image extraction and OCR verification, statement translation, source discovery and verification, tutorials, tags, difficulty calibration, test-data plans, generators, validators, checkers, protocol judges, reference/independent solutions, quality probes and generator repair. The prompt regression suite follows model call sites and imported instruction fragments to check this convention.

Instruction language does not change content language. Extraction preserves the original statement language; translation follows its requested locale; `zh_CN` output remains Chinese and `en_US` output remains English. Bilingual tutorial/tag/explanation requirements and JSON keys remain intact. Original statements, quotations, search results, code and user input stay untrusted data in their original language. Chinese parsing expressions and localized editor/UI labels remain in place.

## Credentials and configuration

Provider credentials are encrypted with AES-256-GCM. Configuration responses expose `hasKey` without returning saved API keys. Saving a new provider URL clears the old key unless a replacement is supplied. The frontend clears submitted keys; request bodies, provider error bodies and keys are excluded from AI diagnostics and usage records.

`HYHOJ_AI_STATE_DIR` selects the private key directory. The backend creates a 32-byte `master.key` with mode `0600` inside a directory with mode `0700` and verifies ownership and file type. Keep this file outside the source repository. An existing encrypted database requires its matching original key; a missing key causes startup to fail. Private database backups must include the corresponding key and must never be committed or distributed with source code.

Provider requests support HTTP/HTTPS. Public destinations are open to every user; private, loopback and link-local destinations require a site administrator's own configuration (the runtime's `allowPrivateNetwork`) or a host listed in `HYHOJ_AI_PRIVATE_HOSTS`. Every resolved address is checked, and DNS lookup results remain pinned to each connection. Model listing and connection tests are bounded per user and site-wide. Redirects and credential-bearing Base URLs remain rejected; account permissions and owner-scoped key storage are unchanged. Model output limits and API capabilities remain provider-specific; the application validates its configured limits before issuing a request.

`HYHOJ_AI_SAMPLE_INPUTS_DIR` and `HYHOJ_AI_GENERATED_DIR` select private temporary work directories. Backend and judge configuration must agree on the sandbox input paths and runner socket. Generated programs execute in the judge sandbox. Its root filesystem and compiler dependencies are supplied separately from the source repository.

AI jobs use bounded concurrency, resumable checkpoints and cancellation checks. Source discovery requires search evidence and semantic verification. Test-data installation validates generated input, applicable samples, the traditional-task quality gate and permissions before activating the new judge configuration. Usage records contain request metadata and reported usage counts, without credentials or prompt/response bodies.

## Test-data quality gate

Traditional problems use three independent checks before new data is activated:

1. A separately generated small-input generator and brute-force oracle check the reference solution on at least 64 legal boundary and random inputs, with at least one input for every subtask. The input validator also checks these inputs. The oracle is requested separately from the reference solution; it uses a simpler exhaustive method rather than copying the optimized implementation.
2. A separately generated alternative correct algorithm must pass every final input using the configured checker and the problem's time and memory limits. Multiple valid witnesses and floating-point answers are compared using the actual checker, rather than byte equality.
3. Concrete wrong or excessively slow candidate programs are executed against the final dataset. Every candidate must fail on a legal case from its applicable subtasks. The runner can search a bounded number of additional targeted inputs and replace cases while retaining subtask scores. Each replacement is checked by the input validator, reference solution and alternative correct solution before it enters the dataset.

The plan records permitted correct algorithms and identifies each wrong or slow candidate's assumption, applicable subtasks and a concrete adversarial construction. SPFA is a slow target only when the legal graph family and resource limits make it inappropriate; the plan must retain other efficient correct methods. Every slow candidate must pass all applicable small differential inputs. A slow target requires TLE or MLE on a full-size legal input; WA or RE is a faulty implementation, not evidence of algorithmic degeneration. A candidate compilation failure, checker failure or sandbox infrastructure failure does not count as a successful rejection. All candidates must be rejected, all differential inputs must pass and all alternative-solution checks must pass; incomplete or inconsistent reports stop publication.

The oracle, small-input generator, alternative solution and challenge programs are private validation helpers and are not published as problem files. Existing generated make.cpp, std.cpp and validator.cpp artifacts are retained, and data.yaml includes the quality report.

The final report records differential counts and each rejected candidate's final case index and verdict (WA, RE, TLE or MLE). This provides evidence against the chosen candidate programs, not a proof that every possible incorrect implementation is rejected. Cases use fresh randomness, so reported final inputs are the reproducible counterexamples; a case index is not a random seed. The number of inputs, models and adversarial attempts is bounded to protect the shared judging queue.

Interactive and communication problems keep their existing hidden-state and protocol validation. Their jobs explicitly report that the independent brute-force and wrong-algorithm quality gate currently applies only to traditional problems.

## Judging contract

A test-data job works within its problem's judging contract (review Part III, W02), resolved by `ai-judging-contract.ts` before the job spends anything on programs.

- **Execution profiles.** Each role of a run (`std`, `alternative`, `challenge`, `oracle`, `generator`, `validator`, `checker`, `interactor`, `manager`) has a profile: C++ compile options, time and memory limits, CPU class (user program, checker or interactor, as the judge runs it) and whether it's compiled with the bundled `testlib.h` and the problem's extra source files. The shared type and parser are `packages/judge-protocol/src/ai-profile.ts`. A checker, interactor or manager the problem already has keeps its own options and limits (the problem's where it has none); one the job writes gets the defaults and explicit limits of at least 5,000 ms and 256 MiB (at least the problem's), which it is published with. Solutions run with the problem's limits and file I/O, the job's own programs (generators, validator, oracle) with 5,000 ms and 512 MiB, and Self Eval runs the published generator and validator with those too (`selfEval.limits`). Helper settings the job can't check with (other options, limits above 60 s or 4,096 MiB) are refused before the plan (`AI_HELPER_SETTINGS_UNSUPPORTED`).
- **The runner.** The AI runner (judge protocol 7) compiles and runs every program with its role's profile and nothing else, and reports the profiles' digest with its result; a result without it is refused (`INVALID_SANDBOX_RESPONSE`). Only judges of protocol 7 are sent AI runs. A request without profiles, from an older backend, runs as before (`aiProfile.ts`, `legacyProfiles`).
- **Isolation.** Each program is compiled into a directory of its own and runs with only that directory mounted (read-only): no role can list, read or run another's binary. The protocol path already ran its two programs this way.
- **Publication.** Before activation, `profileDifferences` reads the judging settings to be published the way the judge does (a checker's own limits or the problem's, an interactor's time limit at least the problem's) and stops publication if any published program would be judged with other settings than it was checked with (`AI_PROFILE_MISMATCH`).
- **Scoring.** A problem whose judging settings have subtasks of their own has an established scoring policy: each subtask's points (automatic points worked out), scoring type (`Sum`, `GroupMin`, `GroupMul`), dependencies and own limits, and whether samples are judged first. Its SHA-256 (`scoringDigest`) is unchanged by regenerated cases that keep it. The plan is asked for these subtasks when the statement's correspond to them one to one, and keeps them (their points included); both publication paths (traditional and protocol) use `publishedSubtasks`. A plan whose subtasks differ in number, order or points, or settings bound to the replaced cases (a subtask's own limits, test case points or limits), stop the job right after the plan with `AI_SCORING_REVIEW_REQUIRED` and `state.scoringReview` (both policies and why). The owner approves exactly that change by retrying with `retryFrom: "replace-scoring"` (audited with both digests); retried without it, the job plans again after the owner changed the subtasks. A problem without subtasks of its own gets the plan's, each a sum. `data.yaml` records the scoring decision and digest, and the execution profiles with their digest.

## Failure evidence

A failed run of a job's programs is kept as typed observations with their evidence (review Part III, W01), before the run's workspace is cleaned up. The shared contract is `packages/judge-protocol/src/ai-observation.ts`, exported by `@libreoj/judge-protocol`: failure kinds, artifact roles and classifications, limits, `textPreview`, `firstDifference` and `parseAiRunFailure`, which the backend applies to everything a runner sends.

- **Judge.** Each place a failure passes through adds what it knows (`aiFailure.ts`): the sandbox run its program, verdict and measurements, a comparison its input, outputs and the checker's message, the quality checks the program's role, the case and what the output was compared with (`expectedBasis`: an official sample, the candidate oracle or the reference output). `aiEvidence.ts` writes the exact bytes into the run's evidence directory within fixed limits (16 MiB per artifact, 64 MiB and 8 observations per run; a larger artifact keeps its start and says so) and describes them in `failure.json`. A canceled run keeps nothing. A challenge that survives carries its first small failing input as a related `small_counterexample` observation, and whether the extra search stopped at its budget or for lack of a replaceable case. The local runner's directory is `<generated>/<job>/failure`, which the backend reads before it asks for the job's cleanup; a judge machine (protocol 6) uploads it through forms signed for evidence names only, then reports the failure as `AiExecutionProgress.failure`.
- **Backend.** `AiEvidenceService.record` copies each artifact into `temporary/ai-evidence/<observation>/<role>` after checking its size and SHA-256 against the report, and stores the observations in `ai_observation` with IDs derived from the run's attempt, so recording a run twice records it once. Artifacts that can't be stored are recorded as missing, with why; nothing unverified is kept. Evidence is bounded per job (256 MiB, 64 observations) and for the site (2 GiB), and deleted after 14 days (previews and difference excerpts too); the observation stays 90 days. A failure reported while no backend waited is recorded when the job runs again, or by the 10-minute AI run cleanup before it removes the run. Transport and time-limit failures the backend sees itself are recorded without evidence, and a runner that sent none as `unclassified`.
- **Use.** The typed failure decides the one `make.cpp` compile repair (the message is read only for older judges), and the repair prompt gets the compiler's kept diagnostics without terminal colours (also left out of the job's error message and diagnostics previews; the kept bytes have them). A tutorial's solution that fails its check is recorded with `context: "tutorial-reference"`, not as the failure that ended the job. The job owner reads observations through `ai/failures`, `ai/failureArtifact` (64 KiB parts that end on whole characters) and `ai/downloadFailureArtifact` (a 2-minute link, audited), only while they may still run the job (`AiJobCoordinator.assertEvidenceAccess`).

## Tests

Run the mock unit tests and type check from `apps/backend`:

```sh
node --test --test-concurrency=1 src/ai/*.test.cjs
./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

The judge quality suite runs without a rootfs or native sandbox:

```sh
node --test apps/judge/src/aiQuality.test.cjs apps/judge/src/aiEvidence.test.cjs apps/judge/src/aiProfile.test.cjs
```

`aiProfile.test.cjs` also checks the judging contract against the judge's own reading of judging settings (checker limits, interactor limits, compile parameters).

Run that command from the repository root. CI runs both the backend mock suite and this judge suite, as documented in the bilingual development guides. Real sandbox acceptance requires a dedicated execution environment and verifies compilation, actual resource verdicts and checker behavior separately.

The mock tests use synthetic keys. MariaDB tests are opt-in through their documented test configuration environment variables and create temporary tables; select a disposable test database. The attachment cases of `ai-actions.mariadb.test.cjs` extract real ZIP archives in the system temporary directory (or the directory of `HYHOJ_AI_TEST_RESULTS`), and extraction keeps 2 GiB free, so set `TMPDIR` to a larger filesystem when `/tmp` is a small tmpfs.

The `.mjs` integration suites additionally require an explicitly configured disposable backend, test fixture users and sandbox runner. `test/integration-client.mjs` requires all of:

- `HYHOJ_TEST_CONFIG`: a private backend YAML file whose database name starts with `hyhoj_test_` and whose database host is a numeric loopback address.
- `HYHOJ_TEST_STATE`: a private JSON file with `users` and `tokens` maps for newly created test accounts. Do not reuse production sessions or include this file in the repository.
- `HYHOJ_TEST_BASE`: the loopback origin of the dedicated test backend or frontend proxy, without URL credentials, query or path.

Use a dedicated local Redis instance configured with an explicit nonzero logical database. The client rejects the former installation's service ports. It validates the configuration before connecting and refuses HTTP redirects. The default AI fixture account is `ai_fixture`; `HYHOJ_AI_FIXTURE_USER` can select another dedicated test account, but `admin` is rejected. The synthetic provider on loopback port `2230` works without an address allowlist.

Browser integration requires Playwright available as a local backend development dependency. Screenshots are saved only when `HYHOJ_TEST_EVIDENCE_DIR` is set to a directory outside the repository. After integration tests, remove the disposable test database, sessions and temporary files.

## References

- [OpenAI Responses API](https://developers.openai.com/api/docs/)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Tavily search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [Codeforces API](https://codeforces.com/apiHelp): embedded difficulty calibration uses official metadata; provenance is recorded in `deploy/content/codeforces-calibration.json`.

## NOI contest Self Eval integration

Successful traditional-data publication binds immutable, hash-checked copies of the exact generator, standard solution and validator used by that job. The enabled NOI / OI contest problem’s Self Eval dialog can explicitly start the existing `testdata` workflow through its AI button, regenerate formal data, reload matching make/std sources and then prepare the fixed hidden prediction set before the contest begins. The prediction judge reuses the problem’s formal checker/SPJ; handwritten configuration needs only make/std, with the bound formal validator reused when available. The generator and validator run with the limits the job checked them with (`selfEval.limits`). This binding does not expose ordinary problem-bank Self Eval or alter official scores. Runtime/API scope and quotas are enforced independently by SelfEvalService. See the bilingual [Self Eval guide](../../../../wiki/Self-Evaluation.md).
