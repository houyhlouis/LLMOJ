/* On a disposable MariaDB database (never a production one): an AI job's programs run on a judge machine through the
 * judge queue and give the job the same result as the local AI runner, with the generated files checked against
 * what the judge reported; and the local runner's socket client. Storage, the queue and the gateway are stand-ins. */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
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
String.prototype.format ||= function format(...args) {
  return require("node:util").format(String(this), ...args);
};
require("@nestjs/common").Logger.overrideLogger(false);
const { DataSource } = require("typeorm");
const { AiExecutionEntity } = require("./ai-execution.entity.ts");
const { AiExecutionService, aiExecutionBudget } = require("./ai-execution.service.ts");
const { aiOperationKey } = require("./ai-operation.ts");
const { AiError } = require("./ai.types.ts");
const { AI_EXECUTION_PROTOCOL_VERSION } = require("@libreoj/judge-protocol");

const configPath = process.env.LLMOJ_OPERATIONS_TEST_DB_CONFIG;
const skip = !configPath && "needs LLMOJ_OPERATIONS_TEST_DB_CONFIG";
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const until = async (condition, what) => {
  for (let i = 0; i < 400; i++) {
    const value = await condition();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

async function fixture(t) {
  const { database } = JSON.parse(fs.readFileSync(configPath, "utf8")).services;
  const ds = new DataSource({ ...database, entities: [AiExecutionEntity], synchronize: true, dropSchema: true, logging: false });
  await ds.initialize();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-ai-execution-"));
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  process.env.LLMOJ_AI_EXECUTION = "judges";
  t.after(async () => {
    await ds.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    delete process.env.LLMOJ_AI_EXECUTION;
  });
  const objects = new Map();
  const modified = new Map();
  const files = {
    putTemporaryObject: async (name, data) => objects.set(name, Buffer.from(data)),
    readObject: async name => {
      if (!objects.has(name)) throw Object.assign(new Error("Not Found"), { code: "NoSuchKey" });
      return objects.get(name);
    },
    listTemporaryObjects: async prefix =>
      [...objects.keys()]
        .filter(name => name.startsWith(prefix))
        .map(name => ({ name, lastModified: modified.get(name) ?? new Date() })),
    removeTemporaryObjects: async names => names.forEach(name => objects.delete(name)),
    signDownloadLink: async ({ uuid, signFor, expiresSeconds }) => `https://storage.invalid/${uuid}?for=${signFor}&expires=${expiresSeconds}`,
    signJudgeUpload: async (name, size) => ({
      uuid: name,
      method: "POST",
      url: "https://storage.invalid/upload",
      extraFormData: { key: name, size: String(size) },
      fileFieldName: "file"
    }),
    downloadFileToPath: async (name, destination, maximumBytes) => {
      const data = objects.get(name);
      if (!data) throw new Error("The specified key does not exist.");
      if (data.length > maximumBytes) throw new Error("FILE_SIZE_LIMIT");
      fs.writeFileSync(destination, data, { flag: "wx" });
      return data.length;
    }
  };
  const queue = {
    services: new Map(),
    enqueued: [],
    registerTaskType(type, service) {
      this.services.set(type, service);
    },
    enqueue: async (taskId, type, priority) => queue.enqueued.push({ taskId, type, priority }),
    notifyJobsAvailable() {}
  };
  const gateway = { canceled: [], cancelTask: taskId => gateway.canceled.push(taskId) };
  const service = new AiExecutionService(ds, files, queue, gateway, { takeTurn: async () => true });
  const row = async taskId => await ds.getRepository(AiExecutionEntity).findOneBy({ taskId });
  return { ds, service, objects, modified, queue, gateway, row, tmp };
}

const sampleUuids = [crypto.randomUUID(), crypto.randomUUID()];
const request = jobId => ({
  operation: "generate",
  jobId,
  cases: [{ subtask: 1, seed: 7 }],
  makeCode: "int main(){}",
  stdCode: "int main(){}",
  stdTimeLimitMs: 1000,
  sampleFiles: [{ inputFile: "1.in", outputFile: "1.out", inputUuid: sampleUuids[0], outputUuid: sampleUuids[1] }]
});
const complete = (contents, overrides = {}) => ({
  finished: true,
  status: "Complete",
  result: { validation: { samplesPassed: 1, inputsPassed: 1 }, requestHash: "h" },
  files: Object.entries(contents).map(([name, data]) => ({ name, size: Buffer.byteLength(data), sha256: sha256(data) })),
  ...overrides
});

test("a job's programs run on a judge machine and give the same result as the local runner", { skip }, async t => {
  const { service, objects, queue, row } = await fixture(t);
  const job = { id: crypto.randomUUID() };
  const progress = [];
  const running = service.run(job, request(job.id), async value => progress.push(value), async () => {});
  const { taskId, type, priority } = await until(() => queue.enqueued[0], "the task");
  assert.equal(type, "AiExecution");
  assert.equal(priority, 4, "after submissions");
  assert.equal(queue.services.get("AiExecution"), service);
  assert.deepEqual(await service.listActiveTasks(), [{ taskId, priority: 4 }]);

  // What the judge machine is sent: the request as the local runner takes it, and the stored sample files
  const task = await service.getTaskToBeSentToJudgeByTaskId(taskId, 4);
  assert.deepEqual(task.extraInfo.request.sampleFiles, [{ inputFile: "1.in", outputFile: "1.out" }]);
  assert.equal(task.extraInfo.request.jobId, job.id);
  // The logical operation it's an attempt of (review Part III, W03), whose key covers the stored sample files
  const key = aiOperationKey(job.id, request(job.id));
  assert.equal(task.extraInfo.request.operationKey, key);
  assert.deepEqual([(await row(taskId)).operationKey, (await row(taskId)).operation], [key, "generate"]);
  assert.deepEqual(task.extraInfo.sampleFiles, [
    { name: "1.in", uuid: sampleUuids[0] },
    { name: "1.out", uuid: sampleUuids[1] }
  ]);
  assert.equal((await row(taskId)).state, "Running");

  assert.equal(await service.onTaskProgress(taskId, { finished: false, phase: "generate", completed: 1, total: 1 }), true);
  await until(() => progress.length, "progress");
  assert.deepEqual(progress, [{ type: "progress", phase: "generate", completed: 1, total: 1 }]);

  // Upload forms only for generated test data, each for its exact size
  for (const refused of [
    [{ name: "../escape", size: 1 }],
    [{ name: "1.in", size: 16 * 1024 * 1024 + 1 }],
    [
      { name: "1.in", size: 1 },
      { name: "1.in", size: 1 }
    ],
    [{ name: "result.json", size: 1 }],
    [{ name: "a/b", size: 1 }],
    []
  ])
    assert.deepEqual(await service.signUploads(taskId, refused), []);
  const targets = await service.signUploads(taskId, [
    { name: "1.in", size: 4 },
    { name: "1.out", size: 2 }
  ]);
  assert.deepEqual(
    targets.map(target => [target.name, target.extraFormData.key, target.extraFormData.size]),
    [
      ["1.in", `temporary/ai-execution/${taskId}/files/1.in`, "4"],
      ["1.out", `temporary/ai-execution/${taskId}/files/1.out`, "2"]
    ]
  );
  objects.set(`temporary/ai-execution/${taskId}/files/1.in`, Buffer.from("1 2\n"));
  objects.set(`temporary/ai-execution/${taskId}/files/1.out`, Buffer.from("3\n"));

  // The result is stored with the job's completion, and the runtime the backend recorded for the judge machine
  let confirmed = 0;
  const result = complete({ "1.in": "1 2\n", "1.out": "3\n" });
  assert.equal(
    await service.onTaskProgress(taskId, result, { confirm: async () => ++confirmed > 0, judgeRuntimeId: 7 }),
    true
  );
  assert.equal(confirmed, 1);
  const message = await running;
  assert.deepEqual(message, {
    validation: { samplesPassed: 1, inputsPassed: 1 },
    requestHash: "h",
    type: "complete",
    directory: service.outputDirectory(job.id),
    files: ["1.in", "1.out"],
    operation: { key, origin: "judge", result: "new", task: taskId, judgeRuntimeId: 7 }
  });
  assert.equal(fs.readFileSync(path.join(message.directory, "1.in"), "utf8"), "1 2\n");
  // Collected, and kept until the job acknowledges it
  assert((await row(taskId)).collectedAt);
  assert.equal([...objects.keys()].filter(name => name.includes(taskId)).length, 3);
  await service.acknowledge(job.id);
  assert.equal(await row(taskId), null);
  assert.equal([...objects.keys()].filter(name => name.includes(taskId)).length, 0);
  assert.equal(fs.existsSync(message.directory), false);
});

test("files that aren't what the judge reported, or that it had no form for, are refused", { skip }, async t => {
  const { service, objects, queue } = await fixture(t);
  for (const [tamper, error] of [
    [objects => objects.set("1.in", "1 3\n"), /INVALID_SANDBOX_FILE/],
    [(objects, result) => result.files.push({ name: "2.in", size: 1, sha256: sha256("x") }), /INVALID_SANDBOX_RESPONSE/],
    [(objects, result) => (result.files[0].sha256 = "nonsense"), /INVALID_SANDBOX_RESPONSE/]
  ]) {
    const job = { id: crypto.randomUUID() };
    const running = service.run(job, request(job.id), async () => {}, async () => {});
    const index = queue.enqueued.length;
    const { taskId } = await until(() => queue.enqueued[index], "the task");
    await service.getTaskToBeSentToJudgeByTaskId(taskId, 4);
    await service.signUploads(taskId, [{ name: "1.in", size: 4 }]);
    const stored = new Map([["1.in", "1 2\n"]]);
    const result = complete({ "1.in": "1 2\n" });
    tamper(stored, result);
    for (const [name, data] of stored) objects.set(`temporary/ai-execution/${taskId}/files/${name}`, Buffer.from(data));
    await service.onTaskProgress(taskId, result, { confirm: async () => true });
    await assert.rejects(running, error);
  }
});

test("failures, cancellation, restarts and obsolete leases", { skip }, async t => {
  const { service, queue, gateway, row } = await fixture(t);
  const start = async (job, checkJob = async () => {}) => {
    const index = queue.enqueued.length;
    const running = service.run(job, request(job.id), async () => {}, checkJob);
    running.catch(() => null);
    const { taskId } = await until(() => queue.enqueued[index], "the task");
    return { running, taskId };
  };

  // The program under test failed: as from the local runner
  let job = { id: crypto.randomUUID() };
  let { running, taskId } = await start(job);
  await service.onTaskProgress(
    taskId,
    { finished: true, status: "Failed", message: "Reference solution failed sample 1", candidateFailure: true },
    { confirm: async () => true }
  );
  await assert.rejects(running, error => {
    assert.equal(error.code, "SANDBOX_GENERATION_FAILED");
    assert.match(error.message, /Reference solution failed sample 1/);
    assert.equal(error.candidateFailure, true);
    return true;
  });

  // A result the judge client no longer holds the lease for is ignored
  job = { id: crypto.randomUUID() };
  ({ running, taskId } = await start(job));
  assert.equal(await service.onTaskProgress(taskId, complete({}), { confirm: async () => false }), false);
  assert.equal((await row(taskId)).state, "Queued");

  // An invalid result counts as a failure
  assert.equal(await service.onTaskProgress(taskId, { finished: true, status: "Weird" }, { confirm: async () => true }), true);
  await assert.rejects(running, /SANDBOX_GENERATION_FAILED: The judge machine sent an invalid result/);

  // The queue gave up on it
  job = { id: crypto.randomUUID() };
  ({ running, taskId } = await start(job));
  await service.onTaskFailed(taskId, "Judging was interrupted 5 times");
  await assert.rejects(running, /Judging was interrupted 5 times/);

  // The job is canceled: so is its run, also on the judge machine
  job = { id: crypto.randomUUID() };
  let canceled = false;
  ({ running, taskId } = await start(job, async () => {
    if (canceled) throw new Error("JOB_CANCELLED");
  }));
  canceled = true;
  await assert.rejects(running, /JOB_CANCELLED/);
  assert.equal((await row(taskId)).state, "Canceled");
  assert(gateway.canceled.includes(taskId));
  assert.equal(await service.getTaskToBeSentToJudgeByTaskId(taskId, 4), null, "not sent any more");
  assert.equal(await service.onTaskProgress(taskId, { finished: false, phase: "generate" }), false);

  // A job that stops waiting because another backend runs it now leaves its run to it
  job = { id: crypto.randomUUID() };
  let lost = false;
  const first = await start(job, async () => {
    if (lost) throw new AiError("JOB_LEASE_LOST");
  });
  lost = true;
  await assert.rejects(first.running, /JOB_LEASE_LOST/);
  assert.equal((await row(first.taskId)).state, "Queued", "not canceled");
  await service.release(job.id);
  assert.equal((await row(first.taskId)).state, "Canceled", "a job that stops without publishing stops its runs");
});

test("old runs and the objects nothing refers to are cleaned up", { skip }, async t => {
  const { ds, service, objects, modified, gateway, row } = await fixture(t);
  const repository = ds.getRepository(AiExecutionEntity);
  const hour = 60 * 60 * 1000;
  const now = Date.now();
  const add = async (taskId, state, createdAgo, finishedAgo) =>
    await repository.insert({
      taskId,
      jobId: crypto.randomUUID(),
      state,
      sampleFiles: [],
      createdAt: new Date(now - createdAgo),
      finishedAt: finishedAgo == null ? null : new Date(now - finishedAgo)
    });
  const [stale, active, oldFinished, recentFinished, keptComplete, oldComplete] = Array.from({ length: 6 }, () =>
    crypto.randomUUID()
  );
  await add(stale, "Running", 6 * hour);
  await add(active, "Running", hour);
  await add(oldFinished, "Canceled", 3 * hour, 2 * hour);
  await add(recentFinished, "Failed", hour, 0.5 * hour);
  // A completed run stays for its job to collect again, for a day
  await add(keptComplete, "Complete", 3 * hour, 2 * hour);
  await add(oldComplete, "Complete", 26 * hour, 25 * hour);
  const orphanOld = `temporary/ai-execution/${crypto.randomUUID()}/request.json`;
  const orphanNew = `temporary/ai-execution/${crypto.randomUUID()}/request.json`;
  for (const [name, age] of [
    [orphanOld, 2 * hour],
    [orphanNew, 0],
    [`temporary/ai-execution/${active}/request.json`, 2 * hour],
    [`temporary/ai-execution/${oldFinished}/1.in`, 2 * hour]
  ]) {
    objects.set(name, Buffer.from("x"));
    modified.set(name, new Date(now - age));
  }
  await service.sweep(now);
  assert.equal((await row(stale)).state, "Canceled");
  assert.deepEqual(gateway.canceled, [stale]);
  assert.equal((await row(active)).state, "Running");
  assert.equal(await row(oldFinished), null);
  assert(await row(recentFinished));
  assert(await row(keptComplete));
  assert.equal(await row(oldComplete), null);
  assert.deepEqual([...objects.keys()].sort(), [orphanNew, `temporary/ai-execution/${active}/request.json`].sort());
});

// How a run of judge protocol version 8 says it made its result
const executionRecord = (overrides = {}) => ({
  contract: AI_EXECUTION_PROTOCOL_VERSION,
  attemptId: crypto.randomUUID(),
  runtime: { judgeProgram: "a".repeat(64), sandboxImage: "bbe9c69b2027", arch: "x64" },
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  reuse: { builds: 0, inputs: 0 },
  ...overrides
});

test(
  "a job that restarts waits for its run again or collects its completed result, and never another operation's",
  { skip },
  async t => {
    const { service, objects, queue, gateway, row } = await fixture(t);
    const job = { id: crypto.randomUUID() };
    // Before the restart: the run is on a judge machine, and its backend stops waiting
    let stopped = false;
    const first = service.run(
      job,
      request(job.id),
      async () => {},
      async () => {
        if (stopped) throw new AiError("JOB_LEASE_LOST");
      }
    );
    const { taskId } = await until(() => queue.enqueued[0], "the task");
    await service.getTaskToBeSentToJudgeByTaskId(taskId, 4);
    stopped = true;
    await assert.rejects(first, /JOB_LEASE_LOST/);

    // After it, the same operation waits for the same run: no new task
    const progress = [];
    const second = service.run(job, request(job.id), async value => progress.push(value), async () => {});
    await service.onTaskProgress(taskId, { finished: false, phase: "generate", completed: 1, total: 1 });
    await until(() => progress.length, "the same run's progress");
    await service.signUploads(taskId, [
      { name: "1.in", size: 4 },
      { name: "1.out", size: 2 }
    ]);
    objects.set(`temporary/ai-execution/${taskId}/files/1.in`, Buffer.from("1 2\n"));
    objects.set(`temporary/ai-execution/${taskId}/files/1.out`, Buffer.from("3\n"));
    const made = complete({ "1.in": "1 2\n", "1.out": "3\n" });
    made.result.execution = executionRecord();
    await service.onTaskProgress(taskId, made, { confirm: async () => true });
    const resumed = await second;
    assert.deepEqual([resumed.operation.result, resumed.operation.task], ["resumed", taskId]);
    assert.equal(queue.enqueued.length, 1);

    // The job stops before it publishes (it restarts again, or its publication fails): its completed result stays,
    // and the same operation collects it again instead of making new test data
    await service.release(job.id);
    assert.equal((await row(taskId)).state, "Complete");
    const again = await service.run(job, request(job.id), async () => {}, async () => {});
    assert.equal(again.operation.result, "collected-again");
    assert.deepEqual(again.execution, made.result.execution);
    assert.equal(fs.readFileSync(path.join(again.directory, "1.in"), "utf8"), "1 2\n");
    assert.equal(queue.enqueued.length, 1, "not made again");

    // Another operation of the job (e.g. a retry with a new reference solution) never takes it: it's removed
    const other = service.run(job, { ...request(job.id), stdCode: "int main(){return 1;}" }, async () => {}, async () => {});
    other.catch(() => {});
    const next = await until(() => queue.enqueued[1], "a new task");
    assert.equal(await row(taskId), null);
    assert.equal([...objects.keys()].filter(name => name.includes(taskId)).length, 0);
    // And back: the other operation's unfinished run is stopped, not attached to
    const back = service.run(job, request(job.id), async () => {}, async () => {});
    back.catch(() => {});
    await until(() => queue.enqueued[2], "another new task");
    assert.equal((await row(next.taskId)).state, "Canceled");
    assert(gateway.canceled.includes(next.taskId));
    // A canceled job keeps nothing
    await service.discard(job.id);
    await assert.rejects(back, /SANDBOX_DISCONNECTED/);
    assert.equal((await service.workflowRuns(job.id)).length, 0);
  }
);

test("a result made under an older contract, or a run from before logical operations, is never collected", { skip }, async t => {
  const { ds, service, queue, gateway, row } = await fixture(t);
  const job = { id: crypto.randomUUID() };
  const repository = ds.getRepository(AiExecutionEntity);
  const [older, legacy] = [crypto.randomUUID(), crypto.randomUUID()];
  const now = new Date();
  await repository.insert({
    taskId: older,
    jobId: job.id,
    state: "Complete",
    sampleFiles: [],
    result: { ...complete({}), result: { execution: executionRecord({ contract: AI_EXECUTION_PROTOCOL_VERSION - 1 }) } },
    createdAt: now,
    finishedAt: now,
    operationKey: aiOperationKey(job.id, request(job.id)),
    operation: "generate"
  });
  await repository.insert({ taskId: legacy, jobId: job.id, state: "Running", sampleFiles: [], createdAt: now });
  const running = service.run(job, request(job.id), async () => {}, async () => {});
  running.catch(() => {});
  await until(() => queue.enqueued[0], "a new task");
  assert.equal(await row(older), null);
  assert.equal((await row(legacy)).state, "Canceled");
  assert(gateway.canceled.includes(legacy));
  await service.discard(job.id);
});

test("a replay runs on a judge machine beside the job's runs, with links to the kept files signed when it's sent", { skip }, async t => {
  const { service, queue, row, objects } = await fixture(t);
  const job = { id: crypto.randomUUID() };
  const transfers = [
    { name: "replay.input", object: "temporary/ai-evidence/x/input", size: 4, sha256: "a".repeat(64) },
    { name: "replay.expected", object: "temporary/ai-evidence/x/expected", size: 2, sha256: "b".repeat(64) }
  ];
  const replayRequest = {
    operation: "replay",
    jobId: job.id,
    stdTimeLimitMs: 1000,
    replay: {
      check: "compare",
      role: "std",
      against: "expected",
      files: { input: "replay.input", expected: "replay.expected" },
      repeat: 3,
      programs: { std: "int main(){}" }
    }
  };
  const runs = [
    { outcome: "failed", kind: "solver_disagreement", verdict: "WA", summary: "" },
    { outcome: "failed", kind: "solver_disagreement", verdict: "WA", summary: "" },
    { outcome: "failed", kind: "solver_disagreement", verdict: "WA", summary: "" }
  ];
  const replaying = service.replay(job, replayRequest, transfers);
  const { taskId } = await until(() => queue.enqueued[0], "the replay");
  assert.equal((await row(taskId)).operation, "replay");
  const task = await service.getTaskToBeSentToJudgeByTaskId(taskId, 4);
  assert.deepEqual(task.extraInfo.request.cases, []);
  assert.deepEqual(task.extraInfo.transfers, [
    { name: "replay.input", size: 4, sha256: "a".repeat(64), url: "https://storage.invalid/temporary/ai-evidence/x/input?for=Judge&expires=21600" },
    { name: "replay.expected", size: 2, sha256: "b".repeat(64), url: "https://storage.invalid/temporary/ai-evidence/x/expected?for=Judge&expires=21600" }
  ]);
  // The job's own run doesn't stop it
  const own = service.run(job, request(job.id), async () => {}, async () => {});
  own.catch(() => {});
  await until(() => queue.enqueued[1], "the job's run");
  assert.equal((await row(taskId)).state, "Running");
  await service.onTaskProgress(
    taskId,
    { finished: true, status: "Complete", result: { replay: { runs }, execution: executionRecord() }, files: [] },
    { confirm: async () => true, judgeRuntimeId: 3 }
  );
  const message = await replaying;
  assert.deepEqual(message.replay.runs, runs);
  assert.deepEqual(
    [message.operation.origin, message.operation.result, message.operation.task, message.operation.judgeRuntimeId],
    ["judge", "new", taskId, 3]
  );
  assert.equal(await row(taskId), null, "a replay leaves nothing");
  assert.equal([...objects.keys()].filter(name => name.includes(taskId)).length, 0);
  // A replay that fails itself
  const failing = service.replay(job, replayRequest, transfers);
  const failed = await until(() => queue.enqueued[2], "another replay");
  await service.onTaskFailed(failed.taskId, "Judging was interrupted 5 times");
  await assert.rejects(failing, /Judging was interrupted 5 times/);
  assert.equal(await row(failed.taskId), null);
  await service.discard(job.id);
});

test("the local runner is used where it is; each job keeps its mode until it's cleaned up", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-ai-runner-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, "ai-runner.sock");
  process.env.HYHOJ_AI_RUNNER_SOCKET = socketPath;
  t.after(() => delete process.env.HYHOJ_AI_RUNNER_SOCKET);
  const service = Object.create(AiExecutionService.prototype);
  Object.assign(service, { modes: new Map() });
  assert.equal(service.mode("a"), "judges", "no local runner");
  const received = [];
  let reply = request => [
    { type: "progress", phase: "compile-make", completed: 0, total: 1 },
    { type: "complete", directory: "/opt/LLMOJ/data/ai-generated/b", files: ["1.in", "1.out"], requestHash: request.jobId }
  ];
  const server = net.createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      received.push(message);
      for (const line of message.operation === "cleanup" ? [{ type: "complete", cleaned: true }] : reply(message))
        socket.write(`${JSON.stringify(line)}\n`);
      socket.end();
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => server.close());
  assert.equal(service.mode("a"), "judges", "kept for the job");
  assert.equal(service.mode("b"), "local");
  process.env.LLMOJ_AI_EXECUTION = "judges";
  assert.equal(service.mode("c"), "judges", "chosen explicitly");
  delete process.env.LLMOJ_AI_EXECUTION;
  assert.equal(service.outputDirectory("b"), path.join(process.env.HYHOJ_AI_GENERATED_DIR || "/opt/LLMOJ/data/ai-generated", "b"));

  const progress = [];
  const job = { id: "b" };
  const message = await service.run(
    job,
    { ...request("b"), sampleFiles: [{ inputFile: "1.in", outputFile: "1.out", inputUuid: "x", outputUuid: "y" }] },
    async value => progress.push(value),
    async () => {}
  );
  assert.deepEqual(received[0].sampleFiles, [{ inputFile: "1.in", outputFile: "1.out" }], "only names, as before");
  assert.deepEqual(progress, [{ type: "progress", phase: "compile-make", completed: 0, total: 1 }]);
  assert.deepEqual(message.files, ["1.in", "1.out"]);

  reply = () => [{ type: "error", message: "Reference solution failed sample 1", candidateFailure: true }];
  await assert.rejects(service.run(job, request("b"), async () => {}, async () => {}), error => {
    assert.equal(error.code, "SANDBOX_GENERATION_FAILED");
    assert.equal(error.candidateFailure, true);
    return true;
  });
  await service.cleanup("b");
  assert.deepEqual(received.at(-1), { operation: "cleanup", jobId: "b" });
  assert.equal(service.modes.has("b"), false);
});

test("a run's time limit follows its number of program runs, as the AI runner's own", () => {
  assert.equal(aiExecutionBudget({ cases: [1, 2], stdTimeLimitMs: 1000 }), 180000 + 2 * 20000);
  assert.equal(aiExecutionBudget({ cases: [1], stdTimeLimitMs: 10000, problemType: "Communication" }), 180000 + 35000);
  assert.equal(aiExecutionBudget({ cases: Array(10000).fill(0), stdTimeLimitMs: 10000 }), 4 * 60 * 60 * 1000);
});

test("for a run on a judge machine, hidden samples are sent as the stored files they are, not downloaded", async () => {
  const { aiServices, bareAiServices } = require("./ai-test-services.cjs");
  const service = bareAiServices();
  const downloads = [];
  Object.assign(service, {
    execution: { mode: () => "judges" },
    problems: {
      getProblemFiles: async () => [
        { filename: "sample.in", uuid: "input-uuid" },
        { filename: "sample.out", uuid: "output-uuid" }
      ]
    },
    files: { downloadFileToPath: async (...args) => downloads.push(args) },
    assertJob: async () => ({})
  });
  const job = { id: crypto.randomUUID() };
  const snapshot = hiddenSamples => ({ judgeInfo: { hiddenSamples } });
  assert.deepEqual(await service.prepareSampleFiles(job, {}, snapshot([{ inputFile: "sample.in", outputFile: "sample.out" }])), {
    files: [{ inputFile: "1.in", outputFile: "1.out", inputUuid: "input-uuid", outputUuid: "output-uuid" }],
    directory: null
  });
  assert.deepEqual(downloads, []);
  await assert.rejects(
    service.prepareSampleFiles(job, {}, snapshot([{ inputFile: "sample.in", outputFile: "missing.out" }])),
    /HIDDEN_SAMPLE_FILE_MISSING/
  );
  assert.deepEqual(await service.prepareSampleFiles(job, {}, snapshot([])), { files: [], directory: null });
});
