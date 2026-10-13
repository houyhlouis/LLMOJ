# AI integration

`AiModule` provides authenticated, owner-scoped LLM and search/MCP configuration and durable jobs under `/api/ai/`. Supported actions include statement import and translation, source discovery, tags, difficulty, tutorials and sandboxed test-data generation. Generated problems remain private, and every write rechecks the current user's permissions and problem snapshot.

## Credentials and configuration

Provider credentials are encrypted with AES-256-GCM. Configuration responses expose `hasKey` without returning saved API keys. Saving a new provider URL clears the old key unless a replacement is supplied. The frontend clears submitted keys; request bodies, provider error bodies and keys are excluded from AI diagnostics and usage records.

`HYHOJ_AI_STATE_DIR` selects the private key directory. The backend creates a 32-byte `master.key` with mode `0600` inside a directory with mode `0700` and verifies ownership and file type. Keep this file outside the source repository. An existing encrypted database requires its matching original key; a missing key causes startup to fail. Private database backups must include the corresponding key and must never be committed or distributed with source code.

Provider requests support HTTP/HTTPS and permit private, loopback and public destinations without a `HYHOJ_AI_PRIVATE_HOSTS` allowlist. DNS lookup results remain pinned to each connection. Redirects and credential-bearing Base URLs remain rejected; account permissions and owner-scoped key storage are unchanged. Model output limits and API capabilities remain provider-specific; the application validates its configured limits before issuing a request.

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

## Tests

Run the mock unit tests and type check from `apps/backend`:

```sh
node --test --test-concurrency=1 src/ai/*.test.cjs
./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

The judge quality suite runs without a rootfs or native sandbox:

```sh
node --test apps/judge/src/aiQuality.test.cjs
```

Run that command from the repository root. CI runs both the backend mock suite and this judge suite, as documented in the bilingual development guides. Real sandbox acceptance requires a dedicated execution environment and verifies compilation, actual resource verdicts and checker behavior separately.

The mock tests use synthetic keys. MariaDB tests are opt-in through their documented test configuration environment variables and create temporary tables; select a disposable test database.

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
