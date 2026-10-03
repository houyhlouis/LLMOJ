/* Run: node --test src/ai/ai-security.test.cjs. Uses temporary synthetic keys only. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
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
const { loadAiEncryptionKey, encryptAiConfiguration, decryptAiConfiguration } = require("./ai-crypto.ts");
const { isAiRequest, AI_ERROR_REPORT_MESSAGE, AI_REQUEST_BODY_REDACTED } = require("./ai-security.ts");
const { EventReportService, EventReportType } = require("../event-report/event-report.service.ts");
const { ErrorFilter } = require("../error.filter.ts");
const { Logger, BadRequestException } = require("@nestjs/common");
const configuration = {
  llm: { type: "chat", baseUrl: "https://example.org/v1", model: "fixture", apiKey: "synthetic-llm-secret" },
  search: { type: "tavily", baseUrl: "https://api.tavily.com", apiKey: "synthetic-search-secret" },
  autoOnSave: true
};
async function temporary(work) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "hyhoj-ai-crypto-test-"));
  try {
    await work(directory);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

test("both API keys are authenticated ciphertext with a unique IV", () => {
  const key = crypto.randomBytes(32);
  const first = encryptAiConfiguration(key, configuration),
    second = encryptAiConfiguration(key, configuration);
  assert.notEqual(first, second);
  assert.deepEqual(decryptAiConfiguration(key, first), configuration);
  assert(!first.includes(configuration.llm.apiKey));
  assert(!first.includes(configuration.search.apiKey));
});

test("existing iv.tag.ciphertext records remain decryptable", () => {
  const key = crypto.randomBytes(32),
    iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(configuration), "utf8"), cipher.final()]);
  const legacy = [iv, cipher.getAuthTag(), encrypted].map(value => value.toString("base64")).join(".");
  assert.deepEqual(decryptAiConfiguration(key, legacy), configuration);
});

test("tampered records, wrong keys and malformed plaintext fail without exposing contents", () => {
  const key = crypto.randomBytes(32),
    value = encryptAiConfiguration(key, configuration);
  const pieces = value.split(".");
  const damaged = Buffer.from(pieces[2], "base64");
  damaged[0] ^= 1;
  pieces[2] = damaged.toString("base64");
  for (const [tryKey, record] of [
    [key, pieces.join(".")],
    [crypto.randomBytes(32), value],
    [key, value + ".extra"],
    [key, "synthetic-llm-secret"]
  ]) {
    assert.throws(
      () => decryptAiConfiguration(tryKey, record),
      error => error.message === "Invalid AI encrypted configuration"
    );
  }
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const invalid = Buffer.concat([cipher.update("synthetic-llm-secret", "utf8"), cipher.final()]);
  const record = [iv, cipher.getAuthTag(), invalid].map(value => value.toString("base64")).join(".");
  assert.throws(
    () => decryptAiConfiguration(key, record),
    error => error.message === "Invalid AI encrypted configuration"
  );
});

test("new installation creates private files and restart preserves the same key", async () =>
  temporary(async directory => {
    const state = path.join(directory, "state");
    const first = await loadAiEncryptionKey(state, false);
    assert.equal(first.length, 32);
    assert.equal((await fsp.stat(state)).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(path.join(state, "master.key"))).mode & 0o777, 0o600);
    assert.deepEqual(await loadAiEncryptionKey(state, true), first);
  }));

test("existing permissions are tightened without rotating or rewriting the key", async () =>
  temporary(async directory => {
    const filename = path.join(directory, "master.key"),
      key = crypto.randomBytes(32);
    await fsp.writeFile(filename, key, { mode: 0o644 });
    await fsp.chmod(directory, 0o755);
    const before = await fsp.stat(filename);
    assert.deepEqual(await loadAiEncryptionKey(directory, true), key);
    const after = await fsp.stat(filename);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.mode & 0o777, 0o600);
    assert.equal((await fsp.stat(directory)).mode & 0o777, 0o700);
  }));

test("missing key with saved configuration is never silently regenerated", async () =>
  temporary(async directory => {
    await assert.rejects(loadAiEncryptionKey(directory, true), /restore the original master.key/);
    await assert.rejects(fsp.stat(path.join(directory, "master.key")), { code: "ENOENT" });
  }));

test("symlinked key cannot be read or chmod its target", async () =>
  temporary(async directory => {
    const state = path.join(directory, "state"),
      target = path.join(directory, "target");
    await fsp.mkdir(state);
    await fsp.writeFile(target, crypto.randomBytes(32), { mode: 0o644 });
    await fsp.symlink(target, path.join(state, "master.key"));
    await assert.rejects(loadAiEncryptionKey(state, true), /Cannot safely open/);
    assert.equal((await fsp.stat(target)).mode & 0o777, 0o644);
  }));

test("symlinked state directory and multiply linked keys are rejected", async () =>
  temporary(async directory => {
    const state = path.join(directory, "state"),
      linkedState = path.join(directory, "alias");
    await fsp.mkdir(state, { mode: 0o755 });
    await fsp.symlink(state, linkedState);
    await assert.rejects(loadAiEncryptionKey(linkedState, false));
    assert.equal((await fsp.stat(state)).mode & 0o777, 0o755);
    const target = path.join(directory, "target");
    await fsp.writeFile(target, crypto.randomBytes(32));
    await fsp.link(target, path.join(state, "master.key"));
    await assert.rejects(loadAiEncryptionKey(state, true), /single-link regular/);
  }));

test("invalid-length key fails safely without replacing it", async () =>
  temporary(async directory => {
    const filename = path.join(directory, "master.key"),
      original = Buffer.from("do-not-replace");
    await fsp.writeFile(filename, original);
    await assert.rejects(loadAiEncryptionKey(directory, true), /32-byte file/);
    assert.deepEqual(await fsp.readFile(filename), original);
  }));

test("AI route detection covers query/case/encoded paths and leaves unrelated routes alone", () => {
  for (const url of ["/api/ai/saveConfiguration", "/api/ai/jobs?x=1", "/API/AI/test", "/api/%61i/test", "/api/ai"])
    assert(isAiRequest(url));
  for (const url of ["/api/user/login", "/api/air", "/api/problems?next=/api/ai", undefined]) assert(!isAiRequest(url));
});

function reportFixture() {
  const messages = [];
  const service = new EventReportService(
    { config: { eventReport: {}, preference: { siteName: "HYHOJ" } } },
    { postMessageToMaster: (_channel, message) => messages.push(message) }
  );
  service.enabled = true; // Record the IPC payload without constructing or contacting a Telegram client.
  return { service, messages };
}

test("AI exception reports remove body, query, custom details and exception secrets", async () => {
  const { service, messages } = reportFixture();
  await service.report({
    type: EventReportType.Error,
    error: new Error("synthetic-llm-secret"),
    message: "synthetic-search-secret",
    request: {
      originalUrl: "/api/ai/saveConfiguration?key=synthetic-query-secret",
      body: configuration,
      ip: "127.0.0.1"
    }
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].fileContent, AI_REQUEST_BODY_REDACTED);
  assert(messages[0].message.includes(AI_ERROR_REPORT_MESSAGE));
  assert(!JSON.stringify(messages).includes("synthetic-"));
});

test("non-AI exception reports retain their diagnostic information", async () => {
  const { service, messages } = reportFixture();
  await service.report({
    type: EventReportType.Error,
    error: new Error("ordinary-error"),
    message: "ordinary-message",
    request: { originalUrl: "/api/problem/update?revision=3", body: { value: "ordinary-body" }, ip: "127.0.0.1" }
  });
  assert(messages[0].message.includes("ordinary-error"));
  assert(messages[0].message.includes("ordinary-message"));
  assert(messages[0].message.includes("revision=3"));
  assert(messages[0].fileContent.includes("ordinary-body"));
});

test("global filter hides AI errors from HTTP and logs but retains non-AI diagnostics", () => {
  const reports = [],
    logs = [],
    originalLogger = Logger.prototype.error;
  Logger.prototype.error = (...args) => logs.push(args);
  try {
    const filter = new ErrorFilter({ report: report => reports.push(report) }, { counter: () => ({ inc() {} }) });
    function invoke(url, error) {
      let body, status;
      const response = {
        status(code) {
          status = code;
          return this;
        },
        send(value) {
          body = value;
        }
      };
      filter.catch(error, {
        getType: () => "http",
        switchToHttp: () => ({
          getRequest: () => ({ originalUrl: url, body: configuration }),
          getResponse: () => response
        })
      });
      return { body, status };
    }
    assert.deepEqual(invoke("/api/ai/saveConfiguration", new Error("synthetic-llm-secret")), {
      body: { error: "INTERNAL_ERROR" },
      status: 500
    });
    assert(!JSON.stringify(logs).includes("synthetic-llm-secret"));
    assert.equal(reports.length, 1);
    const ordinary = invoke("/api/problem/update", new Error("ordinary-error"));
    assert(ordinary.body.error.includes("ordinary-error"));
    assert(ordinary.body.stack.includes("ordinary-error"));
    assert(JSON.stringify(logs).includes("ordinary-error"));
    assert.equal(invoke("/api/ai/saveConfiguration", new BadRequestException("validation-error")).status, 400);
  } finally {
    Logger.prototype.error = originalLogger;
  }
});
