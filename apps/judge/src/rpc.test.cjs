/* Run with the judge's installed dependencies: node --test apps/judge/src/rpc.test.cjs. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const lodashDebounce = require("lodash.debounce");

class CanceledError extends Error {}
const noop = () => {};

function loadRpc(taskHandler) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "rpc.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const sockets = [];
  const overrides = {
    "socket.io-client": {
      __esModule: true,
      default: () => {
        const handlers = new Map();
        const socket = {
          sent: [],
          on: (event, handler) => handlers.set(event, [...(handlers.get(event) || []), handler]),
          off: (event, handler) =>
            handlers.set(
              event,
              (handlers.get(event) || []).filter(h => h !== handler)
            ),
          emit: (...args) => socket.sent.push(args),
          receive: (event, ...args) => (handlers.get(event) || []).forEach(handler => handler(...args)),
          removeAllListeners: noop,
          close: noop
        };
        sockets.push(socket);
        return socket;
      }
    },
    winston: { info: noop, error: noop, verbose: noop, warn: noop },
    "lodash.debounce": lodashDebounce,
    "socket.io-msgpack-parser": {},
    "./config": {
      __esModule: true,
      default: { serverUrl: "http://judge.invalid/", key: "k", rpcTimeout: 20000, taskConsumingThreads: 3 },
      updateServerSideConfig: noop
    },
    "./task": { __esModule: true, default: taskHandler, supportedTaskTypes: ["Submission", "Hack"] },
    "./taskQueue": { executionScheduler: { slots: 7, memoryBudget: 2374, aiSlots: 6 } },
    "@libreoj/judge-protocol": { JUDGE_PROTOCOL_VERSION: 2 },
    "./systemInfo": { __esModule: true, default: async () => ({}) },
    "./error": { CanceledError }
  };
  const loaded = { exports: {} };
  new Function("require", "module", "exports", source)(
    name => {
      if (!(name in overrides)) throw new Error(`Unexpected runtime import ${name}`);
      return overrides[name];
    },
    loaded,
    loaded.exports
  );
  return { rpc: new loaded.exports.RPC(), sockets };
}

const until = async condition => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert(condition());
};

async function runOneTask(capabilities) {
  const { rpc, sockets } = loadRpc(async task => {
    task.reportProgressRaw({ step: 1 });
    task.reportProgressRaw({ step: 2, finished: true });
  });
  const connected = rpc.connect();
  const [socket] = sockets;
  socket.receive("ready", "judge", {}, ...(capabilities === undefined ? [] : [capabilities]));
  await connected;

  let acknowledged = false;
  rpc.startTaskConsumerThread(0);
  socket.receive("task", 0, { taskId: "t", type: "Submission", extraInfo: {} }, () => (acknowledged = true));
  return { socket, isAcknowledged: () => acknowledged };
}

test("the final progress is sent without waiting for the debounce and stored before the task is acknowledged", async () => {
  const { socket, isAcknowledged } = await runOneTask({ progressAck: true });
  await until(() => socket.sent.some(([event]) => event === "progress"));
  const progress = socket.sent.filter(([event]) => event === "progress");
  // The debounced intermediate progress is superseded by the final result.
  assert.equal(progress.length, 1);
  const [, message, storedCallback] = progress[0];
  assert.deepEqual(message, { taskMeta: { taskId: "t", type: "Submission" }, progress: { step: 2, finished: true } });
  assert.equal(typeof storedCallback, "function");

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(isAcknowledged(), false, "The task must not be acknowledged before the server stored its result.");
  storedCallback(true);
  await until(isAcknowledged);
});

test("with a server that does not acknowledge progress, the final progress is flushed before the task ack", async () => {
  for (const capabilities of [undefined, {}, "unexpected"]) {
    const { socket, isAcknowledged } = await runOneTask(capabilities);
    await until(isAcknowledged);
    const progress = socket.sent.filter(([event]) => event === "progress");
    assert.equal(progress.length, 1);
    assert.equal(progress[0].length, 2, "Older servers never receive an acknowledgement callback.");
    assert.deepEqual(progress[0][1].progress, { step: 2, finished: true });
  }
});

test("after connecting, the judge client announces what it can judge and its capacity", async () => {
  const { socket, isAcknowledged } = await runOneTask({ progressAck: true });
  // Finish the task, so nothing waits for the server afterwards
  await until(() => socket.sent.some(([event]) => event === "progress"));
  socket.sent.find(([event]) => event === "progress")[2](true);
  await until(isAcknowledged);
  const announced = socket.sent.filter(([event]) => event === "capabilities");
  assert.deepEqual(announced, [
    [
      "capabilities",
      {
        protocolVersion: 2,
        taskTypes: ["Submission", "Hack"],
        consumerThreads: 3,
        executionSlots: 7,
        memoryBudget: 2374,
        aiExecutionSlots: 6
      }
    ]
  ]);
  const events = socket.sent.map(([event]) => event);
  assert(events.indexOf("capabilities") < events.indexOf("consumeTask"), "announced before consuming tasks");
});
