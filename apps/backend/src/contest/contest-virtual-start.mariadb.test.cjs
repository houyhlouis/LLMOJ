// Disposable MariaDB only. Exercise both sides of the contest/user locks and the actual SQL elapsed-time filters.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(
  ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
  }).outputText, filename
);
require("@nestjs/common").Logger.overrideLogger(false);
const { DataSource } = require("typeorm");
const { UserEntity } = require("../user/user.entity.ts");
const { UserPrivilegeEntity } = require("../user/user-privilege.entity.ts");
const { UserPrivilegeService } = require("../user/user-privilege.service.ts");
const { UserPermissionRuleEntity } = require("../access/user-permission-rule.entity.ts");
const { UserAuthEntity } = require("../auth/user-auth.entity.ts");
const { AuditLogEntity } = require("../audit/audit-log.entity.ts");
const { requestContext } = require("../common/request-context.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts");
const { ProblemSampleEntity } = require("../problem/problem-sample.entity.ts");
const { ProblemJudgeInfoEntity } = require("../problem/problem-judge-info.entity.ts");
const { TeamResourceEntity } = require("../team/team.entity.ts");
const { SubmissionEntity } = require("../submission/submission.entity.ts");
const { SubmissionDetailEntity } = require("../submission/submission-detail.entity.ts");
const { SubmissionService } = require("../submission/submission.service.ts");
const { ContestEntity } = require("./contest.entity.ts");
const { ContestProblemEntity } = require("./contest-problem.entity.ts");
const { ContestVirtualParticipationEntity: Run } = require("./contest-virtual-participation.entity.ts");
const { ContestAccessService } = require("./contest-access.service.ts");
const { ContestSubmissionService } = require("./contest-submission.service.ts");
const { ContestService } = require("./contest.service.ts");
const { ContestScoreService } = require("./contest-score.service.ts");

const configPath = process.env.LLMOJ_CONTEST_VIRTUAL_TEST_DB_CONFIG;
const errorCode = code => error => error.getResponse().error === code;
const SECOND = 1000;

// Pause the first INSERT before its SQL is issued. Observe the second transaction request the lock,
// verify its SELECT hasn't completed, then release both operations and surface any fixture/SQL errors.
async function interleave(db, beforeInsertTarget, lockTarget, first, second) {
  const inserting = Promise.withResolvers(), requested = Promise.withResolvers(), acquired = Promise.withResolvers();
  const release = Promise.withResolvers();
  const isLockQuery = sql => sql.includes("FOR UPDATE") && sql.includes("FROM `" + lockTarget + "`");
  const subscriber = {
    async beforeInsert(event) {
      if (event.metadata.target === beforeInsertTarget) {
        inserting.resolve();
        await release.promise;
      }
    },
    beforeQuery({ query }) { if (isLockQuery(query)) requested.resolve(); },
    afterQuery({ query }) { if (isLockQuery(query)) acquired.resolve(); }
  };
  db.subscribers.push(subscriber);
  async function reached(promise, operation, name) {
    let timer;
    try {
      await Promise.race([promise, operation.then(() => { throw new Error("Operation finished before " + name); }), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for " + name)), 8000);
      })]);
    } finally { clearTimeout(timer); }
  }
  let held, competing;
  try {
    held = first();
    await reached(inserting.promise, held, "insert of " + beforeInsertTarget.name);
    competing = second();
    await reached(requested.promise, competing, "exclusive lock on " + lockTarget);
    assert.equal(await Promise.race([
      acquired.promise.then(() => "acquired"),
      new Promise(resolve => setTimeout(() => resolve("waiting"), 100))
    ]), "waiting", "the second connection must wait for the first transaction's commit");
  } finally {
    release.resolve();
    db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
    await Promise.allSettled([held, competing]);
  }
  return await Promise.all([held, competing]);
}

test("virtual contest transactions and replay queries in MariaDB", {
  skip: !configPath && "needs LLMOJ_CONTEST_VIRTUAL_TEST_DB_CONFIG", timeout: 120000
}, async t => {
  const cfg = require("js-yaml").load(fs.readFileSync(configPath, "utf8")).services.database;
  assert.equal(cfg.database, "llmoj_test_contest_virtual", "The virtual contest suite requires its dedicated database");
  const entities = [UserEntity, UserAuthEntity, UserPrivilegeEntity, UserPermissionRuleEntity, TeamResourceEntity, AuditLogEntity,
    ProblemEntity, ProblemSampleEntity, ProblemJudgeInfoEntity, SubmissionEntity, SubmissionDetailEntity, ContestEntity, ContestProblemEntity, Run];
  const db = new DataSource({ ...cfg, entities, synchronize: false, dropSchema: false, migrationsRun: false, logging: false });
  await db.initialize();
  let ownsFixture = false;
  t.after(async () => {
    try {
      if (ownsFixture) {
        const runner = db.createQueryRunner();
        await runner.connect();
        try {
          await runner.query("SET FOREIGN_KEY_CHECKS=0");
          for (const entity of entities)
            await runner.query("DROP TABLE IF EXISTS " + db.driver.escape(db.getMetadata(entity).tableName));
        } finally { await runner.query("SET FOREIGN_KEY_CHECKS=1"); await runner.release(); }
      }
    } finally { await db.destroy(); }
  });
  assert.equal((await db.query("SHOW TABLES")).length, 0, "Refusing to change a nonempty database");
  ownsFixture = true;
  await db.synchronize();
  const base = Math.floor(Date.now() / SECOND) * SECOND;
  let serial = 0, wallNow = base;
  t.mock.method(Date, "now", () => wallNow);
  async function user(isAdmin = false) {
    const name = "virtual-" + ++serial;
    return await db.manager.save(UserEntity, { username: name, email: name + "@example.invalid", nickname: "", bio: "",
      avatarInfo: "", isAdmin, acceptedProblemCount: 0, submissionCount: 0, rating: 0, publicEmail: false, registrationTime: new Date(base) });
  }
  const admin = await user(true);
  const privileges = new UserPrivilegeService(db, db.getRepository(UserPrivilegeEntity));
  const access = new ContestAccessService(db, privileges);
  const scores = new ContestScoreService(db);
  const problem = await db.manager.save(ProblemEntity, { ownerId: admin.id, type: "Traditional", isPublic: true,
    locales: ["en_US"], submissionCount: 0, acceptedSubmissionCount: 0 });
  const content = { language: "cpp", code: "int main(){}", compileAndRunOptions: { compiler: "g++", std: "c++17", O: "0", m: "64" } };
  const submissions = Object.assign(Object.create(SubmissionService.prototype), {
    connection: db, submissionDetailRepository: db.getRepository(SubmissionDetailEntity),
    problemTypeFactoryService: { type: () => ({
      validateSubmissionContent: async () => [], shouldUploadAnswerFile: () => false,
      getCodeLanguageAndAnswerSizeFromSubmissionContentAndFile: async () => ({ language: "cpp", answerSize: null })
    }) },
    submissionJudgingService: { dataVersionToPin: async () => null, queueJudgeTask: async () => {},
      lockSubmission: async (s, _lockProblem, callback) => callback(await db.getRepository(SubmissionEntity).findOneBy({ id: s.id })) },
    statisticsOutboxService: { record: async () => [], apply: async () => {} }, judgeQueueService: { notifyJobsAvailable() {} },
    submissionStatisticsService: { onSubmissionUpdated: async () => {} }
  });
  const contests = new ContestService(db, access, scores, {
    problemList: id => db.getRepository(ContestProblemEntity).findBy({ contestId: id })
  }, submissions, { deleteFile: async () => () => {} });
  const writer = new ContestSubmissionService(db, access, { getProblemJudgeInfo: async () => [{}, true] },
    { lockProblemById: (_id, _mode, cb) => cb(problem) }, submissions);
  async function contest(rule = "acm") {
    const entry = await db.manager.save(ContestEntity, {
      title: "Replay", subtitle: "", description: "", ownerId: admin.id, rule, languages: ["cpp:c++17"], adminIds: [],
      startTime: new Date(base - 300 * SECOND), endTime: new Date(base), isPublic: true, createdAt: new Date(base)
    });
    const slot = await db.manager.save(ContestProblemEntity, {
      contestId: entry.id, problemId: problem.id, title: "A", position: 1, weight: 1, attachments: []
    });
    return { entry, slot };
  }

  await t.test("concurrent starts produce exactly one stored, audited run; user and contest deletions cascade", async () => {
    const { entry } = await contest();
    const actor = await user(), other = await user();
    wallNow = base + 1200 * SECOND;
    const starts = await Promise.allSettled(Array.from({ length: 5 }, () => contests.startVirtual(actor, entry.id)));
    assert.equal(starts.filter(s => s.status === "fulfilled").length, 1);
    for (const rejected of starts.filter(s => s.status === "rejected"))
      assert.equal(rejected.reason.getResponse().error, "VIRTUAL_ALREADY_USED");
    const rows = await db.getRepository(Run).findBy({ contestId: entry.id });
    assert.equal(rows.length, 1);
    assert.equal(+rows[0].startTime, wallNow);
    assert.equal(+rows[0].endTime - +rows[0].startTime, +entry.endTime - +entry.startTime);
    assert.equal(await db.getRepository(AuditLogEntity).countBy({ userId: actor.id, action: "contest.start_virtual" }), 1);
    await contests.startVirtual(other, entry.id);
    await db.manager.delete(UserEntity, actor.id);
    assert.equal(await db.getRepository(Run).countBy({ contestId: entry.id }), 1);
    await db.manager.delete(ContestEntity, entry.id);
    assert.equal(await db.getRepository(Run).countBy({ userId: other.id }), 0);
  });

  await t.test("an admitted official submission racing the cutoff disqualifies its user on commit", async () => {
    const { entry, slot } = await contest();
    const actor = await user();
    wallNow = +entry.endTime - 1;
    const [created] = await interleave(db, SubmissionEntity, "user",
      () => writer.submit(actor, entry.id, slot.id, { content }),
      () => {
        wallNow = +entry.endTime;
        return assert.rejects(contests.startVirtual(actor, entry.id), errorCode("VIRTUAL_PARTICIPATED"));
      });
    const stored = await db.getRepository(SubmissionEntity).findOneByOrFail({ id: created.submissionId });
    assert.equal(+stored.submitTime, +entry.endTime - SECOND);
    assert.equal(await db.getRepository(Run).countBy({ contestId: entry.id }), 0);
    await submissions.deleteSubmission(stored);
    await contests.startVirtual(actor, entry.id);
    assert.equal(await db.getRepository(Run).countBy({ contestId: entry.id }), 1, "the last official submission was permanently deleted");
  });

  await t.test("start uses current permissions even when the request already cached a grant", async () => {
    const { entry } = await contest();
    const actor = await user();
    wallNow = +entry.endTime;
    await requestContext.run({ res: { writableEnded: false } }, async () => {
      assert.equal((await contests.detail(actor, entry.id)).virtualParticipation.canStart, true);
      await db.manager.save(UserPermissionRuleEntity, { userId: actor.id, permission: "ParticipateContest", allowed: false });
      await assert.rejects(contests.startVirtual(actor, entry.id), errorCode("VIRTUAL_NO_PERMISSION"));
    });
    assert.equal(await db.getRepository(Run).countBy({ contestId: entry.id }), 0);
  });

  await t.test("a schedule edit racing a start observes the run; other edits still succeed", async () => {
    const start = base - 300 * SECOND;
    const original = { title: "Timed contest", rule: "acm", startTime: new Date(start + 987).toISOString(),
      endTime: new Date(base + 543).toISOString(), adminIds: [], languages: ["cpp:c++17"], isPublic: true };
    const { id } = await contests.save(admin, undefined, original);
    wallNow = base + 10 * SECOND;
    const actor = await user();
    const edit = { ...original, endTime: new Date(base + 543 + SECOND).toISOString() };
    await interleave(db, Run, "contest", () => contests.startVirtual(actor, id),
      () => assert.rejects(contests.save(admin, id, edit), errorCode("VIRTUAL_RUNS_EXIST")));
    await contests.save(admin, id, { ...original, title: "New title" });
    const saved = await db.getRepository(ContestEntity).findOneByOrFail({ id });
    assert.equal(saved.title, "New title");
    assert.equal(+saved.startTime, start);
    assert.equal(+saved.endTime, base);
  });

  await t.test("deleting an ended contest waits for an admitted virtual submission and cleans its rows", async () => {
    const { entry, slot } = await contest();
    const actor = await user();
    wallNow = +entry.endTime + 30 * SECOND;
    await contests.startVirtual(actor, entry.id);
    const [{ submissionId }] = await interleave(db, SubmissionEntity, "contest",
      () => writer.submit(actor, entry.id, slot.id, { content }), () => contests.delete(admin, entry.id));
    assert.equal(await db.getRepository(ContestEntity).existsBy({ id: entry.id }), false);
    assert.equal(await db.getRepository(Run).existsBy({ contestId: entry.id }), false);
    assert.equal(await db.getRepository(SubmissionEntity).existsBy({ contestId: entry.id }), false);
    assert.equal(await db.getRepository(SubmissionDetailEntity).existsBy({ submissionId }), false);
  });

  await t.test("the first virtual submission closes rule edits at commit", async () => {
    const { entry, slot } = await contest();
    const actor = await user();
    wallNow = +entry.endTime + 30 * SECOND;
    await contests.startVirtual(actor, entry.id);
    const edit = { title: entry.title, rule: "noi", startTime: entry.startTime.toISOString(),
      endTime: entry.endTime.toISOString(), adminIds: [], languages: ["cpp:c++17"], isPublic: true };
    await interleave(db, SubmissionEntity, "contest", () => writer.submit(actor, entry.id, slot.id, { content }),
      () => assert.rejects(contests.save(admin, entry.id, edit), /Cannot change rule after submissions/));
    assert.equal((await db.manager.findOneByOrFail(ContestEntity, { id: entry.id })).rule, entry.rule);
  });

  await t.test("list totals, detail, statistics and standings apply the same exact elapsed cutoff", async () => {
    const { entry, slot } = await contest();
    const official = await user(), other = await user(), viewer = await user();
    const otherStart = base + 200 * SECOND, viewerStart = base + 1000 * SECOND;
    const insert = async (actor, when, status) => {
      const s = await db.manager.save(SubmissionEntity, { contestId: entry.id, contestProblemId: slot.id,
        problemId: problem.id, isPublic: false, submitterId: actor.id, submitTime: new Date(when), codeLanguage: "cpp",
        status, score: status === "Accepted" ? 100 : 0 });
      await db.manager.save(SubmissionDetailEntity, { submissionId: s.id, content, result: { subtasks: [], testcaseResult: {} } });
      return s.id;
    };
    const officialNow = await insert(official, +entry.startTime + 5 * SECOND, "WrongAnswer");
    const officialFuture = await insert(official, +entry.startTime + 6 * SECOND, "Accepted");
    wallNow = otherStart;
    await contests.startVirtual(other, entry.id);
    const virtualNow = await insert(other, otherStart + 5 * SECOND, "WrongAnswer");
    const virtualFuture = await insert(other, otherStart + 6 * SECOND, "Accepted");
    wallNow = viewerStart;
    await contests.startVirtual(viewer, entry.id);
    const own = await insert(viewer, viewerStart, "Accepted");
    wallNow = viewerStart + 5 * SECOND + 999;
    const page = await writer.submissionList(viewer, entry.id);
    assert.equal(page.total, 3);
    assert.deepEqual(page.submissions.map(s => s.id), [own, virtualNow, officialNow]);
    assert.equal((await writer.submissionList(viewer, entry.id, 1, { userId: other.id })).total, 1);
    for (const id of [officialFuture, virtualFuture])
      await assert.rejects(writer.submissionDetail(viewer, entry.id, id), error => error.getStatus() === 404);
    assert.equal((await writer.submissionDetail(viewer, entry.id, virtualNow)).submission.status, "WrongAnswer");
    const detail = await contests.detail(viewer, entry.id);
    assert.equal(detail.problemStats[slot.id].attempted, 3);
    assert.equal(detail.problemStats[slot.id].accepted, 1);
    const replay = await contests.ranklist(viewer, entry.id);
    assert.deepEqual(replay.rows.map(r => [r.userId, r.score, !!r.virtual]), [
      [viewer.id, 1, true], [official.id, 0, false], [other.id, 0, true]
    ]);
    wallNow++;
    assert.equal((await writer.submissionList(viewer, entry.id)).total, 5);
    assert.equal((await contests.detail(viewer, entry.id)).problemStats[slot.id].accepted, 3);
    const ended = await contests.ranklist(admin, entry.id);
    assert.deepEqual(ended.rows.map(r => r.userId), [official.id]);
    assert.equal((await contests.ranklist(admin, entry.id, true)).rows.length, 3);
  });
});
