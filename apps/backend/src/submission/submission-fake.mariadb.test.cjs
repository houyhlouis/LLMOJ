// Real SQL/service regression. Opt in with an isolated database configuration; all random tables are dropped.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
String.prototype.format ||= function (...args) { return require("node:util").format(this, ...args); };
const { DataSource, EntitySchema } = require("typeorm");
const { SubmissionService } = require("./submission.service.ts");
const { SubmissionJudgingService } = require("./submission-judging.service.ts");
const { SubmissionAccessService, SubmissionPermissionType } = require("./submission-access.service.ts");
const { SubmissionController } = require("./submission.controller.ts");
const { SubmissionStatisticsService, SubmissionStatisticsType } = require("./submission-statistics.service.ts");
const { submissionDisplayProgress } = require("./submission-display-progress.ts");
const { SubmissionEntity } = require("./submission.entity.ts");
const { SubmissionDetailEntity } = require("./submission-detail.entity.ts");
const { SubmissionResultHistoryEntity } = require("./submission-result-history.entity.ts");
const { StatisticsOutboxEntity } = require("./statistics-outbox.entity.ts");
const { StatisticsOutboxService } = require("./statistics-outbox.service.ts");
const { UserEntity } = require("../user/user.entity.ts");
const { UserService } = require("../user/user.service.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts");
const { ProblemService } = require("../problem/problem.service.ts");
const { ContestEntity } = require("../contest/contest.entity.ts");
const { scoreContest } = require("../contest/contest-scoring.ts");
const { TeamEntity, TeamMemberEntity, TeamResourceEntity } = require("../team/team.entity.ts");

test("fake retains evidence, updates statistics and resists judge races (real MariaDB)", {
  skip: !process.env.LLMOJ_FAKE_TEST_DB_CONFIG, timeout: 60000
}, async t => {
  const cfg = require("js-yaml").load(fs.readFileSync(process.env.LLMOJ_FAKE_TEST_DB_CONFIG, "utf8")).services.database;
  const prefix = "qa_fake_" + crypto.randomBytes(8).toString("hex") + "_", n = { type: Number };
  const defs = [
    [UserEntity, "user", { id: { ...n, primary: true }, submissionCount: n, acceptedProblemCount: n }],
    [ProblemEntity, "problem", { id: { ...n, primary: true }, type: { type: String }, submissionCount: n, acceptedSubmissionCount: n }],
    [SubmissionEntity, "submission", { id: { ...n, primary: true, generated: true }, problemId: n, submitterId: n,
      contestId: { ...n, nullable: true }, contestProblemId: { ...n, nullable: true }, taskId: { type: String, nullable: true },
      status: { type: "enum", enum: ["Accepted", "WrongAnswer", "PartiallyCorrect", "Pending", "Fake", "Canceled"] },
      score: { ...n, nullable: true }, timeUsed: { ...n, nullable: true }, memoryUsed: { ...n, nullable: true },
      totalOccupiedTime: { ...n, nullable: true }, answerSize: n, submitTime: { type: Date } }],
    [SubmissionDetailEntity, "detail", { submissionId: { ...n, primary: true }, content: { type: "json" }, fileUuid: { type: String, nullable: true }, result: { type: "json", nullable: true } }],
    [SubmissionResultHistoryEntity, "history", { id: { ...n, primary: true, generated: true }, submissionId: n, problemDataVersionId: { ...n, nullable: true },
      status: { type: String }, score: { ...n, nullable: true }, timeUsed: { ...n, nullable: true }, memoryUsed: { ...n, nullable: true },
      totalOccupiedTime: { ...n, nullable: true }, result: { type: "json", nullable: true }, replacedAt: { type: Date }, replacedBy: { ...n, nullable: true } }],
    [StatisticsOutboxEntity, "outbox", { id: { ...n, primary: true, generated: true }, kind: { type: String }, targetId: n, submissions: n, accepted: n, createdAt: { type: Date } }],
    [TeamEntity, "team", { id: { ...n, primary: true }, ownerId: n, archived: { type: Boolean } }],
    [TeamMemberEntity, "member", { id: { ...n, primary: true }, teamId: n, userId: n, status: { type: String }, permissions: { type: "json" } }],
    [TeamResourceEntity, "resource", { id: { ...n, primary: true }, teamId: n, resourceId: n, kind: { type: String }, visibility: { type: String }, invitedUserIds: { type: "json" }, archived: { type: Boolean } }],
    [ContestEntity, "contest", { id: { ...n, primary: true }, ownerId: n, adminIds: { type: "json" }, endTime: { type: Date } }]
  ];
  const db = new DataSource({ ...cfg, entities: defs.map(([target, name, columns]) => new EntitySchema({ name: target.name, target, tableName: prefix + name, columns })), synchronize: true, logging: false });
  try {
    await db.initialize();
    const users = db.getRepository(UserEntity), problems = db.getRepository(ProblemEntity), subs = db.getRepository(SubmissionEntity), details = db.getRepository(SubmissionDetailEntity);
    const tails = new Map(), locks = { lock: async (key, callback) => {
      const previous = tails.get(key) || Promise.resolve(); let release;
      const gate = new Promise(done => release = done), tail = previous.then(() => gate); tails.set(key, tail); await previous;
      try { return await callback(); } finally { release(); if (tails.get(key) === tail) tails.delete(key); }
    }};
    const problemService = Object.create(ProblemService.prototype);
    Object.assign(problemService, { problemRepository: problems, userHasPermission: async () => true,
      lockProblemById: async (id, _type, callback) => callback(await problems.findOneBy({ id })) });
    const svc = Object.create(SubmissionService.prototype), userService = Object.create(UserService.prototype);
    Object.assign(userService, { userRepository: users, submissionService: svc, lockService: locks });
    const cache = new Map(), stats = Object.create(SubmissionStatisticsService.prototype);
    Object.assign(stats, { connection: db, submissionService: svc, redisService: {
      cacheGet: async key => cache.get(key) || null, cacheSet: async (key, value) => cache.set(key, value), cacheDelete: async key => cache.delete(key)
    }});
    const events = [], audits = [], canceled = [], queued = [];
    Object.assign(svc, { connection: db, submissionRepository: subs, submissionDetailRepository: details, problemService, userService, lockService: locks,
      submissionStatisticsService: stats, judgeGateway: { cancelTask: id => canceled.push(id) }, judgeQueueService: { enqueue: async (...args) => queued.push(args), notifyJobsAvailable() {} },
      submissionProgressService: { emitSubmissionEvent: async (...args) => events.push(args) }, auditService: { log: async (...args) => audits.push(args) },
      configService: { config: { preference: { serverSideOnly: { dynamicTaskPriority: false } } } },
      problemTypeFactoryService: { type: () => ({ getTimeAndMemoryUsedFromFinishedSubmissionProgress: () => ({ timeUsed: 4, memoryUsed: 8 }) }) },
      metricSubmissionJudgeTime: { observe: () => {} }, problemDataVersionService: { current: async () => null, findById: async () => null },
      statisticsOutboxService: Object.assign(Object.create(StatisticsOutboxService.prototype), { connection: db }),
      userPrivilegeService: {
        userHasPrivilege: async (u, p) => !!u && (u.isAdmin || ["ViewContest", "ViewSubmission"].includes(p)),
        permissionDecision: async (u, p) => !!u && (u.isAdmin || p === "RejudgeSubmission") }
    });
    // The judging half and the permission rules of the submission service, with the same collaborators
    const judging = Object.assign(Object.create(SubmissionJudgingService.prototype), svc);
    const access = Object.assign(Object.create(SubmissionAccessService.prototype), svc);
    judging.submissionAccessService = access;
    svc.submissionJudgingService = judging;
    const controller = Object.create(SubmissionController.prototype);
    Object.assign(controller, { submissionService: svc, submissionAccessService: access, submissionJudgingService: judging });
    const original = { progressType: "Finished", status: "Accepted", score: 100, totalOccupiedTime: 500,
      testcaseResult: { a: { status: "Accepted", score: 100, time: 4, memory: 8 } }, subtasks: [{ score: 100, fullScore: 100, testcases: [{ testcaseHash: "a" }] }] };
    const start = new Date("2026-01-01T00:00:00Z");
    async function reset(count = 1, accepted = 1) {
      await db.getRepository(SubmissionResultHistoryEntity).clear(); await details.clear(); await subs.clear(); cache.clear(); events.length = audits.length = canceled.length = queued.length = 0;
      await users.save({ id: 2, submissionCount: count, acceptedProblemCount: accepted > 0 ? 1 : 0 });
      await problems.save({ id: 1, type: "Traditional", submissionCount: count, acceptedSubmissionCount: accepted });
    }
    async function create(status = "Accepted", contestId = null) {
      const s = await subs.save({ problemId: 1, submitterId: 2, contestId, contestProblemId: contestId ? 1 : null, status,
        score: status === "Pending" ? null : status === "Accepted" ? 100 : 0, taskId: status === "Pending" ? crypto.randomUUID() : null,
        timeUsed: 4, memoryUsed: 8, totalOccupiedTime: 500, answerSize: 23, submitTime: new Date(+start + 60000) });
      await details.save({ submissionId: s.id, content: { code: "int main() { return 0; }" }, fileUuid: "preserved-upload", result: original }); return s;
    }
    await t.test("sole AC updates counts and cached rankings but preserves record, code, file and result", async () => {
      await reset(); const s = await create(), before = await details.findOneBy({ submissionId: s.id });
      for (const type of Object.values(SubmissionStatisticsType)) assert.equal((await stats.querySubmissionStatisticsAndCount({ id: 1 }, type, 0, 100))[1], 1);
      assert.equal((await stats.querySubmissionScoreStatistics({ id: 1 }))[100], 1);
      assert.equal(await svc.fakeSubmission(s, 9), true); const now = await subs.findOneBy({ id: s.id });
      assert.equal(now.status, "Fake"); assert.equal(now.score, 0); assert.equal(now.taskId, null);
      assert.deepEqual(await details.findOneBy({ submissionId: s.id }), before);
      assert.equal((await users.findOneBy({ id: 2 })).submissionCount, 1); assert.equal((await users.findOneBy({ id: 2 })).acceptedProblemCount, 0);
      assert.equal((await problems.findOneBy({ id: 1 })).submissionCount, 1); assert.equal((await problems.findOneBy({ id: 1 })).acceptedSubmissionCount, 0);
      for (const type of Object.values(SubmissionStatisticsType)) assert.equal((await stats.querySubmissionStatisticsAndCount({ id: 1 }, type, 0, 100))[1], 0);
      assert.equal((await stats.querySubmissionScoreStatistics({ id: 1 })).reduce((a, b) => a + b, 0), 0);
      assert.equal(audits[0][0], 9); assert.equal(audits[0][1], "submission.fake"); assert.equal(audits[0][4].previousScore, 100);
      const displayed = submissionDisplayProgress(now, before.result); assert.equal(displayed.status, "Fake"); assert.equal(displayed.score, 0);
      assert.deepEqual(displayed.subtasks, before.result.subtasks); assert.equal(before.result.status, "Accepted");
    });
    await t.test("concurrent duplicate fake changes only one of two ACs exactly once", async () => {
      await reset(2, 2); const s = await create(); await create(); await Promise.all([svc.fakeSubmission(s, 9), svc.fakeSubmission({ ...s }, 9)]);
      assert.equal((await users.findOneBy({ id: 2 })).acceptedProblemCount, 1); assert.equal((await problems.findOneBy({ id: 1 })).acceptedSubmissionCount, 1);
      assert.equal(await subs.count(), 2); assert.equal(audits.length, 1);
    });
    await t.test("same zero-score verdict still invalidates score histogram when it becomes fake", async () => {
      await reset(1, 0); const s = await create("WrongAnswer"); assert.equal((await stats.querySubmissionScoreStatistics({ id: 1 }))[0], 1);
      await svc.fakeSubmission(s, 9); assert.equal((await stats.querySubmissionScoreStatistics({ id: 1 }))[0], 0);
    });
    await t.test("finished/running callbacks that found a task before fake cannot overwrite the locked verdict", async () => {
      for (const progress of [original, { progressType: "Running" }]) {
        await reset(1, 0); const s = await create("Pending"), find = judging.findSubmissionByTaskId;
        judging.findSubmissionByTaskId = async () => { await svc.fakeSubmission(s, 9); return s; };
        try { assert.equal(await judging.onTaskProgress(s.taskId, progress), false); } finally { judging.findSubmissionByTaskId = find; }
        assert.equal((await subs.findOneBy({ id: s.id })).status, "Fake"); assert.equal(events.length, 1); assert.deepEqual(canceled, [s.taskId]);
      }
    });
    await t.test("authorized restore creates a new judge task, rejects the old task and recovers AC counts", async () => {
      await reset(1, 0); const s = await create("Pending"), oldTask = s.taskId;
      await svc.fakeSubmission(s, 9); await judging.rejudgeSubmission(s, { id: 9, isAdmin: true });
      const pending = await subs.findOneBy({ id: s.id }); assert.equal(pending.status, "Pending"); assert.notEqual(pending.taskId, oldTask);
      assert.equal((await details.findOneBy({ submissionId: s.id })).result, null);
      const [kept, ...more] = await db.getRepository(SubmissionResultHistoryEntity).findBy({ submissionId: s.id });
      assert.equal(more.length, 0); assert.equal(kept.status, "Fake"); assert.equal(kept.score, 0); assert.equal(kept.replacedBy, 9);
      assert.deepEqual(kept.result, original, "the rejudge keeps the result it replaced");
      assert.equal(await judging.onTaskProgress(oldTask, original), false); assert.equal(await judging.onTaskProgress(pending.taskId, original), true);
      assert.equal((await subs.findOneBy({ id: s.id })).status, "Accepted"); assert.equal((await users.findOneBy({ id: 2 })).acceptedProblemCount, 1); assert.equal(queued.length, 1);
    });
    await t.test("owner/rejudge-only users cannot fake or restore; lock recheck defeats stale permissions", async () => {
      await reset(); const s = await create(), user = { id: 2, isAdmin: false };
      assert.deepEqual(await controller.fakeSubmission(null, { submissionId: s.id }), { error: "PERMISSION_DENIED" });
      assert.deepEqual(await controller.fakeSubmission(user, { submissionId: s.id }), { error: "PERMISSION_DENIED" });
      await svc.fakeSubmission(s, 9); const fake = await subs.findOneBy({ id: s.id });
      assert.equal(await access.userHasPermission(user, fake, SubmissionPermissionType.Rejudge), false);
      await assert.rejects(judging.rejudgeSubmission(s, user), /Restoring a fake submission/);
      assert.equal((await subs.findOneBy({ id: s.id })).status, "Fake");
      assert.equal(await access.userHasPermission({ id: 9, isAdmin: true }, fake, SubmissionPermissionType.Rejudge), true);
    });
    await t.test("NOI/IOI/ACM scores become zero without polluting ordinary OJ counters", async () => {
      await reset(3, 2); const s = await create("Accepted", 7); await svc.fakeSubmission(s, 9);
      for (const rule of ["noi", "ioi", "acm"]) assert.equal(scoreContest(rule, start, [{ id: 1, weight: 1 }], await subs.findBy({ contestId: 7 }))[0].score, 0);
      assert.equal((await users.findOneBy({ id: 2 })).acceptedProblemCount, 1); assert.equal((await problems.findOneBy({ id: 1 })).acceptedSubmissionCount, 2);
      assert.equal((await users.findOneBy({ id: 2 })).submissionCount, 3);
    });
  } finally {
    if (db.isInitialized) {
      for (const [, name] of [...defs].reverse()) await db.query("DROP TABLE IF EXISTS `" + prefix + name + "`");
      const remaining = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND LEFT(TABLE_NAME,?)=?", [prefix.length, prefix]);
      assert.equal(remaining.length, 0); await db.destroy();
    }
  }
});
