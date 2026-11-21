// The same SQL and Redis projections the export uses, including a real fenced submission completion.
// Only the dedicated, disposable diagnostic test database is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { DataSource } = require("typeorm");
const { RegistrationSettingsService, UserEntity, UserAuthEntity } = require("../auth/registration-test-helpers.cjs");
const { redisAvailable, startRedis } = require("../../test/temporary-redis.cjs");
const { JudgeClientEntity } = require("../judge/judge-client.entity.ts");
const { JudgeClientService } = require("../judge/judge-client.service.ts");
const { JudgeRuntimeEntity } = require("../judge/judge-runtime.entity.ts");
const { JudgeJobEntity, JudgeJobAttemptEntity } = require("../judge/judge-job.entity.ts");
const { JudgeQueueService } = require("../judge/judge-queue.service.ts");
const { SubmissionEntity } = require("../submission/submission.entity.ts");
const { SubmissionDetailEntity } = require("../submission/submission-detail.entity.ts");
const { SubmissionJudgingService } = require("../submission/submission-judging.service.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts");
const { ProblemSampleEntity } = require("../problem/problem-sample.entity.ts");
const { ProblemJudgeInfoEntity } = require("../problem/problem-judge-info.entity.ts");
const { AiJobEntity, AiConfigurationEntity } = require("../ai/ai.entity.ts");
const { AiObservationEntity } = require("../ai/ai-observation.entity.ts");
const { AuditService } = require("../audit/audit.service.ts");
const { AuditLogEntity } = require("../audit/audit-log.entity.ts");
const { AiPolicyService } = require("../settings/ai-policy.service.ts");
const { SettingsEntity } = require("../settings/settings.entity.ts");
const { HealthService } = require("../health/health.service.ts");
const { DiagnosticBundleService } = require("./diagnostic-bundle.service.ts");

const entities = [
  UserEntity, UserAuthEntity, ProblemEntity, ProblemSampleEntity, ProblemJudgeInfoEntity,
  SubmissionEntity, SubmissionDetailEntity, SettingsEntity, AuditLogEntity, JudgeClientEntity, JudgeJobEntity,
  JudgeJobAttemptEntity, JudgeRuntimeEntity, AiJobEntity, AiObservationEntity, AiConfigurationEntity
];
test("the disposable diagnostic schema resolves the production entity relations without a listener", async () => {
  const db = new DataSource({ type: "mariadb", database: "llmoj_test_diagnostic_bundle", entities });
  await db.buildMetadatas();
  assert.equal(db.entityMetadatas.length, entities.length);
  assert.equal(db.getMetadata(SubmissionEntity).relations.find(r => r.propertyName === "detail").inverseEntityMetadata.target,
    SubmissionDetailEntity);
});

async function assertEmptyDiagnosticDatabase(runner) {
  assert.equal((await runner.query("SELECT DATABASE() AS db"))[0].db, "llmoj_test_diagnostic_bundle");
  const [{ n }] = await runner.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  assert.equal(Number(n), 0, "the disposable database must be empty");
}

test("the fixture accepts an empty diagnostic database when other visible databases have tables", async t => {
  const { DatabaseSync } = require("node:sqlite");
  const catalog = new DatabaseSync(":memory:");
  t.after(() => catalog.close());
  const database = "llmoj_test_diagnostic_bundle";
  catalog.function("DATABASE", () => database);
  catalog.exec("ATTACH DATABASE ':memory:' AS information_schema");
  catalog.exec("CREATE TABLE information_schema.TABLES (TABLE_SCHEMA TEXT, TABLE_NAME TEXT)");
  const addTable = catalog.prepare("INSERT INTO information_schema.TABLES VALUES (?, ?)");
  addTable.run("other_fixture", "submission");
  addTable.run("another_fixture", "settings");
  const runner = { query: sql => catalog.prepare(sql).all() };
  await assertEmptyDiagnosticDatabase(runner);
  addTable.run(database, "existing_data");
  await assert.rejects(assertEmptyDiagnosticDatabase(runner), /the disposable database must be empty/);
});

const dbConfig = process.env.LLMOJ_DIAGNOSTIC_BUNDLE_TEST_DB_CONFIG;
const skip = (!dbConfig || !redisAvailable) && "needs LLMOJ_DIAGNOSTIC_BUNDLE_TEST_DB_CONFIG and redis-server";
test("the administrator exports real stored jobs, queue counts, judge lifecycle and bounded testcase metadata", { skip }, async t => {
  const database = JSON.parse(fs.readFileSync(dbConfig, "utf8")).services.database;
  assert.equal(database.database, "llmoj_test_diagnostic_bundle", "requires its dedicated disposable test database");
  const originalMode = process.env.LLMOJ_AI_EXECUTION;
  process.env.LLMOJ_AI_EXECUTION = "judges";
  t.after(() => {
    if (originalMode === undefined) delete process.env.LLMOJ_AI_EXECUTION;
    else process.env.LLMOJ_AI_EXECUTION = originalMode;
  });
  const redis = await startRedis(t);
  const db = new DataSource({ ...database, entities, dropSchema: false, synchronize: false, logging: false });
  await db.initialize();
  const runner = db.createQueryRunner();
  await runner.connect();
  let ownedTables = [];
  t.after(async () => {
    try {
      if (ownedTables.length) {
        await runner.query("SET FOREIGN_KEY_CHECKS = 0");
        for (const table of ownedTables) await runner.query("DROP TABLE IF EXISTS " + db.driver.escape(table));
      }
    } finally {
      try { await runner.query("SET FOREIGN_KEY_CHECKS = 1"); } finally {
        await runner.release();
        await db.destroy();
      }
    }
  });
  await assertEmptyDiagnosticDatabase(runner);
  ownedTables = db.entityMetadatas.map(entity => entity.tableName);
  await db.synchronize();
  await db.getRepository(UserEntity).insert([3,4].map(id => ({
    id, username: "fixture" + id, email: id + "@example.invalid", nickname: "", bio: "", avatarInfo: "",
    isAdmin: id === 3, acceptedProblemCount: 0, submissionCount: 0, rating: 0, publicEmail: false
  })));
  await db.getRepository(ProblemEntity).insert({
    id: 5, type: "Traditional", isPublic: false, ownerId: 3, locales: ["en_US"], submissionCount: 0, acceptedSubmissionCount: 0
  });
  await db.getRepository(AiConfigurationEntity).insert({ userId: 4, encrypted: "PRIVATE_FIXTURE_PROVIDER_KEY" });
  const clients = new JudgeClientService(db.getRepository(JudgeClientEntity), db.getRepository(JudgeJobEntity), { getClient: () => redis });
  const machine = await clients.addJudgeClient("PRIVATE_FIXTURE_NAME", ["PRIVATE_FIXTURE_IP"]);
  const privateKey = machine.key;
  await clients.setJudgeClientOnlineSessionId(machine, "fixture-socket");
  await clients.noteConnected([machine.id]);
  await clients.setJudgeClientDraining(machine, true);
  await clients.updateJudgeClientCapabilities(machine, {
    protocolVersion: 9, consumerThreads: 8, executionSlots: 4, aiExecutionSlots: 2, memoryBudget: 4096,
    runtime: { arch: "arm64", node: "v24.21.0", os: "PRIVATE_FIXTURE_OS", cpu: "PRIVATE_FIXTURE_CPU",
      judgeProgram: "c".repeat(64), sandboxImage: "d".repeat(64) }
  });

  const taskId = randomUUID(), now = new Date();
  const sub = await db.getRepository(SubmissionEntity).save({
    submitterId: 4, problemId: 5, taskId, isPublic: false, status: "Pending", submitTime: now
  });
  await db.getRepository(SubmissionDetailEntity).save({ submissionId: sub.id, content: { code: "PRIVATE_FIXTURE_CODE" } });
  const legacy = await db.getRepository(SubmissionEntity).save({
    submitterId: 4, problemId: 5, isPublic: true, status: "Pending", submitTime: now
  });
  const job = { taskId, type: "Submission", state: "Leased", createdAt: now, availableAt: now, priority: 0,
    fence: 2, leaseOwner: "fixture-socket", judgeClientId: machine.id, unfinishedLeases: 0, preparationFailures: 0 };
  await db.getRepository(JudgeJobEntity).insert(job);
  await db.getRepository(JudgeJobEntity).insert({ ...job, taskId: randomUUID(), type: "Hack", state: "Queued", createdAt: new Date(now - 120000) });
  const judge = Object.assign(Object.create(SubmissionJudgingService.prototype), {
    submissionRepository: db.getRepository(SubmissionEntity), submissionDetailRepository: db.getRepository(SubmissionDetailEntity),
    connection: db, lockSubmission: (submission, _lock, act) => act(submission, { type: "Traditional" }),
    statisticsOutboxService: { record: async () => [], apply() {} }, submissionStatisticsService: { onSubmissionUpdated() {} },
    problemTypeFactoryService: { type: () => ({ getTimeAndMemoryUsedFromFinishedSubmissionProgress: () => ({ timeUsed: 2, memoryUsed: 10 }) }) },
    submissionProgressService: { emitSubmissionEvent() {} }, metricSubmissionJudgeTime: { observe() {} }
  });
  const queue = Object.assign(Object.create(JudgeQueueService.prototype), { connection: db, taskServices: new Map([["Submission", judge]]) });
  const progress = { progressType: "Finished", status: "WrongAnswer", score: 0, totalOccupiedTime: 2,
    compile: { success: true, message: "PRIVATE_FIXTURE_COMPILER" }, testcaseResult: {
      PRIVATE_FIXTURE_HASH: { status: "WrongAnswer", input: "PRIVATE_FIXTURE_BYTES", checkerMessage: "PRIVATE_FIXTURE_MSG",
        testcaseInfo: { inputFile: "PRIVATE_FIXTURE_INPUT_NAME", timeLimit: 3000, memoryLimit: 9000 } }
    } };
  const lease = { fence: 2, connectionId: "fixture-socket" };
  assert.equal(await queue.onTaskProgress({ taskId, type: "Submission" }, { ...lease, fence: 1 }, progress), false);
  assert.equal(await queue.onTaskProgress({ taskId, type: "Submission" }, lease, progress), true);
  assert.equal(await queue.onTaskProgress({ taskId, type: "Submission" }, lease, progress), true);

  const aiId = randomUUID(), runToken = randomUUID();
  await db.getRepository(AiJobEntity).save({ id: aiId, ownerId: 4, problemId: 5, action: "testdata", status: "failed",
    error: "PROVIDER_TIMEOUT:PRIVATE_FIXTURE_AI_ERROR", runToken, step: "testdata.quality-plan", input: { markdown: "PRIVATE_FIXTURE_PROMPT" },
    state: { output: "PRIVATE_FIXTURE_RESPONSE" }, stageStartedAt: now, stageEndedAt: now });
  const observation = { jobId: aiId, kind: "time_limit", evidence: "none", bytes: 0, fatal: true, expiresAt: now };
  await db.getRepository(AiObservationEntity).save([
    { ...observation, id: randomUUID(), runToken, observation: { role: "quality-alt-0", artifacts: [{ preview: "PRIVATE_FIXTURE_ARTIFACT" }] }, createdAt: now },
    { ...observation, id: randomUUID(), runToken: randomUUID(), observation: { role: "std" }, createdAt: new Date(+now + 1000) }
  ]);

  const config = { config: { server: {}, services: {}, security: {}, preference: { security: { registrationMode: "closed" } } } };
  const health = new HealthService(db, { ping: () => redis.ping() }, { storageAvailable: async () => true });
  const service = new DiagnosticBundleService(db, config, new RegistrationSettingsService(db, config), new AiPolicyService(db),
    health, clients, new AuditService(db.getRepository(AuditLogEntity)));
  const requestId = randomUUID(), otherId = randomUUID();
  const exportFor = (user, selection = {}) => service.export(user, selection, requestId);
  await assert.rejects(exportFor({ id: 4, isAdmin: true }), e => e.getStatus() === 403);
  const actor = { id: 3, isAdmin: true };
  const result = await exportFor(actor, { aiJobIds: [otherId, aiId], submissionIds: [legacy.id, sub.id, 9999] });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /PRIVATE_FIXTURE_/);
  assert.ok(!serialized.includes(privateKey));
  assert.deepEqual(result.selected.missingAiJobIds, [otherId]);
  assert.deepEqual(result.selected.missingSubmissionIds, [9999]);
  const [old, current] = result.selected.submissions;
  assert.equal(old.id, legacy.id);
  assert.deepEqual([old.judgedAt, old.judgeMachineId, old.testcaseCount], [null, null, 0]);
  assert.equal(current.judgeMachineId, machine.id);
  assert.ok(Date.parse(current.judgedAt) >= +now);
  assert.deepEqual(current.testcases, [{ status: "WrongAnswer", timeLimit: 3000, memoryLimit: 9000 }]);
  assert.equal(current.testcaseCount, 1);
  assert.equal(result.ai.jobCounts.failed, 1);
  assert.deepEqual(result.ai.recentFailed, result.selected.aiJobs);
  assert.equal(result.selected.aiJobs[0].errorCode, "PROVIDER_TIMEOUT");
  assert.equal(result.selected.aiJobs[0].failureRole, "quality-alt-0");
  assert.equal(result.judging.queue.find(row => row.kind === "Hack").queued, 1);
  assert.ok(result.judging.oldestWaitingAgeSeconds >= 119);
  const [active] = result.judging.machines;
  assert.equal(active.online, true);
  assert.equal(active.draining, true);
  assert.equal(active.revoked, false);
  assert.ok(active.lastSeenAgeSeconds >= 0);
  assert.equal(active.nodeVersion, "v24.21.0");
  assert.equal((await db.getRepository(AuditLogEntity).findOneByOrFail({ userId: 3 })).details.requestId, requestId);
  await clients.resetJudgeClientKey(machine);
  const [revoked] = (await exportFor(actor)).judging.machines;
  assert.deepEqual([revoked.online, revoked.revoked], [false, true]);
  await clients.setJudgeClientOnlineSessionId(machine, "new-fixture-socket");
  assert.equal((await exportFor(actor)).judging.machines[0].revoked, false);
  await clients.deleteJudgeClient(machine);
  assert.equal((await exportFor(actor)).judging.machineCount, 0);
  // Commit a rejudge through another pool connection after the export read the header, before it reads cases.
  const originalTransaction = db.transaction.bind(db);
  let replaced = false;
  db.transaction = (isolation, work) => originalTransaction(isolation, async manager => {
    if (isolation === "REPEATABLE READ" && !replaced) {
      const query = manager.query.bind(manager);
      manager.query = async (sql, args) => {
        const rows = await query(sql, args);
        if (sql.includes("FROM submission s") && !replaced) {
          replaced = true;
          await originalTransaction("READ COMMITTED", async writer => {
            await writer.update(SubmissionEntity, sub.id, { status: "Accepted", problemDataVersionId: 64 });
            await writer.update(SubmissionDetailEntity, sub.id, {
              result: { ...progress, status: "Accepted", testcaseResult: { new: { status: "Accepted", testcaseInfo: { timeLimit: 100 } } } }
            });
          });
        }
        return rows;
      };
    }
    return await work(manager);
  });
  const [beforeRejudge] = (await exportFor(actor, { submissionIds: [sub.id] })).selected.submissions;
  assert.equal(replaced, true);
  assert.deepEqual([beforeRejudge.status, beforeRejudge.testcases[0].status, beforeRejudge.problemDataVersionId],
    ["WrongAnswer", "WrongAnswer", null]);
  const [afterRejudge] = (await exportFor(actor, { submissionIds: [sub.id] })).selected.submissions;
  assert.deepEqual([afterRejudge.status, afterRejudge.testcases[0].status, afterRejudge.problemDataVersionId],
    ["Accepted", "Accepted", 64]);
  assert.equal(await db.getRepository(AuditLogEntity).count(), 6);
});
