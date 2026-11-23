// The two operations use the public service methods on independent MariaDB connections.
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { Readable } = require("node:stream");
const test = require("node:test");
require("../redis/register-typescript.cjs");
require("@nestjs/common").Logger.overrideLogger(false);
const { DataSource } = require("typeorm");
const { startRedis } = require("../../test/temporary-redis.cjs");
const { UserEntity } = require("../user/user.entity.ts");
const { UserAuthEntity } = require("../auth/user-auth.entity.ts");
const { UserPermissionRuleEntity } = require("../access/user-permission-rule.entity.ts");
const { UserPrivilegeEntity } = require("../user/user-privilege.entity.ts");
const { UserPrivilegeService } = require("../user/user-privilege.service.ts");
const { TeamResourceEntity } = require("../team/team.entity.ts");
const { AuditLogEntity } = require("../audit/audit-log.entity.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts");
const { ProblemSampleEntity } = require("../problem/problem-sample.entity.ts");
const { ProblemJudgeInfoEntity } = require("../problem/problem-judge-info.entity.ts");
const { ProblemAccessService } = require("../problem/problem-access.service.ts");
const { ProblemLockService } = require("../problem/problem-lock.service.ts");
const { LockService } = require("../redis/lock.service.ts");
const { LockLeaseSubscriber } = require("../redis/lock-lease.subscriber.ts");
const { RedisService } = require("../redis/redis.service.ts");
const { CodeLanguageService } = require("../code-language/code-language.service.ts");
const { ProblemTypeTraditionalService } = require("../problem-type/types/traditional/problem-type.service.ts");
const { ProblemTypeSubmitAnswerService } = require("../problem-type/types/submit-answer/problem-type.service.ts");
const { FileEntity } = require("../file/file.entity.ts");
const { FileService, stagingObject } = require("../file/file.service.ts");
const { JudgeJobEntity } = require("../judge/judge-job.entity.ts");
const { JudgeQueueService } = require("../judge/judge-queue.service.ts");
const { MetricsService } = require("../metrics/metrics.service.ts");
const { SubmissionEntity } = require("../submission/submission.entity.ts");
const { SubmissionDetailEntity } = require("../submission/submission-detail.entity.ts");
const { SubmissionService } = require("../submission/submission.service.ts");
const { SubmissionJudgingService } = require("../submission/submission-judging.service.ts");
const { StatisticsOutboxEntity } = require("../submission/statistics-outbox.entity.ts");
const { StatisticsOutboxService } = require("../submission/statistics-outbox.service.ts");
const { ContestScoreRevisionService } = require("../submission/contest-score-revision.service.ts");
const { ContestEntity } = require("./contest.entity.ts");
const { ContestProblemEntity } = require("./contest-problem.entity.ts");
const { ContestVirtualParticipationEntity: Run } = require("./contest-virtual-participation.entity.ts");
const { ContestAccessService } = require("./contest-access.service.ts");
const { ContestProblemService } = require("./contest-problem.service.ts");
const { ContestSubmissionService } = require("./contest-submission.service.ts");
const { ContestService } = require("./contest.service.ts");
const { isVirtualContestSubmission } = require("./contest-virtual-timeline.ts");

const configPath = process.env.LLMOJ_CONTEST_ADMISSION_TEST_DB_CONFIG;
const entities = [UserEntity, UserAuthEntity, UserPermissionRuleEntity, UserPrivilegeEntity, TeamResourceEntity,
  AuditLogEntity, ProblemEntity, ProblemSampleEntity, ProblemJudgeInfoEntity, FileEntity, SubmissionEntity,
  SubmissionDetailEntity, JudgeJobEntity, StatisticsOutboxEntity, ContestEntity, ContestProblemEntity, Run];
const original = { inputFilename: "first.in", outputFilename: "first.out", subtaskAllOrNothing: false };
const edited = { inputFilename: "revised.in", outputFilename: "revised.out", subtaskAllOrNothing: true };
const code = { language: "cpp", code: "int main(){}", compileAndRunOptions: { compiler: "g++", std: "c++17", O: "0", m: "64" } };
const bytes = Buffer.from("42\n");
const hash = (data, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");
const denied = (status, message) => error => error.getStatus() === status && (!message || error.message === message);

async function openDatabase(t) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")).services.database;
  assert.equal(cfg.database, "llmoj_test_contest_admission", "Use the dedicated, empty admission database");
  const db = await new DataSource({ ...cfg, entities, subscribers: [LockLeaseSubscriber], synchronize: false,
    dropSchema: false, migrationsRun: false, logging: false }).initialize();
  let ownsFixture = false;
  t.after(async () => {
    try {
      if (ownsFixture) {
        const runner = db.createQueryRunner();
        try {
          await runner.query("SET FOREIGN_KEY_CHECKS=0");
          for (const entity of entities)
            await runner.query("DROP TABLE IF EXISTS " + db.driver.escape(db.getMetadata(entity).tableName));
        } finally {
          await runner.query("SET FOREIGN_KEY_CHECKS=1");
          await runner.release();
        }
      }
    } finally { await db.destroy(); }
  });
  assert.deepEqual(await db.query("SHOW TABLES"), [], "Refusing to alter a nonempty database");
  ownsFixture = true;
  await db.synchronize();
  return db;
}

// Substitute only the object store. FileService copies, checks the size, hashes, registers in MariaDB and cleans up.
function fileStorage(db) {
  const objects = new Map();
  const files = Object.assign(Object.create(FileService.prototype), {
    fileRepository: db.getRepository(FileEntity), bucket: "answers",
    minioClient: {
      async statObject(_bucket, key) {
        const data = objects.get(key);
        if (!data) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
        return { size: data.length, etag: hash(data, "md5"), lastModified: new Date() };
      },
      async composeObject(dest, [source]) {
        const data = objects.get(source.Object);
        assert.equal(source.MatchETag, hash(data, "md5"));
        objects.set(dest.Object, Buffer.from(data));
      },
      async getObject(_bucket, key) { return Readable.from([objects.get(key)]); },
      async removeObject(_bucket, key) { objects.delete(key); },
      async removeObjects(_bucket, keys) { keys.forEach(key => objects.delete(key)); }
    }
  });
  return { files, objects };
}

async function reached(signal, operation, description) {
  let timer;
  try {
    return await Promise.race([signal, operation.then(() => { throw new Error("Finished before " + description); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out at " + description)), 8000); })]);
  } finally { clearTimeout(timer); }
}

// Pause the winner with all its writes staged. NOWAIT on a third connection proves which rows it actually holds.
// The loser must get through preflight and request its conflicting lock before the winner can commit.
async function race(db, contestId, slotId, admissionFirst, first, second, onContention) {
  const ready = Promise.withResolvers(), release = Promise.withResolvers(), contended = Promise.withResolvers();
  const shared = "LOCK IN SHARE MODE", exclusive = "FOR UPDATE";
  const secondLock = admissionFirst ? exclusive : shared;
  let holder, held, competing;
  const observer = {
    beforeQuery({ query, queryRunner }) {
      if (!query.includes("FROM `contest`")) return;
      if (!holder && query.endsWith(admissionFirst ? shared : exclusive)) holder = queryRunner;
      if (holder && queryRunner !== holder && query.endsWith(secondLock))
        contended.resolve(queryRunner.databaseConnection.threadId);
    },
    async beforeTransactionCommit({ queryRunner }) {
      if (queryRunner === holder && queryRunner.transactionDepth === 1) {
        ready.resolve();
        await release.promise;
      }
    }
  };
  db.subscribers.push(observer);
  try {
    held = first();
    await reached(ready.promise, held, "first transaction's commit");
    for (const [table, id] of [["contest", contestId], ...(admissionFirst ? [["contest_problem", slotId]] : [])]) {
      await assert.rejects(db.transaction("READ COMMITTED", tx =>
        tx.query("SELECT id FROM " + db.driver.escape(table) + " WHERE id = ? FOR UPDATE NOWAIT", [id])),
        error => error.driverError?.errno === 1205, "the first transaction must hold " + table);
    }
    competing = second();
    const waitingId = await reached(contended.promise, competing, "second transaction's contest lock");
    // MariaDB shows the fixture user's own connections without a global PROCESS grant.
    const deadline = performance.now() + 8000;
    while (!(await db.query("SHOW FULL PROCESSLIST")).some(row =>
      Number(row.Id) === Number(waitingId) && String(row.Info).includes("FROM `contest`") && String(row.Info).endsWith(secondLock)
    )) {
      assert.ok(performance.now() < deadline, "MariaDB did not see the competing lock request");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    onContention();
  } finally {
    release.resolve();
    await Promise.allSettled([held, competing]);
    db.subscribers.splice(db.subscribers.indexOf(observer), 1);
  }
  return await Promise.all([held, competing]);
}

test("contest admission and concurrent administration in MariaDB", {
  skip: !configPath && "needs LLMOJ_CONTEST_ADMISSION_TEST_DB_CONFIG", timeout: 120000
}, async t => {
  const db = await openDatabase(t);
  const redis = Object.assign(Object.create(RedisService.prototype), { client: await startRedis(t) });
  const config = { config: { resourceLimit: { submissionFileSize: 8192 },
    preference: { serverSideOnly: { dynamicTaskPriority: false } } } };
  const locks = new LockService(redis);
  const queue = new JudgeQueueService(db, redis, new MetricsService(config));
  t.after(() => { locks.onModuleDestroy(); queue.onModuleDestroy(); });
  const revisions = new ContestScoreRevisionService(db, redis);
  revisions.onModuleInit();
  const outbox = Object.assign(new StatisticsOutboxService(db, redis), { contestScores: revisions });
  const privileges = new UserPrivilegeService(db, db.getRepository(UserPrivilegeEntity));
  const access = new ContestAccessService(db, privileges);
  const contests = new ContestService(db, access);
  const problems = { findProblemById: id => db.manager.findOneBy(ProblemEntity, { id }), getProblemJudgeInfo: async () => [{}, true] };
  const { files, objects } = fileStorage(db);
  const slots = new ContestProblemService(db, access, problems, new ProblemAccessService(db, privileges, null, config), null, files);
  const languages = new CodeLanguageService();
  const types = { Traditional: new ProblemTypeTraditionalService(config, languages), SubmitAnswer: new ProblemTypeSubmitAnswerService(config, languages) };
  const submissions = Object.assign(Object.create(SubmissionService.prototype), {
    connection: db, fileService: files, configService: config, problemTypeFactoryService: { type: name => types[name] },
    judgeQueueService: queue, statisticsOutboxService: outbox,
    submissionJudgingService: Object.assign(Object.create(SubmissionJudgingService.prototype), {
      configService: config, judgeQueueService: queue, problemDataVersionService: { current: async () => null }
    })
  });
  const writer = new ContestSubmissionService(db, access, problems, new ProblemLockService(db.getRepository(ProblemEntity), locks), submissions);
  const base = Math.floor(Date.now() / 1000) * 1000;
  let now = base;
  t.mock.method(Date, "now", () => now);
  const user = (username, isAdmin) => db.manager.save(UserEntity, { username, email: username + "@example.invalid",
    nickname: "", bio: "", avatarInfo: "", isAdmin, acceptedProblemCount: 0, submissionCount: 0, rating: 0, publicEmail: false });
  const admin = await user("organizer", true), player = await user("entrant", false);
  async function counts() {
    const [submissions, details, jobs, outbox, files] = await Promise.all(
      [SubmissionEntity, SubmissionDetailEntity, JudgeJobEntity, StatisticsOutboxEntity, FileEntity].map(entity => db.manager.count(entity))
    );
    return { submissions, details, jobs, outbox, files };
  }

  async function fixture(virtual, answer) {
    now = base + 321;
    const problem = await db.manager.save(ProblemEntity, { type: answer ? "SubmitAnswer" : "Traditional",
      ownerId: admin.id, isPublic: false, locales: ["en_US"], submissionCount: 0, acceptedSubmissionCount: 0 });
    const settings = { title: "Timing", rule: "acm", isPublic: true, adminIds: [], languages: ["cpp:c++17", "cpp:c++20"],
      startTime: new Date(base - (virtual ? 180000 : 60000)).toISOString(),
      endTime: new Date(base + (virtual ? -60000 : 60000)).toISOString() };
    const { id } = await contests.save(admin, undefined, settings);
    const slotSettings = { position: 1, weight: 100, problemId: problem.id };
    const { id: slotId } = await slots.saveProblem(admin, id, { ...slotSettings, ...original });
    const finish = virtual ? +(await contests.startVirtual(player, id)).run.endTime : Date.parse(settings.endTime);
    const upload = answer ? { uuid: randomUUID(), size: bytes.length } : undefined;
    if (answer) objects.set(stagingObject(upload.uuid), bytes);
    return { id, slotId, settings, slotSettings, upload, finish,
      submit: (slot = slotId) => writer.submit(player, id, slot, { content: answer ? {} : code, uploadInfo: upload }) };
  }

  async function checkSubmission(f, slotId, response, metadata, at, virtual) {
    const s = await db.manager.findOneByOrFail(SubmissionEntity, { id: response.submissionId });
    assert.deepEqual([s.contestId, s.contestProblemId, s.problemId, s.submitterId, s.isPublic],
      [f.id, slotId, f.slotSettings.problemId, player.id, false]);
    assert.deepEqual([s.contestInputFilename, s.contestOutputFilename, s.contestSubtaskAllOrNothing],
      [metadata.inputFilename, metadata.outputFilename, metadata.subtaskAllOrNothing]);
    assert.equal(+s.submitTime, Math.floor(at / 1000) * 1000);
    assert.equal(await isVirtualContestSubmission(db.manager, s), virtual);
    const detail = await db.manager.findOneByOrFail(SubmissionDetailEntity, { submissionId: s.id });
    assert.deepEqual(detail.content, f.upload ? {} : code);
    const job = await db.manager.findOneByOrFail(JudgeJobEntity, { taskId: s.taskId });
    assert.deepEqual([job.type, job.state], ["Submission", "Queued"]);
    if (f.upload) {
      const file = await db.manager.findOneByOrFail(FileEntity, { uploadUuid: f.upload.uuid });
      assert.equal(file.uuid, detail.fileUuid);
      assert.equal(file.sha256, hash(bytes));
      assert.deepEqual(objects.get(file.uuid), bytes);
      assert.ok(!objects.has(stagingObject(f.upload.uuid)));
    } else assert.equal(s.codeLanguage, code.language);
  }

  for (const virtual of [false, true]) {
    const path = virtual ? "virtual" : "official";
    for (const mutation of ["remove", "language", "slot settings"]) {
      for (const admissionFirst of [false, true]) {
        await t.test(path + ": " + (admissionFirst ? "admit before " + mutation : mutation + " before admission"), async () => {
          const f = await fixture(virtual, mutation === "remove");
          const initialTime = now, before = await counts(), keys = [...objects.keys()];
          const remove = () => slots.removeProblem(admin, f.id, f.slotId);
          const changes = {
            remove: admissionFirst ? () => assert.rejects(remove(), denied(400, "Problem already has contest submissions")) : remove,
            language: () => contests.save(admin, f.id, { ...f.settings, languages: ["cpp:c++20"] }),
            "slot settings": () => slots.saveProblem(admin, f.id, { ...f.slotSettings, ...edited })
          };
          const accepted = admissionFirst || mutation === "slot settings";
          const submit = accepted ? f.submit : () => assert.rejects(f.submit(), mutation === "remove"
            ? denied(404) : denied(403, "Language is not allowed in this contest"));
          const operations = admissionFirst ? [submit, changes[mutation]] : [changes[mutation], submit];
          const results = await race(db, f.id, f.slotId, admissionFirst, ...operations, () => { now += 2000; });
          const slot = await db.manager.findOneBy(ContestProblemEntity, { id: f.slotId, contestId: f.id });
          assert.equal(slot === null, mutation === "remove" && !admissionFirst);
          if (mutation === "slot settings") {
            for (const [key, value] of Object.entries(edited)) assert.equal(slot[key], value);
          }
          if (mutation === "language") assert.deepEqual((await db.manager.findOneByOrFail(ContestEntity, { id: f.id })).languages, ["cpp:c++20"]);
          if (accepted) {
            await checkSubmission(f, f.slotId, results[admissionFirst ? 0 : 1], admissionFirst ? original : edited,
              admissionFirst ? initialTime : now, virtual);
            assert.deepEqual(await counts(), {
              submissions: before.submissions + 1, details: before.details + 1, jobs: before.jobs + 1,
              outbox: before.outbox, files: before.files + Number(!!f.upload)
            });
            assert.equal(await revisions.revision(f.id, virtual), "1");
            assert.equal(await revisions.revision(f.id, !virtual), "0");
          } else {
            assert.deepEqual(await counts(), before, "no submission, detail, judge job, statistics record or registered file");
            assert.equal(await revisions.revision(f.id, virtual), "0");
            assert.equal(await revisions.revision(f.id, !virtual), "0");
            assert.deepEqual([...objects.keys()], keys, "no staging loss or leaked sealed copy");
            if (f.upload) {
              assert.deepEqual(objects.get(stagingObject(f.upload.uuid)), bytes);
              const added = await slots.saveProblem(admin, f.id, { ...f.slotSettings, ...original });
              assert.notEqual(added.id, f.slotId);
              await checkSubmission(f, added.id, await f.submit(added.id), original, now, virtual);
            }
          }
        });
      }
    }

    await t.test(path + " answer retains its pre-seal time across the exact deadline", async t => {
      const f = await fixture(virtual, true);
      now = f.finish - 1;
      const hashStoredObject = files.hashStoredObject.bind(files);
      t.mock.method(files, "hashStoredObject", async key => {
        // Another connection can lock all admission rows while the object is being read.
        await db.transaction("READ COMMITTED", async tx => {
          for (const [table, id] of [["user", player.id], ["contest", f.id], ["contest_problem", f.slotId]])
            await tx.query("SELECT id FROM " + db.driver.escape(table) + " WHERE id = ? FOR UPDATE NOWAIT", [id]);
        });
        now = f.finish;
        return await hashStoredObject(key);
      });
      await checkSubmission(f, f.slotId, await f.submit(), original, f.finish - 1, virtual);
    });
  }

  await t.test("a virtual start committed during sealing precludes a backdated official submission", async t => {
    const f = await fixture(false, true);
    const before = await counts(), keys = [...objects.keys()];
    now = f.finish - 1;
    const hashStoredObject = files.hashStoredObject.bind(files);
    t.mock.method(files, "hashStoredObject", async key => {
      now = f.finish;
      await contests.startVirtual(player, f.id);
      return await hashStoredObject(key);
    });
    await assert.rejects(f.submit(), denied(403, "Contest has ended"));
    assert.equal(await db.manager.countBy(Run, { userId: player.id, contestId: f.id }), 1);
    assert.deepEqual(await counts(), before);
    assert.deepEqual([...objects.keys()], keys);
    assert.deepEqual(objects.get(stagingObject(f.upload.uuid)), bytes);
  });

  await t.test("rolling back after file registration and enqueue keeps the original answer usable", async t => {
    const f = await fixture(false, true);
    const before = await counts(), keys = [...objects.keys()];
    const failure = t.mock.method(outbox, "record", async () => { throw new Error("interrupted before commit"); });
    await assert.rejects(f.submit(), /interrupted before commit/);
    assert.deepEqual(await counts(), before);
    assert.deepEqual([...objects.keys()], keys);
    assert.deepEqual(objects.get(stagingObject(f.upload.uuid)), bytes);
    failure.mock.restore();
    await checkSubmission(f, f.slotId, await f.submit(), original, now, false);
  });

  await t.test("slot settings preserve attachments and an omitted scoring flag", async () => {
    const f = await fixture(false, false);
    const upload = { uuid: randomUUID(), size: bytes.length };
    objects.set(stagingObject(upload.uuid), bytes);
    const attach = uploadInfo => slots.attachment(admin, f.id, f.slotId, { filename: "rules.txt", uploadInfo });
    assert.deepEqual(await attach(upload), {});
    const file = await db.manager.findOneByOrFail(FileEntity, { uploadUuid: upload.uuid });
    assert.deepEqual(objects.get(file.uuid), bytes);
    await slots.saveProblem(admin, f.id, { ...f.slotSettings, ...edited });
    await slots.saveProblem(admin, f.id, { ...f.slotSettings, title: "Renamed" });
    const slot = await db.manager.findOneByOrFail(ContestProblemEntity, { id: f.slotId });
    assert.equal(slot.subtaskAllOrNothing, true);
    assert.deepEqual(slot.attachments, [{ filename: "rules.txt", uuid: file.uuid, size: bytes.length }]);
    const another = { uuid: randomUUID(), size: bytes.length };
    objects.set(stagingObject(another.uuid), bytes);
    const before = await counts(), keys = [...objects.keys()];
    await assert.rejects(attach(another), denied(400, "Duplicate attachment or too many attachments"));
    assert.deepEqual(await counts(), before);
    assert.deepEqual([...objects.keys()], keys);
  });
});
