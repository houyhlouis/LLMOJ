// Operational gauges are read when the metrics are read. A failing reading makes its gauge unknown (NaN, instead of a
// stale or zero value) and doesn't break the other metrics.
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
const { MetricsService, sharedReading } = require("./metrics.service.ts");

const warnings = [];
Logger.overrideLogger({ log() {}, error() {}, debug() {}, verbose() {}, warn: message => warnings.push(message) });

test("gauges are read when the metrics are read; a failing one is unknown and logged once a minute", async () => {
  const metrics = new MetricsService({ config: {} });
  let value = 3;
  let failing = true;
  metrics.gauge("libreoj_test_jobs", ["state"], async gauge => gauge.set({ state: "queued" }, value));
  metrics.gauge("libreoj_test_lag_seconds", [], async gauge => {
    if (failing) throw new Error("database unavailable");
    gauge.set(7);
  });
  warnings.length = 0;
  let text = await metrics.registry.metrics();
  assert.match(text, /^libreoj_test_jobs\{state="queued"\} 3$/m);
  assert.match(text, /^libreoj_test_lag_seconds NaN$/im);
  value = 4;
  text = await metrics.registry.metrics();
  assert.match(text, /^libreoj_test_jobs\{state="queued"\} 4$/m);
  assert.deepEqual(warnings, ["Failed to read metric libreoj_test_lag_seconds: database unavailable"]);
  failing = false;
  assert.match(await metrics.registry.metrics(), /^libreoj_test_lag_seconds 7$/m);
});

test("a shared reading is read once for all the metrics that use it, and again after a failure", async () => {
  let reads = 0;
  let fail = false;
  const reading = sharedReading(async () => {
    reads++;
    if (fail) throw new Error("no");
    return reads;
  }, 50);
  assert.deepEqual(await Promise.all([reading(), reading(), reading()]), [1, 1, 1]);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(await reading(), 2);
  await new Promise(resolve => setTimeout(resolve, 60));
  fail = true;
  await assert.rejects(reading());
  fail = false;
  assert.equal(await reading(), 4);
});
