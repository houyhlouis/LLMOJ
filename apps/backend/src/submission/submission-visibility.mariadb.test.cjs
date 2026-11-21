// Run against a disposable MariaDB config. Request and verdict operations use separate connections and random tables.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
require("@nestjs/common").Logger.overrideLogger(false);
const main = require.resolve("../main.ts");
require.cache[main] = { id: main, filename: main, loaded: true, exports: { appGitRepoInfo: {} } };
const { DataSource, EntitySchema } = require("typeorm");
const { SubmissionService } = require("./submission.service.ts");
const { SubmissionController } = require("./submission.controller.ts");
const { SubmissionJudgingService } = require("./submission-judging.service.ts");
const { SubmissionEntity } = require("./submission.entity.ts");
const { SubmissionDetailEntity } = require("./submission-detail.entity.ts");
const { SubmissionResultHistoryEntity } = require("./submission-result-history.entity.ts");
const { StatisticsOutboxService } = require("./statistics-outbox.service.ts");
const { StatisticsOutboxEntity } = require("./statistics-outbox.entity.ts");
const { UserEntity } = require("../user/user.entity.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts");

const configPath = process.env.LLMOJ_NARROW_WRITES_TEST_DB_CONFIG;
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};

test(
  "visibility preserves committed verdict changes (real MariaDB)",
  {
    skip: !configPath && "needs LLMOJ_NARROW_WRITES_TEST_DB_CONFIG",
    timeout: 60000
  },
  async t => {
    const config = require("js-yaml").load(fs.readFileSync(configPath, "utf8")).services.database;
    const prefix = `qa_visibility_${crypto.randomBytes(8).toString("hex")}_`;
    const number = { type: Number };
    const nullableNumber = { ...number, nullable: true };
    const nullableString = { type: String, nullable: true };
    const definitions = [
      [UserEntity, "user", { id: { ...number, primary: true }, submissionCount: number, acceptedProblemCount: number }],
      [
        ProblemEntity,
        "problem",
        {
          id: { ...number, primary: true },
          type: { type: String },
          submissionCount: number,
          acceptedSubmissionCount: number
        }
      ],
      [
        SubmissionEntity,
        "submission",
        {
          id: { ...number, primary: true },
          problemId: number,
          submitterId: number,
          contestId: nullableNumber,
          taskId: nullableString,
          isPublic: { type: Boolean },
          status: { type: String },
          score: nullableNumber,
          timeUsed: nullableNumber,
          memoryUsed: nullableNumber,
          totalOccupiedTime: nullableNumber,
          problemDataVersionId: nullableNumber,
          judgeRuntimeId: nullableNumber,
          answerSize: number,
          submitTime: { type: Date }
        }
      ],
      [
        SubmissionDetailEntity,
        "detail",
        {
          submissionId: { ...number, primary: true },
          content: { type: "json" },
          fileUuid: nullableString,
          result: { type: "json", nullable: true }
        }
      ],
      [
        SubmissionResultHistoryEntity,
        "history",
        {
          id: { ...number, primary: true, generated: true },
          submissionId: number,
          problemDataVersionId: nullableNumber,
          judgeRuntimeId: nullableNumber,
          status: { type: String },
          score: nullableNumber,
          timeUsed: nullableNumber,
          memoryUsed: nullableNumber,
          totalOccupiedTime: nullableNumber,
          result: { type: "json", nullable: true },
          replacedAt: { type: Date },
          replacedBy: nullableNumber
        }
      ],
      [
        StatisticsOutboxEntity,
        "outbox",
        {
          id: { ...number, primary: true, generated: true },
          kind: { type: String },
          targetId: number,
          submissions: number,
          accepted: number,
          createdAt: { type: Date }
        }
      ]
    ];
    const entities = definitions.map(
      ([target, name, columns]) =>
        new EntitySchema({
          name: target.name,
          target,
          tableName: prefix + name,
          columns
        })
    );
    const db = new DataSource({ ...config, entities, synchronize: true, logging: false });
    const writer = new DataSource({ ...config, entities, synchronize: false, logging: false });
    try {
      await db.initialize();
      await writer.initialize();
      const submissions = db.getRepository(SubmissionEntity);
      const details = db.getRepository(SubmissionDetailEntity);
      const history = db.getRepository(SubmissionResultHistoryEntity);
      const users = db.getRepository(UserEntity);
      const problems = db.getRepository(ProblemEntity);
      const outbox = Object.assign(Object.create(StatisticsOutboxService.prototype), { connection: writer });
      const tails = new Map();
      const lockService = {
        async lock(key, callback) {
          const previous = tails.get(key) || Promise.resolve();
          const released = deferred();
          const tail = previous.then(() => released.promise);
          tails.set(key, tail);
          await previous;
          try {
            return await callback();
          } finally {
            released.resolve();
            if (tails.get(key) === tail) tails.delete(key);
          }
        }
      };
      const collaborators = {
        connection: writer,
        submissionRepository: writer.getRepository(SubmissionEntity),
        submissionDetailRepository: writer.getRepository(SubmissionDetailEntity),
        lockService,
        problemLocks: {
          lockProblemById: async (id, _type, callback) =>
            callback(await writer.getRepository(ProblemEntity).findOneBy({ id }))
        },
        statisticsOutboxService: outbox,
        submissionStatisticsService: { onSubmissionUpdated: async () => {} },
        submissionProgressService: { emitSubmissionEvent: async () => {} },
        judgeGateway: { cancelTask() {} },
        judgeQueueService: { enqueue: async () => {}, notifyJobsAvailable() {} },
        configService: { config: { preference: { serverSideOnly: { dynamicTaskPriority: false } } } },
        problemDataVersionService: { current: async () => ({ id: 92 }) },
        problemTypeFactoryService: {
          type: () => ({ getTimeAndMemoryUsedFromFinishedSubmissionProgress: () => ({ timeUsed: 23, memoryUsed: 42 }) })
        },
        metricSubmissionJudgeTime: { observe() {} },
        auditService: { log: async () => {} },
        submissionAccessService: { userHasPermission: async () => true }
      };
      const judging = Object.assign(Object.create(SubmissionJudgingService.prototype), collaborators);
      const mutations = Object.assign(Object.create(SubmissionService.prototype), collaborators, {
        submissionJudgingService: judging
      });
      const service = Object.assign(Object.create(SubmissionService.prototype), { submissionRepository: submissions });
      const controllerLogs = [];
      const controller = Object.assign(Object.create(SubmissionController.prototype), {
        submissionService: service,
        auditService: { log: async (...args) => controllerLogs.push(args) }
      });
      const finished = { progressType: "Finished", status: "Accepted", score: 100, totalOccupiedTime: 70 };
      async function reset(isPublic, pending = false) {
        for (const target of [
          StatisticsOutboxEntity,
          SubmissionResultHistoryEntity,
          SubmissionDetailEntity,
          SubmissionEntity
        ])
          await db.getRepository(target).clear();
        controllerLogs.length = 0;
        await users.save({ id: 2, submissionCount: 1, acceptedProblemCount: pending ? 0 : 1 });
        await problems.save({
          id: 1,
          type: "Traditional",
          submissionCount: 1,
          acceptedSubmissionCount: pending ? 0 : 1
        });
        await submissions.insert({
          id: 3,
          problemId: 1,
          submitterId: 2,
          contestId: null,
          isPublic,
          taskId: pending ? crypto.randomUUID() : null,
          status: pending ? "Pending" : "Accepted",
          score: pending ? null : 100,
          timeUsed: pending ? null : 7,
          memoryUsed: pending ? null : 9,
          totalOccupiedTime: pending ? null : 50,
          problemDataVersionId: 61,
          judgeRuntimeId: pending ? null : 31,
          answerSize: 12,
          submitTime: new Date("2026-02-03T04:05:06Z")
        });
        await details.insert({
          submissionId: 3,
          content: { language: "cpp", code: "int main() { return 0; }" },
          result: pending ? null : finished,
          fileUuid: null
        });
      }
      async function preservedState() {
        return plain({
          submission: await submissions.findOneByOrFail({ id: 3 }),
          detail: await details.findOneByOrFail({ submissionId: 3 }),
          history: await history.find({ order: { id: "ASC" } }),
          user: await users.findOneByOrFail({ id: 2 }),
          problem: await problems.findOneByOrFail({ id: 1 }),
          outbox: await db.getRepository(StatisticsOutboxEntity).find({ order: { id: "ASC" } })
        });
      }
      async function betweenReadAndWrite(desired, concurrentWrite) {
        const read = deferred();
        const resume = deferred();
        controller.submissionAccessService = {
          userHasPermission: async (_user, submission) => {
            read.resolve(submission);
            await resume.promise;
            return true;
          }
        };
        const request = controller.setSubmissionPublic(
          { id: 9, isAdmin: true },
          { submissionId: 3, isPublic: desired }
        );
        const snapshot = await read.promise;
        let committed;
        try {
          await concurrentWrite(snapshot);
          committed = await preservedState();
        } finally {
          resume.resolve();
        }
        assert.deepEqual(await request, {});
        const after = await preservedState();
        assert.deepEqual(after, { ...committed, submission: { ...committed.submission, isPublic: desired } });
        return { snapshot, committed, after };
      }

      for (const desired of [false, true]) {
        for (const transition of ["complete", "Fake", "Hacked", "rejudge"]) {
          await t.test(`${transition} commits between read and visibility ${desired}`, async () => {
            await reset(!desired, transition === "complete");
            const { snapshot, committed } = await betweenReadAndWrite(desired, async () => {
              const current = await writer.getRepository(SubmissionEntity).findOneByOrFail({ id: 3 });
              if (transition === "complete")
                assert.equal(
                  await judging.onTaskProgress(current.taskId, finished, {
                    judgeRuntimeId: 45,
                    confirm: async () => true
                  }),
                  true
                );
              else if (transition === "Fake") assert.equal(await mutations.fakeSubmission(current, 9), true);
              else if (transition === "Hacked") {
                const detail = await writer.getRepository(SubmissionDetailEntity).findOneByOrFail({ submissionId: 3 });
                const fingerprint = crypto
                  .createHash("sha256")
                  .update(
                    JSON.stringify([current.id, current.submitTime, current.status, current.score, detail.content])
                  )
                  .digest("hex");
                assert.equal(await mutations.markSubmissionHacked(current, 9, 12, fingerprint), true);
              } else await judging.rejudgeSubmission(current, { id: 9, isAdmin: true });
            });
            assert.notEqual(committed.submission.status, snapshot.status);
            if (transition === "complete") assert.equal(committed.submission.judgeRuntimeId, 45);
            if (transition === "rejudge") {
              assert.equal(committed.submission.problemDataVersionId, 92);
              assert.ok(committed.submission.taskId);
              assert.equal(committed.history.length, 1);
            }
            assert.deepEqual(
              committed.outbox,
              [],
              "the verdict's statistics effects finished before the visibility write"
            );
            assert.equal(controllerLogs.length, 1);
            assert.equal(controllerLogs[0][0], desired ? "submission.set_public" : "submission.set_non_public");
          });
        }

        await t.test(`a stale matching visibility ${desired} still applies the requested value`, async () => {
          await reset(desired);
          await betweenReadAndWrite(desired, () =>
            writer.getRepository(SubmissionEntity).update({ id: 3 }, { isPublic: !desired })
          );
          assert.equal(controllerLogs.length, 1);
        });

        await t.test(`a stale different visibility ${desired} does not produce a duplicate audit event`, async () => {
          await reset(!desired);
          await betweenReadAndWrite(desired, () =>
            writer.getRepository(SubmissionEntity).update({ id: 3 }, { isPublic: desired })
          );
          assert.deepEqual(controllerLogs, []);
        });
      }
    } finally {
      if (writer.isInitialized) await writer.destroy();
      if (db.isInitialized) {
        for (const [, name] of definitions.slice().reverse())
          await db.query(`DROP TABLE IF EXISTS \`${prefix}${name}\``);
        await db.destroy();
      }
    }
  }
);
