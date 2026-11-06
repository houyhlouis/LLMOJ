// Review Part III, H09: an AI run's cancellation scope reaches every sandbox it starts, through calls and awaits, and
// its canceled work fails as "canceled", never as a program's verdict.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function load(file, stubs = {}) {
  const loaded = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    ts.transpileModule(fs.readFileSync(path.join(__dirname, file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText
  )(name => stubs[name] || require(name), loaded, loaded.exports);
  return loaded.exports;
}
const { withCancelScope, currentCancelScope, runInTurn } = load("cancelScope.ts");

test("the scope is the run's in everything it awaits, and no one else's", async () => {
  const scope = { isCanceled: () => false, onCancel: () => () => undefined, error: () => new Error("x") };
  assert.equal(currentCancelScope(), null);
  const seen = await withCancelScope(scope, async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    const nested = await Promise.all([1, 2].map(async () => currentCancelScope()));
    return [currentCancelScope(), ...nested];
  });
  assert.deepEqual(seen, [scope, scope, scope]);
  assert.equal(currentCancelScope(), null, "outside the run");
  const other = { ...scope };
  const both = await Promise.all([
    withCancelScope(scope, async () => currentCancelScope()),
    withCancelScope(other, async () => currentCancelScope())
  ]);
  assert.equal(both[0], scope);
  assert.equal(both[1], other);
});

test("a canceled run's failure is canceled: its evidence isn't kept and it's no verdict", async () => {
  const aiFailure = load("aiFailure.ts", { "@libreoj/judge-protocol": require("@libreoj/judge-protocol") });
  // As the runner makes it (aiRunner.ts canceledRun)
  const error = aiFailure.describe(new Error("Generation canceled"), { kind: "canceled" });
  // Passed through the places a program's failure passes, it stays canceled
  const described = aiFailure.describe(error, { role: "std", phase: "generate", subject: "case 3" });
  assert.equal(aiFailure.detailsOf(described).kind, "canceled");
  assert.equal(aiFailure.detailsOf(described).verdict, undefined);
});

// A scope the test cancels
function scope() {
  let canceled = false;
  const callbacks = new Set();
  return {
    isCanceled: () => canceled,
    onCancel(callback) {
      if (canceled) {
        callback();
        return () => undefined;
      }
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    error: () => Object.assign(new Error("Generation canceled"), { canceled: true }),
    cancel() {
      canceled = true;
      for (const callback of [...callbacks]) callback();
      callbacks.clear();
    },
    listening: () => callbacks.size
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("a run canceled while it waits for its turn leaves at once, and its turn does nothing", async () => {
  const Queue = require("promise-queue");
  const queue = new Queue(1);
  const add = run => queue.add(run);
  let finishFirst;
  const first = scope();
  const running = runInTurn(add, first, () => new Promise(resolve => (finishFirst = resolve)));
  const waiting = scope();
  let ran = false;
  const left = runInTurn(add, waiting, async () => {
    ran = true;
  });
  await flush();
  waiting.cancel();
  await assert.rejects(left, error => error.canceled, "out before the first one ends");
  finishFirst("done");
  assert.equal(await running, "done");
  await flush();
  assert.equal(ran, false, "the canceled run never started");
  assert.equal(queue.getQueueLength() + queue.getPendingLength(), 0);
  assert.equal(first.listening() + waiting.listening(), 0, "nothing listens any more");
});

test("a started run ends as its work does, in its scope", async () => {
  const Queue = require("promise-queue");
  const queue = new Queue(1);
  const run = scope();
  let stop;
  const result = runInTurn(
    work => queue.add(work),
    run,
    () =>
      new Promise((resolve, reject) => {
        assert.equal(currentCancelScope(), run, "its programs see the run's scope");
        // As a sandbox does: stopped on cancellation, it rejects with the scope's error
        stop = currentCancelScope().onCancel(() => reject(run.error()));
      })
  );
  await flush();
  run.cancel();
  await assert.rejects(result, error => error.canceled);
  assert.equal(typeof stop, "function");
  // A run already canceled when it asks for a turn never starts
  let started = false;
  await assert.rejects(
    runInTurn(
      work => queue.add(work),
      run,
      async () => {
        started = true;
      }
    ),
    error => error.canceled
  );
  await flush();
  assert.equal(started, false);
});
