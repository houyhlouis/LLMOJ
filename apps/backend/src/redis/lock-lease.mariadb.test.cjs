const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const Redis = require("ioredis");
const { DataSource } = require("typeorm");
const { redisAvailable, startRedisFixture } = require("../../test/temporary-redis.cjs");
require("./register-typescript.cjs");
const { LockService } = require("./lock.service.ts");
const { LockLeaseLostError, LOCK_TTL } = require("./lock-lease.ts");
const { LockLeaseSubscriber } = require("./lock-lease.subscriber.ts");
const { MetricsService } = require("../metrics/metrics.service.ts");
const { UserEntity } = require("../user/user.entity.ts");
const { UserAuthEntity } = require("../auth/user-auth.entity.ts");
const { ProblemEntity } = require("../problem/problem.entity.ts");
const { ProblemJudgeInfoEntity } = require("../problem/problem-judge-info.entity.ts");
const { ProblemSampleEntity } = require("../problem/problem-sample.entity.ts");
const { ProblemLockService } = require("../problem/problem-lock.service.ts");
const { ProblemTypeTraditionalService } = require("../problem-type/types/traditional/problem-type.service.ts");
const { SubmissionEntity } = require("../submission/submission.entity.ts");
const { SubmissionDetailEntity } = require("../submission/submission-detail.entity.ts");
const { SubmissionService } = require("../submission/submission.service.ts");
const { SubmissionJudgingService } = require("../submission/submission-judging.service.ts");
const { StatisticsOutboxService } = require("../submission/statistics-outbox.service.ts");
const { StatisticsOutboxEntity } = require("../submission/statistics-outbox.entity.ts");
const { JudgeQueueService, JudgeTask } = require("../judge/judge-queue.service.ts");
const { JudgeJobEntity, JudgeJobAttemptEntity } = require("../judge/judge-job.entity.ts");
const { SelfEvalSetEntity } = require("../self-eval/self-eval.entity.ts");
const { SelfEvalService } = require("../self-eval/self-eval.service.ts");

const configPath = process.env.LLMOJ_LOCK_LEASE_TEST_DB_CONFIG;
// The durable queue's poll uses its actual table names. The suite owns an empty, dedicated database.
const entities = [
  UserEntity,
  UserAuthEntity,
  ProblemEntity,
  ProblemJudgeInfoEntity,
  ProblemSampleEntity,
  SubmissionEntity,
  SubmissionDetailEntity,
  JudgeJobEntity,
  JudgeJobAttemptEntity,
  StatisticsOutboxEntity,
  SelfEvalSetEntity
];

async function database() {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")).services.database;
  assert.equal(config.database, "llmoj_test_lock_lease", "Use the disposable lease test database");
  return new DataSource({ ...config, entities, subscribers: [LockLeaseSubscriber], synchronize: false }).initialize();
}

function backend(db, redis) {
  const redisService = { getClient: options => redis.duplicate(options) };
  const config = { config: { preference: { serverSideOnly: { dynamicTaskPriority: false } } } };
  const locks = new LockService(redisService);
  const problems = new ProblemLockService(db.getRepository(ProblemEntity), locks);
  const queue = new JudgeQueueService(db, redisService, new MetricsService(config));
  const outbox = new StatisticsOutboxService(db, redisService);
  const submissionType = new ProblemTypeTraditionalService(config);
  const judging = Object.assign(Object.create(SubmissionJudgingService.prototype), {
    configService: config,
    judgeQueueService: queue,
    problemDataVersionService: { current: async () => null }
  });
  const submissions = Object.assign(Object.create(SubmissionService.prototype), {
    connection: db,
    submissionJudgingService: judging,
    statisticsOutboxService: outbox,
    judgeQueueService: queue,
    problemTypeFactoryService: { type: () => submissionType }
  });
  const create = problem =>
    submissions.createSubmission({ id: problem.ownerId }, problem, { language: "cpp", code: "0" });
  return { locks, problems, queue, outbox, create };
}

async function pausedHolder(port, problemId) {
  const db = await database();
  const redis = new Redis({ host: "127.0.0.1", port });
  const { locks, problems, queue, outbox, create } = backend(db, redis);
  try {
    const record = outbox.record.bind(outbox);
    outbox.record = async (...args) => {
      const ids = await record(...args);
      assert.equal(ids.length, 2);
      // createSubmission has staged its two rows, durable job and count deltas. Its next step is COMMIT.
      await new Promise((resolve, reject) => process.send("staged", error => (error ? reject(error) : resolve())));
      process.kill(process.pid, "SIGSTOP");
      return ids;
    };
    const checked = Promise.withResolvers();
    const outcome = problems.lockProblemById(problemId, "Read", problem => {
      const writes = (async () => {
        await assert.rejects(create(problem), LockLeaseLostError);
        // Even if the outer operation already reported loss, an autocommit UPDATE from its callback is fenced.
        await assert.rejects(db.manager.update(ProblemEntity, problemId, { difficulty: 9 }), LockLeaseLostError);
      })();
      writes.then(checked.resolve, checked.reject);
      return writes;
    });
    await Promise.all([assert.rejects(outcome, LockLeaseLostError), checked.promise]);
  } finally {
    locks.onModuleDestroy();
    queue.onModuleDestroy();
    redis.disconnect();
    await db.destroy();
  }
}

async function restartedHolder(port, scope) {
  const db = await database();
  let client;
  const locks = new LockService({
    getClient(options) {
      client = new Redis({ host: "127.0.0.1", port, ...options });
      client.on("error", () => {}); // A connection refusal is expected while the server is restarting.
      return client;
    }
  });
  const key = `SelfEvalSet_${scope}`;
  const sets = db.getRepository(SelfEvalSetEntity);
  try {
    const checked = Promise.withResolvers();
    const outcome = locks.lock(key, lease => {
      // This connection already acquired the lock. Its next "ready" will be from the fresh server.
      const reconnected = new Promise(resolve => client.once("ready", resolve));
      const transaction = db.transaction("READ COMMITTED", async manager => {
        await manager.update(SelfEvalSetEntity, { scope }, { message: "old owner" });
        assert.equal((await manager.findOneByOrFail(SelfEvalSetEntity, { scope })).message, "old owner");
        const resume = once(process, "message");
        process.send("staged");
        const [message] = await resume;
        assert.equal(message, "restarted");
        await reconnected;
        assert.ok(lease.signal.reason instanceof LockLeaseLostError);
        assert.equal(lease.signal.reason.code, "LOCK_LEASE_LOST");
        // Returning would commit the staged change. The subscriber must still fence this old callback.
      });
      const verify = assert.rejects(transaction, LockLeaseLostError);
      verify.then(checked.resolve, checked.reject);
      return verify;
    });
    await Promise.all([assert.rejects(outcome, LockLeaseLostError), checked.promise]);
    assert.equal((await sets.findOneByOrFail({ scope })).message, null);
    await locks.lock(key, () =>
      db.transaction(manager => manager.update(SelfEvalSetEntity, { scope }, { message: "new owner" }))
    );
    assert.equal((await sets.findOneByOrFail({ scope })).message, "new owner");
  } finally {
    locks.onModuleDestroy();
    await db.destroy();
  }
}

function holder(t, mode, port, id) {
  const child = fork(__filename, [mode, String(port), String(id)], { execArgv: ["--unhandled-rejections=strict"] });
  const childExit = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await childExit;
  });
  return { child, childExit };
}

function pendingSet(db, scope) {
  return db.manager.save(SelfEvalSetEntity, {
    scope,
    problemId: 1,
    recipeHash: "r",
    configHash: "c",
    snapshot: {},
    status: "Pending",
    taskId: randomUUID(),
    createdAt: new Date()
  });
}

async function blockedUpdate(db, redis, locks) {
  const { scope, taskId } = await pendingSet(db, "lease-wait");
  const sets = db.getRepository(SelfEvalSetEntity);
  const acquired = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const selfEval = Object.assign(Object.create(SelfEvalService.prototype), {
    db,
    locks: {
      lock: (name, callback) =>
        locks.lock(name, async lease => {
          acquired.resolve(lease);
          try {
            return await callback(lease);
          } finally {
            finished.resolve();
          }
        })
    }
  });
  const blocker = db.createQueryRunner();
  await blocker.startTransaction();
  let result;
  try {
    await blocker.manager.findOneOrFail(SelfEvalSetEntity, { where: { scope }, lock: { mode: "pessimistic_write" } });
    result = selfEval.onTaskFailed(taskId, "obsolete").then(
      () => null,
      error => error
    );
    const lease = await Promise.race([
      acquired.promise,
      result.then(error => {
        throw error ?? Error("missing lease");
      })
    ]);
    const deadline = Date.now() + 10000;
    // Same account, same database. Seeing the SQL on the server proves it got past the pre-query lease check.
    while (
      !(
        await db.query(
          "SELECT 1 FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID() AND INFO LIKE ?",
          ["UPDATE `self_eval_set` SET %"]
        )
      ).length
    ) {
      assert.ok(Date.now() < deadline, "the self-evaluation UPDATE never reached MariaDB");
      await delay(20);
    }
    lease.assertHeld();
    assert.equal(await redis.del(`SelfEvalSet_${scope}`), 1);
    if (!lease.signal.aborted) await once(lease.signal, "abort", { signal: AbortSignal.timeout(8000) });
  } finally {
    try {
      await blocker.rollbackTransaction();
    } finally {
      await blocker.release();
    }
  }
  assert.ok((await result) instanceof LockLeaseLostError);
  await finished.promise;
  const unchanged = await sets.findOneByOrFail({ scope });
  assert.equal(unchanged.status, "Pending");
  assert.equal(unchanged.taskId, taskId);
  assert.equal(unchanged.message, null);
  await selfEval.onTaskFailed(taskId, "retry");
  const retried = await sets.findOneByOrFail({ scope });
  assert.equal(retried.status, "SystemError");
  assert.equal(retried.taskId, null);
  assert.equal(retried.message, "retry");
}

async function replacedAtCommit(db, redis, { locks, queue }) {
  const key = "queue-commit";
  const successor = randomUUID();
  const taskId = randomUUID();
  const checked = Promise.withResolvers();
  const outcome = locks.lock(key, lease => {
    const transaction = db.transaction("READ COMMITTED", async manager => {
      await queue.enqueue(taskId, "SelfEval", 1, manager);
      assert.equal(await redis.set(key, successor, "XX", "PX", LOCK_TTL), "OK");
      // The local deadline has not elapsed and the refresh timer has not reported the replacement.
      lease.assertHeld();
    });
    const verify = assert.rejects(transaction, LockLeaseLostError);
    verify.then(checked.resolve, checked.reject);
    return verify;
  });
  await Promise.all([assert.rejects(outcome, LockLeaseLostError), checked.promise]);
  assert.equal(await db.manager.countBy(JudgeJobEntity, { taskId }), 0);
  assert.equal(await redis.get(key), successor);
}

async function replacedBeforeUpdate(db, redis, locks) {
  const { scope } = await pendingSet(db, "lease-replaced");
  const key = `SelfEvalSet_${scope}`;
  const sets = db.getRepository(SelfEvalSetEntity);
  const acquired = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let attempted = false;
  const old = locks
    .lock(key, async lease => {
      acquired.resolve();
      try {
        await resume.promise;
        lease.assertHeld();
        attempted = true;
        await sets.update({ scope }, { message: "obsolete" });
      } finally {
        finished.resolve();
      }
    })
    .then(
      () => null,
      error => {
        acquired.reject(error);
        return error;
      }
    );
  try {
    await acquired.promise;
    assert.equal(await redis.del(key), 1);
    await locks.lock(key, async () => {
      const successor = await redis.get(key);
      assert.ok(successor);
      resume.resolve();
      assert.ok((await old) instanceof LockLeaseLostError);
      await finished.promise;
      assert.ok(attempted, "the UPDATE was attempted inside the old owner's local validity window");
      assert.equal((await sets.findOneByOrFail({ scope })).message, null);
      assert.equal(await redis.get(key), successor);
      await sets.update({ scope }, { message: "fresh" });
    });
  } finally {
    resume.resolve();
  }
  assert.equal((await sets.findOneByOrFail({ scope })).message, "fresh");
}

if (process.argv[2] === "paused-holder" || process.argv[2] === "restarted-holder") {
  const port = Number(process.argv[3]);
  const run =
    process.argv[2] === "paused-holder"
      ? pausedHolder(port, Number(process.argv[4]))
      : restartedHolder(port, process.argv[4]);
  process.exitCode = 1;
  run
    .then(() => {
      process.exitCode = 0;
    })
    .catch(error => {
      console.error(error.stack);
      process.exitCode = 1;
    })
    .finally(() => process.disconnect());
} else {
  const test = require("node:test");
  test(
    "owned leases with MariaDB and Redis",
    {
      skip: (!configPath && "needs LLMOJ_LOCK_LEASE_TEST_DB_CONFIG") || (!redisAvailable && "needs redis-server"),
      timeout: 90000
    },
    async t => {
      const { redis, restart } = await startRedisFixture(t);
      const db = await database();
      let ownsTables = false;
      let services;
      t.after(async () => {
        services?.locks.onModuleDestroy();
        services?.queue.onModuleDestroy();
        try {
          if (ownsTables)
            for (const entity of [...entities].reverse())
              await db.query(`DROP TABLE IF EXISTS \`${db.getMetadata(entity).tableName}\``);
        } finally {
          await db.destroy();
        }
      });
      assert.equal((await db.query("SHOW TABLES")).length, 0, "The lease test database must start empty");
      ownsTables = true;
      await db.synchronize();
      services = backend(db, redis);
      const { locks, problems, queue, outbox, create } = services;
      await t.test("a self-evaluation UPDATE waiting on a row lock rolls back after renewal fails", () =>
        blockedUpdate(db, redis, locks)
      );
      await t.test("a replaced token before the next renewal rolls back the queued job at commit", () =>
        replacedAtCommit(db, redis, services)
      );
      await t.test("an autocommit UPDATE checks Redis while the old owner's local deadline is still valid", () =>
        replacedBeforeUpdate(db, redis, locks)
      );
      await t.test("a fresh Redis on the same port fences an open transaction and accepts a new lease", async t => {
        const { scope } = await pendingSet(db, "lease-restart");
        const key = `SelfEvalSet_${scope}`;
        const { child, childExit } = holder(t, "restarted-holder", redis.options.port, scope);
        const [message] = await Promise.race([once(child, "message"), childExit]);
        assert.equal(message, "staged", "holder exited before staging its update");
        assert.ok(await redis.get(key));
        assert.equal((await db.manager.findOneByOrFail(SelfEvalSetEntity, { scope })).message, null);
        const runId = async () => (await redis.info("server")).match(/^run_id:(\w+)/m)[1];
        const oldRun = await runId();
        await restart();
        assert.notEqual(await runId(), oldRun);
        assert.equal(await redis.exists(key), 0);
        child.send("restarted");
        assert.deepEqual(await childExit, [0, null], "the strict holder must finish all checks and exit normally");
        assert.equal((await db.manager.findOneByOrFail(SelfEvalSetEntity, { scope })).message, "new owner");
        assert.equal(await redis.exists(key), 0);
      });
      await t.test(
        "a stopped reader cannot commit or update after expiry; queue and outbox recover on retry",
        async t => {
          const user = await db.manager.save(UserEntity, {
            username: "lease",
            email: "lease@example.invalid",
            nickname: "",
            bio: "",
            avatarInfo: "gravatar:",
            isAdmin: false,
            acceptedProblemCount: 0,
            submissionCount: 0,
            rating: 0,
            publicEmail: false
          });
          const problem = await db.manager.save(ProblemEntity, {
            ownerId: user.id,
            isPublic: true,
            type: "Traditional",
            locales: ["en_US"],
            difficulty: 3,
            submissionCount: 0,
            acceptedSubmissionCount: 0
          });
          const readerKey = `rwlock-v2:AcquireProblem_${problem.id}:readers`;
          const { child, childExit } = holder(t, "paused-holder", redis.options.port, problem.id);
          const [message] = await Promise.race([once(child, "message"), childExit]);
          assert.equal(message, "staged", "holder exited before its transaction was ready");
          const [oldToken] = await redis.zrange(readerKey, 0, -1);
          assert.ok(oldToken);
          const deadline = Date.now() + 15000;
          await delay(LOCK_TTL + 100);
          while (await redis.exists(readerKey)) {
            assert.ok(Date.now() < deadline, "the stopped reader did not expire");
            await delay(50);
          }

          await problems.lockProblemById(problem.id, "Read", async () => {
            const [newToken] = await redis.zrange(readerKey, 0, -1);
            assert.ok(newToken && newToken !== oldToken);
            assert.ok(child.kill("SIGCONT"));
            assert.deepEqual(await childExit, [0, null]);
            assert.deepEqual(await redis.zrange(readerKey, 0, -1), [newToken]);
            assert.equal((await db.manager.findOneByOrFail(ProblemEntity, { id: problem.id })).difficulty, 3);
            for (const entity of [SubmissionEntity, SubmissionDetailEntity, JudgeJobEntity, StatisticsOutboxEntity])
              assert.equal(await db.manager.count(entity), 0, entity.name);
          });
          assert.equal(await redis.exists(readerKey), 0);

          // A fresh submission commits, then the backend loses its lease just before applying the count records.
          const apply = outbox.apply.bind(outbox);
          outbox.apply = ids => {
            locks.onModuleDestroy();
            return apply(ids);
          };
          await assert.rejects(problems.lockProblemById(problem.id, "Read", create), LockLeaseLostError);
          outbox.apply = apply;
          const [saved] = await db.manager.find(SubmissionEntity);
          assert.ok(saved.taskId);
          assert.equal(await db.manager.count(SubmissionEntity), 1);
          assert.equal(await db.manager.count(SubmissionDetailEntity), 1);
          assert.equal(await db.manager.count(StatisticsOutboxEntity), 2);
          assert.equal((await db.manager.findOneByOrFail(ProblemEntity, { id: problem.id })).submissionCount, 0);
          assert.equal((await db.manager.findOneByOrFail(JudgeJobEntity, { taskId: saved.taskId })).state, "Queued");

          // A retransmitted enqueue and a second poll can only give this task to one consumer.
          await queue.enqueue(saved.taskId, "Submission", 1);
          assert.equal(await db.manager.count(JudgeJobEntity), 1);
          queue.registerTaskType("Submission", {
            getTaskToBeSentToJudgeByTaskId: async (id, priority) =>
              (await db.manager.existsBy(SubmissionEntity, { taskId: id }))
                ? new JudgeTask(id, "Submission", 1, priority, {})
                : null
          });
          const consumer = { connectionId: "recovery", judgeClientId: 1 };
          assert.equal((await queue.claim(consumer, ["Submission"])).task.taskId, saved.taskId);
          assert.equal(await queue.claim(consumer, ["Submission"]), null);
          assert.equal(await db.manager.count(JudgeJobAttemptEntity), 1);
          assert.equal(await outbox.replay(-1000), 2);
          assert.equal(await outbox.replay(-1000), 0);
          assert.equal((await db.manager.findOneByOrFail(ProblemEntity, { id: problem.id })).submissionCount, 1);
          assert.equal((await db.manager.findOneByOrFail(UserEntity, { id: user.id })).submissionCount, 1);
        }
      );
    }
  );
}
