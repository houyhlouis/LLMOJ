const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
    }).outputText,
    filename
  );
const { protocolDiagnostics } = require("./aiProtocolDiagnostics.ts");
test("protocol failures keep named bounded stderr and both sequential phases without private stream bytes", () => {
  const transitions = [
    { stage: 1, event: "started" },
    { stage: 1, event: "finished", status: "Accepted" },
    { stage: 2, event: "started" },
    { stage: 2, event: "finished", status: "RuntimeError" }
  ];
  const buffer = protocolDiagnostics(
    2,
    "manager",
    {
      status: "RuntimeError",
      roleDiagnostics: { contestant: "x".repeat(10000), helper: "frame length mismatch" },
      systemMessage: "Exit code: 1"
    },
    transitions
  );
  const details = JSON.parse(buffer);
  assert.equal(details.roles.std.truncated, true);
  assert.equal(details.roles.std.text.length, 4096);
  assert.equal(details.roles.manager.text, "frame length mismatch");
  assert.deepEqual(details.transitions, transitions);
  assert.equal(details.transcript.status, "unexported");
  assert(buffer.length < 14000);
});
