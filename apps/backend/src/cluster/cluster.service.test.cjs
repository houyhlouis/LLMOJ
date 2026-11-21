const assert = require("node:assert/strict");
const cluster = require("node:cluster");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const { test } = require("node:test");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );

const { Logger } = require("@nestjs/common");
const { ClusterService } = require("./cluster.service.ts");
const { MetricsService } = require("../metrics/metrics.service.ts");
Logger.overrideLogger(false);

async function primary(t, clusters = 2) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const workers = [];
  t.mock.method(cluster, "fork", env => {
    const id = workers.length + 1;
    const worker = Object.assign(new EventEmitter(), {
      id,
      env,
      process: { pid: 5000 + id },
      kill: t.mock.fn(),
      disconnect: t.mock.fn()
    });
    workers.push(worker);
    return worker;
  });
  const exit = t.mock.method(process, "exit", () => {});
  const service = new ClusterService({ config: { server: { clusters } } });
  t.after(() => service.onModuleDestroy());
  const serve = t.mock.fn(async () => {});
  await service.initialization(serve);
  return { service, workers, serve, exit };
}

test("each lost worker is replaced in its slot with the same metrics listener and name", async t => {
  const { workers, serve, service } = await primary(t);
  assert.equal(serve.mock.callCount(), 0, "only workers can answer HTTP readiness");
  assert.deepEqual(
    workers.map(w => w.env.LLMOJ_WORKER_SLOT),
    ["1", "2"]
  );
  // Lose every serving worker in reverse slot order. Even a clean exit is unexpected while the primary is running.
  workers[1].emit("exit", null, "SIGKILL");
  workers[0].emit("exit", 0, null);
  t.mock.timers.tick(249);
  assert.equal(workers.length, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(
    workers.map(w => w.env.LLMOJ_WORKER_SLOT),
    ["1", "2", "2", "1"]
  );

  const messages = [];
  service.onMessageFromWorker("fixture", data => messages.push(data));
  cluster.emit("message", workers[3], { channel: "fixture", data: "replacement online" });
  assert.deepEqual(messages, ["replacement online"]);

  const config = { config: { metrics: { hostname: "127.0.0.1", basePort: 9000 } } };
  const listen = t.mock.fn((port, host, started) => started());
  const log = t.mock.method(Logger.prototype, "log", () => {});
  t.mock.method(http, "createServer", () => ({ listen }));
  t.mock.method(require("@prometheus-io/client"), "collectDefaultMetrics", () => {});
  new MetricsService(config);
  t.mock.property(cluster, "isPrimary", false);
  const originalSlot = process.env.LLMOJ_WORKER_SLOT;
  t.after(() => {
    delete cluster.worker;
    if (originalSlot === undefined) delete process.env.LLMOJ_WORKER_SLOT;
    else process.env.LLMOJ_WORKER_SLOT = originalSlot;
  });
  for (const worker of workers) {
    cluster.worker = worker;
    process.env.LLMOJ_WORKER_SLOT = worker.env.LLMOJ_WORKER_SLOT;
    new MetricsService(config);
  }
  assert.deepEqual(
    listen.mock.calls.map(call => call.arguments[0]),
    [9000, 9001, 9002, 9002, 9001]
  );
  assert.deepEqual(
    log.mock.calls.map(call => call.arguments[0].match(/\((.+)\)$/)[1]),
    ["Master", "Worker #1", "Worker #2", "Worker #2", "Worker #1"]
  );
});

test("retries back off independently up to four seconds, then a cluster-wide crash loop exits nonzero", async t => {
  const { workers, exit } = await primary(t);
  let firstSlot = workers[0];
  for (const delay of [250, 500, 1000, 2000, 4000, 4000]) {
    const count = workers.length;
    firstSlot.emit("exit", 1, null);
    t.mock.timers.tick(delay - 1);
    assert.equal(workers.length, count);
    t.mock.timers.tick(1);
    assert.equal(workers.length, count + 1);
    firstSlot = workers.at(-1);
    assert.equal(firstSlot.env.LLMOJ_WORKER_SLOT, "1");
  }
  firstSlot.emit("exit", 1, null); // seventh failure, replacement pending at four seconds
  workers[1].emit("exit", 1, null);
  t.mock.timers.tick(250);
  assert.equal(workers.at(-1).env.LLMOJ_WORKER_SLOT, "2", "slot 2 starts at the first delay");
  assert.equal(exit.mock.callCount(), 0);
  const count = workers.length;
  workers.at(-1).emit("exit", 1, null); // ninth failure inside one minute
  assert.deepEqual(
    exit.mock.calls.map(call => call.arguments),
    [[1]]
  );
  t.mock.timers.tick(60000);
  assert.equal(workers.length, count);
});

test("a minute of worker uptime resets the slot delay and expires earlier crashes", async t => {
  const { workers, exit } = await primary(t, 1);
  for (let burst = 0; burst < 2; burst++) {
    for (const delay of [250, 500, 1000, 2000, 4000]) {
      const count = workers.length;
      workers.at(-1).emit("exit", 1, null);
      t.mock.timers.tick(delay);
      assert.equal(workers.length, count + 1);
    }
    t.mock.timers.tick(60000);
  }
  assert.equal(exit.mock.callCount(), 0);
});

test("an asynchronous spawn failure gets one replacement even without an exit or with a late exit", async t => {
  const { workers, exit } = await primary(t, 1);
  const failed = workers[0];
  failed.process.pid = undefined;
  failed.emit("error", Object.assign(new Error("retry spawn"), { code: "EAGAIN" }));
  assert.equal(failed.disconnect.mock.callCount(), 1);
  t.mock.timers.tick(249);
  assert.equal(workers.length, 1);
  t.mock.timers.tick(1);
  assert.equal(workers.length, 2);
  assert.equal(workers[1].env.LLMOJ_WORKER_SLOT, "1");
  failed.emit("exit", 1, null);
  failed.emit("error", new Error("late notification"));
  t.mock.timers.tick(10000);
  assert.equal(workers.length, 2);
  assert.equal(failed.disconnect.mock.callCount(), 1);

  workers[1].emit("exit", 1, null);
  t.mock.timers.tick(499);
  assert.equal(workers.length, 2);
  t.mock.timers.tick(1);
  assert.equal(workers.length, 3, "the failed spawn used one backoff step");
  assert.equal(exit.mock.callCount(), 0);
});

test("a live worker's process errors are contained and only its exit frees the slot", async t => {
  const { workers } = await primary(t, 1);
  const worker = workers[0];
  worker.emit("error", new Error("IPC unavailable"));
  worker.emit("error", new Error("second IPC failure"));
  t.mock.timers.tick(10000);
  assert.equal(workers.length, 1);
  assert.equal(worker.disconnect.mock.callCount(), 0);
  worker.emit("exit", 1, null);
  t.mock.timers.tick(250);
  assert.equal(workers.length, 2);
  assert.equal(workers[1].env.LLMOJ_WORKER_SLOT, "1");
});

for (const stop of ["SIGTERM", "SIGINT", "onModuleDestroy"]) {
  test(`${stop} cancels pending replacements and worker exits during shutdown are final`, async t => {
    const prior = process.listeners(stop);
    const { service, workers, exit } = await primary(t);
    const kill = t.mock.method(process, "kill", () => true);
    workers[0].emit("exit", 1, null);
    if (stop === "onModuleDestroy") service.onModuleDestroy();
    else {
      const handler = process.listeners(stop).find(fn => !prior.includes(fn));
      assert.ok(handler);
      handler(stop);
      assert.deepEqual(
        kill.mock.calls.map(call => call.arguments),
        prior.length ? [] : [[process.pid, stop]]
      );
    }
    assert.equal(workers[1].kill.mock.callCount(), 1);
    workers[1].emit("exit", null, "SIGTERM");
    t.mock.timers.tick(60000);
    assert.equal(workers.length, 2);
    assert.equal(exit.mock.callCount(), 0);
  });
}

test("null serves in the primary without installing a supervisor", async t => {
  const previous = process.listeners("SIGTERM");
  const { service, workers, serve } = await primary(t, null);
  assert.equal(serve.mock.callCount(), 1);
  assert.equal(workers.length, 0);
  assert.deepEqual(process.listeners("SIGTERM"), previous);
  const delivered = [];
  service.onMessageFromWorker("fixture", data => delivered.push(data));
  service.postMessageToMaster("fixture", 17);
  assert.deepEqual(delivered, [17]);
});

test("zero still assigns one slot per CPU", async t => {
  t.mock.method(os, "cpus", () => [{}, {}, {}]);
  const { workers, serve } = await primary(t, 0);
  assert.deepEqual(
    workers.map(w => w.env.LLMOJ_WORKER_SLOT),
    ["1", "2", "3"]
  );
  assert.equal(serve.mock.callCount(), 0);
});
