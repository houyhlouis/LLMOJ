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

  // The result is stored with the job's completion
  let confirmed = 0;
  const result = complete({ "1.in": "1 2\n", "1.out": "3\n" });
  assert.equal(await service.onTaskProgress(taskId, result, { confirm: async () => ++confirmed > 0 }), true);
  assert.equal(confirmed, 1);
  const message = await running;
  assert.deepEqual(message, {
    validation: { samplesPassed: 1, inputsPassed: 1 },
    requestHash: "h",
    type: "complete",
    directory: service.outputDirectory(job.id),
    files: ["1.in", "1.out"]
  });
  assert.equal(fs.readFileSync(path.join(message.directory, "1.in"), "utf8"), "1 2\n");
  assert.equal(await row(taskId), null, "collected");
  assert.equal([...objects.keys()].filter(name => name.includes(taskId)).length, 0);
  await service.cleanup(job.id);
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

  // After a restart, the job's new run replaces the old one
  job = { id: crypto.randomUUID() };
  const first = await start(job);
  const second = await start(job);
  assert.equal((await row(first.taskId)).state, "Canceled");
  assert(gateway.canceled.includes(first.taskId));
  assert.equal((await row(second.taskId)).state, "Queued");
  await service.cleanup(job.id);
  assert.equal((await row(second.taskId)).state, "Canceled", "cleanup stops what's left");
  await assert.rejects(second.running, /SANDBOX_DISCONNECTED/);
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
  const [stale, active, oldFinished, recentFinished] = Array.from({ length: 4 }, () => crypto.randomUUID());
  await add(stale, "Running", 6 * hour);
  await add(active, "Running", hour);
  await add(oldFinished, "Complete", 3 * hour, 2 * hour);
  await add(recentFinished, "Failed", hour, 0.5 * hour);
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
  assert.deepEqual([...objects.keys()].sort(), [orphanNew, `temporary/ai-execution/${active}/request.json`].sort());
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
  const { AiService } = require("./ai.service.ts");
  const service = Object.create(AiService.prototype);
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
