/* Reproducible judging on a disposable MariaDB database (tables created from the real entities; never a production
 * database): problem data versions, deferred deletion of removed test data and how long it's retained, results kept
 * by rejudges, and counts that change exactly with the submissions, also under concurrency and while being rebuilt. */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
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
String.prototype.format ||= function (...args) {
  return require("node:util").format(this, ...args);
};
require("@nestjs/common").Logger.overrideLogger(false);
const { DataSource, In } = require("typeorm");
const { SubmissionService } = require("./submission.service.ts");
const { SubmissionJudgingService } = require("./submission-judging.service.ts");
const { SubmissionAccessService } = require("./submission-access.service.ts");
const { SubmissionEntity } = require("./submission.entity.ts");
const { SubmissionDetailEntity } = require("./submission-detail.entity.ts");
const { SubmissionResultHistoryEntity } = require("./submission-result-history.entity.ts");
const { StatisticsOutboxEntity } = require("./statistics-outbox.entity.ts");
const { StatisticsOutboxService } = require("./statistics-outbox.service.ts");
const { ProblemDataVersionService, canonicalJson } = require("../problem/problem-data-version.service.ts");
const { ProblemDataVersionEntity } = require("../problem/problem-data-version.entity.ts");
const { DeferredFileDeletionEntity } = require("../problem/deferred-file-deletion.entity.ts");
const { ProblemService } = require("../problem/problem.service.ts");
const { bareProblemServices } = require("../problem/problem-test-services.cjs");
const { ProblemFileEntity, ProblemFileType } = require("../problem/problem-file.entity.ts");
const { ProblemSampleEntity } = require("../problem/problem-sample.entity.ts");
const { ProblemJudgeInfoEntity } = require("../problem/problem-judge-info.entity.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts");
const { FileEntity } = require("../file/file.entity.ts");
const { FileService } = require("../file/file.service.ts");
const { UserEntity } = require("../user/user.entity.ts");
const { UserAuthEntity } = require("../auth/user-auth.entity.ts");
const { ContestEntity } = require("../contest/contest.entity.ts");
const { HackEntity } = require("../hack/hack.entity.ts");
const { SelfEvalEntity, SelfEvalSetEntity } = require("../self-eval/self-eval.entity.ts");
const { SettingsEntity } = require("../settings/settings.entity.ts");
const { TestDataRetentionPolicyService } = require("../settings/test-data-retention-policy.service.ts");
const { ProblemDataVersionKeepEntity } = require("../problem/problem-data-version-keep.entity.ts");
const { TestDataRetentionService } = require("../problem/test-data-retention.service.ts");

const configPath = process.env.LLMOJ_DATA_VERSION_TEST_DB_CONFIG;
const plain = value => JSON.parse(JSON.stringify(value));
const finished = (status, score = status === "Accepted" ? 100 : 0) => ({
  progressType: "Finished",
  status,
  score,
  totalOccupiedTime: 10
});
const code = { language: "cpp", code: "int main() {}", compileAndRunOptions: {} };

test("data versions are content-addressed with sorted keys", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }], e: undefined }), '{"a":[{"c":2,"d":1}],"b":1}');
  assert.equal(canonicalJson(null), "null");
});

test(
  "reproducible judging (real MariaDB)",
  { skip: !configPath && "needs LLMOJ_DATA_VERSION_TEST_DB_CONFIG", timeout: 180000 },
  async t => {
    const config = require("js-yaml").load(fs.readFileSync(configPath, "utf8")).services.database;
    const ds = new DataSource({
      ...config,
      entities: [
        UserEntity,
        UserAuthEntity,
        ProblemEntity,
        ProblemSampleEntity,
        ProblemJudgeInfoEntity,
        ProblemFileEntity,
        FileEntity,
        SubmissionEntity,
        SubmissionDetailEntity,
        SubmissionResultHistoryEntity,
        ProblemDataVersionEntity,
        DeferredFileDeletionEntity,
        StatisticsOutboxEntity,
        ContestEntity,
        ProblemDataVersionKeepEntity,
        HackEntity,
        SelfEvalEntity,
        SelfEvalSetEntity,
        SettingsEntity
      ],
      dropSchema: true,
      synchronize: true,
      logging: false
    });
    await ds.initialize();
    t.after(async () => {
      await ds.dropDatabase();
      await ds.destroy();
    });

    // In-process stand-ins for the Redis lock and the problem's preprocessed judge info and samples
    const tails = new Map();
    const locks = {
      async lock(key, callback) {
        const previous = tails.get(key) || Promise.resolve();
        let release;
        const gate = new Promise(done => (release = done));
        const tail = previous.then(() => gate);
        tails.set(key, tail);
        await previous;
        try {
          return await callback();
        } finally {
          release();
          if (tails.get(key) === tail) tails.delete(key);
        }
      }
    };
    const content = new Map();
    const problems = ds.getRepository(ProblemEntity);
    const problemService = {
      getProblemPreprocessedJudgeInfo: async problem => [structuredClone(content.get(problem.id).judgeInfo), true],
      getProblemFiles: async (problem, type) =>
        await ds.getRepository(ProblemFileEntity).findBy({ problemId: problem.id, type }),
      getProblemSamples: async problem => structuredClone(content.get(problem.id).samples),
      findProblemById: async id => await problems.findOneBy({ id }),
      lockProblemById: async (id, _type, callback) => await callback(await problems.findOneBy({ id }))
    };
    const removedObjects = [];
    const fileService = {
      async deleteFile(uuids, manager) {
        const list = [].concat(uuids);
        if (list.length) await manager.delete(FileEntity, { uuid: In(list) });
        return () => removedObjects.push(...list);
      },
      signDownloadLink: async () => "signed",
      getContentHashes: uuids =>
        FileService.prototype.getContentHashes.call({ fileRepository: ds.getRepository(FileEntity) }, uuids)
    };
    const configService = {
      config: {
        preference: { serverSideOnly: { dynamicTaskPriority: false } },
        resourceLimit: { problemSamplesToRun: 2, submissionFileSize: 1 }
      }
    };
    const versions = Object.create(ProblemDataVersionService.prototype);
    Object.assign(versions, {
      connection: ds,
      problemDataVersionRepository: ds.getRepository(ProblemDataVersionEntity),
      problemService,
      fileService,
      configService,
      redisService: { takeTurn: async () => true }
    });
    versions.problemAccess =
      versions.problemFiles =
      versions.problemTags =
      versions.problemLocks =
        versions.problemService;
    const retention = Object.assign(Object.create(TestDataRetentionService.prototype), {
      connection: ds,
      fileService,
      redisService: { takeTurn: async () => true },
      policyService: Object.assign(Object.create(TestDataRetentionPolicyService.prototype), { connection: ds })
    });
    const setPolicy = async policy =>
      await ds.query("REPLACE INTO settings (`key`, value) VALUES ('test-data-retention', ?)", [JSON.stringify(policy)]);
    // The priority each judge task was queued with
    const queued = new Map();
    const outbox = Object.assign(Object.create(StatisticsOutboxService.prototype), { connection: ds });
    const svc = Object.create(SubmissionService.prototype);
    Object.assign(svc, {
      connection: ds,
      submissionRepository: ds.getRepository(SubmissionEntity),
      submissionDetailRepository: ds.getRepository(SubmissionDetailEntity),
      problemService,
      problemDataVersionService: versions,
      testDataRetentionService: retention,
      statisticsOutboxService: outbox,
      lockService: locks,
      submissionStatisticsService: { onSubmissionUpdated: async () => {} },
      judgeGateway: { cancelTask() {} },
      judgeQueueService: {
        enqueue: async (taskId, type, priority) => queued.set(taskId, priority),
        notifyJobsAvailable() {}
      },
      submissionProgressService: { emitSubmissionEvent: async () => {} },
      auditService: { log: async () => {} },
      configService,
      fileService,
      metricSubmissionJudgeTime: { observe() {} },
      problemTypeFactoryService: {
        type: () => ({
          shouldUploadAnswerFile: () => false,
          getCodeLanguageAndAnswerSizeFromSubmissionContentAndFile: async () => ({ language: "cpp", answerSize: 13 }),
          getTimeAndMemoryUsedFromFinishedSubmissionProgress: () => ({ timeUsed: 4, memoryUsed: 8 })
        })
      }
    });
    svc.problemAccess = svc.problemFiles = svc.problemTags = svc.problemLocks = svc.problemService;

    // The judging half and the permission rules of the submission service, with the same collaborators
    const judging = Object.assign(Object.create(SubmissionJudgingService.prototype), svc);
    const access = Object.assign(Object.create(SubmissionAccessService.prototype), svc);
    judging.submissionAccessService = access;
    svc.submissionJudgingService = judging;
    const admin = { id: 1, isAdmin: true };

    let nextId = 1;
    async function user() {
      const id = nextId++;
      await ds.query(
        "INSERT INTO user (id, username, email, nickname, bio, avatarInfo, isAdmin, acceptedProblemCount, submissionCount, rating, publicEmail) VALUES (?, ?, ?, '', '', '', 0, 0, 0, 1500, 0)",
        [id, `u${id}`, `u${id}@example.invalid`]
      );
      return { id };
    }
    const owner = await user();
    async function file(problemId, filename, type = ProblemFileType.TestData) {
      const uuid = crypto.randomUUID();
      await ds.getRepository(FileEntity).insert({ uuid, size: 3, uploadTime: new Date() });
      await ds.getRepository(ProblemFileEntity).save({ problemId, type, filename, uuid });
      return uuid;
    }
    async function problem(judgeInfo = { timeLimit: 1000, runSamples: false }) {
      const id = nextId++;
      await ds.query(
        "INSERT INTO problem (id, type, isPublic, ownerId, locales, submissionCount, acceptedSubmissionCount) VALUES (?, 'Traditional', 1, ?, '[\"en_US\"]', 0, 0)",
        [id, owner.id]
      );
      content.set(id, { judgeInfo, samples: [] });
      return await problems.findOneBy({ id });
    }
    const submit = async (submitter, p, contest) => (await svc.createSubmission(submitter, p, code, null, contest))[1];
    const load = async id => await ds.getRepository(SubmissionEntity).findOneBy({ id });
    const finish = async (id, status, judgeRuntimeId) =>
      assert.equal(
        await judging.onTaskProgress(
          (await load(id)).taskId,
          finished(status),
          judgeRuntimeId === undefined ? undefined : { judgeRuntimeId, confirm: async () => true }
        ),
        true
      );
    const counts = async (p, u) => [
      plain(await ds.query("SELECT submissionCount, acceptedSubmissionCount FROM problem WHERE id = ?", [p.id]))[0],
      plain(await ds.query("SELECT submissionCount, acceptedProblemCount FROM user WHERE id = ?", [u.id]))[0]
    ];

    await t.test(
      "equal content shares a version; edits make the next one; concurrent submitters create one",
      async () => {
        const p = await problem();
        const first = await versions.current(p);
        assert.equal(first.version, 1);
        assert.equal((await versions.current(p)).id, first.id);
        content.get(p.id).judgeInfo = { runSamples: false, timeLimit: 1000 };
        assert.equal((await versions.current(p)).id, first.id, "the order of keys doesn't matter");
        content.get(p.id).judgeInfo.timeLimit = 2000;
        assert.equal((await versions.current(p)).version, 2);
        content.get(p.id).judgeInfo.timeLimit = 1000;
        assert.equal((await versions.current(p)).id, first.id, "reverting reuses the earlier version");
        await file(p.id, "1.in");
        assert.equal((await versions.current(p)).version, 3);
        content.get(p.id).judgeInfo.timeLimit = 3000;
        const concurrent = await Promise.all(Array.from({ length: 8 }, () => versions.current(p)));
        assert.equal(new Set(concurrent.map(version => version.id)).size, 1);
        assert.deepEqual(
          (await ds.getRepository(ProblemDataVersionEntity).findBy({ problemId: p.id }))
            .map(version => version.version)
            .sort(),
          [1, 2, 3, 4]
        );
      }
    );

    await t.test(
      "a submission is judged with the data it was submitted with; a rejudge uses the current data",
      async () => {
        const submitter = await user();
        const p = await problem({
          timeLimit: 1000,
          runSamples: true,
          subtasks: [{ scoringType: "Sum", testcases: [] }]
        });
        content.get(p.id).samples = [{ inputData: "1" }, { inputData: "2" }, { inputData: "3" }];
        const before = await file(p.id, "1.in");
        const s = await submit(submitter, p);
        assert.ok(s.problemDataVersionId);

        // The problem changes while the submission waits
        content.get(p.id).judgeInfo.timeLimit = 2000;
        content.get(p.id).samples = [{ inputData: "changed" }];
        const after = crypto.randomUUID();
        await ds.getRepository(FileEntity).insert({ uuid: after, size: 3, uploadTime: new Date() });
        await ds.getRepository(ProblemFileEntity).update({ problemId: p.id, filename: "1.in" }, { uuid: after });

        let task = (await judging.getTaskToBeSentToJudgeByTaskId(s.taskId, 1)).extraInfo;
        assert.equal(task.judgeInfo.timeLimit, 1000);
        assert.deepEqual(plain(task.testData), { "1.in": before });
        assert.deepEqual(
          plain(task.samples),
          [{ inputData: "1" }, { inputData: "2" }],
          "the samples it ran, as many as configured"
        );
        await finish(s.id, "Accepted");

        await judging.rejudgeSubmission(await load(s.id), admin);
        const rejudged = await load(s.id);
        task = (await judging.getTaskToBeSentToJudgeByTaskId(rejudged.taskId, 1)).extraInfo;
        assert.equal(task.judgeInfo.timeLimit, 2000);
        assert.deepEqual(plain(task.testData), { "1.in": after });
        assert.deepEqual(plain(await svc.getSubmissionDataVersion(rejudged, p)), {
          version: 2,
          current: true,
          testData: { state: "InUse" }
        });
        content.get(p.id).judgeInfo.timeLimit = 3000;
        assert.deepEqual(plain(await svc.getSubmissionDataVersion(rejudged, p)), {
          version: 2,
          current: false,
          testData: { state: "InUse" }
        });

        // Contest settings still apply on top of the pinned judge info; contest submissions aren't counted. A submission
        // to a contest that hasn't ended is judged before practice (the live contest class, below 0.5).
        await ds.getRepository(ContestEntity).save({
          id: 5,
          title: "Running",
          subtitle: "",
          description: "",
          rule: "ACM",
          startTime: new Date(Date.now() - 3600000),
          endTime: new Date(Date.now() + 3600000),
          ownerId: submitter.id,
          adminIds: [],
          languages: [],
          createdAt: new Date()
        });
        const [problemCounts, userCounts] = await counts(p, submitter);
        const contest = await submit(submitter, p, {
          contestId: 5,
          contestProblemId: 1,
          contestInputFilename: "a.in",
          contestOutputFilename: "a.out",
          contestSubtaskAllOrNothing: true
        });
        assert(queued.get(contest.taskId) < 0.5, `live contest priority ${queued.get(contest.taskId)}`);
        assert(queued.get(rejudged.taskId) >= 1.5, "a rejudge is in its own class");
        task = (await judging.getTaskToBeSentToJudgeByTaskId(contest.taskId, queued.get(contest.taskId))).extraInfo;
        assert.equal(task.judgeInfo.timeLimit, 3000);
        assert.equal(task.judgeInfo.subtasks[0].scoringType, "GroupMin");
        assert.deepEqual(plain(task.judgeInfo.fileIo), { inputFilename: "a.in", outputFilename: "a.out" });
        await finish(contest.id, "Accepted");
        assert.deepEqual(await counts(p, submitter), [problemCounts, userCounts]);

        // Submissions from before data versions are judged with the current data
        await ds
          .getRepository(SubmissionEntity)
          .update(contest.id, { problemDataVersionId: null, taskId: "legacy-task" });
        task = (await judging.getTaskToBeSentToJudgeByTaskId("legacy-task", 1)).extraInfo;
        assert.equal(task.judgeInfo.timeLimit, 3000);
        assert.deepEqual(plain(task.samples), [{ inputData: "changed" }]);
        await ds.getRepository(SubmissionEntity).update(contest.id, { taskId: null });
      }
    );

    await t.test("a rejudge keeps the result it replaces, the five most recent", async () => {
      const submitter = await user();
      const p = await problem();
      const s = await submit(submitter, p);
      const statuses = [
        "Accepted",
        "WrongAnswer",
        "TimeLimitExceeded",
        "Accepted",
        "RuntimeError",
        "WrongAnswer",
        "Accepted"
      ];
      await finish(s.id, statuses[0]);
      for (const [index, status] of statuses.slice(1).entries()) {
        content.get(p.id).judgeInfo.timeLimit = 2000 + index;
        await judging.rejudgeSubmission(await load(s.id), admin);
        assert.equal((await ds.getRepository(SubmissionDetailEntity).findOneBy({ submissionId: s.id })).result, null);
        await finish(s.id, status);
      }
      const earlier = plain(await svc.getEarlierResults(await load(s.id)));
      assert.deepEqual(
        earlier.map(result => result.status),
        ["WrongAnswer", "RuntimeError", "Accepted", "TimeLimitExceeded", "WrongAnswer"],
        "the most recent first"
      );
      assert.deepEqual(
        earlier.map(result => result.dataVersion),
        [6, 5, 4, 3, 2]
      );
      assert.equal(earlier[2].score, 100);
      const kept = await ds.getRepository(SubmissionResultHistoryEntity).findBy({ submissionId: s.id });
      assert.equal(kept.length, 5);
      assert.ok(kept.every(result => result.replacedBy === admin.id && result.result.progressType === "Finished"));
      assert.deepEqual(plain((await counts(p, submitter))[1]), { submissionCount: 1, acceptedProblemCount: 1 });

      // Deleting the submission deletes its history
      await svc.deleteSubmission(await load(s.id));
      assert.equal(await ds.getRepository(SubmissionResultHistoryEntity).countBy({ submissionId: s.id }), 0);
    });

    await t.test(
      "data versions record content hashes, sent with the task; a result records what judged it",
      async () => {
        const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");
        const submitter = await user();
        const p = await problem();
        const older = await file(p.id, "1.in");
        const first = await versions.current(p);
        assert.deepEqual(plain(first.testData), [{ filename: "1.in", uuid: older }]);
        // Its hash is recorded later (in the background): the version stays the same
        await ds.getRepository(FileEntity).update({ uuid: older }, { sha256: sha256("one") });
        assert.equal((await versions.current(p)).id, first.id, "recording a hash doesn't make a new version");
        assert.equal(await versions.isCurrent(p, first), true);
        const newer = crypto.randomUUID();
        await ds
          .getRepository(FileEntity)
          .insert({ uuid: newer, size: 3, uploadTime: new Date(), sha256: sha256("two") });
        await ds
          .getRepository(ProblemFileEntity)
          .save({ problemId: p.id, type: ProblemFileType.TestData, filename: "2.in", uuid: newer });
        const second = await versions.current(p);
        assert.equal(second.version, first.version + 1);
        assert.deepEqual(plain(second.testData), [
          { filename: "1.in", uuid: older, sha256: sha256("one") },
          { filename: "2.in", uuid: newer, sha256: sha256("two") }
        ]);

        const s = await submit(submitter, p);
        assert.equal(s.problemDataVersionId, second.id);
        const task = await judging.getTaskToBeSentToJudgeByTaskId(s.taskId, 1);
        assert.deepEqual(plain(task.fileHashes), { [older]: sha256("one"), [newer]: sha256("two") });

        // The result records the runtime its judge client announced; a rejudge keeps it with the replaced result
        const runtime = {
          judgeMachine: "judge-1",
          judgeProgram: "a".repeat(64),
          sandboxImage: "b".repeat(64),
          node: "v24.21.0",
          os: "Ubuntu 26.04",
          kernel: "Linux 7.0.0",
          arch: "x64",
          cpu: "Intel Core i7"
        };
        svc.judgeRuntimeService = {
          describe: async ids => new Map(ids.filter(id => id === 7).map(id => [id, runtime]))
        };
        try {
          await finish(s.id, "Accepted", 7);
          assert.equal((await load(s.id)).judgeRuntimeId, 7);
          assert.deepEqual(plain(await svc.getSubmissionJudgeRuntime(await load(s.id))), runtime);
          await judging.rejudgeSubmission(await load(s.id), admin);
          assert.equal((await load(s.id)).judgeRuntimeId, null, "none while it's judged again");
          // A judge client that announces no runtime
          await finish(s.id, "WrongAnswer");
          assert.equal((await load(s.id)).judgeRuntimeId, null);
          assert.equal(await svc.getSubmissionJudgeRuntime(await load(s.id)), null);
          const [earlier] = plain(await svc.getEarlierResults(await load(s.id)));
          assert.equal(earlier.status, "Accepted");
          assert.deepEqual(earlier.judgeRuntime, runtime);
          assert.equal(
            (await ds.getRepository(SubmissionResultHistoryEntity).findOneBy({ submissionId: s.id })).judgeRuntimeId,
            7
          );
        } finally {
          delete svc.judgeRuntimeService;
        }
      }
    );

    await t.test("removed test data stays until no waiting submission needs it", async () => {
      // Without retention for contests and results, as before the policy
      await setPolicy({ contestDays: 0, resultDays: 0 });
      const submitter = await user();
      const p = await problem();
      const kept = await file(p.id, "1.in");
      const removed = await file(p.id, "2.in");
      const attachment = await file(p.id, "statement.pdf", ProblemFileType.AdditionalFile);
      const waiting = await submit(submitter, p);

      const problemFiles = bareProblemServices();
      Object.assign(problemFiles, {
        connection: ds,
        fileService,
        redisService: { cacheDelete: async () => {} },
        lockManageProblemFile: async (id, _type, callback) => await callback(await problems.findOneBy({ id })),
        authorizeProblemMutation: async () => {}
      });
      await problemFiles.removeProblemFiles(p, ProblemFileType.TestData, ["2.in"]);
      await problemFiles.removeProblemFiles(p, ProblemFileType.AdditionalFile, ["statement.pdf"]);
      const exists = async uuid => (await ds.getRepository(FileEntity).countBy({ uuid })) === 1;
      assert.equal(await ds.getRepository(ProblemFileEntity).countBy({ problemId: p.id }), 1);
      assert.equal(await exists(removed), true, "kept for the waiting submission");
      assert.equal(await exists(attachment), false, "attachments are deleted at once");
      assert.deepEqual(removedObjects.splice(0), [attachment]);

      assert.equal(await retention.sweepDeferredFiles(), 0, "not within the grace period");
      const later = Date.now() + 20 * 60 * 1000;
      assert.equal(await retention.sweepDeferredFiles(later), 0, "still needed");
      assert.equal(await exists(removed), true);
      assert.equal(
        (await judging.getTaskToBeSentToJudgeByTaskId(waiting.taskId, 1)).extraInfo.testData["2.in"],
        removed
      );

      await finish(waiting.id, "Accepted");
      assert.equal(await retention.sweepDeferredFiles(later), 1);
      assert.equal(await exists(removed), false);
      assert.equal(await exists(kept), true);
      assert.deepEqual(removedObjects.splice(0), [removed]);
      assert.equal(await ds.getRepository(DeferredFileDeletionEntity).count(), 0);

      // A file a problem uses again is never deleted
      const reused = await file(p.id, "3.in");
      await ds.getRepository(DeferredFileDeletionEntity).insert({ uuid: reused, requestedAt: new Date(0) });
      assert.equal(await retention.sweepDeferredFiles(later), 0);
      assert.equal(await exists(reused), true);
      assert.equal(await ds.getRepository(DeferredFileDeletionEntity).count(), 0);
    });

    // Test data removal as the problem page does it
    const removeTestData = async (p, filenames) => {
      const problemFiles = bareProblemServices();
      Object.assign(problemFiles, {
        connection: ds,
        fileService,
        redisService: { cacheDelete: async () => {} },
        lockManageProblemFile: async (id, _type, callback) => await callback(await problems.findOneBy({ id })),
        authorizeProblemMutation: async () => {}
      });
      await problemFiles.removeProblemFiles(p, ProblemFileType.TestData, filenames);
    };
    const exists = async uuid => (await ds.getRepository(FileEntity).countBy({ uuid })) === 1;
    const DAY = 24 * 60 * 60 * 1000;
    const near = (date, expected) => assert(Math.abs(new Date(date).getTime() - expected) < 5000, `${date}`);
    const decision = async (uuid, now) => (await retention.report(now)).files.find(file => file.uuid === uuid);
    const noneLeft = async () => {
      await setPolicy({ contestDays: 0, resultDays: 0 });
      while ((await retention.sweepDeferredFiles(Date.now() + 3650 * DAY)) > 0);
      assert.equal(await ds.getRepository(DeferredFileDeletionEntity).count(), 0);
    };

    await t.test("removed test data stays for waiting hacks and self-evaluations, which were given it", async () => {
      await setPolicy({ contestDays: 0, resultDays: 0 });
      const p = await problem();
      const [forHack, forRun, forSet] = [await file(p.id, "1.in"), await file(p.id, "2.in"), await file(p.id, "3.in")];
      const taskId = () => crypto.randomUUID();
      const hack = await ds.getRepository(HackEntity).save({
        submissionId: 1,
        problemId: p.id,
        submitterId: owner.id,
        hackerId: owner.id,
        status: "Pending",
        taskId: taskId(),
        inputData: "1",
        snapshot: { testData: { "1.in": forHack } },
        targetFingerprint: "f",
        createTime: new Date()
      });
      const run = await ds.getRepository(SelfEvalEntity).save({
        scope: `contest:1:problem:${p.id}`,
        problemId: p.id,
        submitterId: owner.id,
        status: "Pending",
        taskId: taskId(),
        content: {},
        snapshot: { testData: { "2.in": forRun } },
        createTime: new Date()
      });
      const set = await ds.getRepository(SelfEvalSetEntity).save({
        scope: `set:${p.id}`,
        problemId: p.id,
        recipeHash: "r",
        configHash: "c",
        status: "Pending",
        taskId: taskId(),
        snapshot: { testData: { "3.in": forSet } },
        createdAt: new Date()
      });
      await removeTestData(p, ["1.in", "2.in", "3.in"]);
      const later = Date.now() + 20 * 60 * 1000;
      // Until this release, all three were deleted here while their tasks waited
      assert.equal(await retention.sweepDeferredFiles(later), 0);
      for (const [uuid, kind] of [
        [forHack, "WaitingHack"],
        [forRun, "WaitingSelfEval"],
        [forSet, "WaitingSelfEval"]
      ])
        assert.deepEqual(plain(await decision(uuid, later)).reasons, [{ kind }]);
      await ds.getRepository(HackEntity).update(hack.id, { taskId: null, status: "Success" });
      await ds.getRepository(SelfEvalEntity).update(run.id, { taskId: null });
      await ds.getRepository(SelfEvalSetEntity).update({ scope: set.scope }, { taskId: null });
      assert.equal(await retention.sweepDeferredFiles(later), 3);
      for (const uuid of [forHack, forRun, forSet]) assert.equal(await exists(uuid), false);
    });

    await t.test(
      "contests and judged results keep removed test data for the policy's days, a kept version until released",
      async () => {
        await setPolicy({ contestDays: 30, resultDays: 7 });
        const submitter = await user();
        const p = await problem();
        const first = await file(p.id, "1.in");
        const practice = await submit(submitter, p);
        await finish(practice.id, "Accepted");
        const contestEnd = Date.now() + 2 * DAY;
        await ds.getRepository(ContestEntity).save({
          id: 77,
          title: "Retention cup",
          subtitle: "",
          description: "",
          rule: "ioi",
          startTime: new Date(Date.now() - DAY),
          endTime: new Date(contestEnd),
          ownerId: submitter.id,
          adminIds: [],
          languages: [],
          createdAt: new Date()
        });
        const inContest = await submit(submitter, p, {
          contestId: 77,
          contestProblemId: 1,
          contestInputFilename: null,
          contestOutputFilename: null,
          contestSubtaskAllOrNothing: false
        });
        await finish(inContest.id, "WrongAnswer");
        const v1 = (await load(practice.id)).problemDataVersionId;
        assert.equal((await load(inContest.id)).problemDataVersionId, v1);

        // The test data is replaced
        await removeTestData(p, ["1.in"]);
        const removedAt = Date.now();
        await file(p.id, "1.in");
        let kept = plain(await decision(first, removedAt + 20 * 60 * 1000));
        assert.equal(kept.action, "Keep");
        assert.deepEqual(
          [kept.problemId, kept.filename, kept.versions, kept.size],
          [p.id, "1.in", [1], 3],
          "found through the data version that uses it"
        );
        assert.deepEqual(kept.reasons.map(reason => reason.kind).sort(), ["Contest", "Result"]);
        const contest = kept.reasons.find(reason => reason.kind === "Contest");
        assert.deepEqual([contest.contestId, contest.version], [77, 1]);
        near(contest.until, contestEnd + 30 * DAY);
        near(kept.reasons.find(reason => reason.kind === "Result").until, removedAt + 7 * DAY);
        near(kept.keptUntil, contestEnd + 30 * DAY);
        // What people who can rejudge see: the old version is no longer the problem's, but its data is all there
        const shown = plain(await svc.getSubmissionDataVersion(await load(practice.id), p));
        assert.deepEqual([shown.version, shown.current, shown.testData.state], [1, false, "Retained"]);
        near(shown.testData.retainedUntil, contestEnd + 30 * DAY);
        assert.deepEqual(shown.testData.reasons.sort(), ["Contest", "Grace", "Result"], "just removed");

        // A rejudge five days later keeps the earlier result: seven days from then
        await judging.rejudgeSubmission(await load(practice.id), admin);
        await finish(practice.id, "Accepted");
        await ds.query("UPDATE submission_result_history SET replacedAt = ? WHERE submissionId = ?", [
          new Date(removedAt + 5 * DAY),
          practice.id
        ]);
        const [earlier] = plain(await svc.getEarlierResults(await load(practice.id)));
        assert.deepEqual([earlier.dataVersion, earlier.testData.state], [1, "Retained"]);
        kept = plain(await decision(first, removedAt + 8 * DAY));
        assert.deepEqual(
          kept.reasons.map(reason => reason.kind).sort(),
          ["Contest", "EarlierResult"],
          "the results' seven days from the removal are over"
        );
        near(kept.reasons.find(reason => reason.kind === "EarlierResult").until, removedAt + 12 * DAY);
        // The contest submission's own result (still version 1) is a result too: seven days after the removal
        assert.equal((await decision(first, removedAt + 7 * DAY - 60000)).reasons.length, 3);
        assert.deepEqual(
          (await decision(first, removedAt + 13 * DAY)).reasons.map(reason => reason.kind),
          ["Contest"],
          "only the contest's days are left"
        );
        assert.equal((await decision(first, contestEnd + 31 * DAY)).action, "Delete");
        assert.equal(await retention.sweepDeferredFiles(contestEnd + 29 * DAY), 0, "the cleanup does as the report says");
        assert.equal(await exists(first), true);
        const report = await retention.report(contestEnd + 29 * DAY);
        assert.deepEqual(plain(report.kept), { files: 1, bytes: 3 });
        assert.deepEqual(plain(report.byReason), [{ kind: "Contest", files: 1, bytes: 3 }]);

        // Kept by a problem manager: whatever the policy, until released
        const version = await versions.findById(v1);
        assert.equal(await retention.keep(version, submitter), true);
        kept = plain(await decision(first, contestEnd + 400 * DAY));
        assert.deepEqual([kept.action, kept.keptUntil], ["Keep", undefined]);
        assert.deepEqual(kept.reasons, [{ kind: "Kept", version: 1, keptBy: submitter.id }]);
        const keptShown = plain((await retention.describeAvailability([v1], contestEnd + 400 * DAY)).get(v1));
        assert.deepEqual([keptShown.state, keptShown.keptBy, keptShown.retainedUntil], ["Retained", `u${submitter.id}`, undefined]);
        assert.equal(await retention.sweepDeferredFiles(contestEnd + 400 * DAY), 0);
        await retention.release(version);
        assert.equal(await retention.sweepDeferredFiles(contestEnd + 400 * DAY), 1);
        assert.equal(await exists(first), false);
        // Metadata only from now on: the results stay readable, nothing can be kept
        assert.equal((await svc.getSubmissionDataVersion(await load(inContest.id), p)).testData.state, "Deleted");
        assert.equal(plain(await svc.getEarlierResults(await load(practice.id)))[0].testData.state, "Deleted");
        assert.equal(plain(await svc.getEarlierResults(await load(practice.id)))[0].status, "Accepted");
        assert.equal(await retention.keep(version, submitter), false);
        await noneLeft();
      }
    );

    await t.test("a version kept while a cleanup deletes its files is kept or refused, never half kept", async () => {
      await setPolicy({ contestDays: 0, resultDays: 0 });
      const submitter = await user();
      const later = Date.now() + 20 * 60 * 1000;
      const evaluate = retention.evaluate;
      try {
        // Kept after the cleanup's first look: its second look, with the records locked, keeps the file
        let p = await problem();
        let removed = await file(p.id, "1.in");
        let s = await submit(submitter, p);
        await finish(s.id, "Accepted");
        let version = await versions.findById((await load(s.id)).problemDataVersionId);
        await removeTestData(p, ["1.in"]);
        retention.evaluate = async function (rows, now, manager) {
          const result = await evaluate.call(this, rows, now, manager);
          if (!manager) {
            retention.evaluate = evaluate;
            assert.equal(result.find(file => file.uuid === removed).action, "Delete");
            assert.equal(await retention.keep(version, submitter), true);
          }
          return result;
        };
        assert.equal(await retention.sweepDeferredFiles(later), 0);
        assert.equal(await exists(removed), true);
        await retention.release(version);
        assert.equal(await retention.sweepDeferredFiles(later), 1);

        // Kept while the cleanup deletes: it waits for the deletion, then finds the file gone
        p = await problem();
        removed = await file(p.id, "1.in");
        s = await submit(submitter, p);
        await finish(s.id, "Accepted");
        version = await versions.findById((await load(s.id)).problemDataVersionId);
        await removeTestData(p, ["1.in"]);
        let keeping = null;
        retention.evaluate = async function (rows, now, manager) {
          const result = await evaluate.call(this, rows, now, manager);
          if (manager) {
            retention.evaluate = evaluate;
            keeping = retention.keep(version, submitter);
            await new Promise(resolve => setTimeout(resolve, 300));
          }
          return result;
        };
        assert.equal(await retention.sweepDeferredFiles(later), 1);
        assert.equal(await keeping, false);
        assert.equal(await ds.getRepository(ProblemDataVersionKeepEntity).countBy({ problemDataVersionId: version.id }), 0);
      } finally {
        retention.evaluate = evaluate;
      }
      await noneLeft();
    });

    await t.test("files the policy keeps don't hold up the cleanup of later ones", async () => {
      await setPolicy({ contestDays: 0, resultDays: 0 });
      const p = await problem();
      // More than a cleanup's page, given to a waiting hack, then one nothing keeps, removed later
      const held = Array.from({ length: 1001 }, () => crypto.randomUUID());
      await ds.getRepository(FileEntity).insert(held.map(uuid => ({ uuid, size: 1, uploadTime: new Date() })));
      await ds
        .getRepository(DeferredFileDeletionEntity)
        .insert(held.map(uuid => ({ uuid, requestedAt: new Date(Date.now() - 2 * DAY) })));
      const hack = await ds.getRepository(HackEntity).save({
        submissionId: 1,
        problemId: p.id,
        submitterId: owner.id,
        hackerId: owner.id,
        status: "Pending",
        taskId: crypto.randomUUID(),
        inputData: "1",
        snapshot: { testData: Object.fromEntries(held.map((uuid, i) => [`${i}.in`, uuid])) },
        targetFingerprint: "f",
        createTime: new Date()
      });
      const free = crypto.randomUUID();
      await ds.getRepository(FileEntity).insert({ uuid: free, size: 1, uploadTime: new Date() });
      await ds.getRepository(DeferredFileDeletionEntity).insert({ uuid: free, requestedAt: new Date(Date.now() - DAY) });
      assert.equal(await retention.sweepDeferredFiles(), 1);
      assert.equal(await exists(free), false);
      assert.equal(await ds.getRepository(DeferredFileDeletionEntity).count(), 1001);
      await ds.getRepository(HackEntity).update(hack.id, { taskId: null });
      await noneLeft();
    });

    await t.test("counts change exactly with the submissions, also concurrently", async () => {
      const users = [await user(), await user()];
      const ps = [await problem(), await problem()];
      const all = [];
      for (let round = 0; round < 3; round++)
        all.push(...(await Promise.all(users.flatMap(u => ps.map(p => submit(u, p))))));
      for (const p of ps)
        assert.deepEqual((await counts(p, users[0]))[0], { submissionCount: 6, acceptedSubmissionCount: 0 });
      await Promise.all(all.map(s => finish(s.id, "Accepted")));
      for (const p of ps)
        assert.deepEqual((await counts(p, users[0]))[0], { submissionCount: 6, acceptedSubmissionCount: 6 });
      for (const u of users)
        assert.deepEqual((await counts(ps[0], u))[1], { submissionCount: 6, acceptedProblemCount: 2 });
      await Promise.all(all.map(async s => await judging.rejudgeSubmission(await load(s.id), admin)));
      for (const u of users) assert.equal((await counts(ps[0], u))[1].acceptedProblemCount, 0);
      await Promise.all(all.map((s, index) => finish(s.id, index % 3 === 0 ? "Accepted" : "WrongAnswer")));
      assert.deepEqual(
        users.map(u => all.filter((s, index) => s.submitterId === u.id && index % 3 === 0).length > 0),
        [true, true]
      );

      // A failure recording the change of the counts stores nothing: the result is reported again later
      const s = await submit(users[0], ps[0]);
      const before = await counts(ps[0], users[0]);
      const record = outbox.record;
      outbox.record = async () => {
        throw new Error("forced record failure");
      };
      try {
        await assert.rejects(
          judging.onTaskProgress((await load(s.id)).taskId, finished("Accepted")),
          /forced record failure/
        );
      } finally {
        outbox.record = record;
      }
      assert.equal((await load(s.id)).status, "Pending");
      assert.deepEqual(await counts(ps[0], users[0]), before);
      await finish(s.id, "Accepted");
      assert.equal(await ds.getRepository(StatisticsOutboxEntity).count(), 0, "every change was applied");
    });

    await t.test("changes recorded before a crash are applied once by a later replay", async () => {
      const submitter = await user();
      const p = await problem();
      // The process "stops" after its transactions commit, before applying the changes they recorded
      const apply = outbox.apply;
      outbox.apply = async () => {};
      let waiting;
      try {
        waiting = [await submit(submitter, p), await submit(submitter, p)];
        await finish(waiting[0].id, "Accepted");
      } finally {
        outbox.apply = apply;
      }
      assert.deepEqual(await counts(p, submitter), [
        { submissionCount: 0, acceptedSubmissionCount: 0 },
        { submissionCount: 0, acceptedProblemCount: 0 }
      ]);
      assert.equal(await outbox.replay(), 0, "recent changes are left to the process that recorded them");
      const pending = (await ds.getRepository(StatisticsOutboxEntity).find()).map(record => record.id);
      assert.equal(pending.length, 6);
      // Another process replays while this one applies the same records
      await Promise.all([outbox.replay(0), outbox.apply(pending), outbox.replay(0)]);
      const expected = [
        { submissionCount: 2, acceptedSubmissionCount: 1 },
        { submissionCount: 2, acceptedProblemCount: 1 }
      ];
      assert.deepEqual(await counts(p, submitter), expected);
      assert.equal(await outbox.replay(0), 0);
      await outbox.apply(pending);
      assert.deepEqual(await counts(p, submitter), expected, "each change counts once");
    });

    await t.test("the rebuild command finds and corrects differences, also while results change", async () => {
      const { rebuildStatistics } = await import(path.resolve(__dirname, "../../../../deploy/rebuild-statistics.mjs"));
      const clean = await rebuildStatistics(ds);
      assert.deepEqual([clean.problems.differing, clean.users.differing], [0, 0], "every count above was exact");

      const submitter = await user();
      const p = await problem();
      const waiting = [];
      for (let i = 0; i < 12; i++) waiting.push(await submit(submitter, p));
      await ds.query("UPDATE problem SET submissionCount = 99, acceptedSubmissionCount = 7 WHERE id = ?", [p.id]);
      await ds.query("UPDATE user SET acceptedProblemCount = 5 WHERE id = ?", [submitter.id]);
      const found = await rebuildStatistics(ds);
      assert.deepEqual(plain(found.problems.sample), [{ id: p.id, stored: [99, 7], counted: [12, 0] }]);
      assert.deepEqual(plain(found.users.sample), [{ id: submitter.id, stored: [12, 5], counted: [12, 0] }]);
      assert.equal(found.problems.corrected, 0, "checking changes nothing");

      // Results arrive while the counts are rebuilt
      await Promise.all([
        ...waiting.map((s, index) => finish(s.id, index % 2 ? "Accepted" : "WrongAnswer")),
        rebuildStatistics(ds, { apply: true }),
        rebuildStatistics(ds, { apply: true })
      ]);
      const after = await rebuildStatistics(ds);
      assert.deepEqual([after.problems.differing, after.users.differing], [0, 0]);
      assert.deepEqual(await counts(p, submitter), [
        { submissionCount: 12, acceptedSubmissionCount: 6 },
        { submissionCount: 12, acceptedProblemCount: 1 }
      ]);
    });
  }
);
