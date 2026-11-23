const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { plainToInstance } = require("class-transformer");
const { validateSync } = require("class-validator");
const { SwaggerModule, DocumentBuilder } = require("@nestjs/swagger");
const { NestFactory } = require("@nestjs/core");
const { RegistrationSettingsService, UserEntity } = require("../auth/registration-test-helpers.cjs");
const { ForbiddenException, Logger, Module } = require("@nestjs/common");
const { AuditService } = require("../audit/audit.service.ts");
const { AiPolicyService } = require("../settings/ai-policy.service.ts");
const { HealthService } = require("../health/health.service.ts");
const { SiteManagementController } = require("./site-management.controller.ts");
const { DiagnosticBundleService } = require("./diagnostic-bundle.service.ts");
const { DiagnosticBundleRequestDto, DiagnosticBundleResponseDto, BUNDLE_BYTE_LIMIT } = require("./diagnostic-bundle.dto.ts");
const { ErrorFilter } = require("../error.filter.ts");
const { UnexpectedErrors } = require("../event-report/unexpected-errors.ts");
const { permissionCatalog } = require("../access/permission-catalog.ts");
const { submissionDisplayProgress } = require("../submission/submission-display-progress.ts");

Logger.overrideLogger(false);
const originalMode = process.env.LLMOJ_AI_EXECUTION;
test.before(() => { process.env.LLMOJ_AI_EXECUTION = "judges"; });
test.after(() => {
  if (originalMode === undefined) delete process.env.LLMOJ_AI_EXECUTION;
  else process.env.LLMOJ_AI_EXECUTION = originalMode;
});
const admin = { id: 3, isAdmin: true };
const NOW = "2026-05-10T12:00:00.000Z";
const jobId = randomUUID(), requestId = randomUUID();

function setup({ size = 1, rowsPerSubmission = 1, administrator = true, redisFails = false } = {}) {
  const canary = key => `PRIVATE_FIXTURE_${key}`;
  const config = { config: {
    server: { clusters: 2, hostname: canary("SERVER_HOST") },
    metrics: { hostname: canary("METRICS_HOST") },
    services: {
      database: { username: canary("DB_USER"), password: canary("DB_PASSWORD") }, redis: canary("REDIS_URI"),
      minio: { accessKey: canary("MINIO_KEY"), secretKey: canary("MINIO_SECRET") }, mail: { transport: { auth: { pass: canary("MAIL_PASSWORD") } } }
    },
    security: {
      sessionSecret: canary("SESSION_SECRET"), maintainceKey: canary("MAINTENANCE"),
      captcha: { turnstile: { secretKey: canary("CAPTCHA_KEY"), siteKey: canary("CAPTCHA_SITE") } },
      crossOrigin: { enabled: true, whiteList: [canary("ORIGIN")] }, rateLimit: { maxRequests: 9, durationSeconds: 60 },
      proofOfWork: { difficulty: 2, expensiveActionDifficulty: 4 }
    },
    preference: { security: { registrationMode: "open", requireEmailVerification: true } },
    resourceLimit: { problemTestcases: 1000, problemTimeLimit: 8000, problemMemoryLimit: 200000, submissionFileSize: 20000 },
    queryLimit: { submissions: 10, problemSet: 50 }, eventReport: { telegramBotToken: canary("TELEGRAM") }
  } };
  const log = [], queries = [];
  const job = {
    id: jobId, ownerId: 991, problemId: 8, revision: 2, action: "testdata", status: "failed", step: "testdata.generate",
    attempt: 2, errorCode: "SANDBOX_GENERATION_FAILED", role: "quality-alt-0", createdAt: NOW, updatedAt: NOW,
    stageStartedAt: NOW, stageEndedAt: NOW,
    state: { prompt: canary("PROMPT"), repair: canary("OLD_SOURCE"), response: canary("PROVIDER_RESPONSE") },
    input: { markdown: canary("PROMPT_BODY") }, provider: { apiKey: canary("PROVIDER_KEY"), baseUrl: canary("PROVIDER_URL") },
    error: canary("AI_TRACE"), projection: { attention: { message: canary("PROVIDER_MESSAGE") } }
  };
  const submissions = Array.from({ length: size }, (_, i) => ({
    id: i+1, problemId: 6, contestId: 7, status: "Accepted", score: 100, timeUsed: 811, memoryUsed: 702,
    problemDataVersionId: 352, submitTime: NOW, judgedAt: null, judgeMachineId: 11,
    testcaseCount: rowsPerSubmission, content: { code: canary("SOURCE_CODE") }, filename: canary("TESTDATA_NAME"),
    result: { compile: { message: canary("COMPILER_OUTPUT") }, systemMessage: canary("SYSTEM_MESSAGE") }
  }));
  const cases = submissions.flatMap(s => Array.from({ length: rowsPerSubmission }, () => ({
    submissionId: s.id, status: "TimeLimitExceeded", timeLimit: 30000, memoryLimit: 2048000,
    input: canary("INPUT"), output: canary("OUTPUT"), checkerMessage: canary("CHECKER"), testcaseInfo: { inputFile: canary("FILE_NAME") }
  })));
  const machine = { id: 11, draining: true, key: canary("JUDGE_KEY"), allowedHosts: [canary("JUDGE_HOST")], name: canary("JUDGE_NAME") };
  const caps = {
    protocolVersion: 9, consumerThreads: 4, executionSlots: 3, aiExecutionSlots: 2, memoryBudget: 4096,
    runtime: { cpu: canary("CPU_NAME"), arch: "arm64", os: canary("PRIVATE_OS"), node: "v24.21.0", judgeProgram: "a".repeat(64), sandboxImage: "b".repeat(64) }
  };
  const manager = { findOne: async (entity, { where }) => {
    if (entity === UserEntity) return where.id === admin.id ? { id: admin.id, isAdmin: administrator } : null;
    if (where.key === "ai-policy") return { value: { paused: true, userDailyTokens: 2000, userDailyRequests: 20, jobRequests: 10, concurrentRequests: 3 } };
    if (where.key === "registration-policy") return { value: { registrationMode: "approval" } };
    throw Error("unexpected row");
  } };
  const db = {
    manager, transaction: (_isolation, run) => run(manager),
    getRepository: () => ({ findAndCount: async options => {
      assert.deepEqual(options.select, ["id", "draining"]);
      return [[machine], 1];
    } }),
    query: async (sql, args) => {
      queries.push(sql);
      if (sql === "SELECT 1") return [{ "1": 1 }];
      if (sql.includes("FROM judge_job")) return [{ kind: "Submission", queued: "3", leased: "2", oldest: 123 }];
      if (sql.includes("GROUP BY status")) return [{ status: "failed", count: 1 }, { status: canary("BAD_STATUS"), count: 2 }];
      if (sql.includes("FROM ai_job j")) return sql.includes("j.id IN") && !args[0].includes(jobId) ? [] : [job];
      if (sql.includes("FROM submission s")) return submissions.filter(s => args[0].includes(s.id));
      if (sql.includes("JOIN JSON_TABLE")) return cases.filter(c => args[1].includes(c.submissionId));
      throw Error("unrecognized diagnostic query");
    }
  };
  manager.query = (sql, args) => db.query(sql, args);
  const clients = { diagnosticStates: async () => {
    if (redisFails) throw Error(canary("REDIS_ERROR"));
    return [{ id: machine.id, online: true, revoked: false, seenAt: Date.now() - 5000, capabilities: caps }];
  } };
  const health = new HealthService(db, { ping: async () => { if (redisFails) throw Error(canary("REDIS_ERROR")); } }, { storageAvailable: async () => true });
  const service = new DiagnosticBundleService(db, config, new RegistrationSettingsService(db, config), new AiPolicyService(db),
    health, clients, new AuditService({ save: async row => { log.push(row); } }));
  const controller = Object.assign(Object.create(SiteManagementController.prototype), { diagnosticBundles: service });
  return { controller, job, cases, caps, queries, log };
}

let documentPromise;
async function schemaTools() {
  documentPromise ||= (async () => {
    class FixtureModule {}
    Module({
      controllers: [SiteManagementController],
      providers: Reflect.getMetadata("design:paramtypes", SiteManagementController).map(token => ({ provide: token, useValue: {} }))
    })(FixtureModule);
    const app = await NestFactory.create(FixtureModule, { logger: false, abortOnError: false });
    try {
      return SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("Fixture").build());
    } finally {
      await app.close();
    }
  })();
  const document = await documentPromise;
  const definitions = document.components.schemas;
  const response = document.paths["/site-management/diagnosticBundle"].post.responses["201"];
  const root = response.content["application/json"].schema;
  assert.equal(root.$ref, "#/components/schemas/" + DiagnosticBundleResponseDto.name);
  function check(schema, value, path) {
    if (schema.$ref) return check(definitions[schema.$ref.split("/").pop()], value, path);
    if (schema.enum) assert.ok(schema.enum.includes(value), path);
    if (value === null && schema.nullable) return;
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), path);
    if (schema.format === "uuid") assert.match(value, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, path);
    if (schema.format === "date-time") assert.equal(new Date(value).toISOString(), value, path);
    if (schema.type === "object") {
      assert.ok(value && typeof value === "object" && !Array.isArray(value), path);
      assert.equal(schema.additionalProperties, false, path);
      for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), path + "." + key);
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(schema.properties, key), "unknown field " + path + "." + key);
        check(schema.properties[key], value[key], path + "." + key);
      }
    } else if (schema.type === "array") {
      assert.ok(Array.isArray(value), path);
      if (schema.maxItems != null) assert.ok(value.length <= schema.maxItems, path);
      value.forEach((item, i) => check(schema.items, item, path + "[" + i + "]"));
    } else {
      assert.equal(typeof value, schema.type === "integer" ? "number" : schema.type, path);
      if (typeof value === "number") assert.ok(Number.isFinite(value), path);
    }
  }
  return bundle => check(root, bundle, "bundle");
}

test("the exported JSON conforms to the closed Swagger response schema and contains only diagnostic metadata", async () => {
  const { controller, queries, log } = setup();
  const missing = randomUUID();
  const bundle = await controller.diagnosticBundle(admin, { submissionIds: [1, 234], aiJobIds: [jobId.toUpperCase(), missing] }, { requestId });
  const check = await schemaTools();
  check(bundle);
  assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE_FIXTURE_/);
  assert.deepEqual(bundle.bundle, { bundleVersion: 2, generatedAt: bundle.bundle.generatedAt, requestId, administratorId: admin.id });
  const { deploymentBuildIdentity } = require("../health/deployment-identity.ts");
  assert.deepEqual(bundle.deployment.backendProvenance, deploymentBuildIdentity.backend.provenance);
  assert.equal(bundle.deployment.backendBuild, deploymentBuildIdentity.backend.sha256);
  assert.equal(bundle.deployment.revision, bundle.deployment.backendProvenance.commit);
  assert.deepEqual(bundle.judging.machines[0].provenance, { status: "unknown", commit: null, treeSha256: null });
  assert.equal(bundle.deployment.aiExecutionMode, "judges");
  assert.equal(bundle.deployment.settings.registrationMode, "approval");
  assert.equal(bundle.deployment.settings.rateLimitDurationSeconds, 60);
  assert.equal(bundle.health.status, "ready");
  assert.equal(bundle.ai.paused, true);
  assert.equal(bundle.ai.recentFailed[0].errorCode, "SANDBOX_GENERATION_FAILED");
  assert.equal(bundle.ai.recentFailed[0].failureRole, "quality-alt-0");
  assert.deepEqual(bundle.ai.recentFailed, bundle.selected.aiJobs);
  assert.deepEqual(bundle.ai.jobCounts, { queued: 0, running: 0, completed: 0, failed: 1, cancelled: 0 });
  assert.deepEqual(bundle.judging.queue.find(row => row.kind === "Submission"), { kind: "Submission", queued: 3, leased: 2 });
  assert.equal(bundle.judging.oldestWaitingAgeSeconds, 123);
  assert.equal(bundle.judging.machines[0].executionSlots, 3);
  assert.equal(bundle.judging.machines[0].judgeProgram, "a".repeat(64));
  assert.deepEqual(bundle.selected.submissions[0].testcases, [{ status: "TimeLimitExceeded", timeLimit: 30000, memoryLimit: 2048000 }]);
  assert.deepEqual(bundle.selected.missingSubmissionIds, [234]);
  assert.deepEqual(bundle.selected.missingAiJobIds, [missing]);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "site.diagnostic_bundle.export");
  assert.equal(log[0].userId, 3);
  assert.deepEqual(log[0].details, { requestId, aiJobIds: [jobId, missing], submissionIds: [1,234] });
  assert.ok(queries.every(sql => !/SELECT \*|\bd.content\b|\bj.input\b|\bj.state\b/i.test(sql)));
  bundle.selected.aiJobs[0].unexpected = true;
  assert.throws(() => check(bundle), /unknown field .*unexpected/);
});

test("the bundle revision follows the verified startup binding and disappears on a mismatched deployment", async t => {
  const identity = require("../health/deployment-identity.ts");
  const startup = identity.deploymentBuildIdentity;
  t.after(() => { identity.deploymentBuildIdentity = startup; });
  const { controller } = setup();
  const check = await schemaTools();
  for (const provenance of [
    { status: "verified", commit: "d".repeat(40), treeSha256: "e".repeat(64) },
    { status: "mismatch", commit: null, treeSha256: null }
  ]) {
    identity.deploymentBuildIdentity = { ...startup, backend: { ...startup.backend, provenance } };
    const bundle = await controller.diagnosticBundle(admin, {}, { requestId });
    check(bundle);
    assert.equal(bundle.deployment.revision, provenance.commit);
    assert.deepEqual(bundle.deployment.backendProvenance, provenance);
    assert.equal(bundle.deployment.backendBuild, startup.backend.sha256);
    assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE_FIXTURE_/);
  }
});

test("every delegable permission and a stale admin snapshot both fail a fresh administrator check; visitors are forbidden", async () => {
  const { controller, queries, log } = setup({ administrator: false });
  const holder = { id: 4, isAdmin: false, permissions: permissionCatalog.map(p => p.key) };
  for (const user of [null, holder, admin])
    await assert.rejects(controller.diagnosticBundle(user, { submissionIds: [1] }, { requestId }), e => e.getStatus() === 403);
  assert.deepEqual(queries, []);
  assert.deepEqual(log, []);
});

test("absent and empty selection skip private data queries and keep the selected section absent", async () => {
  const { controller, queries, log } = setup({ redisFails: true });
  for (const body of [{}, { aiJobIds: [], submissionIds: [] }]) {
    const bundle = await controller.diagnosticBundle(admin, body, { requestId });
    (await schemaTools())(bundle);
    assert.equal(Object.hasOwn(bundle, "selected"), false);
    assert.equal(bundle.health.redis.status, "failed");
    assert.equal(bundle.health.status, "unavailable");
    assert.equal(bundle.judging.machines[0].online, null);
    assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE_FIXTURE_/);
  }
  assert.ok(queries.every(sql => !/FROM submission|j.id IN/.test(sql)));
  assert.equal(log.length, 2);
});

test("malformed announced runtime, error, role and testcase values do not cross the projection", async () => {
  const { controller, job, cases, caps } = setup();
  job.errorCode = "PRIVATE_FIXTURE_UNEXPECTED_CODE";
  job.role = "PRIVATE_FIXTURE_PRIVATE_ROLE";
  job.status = "PRIVATE_FIXTURE_BAD_JOB_STATUS";
  caps.runtime.node = "sk-" + "PRIVATE_FIXTURE_PRIVATE_NODE";
  caps.runtime.arch = "https://PRIVATE_FIXTURE_PRIVATE_ARCH";
  caps.runtime.sandboxImage = "PRIVATE_FIXTURE_PRIVATE_IMAGE";
  cases[0].status = "PRIVATE_FIXTURE_WRONG_STATUS";
  cases[0].memoryLimit = "PRIVATE_FIXTURE_INVALID_NUMBER";
  const bundle = await controller.diagnosticBundle(admin, { submissionIds: [1], aiJobIds: [jobId] }, { requestId });
  (await schemaTools())(bundle);
  assert.equal(bundle.selected.aiJobs[0].errorCode, "UNCLASSIFIED_ERROR");
  assert.equal(bundle.selected.aiJobs[0].status, null);
  assert.equal(bundle.ai.recentFailed[0].failureRole, null);
  assert.equal(bundle.selected.submissions[0].testcases[0].status, null);
  assert.equal(bundle.judging.machines[0].nodeVersion, null);
  assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE_FIXTURE_/);
});

test("known request-budget and sample-limit failures retain their exact backend codes", async () => {
  const { controller, job } = setup();
  for (const code of ["AI_REQUEST_EXCEEDS_BUDGET", "SAMPLES_TOO_LARGE"]) {
    job.errorCode = code;
    const result = await controller.diagnosticBundle(admin, { aiJobIds: [jobId] }, { requestId });
    assert.equal(result.selected.aiJobs[0].errorCode, code);
    assert.equal(result.ai.recentFailed[0].errorCode, code);
  }
});

test("largest selection respects the UTF-8 byte budget and reports the full testcase counts and all selected IDs", async () => {
  const ids = Array.from({ length: 50 }, (_, i) => i+1);
  const { controller } = setup({ size: 50, rowsPerSubmission: 400 });
  const bundle = await controller.diagnosticBundle(admin, { submissionIds: ids }, { requestId });
  (await schemaTools())(bundle);
  const bytes = Buffer.byteLength(JSON.stringify(bundle));
  assert.ok(bytes <= BUNDLE_BYTE_LIMIT && bytes > BUNDLE_BYTE_LIMIT - 256, String(bytes));
  assert.equal(bundle.selected.submissions.length, 50);
  assert.ok(bundle.selected.submissions.every(s => s.testcaseCount === 400 && s.testcases.length <= 200));
  assert.equal(bundle.selected.submissions[0].testcases.length, 200);
  assert.equal(bundle.selected.submissions.at(-1).testcases.length, 0);
});

test("request validation accepts optional distinct identifiers and rejects other fields, mis-typed, duplicate or excessive IDs", () => {
  const errors = body => validateSync(plainToInstance(DiagnosticBundleRequestDto, body), { whitelist: true, forbidNonWhitelisted: true }).length;
  for (const body of [{}, { submissionIds: [] }, { submissionIds: [1, 2147483647], aiJobIds: [jobId] }]) assert.equal(errors(body), 0);
  for (const body of [
    { includeSource: true }, { submissionIds: null }, { submissionIds: ["1"] }, { submissionIds: [0] }, { submissionIds: [2147483648] },
    { submissionIds: [1, 1] }, { aiJobIds: [jobId, jobId.toUpperCase()] }, { aiJobIds: "x" }, { aiJobIds: [null] },
    { aiJobIds: ["a".repeat(36)] }, { submissionIds: Array.from({ length: 51 }, (_, i) => i+1) }, { aiJobIds: Array.from({ length: 51 }, () => randomUUID()) }
  ]) assert.ok(errors(body), JSON.stringify(body));
});

test("the unexpected-error history keeps the latest 100 for 24 hours while maintaining bounded lifetime class totals", () => {
  const errors = new UnexpectedErrors(), last = Date.now(), day = 24 * 3600000;
  for (let i = 0; i < 150; i++) errors.record(new Error("private"), randomUUID(), { method: "PATCH", route: { path: "/api/test/:id" } }, last - 150 + i);
  let result = errors.snapshot(last);
  assert.equal(result.recent.length, 100);
  assert.equal(Date.parse(result.recent[0].time), last - 1);
  assert.equal(Date.parse(result.recent.at(-1).time), last - 100);
  assert.deepEqual(result.totals, [{ errorClass: "Error", count: 150 }]);
  result = errors.snapshot(last + day);
  assert.equal(result.recent.length, 0);
  assert.equal(result.totals[0].count, 150);
  for (let i = 0; i < 100; i++) {
    const CustomError = class extends Error {};
    Object.defineProperty(CustomError, "name", { value: "FixtureError" + i });
    errors.record(new CustomError(), randomUUID());
  }
  assert.equal(errors.snapshot().totals.length, 64);
  assert.equal(errors.snapshot().totals.reduce((sum, row) => sum+row.count, 0), 250);
});

test("real error filter uses the route template, omits HTTP exceptions, counts connection errors, and exports only its process", async () => {
  const entries = [];
  const filter = new ErrorFilter({ report() {} }, { counter: () => ({ inc: entry => entries.push(entry) }) });
  const makeFault = (error, route) => {
    const id = randomUUID();
    const req = { requestId: id, originalUrl: "/api/PRIVATE_FIXTURE_PATH?key=PRIVATE_FIXTURE_QUERY", baseUrl: "/PRIVATE_FIXTURE_MOUNT",
      method: "POST", route, body: { answer: "PRIVATE_FIXTURE_BODY" }, headers: { authorization: "PRIVATE_FIXTURE_HEADER" } };
    filter.catch(error, { getType: () => "http", switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ status: () => ({ send() {} }) }) }) });
    return id;
  };
  const first = makeFault(new TypeError("PRIVATE_FIXTURE_MESSAGE"), { path: "/api/submission/:id" });
  const second = makeFault(new Error("read ECONNRESET"));
  const ignored = makeFault(new ForbiddenException());
  const { controller } = setup();
  const { errors } = await controller.diagnosticBundle(admin, {}, { requestId });
  assert.equal(errors.scope, "responding_process");
  assert.equal(errors.recent.find(r => r.requestId === first).route, "/api/submission/:id");
  assert.deepEqual(errors.recent.find(r => r.requestId === second), {
    time: errors.recent.find(r => r.requestId === second).time, method: "POST", status: 500, route: null, requestId: second, errorClass: "Error"
  });
  assert.ok(!errors.recent.some(r => r.requestId === ignored));
  for (const label of entries) assert.equal(errors.totals.find(r => r.errorClass === label.error).count, 1);
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE_FIXTURE_/);
});

test("machine ID and wall-clock completion time stored for diagnostics stay out of displayed submission progress", () => {
  const stored = { progressType: "Finished", score: 100, status: "Accepted", totalOccupiedTime: 2, completion: { judgeMachineId: 123, judgedAt: NOW } };
  const expected = { progressType: "Finished", score: 100, status: "Accepted", totalOccupiedTime: 2 };
  assert.deepEqual(submissionDisplayProgress({ status: "Accepted" }, stored), expected);
  assert.equal(stored.completion.judgeMachineId, 123);
  assert.equal(submissionDisplayProgress({ status: "Fake" }, stored).completion, undefined);
  assert.deepEqual(submissionDisplayProgress({ status: "Accepted" }, expected), expected);
});
