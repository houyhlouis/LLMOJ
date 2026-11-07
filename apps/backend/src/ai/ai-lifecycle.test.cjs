const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
const { recoverableResponse, providerBindingHash } = require("./ai-responses.ts");
const { withAiRuntime } = require("./ai-runtime.ts");
const { AiError } = require("./ai.types.ts");
const { AiUsageService } = require("./ai-usage.service.ts");
const provider = require("./ai-provider.ts");
const { AiJobCoordinator } = require("./ai-job-coordinator.service.ts");
const { projectJob, jobSummary, advanceStage } = require("./ai-job-view.ts");
const { allocateAiTestcases } = require("./ai-case-allocation.ts");
const { allocationReview } = require("./ai-allocation-review.ts");
const { boundedDiagnosticExport } = require("./ai-diagnostic-export.ts");
const config = { type: "responses", baseUrl: "https://api.openai.com/v1", apiKey: "fake-secret", model: "fixture" };
const context = () => {
  const saved = new Map();
  return {
    ownerId: 1,
    jobId: "fixture",
    saved,
    record: async () => {},
    purpose: () => "plan",
    loadResponse: async key => structuredClone(saved.get(key) || null),
    saveResponse: async (key, value) => saved.set(key, structuredClone(value))
  };
};

test("logical identity and purpose exist before dispatch and survive lease transfer without another POST", async () => {
  const ctx = context();
  let first;
  await assert.rejects(
    withAiRuntime(ctx, () =>
      recoverableResponse(
        config,
        { input: "synthetic" },
        async (suffix, body, operation, identity) => {
          if (!suffix) {
            first = identity;
            assert.equal(ctx.saved.values().next().value.generationId, identity.generationId);
            assert.equal(identity.purpose, "plan");
            assert.equal(identity.requestAttempt, 1);
            return { id: "resp_fixture", status: "queued" };
          }
          throw new AiError("JOB_LEASE_LOST");
        },
        { pollMs: 1 }
      )
    ),
    /JOB_LEASE_LOST/
  );
  ctx.purpose = () => "other";
  await withAiRuntime(ctx, () =>
    recoverableResponse(config, { input: "synthetic" }, async (suffix, body, operation, identity) => {
      assert.equal(suffix, "/resp_fixture");
      assert.equal(identity.generationId, first.generationId);
      assert.equal(identity.purpose, "plan");
      assert.equal(identity.requestAttempt, 3);
      return { id: "resp_fixture", status: "completed", output_text: "ok" };
    })
  );
  assert.equal(ctx.saved.values().next().value.lifecycle, "terminal");
});

test("lost acknowledgement persists uncertain paid intent and cannot automatically dispatch again", async () => {
  const ctx = context();
  let calls = 0;
  const request = async () => {
    calls++;
    throw new AiError("PROVIDER_NETWORK_ERROR");
  };
  await assert.rejects(
    withAiRuntime(ctx, () => recoverableResponse(config, {}, request)),
    /PROVIDER_NETWORK_ERROR/
  );
  await assert.rejects(
    withAiRuntime(ctx, () => recoverableResponse(config, {}, request)),
    /PROVIDER_ACKNOWLEDGEMENT_UNKNOWN/
  );
  assert.equal(calls, 1);
  assert.equal(ctx.saved.values().next().value.lifecycle, "dispatching");
});

test("legacy handle recovery remains unlinked rather than inventing historical generation identity", async () => {
  const ctx = context();
  ctx.loadResponse = async () => ({ responseId: "resp_old", createdAt: Date.now() });
  await withAiRuntime(ctx, () =>
    recoverableResponse(config, {}, async (_, __, ___, identity) => {
      assert.equal(identity.generationId, undefined);
      return { id: "resp_old", status: "completed" };
    })
  );
});

function usageFixture(saved = []) {
  const rows = [];
  const repository = {
    insert: async row => rows.push(structuredClone(row)),
    find: async ({ where }) => rows.filter(row => Object.entries(where).every(([k, v]) => row[k] === v))
  };
  const checkpoints = {
    find: async () => saved,
    update: async (where, changes) => {
      const row = saved.find(r => r.requestHash === where.requestHash);
      Object.assign(row, changes);
    }
  };
  const { AiResponseCheckpointEntity } = require("./ai-usage.entity.ts");
  const manager = {
    findOne: async (entity, options) =>
      entity === AiResponseCheckpointEntity ? saved.find(row => row.requestHash === options.where.requestHash) : {},
    getRepository: entity => (entity === AiResponseCheckpointEntity ? checkpoints : repository),
    increment: async () => {}
  };
  const db = { transaction: work => work(manager), getRepository: () => ({ increment: async () => {} }) };
  return { rows, service: new AiUsageService(db, repository, checkpoints) };
}

test("usage reconciliation fills partial reports and counts a repeated terminal retrieval only once", async () => {
  const { rows, service } = usageFixture();
  const base = {
    target: "llm",
    provider: "responses",
    host: "api.openai.com",
    operation: "responses.poll",
    generationId: "logical",
    purpose: "plan",
    success: true,
    errorCode: null,
    elapsedMs: 1,
    responseId: "resp_fixture",
    usageReported: true,
    inputTokens: 10,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    searchCredits: null
  };
  await service.context(1, "job").record(base);
  await service.context(1, "job").record({ ...base, inputTokens: 10, outputTokens: 20 });
  await service.context(1, "job").record({ ...base, inputTokens: 10, outputTokens: 20 });
  assert.equal(
    rows.reduce((n, r) => n + (r.inputTokens || 0), 0),
    10
  );
  assert.equal(
    rows.reduce((n, r) => n + (r.outputTokens || 0), 0),
    20
  );
  assert.equal(rows[0].outputTokens, null, "unreported usage remains unknown");
});

test("provider cancellation persists requested before dispatch and independently confirms outcome", async () => {
  const saved = [
    {
      requestHash: "hash",
      generationId: "logical",
      purpose: "plan",
      requestAttempts: 2,
      responseId: "resp_fixture",
      lifecycle: "pending",
      cancellation: "not_requested",
      bindingHash: providerBindingHash(config)
    }
  ];
  const { service } = usageFixture(saved);
  const original = provider.cancelProviderResponse;
  provider.cancelProviderResponse = async (_, id, metadata) => {
    assert.equal(saved[0].cancellation, "requested");
    assert.equal(id, "resp_fixture");
    assert.equal(metadata.generationId, "logical");
    return { id, status: "cancelled" };
  };
  try {
    await service.cancelResponses(1, "job", config);
  } finally {
    provider.cancelProviderResponse = original;
  }
  assert.equal(saved[0].cancellation, "confirmed");
});

test("credential rotation cannot cancel a response under a different provider account", async () => {
  const saved = [
    {
      requestHash: "hash",
      responseId: "resp_fixture",
      lifecycle: "pending",
      cancellation: "not_requested",
      bindingHash: "old"
    }
  ];
  const { service } = usageFixture(saved);
  await service.cancelResponses(1, "job", config);
  assert.equal(saved[0].cancellation, "failed");
  assert.equal(saved[0].cancellationError, "PROVIDER_CREDENTIALS_CHANGED");
});

test("coverage allocation is bounded independently of decimal score denominators and reserves target cases", () => {
  const tasks = [
    { id: 1, points: 0.000001 },
    { id: 2, points: 99.999999 }
  ];
  const allocation = allocateAiTestcases(
    tasks,
    20,
    [
      { id: "a", subtasks: [1] },
      { id: "b", subtasks: [1] }
    ],
    "coverage"
  );
  assert.equal(allocation.count, 20);
  assert(allocation.allocations[0].count >= 4);
  assert.equal(allocation.allocations[0].points, 0.000001);
  assert.throws(() => allocateAiTestcases(tasks, 20), /RATIO_UNREPRESENTABLE/);
});

test("coverage partial-credit review binds exact old and proposed cases; GroupMin scoring needs no review", () => {
  const allocation = allocateAiTestcases([{ id: 1, points: 100 }], 20, [], "coverage");
  const previous = { subtasks: [{ scoringType: "Sum", points: 100, testcases: [{}, {}] }] };
  const review = allocationReview(previous, allocation);
  assert.equal(review.reason, "PARTIAL_CREDIT_ALLOCATION");
  assert.notEqual(
    review.digest,
    allocationReview({ subtasks: [{ ...previous.subtasks[0], testcases: [{}] }] }, allocation).digest
  );
  assert.equal(
    allocationReview({ subtasks: [{ ...previous.subtasks[0], scoringType: "GroupMin" }] }, allocation),
    null
  );
});

test("compact progress never writes source state and timeline preserves failed and retried attempts", async () => {
  const job = {
    id: "job",
    status: "running",
    runToken: "token",
    attempt: 1,
    step: "testdata.generate",
    progress: 20,
    input: { count: 20 },
    state: { stdCode: "SECRET_SOURCE", caseAllocation: { count: 20 } },
    updatedAt: new Date(),
    revision: 3
  };
  const service = Object.create(AiJobCoordinator.prototype);
  let update;
  service.assertJob = async () => {};
  service.jobs = {
    update: async (_, value) => {
      update = value;
      return { affected: 1 };
    }
  };
  await service.progress(job, "testdata.generate", 30);
  assert(!("state" in update));
  assert(!JSON.stringify(update).includes("SECRET_SOURCE"));
  advanceStage(job, job.step, "failed");
  job.attempt = 2;
  advanceStage(job, "testdata.generate");
  assert.equal(job.timeline.entries.length, 2);
  assert.equal(job.timeline.entries[0].outcome, "failed");
  assert.equal(job.timeline.entries[1].attempt, 2);
  job.projection = projectJob(job);
  assert(!JSON.stringify(jobSummary(job, null)).includes("SECRET_SOURCE"));
});

test("diagnostic export is bounded and redacts credentials, private bytes and source bodies", () => {
  const exported = boundedDiagnosticExport(
    {
      corpus: { input: "HIDDEN_FIXTURE_BYTES", sha256: "a".repeat(64) },
      diagnostics: { message: "Bearer secretvalue apiKey=keyvalue", reasoning: "private", code: "int main(){}" },
      missing: undefined,
      huge: "x".repeat(5000)
    },
    1800
  );
  const text = JSON.stringify(exported);
  for (const secret of ["secretvalue", "keyvalue", "HIDDEN_FIXTURE_BYTES", "int main", '"private"'])
    assert(!text.includes(secret));
  assert(text.includes("truncated"));
  assert(text.includes("missing"));
  assert(text.length < 2000);
});

test(
  "more than fifty history jobs cannot hide active work; cursors and revisions cannot bypass authorization",
  {
    skip: !process.env.HYHOJ_AI_TEST_DB_CONFIG
  },
  async () => {
    const crypto = require("node:crypto");
    const { DataSource } = require("typeorm");
    const { AiJobEntity } = require("./ai.entity.ts");
    const { AiObservationEntity } = require("./ai-observation.entity.ts");
    const { AiJobViewService } = require("./ai-job-view.service.ts");
    const config = require("js-yaml").load(fs.readFileSync(process.env.HYHOJ_AI_TEST_DB_CONFIG, "utf8")).services
      .database;
    const db = new DataSource({
      ...config,
      entities: [AiJobEntity, AiObservationEntity],
      entityPrefix: `p38b_${crypto.randomBytes(8).toString("hex")}_`,
      synchronize: true
    });
    await db.initialize();
    const jobs = db.getRepository(AiJobEntity);
    let allowed = true;
    let paused = false;
    const coordinator = {
      policy: async () => ({ paused }),
      assertEvidenceAccess: async () => {
        if (!allowed) throw new AiError("PERMISSION_DENIED");
      }
    };
    const usage = {
      jobTotals: async (_, ids) =>
        new Map([
          [
            ids[0],
            {
              generations: 1,
              requests: 1,
              searches: 0,
              failed: 1,
              inputTokens: 0,
              outputTokens: 0,
              cachedTokens: null,
              reasoningTokens: null,
              unreported: 1,
              legacyUnlinkedRequests: 1,
              inputTokensReported: false,
              outputTokensReported: false,
              polls: 0
            }
          ]
        ]),
      generations: async () => [],
      generationCounts: async () => ({ logicalGenerations: 0, legacyGenerationRequests: 1 }),
      stageTotals: async () => new Map(),
      recentFailures: async () => [
        {
          id: "request",
          purpose: null,
          stageId: null,
          generationId: null,
          operation: "generate",
          errorCode: "PROVIDER_HTTP_ERROR",
          diagnostics: { httpStatus: 400, requestShapeVersion: 1 },
          createdAt: new Date()
        }
      ]
    };
    const service = new AiJobViewService(
      db,
      coordinator,
      { retryOptions: () => [], repairRoles: () => [] },
      usage,
      {},
      {},
      {},
      undefined
    );
    try {
      const base = {
        ownerId: 1,
        action: "testdata",
        progress: 1,
        step: "queued",
        input: { count: 20 },
        state: { stdCode: "private" }
      };
      const active = await jobs.save({
        ...base,
        id: crypto.randomUUID(),
        status: "running",
        createdAt: new Date("2020-01-01")
      });
      await jobs.save(
        Array.from({ length: 61 }, (_, i) => ({
          ...base,
          id: crypto.randomUUID(),
          status: "completed",
          createdAt: new Date(1700000000000 + i * 1000)
        }))
      );
      await db.query(
        `UPDATE \`${db.getMetadata(AiJobEntity).tableName}\` SET createdAt='2026-11-07 07:00:00.123456' WHERE status='completed'`
      );
      const page = await service.summaries({ id: 1 }, { section: "active" });
      assert.deepEqual(
        page.jobs.map(j => j.id),
        [active.id]
      );
      assert(!JSON.stringify(page).includes("private"));
      assert(!Object.hasOwn(page, "job"));
      assert(page.jobs.every(row => !Object.hasOwn(row, "job") && !Object.hasOwn(row, "result")));
      assert.equal(
        (await service.summaries({ id: 1 }, { section: "active", ifVersion: page.version })).unchanged,
        true
      );
      paused = true;
      const pausedPage = await service.summaries({ id: 1 }, { section: "active", ifVersion: page.version });
      assert.equal(pausedPage.unchanged, false);
      assert.equal(pausedPage.paused, true);
      const first = await service.summaries({ id: 1 }, { section: "history", limit: 50 });
      assert.equal(first.jobs.length, 50);
      const next = await service.summaries(
        { id: 1 },
        { section: "history", cursor: first.nextCursor, ifVersion: first.version }
      );
      assert.equal(next.jobs.length, 11);
      assert.equal(new Set([...first.jobs, ...next.jobs].map(j => j.id)).size, 61);
      const attentive = await jobs.save({
        ...base,
        id: crypto.randomUUID(),
        status: "completed",
        projection: {
          version: 1,
          requested: 20,
          planned: null,
          generated: null,
          qualified: null,
          activated: null,
          rejectedPlans: 0,
          provenance: "unverified",
          attention: { code: "source_unverified", message: "Review provenance", retryable: false }
        }
      });
      const attentionPage = await service.summaries({ id: 1 }, { section: "attention" });
      assert.deepEqual(
        attentionPage.jobs.map(row => row.id),
        [attentive.id]
      );
      assert.equal(attentionPage.jobs[0].attention.code, "source_unverified");
      assert.equal((await service.summaries({ id: 1 }, { section: "history" })).total, 61);
      const unchanged = await service.detail({ id: 1 }, { id: active.id, ifRevision: active.revision });
      assert.equal(unchanged.unchanged, true);
      await jobs.update({ id: active.id }, { progress: 2, status: "failed", error: "PROVIDER_HTTP_ERROR: 400" });
      const updated = await jobs.findOneBy({ id: active.id });
      assert(updated.revision > active.revision);
      const details = await service.detail({ id: 1 }, { id: active.id });
      assert.equal(details.blockingReason.code, "provider_request_failed");
      assert.equal(details.errorCode, "PROVIDER_HTTP_ERROR");
      assert.equal(details.requestFailures[0].diagnostics.httpStatus, 400);
      assert.equal(details.usage.reported.inputTokens, null, "unreported usage cannot become an assumed zero");
      assert.equal(details.counters.logicalGenerations, 0);
      assert.equal(details.counters.legacyGenerationRequests, 1);
      allowed = false;
      await assert.rejects(
        service.detail({ id: 1 }, { id: active.id, ifRevision: updated.revision }),
        /PERMISSION_DENIED/
      );
    } finally {
      for (const entity of [AiObservationEntity, AiJobEntity])
        await db.query(`DROP TABLE \`${db.getMetadata(entity).tableName}\``);
      await db.destroy();
    }
  }
);

test("same-size generated file corruption is rejected after sealing and before registration", async () => {
  const { FileService } = require("../file/file.service.ts");
  const files = Object.create(FileService.prototype);
  let registered = false;
  const discarded = [];
  files.isUploadRegistered = async () => false;
  files.findUpload = async () => ({ size: 4, name: "staging/fixture", etag: "e" });
  files.sealObjects = async () => ({ uuid: "sealed", size: 4, sha256: "b".repeat(64) });
  files.registerSealedUpload = async () => {
    registered = true;
  };
  files.discardSealedUpload = async item => discarded.push(item.uuid);
  await assert.rejects(
    files.processUploadRequest({ uuid: "staging", size: 4 }, () => null, {}, true, "a".repeat(64)),
    /FILE_HASH_MISMATCH/
  );
  assert.equal(registered, false);
  assert.deepEqual(discarded, ["sealed"]);
});

test(
  "concurrent dispatchers atomically claim one generation before a provider request (real MariaDB)",
  {
    skip: !process.env.HYHOJ_AI_TEST_DB_CONFIG
  },
  async () => {
    const crypto = require("node:crypto");
    const { DataSource } = require("typeorm");
    const { AiJobEntity } = require("./ai.entity.ts");
    const { AiResponseCheckpointEntity } = require("./ai-usage.entity.ts");
    const dbConfig = require("js-yaml").load(fs.readFileSync(process.env.HYHOJ_AI_TEST_DB_CONFIG, "utf8")).services
      .database;
    const db = new DataSource({
      ...dbConfig,
      entities: [AiJobEntity, AiResponseCheckpointEntity],
      entityPrefix: `p38b_claim_${crypto.randomBytes(6).toString("hex")}_`,
      synchronize: true
    });
    await db.initialize();
    const jobId = crypto.randomUUID(),
      runToken = crypto.randomUUID(),
      stageId = crypto.randomUUID();
    try {
      await db.getRepository(AiJobEntity).save({
        id: jobId,
        ownerId: 1,
        action: "testdata",
        status: "running",
        runToken,
        step: "testdata.plan",
        input: { count: 20 },
        state: {}
      });
      const service = new AiUsageService(db, {}, db.getRepository(AiResponseCheckpointEntity));
      const runtime = {
        ...service.context(1, jobId, undefined, runToken),
        purpose: () => "plan",
        stageId: () => stageId
      };
      let requests = 0,
        release;
      const waiting = new Promise(resolve => {
        release = resolve;
      });
      let sent;
      const ready = new Promise(resolve => {
        sent = resolve;
      });
      const first = withAiRuntime(runtime, () =>
        recoverableResponse(config, {}, async (_, __, ___, identity) => {
          requests++;
          assert.equal(identity.stageId, stageId);
          sent();
          await waiting;
          return { id: "resp_atomic", status: "completed" };
        })
      );
      await ready;
      await assert.rejects(
        withAiRuntime(runtime, () =>
          recoverableResponse(config, {}, async () => {
            requests++;
          })
        ),
        /PROVIDER_ACKNOWLEDGEMENT_UNKNOWN/
      );
      release();
      await first;
      assert.equal(requests, 1);
      const rows = await service.generations(1, jobId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].stageId, stageId);
      assert.equal(rows[0].purpose, "plan");
      assert.equal(rows[0].lifecycle, "terminal");
      await db.getRepository(AiJobEntity).update({ id: jobId }, { runToken: crypto.randomUUID() });
      await assert.rejects(
        runtime.saveResponse(rows[0].requestHash, { responseId: "resp_wrong", createdAt: Date.now() }),
        /JOB_LEASE_LOST/
      );
    } finally {
      for (const entity of [AiResponseCheckpointEntity, AiJobEntity])
        await db.query(`DROP TABLE \`${db.getMetadata(entity).tableName}\``);
      await db.destroy();
    }
  }
);

test("an incompatible local worker receives no source-bearing payload", async () => {
  const net = require("node:net"),
    path = require("node:path"),
    os = require("node:os");
  const { AiExecutionService } = require("./ai-execution.service.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p38b-capability-"));
  const previous = process.env.HYHOJ_AI_RUNNER_SOCKET;
  const socketPath = path.join(root, "runner.sock");
  process.env.HYHOJ_AI_RUNNER_SOCKET = socketPath;
  let received = "";
  const server = net.createServer(socket => {
    socket.on("data", data => {
      received += data;
    });
    socket.write(
      JSON.stringify({
        type: "capabilities",
        protocolVersion: 8,
        aiQualityPolicyVersions: [2],
        aiReceiptVersions: [1]
      }) + "\n"
    );
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const service = Object.create(AiExecutionService.prototype);
  try {
    await assert.rejects(
      service.runLocal(
        { id: "fixture" },
        { jobId: "fixture", cases: [], stdCode: "PRIVATE_SOURCE" },
        async () => {},
        async () => {}
      ),
      /AI_CAPABILITY_UNSUPPORTED/
    );
    assert.equal(received, "");
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.HYHOJ_AI_RUNNER_SOCKET;
    else process.env.HYHOJ_AI_RUNNER_SOCKET = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("usage for identical response handles in different provider accounts is never collapsed", async () => {
  const { rows, service } = usageFixture();
  const base = {
    target: "llm",
    provider: "responses",
    host: "api.example.test",
    operation: "responses.poll",
    purpose: "plan",
    success: true,
    errorCode: null,
    elapsedMs: 1,
    responseId: "resp_account_local",
    usageReported: true,
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: null,
    reasoningTokens: null,
    searchCredits: null
  };
  await service.context(1, "job").record({ ...base, generationId: "one", accountBinding: "a".repeat(64) });
  await service.context(1, "job").record({ ...base, generationId: "two", accountBinding: "b".repeat(64) });
  assert.equal(
    rows.reduce((n, r) => n + r.inputTokens, 0),
    20
  );
  assert.notEqual(rows[0].responseHash, rows[1].responseHash);
  assert(!rows.some(r => "accountBinding" in r));
});

test("GroupMul cardinality and released automatic scoring require review; activation pins discovered files", async () => {
  const { automaticAllocationSnapshot } = require("./ai-allocation-review.ts");
  const { AiArtifactPublisher } = require("./ai-artifact-publisher.service.ts");
  const allocation = allocateAiTestcases([{ id: 1, points: 100 }], 20, [], "coverage");
  const product = allocationReview({ subtasks: [{ scoringType: "GroupMul", testcases: [{}, {}] }] }, allocation);
  assert.equal(product.changes[0].scoringType, "GroupMul");
  assert.equal(product.changes[0].proposedPointsPerCase, null);
  const files = [
    { filename: "1.in", uuid: "input" },
    { filename: "1.out", uuid: "output" }
  ];
  const snapshot = automaticAllocationSnapshot({ subtasks: null }, files, false);
  assert.equal(allocationReview(snapshot.judgeInfo, allocation).changes[0].previousCount, 1);
  const staged = [...files, { filename: "ai-managed-11111111-1111-4111-8111-111111111111-1.in", uuid: "staged" }];
  assert.equal(automaticAllocationSnapshot({ subtasks: null }, staged, false).digest, snapshot.digest);
  const publisher = Object.create(AiArtifactPublisher.prototype);
  publisher.authorizeProblemCommit = async () => {};
  publisher.problemFiles = { getProblemFiles: async () => staged };
  const job = { input: { allocationMode: "coverage" }, state: { allocationBaseline: snapshot.digest } };
  await publisher.authorizeTestdataCommit(job, { judgeInfo: { subtasks: null } }, {}, { type: "Traditional" });
  publisher.problemFiles.getProblemFiles = async () => [{ ...files[0], uuid: "replaced" }, files[1]];
  await assert.rejects(
    publisher.authorizeTestdataCommit(job, { judgeInfo: { subtasks: null } }, {}, { type: "Traditional" }),
    /PROBLEM_CHANGED_DURING_AI/
  );
});

test("a known pre-transport admission pause resumes the same generation intent", async () => {
  const ctx = context();
  let identity;
  await assert.rejects(
    withAiRuntime(ctx, () =>
      recoverableResponse(config, {}, async (_, __, ___, value) => {
        identity = value.generationId;
        throw new AiError("AI_PAUSED");
      })
    ),
    /AI_PAUSED/
  );
  assert.equal(ctx.saved.values().next().value.lifecycle, "prepared");
  await withAiRuntime(ctx, () =>
    recoverableResponse(config, {}, async (_, __, ___, value) => {
      assert.equal(value.generationId, identity);
      return { id: "resp_resumed", status: "completed" };
    })
  );
  assert.equal(ctx.saved.size, 1);
});

test("diagnostic export preserves typed reasons but excludes extra proposal source/secret fields", () => {
  const { diagnosticPlanCandidate } = require("./ai-diagnostic-export.ts");
  const candidate = diagnosticPlanCandidate({
    version: 1,
    oracleMethod: "small exhaustive method",
    stdCode: "PRIVATE_SOURCE_BODY",
    targets: [{ id: "x", kind: "wrong", apiKey: "PRIVATE_CREDENTIAL", construction: "boundary case" }]
  });
  const output = boundedDiagnosticExport({
    detail: {
      blockingReason: { code: "plan_repair", message: "repair fields" },
      stdCode: "PRIVATE_SOURCE_BODY",
      sampleInput: "HIDDEN_INPUT_BYTES"
    },
    candidate
  });
  const text = JSON.stringify(output);
  assert(text.includes("plan_repair"));
  assert(!text.includes("PRIVATE_SOURCE_BODY"));
  assert(!text.includes("PRIVATE_CREDENTIAL"));
  assert(!text.includes("HIDDEN_INPUT_BYTES"));
  assert.equal(candidate.omittedFields, 1);
});

test("legacy cancellation cannot assert credentials changed when account binding was never retained", async () => {
  const saved = [
    { requestHash: "legacy", responseId: "resp_legacy", lifecycle: "legacy", cancellation: "not_requested" }
  ];
  const { service } = usageFixture(saved);
  await service.cancelResponses(1, "job", config);
  assert.equal(saved[0].cancellation, "unsupported");
  assert.equal(saved[0].cancellationError, "PROVIDER_BINDING_UNAVAILABLE");
});

test("new generation attribution is captured before asynchronous checkpoint lookup", async () => {
  const ctx = context();
  let purpose = "plan",
    stage = "original-stage";
  ctx.purpose = () => purpose;
  ctx.stageId = () => stage;
  ctx.loadResponse = async () => {
    purpose = "other";
    stage = "later-stage";
    return null;
  };
  await withAiRuntime(ctx, () =>
    recoverableResponse(config, {}, async (_, __, ___, identity) => {
      assert.equal(identity.purpose, "plan");
      assert.equal(identity.stageId, "original-stage");
      return { id: "resp_attribution", status: "completed" };
    })
  );
});

test("persisted future-policy tasks are rejected at dispatch before source or artifact URLs are handed out", async () => {
  const { AiExecutionService } = require("./ai-execution.service.ts");
  for (const requirements of [
    { requiredQualityPolicy: 999 },
    { requiredReceiptVersion: 999 },
    { requiredQualityPolicy: null }
  ]) {
    const service = Object.create(AiExecutionService.prototype);
    let reads = 0;
    service.connection = {
      getRepository: () => ({
        findOneBy: async () => ({ operation: "replay" }),
        update: async () => assert.fail("An incompatible task must not enter running state")
      })
    };
    service.fileService = {
      readObject: async () => {
        assert.equal(++reads, 1, "No replay artifact metadata is read before policy admission");
        return Buffer.from(JSON.stringify(requirements));
      },
      signDownloadLink: async () => assert.fail("No private artifact URL may be minted for an incompatible task")
    };
    await assert.rejects(service.getTaskToBeSentToJudgeByTaskId("future-task", 4), /AI_CAPABILITY_UNSUPPORTED/);
  }
});

test(
  "a late failed duplicate cancellation cannot erase provider confirmation (real MariaDB)",
  {
    skip: !process.env.HYHOJ_AI_TEST_DB_CONFIG,
    timeout: 15000
  },
  async () => {
    const crypto = require("node:crypto");
    const { DataSource } = require("typeorm");
    const { AiJobEntity } = require("./ai.entity.ts");
    const { AiResponseCheckpointEntity } = require("./ai-usage.entity.ts");
    const dbConfig = require("js-yaml").load(fs.readFileSync(process.env.HYHOJ_AI_TEST_DB_CONFIG, "utf8")).services
      .database;
    const db = new DataSource({
      ...dbConfig,
      entities: [AiJobEntity, AiResponseCheckpointEntity],
      entityPrefix: `p38b_cancel_${crypto.randomBytes(6).toString("hex")}_`,
      synchronize: true
    });
    await db.initialize();
    const jobId = crypto.randomUUID(),
      repository = db.getRepository(AiResponseCheckpointEntity);
    const original = provider.cancelProviderResponse;
    try {
      await db
        .getRepository(AiJobEntity)
        .save({ id: jobId, ownerId: 1, status: "cancelled", action: "testdata", input: { count: 20 }, state: {} });
      await repository.save({
        ownerId: 1,
        jobId,
        requestHash: "a".repeat(64),
        responseId: "resp_cancel_race",
        generationId: crypto.randomUUID(),
        lifecycle: "pending",
        bindingHash: providerBindingHash(config),
        purpose: "plan"
      });
      let calls = 0,
        firstStarted,
        secondStarted,
        firstDone;
      const firstEntered = new Promise(resolve => {
        firstStarted = resolve;
      });
      const entered = new Promise(resolve => {
        secondStarted = resolve;
      });
      const confirmed = new Promise(resolve => {
        firstDone = resolve;
      });
      provider.cancelProviderResponse = async () => {
        if (++calls === 1) {
          firstStarted();
          await entered;
          return { id: "resp_cancel_race", status: "cancelled" };
        }
        secondStarted();
        await confirmed;
        throw new AiError("PROVIDER_NETWORK_ERROR");
      };
      const service = new AiUsageService(db, {}, repository);
      const first = service.cancelResponses(1, jobId, config);
      // Database scheduling may reverse arrival at the provider. Establish which call confirms first
      // before starting its duplicate, so the late-failure barrier cannot wait on itself.
      await firstEntered;
      const second = service.cancelResponses(1, jobId, config);
      first.then(firstDone, firstDone);
      await Promise.all([first, second]);
      const row = await repository.findOneBy({ ownerId: 1, jobId });
      assert.equal(calls, 2);
      assert.equal(row.cancellation, "confirmed");
      assert.equal(row.lifecycle, "terminal");
      assert.equal(row.requestAttempts, 2);
      await service.markCancellationFailure(1, jobId, "CONFIGURATION_UNAVAILABLE");
      assert.equal((await repository.findOneBy({ ownerId: 1, jobId })).cancellation, "confirmed");
    } finally {
      provider.cancelProviderResponse = original;
      for (const entity of [AiResponseCheckpointEntity, AiJobEntity])
        await db.query(`DROP TABLE \`${db.getMetadata(entity).tableName}\``);
      await db.destroy();
    }
  }
);

test("queue spans and legacy timeline gaps remain explicit across claims and retries", () => {
  const { queueStage, stageKind } = require("./ai-job-view.ts");
  const queued = queueStage({ attempt: 0, timeline: { entries: [], omitted: 0, legacyHistoryUnavailable: false } });
  assert.equal(queued.timeline.entries[0].attempt, 1);
  assert.equal(queued.timeline.entries[0].stage, "queued");
  assert(queued.stageStartedAt instanceof Date);
  assert.equal(queued.timeline.legacyHistoryUnavailable, false);
  const resumed = { attempt: 4, timeline: null, stageStartedAt: null, stageEndedAt: null };
  advanceStage(resumed, "testdata.generate");
  assert.equal(resumed.timeline.legacyHistoryUnavailable, true);
  assert.equal(queueStage(resumed).timeline.legacyHistoryUnavailable, true);
  assert.equal(stageKind("testdata.queued"), "queued");
});

test("summary titles require current problem-view permission and missing problems retain only their known ID", async () => {
  const { AiJobViewService } = require("./ai-job-view.service.ts");
  const service = Object.create(AiJobViewService.prototype);
  service.db = { getRepository: () => ({ find: async () => [{ id: 1, displayId: 1001, locales: ["en_US"] }] }) };
  service.access = { userHasPermission: async () => false };
  service.problems = { getProblemLocalizedTitles: async () => assert.fail("No unreadable title is fetched") };
  const problem = (await service.problemRows([{ problemId: 1 }], { id: 2 })).get(1);
  assert.deepEqual(problem, { id: 1, displayId: null, title: null });
  assert.deepEqual(
    jobSummary({ id: "job", problemId: 1, status: "queued", step: "queued", updatedAt: new Date() }, null).problem,
    { id: 1, displayId: null, title: null }
  );
});

test("known completed synchronous work is distinguished from a lost acknowledgement", async () => {
  const ctx = context();
  await withAiRuntime(ctx, () =>
    recoverableResponse(config, {}, async () => ({ choices: [{ message: { content: "ok" } }] }), { background: false })
  );
  await assert.rejects(
    withAiRuntime(ctx, () =>
      recoverableResponse(config, {}, async () => assert.fail("No automatic paid resend"), { background: false })
    ),
    /PROVIDER_RESULT_UNRECOVERABLE/
  );
});

test("turning background creation off does not discard an existing paid response handle", async () => {
  const ctx = context();
  ctx.loadResponse = async () => ({
    responseId: "resp_existing",
    createdAt: Date.now(),
    generationId: "existing",
    purpose: "plan"
  });
  const result = await withAiRuntime(ctx, () =>
    recoverableResponse(
      config,
      {},
      async suffix => {
        assert.equal(suffix, "/resp_existing");
        return { id: "resp_existing", status: "completed", output_text: "recovered" };
      },
      { background: false }
    )
  );
  assert.equal(result.output_text, "recovered");
});

test("generated public headers verify stored bytes against qualified hashes before any registration", async () => {
  const path = require("node:path"),
    os = require("node:os"),
    crypto = require("node:crypto");
  const { ProblemFileService } = require("../problem/problem-file.service.ts");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p38b-header-"));
  const filename = path.join(directory, "api.h"),
    bytes = Buffer.from("void Send(int value);\n");
  fs.writeFileSync(filename, bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const service = Object.create(ProblemFileService.prototype);
  const discarded = [];
  service.fileService = {
    uploadFile: async (_, stream) => {
      for await (const chunk of stream) {
        assert(chunk.length);
      }
      return sha256;
    },
    hashStoredObject: async () => ({ sha256: "f".repeat(64), size: bytes.length }),
    deleteUnfinishedUploadedFile: uuid => discarded.push(uuid)
  };
  service.lockManageProblemFile = async () =>
    assert.fail("Corrupt stored headers must never reach the registration transaction");
  try {
    await assert.rejects(
      service.addProblemFilesFromDisk(
        { id: 1 },
        "AdditionalFile",
        [{ filename: "api.h", path: filename, size: bytes.length, expectedSha256: sha256 }],
        { authorize: async () => {} }
      ),
      /FILE_HASH_MISMATCH/
    );
    assert.equal(discarded.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
