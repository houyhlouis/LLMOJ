// Exercise actual gateway method bodies with deterministic sockets and queue scheduling.
// No running judge connection or Redis queue is changed by these regressions.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const sourcePath = process.env.TEST_JUDGE_GATEWAY_SOURCE || path.join(__dirname, "judge.gateway.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const gatewayClass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "JudgeGateway");
assert(gatewayClass, "actual JudgeGateway class is present");
const methodBody = name => {
  const method = gatewayClass.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === name);
  assert(method?.body, `actual ${name} method is present`);
  return method.body.getText(ast);
};
const moduleObject = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(
    `export class Gateway {
      async onConsumeTask(client: any, threadId: number) ${methodBody("onConsumeTask")}
      onCancelTask(taskId: string) ${methodBody("onCancelTask")}
    }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }
  ).outputText,
  { module: moduleObject, exports: moduleObject.exports, logger: { warn() {}, verbose() {} } },
  { timeout: 1000 }
);
const { Gateway } = moduleObject.exports;
const evidence = {
  scope:
    "Actual onConsumeTask and onCancelTask method bodies extracted by TypeScript AST; mocked sockets and queue. No live judge/Redis interruption.",
  sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
  cases: []
};
after(() => {
  if (process.env.TEST_JUDGE_GATEWAY_RESULTS) {
    fs.writeFileSync(process.env.TEST_JUDGE_GATEWAY_RESULTS, `${JSON.stringify(evidence, null, 2)}\n`);
  }
});

function fixture() {
  const gateway = new Gateway();
  const task = { taskId: "isolated-task", type: "submission", priority: 5 };
  const events = [];
  const acknowledgements = new Map();
  const socket = id => ({
    id,
    emit(event, ...args) {
      events.push({ socket: id, event, taskId: event === "cancel" ? args[0] : args[1].taskId });
      if (event === "task") acknowledgements.set(id, args[2]);
    }
  });
  const oldSocket = socket("old");
  const healthySocket = socket("healthy");
  const oldState = { judgeClient: { name: "old" }, pendingTasks: new Set() };
  const healthyState = { judgeClient: { name: "healthy" }, pendingTasks: new Set() };
  gateway.mapSessionIdToJudgeClient = new Map([
    [oldSocket.id, oldState],
    [healthySocket.id, healthyState]
  ]);
  gateway.mapTaskIdToSocket = new Map();
  gateway.checkConnection = async () => true;
  const requeues = [];
  gateway.judgeQueueService = {
    consumeTask: async () => task,
    pushTask: async (...args) => requeues.push(args)
  };
  return { gateway, task, oldSocket, healthySocket, oldState, healthyState, events, acknowledgements, requeues };
}

function loseConnectionAfterConsume(fixture) {
  let checks = 0;
  fixture.gateway.checkConnection = async client => client === fixture.healthySocket || ++checks === 1;
  fixture.gateway.judgeQueueService.consumeTask = async () => {
    fixture.gateway.mapSessionIdToJudgeClient.delete(fixture.oldSocket.id);
    return fixture.task;
  };
}

test("healthy consumption sends one task, routes cancellation, and acknowledgement releases ownership", async () => {
  const f = fixture();
  await f.gateway.onConsumeTask(f.oldSocket, 7);
  assert.equal(f.oldState.pendingTasks.has(f.task), true);
  assert.equal(f.gateway.mapTaskIdToSocket.get(f.task.taskId), f.oldSocket);
  assert.deepEqual(f.requeues, []);
  f.gateway.onCancelTask(f.task.taskId);
  assert.deepEqual(f.events, [
    { socket: "old", event: "task", taskId: f.task.taskId },
    { socket: "old", event: "cancel", taskId: f.task.taskId }
  ]);
  f.acknowledgements.get("old")();
  assert.equal(f.oldState.pendingTasks.size, 0);
  assert.equal(f.gateway.mapTaskIdToSocket.has(f.task.taskId), false);
  f.gateway.onCancelTask(f.task.taskId);
  assert.equal(f.events.length, 2);
  evidence.cases.push({ name: "normal consumption and acknowledgement", events: f.events, requeues: f.requeues });
});

test("connection lost during dequeue requeues the task without registering or emitting it to the invalid socket", async () => {
  const f = fixture();
  loseConnectionAfterConsume(f);
  await f.gateway.onConsumeTask(f.oldSocket, 0);
  assert.deepEqual(f.requeues, [[f.task.taskId, f.task.type, f.task.priority, true]]);
  assert.equal(f.oldState.pendingTasks.size, 0);
  assert.equal(f.gateway.mapTaskIdToSocket.size, 0);
  assert.deepEqual(f.events, []);
  f.gateway.onCancelTask(f.task.taskId);
  assert.deepEqual(f.events, []);
  evidence.cases.push({ name: "connection lost during dequeue", events: f.events, requeues: f.requeues });
});

test("requeue interleaving preserves the healthy consumer's cancellation route when the old call resumes", async () => {
  const f = fixture();
  loseConnectionAfterConsume(f);
  let consumeCount = 0;
  f.gateway.judgeQueueService.consumeTask = async () => {
    consumeCount++;
    assert(consumeCount <= 2, "task is dequeued once per socket");
    if (consumeCount === 1) f.gateway.mapSessionIdToJudgeClient.delete(f.oldSocket.id);
    return f.task;
  };
  f.gateway.judgeQueueService.pushTask = async (...args) => {
    f.requeues.push(args);
    await f.gateway.onConsumeTask(f.healthySocket, 1);
    assert.equal(f.gateway.mapTaskIdToSocket.get(f.task.taskId), f.healthySocket);
  };
  await f.gateway.onConsumeTask(f.oldSocket, 0);
  assert.equal(consumeCount, 2);
  assert.deepEqual(f.requeues, [[f.task.taskId, f.task.type, f.task.priority, true]]);
  assert.equal(f.gateway.mapSessionIdToJudgeClient.has(f.oldSocket.id), false);
  const actualCancelRoute = f.gateway.mapTaskIdToSocket.get(f.task.taskId)?.id;
  f.gateway.onCancelTask(f.task.taskId);
  assert.equal(actualCancelRoute, f.healthySocket.id, "old call must preserve the healthy task owner");
  assert.deepEqual(f.events, [
    { socket: "healthy", event: "task", taskId: f.task.taskId },
    { socket: "healthy", event: "cancel", taskId: f.task.taskId }
  ]);
  assert.equal(f.oldState.pendingTasks.size, 0);
  assert.equal(f.healthyState.pendingTasks.has(f.task), true);
  evidence.cases.push({
    name: "healthy socket dequeues during old socket's requeue await",
    consumeCount,
    actualCancelRoute: f.gateway.mapTaskIdToSocket.get(f.task.taskId).id,
    oldPendingTaskCount: f.oldState.pendingTasks.size,
    healthyPendingTaskCount: f.healthyState.pendingTasks.size,
    events: f.events,
    requeues: f.requeues
  });
});

test("an empty dequeue retries and subsequently dispatches a task normally", async () => {
  const f = fixture();
  let consumeCount = 0;
  f.gateway.judgeQueueService.consumeTask = async () => (++consumeCount === 1 ? null : f.task);
  await f.gateway.onConsumeTask(f.oldSocket, 0);
  assert.equal(consumeCount, 2);
  assert.equal(f.gateway.mapTaskIdToSocket.get(f.task.taskId), f.oldSocket);
  assert.equal(f.oldState.pendingTasks.has(f.task), true);
  assert.deepEqual(f.requeues, []);
  assert.deepEqual(f.events, [{ socket: "old", event: "task", taskId: f.task.taskId }]);
  evidence.cases.push({ name: "empty dequeue then normal consumption", consumeCount, events: f.events });
});

test("a failed requeue propagates its error without recording invalid socket ownership", async () => {
  const f = fixture();
  loseConnectionAfterConsume(f);
  const error = new Error("simulated requeue failure");
  f.gateway.judgeQueueService.pushTask = async () => {
    throw error;
  };
  await assert.rejects(f.gateway.onConsumeTask(f.oldSocket, 0), failure => failure === error);
  assert.equal(f.oldState.pendingTasks.size, 0);
  assert.equal(f.gateway.mapTaskIdToSocket.size, 0);
  assert.deepEqual(f.events, []);
  evidence.cases.push({ name: "failed requeue propagates without invalid ownership", events: f.events });
});

test("an initially invalid connection does not dequeue a task", async () => {
  const f = fixture();
  f.gateway.checkConnection = async () => false;
  f.gateway.judgeQueueService.consumeTask = async () => assert.fail("invalid socket must not dequeue");
  await f.gateway.onConsumeTask(f.oldSocket, 0);
  assert.equal(f.gateway.mapTaskIdToSocket.size, 0);
  assert.deepEqual(f.events, []);
  evidence.cases.push({ name: "initially invalid connection", events: f.events });
});

test("an unknown session and an unknown cancellation task are ignored", async () => {
  const f = fixture();
  f.gateway.mapSessionIdToJudgeClient.delete(f.oldSocket.id);
  f.gateway.checkConnection = async () => assert.fail("unknown session must be ignored");
  f.gateway.judgeQueueService.consumeTask = async () => assert.fail("unknown session must not dequeue");
  await f.gateway.onConsumeTask(f.oldSocket, 0);
  f.gateway.onCancelTask("not-owned");
  assert.equal(f.gateway.mapTaskIdToSocket.size, 0);
  assert.deepEqual(f.events, []);
  evidence.cases.push({ name: "unknown session and cancellation task", events: f.events });
});
