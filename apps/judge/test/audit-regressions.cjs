"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRequire } = require("node:module");
const judgeRequire = createRequire(path.join(__dirname, "../package.json"));
const ts = judgeRequire("typescript");

function load(relative, mocks) {
  const filename = path.join(__dirname, "../src", relative);
  const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    js,
    {
      module,
      exports: module.exports,
      require(name) {
        assert(Object.hasOwn(mocks, name), `Unexpected dependency ${name}`);
        return mocks[name];
      }
    },
    { filename, timeout: 1000 }
  );
  return module.exports;
}
function loadCompiledProgram(remove) {
  const source = fs.readFileSync(path.join(__dirname, "../src/compile.ts"), "utf8");
  const ast = ts.createSourceFile("compile.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    node => ts.isClassDeclaration(node) && node.name?.text === "CompileResultSuccess"
  );
  assert(declaration, "Actual compiled-program reference class must exist");
  const js = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, fsNative: { remove } }, { timeout: 1000 });
  return module.exports.CompileResultSuccess;
}

const omitted = load("omittableString.ts", { fs: {}, "./safeFile": {} });
const checkers = load("checkers/index.ts", { "../omittableString": omitted });
const SandboxStatus = { OK: 1, TimeLimitExceeded: 2, MemoryLimitExceeded: 3, RuntimeError: 4, Cancelled: 5 };
for (const row of [
  ["ok exit zero", 1, "exited", 0, "ok equal\n", 100],
  ["ok contradictory exit", 4, "exited", 77, "ok inconsistent checker exit\n", "error"],
  ["WA exit one", 4, "exited", 1, "wrong answer unequal\n", 0],
  ["PE exit two", 4, "exited", 2, "wrong output format expected integer\n", 0],
  ["points nonzero", 4, "exited", 7, "points 50\n", 50],
  ["partial nonzero", 4, "exited", 116, "partially correct (100)\n", 50],
  ["FAIL exit three", 4, "exited", 3, "FAIL bad data\n", undefined],
  ["ok then abort", 4, "signaled", 6, "ok equal\n", "error"],
  ["ok then timeout", 2, "signaled", 9, "ok equal\n", "error"],
  ["ok then OOM", 3, "signaled", 9, "ok equal\n", "error"],
  ["ok then cancellation", 5, "signaled", 9, "ok equal\n", "error"]
]) {
  test(`custom testlib: ${row[0]}`, async () => {
    const [, status, termination, code, message, expected] = row;
    const checker = load("checkers/custom/testlib.ts", {
      uuid: { v4: () => "stderr" },
      "simple-sandbox": { SandboxStatus },
      "../../utils": { safelyJoinPath: () => ({ inside: "/stderr", outside: "/stderr" }) },
      "../../omittableString": { ...omitted, readFileOmitted: async () => message },
      ".": {},
      "..": checkers
    }).checker;
    const result = await checker.runChecker({}, {}, {}, {}, "", "", async () => ({ status, termination, code }));
    if (expected === "error") assert.equal(typeof result, "string");
    else assert.equal(result.score, expected);
    if (code === 77) assert.match(result, /exited with code 77/);
  });
}

for (const kind of ["traditional", "interaction", "communication"]) {
  for (const failure of [
    "compile rejects",
    "CE",
    "compiled event throws",
    "judge throws",
    "success",
    "contestant dereference throws",
    "both dereferences throw"
  ]) {
    test(`${kind}: releases references after ${failure}`, async () => {
      const releases = { trusted: 0, contestant: 0 },
        programs = [],
        removals = [];
      const ActualCompileResultSuccess = loadCompiledProgram(async directory => removals.push(directory));
      class CompileResultSuccess extends ActualCompileResultSuccess {
        constructor(name) {
          super(name, "", `/compiled-cache/${name}`, 123, "");
          this.name = name;
          this.reference(); // Cache reference.
          this.reference(); // Submission reference returned by compile.
          programs.push(this);
        }
        async dereference() {
          releases[this.name]++;
          await super.dereference();
          if (
            (this.name === "contestant" && failure === "contestant dereference throws") ||
            failure === "both dereferences throw"
          )
            throw new Error("release failure");
        }
      }
      let compileCalls = 0;
      const mocks = {
        fs: { promises: { readFile: async () => "trusted source" } },
        "object-hash": {},
        uuid: {},
        "simple-sandbox": { SandboxStatus },
        "./judgeInfo": {},
        "../interaction/judgeInfo": {},
        "../interaction": {},
        "..": { SubmissionStatus: { CompilationError: "CE" } },
        "../../../compile": {
          CompileResultSuccess,
          compile: async () => {
            if (++compileCalls === 1) return new CompileResultSuccess("trusted");
            if (failure === "compile rejects") throw new Error("compile failure");
            if (failure === "CE") return { success: false, message: "syntax error" };
            return new CompileResultSuccess("contestant");
          }
        },
        "../../../sandbox": {},
        "../../../languages": {},
        "../../../config": {},
        "../../../utils": {},
        "../../../omittableString": omitted,
        "../../../file": { getFile: value => value },
        "../../../error": { ConfigurationError: class extends Error {} },
        "../../../posixUtils": {},
        "../../../checkers": {},
        "../../../checkers/builtin": {},
        "../../../checkers/custom": { validateCustomChecker() {} },
        "../../../fsNative": {},
        "../../../safeFile": {},
        "../common": {
          getExtraSourceFiles: () => ({}),
          runCommonTask: async () => {
            if (failure === "judge throws") throw new Error("judge failure");
          }
        }
      };
      const { runTask } = load(`task/submission/${kind}/index.ts`, mocks);
      const program = { type: "custom", interface: "testlib", filename: "trusted.cpp", language: "cpp" };
      const task = {
        extraInfo: {
          judgeInfo: { checker: program, interactor: program, manager: program },
          testData: { "trusted.cpp": "trusted" },
          submissionContent: { language: "cpp", code: "contestant" }
        },
        events: {
          compiling() {},
          compiled() {
            if (failure === "compiled event throws") throw new Error("event failure");
          },
          finished() {}
        }
      };
      if (
        [
          "compile rejects",
          "compiled event throws",
          "judge throws",
          "contestant dereference throws",
          "both dereferences throw"
        ].includes(failure)
      )
        await assert.rejects(runTask(task));
      else await runTask(task);
      assert.equal(compileCalls, 2);
      assert.equal(releases.trusted, 1);
      assert.equal(releases.contestant, ["compile rejects", "CE"].includes(failure) ? 0 : 1);
      assert.deepEqual(removals, []);
      for (const program of programs) {
        assert.equal(program.referenceCount, 1, "Only the cache reference may remain after task cleanup");
        await ActualCompileResultSuccess.prototype.dereference.call(program); // Cache eviction.
        assert.equal(program.referenceCount, 0);
      }
      assert.deepEqual(
        removals,
        programs.map(program => program.binaryDirectory)
      );
    });
  }
}

for (const outcome of ["success", "initialization fails", "cancelled before contestant starts"]) {
  test(`runtime initialization: ${outcome}`, async () => {
    const starts = [],
      closed = [];
    let cancelled = false;
    const config = {
      sandbox: {
        immutable: true,
        rootfs: "/rootfs",
        user: "nobody",
        environments: { BASE: "trusted" },
        resourceMode: "arbiter"
      },
      cpuAffinity: { compiler: [1], userProgram: [2] }
    };
    class CanceledError extends Error {}
    // The sandbox launcher runs the sandboxes; standard I/O paths are opened by the judge and passed
    const launcher = {
      async startSandbox(request, descriptors) {
        starts.push({ ...request, passed: descriptors });
        return {
          stop() {},
          waitForStop: async () => {
            if (starts.length === 1) {
              if (outcome === "cancelled before contestant starts") cancelled = true;
              return { status: outcome === "initialization fails" ? SandboxStatus.RuntimeError : SandboxStatus.OK };
            }
            return { status: SandboxStatus.OK };
          }
        };
      }
    };
    let opened = 300;
    const { startSandbox } = load("sandbox.ts", {
      fs: { constants: require("node:fs").constants, closeSync: fd => closed.push(fd) },
      path: require("node:path"),
      "simple-sandbox": { SandboxStatus },
      "./launcherClient": { launcher: () => launcher },
      "./safeFile": {
        openBeneathSync: (root, relative) => {
          assert.deepEqual([root, relative], ["/temp", relative === "output" ? "output" : "errors"]);
          return ++opened;
        }
      },
      "./config": config,
      "./utils": { safelyJoinPath: (a, b) => a + "/" + b, merge: (a, b) => Object.assign({}, a, b) },
      "./rpc": {
        ensureNotCanceled() {
          if (cancelled) throw new CanceledError();
        },
        onCancel: () => () => {},
        isCanceled: () => false
      },
      "./error": { CanceledError },
      "./fsNative": { ensureDir: async () => {} }
    });
    const fd = { fd: 123 };
    const runtimeInitialization = {
      executable: "/usr/bin/emacs",
      parameters: ["--quick", "--batch", "--eval", "(kill-emacs 0)"],
      time: 10000,
      memory: 512 * 1048576,
      process: 20
    };
    const args = {
      executable: "/usr/bin/emacs",
      parameters: ["--quick", "--batch", "--script", "/tmp/binary/main.el"],
      runtimeInitialization,
      time: 1000,
      memory: 256 * 1048576,
      process: 20,
      stdin: fd,
      stdout: "/tmp/output",
      stderr: "/tmp/errors",
      preservedFileDescriptors: [fd],
      environments: { UNTRUSTED: "submission" },
      workingDirectory: "/tmp/working",
      tempDirectoryOutside: "/temp",
      extraMounts: [{ mappedPath: { outside: "/submission", inside: "/tmp/binary" }, readOnly: true }],
      cpuAffinity: "UserProgram"
    };
    if (outcome === "success") await (await startSandbox("task", args)).waitForStop();
    else await assert.rejects(startSandbox("task", args));
    assert.equal(starts.length, outcome === "success" ? 2 : 1);
    const initialization = starts[0];
    assert.equal(initialization.stdin, null);
    assert.equal(initialization.stdout, null);
    assert.equal(initialization.stderr, null);
    assert.equal(JSON.stringify(initialization.passed), "[]");
    assert.equal(initialization.mounts.length, 1);
    assert.equal(initialization.mounts[0].inside, "/tmp");
    assert.equal(initialization.workingDirectory, "/tmp");
    assert.equal(initialization.memory, 512 * 1048576);
    assert.equal(initialization.time, 10000);
    // Not the submitted program: the launcher gives it neither the arbiter mode nor the address space limit
    assert.equal(initialization.strategy, "Compiler");
    assert.equal(initialization.environments.includes("UNTRUSTED=submission"), false);
    assert.equal(initialization.environments.includes("BASE=trusted"), true);
    assert.equal(
      JSON.stringify(initialization.parameters),
      JSON.stringify(["/usr/bin/emacs", ...runtimeInitialization.parameters])
    );
    if (outcome === "success") {
      assert.equal(starts[1].stdin, 123);
      // Opened under the /tmp mount's directory, passed, and closed here once the launcher has them
      assert.equal(JSON.stringify([starts[1].stdout, starts[1].stderr]), "[301,302]");
      assert.equal(JSON.stringify(starts[1].passed), "[123,301,302]");
      assert.equal(JSON.stringify(starts[1].descriptors), "[123,301,302]");
      assert.deepEqual(closed, [301, 302]);
      assert.equal(starts[1].time, 1000);
      assert.equal(starts[1].memory, 256 * 1048576);
      assert.equal(starts[1].strategy, "UserProgram");
    } else assert.deepEqual(closed, []);
  });
}

test("actual compiled-program reference reaches zero after caller release and cache eviction", async () => {
  const removals = [];
  const CompileResultSuccess = loadCompiledProgram(async value => removals.push(value));
  const result = new CompileResultSuccess("hash", "", "/compiled-cache", 123, "");
  result.reference(); // Cache owns one reference.
  result.reference(); // Submission caller owns one reference.
  await result.dereference();
  assert.deepEqual(removals, []);
  await result.dereference();
  assert.deepEqual(removals, ["/compiled-cache"]);
});
