# AI integration

`AiModule` provides authenticated, owner-scoped LLM and search/MCP configuration and durable jobs under `/api/ai/`. Supported actions include statement import and translation, source discovery, tags, difficulty, tutorials and sandboxed test-data generation. Generated problems remain private, and every write rechecks the current user's permissions and problem snapshot.

## Credentials and configuration

Provider credentials are encrypted with AES-256-GCM. Configuration responses expose `hasKey` without returning saved API keys. Saving a new provider URL clears the old key unless a replacement is supplied. The frontend clears submitted keys; request bodies, provider error bodies and keys are excluded from AI diagnostics and usage records.

`HYHOJ_AI_STATE_DIR` selects the private key directory. The backend creates a 32-byte `master.key` with mode `0600` inside a directory with mode `0700` and verifies ownership and file type. Keep this file outside the source repository. An existing encrypted database requires its matching original key; a missing key causes startup to fail. Private database backups must include the corresponding key and must never be committed or distributed with source code.

Provider requests require HTTPS and reject redirects, private destinations and URLs containing credentials. For an intentional local provider, set `HYHOJ_AI_PRIVATE_HOSTS` to its exact hostname. Avoid adding public providers to this allowlist unless the deployment requires it. Model output limits and API capabilities remain provider-specific; the application validates its configured limits before issuing a request.

`HYHOJ_AI_SAMPLE_INPUTS_DIR` and `HYHOJ_AI_GENERATED_DIR` select private temporary work directories. Backend and judge configuration must agree on the sandbox input paths and runner socket. Generated programs execute in the judge sandbox. Its root filesystem and compiler dependencies are supplied separately from the source repository.

AI jobs use bounded concurrency, resumable checkpoints and cancellation checks. Source discovery requires search evidence and semantic verification. Test-data installation validates generated input, applicable samples and permissions before activating the new judge configuration. Usage records contain request metadata and reported usage counts, without credentials or prompt/response bodies.

## Tests

Run the mock unit tests and type check from `apps/backend`:

```sh
node --test --test-concurrency=1 src/ai/*.test.cjs
./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

The mock tests use synthetic keys. MariaDB tests are opt-in through their documented test configuration environment variables and create temporary tables; select a disposable test database.

The `.mjs` integration suites additionally require an explicitly configured disposable backend, test fixture users and sandbox runner. `test/integration-client.mjs` requires all of:

- `HYHOJ_TEST_CONFIG`: a private backend YAML file whose database name starts with `hyhoj_test_` and whose database host is a numeric loopback address.
- `HYHOJ_TEST_STATE`: a private JSON file with `users` and `tokens` maps for newly created test accounts. Do not reuse production sessions or include this file in the repository.
- `HYHOJ_TEST_BASE`: the loopback origin of the dedicated test backend or frontend proxy, without URL credentials, query or path.

Use a dedicated local Redis instance configured with an explicit nonzero logical database. The client rejects the former installation's service ports. It validates the configuration before connecting and refuses HTTP redirects. The default AI fixture account is `ai_fixture`; `HYHOJ_AI_FIXTURE_USER` can select another dedicated test account, but `admin` is rejected. Set `HYHOJ_AI_PRIVATE_HOSTS=127.0.0.1` in the disposable backend to enable the synthetic provider on port `2230`.

Browser integration requires Playwright available as a local backend development dependency. Screenshots are saved only when `HYHOJ_TEST_EVIDENCE_DIR` is set to a directory outside the repository. After integration tests, remove the disposable test database, sessions and temporary files.

## References

- [OpenAI Responses API](https://developers.openai.com/api/docs/)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Tavily search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [Codeforces API](https://codeforces.com/apiHelp): embedded difficulty calibration uses official metadata; provenance is recorded in `deploy/content/codeforces-calibration.json`.
