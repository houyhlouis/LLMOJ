const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const crypto = require("node:crypto");
const ts = require("typescript");
const protocol = require("@libreoj/judge-protocol");
class ConfigurationError extends Error {}
class CanceledError extends Error {}
function fixture(root) {
  const calls = [],
    downloads = [],
    compiles = [],
    checkerCalls = [];
  const sources = {};
  const dependencies = {
    winston: { __esModule: true, default: { error: () => {} } },
    "@libreoj/judge-protocol": protocol,
    "simple-sandbox": { SandboxStatus: { OK: "OK", RuntimeError: "RuntimeError" } },
    "../hack": {
      checkedCompile: async content => {
        compiles.push(content);
        return { content, async dereference() {} };
      },
      runProgram: async (_id, content, compiled, input, _time, _memory, _fileIo, parameters) => {
        calls.push({ code: compiled.content.code, input, parameters });
        return {
          status: "OK",
          output: Buffer.from(compiled.content.code === "make" ? "hidden input" : "answer"),
          timeUsed: 1,
          memoryUsed: 2
        };
      }
    },
    "../../file": {
      ensureFiles: async ids => downloads.push(...ids),
      FileContentError: class FileContentError extends Error {},
      getFile: name => sources[name]
    },
    "../../error": { ConfigurationError, CanceledError },
    "../../compile": {},
    "../submission/common": { getExtraSourceFiles: () => ({}) },
    "../../checkers": {
      checkerMemory: info => (info.checker.type === "custom" ? info.checker.memoryLimit || info.memoryLimit : 0)
    },
    "../../taskQueue": { runTaskQueued: async (_reservation, callback) => callback(root) },
    "../../utils": {
      safelyJoinPath: (base, name) =>
        typeof base === "string"
          ? path.join(base, name)
          : { outside: path.join(base.outside, name), inside: path.join(base.inside, name) }
    },
    "../../sandbox": { SANDBOX_INSIDE_PATH_WORKING: "/working" },
    "../../fsNative": { ensureDir: async directory => fsp.mkdir(directory, { recursive: true }) },
    "../../checkers/builtin": {
      runBuiltinChecker: async () => {
        checkerCalls.push("builtin");
        return { score: 100 };
      }
    },
    "../../checkers/custom": {
      validateCustomChecker: () => {},
      runCustomChecker: async (_id, checker, _time, _memory, compiled) => {
        checkerCalls.push({ checker, source: compiled.content.code });
        return { score: 100, message: "secret checker diagnostic" };
      }
    },
    "../../omittableString": { isOmittableString: value => typeof value === "string" }
  };
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "index.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { Buffer, console })(
    name => dependencies[name] || require(name),
    module,
    module.exports
  );
  const recipe = { subtaskIds: [1] };
  for (const [role, content] of [
    ["generator", "make"],
    ["standard", "std"]
  ]) {
    const name = role + ".cpp";
    sources[name] = path.join(root, name);
    fs.writeFileSync(sources[name], content);
    recipe[role + "File"] = name;
    recipe[role + "Sha256"] = crypto.createHash("sha256").update(content).digest("hex");
  }
  function task(extraInfo) {
    const progress = [];
    return { taskId: "prediction", extraInfo, reportProgressRaw: value => progress.push(value), progress };
  }
  return { ...module.exports, calls, downloads, compiles, checkerCalls, sources, recipe, task };
}
test("manual make.cpp/std.cpp can prepare a fixed set without a separate validator", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "llmoj-selfeval-unit-"));
  try {
    const f = fixture(root);
    const extra = {
      scope: "contest:7:problem:1",
      judgeInfo: { timeLimit: 1000, memoryLimit: 128, selfEval: f.recipe },
      testData: { "generator.cpp": "generator.cpp", "standard.cpp": "standard.cpp" }
    };
    const first = f.task(extra);
    await f.onSelfEvalPrepare(first);
    assert.equal(first.progress.at(-1).status, "Ready");
    assert.deepEqual(
      f.calls.map(call => call.code),
      ["make", "std"]
    );
    assert.equal(f.compiles.length, 2);
    assert(f.compiles.every(content => content.compileAndRunOptions.std === "c++17"));
    assert.equal(f.calls[0].input, f.calls[0].parameters.join(" ") + "\n");
    const second = f.task(extra);
    await f.onSelfEvalPrepare(second);
    assert.deepEqual(first.progress.at(-1).cases, second.progress.at(-1).cases);
    assert.equal(f.downloads.includes(undefined), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
test("the official SPJ file and metadata are reused and checker diagnostics stay hidden", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "llmoj-selfeval-spj-unit-"));
  try {
    const f = fixture(root);
    f.sources["official-spj"] = path.join(root, "checker.cpp");
    await fsp.writeFile(f.sources["official-spj"], "official spj source");
    const checker = {
      type: "custom",
      filename: "checker.cpp",
      interface: "testlib",
      language: "cpp",
      compileAndRunOptions: { std: "c++17" }
    };
    const job = f.task({
      judgeInfo: { checker, timeLimit: 1000, memoryLimit: 128, subtasks: [{ scoringType: "Sum", points: 100 }] },
      testData: { "checker.cpp": "official-spj", "formal.in": "do-not-download" },
      content: { language: "cpp", code: "participant", compileAndRunOptions: {} },
      cases: [
        {
          subtask: 1,
          input: Buffer.from("hidden input").toString("base64"),
          output: Buffer.from("answer").toString("base64")
        }
      ]
    });
    await f.onSelfEval(job);
    assert.equal(job.progress.at(-1).status, "Accepted");
    assert.equal(job.progress.at(-1).score, 100);
    assert.deepEqual(f.checkerCalls, [{ checker, source: "official spj source" }]);
    assert.deepEqual(f.downloads, ["official-spj"]);
    assert.doesNotMatch(JSON.stringify(job.progress), /hidden input|checker diagnostic|input|output|source/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
test("source hash drift refuses preparation before any generator can run", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "llmoj-selfeval-hash-unit-"));
  try {
    const f = fixture(root);
    f.recipe.generatorSha256 = "0".repeat(64);
    const job = f.task({
      scope: "contest:7:problem:1",
      judgeInfo: { timeLimit: 1000, memoryLimit: 128, selfEval: f.recipe },
      testData: { "generator.cpp": "generator.cpp", "standard.cpp": "standard.cpp" }
    });
    await f.onSelfEvalPrepare(job);
    assert.equal(job.progress.at(-1).status, "ConfigurationError");
    assert.equal(f.calls.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
