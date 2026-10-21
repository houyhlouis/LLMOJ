// Exercise actual gateway method bodies with deterministic sockets and queue scheduling.
// No running judge connection or database queue is changed by these regressions.
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
const timers = [];
vm.runInNewContext(
  ts.transpileModule(
    `export class Gateway {
      async claimOptions(state: any) ${methodBody("claimOptions")}
      async onConsumeTask(client: any, threadId: number) ${methodBody("onConsumeTask")}
      onTaskAcknowledged(client: any, state: any, assignment: any) ${methodBody("onTaskAcknowledged")}
      onCancelTask(taskId: string) ${methodBody("onCancelTask")}
    }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }
  ).outputText,
  {
    module: moduleObject,
    exports: moduleObject.exports,
    logger: { warn() {}, verbose() {}, error() {} },
    // Grace timers are run explicitly by the tests
    setTimeout: (callback, delay) => {
      if (delay === 0) return setTimeout(callback, 0);
      timers.push(callback);
      return { unref() {} };
    },
    JudgeJobAttemptOutcome: { Disconnected: "Disconnected", Abandoned: "Abandoned" },
    LEGACY_TASK_TYPES: ["Submission"],
    JudgeTaskPriorityType: { LiveContest: 0 },
    JudgeTaskType: require("@libreoj/judge-protocol").JudgeTaskType,
    // AI runs are covered by judge-gateway-scope.test.cjs
    aiExecutionLimit: () => 0,
    CONSUME_TASK_RETRY_DELAY: 0,
    ACKNOWLEDGED_TASK_GRACE_TIME: 10000
  },
  { timeout: 1000 }
);
const { Gateway } = moduleObject.exports;
// Objects created by the extracted methods belong to the VM's realm
const plain = value => JSON.parse(JSON.stringify(value));
const evidence = {
  scope:
    "Actual claimOptions, onConsumeTask, onTaskAcknowledged and onCancelTask method bodies extracted by TypeScript AST; mocked sockets and queue. No live judge/database interruption.",
  sourceSha256: crypto.createHash("sha256").update(source).digest("hex"),
  cases: []
};
after(() => {
  if (process.env.TEST_JUDGE_GATEWAY_RESULTS) {
    fs.writeFileSync(process.env.TEST_JUDGE_GATEWAY_RESULTS, `${JSON.stringify(evidence, null, 2)}\n`);
  }
});

function fixture() {
  timers.length = 0;
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
  const oldState = { judgeClient: { id: 1, name: "old" }, assignedTasks: new Map() };
  const healthyState = { judgeClient: { id: 2, name: "healthy" }, assignedTasks: new Map() };
  gateway.mapSessionIdToJudgeClient = new Map([
    [oldSocket.id, oldState],
    [healthySocket.id, healthyState]
  ]);
  gateway.mapTaskIdToSocket = new Map();
  gateway.checkConnection = async () => true;
  const releases = [];
  const claims = [];
  let fence = 0;
  let waits = 0;
  gateway.judgeQueueService = {
    claim: async owner => {
      claims.push(owner);
      return { task, fence: ++fence };
    },
    waitForJobs: async () => {
      waits++;
    },
    release: async (...args) => releases.push(args)
  };
  gateway.onTaskAcknowledged = Gateway.prototype.onTaskAcknowledged;
  return {
    gateway,
    task,
    oldSocket,
    healthySocket,
    oldState,
    healthyState,
    events,
    acknowledgements,
    releases,
    claims,
    waits: () => waits
  };
}

function loseConnectionAfterClaim(fixture) {
  let checks = 0;
  fixture.gateway.checkConnection = async client => client === fixture.healthySocket || ++checks === 1;
  const { claim } = fixture.gateway.judgeQueueService;
  fixture.gateway.judgeQueueService.claim = async owner => {
    fixture.gateway.mapSessionIdToJudgeClient.delete(fixture.oldSocket.id);
    return await claim(owner);
  };
}

test("healthy consumption leases and sends one task, routes cancellation, and the acknowledgement ends the lease", async () => {
  const f = fixture();
  await f.gateway.onConsumeTask(f.oldSocket, 7);
  assert.deepEqual(plain(f.claims), [{ connectionId: "old", judgeClientId: 1 }]);
  assert.deepEqual(plain(f.oldState.assignedTasks.get(f.task.taskId)), { task: f.task, fence: 1 });
  assert.equal(f.gateway.mapTaskIdToSocket.get(f.task.taskId), f.oldSocket);
  f.gateway.onCancelTask(f.task.taskId);
  assert.deepEqual(f.events, [
    { socket: "old", event: "task", taskId: f.task.taskId },
    { socket: "old", event: "cancel", taskId: f.task.taskId }
  ]);
  f.acknowledgements.get("old")();
  assert.equal(f.gateway.mapTaskIdToSocket.has(f.task.taskId), false);
  // Late progress from older judge clients is still accepted for a short grace period.
  assert(f.oldState.assignedTasks.has(f.task.taskId));
  f.gateway.onCancelTask(f.task.taskId);
  assert.equal(f.events.length, 2);
  assert.deepEqual(f.releases, []);
  // Then a lease still held without a result is released (a no-op in the queue once the result is stored).
  await timers.shift()();
  assert.equal(f.oldState.assignedTasks.size, 0);
  assert.deepEqual(f.releases, [[f.task.taskId, 1, "old", "Abandoned"]]);
  evidence.cases.push({ name: "normal consumption and acknowledgement", events: f.events, releases: f.releases });
});

test("connection lost after a claim releases the lease without registering or emitting it to the invalid socket", async () => {
  const f = fixture();
  loseConnectionAfterClaim(f);
  await f.gateway.onConsumeTask(f.oldSocket, 0);
  assert.deepEqual(f.releases, [[f.task.taskId, 1, "old", "Disconnected"]]);
  assert.equal(f.oldState.assignedTasks.size, 0);
  assert.equal(f.gateway.mapTaskIdToSocket.size, 0);
  assert.deepEqual(f.events, []);
  f.gateway.onCancelTask(f.task.taskId);
  assert.deepEqual(f.events, []);
  evidence.cases.push({ name: "connection lost after a claim", events: f.events, releases: f.releases });
});

test("a release interleaving preserves the healthy consumer's cancellation route when the old call resumes", async () => {
  const f = fixture();
  loseConnectionAfterClaim(f);
  f.gateway.judgeQueueService.release = async (...args) => {
    f.releases.push(args);
    await f.gateway.onConsumeTask(f.healthySocket, 1);
    assert.equal(f.gateway.mapTaskIdToSocket.get(f.task.taskId), f.healthySocket);
  };
  await f.gateway.onConsumeTask(f.oldSocket, 0);
  assert.equal(f.claims.length, 2);
  assert.deepEqual(f.releases, [[f.task.taskId, 1, "old", "Disconnected"]]);
  assert.equal(f.gateway.mapSessionIdToJudgeClient.has(f.oldSocket.id), false);
  const actualCancelRoute = f.gateway.mapTaskIdToSocket.get(f.task.taskId)?.id;
  f.gateway.onCancelTask(f.task.taskId);
  assert.equal(actualCancelRoute, f.healthySocket.id, "old call must preserve the healthy task owner");
  assert.deepEqual(f.events, [
    { socket: "healthy", event: "task", taskId: f.task.taskId },
    { socket: "healthy", event: "cancel", taskId: f.task.taskId }
  ]);
  assert.equal(f.oldState.assignedTasks.size, 0);
  assert.deepEqual(plain(f.healthyState.assignedTasks.get(f.task.taskId)), { task: f.task, fence: 2 });
  evidence.cases.push({
    name: "healthy socket claims during old socket's release await",
    claims: f.claims.length,
    actualCancelRoute,
    events: f.events,
    releases: f.releases
  });
});

test("an empty queue waits for jobs and subsequently dispatches a task normally", async () => {
  const f = fixture();
  const { claim } = f.gateway.judgeQueueService;
  f.gateway.judgeQueueService.claim = async owner =>
    f.claims.length === 0 ? (f.claims.push(owner), null) : await claim(owner);
  await f.gateway.onConsumeTask(f.oldSocket, 0);
  assert.equal(f.claims.length, 2);
  assert.equal(f.waits(), 1);
  assert.equal(f.gateway.mapTaskIdToSocket.get(f.task.taskId), f.oldSocket);
  assert.deepEqual(f.releases, []);
  assert.deepEqual(f.events, [{ socket: "old", event: "task", taskId: f.task.taskId }]);
  evidence.cases.push({ name: "empty queue then normal consumption", claims: f.claims.length, events: f.events });
});

test("a failed release propagates its error without recording invalid socket ownership", async () => {
  const f = fixture();
  loseConnectionAfterClaim(f);
  const error = new Error("simulated release failure");
  f.gateway.judgeQueueService.release = async () => {
    throw error;
  };
  await assert.rejects(f.gateway.onConsumeTask(f.oldSocket, 0), failure => failure === error);
  assert.equal(f.oldState.assignedTasks.size, 0);
  assert.equal(f.gateway.mapTaskIdToSocket.size, 0);
  assert.deepEqual(f.events, []);
  evidence.cases.push({ name: "failed release propagates without invalid ownership", events: f.events });
});

test("an initially invalid connection does not claim a task", async () => {
  const f = fixture();
  f.gateway.checkConnection = async () => false;
  f.gateway.judgeQueueService.claim = async () => assert.fail("invalid socket must not claim");
  await f.gateway.onConsumeTask(f.oldSocket, 0);
  assert.equal(f.gateway.mapTaskIdToSocket.size, 0);
  assert.deepEqual(f.events, []);
  evidence.cases.push({ name: "initially invalid connection", events: f.events });
});

test("an unknown session and an unknown cancellation task are ignored", async () => {
  const f = fixture();
  f.gateway.mapSessionIdToJudgeClient.delete(f.oldSocket.id);
  f.gateway.checkConnection = async () => assert.fail("unknown session must be ignored");
  f.gateway.judgeQueueService.claim = async () => assert.fail("unknown session must not claim");
  await f.gateway.onConsumeTask(f.oldSocket, 0);
  f.gateway.onCancelTask("not-owned");
  assert.equal(f.gateway.mapTaskIdToSocket.size, 0);
  assert.deepEqual(f.events, []);
  evidence.cases.push({ name: "unknown session and cancellation task", events: f.events });
});
