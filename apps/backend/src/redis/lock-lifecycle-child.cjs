const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { performance } = require("node:perf_hooks");
const timers = require("node:timers/promises");
require("./register-typescript.cjs");
const { Module } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { LockService } = require("./lock.service.ts");
const { LockLeaseLostError, assertLockLeasesHeld } = require("./lock-lease.ts");

const scenario = process.argv[2];
const tick = () => timers.setImmediate();
const internalFailure = new Error("synthetic transport failure");
const releaseCallback = Promise.withResolvers();
const refreshReply = Promise.withResolvers();
const startedRefresh = Promise.withResolvers();
const finishedCallback = Promise.withResolvers();
const commands = [];
const writes = [];
let captured;
let acquire = true;
let disconnected = false;
let clock = 0;

const client = Object.assign(new EventEmitter(), {
  status: "ready",
  defineCommand() {},
  async callLock(key, action, token, ttl) {
    commands.push(action);
    if (action === "lock") {
      assert.equal(ttl, 5000);
      return acquire;
    }
    if (action === "unlock") return true;
    assert.equal(action, "refresh");
    assert.equal(ttl, 5000);
    startedRefresh.resolve();
    return await refreshReply.promise;
  },
  disconnect() {
    disconnected = true;
    this.emit("close");
    // Closing the lock connection settles an outstanding request, as ioredis does.
    if (commands.includes("refresh")) refreshReply.reject(internalFailure);
  }
});
const service = new LockService({ getClient: () => client });

// Run the first renewal promptly while retaining real event-loop ordering and counting pending timers.
const pending = new Set();
const schedule = global.setTimeout;
const cancel = global.clearTimeout;
global.setTimeout = (callback, ms, ...args) => {
  const timer = schedule(() => {
    pending.delete(timer);
    if (scenario === "late renewal reply" && ms <= 2500) clock = 2500;
    callback(...args);
  }, ms > 2000 && ms <= 2500 ? 10 : ms);
  pending.add(timer);
  return timer;
};
global.clearTimeout = timer => {
  pending.delete(timer);
  cancel(timer);
};

async function work(lease) {
  captured = lease;
  try {
    await releaseCallback.promise;
    assertLockLeasesHeld();
    writes.push("protected");
    return 27;
  } finally {
    finishedCallback.resolve();
  }
}

async function run() {
  if (scenario === "shutdown during contention") {
    acquire = false;
    const checked = assert.rejects(service.lock("contended", work), error => LockLeaseLostError.isShutdown(error));
    await tick();
    assert.deepEqual(commands, ["lock"]);
    service.onModuleDestroy();
    await checked;
    assert.equal(captured, undefined);
    assert.equal(service.active.size, 0);
    return;
  }
  if (scenario === "bounded contention") {
    const waits = [];
    timers.setTimeout = async ms => { waits.push(ms); };
    acquire = false;
    await assert.rejects(service.lock("contended", work), /Retries limit exceeded/);
    assert.deepEqual(commands, Array(30).fill("lock"));
    assert.deepEqual(waits, Array(29).fill(1000));
    return;
  }

  if (scenario === "callback and unlock failure") {
    const original = new Error("callback failed");
    client.callLock = async (_key, action) => {
      commands.push(action);
      if (action === "unlock") throw internalFailure;
      return true;
    };
    await assert.rejects(service.lock("ordinary", async lease => {
      captured = lease;
      throw original;
    }), error => {
      assert.equal(error, original);
      assert.equal(error.cleanupErrors.length, 1);
      assert.ok(error.cleanupErrors[0] instanceof LockLeaseLostError);
      assert.equal(error.cleanupErrors[0].cause, internalFailure);
      return true;
    });
  } else if (scenario === "delayed acquisition") {
    let now = 0;
    Object.defineProperty(performance, "now", { value: () => now });
    client.callLock = async (_key, action) => {
      commands.push(action);
      now += 5001;
      return true;
    };
    await assert.rejects(service.lock("slow", () => assert.fail("late acquisition ran its callback")), LockLeaseLostError);
    assert.deepEqual(commands, ["lock", "unlock"]);
  } else if (scenario === "nested loss") {
    const entered = Promise.withResolvers();
    let parent;
    const outcome = service.lock("outer", outer => {
      parent = outer;
      return service.lock("inner", inner => {
        entered.resolve();
        return work(inner);
      });
    });
    await entered.promise;
    const checked = assert.rejects(outcome, LockLeaseLostError);
    parent.lose(internalFailure);
    await checked;
    assert.equal(captured.signal.aborted, true, "the inner renewal must stop with its parent");
    releaseCallback.resolve();
    await finishedCallback.promise;
    await tick();
    assert.deepEqual(writes, []);
    assert.deepEqual(commands, ["lock", "lock", "unlock", "unlock"]);
  } else if (scenario === "detached ordinary callback") {
    const done = Promise.withResolvers();
    const result = await service.lock("ordinary", async lease => {
      captured = lease;
      releaseCallback.promise.then(() => {
        assertLockLeasesHeld();
        writes.push("outside");
        done.resolve();
      });
      return 43;
    });
    assert.equal(result, 43);
    assert.throws(() => captured.assertHeld(), LockLeaseLostError);
    releaseCallback.resolve();
    await done.promise;
    assert.deepEqual(writes, ["outside"]);
  } else {
    let app;
    if (scenario === "late renewal reply") Object.defineProperty(performance, "now", { value: () => clock });
    if (scenario === "shutdown") {
      class TestModule {}
      Module({ providers: [{ provide: LockService, useValue: service }] })(TestModule);
      app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    }
    const outcome = service.lock("synthetic", work);
    const success = scenario === "concurrent successful renewal";
    const checked = success ? outcome : assert.rejects(outcome, error => {
      assert.ok(error instanceof LockLeaseLostError);
      assert.equal(error.code, "LOCK_LEASE_LOST");
      assert.equal(LockLeaseLostError.isShutdown(error), scenario === "shutdown");
      if (scenario === "rejected renewal") assert.equal(error.cause, internalFailure);
      assert.equal(captured.signal.reason, error);
      return true;
    });
    await startedRefresh.promise;
    if (scenario.startsWith("concurrent")) {
      releaseCallback.resolve();
      await finishedCallback.promise;
      await tick();
      assert.deepEqual(commands, ["lock", "refresh"], "unlock must wait for the renewal reply");
      refreshReply.resolve(success);
      if (success) assert.equal(await checked, 27);
      else await checked;
      assert.deepEqual(commands, ["lock", "refresh", "unlock"]);
    } else {
      if (scenario === "shutdown") {
        await app.close();
        assert.equal(disconnected, true);
      } else if (scenario === "rejected renewal") refreshReply.reject(internalFailure);
      else if (scenario === "refused renewal") refreshReply.resolve(false);
      else if (scenario === "late renewal reply") {
        clock = 5001;
        refreshReply.resolve(true);
      }
      else throw new Error("Unknown scenario");
      await checked;
      assert.equal(captured.signal.aborted, true);
      assert.throws(() => captured.assertHeld(), LockLeaseLostError);
      assert.deepEqual(commands, scenario === "shutdown" ? ["lock", "refresh"] : ["lock", "refresh", "unlock"]);
      releaseCallback.resolve();
      await finishedCallback.promise;
      assert.deepEqual(writes, [], "a callback resuming after the caller saw the error attempted a write");
    }
  }

  await tick();
  assert.equal(service.active.size, 0);
  assert.equal(pending.size, 0, "an owned refresh or expiry timer survived cleanup");
  assert.equal(captured?.refreshing, undefined, "the lease retained an in-flight refresh");
}

// An unresolved promise by itself doesn't keep Node alive. A clean exit must also reach every assertion.
process.exitCode = 2;
run().then(() => {
  process.exitCode = 0;
  process.stdout.write("completed\n");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
