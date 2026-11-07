const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const { AI_RUNNER_CAPABILITIES, taskCapabilityGaps, aiAbiProbe } = require('@libreoj/judge-protocol');
const { parseTaskContract, interfaceProposal } = require('./ai-task-contract.ts');
const { repairContract, modelVisible, routeAiFailure } = require('./ai-repair.ts');
const { validateAiQualityPlan, aiPlanProposal } = require('./ai-testdata-quality.ts');
const { applyPlanFieldRepair, qualityPlanSchema, preparePlanProposal } = require('./ai-plan-schema.ts');
const { workflowActions, workflowState } = require('./ai-workflow-state.ts');
const { corpusContext } = require('./ai-corpus.ts');
const { searchDiagnostic, safeHttpError } = require('./ai-search-diagnostics.ts');
const { structuredOutputBody } = require('./ai-model-dispatch.ts');
const { bareAiServices } = require('./ai-test-services.cjs');

// Synthetic minimal contracts only; no incident archive data.
const contract = (duplex = false) => ({
  version: 1, mode: duplex ? 'persistent_duplex' : 'sequential_communication',
  lifetime: duplex ? 'two_live_isolated_roles' : 'two_fresh_processes',
  interface: { headers: [{ name: 'public_api.h', identity: 'synthetic-v1' }], functions: [
    { name: 'Encode', signature: 'int Encode(int value)', owner: 'contestant', role: 'sender' },
    { name: 'Decode', signature: 'int Decode(int message)', owner: 'contestant', role: 'receiver' },
    { name: 'Send', signature: 'void Send(int message)', owner: 'grader', role: 'sender' }
  ] }, roles: [{ name: 'sender', permittedInformation: ['private integer'] }, { name: 'receiver', permittedInformation: ['encoded public message only'] }],
  framing: 'One length-delimited message; EOF ends the sender.',
  scoring: { scope: duplex ? 'subtask' : 'case', reduction: duplex ? 'max' : 'binary', metric: duplex ? 'maximum message length' : 'correct decoded value' }
});
const plan = () => ({ version: 1, correctAlgorithms: ['Exact linear recurrence', 'Same feasible algorithm, independent invariant and reverse traversal'], oracleMethod: 'Exhaustive enumeration of at most eight items', smallInputStrategy: 'One to eight items with all legal value bounds', targets: [{ id: 'overflow', kind: 'wrong', algorithm: 'Narrow accumulation', reason: 'Signed width overflow', subtasks: [1], construction: 'Legal large values with a wide sum' }] });

test('duplex lifecycle and subtask-wide max scoring are refused; sequential one-way stays supported', () => {
  assert.deepEqual(taskCapabilityGaps(parseTaskContract(contract()), AI_RUNNER_CAPABILITIES), []);
  assert.deepEqual(taskCapabilityGaps(parseTaskContract(contract(true)), AI_RUNNER_CAPABILITIES), ['mode:persistent_duplex', 'lifetime:two_live_isolated_roles', 'scoring:subtask:max']);
  assert.throws(() => parseTaskContract({ ...contract(true), lifetime: 'two_fresh_processes' }), /INVALID_AI_TASK_CONTRACT/);
  assert.match(repairContract('std', contract()), /NO main/);
  assert.equal(interfaceProposal('int main() {return 0;}', contract().interface).accepted, false);
});

test('real compiler and linker enforce the pinned public ABI including unused callbacks', t => {
  if (spawnSync('g++', ['--version']).status !== 0) return t.skip('g++ unavailable');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoj-abi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'public_api.h'), 'int Encode(int); int Decode(int); void Send(int);\n');
  fs.writeFileSync(path.join(dir, 'grader.cpp'), '#include "public_api.h"\nvoid Send(int) {}\nint main(){return Encode(3) != 3;}');
  fs.writeFileSync(path.join(dir, 'probe.cpp'), aiAbiProbe(contract().interface));
  const compile = code => { fs.writeFileSync(path.join(dir, 'candidate.cpp'), code); return spawnSync('g++', ['-std=c++17', 'candidate.cpp', 'grader.cpp', 'probe.cpp', '-o', 'candidate'], { cwd: dir }); };
  assert.equal(compile('#include "public_api.h"\nint Encode(int x){return x;} int Decode(int x){return x;}').status, 0);
  assert.notEqual(compile('int main(){return 0;}').status, 0);
  assert.notEqual(compile('int Encode(int x){return x;}').status, 0, 'unused Decode must still link');
  assert.notEqual(compile('long Encode(long x){return x;} int Decode(int x){return x;}').status, 0);
  assert.notEqual(compile('int main(){ int n=2; auto x=long double(n); }').status, 0, 'synthetic bad cast fails immediately');
});

test('schema field repair is hash-bound, preserves accepted fields and never deletes targets', () => {
  const value = plan(); value.targets[0].kind = 'wrong or slow';
  const validation = validateAiQualityPlan(value, [{ id: 1 }]);
  assert.deepEqual(validation.issues.map(i => i.path), ['targets[0].kind']);
  const proposal = aiPlanProposal(value, validation.issues, 1);
  const patch = { hash: proposal.hash, replacements: [{ path: 'targets[0].kind', value: 'wrong' }] };
  const repaired = applyPlanFieldRepair(proposal, patch);
  assert.deepEqual(repaired, plan());
  assert.equal(value.targets[0].kind, 'wrong or slow');
  assert.equal(validateAiQualityPlan(repaired, [{ id: 1 }]).issues.length, 0);
  assert.throws(() => applyPlanFieldRepair(proposal, { ...patch, hash: 'stale' }), /FIELD_REPAIR/);
  assert.throws(() => applyPlanFieldRepair(proposal, { ...patch, replacements: [{ path: 'targets', value: [] }] }), /FIELD_REPAIR/);
  const padded = plan(); padded.targets[0].reason = ' '.repeat(4000) + 'valid' + ' '.repeat(4000);
  assert.equal(validateAiQualityPlan(padded, [{ id: 1 }]).plan.targets[0].reason, 'valid');
  assert.equal(qualityPlanSchema([{ id: 1 }]).properties.targets.items.properties.kind.enum.includes('wrong or slow'), false);
  assert.match(preparePlanProposal(plan()).targets[0].id, /^t_[a-f0-9]{32}$/);
});

test('one field-repair budget survives a process-shaped state round trip', async () => {
  const service = bareAiServices();
  let calls = 0;
  service.checkpoint = async (job, step) => { job.step = step; };
  const bad = plan(); bad.targets[0].kind = 'wrong or slow';
  service.model = async () => { calls++; return { hash: job.state.planProposal.hash, replacements: [{ path: 'targets[0].kind', value: 'still invalid' }] }; };
  let job = { input: {}, progress: 0, state: { planProposal: aiPlanProposal(bad, validateAiQualityPlan(bad, [{ id: 1 }]).issues, 1) } };
  const config = { llm: { type: 'chat' } };
  await assert.rejects(service.boundedQualityPlan(job, config, { subtasks: [{ id: 1 }] }, { statements: [], samples: [], judgeInfo: {} }, ''), /INVALID_AI_QUALITY_PLAN/);
  job = JSON.parse(JSON.stringify(job));
  await assert.rejects(service.boundedQualityPlan(job, config, { subtasks: [{ id: 1 }] }, { statements: [], samples: [], judgeInfo: {} }, ''), /INVALID_AI_QUALITY_PLAN/);
  assert.equal(calls, 1);
  assert.equal(job.state.planRepair.spent, 1);
});

test('unsupported contract stops the workflow before source, editorial, or code generation', async () => {
  const service = bareAiServices();
  delete service.services.workflow.ensureTaskContract;
  const job = { id: 'job', action: 'all', input: {}, progress: 0, state: { completed: [], plan: { taskContract: contract(true) } } };
  service.config = async () => ({ llm: {} });
  service.assertJob = async () => ({});
  service.recordAiAudit = async () => {};
  service.checkpoint = async (j, step) => { j.step = step; };
  service.editable = async () => ({ type: 'Communication' });
  service.snapshot = async () => ({ statements: [], samples: [], judgeInfo: {} });
  service.execution = { availableCapabilities: async () => [AI_RUNNER_CAPABILITIES] };
  service.edit = service.testdata = service.model = async () => assert.fail('downstream call');
  await assert.rejects(service.execute(job), /AI_TASK_NEEDS_CONFIGURATION/);
  assert.equal(job.state.workflow.blocking.kind, 'needs_configuration');
});

test('workflow options and explicit private-corpus policies remain distinct', () => {
  assert.equal(workflowActions('all', 'qualify_first')[0], 'testdata');
  assert.equal(workflowActions('all', 'default')[0], 'source');
  assert.equal(workflowActions('import', 'metadata_only').includes('testdata'), false);
  const state = workflowState({}); state.corpus = [{ id: 'author-1', class: 'author_validation', modelAccess: 'private', inputBytes: 244000 }];
  assert.equal(corpusContext(state).validationSummary, undefined);
  assert.equal(corpusContext(state, 'summaries').validationSummary[0].inputBytes, 244000);
  const observation = { phase: 'validate-samples' }; const artifact = { classification: 'author-private' };
  assert.equal(modelVisible(observation, artifact), false);
  assert.equal(modelVisible(observation, artifact, 'summaries'), false);
  assert.equal(modelVisible(observation, artifact, 'model_visible'), true);
});

test('oracle timeout alone requires attribution, while proven domain overflow repairs the generator', () => {
  const context = { aiWritten: () => true, customChecker: false };
  assert.equal(routeAiFailure({ kind: 'time_limit', role: 'quality-oracle', phase: 'quality-differential' }, context).reason, 'ATTRIBUTION');
  assert.equal(routeAiFailure({ kind: 'oracle_domain_exceeded', role: 'quality-small-make', phase: 'quality-differential' }, context).role, 'quality-small-make');
});

test('search diagnostics are bounded and omit query bytes and provider body text', () => {
  const diagnostic = searchDiagnostic(safeHttpError(400, 'req-123'), 'tavily', 'private query');
  assert.equal(diagnostic.retryable, false); assert.equal(diagnostic.category, 'invalid_request');
  assert.equal(diagnostic.requestId, 'req-123'); assert.match(diagnostic.queryHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(diagnostic).includes('private query'), false);
  assert.equal(searchDiagnostic(safeHttpError(503), 'tavily', 'x').retryable, true);
  assert.deepEqual(structuredOutputBody({ type: 'anthropic', structuredOutput: 'json_schema' }, { name: 'plan', schema: {} }), {});
  assert.equal(structuredOutputBody({ type: 'responses', structuredOutput: 'json_schema' }, { name: 'plan', schema: {} }).text.format.type, 'json_schema');
});

test('a rejected compile/link proposal never replaces the active repair source', async () => {
  const service = bareAiServices();
  const { AiError } = require('./ai.types.ts');
  const provider = require('./ai-provider.ts'); const old = provider.generateText;
  const original = 'int main(){return 1;}';
  const job = { id: 'repair', ownerId: 1, input: {}, progress: 0, state: { stdCode: original, plan: {}, completed: [] } };
  service.assertSnapshot = async () => ({ id: 1 });
  service.privileges = { userHasPrivilege: async () => true, permissionDecision: async () => true };
  service.checkpoint = async () => {};
  service.compileArtifact = async () => { assert.equal(job.state.stdCode, original); assert.equal(job.state.repairProposal.status, 'quarantined'); throw new AiError('AI_ARTIFACT_COMPILE_FAILED'); };
  const row = { id: 'failure', observation: { kind: 'compile_error', phase: 'compile-std', role: 'std', artifacts: [] } };
  provider.generateText = async () => 'int main(){undefined_symbol();}';
  try {
    assert.equal(await service.repairProgram(job, { llm: {}, search: {} }, { type: 'Traditional' }, { statements: [], samples: [], judgeInfo: {} }, 'std', row, 'automatic'), null);
    assert.equal(job.state.stdCode, original);
    assert.equal(job.state.repairProposal.status, 'rejected');
    assert.equal(job.state.repair.revisions[0].rejected, 'INVALID');
  } finally { provider.generateText = old; }
});

test('performance repair replays every retained disagreement and timeout before full qualification', async () => {
  const service = bareAiServices();
  const provider = require('./ai-provider.ts'); const old = provider.generateText;
  const original = 'int main(){return 1;}';
  const rows = ['solver_disagreement', 'time_limit', 'time_limit'].map((kind, i) => ({ id: `failure-${i}`, evidence: 'stored', expiresAt: new Date(Date.now()+86400000), observation: {
    kind, phase: 'generate', role: 'quality-alt-0', expectedBasis: 'reference_output', subject: `case ${[46,79,98][i]}`,
    artifacts: [{ role: 'input', stored: true, size: 4, originalSize: 4 }]
  } }));
  const job = { id: 'regressions', ownerId: 1, input: {}, progress: 0, state: { stdCode: 'int main(){}', plan: {}, qualityArtifacts: { alternatives: [{ id: 'independent', code: original }] } } };
  service.assertSnapshot = async () => ({ id: 1 });
  service.privileges = { userHasPrivilege: async () => true, permissionDecision: async () => true };
  service.checkpoint = service.recordAiAudit = async () => {};
  service.services.workflow.evidence = { list: async () => rows.map(r => ({ ...r.observation, id: r.id })) };
  service.keptFailure = async (_j, id) => rows.find(r => r.id === id);
  const seen = [];
  service.testKeptFailure = async (_j, _p, row) => { seen.push(row.id); return 'passed'; };
  provider.generateText = async () => 'int main(){return 0;}';
  try {
    await service.repairProgram(job, { llm: {}, search: {} }, { type: 'Traditional' }, { statements: [], samples: [], judgeInfo: {} }, 'quality-alt-0', rows[2], 'owner');
    assert.deepEqual([...new Set(seen)].sort(), rows.map(r => r.id).sort());
    assert(job.state.workflow.regressions.every(r => r.replay === 'passed'));
  } finally { provider.generateText = old; }
});

test('candidate preflight labels an uploaded-sample failure as baseline and never dispatches a final run', async () => {
  const service = bareAiServices(); delete service.services.workflow.qualifyCandidate;
  const target = plan().targets[0];
  const job = { id: 'candidate', input: { count: 5 }, progress: 0, state: { plan: { timeLimitMs: 1000, memoryLimitMiB: 128, subtasks: [{ id: 1 }], outputComparison: 'tokens', caseSensitive: true }, qualityPlan: plan(),
    caseAllocation: { cases: Array.from({ length: 5 }, (_, i) => ({ subtask: 1, seed: i+1 })) },
    stdCode: 'std', makeCode: 'make', validatorCode: 'validator', qualityArtifacts: { version: 1, smallMakeCode: 'small', oracleCode: 'oracle', alternatives: [{ id: 'independent', code: 'alt' }], challenges: [{ ...target, code: 'candidate' }] } } };
  service.checkpoint = async () => {};
  service.prepareSampleFiles = async () => ({ files: [{ inputFile: '1.in', outputFile: '1.out', inputUuid: 'in', outputUuid: 'out' }], directory: null });
  let calls = 0;
  service.runSandbox = async (_job, request) => { calls++; assert.equal(request.operation, 'qualify'); return { validation: { samplesPassed: 1, sampleInputsPassed: 1 }, qualification: { fuzzPassed: 64, candidates: [target.id], baselines: [{ id: target.id, sample: 1, corpus: 'author_validation', verdict: 'WA' }] } }; };
  const snapshot = { statements: [], samples: [], judgeInfo: {} };
  await assert.rejects(service.qualifyCandidate(job, { type: 'Traditional' }, snapshot, 0), /AI_NOVEL_TARGET_REQUIRED/);
  assert.equal(job.state.workflow.candidates[0].role, 'baseline');
  assert.equal(job.state.workflow.blocking.kind, 'candidate_baseline');
  await assert.rejects(service.qualifyCandidate(job, { type: 'Traditional' }, snapshot, 0), /AI_NOVEL_TARGET_REQUIRED/);
  assert.equal(calls, 2, 'retry only requalifies locally, never dispatching final data or a model repair');
});

test('a repaired field cannot be applied to a proposal whose retained contents changed', () => {
  const value = plan(); value.targets[0].kind = 'wrong or slow';
  const proposal = aiPlanProposal(value, validateAiQualityPlan(value, [{ id: 1 }]).issues, 1);
  proposal.candidate.oracleMethod = 'unapproved different method';
  assert.throws(() => applyPlanFieldRepair(proposal, { hash: proposal.hash, replacements: [{ path: 'targets[0].kind', value: 'wrong' }] }), /FIELD_REPAIR/);
});

test('provider-specific quota and JSON-RPC errors have safe distinct categories', () => {
  const { safeMcpError } = require('./ai-search-diagnostics.ts');
  for (const status of [432, 433]) assert.equal(searchDiagnostic(safeHttpError(status), 'tavily', 'q').category, 'quota');
  assert.equal(searchDiagnostic(safeMcpError({ code: -32602, message: 'sensitive body' }), 'mcp', 'q').category, 'invalid_request');
  assert.equal(searchDiagnostic(safeMcpError({ code: -32603 }), 'mcp', 'q').retryable, true);
  assert.equal(JSON.stringify(safeMcpError({ code: -32602, message: 'sensitive body' })).includes('sensitive body'), false);
});

test('optional editorial reference lookup cannot reintroduce the blocking source dependency', async () => {
  const service = bareAiServices(); service.checkpoint = async () => {};
  const provider = require('./ai-provider.ts'); const old = provider.searchWeb;
  let requests = 0; provider.searchWeb = async () => { requests++; throw safeHttpError(400); };
  const job = { state: {}, progress: 0, step: 'tutorial' };
  const config = { sourcePolicy: 'optional', search: { type: 'tavily', baseUrl: 'https://search.invalid', apiKey: 'synthetic' } };
  try {
    assert.match(await service.references(job, config, 'reference query'), /lookup failed/);
    assert.match(await service.references(job, config, 'reference query'), /unavailable/);
    assert.equal(requests, 1);
    assert(job.state.warnings.includes('OPTIONAL_REFERENCE_SEARCH_UNAVAILABLE'));
  } finally { provider.searchWeb = old; }
});

test('required provenance verifies existing author metadata without overwriting it', async () => {
  const service = bareAiServices(); const search = require('./ai-source-search.ts'); const old = search.discoverProblemSource;
  service.assertSnapshot = async () => ({ id: 1 }); service.commitProblem = async () => assert.fail('existing author source must not be overwritten');
  const problem = { originalProblem: 'https://example.org/problem/1' };
  const config = { sourcePolicy: 'required', search: { type: 'tavily', apiKey: 'synthetic' } };
  const snapshot = { statements: [], samples: [], judgeInfo: {} };
  try {
    for (const conflict of [false, true]) {
      const job = { action: 'all', input: {}, state: {} };
      search.discoverProblemSource = async (_snapshot, _dependencies, options) => {
        assert(options.sourceHints.includes(problem.originalProblem));
        return { status: 'verified', url: conflict ? 'https://example.org/problem/2' : problem.originalProblem, reason: 'verified', evidence: 'matching statement', trace: { searchCount: 1 } };
      };
      await service.edit(job, { id: 1 }, problem, config, snapshot, 'source');
      assert.equal(job.state.workflow.provenance.status, conflict ? 'unverified' : 'verified');
      if (conflict) assert.equal(job.state.workflow.provenance.reason, 'existing_author_source_conflict');
    }
  } finally { search.discoverProblemSource = old; }
});

test('replayed evidence preserves the reused timing label', () => {
  const { parseAiReplayRuns } = require('@libreoj/judge-protocol');
  const runs = parseAiReplayRuns([{ outcome: 'failed', kind: 'solver_disagreement', summary: 'mismatch', execution: { status: 'OK', timeMs: 2, timing: 'reused' } }], 1);
  assert.equal(runs[0].execution.timing, 'reused');
});
