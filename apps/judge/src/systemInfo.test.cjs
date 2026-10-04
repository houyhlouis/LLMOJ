/* Run with the judge's installed dependencies: node --test apps/judge/src/systemInfo.test.cjs. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true
      }
    }).outputText,
    filename
  );

test("judge system information retains its contract and emits no deprecation warnings", async () => {
  const warnings = [];
  const onWarning = warning => warnings.push(warning);
  process.on("warning", onWarning);
  try {
    const getSystemInfo = require("./systemInfo.ts").default;
    const info = await getSystemInfo();
    assert.equal(typeof info.os, "string");
    assert.equal(typeof info.kernel, "string");
    assert.equal(typeof info.arch, "string");
    assert.equal(typeof info.cpu.model, "string");
    assert.equal(typeof info.cpu.flags, "string");
    assert.equal(typeof info.cpu.cache, "object");
    assert(Number.isFinite(info.memory.size) && info.memory.size > 0);
    assert.equal(typeof info.memory.description, "string");
    assert.deepEqual(info.languages, {});
    assert.equal(info.extraInfo, "");
    assert.equal(await getSystemInfo(), info, "Repeated calls retain the cached system information");
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(
      warnings.filter(warning => warning.name === "DeprecationWarning").map(warning => warning.code),
      []
    );
  } finally {
    process.removeListener("warning", onWarning);
  }
});
