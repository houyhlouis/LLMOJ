const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const cluster = require("node:cluster");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const ts = require("typescript");
const { redisAvailable, startRedis } = require("../../test/temporary-redis.cjs");

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

test("SIGTERM before primary initialization prevents the first worker fork", async t => {
  const prior = process.listeners("SIGTERM");
  const fork = t.mock.method(cluster, "fork", () => assert.fail("forked after shutdown"));
  const service = new ClusterService({ config: { server: { clusters: 2 } } });
  t.after(() => service.onModuleDestroy());
  t.mock.method(process, "kill", () => true);
  process.listeners("SIGTERM").find(handler => !prior.includes(handler))("SIGTERM");
  await service.initialization(() => assert.fail("primary started serving"));
  assert.equal(fork.mock.callCount(), 0);
});

// Keep a real judge namespace transport and an active request on a reused keep-alive connection open
// across the signal. TCP and Redis are confined to the suite's own ephemeral ports.
async function openClients(t, port) {
  const { io } = require(require.resolve("socket.io-client", { paths: [path.resolve(__dirname, "../../../judge")] }));
  const judge = io(`http://127.0.0.1:${port}/judge`, {
    path: "/api/socket", transports: ["websocket"], parser: require("socket.io-msgpack-parser"), reconnection: false
  });
  t.after(() => judge.close());
  await new Promise((resolve, reject) => { judge.once("connect", resolve); judge.once("connect_error", reject); });
  const judgeClosed = new Promise(resolve => judge.once("disconnect", resolve));

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const options = { host: "127.0.0.1", port, agent };
  let firstSocket;
  await new Promise((resolve, reject) => http.get({ ...options, path: "/docs-json" }, res => {
    if (res.statusCode !== 200) reject(new Error(`Swagger HTTP status ${res.statusCode}`));
    firstSocket = res.socket;
    res.resume().once("end", resolve);
  }).once("error", reject));
  const pending = http.get({ ...options, path: "/api/hold" });
  pending.on("error", () => {}); // Shutdown interrupts this unfinished response.
  const [socket] = await once(pending, "socket");
  assert.equal(socket, firstSocket);
  const httpClosed = new Promise(resolve => socket.once("close", resolve));
  return { closed: Promise.all([judgeClosed, httpClosed]) };
}

async function stopProcessGroup(t, mode) {
  const redis = mode === "tcp" ? await startRedis(t) : null;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-stop-"));
  const log = path.join(directory, "events");
  fs.writeFileSync(log, "");
  const stderr = path.join(directory, "stderr");
  const fd = fs.openSync(stderr, "wx", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [
      "--unhandled-rejections=strict", path.join(__dirname, "cluster-shutdown-child.cjs"),
      directory, mode, String(redis?.options?.port || 0)
    ], { detached: true, env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  const exited = once(child, "close");
  const errors = () => fs.readFileSync(stderr, "utf8").slice(-4000);
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function events(name) {
    return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
      .filter(row => row.event === name);
  }
  async function until(condition) {
    const timeout = Date.now() + 30000;
    while (!condition()) {
      assert.ok(child.exitCode === null && child.signalCode === null && Date.now() < timeout,
        `Fixture did not reach start barrier. ${errors()}\n${fs.readFileSync(log, "utf8")}`);
      await delay(15);
    }
  }
  let clients;
  if (redis) {
    await until(() => events("listening").length === 2);
    clients = await openClients(t, events("listening")[0].value);
    await until(() => events("judge-connected").length === 1 && events("request-pending").length === 1);
  } else await until(() => events("ready").length === 3);
  fs.writeFileSync(path.join(directory, "acquire"), "");
  await until(() => events(redis ? "held" : "refresh-pending").length === 3);
  const holders = events("held").map(row => row.pid).sort();
  assert.deepEqual(events("held").map(row => row.slot).sort(), [0, 1, 2]);
  assert.equal(events("fork").length, 2);

  // systemd KillMode=control-group delivers the signal to the primary and all workers.
  const signaledAt = performance.now();
  process.kill(-child.pid, "SIGTERM");
  const stopped = Promise.all([exited, clients?.closed]);
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Shutdown took over 15s. ${errors()}\n${fs.readFileSync(log, "utf8")}`)), 15000);
  });
  const [[code, signal]] = await Promise.race([stopped, limit]).finally(() => clearTimeout(timer));
  t.diagnostic(`Stopped the process group and closed its clients in ${Math.round(performance.now() - signaledAt)} ms`);
  assert.ok(code === 0 || signal === "SIGTERM", `primary exited with ${code}/${signal}: ${errors()}`);
  assert.equal(events("fork").length, 2, "no workers replaced after SIGTERM");
  if (mode === "stuck") {
    assert.match(errors(), /Worker slot 2 did not finish shutdown/);
    assert.match(errors(), /Backend shutdown timed out/);
  }
  assert.deepEqual(events("lost").map(row => row.pid).sort(), holders);
  if (!redis) assert.deepEqual(events("disconnected").map(row => row.pid).sort(), holders);
  assert.deepEqual(events("closed").map(row => row.slot).sort(), mode === "stuck" ? [1] : [0, 1, 2]);
  const exits = events("worker-exit").map(row => row.value);
  assert.deepEqual(exits.map(exit => exit.pid).sort(), events("fork").map(row => row.value).sort());
  for (const exit of exits) {
    const forced = mode === "stuck" && events("held").some(row => row.slot === 2 && row.pid === exit.pid);
    if (forced) assert.equal(exit.signal, "SIGKILL");
    else assert.ok(exit.code === 0 || exit.signal === "SIGTERM", JSON.stringify(exit));
  }
  if (redis) {
    const connected = await redis.client("LIST");
    for (const pid of holders) {
      assert.ok(!connected.includes(`name=shutdown-${pid} `), "the lock connection closed");
      const remaining = await redis.pttl(`shutdown-${pid}`);
      assert.ok(remaining === -2 || (remaining >= 0 && remaining <= 5000), "surviving lease has bounded TTL");
    }
  }
}

test("process-group SIGTERM drains Nest leases and workers before the cluster primary exits", { timeout: 60000 },
  t => stopProcessGroup(t, "ipc"));
test("process-group shutdown remains bounded when a worker's Nest shutdown hook stalls", { timeout: 60000 },
  t => stopProcessGroup(t, "stuck"));
test("process-group SIGTERM closes the judge websocket, HTTP request and Redis lease clients", {
  skip: !redisAvailable && "needs redis-server", timeout: 60000
}, t => stopProcessGroup(t, "tcp"));
