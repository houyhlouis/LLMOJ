const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

require("./register-typescript.cjs");
const { LockService } = require("./lock.service.ts");
const { LockLeaseLostError, assertLockLeasesHeld, currentLockLeases } = require("./lock-lease.ts");
const { FileService } = require("../file/file.service.ts");
const { FileEntity } = require("../file/file.entity.ts");
const { ContestProblemService } = require("../contest/contest-problem.service.ts");
const { TestDataRetentionService } = require("../problem/test-data-retention.service.ts");
const { logger } = require("../logger.ts");
const { ProblemArchiveService } = require("../problem/problem-archive.service.ts");
const { ProblemFileService } = require("../problem/problem-file.service.ts");
const { SubmissionJudgingService } = require("../submission/submission-judging.service.ts");
const { JudgeClientService } = require("../judge/judge-client.service.ts");
const { JudgeQueueService } = require("../judge/judge-queue.service.ts");
const { SelfEvalService } = require("../self-eval/self-eval.service.ts");
const { SelfEvalSetEntity } = require("../self-eval/self-eval.entity.ts");
const { JudgeTaskType } = require("@libreoj/judge-protocol");
const { redisAvailable, startRedis } = require("../../test/temporary-redis.cjs");

function lockFixture(callLock = async () => true) {
  const client = Object.assign(new EventEmitter(), {
    defineCommand() {},
    callLock
  });
  return new LockService({ getClient: () => client });
}

function loseLease() {
  currentLockLeases().at(-1).lose(new Error("Injected owner loss"));
}

test("postcommit object cleanup reports a late lease loss after contest and retention operations return", async t => {
  const log = t.mock.method(logger, "error", () => {});
  const slot = {
    id: 7,
    attachments: [
      { filename: "first", uuid: "a" },
      { filename: "second", uuid: "b" }
    ]
  };
  const deferred = [{ uuid: "c", action: "Delete" }];
  const query = { setLock: () => query, where: () => query, getMany: async () => deferred };
  const manager = {
    findOne: async () => slot,
    existsBy: async () => false,
    createQueryBuilder: () => query,
    save: async () => {},
    remove: async () => {},
    delete: async () => {}
  };
  let inTransaction = false;
  const db = {
    transaction: async (...args) => {
      inTransaction = true;
      try {
        return await args.at(-1)(manager);
      } finally {
        inTransaction = false;
      }
    }
  };
  const removals = [];
  const files = {
    deleteFile: async ids => {
      assert.equal(inTransaction, true);
      return () => {
        assert.equal(inTransaction, false);
        const pending = Promise.withResolvers();
        removals.push({ ids, reject: pending.reject });
        return pending.promise;
      };
    }
  };
  const problems = new ContestProblemService(db, { get: async () => ({ manager: true }) }, null, null, null, files);
  const retention = new TestDataRetentionService(db, files, null, null);
  retention.evaluate = async rows => rows;
  assert.deepEqual(await problems.removeAttachment({}, 1, 7, "first"), {});
  assert.deepEqual(await problems.removeProblem({}, 1, 7), {});
  assert.equal(await retention.settle(["c"], Date.now()), 1);
  assert.deepEqual(
    removals.map(removal => removal.ids),
    ["a", ["b"], ["c"]]
  );
  for (const removal of removals) removal.reject(new LockLeaseLostError(new Error("owner expired")));
  await new Promise(setImmediate);
  assert.equal(log.mock.callCount(), 3);
  for (const call of log.mock.calls) assert.match(call.arguments[0], /LockLeaseLostError/);
});

test("rolling back submission cancellation keeps its active job and outbox unchanged; a retry cancels once", async () => {
  const locks = lockFixture();
  const judging = Object.create(SubmissionJudgingService.prototype);
  const state = {
    submission: { id: 17, taskId: "active-task", status: "Pending" },
    jobs: new Set(["active-task"]),
    events: [],
    outbox: [],
    applied: []
  };
  let injectLoss = true;
  Object.assign(judging, {
    lockSubmission: (_submission, _withProblem, callback) =>
      locks.lock("submission", () => callback({ ...state.submission })),
    getSubmissionDetail: async () => ({ submissionId: 17, result: {} }),
    judgeGateway: {
      cancelTask: async taskId => assert.equal(state.jobs.delete(taskId), true)
    },
    connection: {
      transaction: async (_isolation, work) => {
        const manager = {
          pendingOutbox: [],
          save: async row => {
            if (row.id) manager.submission = { ...row };
          }
        };
        await work(manager);
        if (injectLoss) loseLease();
        // The MariaDB suite exercises this commit check through TypeORM's real subscriber.
        assertLockLeasesHeld();
        state.submission = manager.submission;
        state.outbox.push(...manager.pendingOutbox);
      }
    },
    statisticsOutboxService: {
      record: async manager => {
        manager.pendingOutbox.push(29);
        return manager.pendingOutbox;
      },
      apply: async ids => {
        state.applied.push(...ids);
      }
    },
    submissionStatisticsService: { onSubmissionUpdated: async () => {} },
    submissionProgressService: { emitSubmissionEvent: async id => state.events.push(id) }
  });
  await assert.rejects(judging.cancelSubmission(state.submission), LockLeaseLostError);
  assert.equal(state.submission.taskId, "active-task");
  assert.deepEqual([...state.jobs], ["active-task"]);
  assert.deepEqual([state.outbox, state.applied, state.events], [[], [], []]);
  injectLoss = false;
  await judging.cancelSubmission(state.submission);
  await judging.cancelSubmission(state.submission);
  assert.equal(state.submission.status, "Canceled");
  assert.equal(state.jobs.size, 0);
  assert.deepEqual([state.outbox, state.applied, state.events], [[29], [29], [17]]);
});

test("judge failure delivery and recovery report lost ownership and tolerate a stopped lock service", async t => {
  const errors = t.mock.method(logger, "error", () => {});
  t.mock.method(logger, "warn", () => {});
  const job = { taskId: "active", type: JudgeTaskType.Submission, state: "Failed" };
  let cause = new LockLeaseLostError(new Error("service stopping"), "shutdown");
  let deliveries = 0;
  const service = {
    listActiveTasks: async () => [job],
    onTaskFailed: async () => {
      deliveries++;
      throw cause;
    }
  };
  const queue = Object.assign(Object.create(JudgeQueueService.prototype), {
    connection: { query: async () => [job] },
    taskServices: new Map([[job.type, service]])
  });
  await queue.notifyTaskFailed(job.taskId, "interrupted");
  await queue.recoverActiveTasks(true);
  assert.equal(deliveries, 2);
  assert.equal(errors.mock.callCount(), 0);
  cause = new LockLeaseLostError(new Error("owner expired"));
  await queue.notifyTaskFailed(job.taskId, "interrupted");
  await queue.recoverActiveTasks(true);
  assert.equal(deliveries, 4);
  assert.equal(errors.mock.callCount(), 2);
});

test("a fixed self-evaluation set committed before lease loss is recovered exactly once by the judge queue", async () => {
  const sets = [];
  const jobs = new Map();
  let inserts = 0;
  const manager = {
    createQueryBuilder() {
      return {
        insert() {
          return this;
        },
        into() {
          return this;
        },
        values(row) {
          this.row = row;
          return this;
        },
        orIgnore() {
          return this;
        },
        useTransaction(enabled) {
          assert.equal(enabled, true);
          return this;
        },
        async execute() {
          inserts++;
          jobs.set(this.row.taskId, this.row);
        }
      };
    }
  };
  const db = {
    manager,
    query: async () => [...jobs.values()],
    getRepository: entity => ({
      findOneBy: async () => sets[0],
      create: row => row,
      save: async row => {
        sets.push(row);
        loseLease();
      },
      createQueryBuilder: () => ({
        select() {
          return this;
        },
        where() {
          return this;
        },
        getMany: async () => (entity === SelfEvalSetEntity ? sets : [])
      })
    })
  };
  const selfEval = Object.assign(Object.create(SelfEvalService.prototype), { db, locks: lockFixture() });
  const queue = Object.assign(Object.create(JudgeQueueService.prototype), {
    connection: db,
    taskServices: new Map([[JudgeTaskType.SelfEvalPrepare, selfEval]]),
    tasksMissingJobs: new Set(),
    notifyJobsAvailable() {}
  });
  selfEval.queue = queue;
  const ctx = {
    problem: { id: 3 },
    scope: "practice:3",
    recipeHash: "recipe",
    configHash: "config",
    testData: {},
    judgeInfo: { selfEval: { subtaskIds: [1] } }
  };
  await assert.rejects(selfEval.prepareContext(ctx, { id: 2 }, true), LockLeaseLostError);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].status, "Pending");
  assert.equal(jobs.size, 0);
  assert.deepEqual(await selfEval.prepareContext(ctx, { id: 2 }, true), { ok: true });
  await queue.recoverActiveTasks();
  assert.equal(jobs.size, 0);
  await queue.recoverActiveTasks();
  await queue.recoverActiveTasks();
  assert.equal(inserts, 1);
  assert.deepEqual([...jobs.keys()], [sets[0].taskId]);
  assert.equal(jobs.get(sets[0].taskId).state, "Queued");
});

test("file maintenance loses its lease after reading a batch; only a current run removes the orphan", async () => {
  const locks = lockFixture();
  const stored = new Set(["registered", "orphan"]);
  let injectLoss = true;
  const files = Object.assign(Object.create(FileService.prototype), {
    minioClient: {
      listObjectsV2: () => Array.from(stored, name => ({ name, lastModified: new Date(0) })),
      removeObjects: async (_bucket, names) => names.forEach(name => stored.delete(name))
    },
    fileRepository: {
      manager: { findBy: async () => [] },
      find: async () => {
        if (injectLoss) loseLease();
        return [{ uuid: "registered" }];
      }
    }
  });
  const maintain = () => locks.lock("maintenance", () => files.runMaintainceTasks());
  await assert.rejects(maintain(), LockLeaseLostError);
  assert.deepEqual([...stored], ["registered", "orphan"]);
  injectLoss = false;
  assert.deepEqual(await maintain(), { checked: 2, deleted: 1 });
  assert.deepEqual(await maintain(), { checked: 1, deleted: 0 });
  assert.deepEqual([...stored], ["registered"]);
});

test("object upload checks remote ownership even before the first scheduled refresh", async () => {
  let matches = false;
  const locks = lockFixture(async (_key, action) => action !== "check" || matches);
  const stored = new Map([["object", "original"]]);
  const files = Object.assign(Object.create(FileService.prototype), {
    minioClient: { putObject: async (_bucket, key, bytes) => stored.set(key, bytes.toString()) }
  });
  const write = text => locks.lock("upload", () => files.uploadFile("object", Buffer.from(text)));
  await assert.rejects(write("lost"), LockLeaseLostError);
  assert.equal(stored.get("object"), "original");
  matches = true;
  await write("fresh");
  assert.equal(stored.get("object"), "fresh");
});

test("loss while a batch registration commit reply is in flight never removes its registered bytes", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lease-file-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "sample");
  await fs.writeFile(filename, "bytes");
  const locks = lockFixture();
  const received = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const objects = new Map();
  const registered = new Set();
  const files = Object.assign(Object.create(ProblemFileService.prototype), {
    lockManageProblemFile: (_id, _type, work) =>
      locks.lock("files", async () => {
        try {
          return await work({ id: 3 });
        } finally {
          finished.resolve();
        }
      }),
    configService: { config: { resourceLimit: {} } },
    fileService: {
      uploadFile: async (uuid, stream) => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        objects.set(uuid, Buffer.concat(chunks).toString());
      },
      getFileSizes: async () => [],
      deleteUnfinishedUploadedFile: uuid => objects.delete(uuid)
    },
    connection: {
      transaction: async (_isolation, work) => {
        await work({
          findBy: async () => [],
          save: async (entity, row) => {
            if (entity === FileEntity) registered.add(row.uuid);
          }
        });
        // COMMIT was sent under a valid lease. Its acknowledgement arrives only after local expiry.
        loseLease();
        await received.promise;
      }
    }
  });
  await assert.rejects(
    files.addProblemFilesFromDisk({ id: 3 }, "AdditionalFile", [{ filename: "sample", path: filename, size: 5 }], {
      authorize: async () => {},
      noLimit: true
    }),
    LockLeaseLostError
  );
  assert.equal(registered.size, 1);
  assert.equal(objects.get([...registered][0]), "bytes");
  received.resolve();
  await finished.promise;
  assert.equal(objects.get([...registered][0]), "bytes");
});

test("a lost ZIP import discards only its private sealed archive after its download settles", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lease-zip-"));
  const previousDirectory = process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY;
  process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY = directory;
  t.after(async () => {
    if (previousDirectory === undefined) delete process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY;
    else process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY = previousDirectory;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const resumed = Promise.withResolvers();
  const discarded = Promise.withResolvers();
  const registered = new Set(["new-owner-file"]);
  const stored = new Set(registered);
  const imported = [];
  const lease = JSON.stringify({ ownerId: 2, problemId: 7, filename: "input.zip", size: 22, replaceExisting: false });
  let redisClaim = lease;
  const service = Object.assign(Object.create(ProblemArchiveService.prototype), {
    userService: { findUserById: async () => ({ id: 2 }) },
    userPrivilegeService: { userHasPrivilege: async () => true, permissionDecision: async () => true },
    problemAccess: { userHasPermission: async () => true },
    problemService: { findProblemById: async () => ({ id: 7 }) },
    problemFiles: { addProblemFilesFromDisk: async (...args) => imported.push(args) },
    lockService: lockFixture(),
    redisService: {
      cacheGet: async () => redisClaim,
      cacheDelete: async () => {
        redisClaim = null;
      }
    },
    connection: {
      transaction: work => {
        assertLockLeasesHeld();
        return work({});
      }
    },
    fileService: {
      processUploadRequest: async () => {
        registered.add("old-private-copy");
        stored.add("old-private-copy");
        return Object.assign(new FileEntity(), { uuid: "old-private-copy" });
      },
      downloadFileToPath: async () => {
        loseLease();
        await resumed.promise;
        assertLockLeasesHeld();
      },
      deleteFile: async uuid => {
        assert.equal(registered.delete(uuid), true);
        return () => {
          stored.delete(uuid);
          discarded.resolve();
        };
      }
    }
  });
  await assert.rejects(
    service.importTestDataZip(
      { id: 2 },
      { filename: "input.zip", problemId: 7, uploadInfo: { uuid: "upload", size: 22 } }
    ),
    LockLeaseLostError
  );
  assert.ok(registered.has("old-private-copy"));
  // The next owner now has a claim in Redis. Late cleanup must leave it and unrelated files alone.
  redisClaim = "new-claim";
  resumed.resolve();
  await discarded.promise;
  assert.deepEqual([...registered], ["new-owner-file"]);
  assert.deepEqual([...stored], ["new-owner-file"]);
  assert.equal(redisClaim, "new-claim");
  assert.deepEqual(imported, []);
  assert.deepEqual(await fs.readdir(directory), []);
});

test(
  "Redis refuses a judge session write already in flight when its reader expires",
  {
    skip: !redisAvailable && "redis-server is not installed",
    timeout: 30000
  },
  async t => {
    const redis = await startRedis(t);
    const locks = new LockService({ getClient: options => redis.duplicate(options) });
    t.after(() => locks.onModuleDestroy());
    const judges = Object.assign(Object.create(JudgeClientService.prototype), { redis });
    const judge = { id: 19 };
    const key = "judge-client-session-id:19";
    await locks.lock("judge-connect", () =>
      locks.lockReadWrite("judge-config", "Read", async () => {
        await judges.setJudgeClientOnlineSessionId(judge, "current");
        await judges.updateJudgeClientCapabilities(judge, { protocolVersion: 7 });
      })
    );
    assert.equal(await redis.get(key), "current");
    assert.equal(await redis.get("judge-client-capabilities:19"), '{"protocolVersion":7}');
    let dispatched;
    await assert.rejects(
      locks.lockReadWrite("judge-config", "Read", async () => {
        // The local check passes at dispatch. When Redis runs the queued script its own clock has passed the TTL.
        await redis.call("CLIENT", "PAUSE", "5500", "ALL");
        dispatched = judges.setJudgeClientOnlineSessionId(judge, "obsolete");
        await dispatched;
      }),
      LockLeaseLostError
    );
    await assert.rejects(dispatched, LockLeaseLostError);
    assert.equal(await redis.get(key), "current");
    await judges.forgetDisconnectedSession(judge, "obsolete");
    assert.equal(await redis.get(key), "current");
    await locks.lock("judge-connect", () => judges.disconnectJudgeClient(judge));
    assert.equal(await redis.exists(key), 0);
  }
);
