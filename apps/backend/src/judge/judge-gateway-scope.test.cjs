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
  "../logger": { logger: { log: noop, verbose: noop, error: noop, warn: message => warnings.push(message) } },
  "../file/file.service": { MinioSignFor: { Judge: "Judge" }, JUDGE_FILE_DOWNLOAD_EXPIRE_TIME: 21600 },
  "../event-report/event-report.service": { EventReportType: { Success: "Success", Warning: "Warning" } },
  "../socket-io.constants": { SOCKET_IO_MAX_MESSAGE_SIZE: 64 * 1024 * 1024 }
});

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function fixture() {
  const queue = [];
  const progress = [];
  const signed = [];
  const redis = { on: noop, subscribe: noop, publish: noop, del: async () => 1, setex: async () => "OK" };
  const gateway = new JudgeGateway(
    {
      findJudgeClientByKey: async key => ({ id: Number(key), name: `judge-${key}` }),
      setJudgeClientOnlineSessionId: async () => {},
      checkJudgeClientSession: async () => true,
      disconnectJudgeClient: async () => {},
      isJudgeClientOnline: async () => true
    },
    {
      consumeTask: async () => {
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next ?? null;
      },
      onTaskProgress: async (taskMeta, value) => {
        progress.push([taskMeta.taskId, value]);
        return true;
      },
      pushTask: async () => {}
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
      handshake: { query: { key: String(key) } },
      request: {},
      emit: (...args) => emitted.push(args),
      disconnect: noop
    };
    await gateway.handleConnection(client);
    return { client, emitted };
  }
  return { gateway, queue, progress, signed, connect };
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

test("progress is only accepted from the client the task was assigned to", async () => {
  const { gateway, queue, progress, connect } = fixture();
  const a = await connect(1);
  const b = await connect(2);
  queue.push(submissionTask("task-a", [uuid(1)]));
  await gateway.onConsumeTask(a.client, 0);
  assert(a.emitted.some(([event, , task]) => event === "task" && task.taskId === "task-a"));

  const meta = { taskId: "task-a", type: "Submission" };
  assert.equal(await gateway.onProgress(b.client, { taskMeta: meta, progress: { forged: true } }), false);
  assert.equal(await gateway.onProgress(a.client, { taskMeta: { ...meta, type: "Hack" }, progress: {} }), false);
  assert.equal(await gateway.onProgress(a.client, { taskMeta: { taskId: "other", type: "Submission" }, progress: {} }), false);
  for (const invalid of [null, {}, { taskMeta: { taskId: 1, type: "Submission" } }, { taskMeta: { taskId: "x" } }])
    assert.equal(await gateway.onProgress(a.client, invalid), false);
  assert.deepEqual(progress, []);

  // The returned value is the Socket.IO acknowledgement, sent once the progress has been processed.
  assert.equal(await gateway.onProgress(a.client, { taskMeta: meta, progress: { done: true } }), true);
  assert.deepEqual(progress, [["task-a", { done: true }]]);
});

test("a finished task stays assigned for late progress from older clients, then expires", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gateway, queue, progress, connect } = fixture();
  const a = await connect(1);
  queue.push(submissionTask("task-a", [uuid(1)]));
  await gateway.onConsumeTask(a.client, 0);
  const [, , , acknowledge] = a.emitted.find(([event]) => event === "task");
  acknowledge();

  const message = { taskMeta: { taskId: "task-a", type: "Submission" }, progress: { late: true } };
  assert.equal(await gateway.onProgress(a.client, message), true);
  t.mock.timers.tick(60 * 1000);
  assert.equal(await gateway.onProgress(a.client, message), false);
  assert.equal(progress.length, 1);
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
  queue.push(new Error("redis unavailable"), submissionTask("task-a", []));
  await gateway.onConsumeTask(a.client, 3);
  assert(a.emitted.some(([event, threadId, task]) => event === "task" && threadId === 3 && task.taskId === "task-a"));
});
