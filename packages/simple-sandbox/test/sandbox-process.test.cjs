const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  });
  module._compile(outputText, filename);
};

// Use the production supervisor with a separate native execution handle and waiter for each sandbox.
require.cache[require.resolve("../src/nativeAddon.ts")] = {
  exports: {
    waitForProcess(run, complete) {
      run.complete = complete;
      run.invoke("wait");
    },
    readSandboxStats: run => run.invoke("read"),
    finalizeSandboxCgroup: run => run.invoke("finalize"),
    killSandbox: run => run.invoke("kill"),
    removeSandboxCgroup: run => run.invoke("remove")
  }
};
const { SandboxProcess } = require("../src/sandboxProcess.ts");
const { SandboxStatus } = require("../src/interfaces.ts");

const exited = { status: "exited", code: 0, userCpuTimeNanoseconds: "100" };
const signaled = { status: "signaled", code: 9, userCpuTimeNanoseconds: "100" };

function start({ parameters, stats, failures = {} } = {}) {
  const calls = [];
  const run = {
    invoke(method) {
      calls.push(method);
      if (failures[method]) throw failures[method];
      return { cpuTimeNanoseconds: "200", memoryPeakBytes: "1024", oomKillCount: "0", ...stats };
    }
  };
  const sandbox = new SandboxProcess({ time: 1000, memory: 8192, ...parameters }, 101, run);
  return { sandbox, calls, complete: (error, result = exited) => run.complete(error, result) };
}

function observeWatchdogs(t) {
  const timers = new Set();
  const listeners = process.listeners("exit");
  t.mock.method(globalThis, "setInterval", callback => {
    timers.add(callback);
    return callback;
  });
  t.mock.method(globalThis, "clearInterval", callback => timers.delete(callback));
  return {
    timers,
    tick() {
      for (const callback of timers) callback();
    },
    assertReleased(sandbox) {
      assert.equal(sandbox.running, false);
      assert.equal(sandbox.execution, null, "the completed wrapper releases the native execution handle");
      assert.equal(timers.size, 0);
      assert.deepEqual(process.listeners("exit"), listeners);
    },
    exitHooks: () => process.listeners("exit").filter(callback => !listeners.includes(callback))
  };
}

test("completion collects final stats once and releases the watchdog and exit hook", async t => {
  const watch = observeWatchdogs(t);
  const { sandbox, calls, complete } = start();
  assert.equal(watch.timers.size, 1);
  assert.equal(watch.exitHooks().length, 1);
  const first = sandbox.waitForStop();
  const second = sandbox.waitForStop();
  watch.tick();
  complete();
  complete(new Error("late waiter error"));
  const expected = { status: SandboxStatus.OK, time: 200, memory: 1024, code: 0, termination: "exited" };
  assert.deepEqual(await first, expected);
  assert.deepEqual(await second, expected);
  watch.assertReleased(sandbox);
  sandbox.stop();
  watch.tick();
  assert.deepEqual(calls, ["wait", "read", "finalize"]);
});

test("repeated stops cancel once and wait for the child to exit", async t => {
  const watch = observeWatchdogs(t);
  const { sandbox, calls, complete } = start({ parameters: { time: -1, resourceMode: "arbiter" } });
  assert.equal(watch.timers.size, 0);
  sandbox.stop();
  sandbox.stop();
  assert.equal(sandbox.running, true);
  complete(null, signaled);
  assert.deepEqual(await sandbox.waitForStop(), {
    status: SandboxStatus.Cancelled, time: 100, memory: 1024, code: 9, termination: "signaled"
  });
  watch.assertReleased(sandbox);
  sandbox.stop();
  assert.deepEqual(calls, ["wait", "kill", "finalize"]);
});

test("CPU exhaustion retains the time-limit verdict", async t => {
  const watch = observeWatchdogs(t);
  const { sandbox, calls, complete } = start({
    parameters: { resourceMode: "arbiter" }, stats: { cpuTimeNanoseconds: "2000000000" }
  });
  watch.tick();
  assert.equal(watch.timers.size, 0);
  complete(null, signaled);
  assert.equal((await sandbox.waitForStop()).status, SandboxStatus.TimeLimitExceeded);
  watch.assertReleased(sandbox);
  assert.deepEqual(calls, ["wait", "read", "kill", "finalize"]);
});

test("a final stats failure rejects once even when emergency cleanup fails", async t => {
  const watch = observeWatchdogs(t);
  const failure = new Error("final stats unavailable");
  const { sandbox, calls, complete } = start({ failures: { finalize: failure, remove: new Error("remove failed") } });
  complete();
  await assert.rejects(sandbox.waitForStop(), error => error === failure);
  complete();
  sandbox.stop();
  watch.tick();
  await assert.rejects(sandbox.waitForStop(), error => error === failure);
  watch.assertReleased(sandbox);
  assert.deepEqual(calls, ["wait", "finalize", "kill", "remove"]);
});

test("a watchdog read failure kills its sandbox, waits for reaping and rejects after a normal wait", async t => {
  const watch = observeWatchdogs(t);
  const failure = new Error("CPU accounting unavailable");
  const { sandbox, calls, complete } = start({ failures: { read: failure } });
  let settled = false;
  const failed = sandbox.waitForStop().catch(error => {
    settled = true;
    assert.equal(error, failure);
  });
  watch.tick();
  assert.equal(watch.timers.size, 0);
  assert.deepEqual(calls, ["wait", "read", "kill"]);
  await Promise.resolve();
  assert.equal(settled, false);
  sandbox.stop();
  complete(null, signaled);
  await failed;
  assert.equal(settled, true);
  watch.assertReleased(sandbox);
  watch.tick();
  assert.deepEqual(calls, ["wait", "read", "kill", "remove"]);
});

test("a watchdog read failure survives failures to stop and remove the cgroup", async t => {
  const watch = observeWatchdogs(t);
  const failure = new Error("watchdog read failed");
  const failures = { read: failure, kill: new Error("stop failed"), remove: new Error("remove failed") };
  const { sandbox, calls, complete } = start({ failures });
  const rejected = assert.rejects(sandbox.waitForStop(), error => error === failure);
  watch.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["wait", "read", "kill", "remove"]);
  assert.equal(watch.timers.size, 0);
  assert.equal(sandbox.running, true, "the supervisor still holds the live child's workspace");
  delete failures.kill;
  sandbox.stop();
  sandbox.stop();
  complete(new Error("child wait failed"));
  await rejected;
  watch.assertReleased(sandbox);
  assert.deepEqual(calls, ["wait", "read", "kill", "remove", "kill", "remove"]);
});

for (const synchronous of [false, true]) {
  test(`a ${synchronous ? "synchronous" : "callback"} wait error survives failed cleanup`, async t => {
    const watch = observeWatchdogs(t);
    const failure = new Error("wait failed");
    const failures = { remove: new Error("cgroup already gone") };
    if (synchronous) failures.wait = failure;
    const { sandbox, calls, complete } = start({ failures });
    if (!synchronous) complete(failure);
    await assert.rejects(sandbox.waitForStop(), error => error === failure);
    watch.assertReleased(sandbox);
    assert.deepEqual(calls, ["wait", "kill", "remove"]);
  });
}

test("a failed stop removes the cgroup once and waits for the registered reaper", async t => {
  const watch = observeWatchdogs(t);
  const failure = new Error("stop failed");
  const { sandbox, calls, complete } = start({ failures: { kill: failure } });
  const rejected = assert.rejects(sandbox.waitForStop(), error => error === failure);
  sandbox.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sandbox.running, true);
  assert.deepEqual(calls, ["wait", "kill", "remove"]);
  sandbox.stop();
  complete(null, signaled);
  await rejected;
  watch.assertReleased(sandbox);
  assert.deepEqual(calls, ["wait", "kill", "remove"]);
});

test("concurrent sandboxes share one exit hook until the last one finishes", async t => {
  const watch = observeWatchdogs(t);
  const first = start();
  const second = start();
  assert.equal(watch.exitHooks().length, 1);
  first.complete();
  assert.equal((await first.sandbox.waitForStop()).status, SandboxStatus.OK);
  assert.equal(watch.timers.size, 1);
  const [onExit] = watch.exitHooks();
  onExit();
  assert.deepEqual(first.calls, ["wait", "finalize"]);
  assert.deepEqual(second.calls, ["wait", "kill"]);
  second.complete(null, signaled);
  assert.equal((await second.sandbox.waitForStop()).status, SandboxStatus.Cancelled);
  watch.assertReleased(second.sandbox);
});
