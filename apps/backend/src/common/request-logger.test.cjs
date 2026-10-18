// Log lines written while a request is answered carry its ID (the X-Request-Id its response and error messages
// quote); connection errors are logged, counted and not reported as events.
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
const { RequestLogger, currentRequestId } = require("./request-logger.ts");
const { requestContext } = require("./request-context.ts");
const { ErrorFilter } = require("../error.filter.ts");

const logger = new RequestLogger();
// Without the terminal colours
const format = message =>
  logger.formatMessage("warn", message, "[Nest] 1  - ", "WARN", "[Context] ", "").replace(/\x1B\[\d+m/g, "");

test("messages logged while a request is answered carry its ID", async () => {
  assert.doesNotMatch(format("outside"), /\[request/);
  const request = { requestId: "6f1c2a4e", res: { writableEnded: false } };
  await requestContext.run(request, async () => {
    assert.equal(currentRequestId(), "6f1c2a4e");
    assert.match(format("inside"), /\[Context\] \[request 6f1c2a4e\] inside/);
    // Not twice when the message quotes it already
    assert.doesNotMatch(format("[6f1c2a4e] Internal error"), /\[request 6f1c2a4e\]/);
    assert.match(format({ some: "object" }), /\[request 6f1c2a4e\]/);
    // Work the request started that runs on after its response (an AI job) isn't marked with it
    request.res.writableEnded = true;
    assert.equal(currentRequestId(), undefined);
    assert.doesNotMatch(format("later"), /\[request/);
  });
});

test("connection errors are counted and logged once a minute, without event reports", () => {
  const logged = [];
  Logger.overrideLogger({
    log() {},
    debug() {},
    verbose() {},
    warn: message => logged.push(["warn", message]),
    error: message => logged.push(["error", message])
  });
  const reports = [];
  const counted = [];
  const filter = new ErrorFilter(
    { report: report => reports.push(report) },
    { counter: () => ({ inc: labels => counted.push(labels) }) }
  );
  const host = url => ({
    getType: () => "http",
    switchToHttp: () => ({
      getRequest: () => ({ requestId: "r-1", originalUrl: url }),
      getResponse: () => ({
        status() {
          return this;
        },
        send() {}
      })
    })
  });
  filter.catch(new Error("read ECONNRESET"), host("/api/problem/getProblem"));
  filter.catch(new Error("connect ETIMEDOUT"), host("/api/problem/getProblem"));
  assert.equal(counted.length, 2);
  assert.equal(reports.length, 0);
  assert.deepEqual(logged, [["warn", "[r-1] Connection error, not logged again for a minute: read ECONNRESET"]]);

  // An AI request's error is described by its type only
  logged.length = 0;
  filter.connectionErrorLoggedAt = -Infinity;
  filter.catch(new Error("read ECONNRESET"), host("/api/ai/startJob"));
  assert.deepEqual(logged, [["warn", "[r-1] Connection error, not logged again for a minute: Error"]]);

  // Other errors are still logged with the ID and reported
  logged.length = 0;
  filter.catch(new TypeError("boom"), host("/api/problem/getProblem"));
  assert.equal(logged[0][0], "error");
  assert.match(logged[0][1], /^\[r-1\] boom/);
  assert.equal(reports.length, 1);
});
