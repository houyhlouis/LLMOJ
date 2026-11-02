// Which C and C++ architectures judge clients build, and which ones a judge task needs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText,
    filename
  );
const {
  C_ARCHITECTURES,
  judgeClientArchitectures,
  parseArchitectures,
  taskArchitectures
} = require("./judge-architecture.ts");

const runtime = arch => ({ judgeProgram: "a", sandboxImage: "b", node: "v24", os: "Ubuntu", kernel: "Linux", arch, cpu: "" });

test("judge clients build what they announce; older ones, as on x86-64", () => {
  assert.deepEqual(C_ARCHITECTURES, ["64", "32"]);
  assert.deepEqual(judgeClientArchitectures({ protocolVersion: 5, architectures: ["64"] }), ["64"]);
  assert.deepEqual(judgeClientArchitectures({ protocolVersion: 5, architectures: ["64", "32"] }), ["64", "32"]);
  // Before protocol version 5 judges were installed on x86-64 only; one whose runtime says arm64 builds 64-bit only
  for (const capabilities of [null, { protocolVersion: 2 }, { protocolVersion: 4, runtime: runtime("x64") }])
    assert.deepEqual(judgeClientArchitectures(capabilities), ["64", "32"], JSON.stringify(capabilities));
  assert.deepEqual(judgeClientArchitectures({ protocolVersion: 4, runtime: runtime("arm64") }), ["64"]);
});

test("announced architectures keep only known values, in order", () => {
  assert.deepEqual(parseArchitectures(["32", "x32", "64", 64, "32"]), ["64", "32"]);
  assert.deepEqual(parseArchitectures([]), []);
  for (const invalid of [undefined, null, "64", { 0: "64" }, new Array(17).fill("64")])
    assert.equal(parseArchitectures(invalid), undefined, JSON.stringify(invalid));
});

test("a task needs the architectures of every C and C++ program in it", () => {
  const program = (language, m) => ({ language, code: "", compileAndRunOptions: { compiler: "g++", std: "c++17", O: "2", m } });
  assert.deepEqual(taskArchitectures({ submissionContent: program("cpp", "64") }), []);
  assert.deepEqual(taskArchitectures({ submissionContent: program("cpp", "32") }), ["32"]);
  assert.deepEqual(taskArchitectures({ submissionContent: program("c", "32") }), ["32"]);
  // The checker, interactor or a hack's validator count too
  assert.deepEqual(
    taskArchitectures({
      submissionContent: program("python", "32"),
      judgeInfo: { checker: { type: "custom", interface: "testlib", ...program("cpp", "32"), filename: "checker.cpp" } }
    }),
    ["32"]
  );
  assert.deepEqual(taskArchitectures({ validator: program("cpp", "32"), reference: program("cpp", "64") }), ["32"]);
  assert.deepEqual(taskArchitectures({ testData: [{ name: "1.in" }], judgeInfo: { subtasks: [{ testcases: [] }] } }), []);
  for (const value of [null, undefined, "x", 3, []]) assert.deepEqual(taskArchitectures(value), []);
  // A program nested deeper than any task does isn't looked for
  let deep = { submissionContent: program("cpp", "32") };
  for (let i = 0; i < 20; i++) deep = { inner: deep };
  assert.deepEqual(taskArchitectures(deep), []);
});
