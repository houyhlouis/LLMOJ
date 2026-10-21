/* The durable judge queue on a disposable MariaDB database and a temporary redis-server; never a production database.
 * A "backend crash" is a queue instance dropped at some point: everything it knew lives in the database. */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
require("@nestjs/common").Logger.overrideLogger(false);
const Redis = require("ioredis");
const { DataSource } = require("typeorm");
const { JudgeJobEntity, JudgeJobAttemptEntity } = require("./judge-job.entity.ts");
const { JudgeQueueService, isFinalProgress } = require("./judge-queue.service.ts");

const configPath = process.env.LLMOJ_JUDGE_QUEUE_TEST_DB_CONFIG;
const redisAvailable = spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;
const skip = (!configPath || !redisAvailable) && "needs LLMOJ_JUDGE_QUEUE_TEST_DB_CONFIG and redis-server";

test("results are recognized in both progress formats", () => {
  assert.equal(isFinalProgress({ progressType: "Finished", status: "Accepted" }), true);
  assert.equal(isFinalProgress({ progressType: "Running" }), false);
  assert.equal(isFinalProgress({ status: "Success", finished: true }), true);
  assert.equal(isFinalProgress({ status: "Running", finished: false }), false);
  assert.equal(isFinalProgress(null), false);
});

async function startRedis(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-judge-queue-redis-"));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  const child = spawn(
    "redis-server",
    ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", directory],
    { stdio: "ignore" }
  );
  t.after(() => {
    child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (let attempt = 0; ; attempt++) {
    const listening = await new Promise(resolve => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (listening) break;
    if (attempt > 50) throw new Error("redis-server did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const clients = [];
  t.after(() => clients.forEach(client => client.disconnect()));
  return {
    getClient() {
      const client = new Redis({ port, host: "127.0.0.1" });
      clients.push(client);
      return client;
    }
  };
}

const metrics = () => {
  const observed = [];
  const histogram = () => ({ observe: (labels, value) => observed.push(value) });
  histogram.BUCKETS_TIME_10M_30 = [];
  return { histogram, gauge: () => ({ set() {} }), observed };
};

/**
 * Stands in for a task service: a task is active while `active` has it, and its result is stored in
 * `qa_judge_result` by the transaction that confirms the job.
 */
function fakeTaskService(ds) {
  const service = {
    active: new Map(),
    failed: [],
    prepare: taskId => ({ taskId, type: "Submission", priorityType: 1, priority: 1, extraInfo: { taskId } }),
    async getTaskToBeSentToJudgeByTaskId(taskId) {
      return service.active.has(taskId) ? service.prepare(taskId) : null;
    },
    async onTaskProgress(taskId, progress, completion) {
      if (!service.active.has(taskId)) return false;
      if (!completion) return true;
      return await ds.transaction(async manager => {
        if (!(await completion.confirm(manager))) return false;
        await manager.query("INSERT INTO qa_judge_result (taskId, result) VALUES (?, ?)", [taskId, progress.status]);
        service.active.delete(taskId);
        return true;
      });
    },
    async listActiveTasks() {
      return [...service.active].map(([taskId, priority]) => ({ taskId, priority }));
    },
    async onTaskFailed(taskId, message) {
      if (service.active.delete(taskId)) service.failed.push([taskId, message]);
    }
  };
  return service;
}

const result = status => ({ progressType: "Finished", status, score: 0, totalOccupiedTime: 1 });
const meta = taskId => ({ taskId, type: "Submission" });

test(
  "durable judge queue: ordering, single lease, fenced results, recovery after crashes",
  { skip, timeout: 120000 },
  async t => {
    const database = JSON.parse(fs.readFileSync(configPath, "utf8")).services.database;
    assert.match(database.database, /^llmoj_test_judge_queue$/, "Use only the dedicated disposable test database");
    const redisService = await startRedis(t);
    const ds = new DataSource({
      ...database,
      entities: [JudgeJobEntity, JudgeJobAttemptEntity],
      synchronize: false,
      logging: false
    });
    await ds.initialize();
    assert.equal((await ds.query("SHOW TABLES")).length, 0, "Test database must be empty; no table is removed");
    t.after(async () => {
      for (const table of ["judge_job", "judge_job_attempt", "qa_judge_result"])
        await ds.query(`DROP TABLE IF EXISTS \`${table}\``);
      await ds.destroy();
    });
    await ds.synchronize();
    await ds.query("CREATE TABLE qa_judge_result (taskId char(36) NOT NULL, result varchar(32) NOT NULL)");

    const tasks = fakeTaskService(ds);
    const instances = [];
    const backend = async () => {
      const metric = metrics();
      const queue = new JudgeQueueService(ds, redisService, metric);
      queue.registerTaskType("Submission", tasks);
      queue.registerTaskType("Hack", tasks);
      await queue.onModuleInit();
      instances.push(queue);
      return Object.assign(queue, { observed: metric.observed });
    };
    t.after(() => instances.forEach(queue => queue.onModuleDestroy()));
    const job = async taskId => (await ds.query("SELECT * FROM judge_job WHERE taskId = ?", [taskId]))[0];
    const attempts = async taskId =>
      (await ds.query("SELECT fence, outcome FROM judge_job_attempt WHERE taskId = ? ORDER BY fence", [taskId])).map(
        row => [Number(row.fence), row.outcome]
      );
    const results = async taskId =>
      (await ds.query("SELECT result FROM qa_judge_result WHERE taskId = ?", [taskId])).map(row => row.result);
    const newTask = async (queue, priority = 1, manager = undefined) => {
      const taskId = crypto.randomUUID();
      tasks.active.set(taskId, priority);
      await queue.enqueue(taskId, "Submission", priority, manager);
      return taskId;
    };
    const owner = id => ({ connectionId: `socket-${id}`, judgeClientId: id });
    const lease = (claimed, id) => ({ fence: claimed.fence, connectionId: `socket-${id}` });
    const report = async (queue, taskId, claimed, id, progress) =>
      await queue.onTaskProgress(meta(taskId), lease(claimed, id), progress);

    // The old Redis sorted set is moved to the durable queue when a backend starts.
    const legacy = crypto.randomUUID();
    tasks.active.set(legacy, 0.25);
    const redis = redisService.getClient();
    await redis.zadd("judge-queue", 0.25, JSON.stringify({ taskId: legacy, type: "Submission" }));
    await redis.zadd("judge-queue", 0.3, "not json");
    const a = await backend();
    assert.equal(await redis.exists("judge-queue"), 0);
    assert.equal((await job(legacy)).state, "Queued");
    assert.equal(Number((await job(legacy)).priority), 0.25);

    // Order: priority, then creation time. A claim leases the job with fence 1 and records the attempt.
    const later = await newTask(a, 2);
    const sooner = await newTask(a, 1);
    let claimed = await a.claim(owner(1));
    assert.equal(claimed.task.taskId, legacy);
    claimed = await a.claim(owner(1));
    assert.equal(claimed.task.taskId, sooner);
    assert.equal(claimed.fence, 1);
    assert.equal(a.observed.length, 2, "queue time is observed per claim");
    const soonerJob = await job(sooner);
    assert.equal(soonerJob.state, "Leased");
    assert.equal(soonerJob.leaseOwner, "socket-1");
    assert.equal(Number(soonerJob.judgeClientId), 1);
    assert.deepEqual(await attempts(sooner), [[1, null]]);

    // The lease holder's result is stored with the job's completion. Sent again, it's acknowledged again but
    // stored once; a different result for the finished job is refused.
    assert.equal(await report(a, sooner, claimed, 1, { progressType: "Running" }), true);
    assert.equal(await report(a, sooner, claimed, 1, result("Accepted")), true);
    assert.equal((await job(sooner)).state, "Finished");
    assert.match((await job(sooner)).resultHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(await attempts(sooner), [[1, "Finished"]]);
    assert.equal(await report(a, sooner, claimed, 1, result("Accepted")), true);
    assert.equal(await report(a, sooner, claimed, 1, result("WrongAnswer")), false);
    assert.deepEqual(await results(sooner), ["Accepted"]);

    // The runtime the judge client announced is recorded with its lease and passed on with the result. A task is
    // sent with the recorded content hashes of the files it uses; the hashes its service gives are kept.
    const hashedTask = await newTask(a, 0.1);
    const [pinned, recorded, unrecorded] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const prepare = tasks.prepare;
    tasks.prepare = taskId => ({
      ...prepare(taskId),
      extraInfo: { taskId, testData: { "1.in": pinned, "2.in": recorded, "3.in": unrecorded } },
      fileHashes: { [pinned]: "a".repeat(64) }
    });
    const lookups = [];
    a.fileService = {
      getContentHashes: async uuids => {
        lookups.push(uuids);
        return { [pinned]: "f".repeat(64), [recorded]: "b".repeat(64) };
      }
    };
    const hashedClaim = await a.claim({ ...owner(5), judgeRuntimeId: 9 });
    tasks.prepare = prepare;
    delete a.fileService;
    assert.equal(hashedClaim.task.taskId, hashedTask);
    assert.deepEqual(hashedClaim.task.fileHashes, { [pinned]: "a".repeat(64), [recorded]: "b".repeat(64) });
    assert.deepEqual(new Set(lookups[0]), new Set([hashedTask, pinned, recorded, unrecorded]));
    const [hashedAttempt] = await ds.query("SELECT judgeRuntimeId FROM judge_job_attempt WHERE taskId = ?", [
      hashedTask
    ]);
    assert.equal(Number(hashedAttempt.judgeRuntimeId), 9);
    const onTaskProgress = tasks.onTaskProgress;
    let completionRuntime;
    tasks.onTaskProgress = async (taskId, progress, completion) => {
      completionRuntime = completion?.judgeRuntimeId;
      return await onTaskProgress(taskId, progress, completion);
    };
    assert.equal(
      await a.onTaskProgress(meta(hashedTask), { ...lease(hashedClaim, 5), judgeRuntimeId: 9 }, result("Accepted")),
      true
    );
    tasks.onTaskProgress = onTaskProgress;
    assert.equal(completionRuntime, 9);
    assert.equal((await job(hashedTask)).state, "Finished");
    // Without an announced runtime, none is recorded
    assert.equal(
      (await ds.query("SELECT judgeRuntimeId FROM judge_job_attempt WHERE taskId = ?", [sooner]))[0].judgeRuntimeId,
      null
    );

    // A judge client disconnects: its job is queued again. A second backend judges it with fence 2, and the old
    // connection's result is refused.
    claimed = await a.claim(owner(1));
    assert.equal(claimed.task.taskId, later);
    await a.release(later, claimed.fence, "socket-1", "Disconnected");
    assert.equal((await job(later)).state, "Queued");
    assert.equal(Number((await job(later)).unfinishedLeases), 1);
    const b = await backend();
    const second = await b.claim(owner(2));
    assert.equal(second.task.taskId, later);
    assert.equal(second.fence, 2);
    assert.equal(await report(a, later, claimed, 1, result("Accepted")), false);
    assert.equal(await report(b, later, second, 2, result("WrongAnswer")), true);
    assert.deepEqual(await results(later), ["WrongAnswer"]);
    assert.deepEqual(await attempts(later), [
      [1, "Disconnected"],
      [2, "Finished"]
    ]);
    // Releasing a finished lease (e.g. on a late disconnect) changes nothing
    await b.release(later, second.fence, "socket-2", "Disconnected");
    assert.equal((await job(later)).state, "Finished");

    // The lease changes after the result was checked but before its transaction commits: nothing is stored.
    const raced = await newTask(a);
    claimed = await a.claim(owner(1));
    assert.equal(claimed.task.taskId, raced);
    const originalProgress = tasks.onTaskProgress;
    tasks.onTaskProgress = async (taskId, progress, completion) => {
      await a.release(taskId, claimed.fence, "socket-1", "Expired");
      return await originalProgress(taskId, progress, completion);
    };
    assert.equal(await report(a, raced, claimed, 1, result("Accepted")), false);
    tasks.onTaskProgress = originalProgress;
    assert.deepEqual(await results(raced), []);
    assert.equal((await job(raced)).state, "Queued");
    await a.cancel(raced);
    tasks.active.delete(raced);

    // Many consumers at once: every job is leased exactly once.
    const many = [];
    for (let i = 0; i < 25; i++) many.push(await newTask(a, 1 + i / 100));
    const claims = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).claim(owner(100 + i))));
    const leased = claims.filter(Boolean).map(value => value.task.taskId);
    assert.equal(leased.length, 25);
    assert.deepEqual([...leased].sort(), [...many].sort());
    assert.equal(
      Number((await ds.query("SELECT COUNT(*) AS n FROM judge_job_attempt WHERE taskId IN (?)", [many]))[0].n),
      25
    );
    for (const taskId of many) {
      await a.cancel(taskId);
      tasks.active.delete(taskId);
    }

    // A backend crashes after granting leases: they aren't renewed, expire, and another backend reclaims them.
    // Renewal only extends tasks that reached their judge client.
    const crashed = await newTask(a);
    const orphan = await newTask(a, 1.5);
    claimed = await a.claim(owner(7));
    assert.equal(claimed.task.taskId, crashed);
    assert.equal((await a.claim(owner(7))).task.taskId, orphan);
    await ds.query("UPDATE judge_job SET leaseUntil = NOW(3) - INTERVAL 1 SECOND WHERE taskId IN (?)", [
      [crashed, orphan]
    ]);
    await a.renewLeases([{ taskId: crashed, connectionId: "socket-7" }]);
    await b.reconcile(true);
    assert.equal((await job(crashed)).state, "Leased", "a renewed lease stays");
    assert.equal((await job(orphan)).state, "Queued", "an expired lease is reclaimed");
    assert.deepEqual(await attempts(orphan), [[1, "Expired"]]);
    await ds.query("UPDATE judge_job SET leaseUntil = NOW(3) - INTERVAL 1 SECOND WHERE taskId = ?", [crashed]);
    await b.reconcile(true);
    const reclaimed = await b.claim(owner(8));
    assert.equal(reclaimed.task.taskId, crashed);
    assert.equal(reclaimed.fence, 2);
    assert.equal(await report(b, crashed, reclaimed, 8, result("Accepted")), true);
    const orphanLease = await b.claim(owner(8));
    assert.equal(orphanLease.task.taskId, orphan);
    assert.equal(await report(b, orphan, orphanLease, 8, result("Accepted")), true);

    // A backend crashes after the result commits, before the judge client's acknowledgement: not judged again.
    const committed = await newTask(a);
    claimed = await a.claim(owner(9));
    assert.equal(await report(a, committed, claimed, 9, result("Accepted")), true);
    const c = await backend();
    await c.reconcile(true);
    await a.release(committed, claimed.fence, "socket-9", "Disconnected");
    assert.equal(await c.claim(owner(10)), null);
    assert.equal((await job(committed)).state, "Finished");
    assert.deepEqual(await results(committed), ["Accepted"]);
    await c.cancel(legacy);
    tasks.active.delete(legacy);

    // A task that is no longer active is canceled when it would be sent.
    const gone = await newTask(a);
    tasks.active.delete(gone);
    assert.equal(await a.claim(owner(11)), null);
    assert.equal((await job(gone)).state, "Canceled");

    // Canceling a queued or a leased job; the result of a canceled job is refused.
    const queuedCancel = await newTask(a);
    await a.cancel(queuedCancel);
    assert.equal((await job(queuedCancel)).state, "Canceled");
    const leasedCancel = await newTask(a);
    claimed = await a.claim(owner(12));
    assert.equal(claimed.task.taskId, leasedCancel);
    await a.cancel(leasedCancel);
    assert.deepEqual(await attempts(leasedCancel), [[1, "Canceled"]]);
    assert.equal(await report(a, leasedCancel, claimed, 12, result("Accepted")), false);
    assert.deepEqual(await results(leasedCancel), []);
    tasks.active.delete(queuedCancel);
    tasks.active.delete(leasedCancel);

    // Preparing a task fails: it's retried after a delay, then given up on with a terminal error for its resource.
    const flaky = await newTask(a);
    const originalPrepare = tasks.prepare;
    tasks.prepare = () => {
      throw new Error("database briefly unavailable");
    };
    assert.equal(await a.claim(owner(13)), null);
    let flakyJob = await job(flaky);
    assert.equal(flakyJob.state, "Queued");
    assert.equal(Number(flakyJob.preparationFailures), 1);
    assert.match(flakyJob.lastError, /database briefly unavailable/);
    assert(new Date(flakyJob.availableAt) > new Date(flakyJob.createdAt), "retried after a delay");
    assert.deepEqual(await attempts(flaky), [[1, "NotPrepared"]]);
    assert.equal(await a.claim(owner(13)), null, "not available during the delay");
    assert.equal(Number((await job(flaky)).fence), 1);
    await ds.query("UPDATE judge_job SET availableAt = NOW(3), preparationFailures = 8 WHERE taskId = ?", [flaky]);
    assert.equal(await a.claim(owner(13)), null);
    assert.equal((await job(flaky)).state, "Queued");
    await ds.query("UPDATE judge_job SET availableAt = NOW(3) WHERE taskId = ?", [flaky]);
    assert.equal(await a.claim(owner(13)), null);
    flakyJob = await job(flaky);
    assert.equal(flakyJob.state, "Failed");
    assert.deepEqual(tasks.failed.at(-1), [flaky, flakyJob.lastError]);
    tasks.prepare = originalPrepare;

    // A task whose judging keeps being interrupted is given up on after 5 leases without a result.
    const poison = await newTask(a);
    for (let i = 1; i <= 5; i++) {
      claimed = await a.claim(owner(20 + i));
      assert.equal(claimed.task.taskId, poison);
      await a.release(poison, claimed.fence, `socket-${20 + i}`, "Abandoned");
    }
    assert.equal((await job(poison)).state, "Failed");
    assert.match((await job(poison)).lastError, /interrupted 5 times/);
    assert.equal(tasks.failed.at(-1)[0], poison);

    // Recovery: an active task without a job (e.g. after a crash before it was queued) is queued once it's still
    // missing in the next scan; a resource still waiting for a failed job gets its terminal error again.
    const unqueued = crypto.randomUUID();
    tasks.active.set(unqueued, 1);
    await b.recoverActiveTasks();
    assert.equal(await job(unqueued), undefined, "a task saved just before its job isn't queued twice");
    await b.recoverActiveTasks();
    assert.equal((await job(unqueued)).state, "Queued");
    tasks.active.set(poison, 1);
    await b.recoverActiveTasks(true);
    assert.equal(tasks.active.has(poison), false);
    assert.match(tasks.failed.at(-1)[1], /interrupted 5 times/);

    // A job added in a transaction commits with it, or not at all.
    await assert.rejects(
      ds.transaction(async manager => {
        tasks.active.delete(await newTask(a, 1, manager));
        throw new Error("the resource's transaction failed");
      })
    );
    assert.equal(Number((await ds.query("SELECT COUNT(*) AS n FROM judge_job WHERE state = 'Queued'"))[0].n), 1);

    // A judge client is only sent the task types it can judge.
    const hackTask = crypto.randomUUID();
    tasks.active.set(hackTask, 0.5);
    await a.enqueue(hackTask, "Hack", 0.5);
    assert.equal(await a.claim(owner(30), []), null);
    const submissionOnly = await a.claim(owner(30), ["Submission"]);
    assert.equal(submissionOnly.task.taskId, unqueued, "the Hack task is skipped although it comes first");
    const hackCapable = await a.claim(owner(31), ["Submission", "Hack"]);
    assert.equal(hackCapable.task.taskId, hackTask);
    for (const [taskId, claimed, id] of [
      [unqueued, submissionOnly, 30],
      [hackTask, hackCapable, 31]
    ])
      await a.release(taskId, claimed.fence, `socket-${id}`, "Disconnected");
    await a.cancel(hackTask);
    tasks.active.delete(hackTask);

    // Waiting consumers in other backend processes are woken up by notifications.
    const started = Date.now();
    const woken = c.waitForJobs();
    setTimeout(() => a.notifyJobsAvailable(), 100);
    await woken;
    assert(Date.now() - started < 2000, "woken up before the polling interval");

    // Old finished jobs and attempts are deleted, active ones are kept.
    await ds.query("UPDATE judge_job SET finishedAt = NOW(3) - INTERVAL 31 DAY WHERE taskId = ?", [sooner]);
    await ds.query("UPDATE judge_job_attempt SET startedAt = NOW(3) - INTERVAL 31 DAY WHERE taskId = ?", [sooner]);
    await c.reconcile(true);
    assert.equal(await job(sooner), undefined);
    assert.deepEqual(await attempts(sooner), []);
    assert.equal((await job(unqueued)).state, "Queued");

    // The site administrators' view
    const status = await c.getStatus();
    assert.equal(status.queued, 1);
    assert.equal(status.leased, 0);
    assert.equal(status.failedRecently, 2);
    assert(status.oldestQueuedAt instanceof Date);
    assert(status.jobs.some(value => value.taskId === unqueued && value.state === "Queued"));
    assert(
      status.jobs.some(value => value.taskId === poison && value.state === "Failed" && value.unfinishedLeases === 4)
    );
  }
);

test("job classes follow their priority, including live contests", () => {
  const { judgeTaskPriorityTypeOf, JudgeTaskPriorityType: T } = require("./judge-queue.service.ts");
  const { makeSubmissionPriority } = require("../submission/submission-priority.ts");
  for (const type of [T.LiveContest, T.High, T.Medium, T.Low, T.Lowest]) {
    assert.equal(judgeTaskPriorityTypeOf(makeSubmissionPriority(123456, 9, 900, 10, 3, type)), type);
    assert.equal(judgeTaskPriorityTypeOf(makeSubmissionPriority(1, 0, 0, 0, 0, type)), type);
  }
  // Hacks and self-evaluation add a fraction of their ID
  assert.equal(judgeTaskPriorityTypeOf(T.Low + 987654 / 1e9), T.Low);
  assert.equal(judgeTaskPriorityTypeOf(NaN), T.LiveContest);
  assert.equal(judgeTaskPriorityTypeOf(99), T.Lowest);
});

test(
  "judge queue classes: threads kept for live contests, and aged jobs get every fifth task",
  { skip, timeout: 120000 },
  async t => {
    const database = JSON.parse(fs.readFileSync(configPath, "utf8")).services.database;
    assert.match(database.database, /^llmoj_test_judge_queue$/, "Use only the dedicated disposable test database");
    const redisService = await startRedis(t);
    const ds = new DataSource({
      ...database,
      entities: [JudgeJobEntity, JudgeJobAttemptEntity],
      synchronize: false,
      logging: false
    });
    await ds.initialize();
    assert.equal((await ds.query("SHOW TABLES")).length, 0, "Test database must be empty; no table is removed");
    t.after(async () => {
      for (const table of ["judge_job", "judge_job_attempt", "contest"])
        await ds.query(`DROP TABLE IF EXISTS \`${table}\``);
      await ds.destroy();
    });
    await ds.synchronize();
    // Only what the queue reads of contests
    await ds.query(
      "CREATE TABLE contest (id int NOT NULL PRIMARY KEY, startTime datetime NOT NULL, endTime datetime NOT NULL)"
    );

    const tasks = fakeTaskService(ds);
    const queue = new JudgeQueueService(ds, redisService, metrics());
    queue.registerTaskType("Submission", tasks);
    await queue.onModuleInit();
    t.after(() => queue.onModuleDestroy());
    const owner = { connectionId: "socket-1", judgeClientId: 1 };
    const add = async (name, priority, minutesAgo = 0) => {
      const taskId = crypto.randomUUID();
      tasks.active.set(taskId, priority);
      await queue.enqueue(taskId, "Submission", priority);
      if (minutesAgo)
        await ds.query("UPDATE judge_job SET createdAt = NOW(3) - INTERVAL ? MINUTE WHERE taskId = ?", [
          minutesAgo,
          taskId
        ]);
      return { name, taskId };
    };
    const names = new Map();
    const enqueue = async (name, priority, minutesAgo) => {
      const { taskId } = await add(name, priority, minutesAgo);
      names.set(taskId, name);
    };
    const next = async options => {
      const claimed = await queue.claim(owner, ["Submission"], options);
      return claimed && names.get(claimed.task.taskId);
    };

    // Live contest submissions come before practice, whatever their age
    await enqueue("practice", 1 - 1e-7, 5);
    await enqueue("contest", -1e-7);
    assert.equal(await next(), "contest");
    assert.equal(await next(), "practice");

    // A thread kept for live contests gets nothing else
    await enqueue("rejudge", 2 - 1e-7);
    assert.equal(await next({ liveContestOnly: true }), null);
    await enqueue("contest-2", -1e-7);
    assert.equal(await next({ liveContestOnly: true }), "contest-2");
    assert.equal(await next(), "rejudge");

    // With aging, every fifth task goes to the job waiting longest once it has waited long enough; the others follow
    // the classes. Without aging, the old rejudge waits behind every practice submission.
    queue.claimsSinceAged = 0;
    await enqueue("old-rejudge", 2 - 1e-7, 120);
    for (let i = 0; i < 6; i++) await enqueue(`practice-${i}`, 1 - 1e-7);
    const order = [];
    for (let i = 0; i < 7; i++) order.push(await next({ agingSeconds: 3600 }));
    assert.equal(order.indexOf("old-rejudge"), 4, order.join(" "));
    // A waiting live contest submission is never passed over for an aged job
    queue.claimsSinceAged = 0;
    await enqueue("old-hack", 3 - 1e-7, 120);
    for (let i = 0; i < 4; i++) await enqueue(`practice-late-${i}`, 1 - 1e-7);
    for (let i = 0; i < 4; i++) assert.match(await next({ agingSeconds: 3600 }), /^practice-late-/);
    await enqueue("contest-3", -1e-7);
    assert.equal(await next({ agingSeconds: 3600 }), "contest-3");
    assert.equal(await next({ agingSeconds: 3600 }), "old-hack");
    await enqueue("old-rejudge-2", 2 - 1e-7, 120);
    await enqueue("practice-new", 1 - 1e-7);
    assert.equal(await next({ agingSeconds: 0 }), "practice-new");
    assert.equal(await next({ agingSeconds: 0 }), "old-rejudge-2");

    // Whether a contest is running now
    assert.equal(await queue.liveContestRunning(), false);
    await ds.query("INSERT INTO contest VALUES (1, NOW() - INTERVAL 1 HOUR, NOW() + INTERVAL 1 HOUR)");
    queue.liveContest = null;
    assert.equal(await queue.liveContestRunning(), true);
    await ds.query("UPDATE contest SET endTime = NOW() - INTERVAL 1 MINUTE");
    assert.equal(await queue.liveContestRunning(), true, "read again only after a few seconds");
    queue.liveContest = null;
    assert.equal(await queue.liveContestRunning(), false);
  }
);
