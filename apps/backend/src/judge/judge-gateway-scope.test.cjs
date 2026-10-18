const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const ts = require("typescript");
const protocol = require("@libreoj/judge-protocol");

// Installed globally by main.ts.
// eslint-disable-next-line no-extend-native
String.prototype.format = function format(...args) {
  return util.format(String(this), ...args);
};

const noop = () => {};
const decorator = () => noop;
function load(file, overrides) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      experimentalDecorators: true
    }
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", source)(
    name => {
      if (!(name in overrides)) throw new Error(`Unexpected runtime import ${name}`);
      return overrides[name];
    },
    loaded,
    loaded.exports
  );
  return loaded.exports;
}

const warnings = [];
const judgeRuntimeModule = load("judge-runtime.service.ts", {
  crypto: require("node:crypto"),
  "@nestjs/common": { Injectable: decorator },
  "@nestjs/typeorm": { InjectRepository: decorator },
  typeorm: { In: values => values },
  "./judge-runtime.entity": {},
  "./judge-client.entity": {},
  "./dto/judge-runtime.dto": {}
});
const { JudgeGateway, aiExecutionLimit } = load("judge.gateway.ts", {
  "@nestjs/common": { forwardRef: x => x, Inject: decorator, Optional: decorator },
  "@nestjs/websockets": {
    ConnectedSocket: decorator,
    MessageBody: decorator,
    SubscribeMessage: decorator,
    WebSocketGateway: decorator,
    WebSocketServer: decorator
  },
  "socket.io-msgpack-parser": {},
  "proxy-addr": () => "127.0.0.1",
  "@libreoj/judge-protocol": protocol,
  "./judge-queue.service": { LEASE_RENEW_INTERVAL: 30000 },
  "./judge-client.service": { REDIS_CHANNEL_JUDGE_CLIENT_CHANGED: "judge-client-changed" },
  "./judge-job.entity": {
    JudgeJobAttemptOutcome: { Disconnected: "Disconnected", Abandoned: "Abandoned", Expired: "Expired" }
  },
  "./judge-runtime.service": judgeRuntimeModule,
  "../logger": { logger: { log: noop, verbose: noop, error: noop, warn: message => warnings.push(message) } },
  "../file/file.service": { MinioSignFor: { Judge: "Judge" }, JUDGE_FILE_DOWNLOAD_EXPIRE_TIME: 21600 },
  "../event-report/event-report.service": { EventReportType: { Success: "Success", Warning: "Warning" } },
  "../socket-io.constants": { SOCKET_IO_MAX_MESSAGE_SIZE: 64 * 1024 * 1024 },
  "../metrics/metrics.service": { MetricsService: class MetricsService {} }
});

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture() {
  // Tasks to lease next (an Error makes the claim fail once)
  const queue = [];
  const progress = [];
  const signed = [];
  const released = [];
  const renewed = [];
  const canceled = [];
  const claims = [];
  const owners = [];
  const stored = [];
  const recorded = [];
  const signedUploads = [];
  const clients = new Map();
  let fence = 0;
  let waits = 0;
  let notified = 0;
  const redis = { on: noop, subscribe: noop, publish: noop, del: async () => 1, setex: async () => "OK" };
  const gateway = new JudgeGateway(
    {
      findJudgeClientByKey: async key => {
        const judgeClient = { id: Number(key), name: `judge-${key}`, draining: false };
        clients.set(judgeClient.id, judgeClient);
        return judgeClient;
      },
      findJudgeClientById: async id => (clients.has(id) ? { ...clients.get(id) } : null),
      updateJudgeClientCapabilities: async (judgeClient, capabilities) => stored.push([judgeClient.id, capabilities]),
      setJudgeClientOnlineSessionId: async () => {},
      checkJudgeClientSession: async () => true,
      disconnectJudgeClient: async () => {},
      isJudgeClientOnline: async () => true
    },
    {
      claim: async (owner, taskTypes) => {
        claims.push([owner.connectionId, taskTypes]);
        owners.push(owner);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next ? { task: next, fence: ++fence } : null;
      },
      waitForJobs: async () => {
        waits++;
        if (waits > 1000) throw new Error("waiting forever");
        await new Promise(resolve => setTimeout(resolve, 2));
      },
      notifyJobsAvailable: () => notified++,
      release: async (...args) => released.push(args),
      renewLeases: async leases => renewed.push(leases),
      cancel: async taskId => canceled.push(taskId),
      onTaskProgress: async (taskMeta, lease, value) => {
        progress.push([taskMeta.taskId, lease, value]);
        return true;
      },
      signTaskUploads: async (taskMeta, files) => {
        signedUploads.push([taskMeta, files]);
        return files.map(file => ({ name: file.name, url: "https://storage.invalid/", extraFormData: {}, fileFieldName: "file" }));
      }
    },
    {
      signDownloadLink: async options => {
        signed.push(options);
        return `https://storage.invalid/${options.uuid}`;
      }
    },
    { config: { judge: { limit: {} }, server: { trustProxy: false } } },
    { report: noop },
    { getClient: () => redis },
    { lock: async (name, callback) => await callback() }
  );
  // Each runtime announced is recorded once; the next ID for a new one
  const runtimeIds = new Map();
  gateway.judgeRuntimeService = {
    record: async (judgeClientId, runtime) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      const key = JSON.stringify([judgeClientId, runtime]);
      recorded.push([judgeClientId, runtime]);
      if (!runtimeIds.has(key)) runtimeIds.set(key, 40 + runtimeIds.size + 1);
      return runtimeIds.get(key);
    }
  };
  async function connect(key) {
    const emitted = [];
    const client = {
      id: `socket-${key}`,
      connected: true,
      disconnected: false,
      handshake: { query: { key: String(key) } },
      request: {},
      emit: (...args) => emitted.push(args),
      disconnect() {
        client.disconnected = true;
        client.connected = false;
      }
    };
    await gateway.handleConnection(client);
    return { client, emitted };
  }
  return {
    gateway,
    queue,
    progress,
    signed,
    released,
    renewed,
    canceled,
    claims,
    owners,
    stored,
    recorded,
    signedUploads,
    clients,
    connect,
    waits: () => waits,
    notified: () => notified
  };
}

const submissionTask = (taskId, files) => ({
  taskId,
  type: "Submission",
  priorityType: 1,
  priority: 1,
  extraInfo: { testData: Object.fromEntries(files.map((file, i) => [`${i}.in`, file])), submissionContent: {} }
});

test("judge clients learn that the server acknowledges processed progress", async () => {
  const { connect } = fixture();
  const { emitted } = await connect(1);
  const ready = emitted.find(([event]) => event === "ready");
  assert.deepEqual(ready.slice(1), ["judge-1", { limit: {} }, { progressAck: true }]);
});

test("progress is only accepted from the client the task was leased to, with that lease", async () => {
  const { gateway, queue, progress, connect } = fixture();
  const a = await connect(1);
  const b = await connect(2);
  queue.push(submissionTask("task-a", [uuid(1)]));
  await gateway.onConsumeTask(a.client, 0);
  assert(a.emitted.some(([event, , task]) => event === "task" && task.taskId === "task-a"));

  const meta = { taskId: "task-a", type: "Submission" };
  assert.equal(await gateway.onProgress(b.client, { taskMeta: meta, progress: { forged: true } }), false);
  assert.equal(await gateway.onProgress(a.client, { taskMeta: { ...meta, type: "Hack" }, progress: {} }), false);
  assert.equal(
    await gateway.onProgress(a.client, { taskMeta: { taskId: "other", type: "Submission" }, progress: {} }),
    false
  );
  for (const invalid of [null, {}, { taskMeta: { taskId: 1, type: "Submission" } }, { taskMeta: { taskId: "x" } }])
    assert.equal(await gateway.onProgress(a.client, invalid), false);
  assert.deepEqual(progress, []);

  // The returned value is the Socket.IO acknowledgement, sent once the progress has been processed.
  assert.equal(await gateway.onProgress(a.client, { taskMeta: meta, progress: { done: true } }), true);
  assert.deepEqual(progress, [["task-a", { fence: 1, connectionId: "socket-1", judgeRuntimeId: null }, { done: true }]]);
});

test("an acknowledged task stays assigned for late progress from older clients, then its lease is released", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, queue, progress, released, connect } = fixture();
  const a = await connect(1);
  queue.push(submissionTask("task-a", [uuid(1)]));
  await gateway.onConsumeTask(a.client, 0);
  const [, , , acknowledge] = a.emitted.find(([event]) => event === "task");
  acknowledge();

  const message = { taskMeta: { taskId: "task-a", type: "Submission" }, progress: { late: true } };
  assert.equal(await gateway.onProgress(a.client, message), true);
  t.mock.timers.tick(10 * 1000);
  await new Promise(setImmediate);
  assert.equal(await gateway.onProgress(a.client, message), false);
  assert.equal(progress.length, 1);
  // A no-op in the queue if the result was stored; otherwise the task is judged again
  assert.deepEqual(released, [["task-a", 1, "socket-1", "Abandoned"]]);
});

test("a disconnected client's leases are released, and only connected tasks are renewed", async t => {
  // The disconnect report waits a minute
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, queue, released, renewed, connect } = fixture();
  const a = await connect(1);
  const b = await connect(2);
  queue.push(submissionTask("task-a", []), submissionTask("task-b", []), submissionTask("task-c", []));
  await gateway.onConsumeTask(a.client, 0);
  await gateway.onConsumeTask(a.client, 1);
  await gateway.onConsumeTask(b.client, 0);
  await gateway.renewLeases();
  assert.deepEqual(renewed.at(-1), [
    { taskId: "task-a", connectionId: "socket-1" },
    { taskId: "task-b", connectionId: "socket-1" },
    { taskId: "task-c", connectionId: "socket-2" }
  ]);
  a.client.connected = false;
  await gateway.handleDisconnect(a.client);
  assert.deepEqual(released, [
    ["task-a", 1, "socket-1", "Disconnected"],
    ["task-b", 2, "socket-1", "Disconnected"]
  ]);
  await gateway.renewLeases();
  assert.deepEqual(renewed.at(-1), [{ taskId: "task-c", connectionId: "socket-2" }]);
});

test("canceling a task also cancels its job", async () => {
  const { gateway, canceled } = fixture();
  gateway.cancelTask("task-a");
  await new Promise(setImmediate);
  assert.deepEqual(canceled, ["task-a"]);
});

test("files are only signed when referenced by the requesting client's tasks, with a bounded lifetime", async () => {
  const { gateway, queue, signed, connect } = fixture();
  const a = await connect(1);
  const b = await connect(2);
  queue.push(submissionTask("task-a", [uuid(1), uuid(2)]));
  await gateway.onConsumeTask(a.client, 0);

  assert.deepEqual(await gateway.onRequestFiles(a.client, [uuid(1), uuid(2)]), [
    `https://storage.invalid/${uuid(1)}`,
    `https://storage.invalid/${uuid(2)}`
  ]);
  assert.deepEqual(
    signed.map(options => options.expiresSeconds),
    [21600, 21600]
  );
  assert(signed.every(options => !("noExpire" in options)));

  signed.length = 0;
  assert.deepEqual(await gateway.onRequestFiles(a.client, [uuid(1), uuid(3)]), []);
  assert.deepEqual(await gateway.onRequestFiles(b.client, [uuid(1)]), []);
  for (const invalid of [null, "x", [1], new Array(10001).fill(uuid(1))])
    assert.deepEqual(await gateway.onRequestFiles(a.client, invalid), []);
  assert.deepEqual(signed, []);
});

test("a queue error does not drop the client's request for a task", async () => {
  const { gateway, queue, connect } = fixture();
  const a = await connect(1);
  queue.push(new Error("database unavailable"), submissionTask("task-a", []));
  await gateway.onConsumeTask(a.client, 3);
  assert(a.emitted.some(([event, threadId, task]) => event === "task" && threadId === 3 && task.taskId === "task-a"));
});

const capabilities = (overrides = {}) => ({
  protocolVersion: 2,
  taskTypes: ["Submission", "Hack", "SelfEval", "SelfEvalPrepare"],
  consumerThreads: 3,
  executionSlots: 7,
  memoryBudget: 2374,
  aiExecutionSlots: 6,
  ...overrides
});

test("judge clients are sent only the task types they announce; ones that announce nothing get submissions", async () => {
  const { gateway, queue, claims, stored, connect } = fixture();
  const a = await connect(1);
  queue.push(submissionTask("task-a", []));
  await gateway.onConsumeTask(a.client, 0);
  assert.deepEqual(claims.at(-1), ["socket-1", ["Submission"]]);
  assert.deepEqual(stored, [[1, null]], "stale capabilities are cleared on connect");

  await gateway.onCapabilities(a.client, capabilities({ taskTypes: ["Submission", "Hack", "FutureType", "Hack"] }));
  assert.deepEqual(stored.at(-1), [1, capabilities({ taskTypes: ["Submission", "Hack"] })]);
  queue.push(submissionTask("task-b", []));
  await gateway.onConsumeTask(a.client, 1);
  assert.deepEqual(claims.at(-1), ["socket-1", ["Submission", "Hack"]]);

  for (const invalid of [
    null,
    "x",
    capabilities({ protocolVersion: 1 }),
    capabilities({ taskTypes: "Submission" }),
    capabilities({ consumerThreads: -1 }),
    capabilities({ memoryBudget: 1.5 })
  ])
    await gateway.onCapabilities(a.client, invalid);
  assert.equal(stored.length, 2, "invalid announcements are ignored");
});

test("a draining judge client gets no new task until it is resumed, in every backend process", async () => {
  const { gateway, queue, claims, clients, connect, waits, notified } = fixture();
  const a = await connect(1);
  clients.get(1).draining = true;
  await gateway.onJudgeClientChanged(JSON.stringify({ id: 1, revoked: false }));
  queue.push(submissionTask("task-a", []));
  const consuming = gateway.onConsumeTask(a.client, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(claims.length, 0, "no claim while draining");
  assert(waits() > 0);
  clients.get(1).draining = false;
  await gateway.onJudgeClientChanged(JSON.stringify({ id: 1, revoked: false }));
  assert.equal(notified(), 1, "waiting consumers are woken up on resume");
  await consuming;
  assert.equal(claims.length, 1);
  assert(a.emitted.some(([event, , task]) => event === "task" && task.taskId === "task-a"));
});

test("resetting a judge client's key disconnects it at once, releasing its tasks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, queue, released, connect } = fixture();
  const a = await connect(1);
  const b = await connect(2);
  queue.push(submissionTask("task-a", []));
  await gateway.onConsumeTask(a.client, 0);
  await gateway.onJudgeClientChanged(JSON.stringify({ id: 1, revoked: true }));
  assert.equal(a.client.disconnected, true);
  assert.equal(b.client.disconnected, false, "other judge clients stay connected");
  await gateway.handleDisconnect(a.client);
  assert.deepEqual(released, [["task-a", 1, "socket-1", "Disconnected"]]);
  await gateway.onJudgeClientChanged("not json");
  await gateway.onJudgeClientChanged(JSON.stringify({ id: 99, revoked: true }));
});

const runtime = (overrides = {}) => ({
  judgeProgram: "a".repeat(64),
  sandboxImage: "b".repeat(64),
  node: "v24.21.0",
  os: "Ubuntu 26.04",
  kernel: "Linux 7.0.0-38-generic",
  arch: "x64",
  cpu: "Intel Core i7-11370H @ 4x 4.8GHz",
  ...overrides
});

test("a judge client's announced runtime is recorded, and its leases and results refer to it", async () => {
  const { gateway, queue, progress, owners, stored, recorded, connect } = fixture();
  const a = await connect(1);
  // Announced just before the consumer asks for a task: the claim waits for the runtime to be recorded
  const announced = gateway.onCapabilities(a.client, capabilities({ protocolVersion: 3, runtime: runtime() }));
  queue.push(submissionTask("task-a", []));
  await gateway.onConsumeTask(a.client, 0);
  await announced;
  assert.deepEqual(recorded, [[1, runtime()]]);
  assert.deepEqual(stored.at(-1), [1, capabilities({ protocolVersion: 3, runtime: runtime() })]);
  assert.equal(owners.at(-1).judgeRuntimeId, 41);
  assert.equal(await gateway.onProgress(a.client, { taskMeta: { taskId: "task-a", type: "Submission" }, progress: {} }), true);
  assert.deepEqual(progress.at(-1)[1], { fence: 1, connectionId: "socket-1", judgeRuntimeId: 41 });

  // Another judge machine with the same software is another runtime
  const b = await connect(2);
  await gateway.onCapabilities(b.client, capabilities({ protocolVersion: 3, runtime: runtime() }));
  queue.push(submissionTask("task-b", []));
  await gateway.onConsumeTask(b.client, 0);
  assert.equal(owners.at(-1).judgeRuntimeId, 42);
});

test("an invalid runtime is left out of the capabilities, and the judge client's results have none", async () => {
  const { gateway, queue, owners, stored, recorded, connect } = fixture();
  const a = await connect(1);
  for (const invalid of [
    "x",
    runtime({ judgeProgram: "not a digest" }),
    runtime({ sandboxImage: "B".repeat(64) }),
    runtime({ kernel: 7 }),
    runtime({ cpu: "x".repeat(201) })
  ]) {
    await gateway.onCapabilities(a.client, capabilities({ protocolVersion: 3, runtime: invalid }));
    assert.deepEqual(stored.at(-1), [1, capabilities({ protocolVersion: 3 })]);
  }
  // Extra fields aren't kept
  await gateway.onCapabilities(a.client, capabilities({ protocolVersion: 3, runtime: { ...runtime(), secret: "x" } }));
  assert.deepEqual(stored.at(-1)[1].runtime, runtime());
  assert.deepEqual(recorded, [[1, runtime()]]);

  // If recording fails, judging goes on without
  const b = await connect(2);
  gateway.judgeRuntimeService = { record: async () => Promise.reject(new Error("database unavailable")) };
  await gateway.onCapabilities(b.client, capabilities({ protocolVersion: 3, runtime: runtime() }));
  queue.push(submissionTask("task-b", []));
  await gateway.onConsumeTask(b.client, 0);
  assert.equal(owners.at(-1).judgeRuntimeId, null);
});

const aiTask = taskId => ({ taskId, type: "AiExecution", priorityType: 4, priority: 4, extraInfo: { request: {} } });

test("generated files are only signed for a task assigned to the requesting judge client", async () => {
  const { gateway, queue, signedUploads, connect } = fixture();
  const a = await connect(1);
  const b = await connect(2);
  await gateway.onCapabilities(a.client, capabilities({ protocolVersion: 4, taskTypes: ["Submission", "AiExecution"] }));
  queue.push(aiTask("ai-1"));
  await gateway.onConsumeTask(a.client, 0);
  const files = [{ name: "1.in", size: 4 }];
  assert.deepEqual(await gateway.onRequestUploads(b.client, { taskId: "ai-1", files }), [], "not its task");
  for (const invalid of [null, { taskId: "ai-1" }, { taskId: "ai-1", files: [{ name: 1, size: 4 }] }, { taskId: "ai-1", files: [{ name: "1.in", size: 1.5 }] }])
    assert.deepEqual(await gateway.onRequestUploads(a.client, invalid), []);
  assert.deepEqual(signedUploads, []);
  const targets = await gateway.onRequestUploads(a.client, { taskId: "ai-1", files: [{ name: "1.in", size: 4, extra: "dropped" }] });
  assert.deepEqual(targets.map(target => target.name), ["1.in"]);
  assert.deepEqual(signedUploads, [[{ taskId: "ai-1", type: "AiExecution" }, files]]);
});

test("AI runs leave a judge client's other threads to other work", async () => {
  const { gateway, queue, claims, connect } = fixture();
  const a = await connect(1);
  await gateway.onCapabilities(
    a.client,
    capabilities({ protocolVersion: 4, taskTypes: ["Submission", "AiExecution"], consumerThreads: 3, aiExecutionSlots: 6 })
  );
  for (let i = 0; i < 3; i++) {
    queue.push(aiTask(`ai-${i}`));
    await gateway.onConsumeTask(a.client, i);
  }
  assert.deepEqual(
    claims.map(([, taskTypes]) => taskTypes),
    [["Submission", "AiExecution"], ["Submission", "AiExecution"], ["Submission"]],
    "two of three threads at most"
  );
  assert.equal(aiExecutionLimit(null), 0);
  assert.equal(aiExecutionLimit(capabilities({ consumerThreads: 1, aiExecutionSlots: 4 })), 0, "a single thread runs none");
  assert.equal(aiExecutionLimit(capabilities({ consumerThreads: 8, aiExecutionSlots: 2 })), 2, "nor more than its AI slots");
  assert.equal(aiExecutionLimit(capabilities({ consumerThreads: 3, aiExecutionSlots: 0 })), 1);
});
