const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, f);
const protocol = require('@libreoj/judge-protocol');
const { projectJob, advanceStage, syncWorkflowTimeline } = require('./ai-job-view.ts');
const { workflowState, tallyWorkflowRequest, startJobStage } = require('./ai-workflow-state.ts');
const { AiJobCoordinator } = require('./ai-job-coordinator.service.ts');
const { AiJobViewService } = require('./ai-job-view.service.ts');
const { AiService } = require('./ai.service.ts');
const { serializeAiJobs } = require('./ai-job-serialization.ts');
const { AiExecutionService } = require('./ai-execution.service.ts');
const { AiError } = require('./ai.types.ts');
const { bareAiServices } = require('./ai-test-services.cjs');
const { withWorkflowModels, workflowText } = require('./ai-model-policy.ts');
const { withAiRuntime, meterProviderRequest } = require('./ai-runtime.ts');
const { recoverableResponse } = require('./ai-responses.ts');
const provider = require('./ai-provider.ts');
const makeJob = () => ({ id: '11111111-1111-4111-8111-111111111111', ownerId: 1, input: { count: 20 }, attempt: 1,
  status: 'running', step: 'testdata.plan', progress: 0, state: {}, revision: 1, updatedAt: new Date() });

for (const [kind, code] of Object.entries({ needs_configuration: 'needs_configuration', plan_schema: 'plan_repair', plan_feasibility: 'plan_feasibility',
  interface_mismatch: 'interface_mismatch', candidate_baseline: 'baseline_challenge', qualification_failed: 'qualification_failed', provenance_policy: 'provenance_policy' })) {
  test(`compact progress preserves ${kind} attention without its private payload`, async () => {
    const job = makeJob(); job.status = 'failed';
    workflowState(job.state).blocking = { kind, diagnostic: 'PRIVATE_DIAGNOSTIC', required: { framing: 'PRIVATE_DESCRIPTION' } };
    job.state.workflow.provenance = { status: 'unverified', reason: 'existing_author_source' };
    const service = Object.create(AiJobCoordinator.prototype);
    service.assertJob = async () => {};
    let patch;
    service.jobs = { update: async (_, value) => { patch = value; return { affected: 1 }; } };
    await service.progress(job, 'testdata.generate', 40);
    assert.equal(patch.projection.attention.code, code);
    assert.equal(patch.projection.provenance, 'unverified');
    assert(!('state' in patch));
    assert(!JSON.stringify(patch).includes('PRIVATE_'));
    job.state.attention = { code: 'scoring_review', message: 'Explicit current decision', retryable: false };
    assert.equal(projectJob(job).attention.code, 'scoring_review');
  });
}

test('detail leads with typed blocking data, one timeline, and safe contract/corpus/provenance panels', async () => {
  const job = makeJob(); job.status = 'failed'; job.error = 'AI_NOVEL_TARGET_REQUIRED';
  const flow = workflowState(job.state);
  flow.blocking = { kind: 'candidate_baseline', candidate: 'target', corpus: 'author_validation', reason: 'WA' };
  flow.contract = { status: 'verified', value: { mode: 'batch', interface: { headers: [], functions: [] } }, snapshot: 'hash', available: [], checkedAt: 'time' };
  flow.corpus = [{ id: 'author-1', class: 'author_validation', modelAccess: 'private' }];
  flow.candidates = [{ id: 'target', role: 'baseline' }];
  flow.regressions = [{ observationId: 'observation', replay: 'pending' }];
  flow.receipts = { executions: 1, comparisons: 1, legality: 1, fresh: 5, reusedTiming: 1 };
  flow.provenance = { status: 'unverified' };
  job.state.sourceSearchTrace = { searches: [{ query: 'PRIVATE_QUERY', attempts: 1, diagnostic: { category: 'invalid_request', queryHash: 'digest', requestShape: 'search-v1' } }] };
  job.state.planRepair = { spent: 1, limit: 1, status: 'exhausted' };
  advanceStage(job, job.step);
  const stage = startJobStage(job, job.step, ['accepted-plan'], ['changed-source']);
  stage.generationId = 'generation'; stage.policy = 'reasoning';
  syncWorkflowTimeline(job);
  const view = Object.create(AiJobViewService.prototype);
  view.authorizedJob = async () => job;
  view.coordinator = { assertEvidenceAccess: async () => {} };
  view.workflow = { retryOptions: () => ['regenerate'], repairRoles: () => [] };
  view.usage = { jobTotals: async () => new Map(), generations: async () => [], generationCounts: async () => ({ logicalGenerations: 1, legacyGenerationRequests: 0 }), recentFailures: async () => [], stageTotals: async () => new Map() };
  view.problemRows = async () => new Map();
  view.db = { getRepository: () => ({ find: async () => [{ fatal: true, runToken: job.runToken, kind: 'time_limit', observation: { role: 'quality-alt-0', artifacts: [] } }] }) };
  const detail = await view.detail({ id: 1 }, { id: job.id });
  assert.equal(detail.blockingReason.kind, 'candidate_baseline');
  assert.deepEqual(detail.blockingReason.data, flow.blocking);
  assert.equal(detail.summary.attention.code, 'baseline_challenge');
  assert.deepEqual(detail.technical.taskContract, flow.contract.value);
  assert.deepEqual(detail.technical.corpusMembership, flow.corpus);
  assert.deepEqual(detail.technical.candidates, flow.candidates);
  assert.deepEqual(detail.technical.regressions, flow.regressions);
  assert.deepEqual(detail.technical.receipts, flow.receipts);
  assert.equal(detail.planRepair.spent, 1);
  assert.equal(detail.timeline.entries.filter(e => e.id === stage.id).length, 1);
  assert.equal(detail.timeline.entries.find(e => e.id === stage.id).generationId, 'generation');
  assert(!JSON.stringify(detail).includes('PRIVATE_QUERY'));
});

test('an old timeline keeps the verified source of its own backend across release changes and identical rebuilds', async t => {
  const identity = require('../health/deployment-identity.ts');
  const { HealthService } = require('../health/health.service.ts');
  const { SettingsEntity } = require('../settings/settings.entity.ts');
  const { UserEntity } = require('../user/user.entity.ts');
  const original = identity.deploymentBuildIdentity;
  t.after(() => { identity.deploymentBuildIdentity = original; });
  let history;
  const settings = {
    findOneByOrFail: async () => ({ value: history }),
    findOneBy: async ({ key }) => key === 'deployment.buildHistory' ? { value: history } : null,
    update: async (_where, data) => { history = structuredClone(data.value); }
  };
  const db = {
    transaction: async (_isolation, work) => work({ query: async () => { history ??= []; }, getRepository: () => settings }),
    getRepository: entity => entity === SettingsEntity ? settings : entity === UserEntity ?
      { findOneBy: async () => ({ id: 1, isAdmin: true }) } : { find: async () => [] },
    query: async () => []
  };
  const health = new HealthService(db, {}, {});
  const old = { status: 'verified', commit: '1'.repeat(40), treeSha256: '2'.repeat(64) };
  const current = { status: 'verified', commit: '3'.repeat(40), treeSha256: '4'.repeat(64) };
  const unknown = { status: 'unknown', commit: null, treeSha256: null };
  const oldDigest = '5'.repeat(64), newDigest = '6'.repeat(64);
  async function start(sha256, provenance) {
    identity.deploymentBuildIdentity = { ...original, backend: { ...original.backend, sha256, provenance } };
    await health.onModuleInit();
  }
  await start(oldDigest, old);
  const job = makeJob();
  advanceStage(job, job.step);
  const historical = job.timeline.entries[0];
  // Digest-only rows predate startup verification. Neither their bytes nor an unknown observation can acquire a
  // revision just because a later backend verified the same bytes.
  for (const binding of [undefined, 'unknown', 'mismatch']) job.timeline.entries.push({ ...historical,
    deployment: { ...historical.deployment, backendBinding: binding, unexpected: '/private/PRIVATE_FIXTURE' } });
  await start(oldDigest, current);
  await start(newDigest, current);
  assert.equal(history.length, 3);
  advanceStage(job, 'testdata.generate');
  const view = Object.assign(Object.create(AiJobViewService.prototype), {
    db, judges: { listJudgeClients: async () => [] }, authorizedJob: async () => job,
    coordinator: { assertEvidenceAccess: async () => {} }, workflow: { retryOptions: () => [], repairRoles: () => [] },
    usage: { jobTotals: async () => new Map(), generations: async () => [], generationCounts: async () => ({}),
      recentFailures: async () => [], stageTotals: async () => new Map() }, problemRows: async () => new Map()
  });
  const output = await view.exportDiagnostic({ id: 1 }, job.id);
  assert.equal(output.exportVersion, 2);
  assert.equal(output.deployment.backend.sha256, newDigest);
  assert.deepEqual({ ...output.deployment.backend.provenance }, current);
  const entries = output.detail.timeline.entries.items.map(entry => entry.deployment);
  assert.deepEqual(entries.map(entry => entry.backendBuild), [oldDigest, oldDigest, oldDigest, oldDigest, newDigest]);
  assert.deepEqual(entries.map(entry => ({ ...entry.backendProvenance })), [old, unknown, unknown, { ...unknown, status: 'mismatch' }, current]);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_FIXTURE|backendBinding/);
  const before = structuredClone(history);
  await start(oldDigest, unknown);
  assert.deepEqual(history, before);
  history = history.slice(0, 1);
  assert.equal((await view.exportDiagnostic({ id: 1 }, job.id)).detail.timeline.entries.items[0].deployment.backendProvenance.status, 'unknown');
});

test('recovered model dispatch keeps one stage/generation across workflow, journal, usage and timeline', async () => {
  const original = provider.generateText;
  let job = makeJob(); advanceStage(job, job.step);
  const saved = new Map(), records = [];
  let restart = true, posts = 0, persisted;
  const config = { llm: { type: 'responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic', model: 'fixture' } };
  provider.generateText = async () => {
    const response = await recoverableResponse(config.llm, { input: 'synthetic' }, async (_, __, operation, identity) => {
      assert.equal(job.state.workflow.stages[0].id, identity.stageId);
      assert.equal(persisted.state.workflow.stages[0].generationId, identity.generationId);
      const response = await meterProviderRequest({ target: 'llm', provider: 'responses', host: 'fixture', operation, ...identity }, async () => {
        if (operation === 'generate') { posts++; return { data: { id: 'resp_fixture', object: 'response', status: 'queued' } }; }
        if (restart) throw new AiError('JOB_LEASE_LOST');
        return { data: { id: 'resp_fixture', object: 'response', status: 'completed', output_text: 'result' } };
      });
      return response.data;
    }, { pollMs: 1 });
    return response.output_text;
  };
  const run = () => withAiRuntime({ ownerId: 1, jobId: job.id, record: async record => { records.push(record); tallyWorkflowRequest(job.state, record); },
    stageId: () => 'WRONG_MUTABLE_STEP', loadResponse: async key => structuredClone(saved.get(key) || null),
    saveResponse: async (key, value) => saved.set(key, structuredClone(value)) }, () =>
    withWorkflowModels(job, config, async () => { syncWorkflowTimeline(job); persisted = structuredClone(job); }, () => workflowText(config.llm, 'system', 'prompt')));
  try {
    await assert.rejects(run(), /JOB_LEASE_LOST/);
    job = JSON.parse(JSON.stringify(persisted)); job.attempt = 2; restart = false;
    advanceStage(job, job.step);
    assert.equal(await run(), 'result');
    assert.equal(posts, 1);
    assert.equal(job.state.workflow.stages.length, 1);
    const stage = job.state.workflow.stages[0], journal = [...saved.values()][0];
    assert.equal(stage.id, journal.stageId); assert.equal(stage.generationId, journal.generationId);
    assert(records.every(row => row.stageId === stage.id && row.generationId === stage.generationId));
    assert.deepEqual(records.map(row => row.requestAttempt), [1, 2, 3]);
    assert.equal(stage.requests, 3); assert.equal(stage.responsePolls, 2); assert.equal(stage.failedRequests, 1);
    assert.equal(stage.resumptions[0].attempt, 2);
    assert.equal(job.timeline.entries.filter(entry => entry.id === stage.id).length, 1);
    assert.equal(job.timeline.entries.find(entry => entry.id === stage.id).status, 'completed');
  } finally { provider.generateText = original; }
});

test('a spent in-flight field repair resumes, while an exhausted or regenerated repair cannot spend twice', async () => {
  const { aiPlanProposal, validateAiQualityPlan } = require('./ai-testdata-quality.ts');
  const candidate = { version: 1, correctAlgorithms: ['Linear recurrence', 'Independent reverse traversal'], oracleMethod: 'Exhaustive enumeration', smallInputStrategy: 'At most eight items', targets: [{ id: 'overflow', kind: 'wrong or slow', algorithm: 'Narrow sum', reason: 'Overflow', subtasks: [1], construction: 'Large legal sum' }] };
  const service = bareAiServices(); let job = makeJob(), calls = 0;
  job.state.planProposal = aiPlanProposal(candidate, validateAiQualityPlan(candidate, [{ id: 1 }]).issues, 1);
  service.checkpoint = async (job, step) => { job.step = step; };
  service.model = async () => { calls++; if (calls === 1) throw new AiError('RESPONSE_RECOVERY_INTERRUPTED');
    return { hash: job.state.planProposal.hash, replacements: [{ path: 'targets[0].kind', value: 'wrong' }] }; };
  const run = () => service.boundedQualityPlan(job, { llm: { type: 'chat' } }, { subtasks: [{ id: 1 }] }, { statements: [], samples: [], judgeInfo: {} }, '');
  await assert.rejects(run(), /RESPONSE_RECOVERY_INTERRUPTED/);
  assert.equal(job.state.planRepair.status, 'repairing');
  assert.equal(job.state.workflow.blocking.remaining, 0);
  assert.equal(job.state.workflow.blocking.status, 'repairing');
  job = JSON.parse(JSON.stringify(job));
  assert.equal((await run()).targets[0].kind, 'wrong');
  assert.equal(job.state.planRepair.spent, 1); assert.equal(job.state.planRepair.status, 'accepted');
  assert.equal(job.state.planRejections, 1);
});

test('regenerate cannot bypass allocation or scoring review and preserves the lifetime repair budget', () => {
  const service = bareAiServices(); const job = makeJob(); job.status = 'failed';
  job.state.plan = {}; job.state.planRepair = { spent: 1, limit: 1, status: 'exhausted' };
  workflowState(job.state).blocking = { kind: 'plan_schema' };
  for (const code of ['AI_SCORING_REVIEW_REQUIRED', 'AI_ALLOCATION_REVIEW_REQUIRED']) {
    job.error = code; job.state.scoringReview = {}; job.state.allocationReview = {};
    assert(!service.retryOptions(job).includes('regenerate'));
    assert.throws(() => service.retryState(job, 'regenerate'), /INVALID_RETRY_MODE/);
  }
  job.error = 'INVALID_AI_QUALITY_PLAN'; delete job.state.scoringReview; delete job.state.allocationReview;
  const state = service.retryState(job, 'regenerate');
  assert.equal(state.planRepair.spent, 1); assert.equal(state.planNewMethod, true);
});

test('persisted unsupported task contract is rejected before any replay artifact URL is signed', async () => {
  const service = Object.create(AiExecutionService.prototype); let signed = 0;
  service.connection = { getRepository: () => ({ findOneBy: async () => ({ operation: 'replay' }) }) };
  service.fileService = { readObject: async () => Buffer.from(JSON.stringify({ taskContract: { mode: 'persistent_duplex', lifetime: 'two_live_isolated_roles', scoring: { scope: 'case', reduction: 'binary' } } })), signDownloadLink: async () => { signed++; } };
  await assert.rejects(service.getTaskToBeSentToJudgeByTaskId('task', 0), /AI_CAPABILITY_UNSUPPORTED/);
  assert.equal(signed, 0);
});

for (const missing of ['aiCapabilities', 'aiQualityPolicyVersions', 'aiReceiptVersions']) {
  test(`local handshake without ${missing} receives no source`, async () => {
    const net = require('node:net'), path = require('node:path'), os = require('node:os');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p38c-cap-'));
    const old = process.env.HYHOJ_AI_RUNNER_SOCKET; process.env.HYHOJ_AI_RUNNER_SOCKET = path.join(root, 'runner.sock');
    let received = '';
    const server = net.createServer(socket => {
      socket.on('data', data => received += data);
      const caps = { type: 'capabilities', protocolVersion: 9, aiCapabilities: protocol.AI_RUNNER_CAPABILITIES, aiQualityPolicyVersions: [2], aiReceiptVersions: [1] };
      delete caps[missing]; socket.write(JSON.stringify(caps) + '\n');
    });
    await new Promise(resolve => server.listen(process.env.HYHOJ_AI_RUNNER_SOCKET, resolve));
    try {
      await assert.rejects(Object.create(AiExecutionService.prototype).runLocal(makeJob(), { jobId: makeJob().id, cases: [], stdCode: 'PRIVATE_SOURCE' }, async () => {}, async () => {}), /AI_CAPABILITY_UNSUPPORTED/);
      assert.equal(received, '');
    } finally {
      await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
      if (old === undefined) delete process.env.HYHOJ_AI_RUNNER_SOCKET; else process.env.HYHOJ_AI_RUNNER_SOCKET = old;
    }
  });
}

test('changed provider configuration cannot spend a second schema-repair generation', async () => {
  const { dispatch } = require('./ai-model-dispatch.ts');
  let sent = 0, claimed = 0;
  await assert.rejects(withAiRuntime({ ownerId: 1, record: async () => {}, loadResponse: async () => null,
    saveResponse: async () => { claimed++; } }, () => dispatch.run({ stageId: 'stage', generationId: 'new', requiredGenerationId: 'original' }, () =>
    recoverableResponse({ type: 'responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'rotated', model: 'fixture' }, {}, async () => { sent++; }))), /AI_PLAN_REPAIR_EXHAUSTED/);
  assert.equal(sent, 0); assert.equal(claimed, 0);
});

test('changed detail includes exactly the legacy job panels, with unchanged and unauthorized replies still gated', async () => {
  const job = makeJob();
  Object.assign(job, { problemId: 42, action: 'testdata', status: 'failed', progress: 73, error: 'AI_ALLOCATION_REVIEW_REQUIRED',
    createdAt: new Date('2026-11-07T10:00:00Z'), runToken: 'attempt' });
  Object.assign(job.state, {
    workflow: { version: 1, option: 'qualify_first', stages: [], corpus: [], candidates: [], compiled: {}, regressions: [], provenance: { status: 'verified' } },
    planRepair: { schemaVersion: 2, spent: 1, limit: 1, status: 'accepted', rejectedFields: 1, structuredOutput: 'prompt_fallback' },
    allocationReview: { mode: 'coverage', reason: 'PARTIAL_CREDIT_ALLOCATION', digest: 'a'.repeat(64), changes: [] },
    caseAllocation: { count: 25, capacity: [{ subtask: 1, requested: 2, allocated: 3 }] },
    qualityValidation: { samplesPassed: 2, fuzzPassed: 64, targets: [{ id: 'target', kills: 1 }] },
    repair: { automatic: 1, revisions: [{ round: 1, role: 'std', from: 'b'.repeat(64), to: 'c'.repeat(64), signature: 'PRIVATE_SIGNATURE', diff: { text: 'PRIVATE_DIFF', added: 1, removed: 1, truncated: false } }] },
    tutorialBindings: [{ discussionId: 8, locale: 'en_US', sha256: 'd'.repeat(64), at: '2026-11-07T10:01:00Z' }],
    tutorialChecks: { ['d'.repeat(64)]: { result: 'rejected', samples: 1, reason: 'Synthetic mismatch' } },
    runs: [{ at: '2026-11-07T10:02:00Z', operation: 'generate', seconds: 3, result: 'time_limit' }],
    stdCode: 'PRIVATE_SOURCE', sourceSearchTrace: { searches: [{ query: 'PRIVATE_QUERY' }] }
  });
  const failure = { id: 'failure', kind: 'time_limit', phase: 'generate', role: 'std', evidence: 'stored' };
  const reported = { generations: 1, requests: 3, polls: 2, failed: 0, inputTokens: 0, outputTokens: 0, unreported: 1 };
  let allowed = true, reads = 0, totalsReads = 0, authorizationChecks = 0;
  const coordinator = {
    policy: async () => ({ paused: false }),
    assertEvidenceAccess: async () => { authorizationChecks++; if (!allowed) throw new AiError('PERMISSION_DENIED'); }
  };
  const workflow = { retryOptions: () => ['repair'], repairRoles: () => ['std'] };
  const usage = { jobTotals: async (owner, ids) => { totalsReads++; assert.equal(owner, 1); assert.deepEqual(ids, [job.id]); return new Map([[job.id, reported]]); },
    generations: async () => [], generationCounts: async () => ({ logicalGenerations: 1, legacyGenerationRequests: 0 }),
    recentFailures: async () => [], stageTotals: async () => new Map() };
  const ai = Object.assign(Object.create(AiService.prototype), { workflow, usage, coordinator,
    jobs: { find: async query => { assert.deepEqual(query.where, { ownerId: 1 }); return [structuredClone(job)]; } },
    evidence: { summaries: async jobs => { reads++; assert.deepEqual(jobs.map(row => row.id), [job.id]); return new Map([[job.id, { count: 2, failure }]]); } }
  });
  const view = Object.assign(Object.create(AiJobViewService.prototype), { evidence: ai.evidence, coordinator, workflow, usage,
    problemRows: async () => new Map(),
    db: { getRepository: () => ({
      findOneBy: async where => where.ownerId === job.ownerId && where.id === job.id ? structuredClone(job) : null,
      find: async () => []
    }) }
  });
  const [legacy] = (await ai.listJobs({ id: 1 })).jobs;
  const detail = await view.detail({ id: 1 }, { id: job.id });
  assert.deepEqual(detail.job, legacy);
  assert.equal(detail.job.status, 'failed');
  assert.equal(detail.job.problemId, 42);
  assert.equal(detail.job.progress, 73);
  assert.deepEqual(detail.job.retryOptions, ['repair']);
  assert.deepEqual(detail.job.repairRoles, ['std']);
  assert.deepEqual(detail.job.result.workflow, job.state.workflow);
  assert.deepEqual(detail.job.result.planRepair, job.state.planRepair);
  assert.deepEqual(detail.job.result.allocationReview, job.state.allocationReview);
  assert.deepEqual(detail.job.result.testdataQuality, job.state.qualityValidation);
  assert.deepEqual(detail.job.result.caseCapacity, job.state.caseAllocation.capacity);
  assert.deepEqual(detail.job.result.failure, failure);
  assert.equal(detail.job.result.observationCount, 2);
  assert.equal(detail.job.result.tutorials[0].discussionId, 8);
  assert.deepEqual(detail.job.result.evidence.usage, reported);
  assert.deepEqual(detail.job.result.repair.revisions[0].diff, { added: 1, removed: 1, truncated: false });
  assert(!JSON.stringify(detail.job).includes('PRIVATE_'));
  assert.equal(totalsReads, 2, 'detail reuses its usage read when enriching legacy panels');
  assert.equal(reads, 2, 'both routes enrich through the same serializer path');
  assert(!Object.hasOwn(detail.summary, 'job'));
  assert(!Object.hasOwn(detail.summary, 'result'));
  const unchanged = await view.detail({ id: 1 }, { id: job.id, ifRevision: job.revision });
  assert.deepEqual(unchanged, { unchanged: true, id: job.id, revision: job.revision });
  assert.equal(reads, 2, 'unchanged replies do not load legacy panels');
  assert.equal(totalsReads, 2);
  assert.equal(authorizationChecks, 3);
  await assert.rejects(view.detail({ id: 2 }, { id: job.id }), /NO_SUCH_JOB/);
  await assert.rejects(serializeAiJobs({ id: 2 }, [job], { workflow, usage, evidence: ai.evidence }), /PERMISSION_DENIED/);
  allowed = false;
  await assert.rejects(view.detail({ id: 1 }, { id: job.id }), /PERMISSION_DENIED/);
  await assert.rejects(view.detail({ id: 1 }, { id: job.id, ifRevision: job.revision }), /PERMISSION_DENIED/);
  assert.equal(reads, 2);
  allowed = true;
  const enrich = ai.evidence.summaries;
  ai.evidence.summaries = async jobs => { const result = await enrich(jobs); allowed = false; return result; };
  await assert.rejects(view.detail({ id: 1 }, { id: job.id }), /PERMISSION_DENIED/);
});
