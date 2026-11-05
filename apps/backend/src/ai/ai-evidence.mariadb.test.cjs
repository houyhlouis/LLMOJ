/* Run: LLMOJ_OPERATIONS_TEST_DB_CONFIG=... node --test apps/backend/src/ai/ai-evidence.mariadb.test.cjs */
// Failed AI runs keep their evidence (review Part III, W01): a judge machine's failure survives the run's cleanup and a
// backend restart, evidence is checked and bounded, and only the job's owner, still allowed to run it, can read it.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
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
const { AiObservationEntity } = require("./ai-observation.entity.ts");
const { AiJobEntity } = require("./ai.entity.ts");
const { AiExecutionService } = require("./ai-execution.service.ts");
const { AiError } = require("./ai.types.ts");
const { AiEvidenceService, observationId, EVIDENCE_RETENTION } = require("./ai-evidence.service.ts");
const { textPreview } = require("@libreoj/judge-protocol");

const configPath = process.env.LLMOJ_OPERATIONS_TEST_DB_CONFIG;
const skip = !configPath && "needs LLMOJ_OPERATIONS_TEST_DB_CONFIG";
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const DAY = 24 * 60 * 60 * 1000;
const until = async (condition, what) => {
  for (let i = 0; i < 400; i++) {
    const value = await condition();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// Storage as the services use it, in memory
function storage() {
  const objects = new Map();
  const modified = new Map();
  const read = async source => {
    if (Buffer.isBuffer(source)) return source;
    if (typeof source === "string") return fs.readFileSync(source);
    const chunks = [];
    for await (const chunk of source) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  return {
    objects,
    modified,
    failing: false,
    putTemporaryObject: async (name, data) => objects.set(name, Buffer.from(data)),
    readObject: async name => objects.get(name),
    async uploadFile(name, source) {
      const data = await read(source);
      if (this.failing) throw new Error("storage is down");
      objects.set(name, data);
      return sha256(data);
    },
    readObjectRange: async (name, offset, length) => objects.get(name).subarray(offset, offset + length),
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
    signDownloadLink: async options =>
      `https://storage.invalid/${options.uuid}?expires=${options.expiresSeconds}&name=${options.downloadFilename}`,
    downloadFileToPath: async (name, destination, maximumBytes) => {
      const data = objects.get(name);
      if (!data) throw new Error("The specified key does not exist.");
      if (data.length > maximumBytes) throw new Error("FILE_SIZE_LIMIT");
      fs.writeFileSync(destination, data, { flag: "wx" });
      return data.length;
    }
  };
}

async function fixture(t, mode = "judges") {
  const { database } = JSON.parse(fs.readFileSync(configPath, "utf8")).services;
  const ds = new DataSource({
    ...database,
    entities: [AiExecutionEntity, AiObservationEntity, AiJobEntity],
    synchronize: true,
    dropSchema: true,
    logging: false
  });
  await ds.initialize();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-ai-evidence-"));
  const saved = { TMPDIR: process.env.TMPDIR, HYHOJ_AI_GENERATED_DIR: process.env.HYHOJ_AI_GENERATED_DIR };
  process.env.TMPDIR = tmp;
  process.env.HYHOJ_AI_GENERATED_DIR = path.join(tmp, "generated");
  process.env.LLMOJ_AI_EXECUTION = mode;
  t.after(async () => {
    await ds.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    delete process.env.LLMOJ_AI_EXECUTION;
  });
  const files = storage();
  const queue = {
    enqueued: [],
    registerTaskType() {},
    enqueue: async (taskId, type, priority) => queue.enqueued.push({ taskId, type, priority }),
    notifyJobsAvailable() {}
  };
  const gateway = { canceled: [], cancelTask: taskId => gateway.canceled.push(taskId) };
  const evidence = new AiEvidenceService(ds, files);
  // A backend: what restarting it makes anew
  const backend = () => new AiExecutionService(ds, files, queue, gateway, { takeTurn: async () => true }, evidence);
  const jobs = ds.getRepository(AiJobEntity);
  const job = async (values = {}) =>
    await jobs.save({
      id: crypto.randomUUID(),
      ownerId: 1,
      problemId: 7,
      action: "testdata",
      status: "running",
      runToken: crypto.randomUUID(),
      input: { count: 5 },
      state: {},
      ...values
    });
  const observations = async jobId =>
    await ds.getRepository(AiObservationEntity).find({ where: { jobId }, order: { id: "ASC" } });
  return { ds, files, queue, gateway, evidence, backend, job, jobs, observations, tmp };
}

const request = jobId => ({
  operation: "generate",
  jobId,
  cases: [{ subtask: 1, seed: 7 }],
  makeCode: "m",
  stdCode: "s",
  stdTimeLimitMs: 1000
});
const input = Buffer.from("5\n1 2 3 4 5\n");
const actual = Buffer.from("14\n");
const expected = Buffer.from("15\n");
const diagnostics = Buffer.from("wrong answer 1st numbers differ - expected: '15', found: '14'");
const artifact = (index, role, data, classification = "hidden-test") => ({
  name: `${index}.${role}`,
  role,
  classification,
  size: data.length,
  sha256: sha256(data),
  originalSize: data.length,
  ...(({ text, binary }) => ({ preview: text, binary }))(textPreview(data))
});
const runFailure = (attemptId, overrides = {}) => ({
  schemaVersion: 2,
  attemptId,
  operation: "generate",
  sourceHashes: { make: sha256("m"), std: sha256("s") },
  profile: {
    hash: "f".repeat(64),
    architecture: "x64",
    compiler: "g++ -std=c++17 -O2",
    auxiliary: { timeLimitMs: 5000, memoryLimitMiB: 512 },
    solution: { timeLimitMs: 1000, memoryLimitMiB: 256 },
    oracle: { timeLimitMs: 5000, memoryLimitMiB: 512 },
    checker: "tokens"
  },
  observations: [
    {
      kind: "solver_disagreement",
      fatal: true,
      phase: "generate",
      role: "quality-alt-0",
      candidate: "dp",
      subject: "case 3 (subtask 1, case index 3)",
      subtask: 1,
      scenarioIndex: 3,
      verdict: "WA",
      expectedBasis: "reference_output",
      difference: { unit: "token", index: 1, actualLine: 1, expectedLine: 1, actual: "14", expected: "15" },
      summary: "case 3 alternative dp (subtask 1): checker: RuntimeError (exit 1) wrong answer",
      artifacts: [
        artifact(0, "input", input),
        artifact(0, "actual", actual),
        artifact(0, "expected", expected),
        artifact(0, "diagnostics", diagnostics, "author-private")
      ]
    }
  ],
  ...overrides
});
const bytesOf = { input, actual, expected, diagnostics };

// The judge's side of a failed run: evidence uploads through the forms it's given, then the failure
async function judgeFails(service, files, taskId, failure, upload = true) {
  const evidence = failure.observations.flatMap(observation => observation.artifacts);
  const forms = await service.signUploads(
    taskId,
    evidence.map(({ name, size }) => ({ name, size })),
    true
  );
  assert.deepEqual(
    forms.map(form => form.name),
    evidence.map(({ name }) => name)
  );
  if (upload) for (const form of forms) files.objects.set(form.extraFormData.key, bytesOf[form.name.split(".")[1]]);
  return await service.onTaskProgress(taskId, {
    finished: true,
    status: "Failed",
    message: failure.observations[0].summary,
    failure
  });
}

test("a judge machine's failure keeps its exact evidence after the run is cleaned up", { skip }, async t => {
  const { files, queue, backend, job, observations, ds } = await fixture(t);
  const service = backend();
  const owner = await job();
  const running = service.run(
    owner,
    request(owner.id),
    async () => {},
    async () => {}
  );
  const { taskId } = await until(() => queue.enqueued[0], "the task");
  await service.getTaskToBeSentToJudgeByTaskId(taskId, 1);
  assert.equal(await judgeFails(service, files, taskId, runFailure(taskId)), true);
  const error = await running.catch(e => e);
  assert.equal(error.code, "SANDBOX_GENERATION_FAILED");
  assert.equal(error.failure.kind, "solver_disagreement", "typed for the workflow");
  assert.equal(error.observationId, observationId(taskId, 0));
  const [row] = await observations(owner.id);
  assert.deepEqual(
    [row.id, row.runToken, row.fatal, row.kind, row.evidence, row.bytes],
    [
      error.observationId,
      owner.runToken,
      true,
      "solver_disagreement",
      "stored",
      input.length + actual.length + expected.length + diagnostics.length
    ]
  );
  assert.deepEqual(
    [row.observation.origin, row.observation.attemptId, row.observation.role],
    ["judge", taskId, "quality-alt-0"]
  );
  for (const stored of row.observation.artifacts) {
    assert.equal(stored.stored, true);
    assert.deepEqual(
      files.objects.get(`temporary/ai-evidence/${row.id}/${stored.role}`),
      bytesOf[stored.role],
      "byte-identical"
    );
  }
  assert.equal(await ds.getRepository(AiExecutionEntity).findOneBy({ taskId }), null, "the run is removed");
  assert.deepEqual(
    [...files.objects.keys()].filter(name => name.startsWith("temporary/ai-execution/")),
    [],
    "with its uploads"
  );
  // Recording the same failure again records nothing new
  await service.evidence.record(owner, runFailure(taskId), { origin: "judge", fetch: async () => null });
  assert.equal((await observations(owner.id)).length, 1);
});

test(
  "a failure reported while the backend was down is the outcome its job takes when it runs again, or the cleanup records it",
  { skip },
  async t => {
    const { files, queue, backend, job, observations, ds } = await fixture(t);
    const owner = await job();
    const before = backend();
    // The backend stops waiting: another one runs the job now (it restarted), and the run goes on for it
    let restarted = false;
    const first = before.run(
      owner,
      request(owner.id),
      async () => {},
      async () => {
        if (restarted) throw new AiError("JOB_LEASE_LOST");
      }
    );
    const { taskId } = await until(() => queue.enqueued[0], "the task");
    await before.getTaskToBeSentToJudgeByTaskId(taskId, 1);
    restarted = true;
    await assert.rejects(first, /JOB_LEASE_LOST/);
    assert.equal((await ds.getRepository(AiExecutionEntity).findOneBy({ taskId })).state, "Running", "not canceled");
    // The judge then reports its failure, which nobody waits for
    const after = backend();
    await judgeFails(after, files, taskId, runFailure(taskId));
    // The job runs again: the failure of the same operation, which it never took, is its outcome (review Part III,
    // W03), recorded with its evidence; no new run starts
    const rerun = { ...owner, runToken: crypto.randomUUID() };
    await assert.rejects(
      after.run(
        rerun,
        request(owner.id),
        async () => {},
        async () => {}
      ),
      error => error.code === "SANDBOX_GENERATION_FAILED" && error.observationId === observationId(taskId, 0)
    );
    assert.equal(queue.enqueued.length, 1);
    assert.deepEqual(
      (await observations(owner.id)).map(row => [row.id, row.runToken, row.evidence]),
      [[observationId(taskId, 0), rerun.runToken, "stored"]]
    );
    assert.equal(await ds.getRepository(AiExecutionEntity).findOneBy({ taskId }), null);
    // A retry of the same operation runs it again: the failure was taken once
    const retried = after.run(
      { ...owner, runToken: crypto.randomUUID() },
      request(owner.id),
      async () => {},
      async () => {}
    );
    const next = await until(() => queue.enqueued[1], "the new task");
    await after.onTaskProgress(next.taskId, { finished: true, status: "Failed", message: "again" });
    await retried.catch(() => {});

    // A job that never runs again: the cleanup records it before removing the old run
    const other = await job();
    const run = after.run(
      other,
      request(other.id),
      async () => {},
      async () => {}
    );
    const lost = await until(() => queue.enqueued[2], "another task");
    await after.getTaskToBeSentToJudgeByTaskId(lost.taskId, 1);
    run.catch(() => {});
    await ds.getRepository(AiExecutionEntity).update({ taskId: lost.taskId }, { state: "Running" });
    await judgeFails(after, files, lost.taskId, runFailure(lost.taskId));
    await ds.getRepository(AiExecutionEntity).update({ taskId: lost.taskId }, { state: "Failed" });
    await after.sweep(Date.now() + 2 * 60 * 60 * 1000);
    assert.deepEqual(
      (await observations(other.id)).map(row => [row.runToken, row.evidence]),
      [[null, "stored"]]
    );
    assert.equal(await ds.getRepository(AiExecutionEntity).findOneBy({ taskId: lost.taskId }), null);
  }
);

test("evidence is checked against what the judge reported, and bounded", { skip }, async t => {
  const { files, queue, backend, job, observations } = await fixture(t);
  const service = backend();
  const owner = await job();
  const running = service.run(
    owner,
    request(owner.id),
    async () => {},
    async () => {}
  );
  const { taskId } = await until(() => queue.enqueued[0], "the task");
  await service.getTaskToBeSentToJudgeByTaskId(taskId, 1);
  // Upload forms only for evidence names and within the limits
  for (const files of [
    [{ name: "../x", size: 1 }],
    [{ name: "8.input", size: 1 }],
    [{ name: "0.input", size: 16 * 1024 * 1024 + 1 }],
    [
      { name: "0.input", size: 1 },
      { name: "0.input", size: 1 }
    ],
    Array.from({ length: 5 }, (_, i) => ({ name: `${i}.input`, size: 16 * 1024 * 1024 }))
  ])
    assert.deepEqual(await service.signUploads(taskId, files, true), [], JSON.stringify(files).slice(0, 80));
  await service.signUploads(taskId, [{ name: "0.input", size: input.length }], true);
  // The judge uploads something else as the actual output, and nothing as the expected one
  const failure = runFailure(taskId);
  await service.signUploads(
    taskId,
    failure.observations[0].artifacts.map(({ name, size }) => ({ name, size })),
    true
  );
  files.objects.set(`temporary/ai-execution/${taskId}/evidence/0.input`, input);
  files.objects.set(`temporary/ai-execution/${taskId}/evidence/0.actual`, Buffer.from("15\n"));
  files.objects.set(`temporary/ai-execution/${taskId}/evidence/0.diagnostics`, diagnostics);
  await service.onTaskProgress(taskId, { finished: true, status: "Failed", message: "x", failure });
  await running.catch(() => {});
  const [row] = await observations(owner.id);
  assert.equal(row.evidence, "partial");
  assert.deepEqual(
    row.observation.artifacts.map(({ role, stored, missing }) => [role, stored, missing]),
    [
      ["input", true, undefined],
      ["actual", false, "It isn't what the run reported"],
      ["expected", false, "The run didn't keep it"],
      ["diagnostics", true, undefined]
    ]
  );
  assert.equal(files.objects.has(`temporary/ai-evidence/${row.id}/actual`), false, "nothing unverified is kept");
  // An invalid failure from a judge isn't recorded as one
  assert.equal(
    await service.onTaskProgress(crypto.randomUUID(), {
      finished: true,
      status: "Failed",
      message: "y",
      failure: { ...failure, attemptId: "x" }
    }),
    false
  );
});

test("storage that fails is said to have failed, not taken for a replayable failure", { skip }, async t => {
  const { evidence, job, observations, files } = await fixture(t);
  const owner = await job();
  files.failing = true;
  await evidence.record(owner, runFailure(crypto.randomUUID()), {
    origin: "judge",
    fetch: async name => {
      const file = path.join(os.tmpdir(), `${crypto.randomUUID()}-${name}`);
      fs.writeFileSync(file, bytesOf[name.split(".")[1]]);
      return { path: file, done: async () => fs.rmSync(file, { force: true }) };
    }
  });
  const [row] = await observations(owner.id);
  assert.equal(row.evidence, "unavailable");
  assert.deepEqual([...new Set(row.observation.artifacts.map(item => item.missing))], ["It couldn't be stored"]);
  await assert.rejects(evidence.readArtifact(owner, row.id, "input", 0), /EVIDENCE_UNAVAILABLE/);
});

test("the site's and the job's evidence storage are bounded", { skip }, async t => {
  const { evidence, job, observations, files } = await fixture(t);
  const owner = await job();
  const source = {
    origin: "judge",
    fetch: async name => {
      const file = path.join(os.tmpdir(), `${crypto.randomUUID()}-${name}`);
      fs.writeFileSync(file, bytesOf[name.split(".")[1]]);
      return { path: file, done: async () => fs.rmSync(file, { force: true }) };
    }
  };
  // Fill the site's storage with another job's evidence
  const other = await job();
  await evidence.connection.query(
    "INSERT INTO ai_observation (id, jobId, fatal, kind, evidence, bytes, observation, createdAt, expiresAt) VALUES (?, ?, 1, 'runtime_error', 'stored', ?, '{}', NOW(), NOW() + INTERVAL 1 DAY)",
    [crypto.randomUUID(), other.id, 2 * 1024 * 1024 * 1024 - 10]
  );
  await evidence.record(owner, runFailure(crypto.randomUUID()), source);
  const [row] = await observations(owner.id);
  assert.equal(row.evidence, "unavailable");
  assert.deepEqual(
    [...new Set(row.observation.artifacts.map(item => item.missing))],
    ["The site's storage for failure evidence is full"]
  );
  assert.equal(
    [...files.objects.keys()].some(name => name.includes(row.id)),
    false
  );
});

test(
  "the local runner's failure is recorded from the job's directory before its cleanup, also after a restart",
  { skip },
  async t => {
    const { backend, job, observations, files, tmp } = await fixture(t, "local");
    const socketPath = path.join(tmp, "ai-runner.sock");
    process.env.HYHOJ_AI_RUNNER_SOCKET = socketPath;
    t.after(() => delete process.env.HYHOJ_AI_RUNNER_SOCKET);
    const owner = await job();
    const attemptId = crypto.randomUUID();
    const failureDirectory = path.join(tmp, "generated", owner.id, "failure");
    const keep = () => {
      fs.mkdirSync(failureDirectory, { recursive: true });
      for (const [role, data] of Object.entries(bytesOf))
        fs.writeFileSync(path.join(failureDirectory, `0.${role}`), data);
    };
    let reply = () => {
      keep();
      return [{ type: "error", message: "Output mismatch", candidateFailure: false, failure: runFailure(attemptId) }];
    };
    const server = net.createServer(socket => {
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        for (const line of message.operation === "cleanup" ? [{ type: "complete", cleaned: true }] : reply(message))
          socket.write(`${JSON.stringify(line)}\n`);
        socket.end();
      });
    });
    await new Promise(resolve => server.listen(socketPath, resolve));
    t.after(() => server.close());
    const service = backend();
    const error = await service
      .run(
        owner,
        request(owner.id),
        async () => {},
        async () => {}
      )
      .catch(e => e);
    assert.equal(error.observationId, observationId(attemptId, 0));
    const [row] = await observations(owner.id);
    assert.deepEqual([row.evidence, row.observation.origin, row.runToken], ["stored", "local", owner.runToken]);
    assert.deepEqual(files.objects.get(`temporary/ai-evidence/${row.id}/input`), input);

    // The backend restarted after the runner kept a failure: recorded before the job's next run
    const missed = crypto.randomUUID();
    keep();
    fs.writeFileSync(path.join(failureDirectory, "failure.json"), JSON.stringify(runFailure(missed)));
    reply = () => [{ type: "complete", directory: path.join(tmp, "generated", owner.id), files: [], requestHash: "h" }];
    await backend().run(
      owner,
      request(owner.id),
      async () => {},
      async () => {}
    );
    assert.deepEqual(
      (await observations(owner.id)).map(item => item.id).sort(),
      [observationId(attemptId, 0), observationId(missed, 0)].sort()
    );

    // A runner that keeps no evidence is recorded as unclassified, and says why
    reply = () => [{ type: "error", message: "Job already running" }];
    const unclassified = await backend()
      .run(
        owner,
        request(owner.id),
        async () => {},
        async () => {}
      )
      .catch(e => e);
    const recorded = (await observations(owner.id)).find(item => item.id === unclassified.observationId);
    assert.deepEqual(
      [recorded.kind, recorded.evidence, recorded.observation.evidenceError],
      ["unclassified", "unavailable", "The AI runner kept no evidence"]
    );
  }
);

test("a tutorial's solution that fails its check is kept, but isn't what ended the job", { skip }, async t => {
  const { backend, job, observations, queue, files } = await fixture(t);
  const service = backend();
  const owner = await job();
  const running = service.run(
    owner,
    { ...request(owner.id), operation: "validate-reference", cases: [] },
    async () => {},
    async () => {}
  );
  const { taskId } = await until(() => queue.enqueued[0], "the task");
  await service.getTaskToBeSentToJudgeByTaskId(taskId, 1);
  const failure = runFailure(taskId, { operation: "validate-reference" });
  const forms = await service.signUploads(
    taskId,
    failure.observations[0].artifacts.map(({ name, size }) => ({ name, size })),
    true
  );
  for (const form of forms) files.objects.set(form.extraFormData.key, bytesOf[form.name.split(".")[1]]);
  await service.onTaskProgress(taskId, {
    finished: true,
    status: "Failed",
    message: "x",
    candidateFailure: true,
    failure
  });
  const error = await running.catch(e => e);
  assert.equal(error.candidateFailure, true);
  const [row] = await observations(owner.id);
  assert.deepEqual([row.fatal, row.observation.context], [false, "tutorial-reference"]);
});

test(
  "the owner's views: the latest run's failure, parts of an artifact, a download link, and expiry",
  { skip },
  async t => {
    const { evidence, job, jobs, files, ds } = await fixture(t);
    const owner = await job({ status: "failed" });
    const text = Buffer.from(`${"é".repeat(40000)}end`);
    const source = {
      origin: "judge",
      fetch: async name => {
        const file = path.join(os.tmpdir(), `${crypto.randomUUID()}-${name}`);
        fs.writeFileSync(file, name === "0.input" ? text : bytesOf[name.split(".")[1]]);
        return { path: file, done: async () => fs.rmSync(file, { force: true }) };
      }
    };
    const failure = runFailure(crypto.randomUUID());
    failure.observations[0].artifacts[0] = artifact(0, "input", text);
    const old = await evidence.record(owner, runFailure(crypto.randomUUID()), source, {
      runToken: crypto.randomUUID()
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    const id = await evidence.record(owner, failure, source, { runToken: owner.runToken });
    const views = await evidence.list(owner);
    assert.deepEqual(
      views.map(view => [view.id, view.current]),
      [
        [id, true],
        [old, false]
      ]
    );
    assert.equal("attemptId" in views[0], false);
    const summaries = await evidence.summaries([owner, await job({ status: "completed" })]);
    assert.deepEqual(summaries.get(owner.id).count, 2);
    assert.deepEqual(summaries.get(owner.id).failure.id, id);

    // Parts end on whole characters; the next starts where one ended
    const first = await evidence.readArtifact(owner, id, "input", 0);
    assert.equal(first.bytes % 2, 0);
    assert.equal(first.text, "é".repeat(first.bytes / 2));
    const second = await evidence.readArtifact(owner, id, "input", first.bytes);
    assert.equal(Buffer.from(first.text + second.text).length, text.length);
    await assert.rejects(evidence.readArtifact(owner, id, "input", text.length + 1), /INVALID_ARTIFACT_RANGE/);
    await assert.rejects(evidence.readArtifact(await job(), id, "input", 0), /NO_SUCH_OBSERVATION/, "another job's");
    assert.match(
      await evidence.downloadLink(owner, id, "diagnostics"),
      /temporary\/ai-evidence\/.*\/diagnostics\?expires=120&name=ai-failure-.*-diagnostics\.txt/
    );

    // After 14 days the evidence is deleted and the previews dropped; after 90 the observation
    await evidence.sweep(Date.now() + EVIDENCE_RETENTION + 1000);
    const [expired] = await evidence.list(owner);
    assert.equal(expired.evidence, "expired");
    assert.deepEqual([...new Set(expired.artifacts.map(item => item.preview))], [""]);
    assert.deepEqual([expired.difference.actual, expired.difference.expected], ["", ""]);
    assert.equal(
      [...files.objects.keys()].some(name => name.startsWith("temporary/ai-evidence/")),
      false
    );
    await assert.rejects(evidence.readArtifact(owner, id, "input", 0), /EVIDENCE_UNAVAILABLE/);
    await evidence.sweep(Date.now() + 91 * DAY);
    assert.deepEqual(await evidence.list(owner), []);

    // Objects of an observation that was never recorded go after an hour
    files.objects.set("temporary/ai-evidence/aaaaaaaa-0000-5000-8000-000000000000/input", input);
    files.modified.set(
      "temporary/ai-evidence/aaaaaaaa-0000-5000-8000-000000000000/input",
      new Date(Date.now() - 2 * 60 * 60 * 1000)
    );
    await evidence.sweep();
    assert.equal(files.objects.size, 0);
  }
);

test("only the job's owner, still allowed to run it, reads its evidence; downloads are audited", { skip }, async t => {
  const { evidence, job, files } = await fixture(t);
  const { bareAiServices } = require("./ai-test-services.cjs");
  const owner = { id: 1 };
  const testdata = await job({ status: "failed" });
  const id = await evidence.record(
    testdata,
    runFailure(crypto.randomUUID()),
    {
      origin: "judge",
      fetch: async name => {
        const file = path.join(os.tmpdir(), `${crypto.randomUUID()}-${name}`);
        fs.writeFileSync(file, bytesOf[name.split(".")[1]]);
        return { path: file, done: async () => fs.rmSync(file, { force: true }) };
      }
    },
    { runToken: testdata.runToken }
  );
  const service = bareAiServices();
  const granted = { privileges: new Set(["UseAi", "GenerateTestdata"]), modify: true, editData: true };
  const audits = [];
  Object.assign(service.services.facade, { evidence, jobs: evidence.connection.getRepository(AiJobEntity) });
  Object.assign(service.services.coordinator, {
    privileges: {
      userHasPrivilege: async (user, privilege) => granted.privileges.has(privilege),
      permissionDecision: async () => granted.editData
    },
    problems: { findProblemById: async problemId => ({ id: problemId }) },
    problemAccess: { userHasPermission: async () => granted.modify },
    aiAudit: { log: async (...args) => audits.push(args) }
  });
  const { failures } = await service.failures(owner, testdata.id);
  assert.deepEqual(
    failures.map(failure => [failure.id, failure.current]),
    [[id, true]]
  );
  const part = await service.failureArtifact(owner, { jobId: testdata.id, id, role: "expected" });
  assert.equal(part.text, "15\n");
  const { url } = await service.downloadFailureArtifact(owner, { jobId: testdata.id, id, role: "input" });
  assert.match(url, /input/);
  assert.deepEqual(
    audits.map(([userId, action, , , details]) => [userId, action, details.observationId, details.role]),
    [[1, "ai.evidence.download", id, "input"]]
  );
  await assert.rejects(service.failures({ id: 2 }, testdata.id), /NO_SUCH_JOB/, "another user");
  await assert.rejects(
    service.failureArtifact(owner, { jobId: crypto.randomUUID(), id, role: "input" }),
    /NO_SUCH_JOB/
  );
  for (const revoke of [
    () => (granted.modify = false),
    () => granted.privileges.delete("GenerateTestdata"),
    () => granted.privileges.delete("UseAi"),
    () => (granted.editData = false)
  ]) {
    const saved = { privileges: new Set(granted.privileges), modify: granted.modify, editData: granted.editData };
    revoke();
    await assert.rejects(
      service.failureArtifact(owner, { jobId: testdata.id, id, role: "input" }),
      /PERMISSION_DENIED/,
      revoke.toString()
    );
    await assert.rejects(
      service.downloadFailureArtifact(owner, { jobId: testdata.id, id, role: "input" }),
      /PERMISSION_DENIED/
    );
    Object.assign(granted, saved);
  }
  assert.equal(audits.length, 1, "refused downloads aren't links");
  assert.ok(files.objects.size >= 4);
});
