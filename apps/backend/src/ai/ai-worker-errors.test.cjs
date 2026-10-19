/* Failures of the AI job scheduler and internal errors of jobs used to be dropped silently. They're counted and
   logged at most once a minute, by type and code only: a message may quote provider output. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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
const { aiServices, bareAiServices } = require("./ai-test-services.cjs");
const { AiError } = require("./ai.types.ts");

const logged = [];
Logger.overrideLogger({ log() {}, warn() {}, debug() {}, verbose() {}, error: message => logged.push(message) });

function fixture() {
  const service = aiServices({}, {}, {}, {}, {}, {}, {});
  const counted = [];
  service.metricWorkerErrors = { inc: labels => counted.push(labels.stage) };
  return { service, counted };
}

test("scheduler failures are logged by type and code once a minute, and counted", () => {
  logged.length = 0;
  const { service, counted } = fixture();
  const error = Object.assign(new Error("provider said: sk-secret-1234"), { code: "ER_LOCK_WAIT_TIMEOUT" });
  service.workerFailed("worker", error);
  service.workerFailed("worker", new Error("again"));
  assert.deepEqual(counted, ["worker", "worker"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /AI job scheduler failed \(Error ER_LOCK_WAIT_TIMEOUT\)/);
  assert.doesNotMatch(logged.join("\n"), /secret|provider said/);
});

test("a job's internal error is logged with the job's ID; expected AI errors and cancellations aren't", async () => {
  for (const [error, expected, status = "running"] of [
    [new TypeError("Cannot read properties of undefined (reading 'x') from model text"), "job"],
    [new AiError("MODEL_REQUEST_FAILED"), null],
    // A cancelled job's request is aborted
    [Object.assign(new Error("The operation was aborted"), { name: "AbortError" }), null, "cancelled"]
  ]) {
    logged.length = 0;
    const { service, counted } = fixture();
    const job = { id: "job-1", ownerId: 2, status, runToken: "t" };
    service.recordAiAudit = async () => {};
    service.jobs = { findOneBy: async () => job, update: async () => ({ affected: 1 }) };
    service.withRuntime = async () => {
      throw error;
    };
    // eslint-disable-next-line no-await-in-loop
    await service.runJob(job);
    assert.deepEqual(counted, expected ? [expected] : []);
    if (expected) {
      assert.equal(logged.length, 1);
      assert.match(logged[0], /^AI job job-1 failed with an internal error \(TypeError\)/);
      assert.doesNotMatch(logged[0], /model text/);
    } else assert.equal(logged.length, 0);
  }
});
