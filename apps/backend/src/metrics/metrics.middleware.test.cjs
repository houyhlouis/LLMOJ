/* Run: node --test apps/backend/src/metrics/metrics.middleware.test.cjs.
 * Exercises the real response-time middleware and real local HTTP responses.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
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
const { MetricsMiddleware } = require("./metrics.middleware.ts");

async function fixture(run) {
  const observations = [];
  const histogram = Object.assign(
    (name, buckets, labels) => {
      assert.equal(name, "libreoj_request_latency_seconds");
      assert.deepEqual(buckets, [0.01, 0.1, 1]);
      assert.deepEqual(labels, ["api"]);
      return { observe: (labels, seconds) => observations.push({ labels, seconds }) };
    },
    { BUCKETS_TIME_5S_10: [0.01, 0.1, 1] }
  );
  const middleware = new MetricsMiddleware({ histogram });
  const errors = [];
  const warnings = [];
  const onWarning = warning => warnings.push(warning);
  process.on("warning", onWarning);
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    middleware
      .use(req, res, () => {
        res.statusCode = Number(req.headers["x-fixture-status"] || 200);
        res.end("fixture-response");
      })
      .catch(error => {
        errors.push(error);
        res.statusCode = 500;
        res.end("middleware-error");
      });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const request = (target, status = 200) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: target,
          method: target === "*" ? "OPTIONS" : "GET",
          agent: false,
          headers: { "x-fixture-status": String(status) }
        },
        res => {
          const chunks = [];
          res.on("data", chunk => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
          res.on("error", reject);
        }
      );
      req.setTimeout(3000, () => req.destroy(new Error("Fixture request timed out")));
      req.on("error", reject);
      req.end();
    });
  try {
    await run({ request, observations, errors });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, [], "Metrics must not interrupt a real response");
    assert.deepEqual(
      warnings.filter(w => w.name === "DeprecationWarning").map(w => w.code),
      [],
      "Requests must not emit Node deprecation warnings"
    );
    for (const observation of observations) {
      assert(Number.isFinite(observation.seconds) && observation.seconds >= 0);
      assert(observation.seconds < 3, "response-time milliseconds must be converted to seconds");
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    process.removeListener("warning", onWarning);
  }
}

test("origin-form metrics preserve paths while omitting query and fragment", () =>
  fixture(async f => {
    for (const target of [
      "/api/problems?token=fixture-secret#fragment",
      "//api/problems?q=private",
      "/api/a%2Fb?q=private",
      "*"
    ]) {
      assert.deepEqual(await f.request(target), { status: 200, body: "fixture-response" });
    }
    assert.deepEqual(
      f.observations.map(x => x.labels.api),
      ["/api/problems", "//api/problems", "/api/a%2Fb", "*"]
    );
    assert(!JSON.stringify(f.observations).includes("fixture-secret"));
  }));

test("absolute-form targets never expose host credentials or parameters in metrics", () =>
  fixture(async f => {
    assert.equal(
      (await f.request("http://fixture-user:fixture-password@example.invalid/api/status?key=fixture-key#secret"))
        .status,
      200
    );
    assert.deepEqual(
      f.observations.map(x => x.labels),
      [{ api: "/api/status" }]
    );
  }));

test("malformed absolute targets do not throw while a response is written", () =>
  fixture(async f => {
    for (const target of ["http://[", "http://fixture-user:fixture-password@["]) {
      assert.deepEqual(await f.request(target), { status: 200, body: "fixture-response" });
    }
    assert.deepEqual(f.observations, []);
  }));

test("only successful and redirect response statuses are observed", () =>
  fixture(async f => {
    for (const status of [200, 201, 302, 399, 400, 404, 500]) {
      const response = await f.request("/api/status/" + status + "?private=fixture", status);
      assert.equal(response.status, status);
    }
    assert.deepEqual(
      f.observations.map(x => x.labels.api),
      ["/api/status/200", "/api/status/201", "/api/status/302", "/api/status/399"]
    );
  }));
