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
const { JudgeGateway } = load("judge.gateway.ts", {
  "@nestjs/common": { forwardRef: x => x, Inject: decorator },
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
  "../logger": { logger: { log: noop, verbose: noop, error: noop, warn: message => warnings.push(message) } },
  "../file/file.service": { MinioSignFor: { Judge: "Judge" }, JUDGE_FILE_DOWNLOAD_EXPIRE_TIME: 21600 },
  "../event-report/event-report.service": { EventReportType: { Success: "Success", Warning: "Warning" } },
  "../socket-io.constants": { SOCKET_IO_MAX_MESSAGE_SIZE: 64 * 1024 * 1024 }
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
  const stored = [];
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
    stored,
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
  assert.deepEqual(progress, [["task-a", { fence: 1, connectionId: "socket-1" }, { done: true }]]);
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
