/* Local synthetic providers only; no external AI calls or real credentials.
 * Run: node --test apps/backend/src/ai/ai-network-policy.test.cjs
 */
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const dns = require("node:dns");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const backendRoot = path.resolve(process.env.BACKEND_ROOT || path.join(__dirname, "../.."));
const backendRequire = createRequire(path.join(backendRoot, "package.json"));
const ts = backendRequire("typescript");
backendRequire("reflect-metadata");
const originalTsLoader = require.extensions[".ts"];
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
const { providerRequest, listModels, generateText, validateBaseUrl } = require(path.join(
  backendRoot,
  "src/ai/ai-provider.ts"
));
const { withAiRuntime } = require(path.join(backendRoot, "src/ai/ai-runtime.ts"));
const { AiError } = require(path.join(backendRoot, "src/ai/ai.types.ts"));
const initialAllowlist = process.env.HYHOJ_AI_PRIVATE_HOSTS;
const syntheticKey = "synthetic-private-policy-key";

before(() => {
  // Empty means no implicit exception from the legacy environment variable.
  process.env.HYHOJ_AI_PRIVATE_HOSTS = "";
});
after(() => {
  if (initialAllowlist === undefined) delete process.env.HYHOJ_AI_PRIVATE_HOSTS;
  else process.env.HYHOJ_AI_PRIVATE_HOSTS = initialAllowlist;
  if (originalTsLoader === undefined) delete require.extensions[".ts"];
  else require.extensions[".ts"] = originalTsLoader;
});

function errorCode(code) {
  return error => error instanceof AiError && error.code === code;
}
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function eventually(condition, description, timeout = 1500) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= end) assert.fail(description);
    await delay(10);
  }
}

async function fixture(host = "127.0.0.1") {
  const sockets = new Set();
  const requests = [];
  const closed = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const entry = { path: req.url, method: req.method, headers: req.headers, body };
      requests.push(entry);
      res.on("close", () => closed.add(entry));
      if (req.url === "/stall") return; // Deliberately never sends a response.
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/redirect-target", "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.url === "/oversize") {
        // A valid JSON response just over the implementation's 16 MiB cap.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"output_text":"' + "x".repeat(16 * 1024 * 1024) + '"}');
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/chat/completions") {
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "synthetic-ok" } }] }));
      } else {
        res.end(JSON.stringify({ data: [{ id: "synthetic-model" }] }));
      }
    } catch (error) {
      res.destroy(error);
    }
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    const fail = error => {
      server.removeListener("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.removeListener("error", fail);
      resolve();
    };
    server.once("error", fail);
    server.once("listening", ready);
    server.listen(0, host);
  });
  const port = server.address().port;
  const formattedHost = host.includes(":") ? "[" + host + "]" : host;
  return {
    server,
    requests,
    closed,
    sockets,
    port,
    origin: "http://" + formattedHost + ":" + port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
  };
}

async function proveSyntheticModelsAndChat(f, hostname) {
  assert.equal(process.env.HYHOJ_AI_PRIVATE_HOSTS, "");
  const baseUrl = (hostname ? "http://" + hostname + ":" + f.port : f.origin) + "/v1";
  const config = { type: "chat", baseUrl, apiKey: syntheticKey, model: "synthetic-model", maxTokens: 1024 };
  assert.deepEqual(await listModels(config), ["synthetic-model"]);
  assert.equal(await generateText(config, "Synthetic local test.", "Reply synthetic-ok."), "synthetic-ok");
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].path, "/v1/models");
  assert.equal(f.requests[1].path, "/v1/chat/completions");
  assert.equal(f.requests[1].headers.authorization, "Bearer " + syntheticKey);
  assert.equal(f.requests[1].body.model, "synthetic-model");
}

// A parent with concurrency:false keeps the temporary DNS override and shared
// allowlist setting isolated from every sibling in this file.
test("AI provider private-address policy regression", { concurrency: false, timeout: 30000 }, async t => {
  await t.test("127.0.0.1 HTTP models and generation work with an empty allowlist", { timeout: 4000 }, async () => {
    const f = await fixture();
    try {
      await proveSyntheticModelsAndChat(f);
    } finally {
      await f.close();
    }
  });

  await t.test("localhost HTTP uses real DNS and works with an empty allowlist", { timeout: 4000 }, async () => {
    const f = await fixture();
    try {
      await proveSyntheticModelsAndChat(f, "localhost");
    } finally {
      await f.close();
    }
  });

  await t.test("local LAN HTTP models and generation work with an empty allowlist", { timeout: 4000 }, async t => {
    const localAddresses = Object.values(os.networkInterfaces()).flat().filter(Boolean);
    const ipv4 = localAddresses.filter(x => (x.family === "IPv4" || x.family === 4) && !x.internal);
    const preferred = ipv4.find(x => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(x.address));
    const lanHost = process.env.LAN_HOST || preferred?.address || ipv4[0]?.address;
    if (!lanHost) {
      t.skip("No local non-loopback IPv4 interface is available.");
      return;
    }
    assert(
      ipv4.some(x => x.address === lanHost),
      "LAN_HOST must name this machine's own IPv4 address."
    );
    t.diagnostic("Synthetic provider bound only to local interface " + lanHost);
    const f = await fixture(lanHost);
    try {
      await proveSyntheticModelsAndChat(f);
    } finally {
      await f.close();
    }
  });

  await t.test("IPv6 loopback HTTP works when ::1 is available", { timeout: 4000 }, async t => {
    let f;
    try {
      f = await fixture("::1");
    } catch (error) {
      if (["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(error.code)) {
        t.skip("IPv6 loopback is unavailable: " + error.code);
        return;
      }
      throw error;
    }
    try {
      await proveSyntheticModelsAndChat(f);
    } finally {
      await f.close();
    }
  });

  await t.test("302 is rejected without following its Location", { timeout: 3000 }, async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        providerRequest(f.origin + "/redirect", {}, undefined, 1000),
        errorCode("PROVIDER_HTTP_ERROR")
      );
      await delay(30);
      assert.deepEqual(
        f.requests.map(x => x.path),
        ["/redirect"]
      );
      assert.equal(f.requests.filter(x => x.path === "/redirect-target").length, 0);
    } finally {
      await f.close();
    }
  });

  await t.test("base URL protocol, credentials, query and fragment validation is retained", () => {
    for (const invalid of [
      "not a url",
      "file:///etc/passwd",
      "ftp://127.0.0.1/file",
      "http://fixture-user:fixture-password@127.0.0.1",
      "https://example.invalid?api_key=synthetic",
      "http://127.0.0.1#fragment"
    ])
      assert.throws(() => validateBaseUrl(invalid), errorCode("INVALID_BASE_URL"));
    for (const valid of ["http://127.0.0.1:1234/v1", "http://192.168.1.10:1234/v1", "https://example.invalid/v1"]) {
      assert.equal(validateBaseUrl(valid).href, valid);
    }
  });

  await t.test("responses larger than 16 MiB are still rejected", { timeout: 5000 }, async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        providerRequest(f.origin + "/oversize", {}, undefined, 2000),
        errorCode("PROVIDER_RESPONSE_TOO_LARGE")
      );
      await eventually(() => f.closed.size === 1, "Oversize response socket did not close.");
    } finally {
      await f.close();
    }
  });

  await t.test("stalled HTTP response still times out and closes its socket", { timeout: 4000 }, async () => {
    const f = await fixture();
    try {
      const start = Date.now();
      await assert.rejects(providerRequest(f.origin + "/stall", {}, undefined, 150), errorCode("PROVIDER_TIMEOUT"));
      assert(Date.now() - start < 2000, "Timeout did not finish promptly.");
      assert.equal(f.requests.length, 1);
      await eventually(() => f.closed.size === 1, "Timed-out response socket did not close.");
    } finally {
      await f.close();
    }
  });

  await t.test("cancelling an in-flight HTTP request closes it with JOB_CANCELLED", { timeout: 4000 }, async () => {
    const f = await fixture();
    const controller = new AbortController();
    try {
      const pending = withAiRuntime({ ownerId: 991, signal: controller.signal, record: async () => {} }, () =>
        providerRequest(f.origin + "/stall", {}, undefined, 10000)
      );
      // Attach the rejection handler before aborting to avoid unhandled rejection noise.
      const rejected = assert.rejects(pending, errorCode("JOB_CANCELLED"));
      await eventually(() => f.requests.length === 1, "Synthetic request never reached local server.");
      const start = Date.now();
      controller.abort(new AiError("JOB_CANCELLED"));
      await rejected;
      assert(Date.now() - start < 1500, "Cancellation waited for the provider timeout.");
      await eventually(() => f.closed.size === 1, "Cancelled response socket did not close.");
    } finally {
      controller.abort();
      await f.close();
    }
  });

  await t.test("DNS is resolved once then pinned into a real HTTP connection", { timeout: 4000 }, async () => {
    const f = await fixture();
    const originalLookup = dns.promises.lookup;
    const hostname = "synthetic-private-provider.invalid";
    let count = 0;
    try {
      dns.promises.lookup = async (name, options) => {
        assert.equal(name, hostname, "No external hostname may be resolved by this test.");
        assert.equal(options.all, true);
        count += 1;
        assert.equal(count, 1, "Provider unexpectedly resolved DNS more than once.");
        return [{ address: "127.0.0.1", family: 4 }];
      };
      const result = await providerRequest("http://" + hostname + ":" + f.port + "/models", {}, undefined, 1000);
      assert.deepEqual(result.data, { data: [{ id: "synthetic-model" }] });
      assert.equal(count, 1);
      assert.equal(f.requests.length, 1, "The request must reach the real local HTTP server.");
      assert.equal(f.requests[0].headers.host, hostname + ":" + f.port);
    } finally {
      dns.promises.lookup = originalLookup;
      await f.close();
    }
  });

  await t.test("an empty DNS result remains a network error", { timeout: 3000 }, async () => {
    const originalLookup = dns.promises.lookup;
    try {
      dns.promises.lookup = async (hostname, options) => {
        assert.equal(hostname, "empty-private-provider.invalid");
        assert.equal(options.all, true);
        return [];
      };
      await assert.rejects(
        providerRequest("http://empty-private-provider.invalid/models", {}, undefined, 1000),
        errorCode("PROVIDER_NETWORK_ERROR")
      );
    } finally {
      dns.promises.lookup = originalLookup;
    }
  });
});
