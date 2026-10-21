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
const { providerRequest, listModels, generateText, validateBaseUrl, isPublicAddress, isAllowedPrivateHost } = require(
  path.join(backendRoot, "src/ai/ai-provider.ts")
);
const { withAiRuntime } = require(path.join(backendRoot, "src/ai/ai-runtime.ts"));
const { AiError } = require(path.join(backendRoot, "src/ai/ai.types.ts"));
const initialAllowlist = process.env.HYHOJ_AI_PRIVATE_HOSTS;
const syntheticKey = "synthetic-private-policy-key";

before(() => {
  // Empty means no private host is allowed for every user; each test opts in explicitly.
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

async function withPrivateHosts(value, work) {
  const previous = process.env.HYHOJ_AI_PRIVATE_HOSTS;
  process.env.HYHOJ_AI_PRIVATE_HOSTS = value;
  try {
    return await work();
  } finally {
    process.env.HYHOJ_AI_PRIVATE_HOSTS = previous;
  }
}
// The AI service allows private destinations in the runtime of a site administrator's own configuration.
function asUser(allowPrivateNetwork, work) {
  return withAiRuntime(
    {
      ownerId: allowPrivateNetwork ? 1 : 2,
      record: async () => {},
      allowPrivateNetwork: async () => allowPrivateNetwork
    },
    work
  );
}
function syntheticConfig(f, hostname) {
  const baseUrl = (hostname ? "http://" + hostname + ":" + f.port : f.origin) + "/v1";
  return { type: "chat", baseUrl, apiKey: syntheticKey, model: "synthetic-model", maxTokens: 1024 };
}

async function proveBlocked(f, hostname) {
  const config = syntheticConfig(f, hostname);
  await assert.rejects(listModels(config), errorCode("PRIVATE_ENDPOINT_BLOCKED"));
  await assert.rejects(
    asUser(false, () => listModels(config)),
    errorCode("PRIVATE_ENDPOINT_BLOCKED")
  );
  await assert.rejects(
    asUser(false, () => generateText(config, "Synthetic local test.", "Reply synthetic-ok.")),
    errorCode("PRIVATE_ENDPOINT_BLOCKED")
  );
  assert.equal(f.requests.length, 0, "A blocked destination must not receive any request.");
}

async function proveSyntheticModelsAndChat(f, hostname) {
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

test("public and non-public addresses are classified, including IPv4-mapped IPv6", () => {
  for (const address of [
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::808:808"
  ])
    assert.equal(isPublicAddress(address), true, address);
  for (const address of [
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fd00::1",
    "fc00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "2001:db8::1",
    "64:ff9b:1::1",
    "2002:a00:1::1",
    "not-an-address"
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of ["172.15.255.255", "172.32.0.1", "100.128.0.1", "11.0.0.1"])
    assert.equal(isPublicAddress(address), true, address);
});

test("HYHOJ_AI_PRIVATE_HOSTS matches hosts and optional ports exactly", () => {
  const env = { HYHOJ_AI_PRIVATE_HOSTS: "LLM.lan, 10.0.0.5:8000 [fd00::5]:8080 [::1] fd00::6" };
  for (const url of [
    "http://llm.lan/v1",
    "https://llm.lan:9000/v1",
    "http://10.0.0.5:8000/v1",
    "http://[fd00::5]:8080/v1",
    "http://[::1]:1234/v1",
    "http://[fd00:0::6]/v1"
  ])
    assert.equal(isAllowedPrivateHost(new URL(url), env), true, url);
  for (const url of [
    "http://10.0.0.5/v1",
    "http://10.0.0.5:8001/v1",
    "http://other.lan/v1",
    "http://llm.lan.evil.example/v1",
    "http://[fd00::5]/v1",
    "http://127.0.0.1/v1"
  ])
    assert.equal(isAllowedPrivateHost(new URL(url), env), false, url);
  assert.equal(isAllowedPrivateHost(new URL("http://127.0.0.1/v1"), {}), false);
  assert.equal(
    isAllowedPrivateHost(new URL("https://127.0.0.1/v1"), { HYHOJ_AI_PRIVATE_HOSTS: "127.0.0.1:443" }),
    true
  );
});

// A parent with concurrency:false keeps the temporary DNS override and shared
// allowlist setting isolated from every sibling in this file.
test("AI provider private-address policy regression", { concurrency: false, timeout: 30000 }, async t => {
  await t.test("loopback is blocked for ordinary users and calls without an owner", { timeout: 4000 }, async () => {
    const f = await fixture();
    try {
      await proveBlocked(f);
      await proveBlocked(f, "localhost");
    } finally {
      await f.close();
    }
  });

  await t.test("127.0.0.1 HTTP models and generation work when allowlisted", { timeout: 4000 }, async () => {
    const f = await fixture();
    try {
      await withPrivateHosts("127.0.0.1", () => proveSyntheticModelsAndChat(f));
    } finally {
      await f.close();
    }
  });

  await t.test("localhost HTTP uses real DNS and works when allowlisted by name", { timeout: 4000 }, async () => {
    const f = await fixture();
    try {
      await withPrivateHosts("localhost", () => proveSyntheticModelsAndChat(f, "localhost"));
    } finally {
      await f.close();
    }
  });

  await t.test("an allowlist entry with a port only allows that port", { timeout: 4000 }, async () => {
    const f = await fixture();
    try {
      await withPrivateHosts("127.0.0.1:" + (f.port === 1 ? 2 : 1), () => proveBlocked(f));
      await withPrivateHosts("127.0.0.1:" + f.port, () => proveSyntheticModelsAndChat(f));
    } finally {
      await f.close();
    }
  });

  await t.test("site administrators can use loopback without an allowlist", { timeout: 4000 }, async () => {
    const f = await fixture();
    try {
      await asUser(true, () => proveSyntheticModelsAndChat(f));
    } finally {
      await f.close();
    }
  });

  await t.test("local LAN HTTP is blocked for users and works for administrators", { timeout: 4000 }, async t => {
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
      if (!isPublicAddress(lanHost)) await proveBlocked(f);
      await asUser(true, () => proveSyntheticModelsAndChat(f));
    } finally {
      await f.close();
    }
  });

  await t.test("IPv6 loopback HTTP is blocked by default and works when allowed", { timeout: 4000 }, async t => {
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
      await proveBlocked(f);
      await withPrivateHosts("[::1]:" + f.port, () => proveSyntheticModelsAndChat(f));
    } finally {
      await f.close();
    }
  });

  await t.test("302 is rejected without following its Location", { timeout: 3000 }, async () => {
    const f = await fixture();
    try {
      await withPrivateHosts("127.0.0.1", () =>
        assert.rejects(providerRequest(f.origin + "/redirect", {}, undefined, 1000), errorCode("PROVIDER_HTTP_ERROR"))
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
      await withPrivateHosts("127.0.0.1", () =>
        assert.rejects(
          providerRequest(f.origin + "/oversize", {}, undefined, 2000),
          errorCode("PROVIDER_RESPONSE_TOO_LARGE")
        )
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
      await withPrivateHosts("127.0.0.1", () =>
        assert.rejects(providerRequest(f.origin + "/stall", {}, undefined, 150), errorCode("PROVIDER_TIMEOUT"))
      );
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
      const pending = withAiRuntime(
        { ownerId: 991, signal: controller.signal, record: async () => {}, allowPrivateNetwork: async () => true },
        () => providerRequest(f.origin + "/stall", {}, undefined, 10000)
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

  await t.test(
    "a name resolving to any non-public address is blocked before connecting",
    { timeout: 4000 },
    async () => {
      const f = await fixture();
      const originalLookup = dns.promises.lookup;
      const hostname = "synthetic-rebinding-provider.invalid";
      try {
        for (const records of [
          [{ address: "127.0.0.1", family: 4 }],
          [
            { address: "8.8.8.8", family: 4 },
            { address: "127.0.0.1", family: 4 }
          ],
          [{ address: "::ffff:7f00:1", family: 6 }],
          [{ address: "169.254.169.254", family: 4 }]
        ]) {
          dns.promises.lookup = async (name, options) => {
            assert.equal(name, hostname, "No external hostname may be resolved by this test.");
            assert.equal(options.all, true);
            return records;
          };
          await assert.rejects(
            asUser(false, () => providerRequest("http://" + hostname + ":" + f.port + "/models", {}, undefined, 1000)),
            errorCode("PRIVATE_ENDPOINT_BLOCKED")
          );
        }
        assert.equal(f.requests.length, 0);
      } finally {
        dns.promises.lookup = originalLookup;
        await f.close();
      }
    }
  );

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
      const result = await withPrivateHosts(hostname, () =>
        providerRequest("http://" + hostname + ":" + f.port + "/models", {}, undefined, 1000)
      );
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

const { parseAiEndpointPolicy, normalizeEndpointUrl, endpointMatches, aiEndpointRefusal } = require(
  path.join(backendRoot, "src/settings/ai-endpoint-policy.service.ts")
);

test("approved AI endpoints: stored form, matching and the refusal rules", () => {
  assert.equal(normalizeEndpointUrl("http://10.0.0.5:8000/v1/"), "http://10.0.0.5:8000/v1");
  assert.equal(normalizeEndpointUrl("https://LLM.example.org"), "https://llm.example.org");
  for (const invalid of ["ftp://x", "https://u:p@x/v1", "https://x/v1?key=1", "https://x/#a", "not a url", 5])
    assert.equal(normalizeEndpointUrl(invalid), null, String(invalid));

  const endpoint = { name: "Lab", type: "chat", baseUrl: "http://10.0.0.5:8000/v1" };
  const policy = parseAiEndpointPolicy({
    customEndpoints: "approved",
    endpoints: [{ ...endpoint, baseUrl: "http://10.0.0.5:8000/v1/" }]
  });
  assert.deepEqual(policy, { customEndpoints: "approved", endpoints: [endpoint] });
  for (const invalid of [
    null,
    [],
    { customEndpoints: "any", endpoints: [] },
    { customEndpoints: "public" },
    { customEndpoints: "public", endpoints: [{ ...endpoint, name: " " }] },
    { customEndpoints: "public", endpoints: [{ ...endpoint, type: "gopher" }] },
    { customEndpoints: "public", endpoints: [{ ...endpoint, baseUrl: "http://10.0.0.5:8000/v1?x=1" }] },
    { customEndpoints: "public", endpoints: [endpoint, { ...endpoint, name: "Again" }] },
    {
      customEndpoints: "public",
      endpoints: new Array(51).fill(0).map((_, i) => ({ ...endpoint, baseUrl: `http://h${i}/v1` }))
    }
  ])
    assert.equal(parseAiEndpointPolicy(invalid), null, JSON.stringify(invalid)?.slice(0, 80));

  const matches = url => endpointMatches(endpoint, new URL(url));
  assert.equal(matches("http://10.0.0.5:8000/v1/chat/completions"), true);
  assert.equal(matches("http://10.0.0.5:8000/v1"), true);
  assert.equal(matches("http://10.0.0.5:8000/v10/models"), false, "a path prefix ends at a slash");
  assert.equal(matches("http://10.0.0.5:8001/v1/models"), false, "another port");
  assert.equal(matches("https://10.0.0.5:8000/v1/models"), false, "another scheme");
  assert.equal(endpointMatches({ baseUrl: "http://10.0.0.5:8000" }, new URL("http://10.0.0.5:8000/any/path")), true);

  const refusal = (customEndpoints, url, options) =>
    aiEndpointRefusal({ customEndpoints, endpoints: [endpoint] }, new URL(url), {
      privateDestination: false,
      administrator: false,
      serverApproved: false,
      ...options
    });
  // Private addresses need an approval, whatever the policy for public ones
  assert.equal(refusal("public", "http://10.0.0.5:8000/v1/models", { privateDestination: true }), null);
  assert.equal(
    refusal("public", "http://10.0.0.6/v1/models", { privateDestination: true }),
    "PRIVATE_ENDPOINT_BLOCKED"
  );
  assert.equal(
    refusal("public", "http://10.0.0.6/v1/models", { privateDestination: true, serverApproved: true }),
    null
  );
  // Public addresses need one only where the site allows only approved addresses
  assert.equal(refusal("public", "https://api.example.com/v1/models"), null);
  assert.equal(refusal("approved", "https://api.example.com/v1/models"), "ENDPOINT_NOT_APPROVED");
  // Site administrators may use any address
  assert.equal(
    refusal("approved", "http://10.0.0.6/v1/models", { privateDestination: true, administrator: true }),
    null
  );
});

test("approved AI endpoints are enforced for every provider request of an account", { timeout: 15000 }, async () => {
  const { AiJobCoordinator } = require(path.join(backendRoot, "src/ai/ai-job-coordinator.service.ts"));
  const f = await fixture();
  try {
    let policy = { customEndpoints: "public", endpoints: [] };
    let administrator = false;
    // The coordinator's own runtime, with the services it reads stubbed
    const coordinator = Object.assign(Object.create(AiJobCoordinator.prototype), {
      usage: { context: ownerId => ({ ownerId, record: async () => {} }) },
      endpointPolicies: { current: async () => policy },
      db: { getRepository: () => ({ findOneBy: async () => ({ isAdmin: administrator }) }) }
    });
    const asAccount = work => coordinator.withRuntime(2, undefined, work);
    const config = syntheticConfig(f);

    await assert.rejects(
      asAccount(() => listModels(config)),
      errorCode("PRIVATE_ENDPOINT_BLOCKED")
    );
    assert.equal(f.requests.length, 0, "A refused request must not reach the provider.");

    // Approving the address (here a path above the configured one) lets the account use it
    policy = { customEndpoints: "approved", endpoints: [{ name: "Lab", type: "chat", baseUrl: f.origin }] };
    assert.deepEqual(await asAccount(() => listModels(config)), ["synthetic-model"]);
    assert.equal(
      await asAccount(() => generateText(config, "Synthetic local test.", "Reply synthetic-ok.")),
      "synthetic-ok"
    );

    // Another port of the same host isn't approved
    policy = {
      customEndpoints: "approved",
      endpoints: [{ name: "Lab", type: "chat", baseUrl: `http://127.0.0.1:${f.port === 1 ? 2 : 1}` }]
    };
    const before = f.requests.length;
    await assert.rejects(
      asAccount(() => listModels(config)),
      errorCode("PRIVATE_ENDPOINT_BLOCKED")
    );
    assert.equal(f.requests.length, before);

    // The server's environment list still approves, and administrators may use any address
    await withPrivateHosts("127.0.0.1", async () =>
      assert.deepEqual(await asAccount(() => listModels(config)), ["synthetic-model"])
    );
    administrator = true;
    assert.deepEqual(await asAccount(() => listModels(config)), ["synthetic-model"]);
  } finally {
    await f.close();
  }
});
