// Queries are counted per request, timed even though the driver reports times outside the request's context, and slow
// ones are logged with the request's ID but never their parameters.
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
const { QueryMetricsLogger, queryTotals, SLOW_QUERY_MS } = require("./query-metrics.ts");
const { requestContext } = require("../common/request-context.ts");

const warnings = [];
Logger.overrideLogger({ log() {}, error() {}, debug() {}, verbose() {}, warn: message => warnings.push(message) });

test("queries are counted for the request that makes them, and timed by their query runner", async () => {
  const logger = new QueryMetricsLogger();
  const request = { requestId: "r-1", res: { writableEnded: false } };
  const runner = {};
  await requestContext.run(request, async () => {
    logger.logQuery("SELECT 1", [], runner);
    logger.logQuery("SELECT 2", [], {});
  });
  // The driver's callback runs outside the request's context
  logger.logQuerySlow(7, "SELECT 1", [], runner);
  assert.equal(request.sqlQueries, 2);
  assert.equal(request.sqlMilliseconds, 7);

  // Work that runs on after the response (an AI job) isn't counted for the request
  request.res.writableEnded = true;
  await requestContext.run(request, async () => logger.logQuery("SELECT 3", [], runner));
  logger.logQuerySlow(5, "SELECT 3", [], runner);
  assert.equal(request.sqlQueries, 2);
  assert.equal(request.sqlMilliseconds, 7);
  // Nor are queries outside any request
  logger.logQuery("SELECT 4");
  logger.logQuerySlow(3, "SELECT 4");
  assert.equal(request.sqlQueries, 2);
});

test("slow queries are logged with the request's ID and without parameters, at most 10 a minute", async () => {
  warnings.length = 0;
  const logger = new QueryMetricsLogger();
  const request = { requestId: "r-2", res: { writableEnded: false } };
  const runner = {};
  const before = queryTotals.slow;
  await requestContext.run(request, async () => logger.logQuery("SELECT * FROM user WHERE email = ?", ["secret@example.invalid"], runner));
  logger.logQuerySlow(SLOW_QUERY_MS - 1, "SELECT fast", ["x"], runner);
  assert.equal(warnings.length, 0);
  logger.logQuerySlow(SLOW_QUERY_MS + 500, "SELECT *\n  FROM user   WHERE email = ?", ["secret@example.invalid"], runner);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], `[request r-2] Slow query (${SLOW_QUERY_MS + 500} ms): SELECT * FROM user WHERE email = ?`);
  assert.doesNotMatch(warnings.join("\n"), /secret/);
  for (let i = 0; i < 20; i++) logger.logQuerySlow(SLOW_QUERY_MS, `SELECT ${"x".repeat(400)}`, [], {});
  assert.equal(warnings.length, 10);
  assert.equal(queryTotals.slow - before, 21);
  assert(warnings[9].length < 400, "a long statement is shortened");
});

test("with LIBREOJ_LOG_SQL, every query is also printed as before", () => {
  const printed = [];
  const logger = new QueryMetricsLogger(true);
  logger.printer = { logQuery: query => printed.push(query), logQuerySlow() {}, logQueryError() {}, log() {} };
  logger.logQuery("SELECT 5");
  assert.deepEqual(printed, ["SELECT 5"]);
  assert.equal(new QueryMetricsLogger(false).printer, null);
});
