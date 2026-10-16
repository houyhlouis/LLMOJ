// Admission of execution slots by memory: the reservations of running work never exceed the budget.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const loaded = { exports: {} };
new Function(
  "require",
  "module",
  "exports",
  ts.transpileModule(fs.readFileSync(path.join(__dirname, "executionScheduler.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText
)(require, loaded, loaded.exports);
const { ExecutionScheduler, defaultMemoryBudget, defaultAiSlots, DEFAULT_RESERVATION } = loaded.exports;

const flush = () => new Promise(resolve => setImmediate(resolve));

// Starts an acquisition and records when it is admitted
function request(scheduler, reservation, log, name) {
  const entry = { name, release: null };
  scheduler.acquire(reservation).then(release => {
    entry.release = release;
    log.push(name);
  });
  return entry;
}

test("work waits until its memory fits the budget, and at most `slots` run", async () => {
  const scheduler = new ExecutionScheduler(3, 1000, 3);
  const log = [];
  const a = request(scheduler, { memory: 600 }, log, "a");
  const b = request(scheduler, { memory: 600 }, log, "b");
  await flush();
  assert.deepEqual(log, ["a"]);
  assert.deepEqual(scheduler.status, {
    slots: 3,
    freeSlots: 2,
    memoryBudget: 1000,
    freeMemory: 400,
    aiSlots: 3,
    runningAi: 0,
    waiting: 1
  });
  a.release();
  await flush();
  assert.deepEqual(log, ["a", "b"]);
  const small = [1, 2, 3].map(i => request(scheduler, { memory: 100 }, log, `small${i}`));
  await flush();
  assert.deepEqual(log, ["a", "b", "small1", "small2"], "three slots in all");
  b.release();
  await flush();
  assert.deepEqual(log.at(-1), "small3");
  small.forEach(entry => entry.release());
  await flush();
  assert.equal(scheduler.status.freeMemory, 1000);
  assert.equal(scheduler.status.freeSlots, 3);
});

test("work larger than the whole budget runs alone, and nothing overtakes it", async () => {
  const scheduler = new ExecutionScheduler(4, 1000);
  const log = [];
  const running = request(scheduler, { memory: 100 }, log, "running");
  const huge = request(scheduler, { memory: 5000 }, log, "huge");
  const later = request(scheduler, { memory: 100 }, log, "later");
  await flush();
  assert.deepEqual(log, ["running"], "a small request behind the large one waits too");
  running.release();
  await flush();
  assert.deepEqual(log, ["running", "huge"]);
  assert.equal(scheduler.status.freeMemory, 0);
  huge.release();
  await flush();
  assert.deepEqual(log, ["running", "huge", "later"]);
  later.release();
});

test("AI work uses at most its share of slots without blocking judging behind it", async () => {
  const scheduler = new ExecutionScheduler(3, 10000, 2);
  const log = [];
  const ai = [1, 2, 3].map(i => request(scheduler, { memory: 100, ai: true }, log, `ai${i}`));
  const judging = request(scheduler, { memory: 100 }, log, "judging");
  await flush();
  assert.deepEqual(log, ["ai1", "ai2", "judging"]);
  assert.equal(scheduler.status.runningAi, 2);
  judging.release();
  await flush();
  assert.deepEqual(log, ["ai1", "ai2", "judging"], "the free slot stays for judging");
  ai[0].release();
  await flush();
  assert.deepEqual(log.at(-1), "ai3");
  ai[1].release();
  ai[2].release();
  ai[2].release();
  await flush();
  assert.equal(scheduler.status.runningAi, 0);
  assert.equal(scheduler.status.freeSlots, 3, "releasing twice frees once");
});

test("defaults: undeclared work reserves the old per-slot estimate; budgets leave room for the host", async () => {
  const scheduler = new ExecutionScheduler(2, 1000);
  const log = [];
  request(scheduler, undefined, log, "undeclared");
  await flush();
  assert.equal(scheduler.status.freeMemory, 1000 - DEFAULT_RESERVATION);
  assert.equal(defaultMemoryBudget(8 * 1024 ** 3), 6451);
  assert.equal(defaultMemoryBudget(3396 * 1024 ** 2), 2374);
  assert.equal(defaultMemoryBudget(256 * 1024 ** 2), DEFAULT_RESERVATION);
  assert.deepEqual([defaultAiSlots(1), defaultAiSlots(2), defaultAiSlots(7)], [1, 1, 6]);
  assert.equal(new ExecutionScheduler(3, 1000, 10).aiSlots, 3);
});
