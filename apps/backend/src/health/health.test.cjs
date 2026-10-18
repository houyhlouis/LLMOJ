// Liveness and readiness: what the upgrader, deploy/doctor.sh and monitors rely on.
const assert = require("node:assert/strict");
const fs = require("node:fs");
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
const { HealthService } = require("./health.service.ts");
const { HealthController } = require("./health.controller.ts");
const { AccessGuard } = require("../access/access.guard.ts");

const warnings = [];
Logger.overrideLogger({
  log() {},
  error() {},
  debug() {},
  verbose() {},
  warn: message => warnings.push(message)
});

function service({ database = async () => [{ 1: 1 }], redis = async () => "PONG", storage = async () => true } = {}) {
  const calls = { database: 0, redis: 0, storage: 0 };
  const health = new HealthService(
    { query: () => (calls.database++, database()) },
    { ping: () => (calls.redis++, redis()) },
    { storageAvailable: () => (calls.storage++, storage()) }
  );
  health.checkTimeout = 50;
  return { health, calls };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    }
  };
}

test("ready when every dependency answers", async () => {
  const { health } = service();
  const res = response();
  assert.deepEqual(await new HealthController(health).ready(res), {
    status: "ready",
    checks: { database: "ok", redis: "ok", storage: "ok" }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(new HealthController(health).live(response()), { status: "ok" });
});

test("a dependency that fails or doesn't answer makes the process unavailable (HTTP 503), logged once a minute", async () => {
  warnings.length = 0;
  const { health } = service({
    redis: () => new Promise(() => {}),
    storage: async () => false
  });
  const res = response();
  assert.deepEqual(await new HealthController(health).ready(res), {
    status: "unavailable",
    checks: { database: "ok", redis: "failed", storage: "failed" }
  });
  assert.equal(res.statusCode, 503);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join("\n"), /redis failed: No answer within 50 ms/);
  assert.match(warnings.join("\n"), /storage failed: The bucket doesn't exist/);
  // Checked again after the cache time, but not logged again
  health.readiness.at -= 1000;
  await health.ready();
  assert.equal(warnings.length, 2);

  const { health: databaseDown } = service({ database: async () => Promise.reject(new Error("connect ECONNREFUSED")) });
  assert.equal((await databaseDown.ready()).checks.database, "failed");
});

test("probes within a second share one check", async () => {
  const { health, calls } = service();
  await Promise.all([health.ready(), health.ready(), health.ready()]);
  await health.ready();
  assert.deepEqual(calls, { database: 1, redis: 1, storage: 1 });
  health.readiness.at -= 1000;
  await health.ready();
  assert.deepEqual(calls, { database: 2, redis: 2, storage: 2 });
});

test("health checks answer on a site that guests can't view", async () => {
  const guard = new AccessGuard({ userHasPrivilege: async () => false });
  const context = path => ({
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => ({ route: { path }, path }) })
  });
  assert.equal(await guard.canActivate(context("/api/health/ready")), true);
  assert.equal(await guard.canActivate(context("/api/health/live")), true);
  await assert.rejects(guard.canActivate(context("/api/problem/getProblem")), /Forbidden/);
});
