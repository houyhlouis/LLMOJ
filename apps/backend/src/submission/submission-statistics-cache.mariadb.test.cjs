const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const test = require("node:test");
const { format } = require("node:util");
const ts = require("typescript");
const { redisAvailable, startRedis } = require("../../test/temporary-redis.cjs");

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
  return format(String(this), ...args);
};
require("@nestjs/common").Logger.overrideLogger(false);
const main = require.resolve("../main.ts");
require.cache[main] = { id: main, filename: main, loaded: true, exports: { appGitRepoInfo: {} } };
const { DataSource } = require("typeorm");
const { UserEntity } = require("../user/user.entity.ts");
const { UserAuthEntity } = require("../auth/user-auth.entity.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts");
const { ProblemFileEntity } = require("../problem/problem-file.entity.ts");
const { ProblemJudgeInfoEntity } = require("../problem/problem-judge-info.entity.ts");
const { ProblemSampleEntity } = require("../problem/problem-sample.entity.ts");
const { ProblemLockService } = require("../problem/problem-lock.service.ts");
const { ProblemService } = require("../problem/problem.service.ts");
const { ProblemTypeTraditionalService } = require("../problem-type/types/traditional/problem-type.service.ts");
const { LockService } = require("../redis/lock.service.ts");
const { RedisService } = require("../redis/redis.service.ts");
const { GenerationCache } = require("../redis/generation-cache.ts");
const { SubmissionEntity } = require("./submission.entity.ts");
const { SubmissionDetailEntity } = require("./submission-detail.entity.ts");
const { SubmissionResultHistoryEntity } = require("./submission-result-history.entity.ts");
const { StatisticsOutboxEntity } = require("./statistics-outbox.entity.ts");
const { StatisticsOutboxService } = require("./statistics-outbox.service.ts");
const { SubmissionStatisticsService, SubmissionStatisticsType } = require("./submission-statistics.service.ts");
const { SubmissionJudgingService } = require("./submission-judging.service.ts");
const { SubmissionService } = require("./submission.service.ts");

const configPath = process.env.LLMOJ_STATISTICS_CACHE_TEST_DB_CONFIG;
const rankings = Object.values(SubmissionStatisticsType);

// Intercept only completed aggregate SELECTs. No MariaDB connection or transaction is held while the caller waits.
function measureSql(db) {
  return {
    reads: 0,
    afterRead: null,
    createQueryBuilder() {
      const query = db.createQueryBuilder();
      const getRows = query.getRawMany.bind(query);
      query.getRawMany = async () => {
        const rows = await getRows();
        this.reads++;
        await this.afterRead?.();
        return rows;
      };
      return query;
    }
  };
}

async function readAll(stats, problem) {
  const [histogram, ...lists] = await Promise.all([
    stats.querySubmissionScoreStatistics(problem),
    ...rankings.map(type => stats.querySubmissionStatisticsAndCount(problem, type, 0, 100))
  ]);
  return { histogram, lists };
}

function assertStatistics({ histogram, lists }, id, accepted) {
  const expected = Array(101).fill(0);
  if (accepted) expected[100] = 1;
  assert.deepEqual(histogram, expected, "score histogram");
  for (const [index, [rows, count]] of lists.entries()) {
    assert.deepEqual(
      rows.map(row => row.id),
      accepted ? [id] : [],
      rankings[index]
    );
    assert.equal(count, rows.length, rankings[index]);
  }
}

async function mutateBeforeFill(sql, read, mutate) {
  const arrived = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let completed = 0;
  const expected = rankings.length + 1;
  sql.afterRead = () => {
    if (++completed === expected) arrived.resolve();
    return resume.promise;
  };
  const timeout = setTimeout(
    () => arrived.reject(new Error(`Only ${completed}/${expected} reads reached the barrier`)),
    10000
  );
  const pending = read();
  try {
    await Promise.race([
      arrived.promise,
      pending.then(() => assert.fail("statistics returned before the SQL barrier"))
    ]);
    await mutate();
  } finally {
    clearTimeout(timeout);
    sql.afterRead = null;
    resume.resolve();
    await pending;
  }
}

test(
  "practice statistics follow committed verdicts across readers (MariaDB and Redis)",
  {
    skip: (!configPath || !redisAvailable) && "needs LLMOJ_STATISTICS_CACHE_TEST_DB_CONFIG and redis-server",
    timeout: 120000
  },
  async t => {
    const redis = await startRedis(t);
    const writerClient = redis.duplicate({ lazyConnect: true });
    t.after(() => writerClient.disconnect());
    await writerClient.connect();

    const database = require("js-yaml").load(fs.readFileSync(configPath, "utf8")).services.database;
    const entities = [
      UserEntity,
      UserAuthEntity,
      ProblemEntity,
      ProblemFileEntity,
      ProblemJudgeInfoEntity,
      ProblemSampleEntity,
      SubmissionEntity,
      SubmissionDetailEntity,
      SubmissionResultHistoryEntity,
      StatisticsOutboxEntity
    ];
    const db = new DataSource({
      ...database,
      entities,
      entityPrefix: `qa_stats_${crypto.randomBytes(6).toString("hex")}_`,
      synchronize: false,
      logging: false
    });
    await db.initialize();
    t.after(async () => {
      try {
        for (const entity of [...entities].reverse())
          await db.query(`DROP TABLE IF EXISTS \`${db.getMetadata(entity).tableName}\``);
      } finally {
        await db.destroy();
      }
    });
    await db.synchronize();
    const users = db.getRepository(UserEntity);
    const problems = db.getRepository(ProblemEntity);
    const submissions = db.getRepository(SubmissionEntity);
    const details = db.getRepository(SubmissionDetailEntity);
    const sql = measureSql(db);
    const submissionService = Object.create(SubmissionService.prototype);
    const cacheService = client =>
      Object.assign(Object.create(RedisService.prototype), { client, generationCache: new GenerationCache(client) });
    const writerRedis = cacheService(writerClient);
    // Independent readers and invalidators, as on two backend processes.
    const readerStats = new SubmissionStatisticsService(sql, submissionService, cacheService(redis));
    const writerStats = new SubmissionStatisticsService(sql, submissionService, writerRedis);
    const lockService = new LockService({ getClient: () => redis });
    const shared = {
      connection: db,
      submissionRepository: submissions,
      submissionDetailRepository: details,
      lockService,
      problemLocks: new ProblemLockService(problems, lockService),
      statisticsOutboxService: new StatisticsOutboxService(db, null),
      submissionStatisticsService: writerStats,
      submissionProgressService: { emitSubmissionEvent: async () => {} }
    };
    const judging = Object.assign(Object.create(SubmissionJudgingService.prototype), shared, {
      configService: { config: { preference: { serverSideOnly: { dynamicTaskPriority: false } } } },
      judgeQueueService: { enqueue: async () => {}, notifyJobsAvailable() {} },
      problemDataVersionService: { current: async () => null },
      problemTypeFactoryService: { type: () => new ProblemTypeTraditionalService() },
      metricSubmissionJudgeTime: { observe() {} }
    });
    Object.assign(submissionService, shared, {
      submissionJudgingService: judging,
      auditService: { log: async () => {} }
    });
    const problemService = Object.assign(Object.create(ProblemService.prototype), {
      connection: db,
      submissionService,
      redisService: writerRedis,
      userService: { onDeleteProblem: async () => {} },
      fileService: { deleteFile: async files => assert.deepEqual(files, []) },
      permissionService: { replaceUsersAndGroupsPermissionForObject: async () => {} }
    });
    const progress = {
      progressType: "Finished",
      status: "Accepted",
      score: 100,
      totalOccupiedTime: 20,
      subtasks: [{ score: 100, fullScore: 100, testcases: [{ testcaseHash: "sample" }] }],
      testcaseResult: { sample: { status: "Accepted", score: 100, time: 3, memory: 7 } }
    };
    const finish = async submission => assert.equal(await judging.onTaskProgress(submission.taskId, progress), true);

    async function fixture(accepted) {
      const username = crypto.randomBytes(6).toString("hex");
      const user = await users.save({
        username,
        email: `${username}@example.test`,
        nickname: "",
        bio: "",
        avatarInfo: "",
        publicEmail: false,
        isAdmin: false,
        acceptedProblemCount: 0,
        submissionCount: 1,
        rating: 0
      });
      const problem = await problems.save({
        type: "Traditional",
        ownerId: user.id,
        locales: ["en_US"],
        isPublic: true,
        submissionCount: 1,
        acceptedSubmissionCount: 0
      });
      const submission = await submissions.save({
        problemId: problem.id,
        submitterId: user.id,
        taskId: crypto.randomUUID(),
        isPublic: true,
        status: "Pending",
        score: null,
        answerSize: 21,
        submitTime: new Date()
      });
      await details.save({
        submissionId: submission.id,
        content: { language: "cpp", code: "int main() {}" },
        result: null
      });
      if (accepted) await finish(submission);
      return { problem, submission: await submissions.findOneByOrFail({ id: submission.id }) };
    }

    const transitions = [
      ["judge completion", false, "Accepted", finish],
      ["rejudge", true, "Pending", submission => judging.rejudgeSubmission(submission, { id: 9 })],
      [
        "Fake",
        true,
        "Fake",
        async submission => assert.equal(await submissionService.fakeSubmission(submission, 9), true)
      ],
      ["submission deletion", true, null, submission => submissionService.deleteSubmission(submission)],
      [
        "problem deletion",
        true,
        null,
        submission =>
          shared.problemLocks.lockProblemById(submission.problemId, "Write", problem =>
            problemService.deleteProblem(problem)
          )
      ]
    ];
    for (const [name, initiallyAccepted, status, mutate] of transitions) {
      await t.test(`${name} commits between the statistics SELECTs and their cache fills`, async () => {
        const { problem, submission } = await fixture(initiallyAccepted);
        await mutateBeforeFill(
          sql,
          () => readAll(readerStats, problem),
          () => mutate(submission)
        );
        const committed = await submissions.findOneBy({ id: submission.id });
        assert.equal(committed?.status ?? null, status);
        assert.equal(await db.getRepository(StatisticsOutboxEntity).count(), 0);
        assertStatistics(await readAll(readerStats, problem), submission.id, status === "Accepted");
        const rebuilt = sql.reads;
        assertStatistics(await readAll(writerStats, problem), submission.id, status === "Accepted");
        assert.equal(sql.reads, rebuilt, "another reader hit every regenerated cache");
        assert.deepEqual(await submissions.findOneBy({ id: submission.id }), committed);
      });
    }

    await t.test(
      "SQL fallback during a cache outage and regeneration after reconnect preserve the verdict",
      async () => {
        const { problem, submission } = await fixture(true);
        // Old layout entries may still exist throughout rollout.
        await redis.set(`submission-score-statistics:${problem.id}`, JSON.stringify(Array(101).fill(0)));
        for (const type of rankings) await redis.set(`submission-statistics:${problem.id}:${type}`, "[]");
        assertStatistics(await readAll(writerStats, problem), submission.id, true);

        const disconnected = once(writerClient, "end");
        writerClient.disconnect();
        await disconnected;
        assert.equal(await submissionService.fakeSubmission(submission, 9), true);
        const verdict = await submissions.findOneByOrFail({ id: submission.id });
        assert.equal(verdict.status, "Fake");
        assert.equal(verdict.score, 0);
        const offline = sql.reads;
        for (let i = 0; i < 2; i++) assertStatistics(await readAll(writerStats, problem), submission.id, false);
        assert.equal(sql.reads - offline, 2 * (rankings.length + 1), "each offline read queried MariaDB");

        await writerClient.connect();
        assertStatistics(await readAll(writerStats, problem), submission.id, false);
        const regenerated = sql.reads;
        assertStatistics(await readAll(readerStats, problem), submission.id, false);
        assert.equal(sql.reads, regenerated, "reconnected values stayed cached");
        assert.deepEqual(await submissions.findOneByOrFail({ id: submission.id }), verdict);
      }
    );
  }
);
