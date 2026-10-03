"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRequire } = require("node:module");
const judgeRequire = createRequire(path.join(__dirname, "../package.json"));
const ts = judgeRequire("typescript");

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
}

function loadProgram(remove) {
  const source = fs.readFileSync(path.join(__dirname, "../src/compile.ts"), "utf8");
  const ast = ts.createSourceFile("compile.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    node => ts.isClassDeclaration(node) && node.name?.text === "CompileResultSuccess"
  );
  assert(declaration, "The actual compiled-program reference class must exist");
  const module = { exports: {} };
  vm.runInNewContext(transpile(declaration.getText(ast)), {
    module,
    exports: module.exports,
    fsNative: { remove }
  });
  return module.exports.CompileResultSuccess;
}

function loadTask(mocks) {
  const filename = path.join(__dirname, "../src/task/submission/submit-answer/index.ts");
  const module = { exports: {} };
  vm.runInNewContext(
    transpile(fs.readFileSync(filename, "utf8")),
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
  return module.exports.runTask;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return { promise, resolve };
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const removals = [],
    programs = [];
  const Actual = loadProgram(async directory => {
    removals.push(directory);
    if (options.removeFails) throw new Error("remove failed");
  });
  class Program extends Actual {
    constructor() {
      super("checker-hash", "", `/compiled-cache/checker-${programs.length}`, 123, "");
      this.releases = 0;
      this.reference(); // The cache owns one reference.
      this.reference(); // compile() transfers one reference to the submission.
      programs.push(this);
    }
    async dereference() {
      this.releases++;
      await super.dereference();
      if (options.releaseFails) throw new Error("release failed");
    }
  }
  const calls = { compile: 0, judge: 0, compiling: 0, read: 0, validate: 0, unzip: 0 };
  const logs = [];
  const unzipResult = { status: {} };
  const fail = step => {
    if (options.failure === step || options.fileFailure === step) throw new Error(`${step} failed`);
  };
  const mocks = {
    fs: {
      promises: {
        readFile: async () => {
          calls.read++;
          fail("read");
          return "checker source";
        }
      }
    },
    uuid: {},
    winston: { error: message => logs.push(message) },
    "./judgeInfo": {},
    "..": {},
    "../../../compile": {
      CompileResultSuccess: Program,
      compile: async () => {
        calls.compile++;
        if (options.compileGate) await options.compileGate.promise;
        if (options.compilerThrows) throw new Error("compiler failed");
        if (options.compilerCE) return { message: "syntax error" };
        const program = new Program();
        if (options.evictBeforeCleanup) await Actual.prototype.dereference.call(program);
        return program;
      }
    },
    "../../../sandbox": {},
    "../../../config": {},
    "../../../utils": {},
    "../../../omittableString": { prependOmittableString: (prefix, message) => prefix + message },
    "../../../file": { getFile: value => value },
    "../../../error": { ConfigurationError: class extends Error {} },
    "../../../checkers/builtin": {},
    "../../../checkers/custom": {
      validateCustomChecker: () => {
        calls.validate++;
        fail("validate");
      }
    },
    "../../../fsNative": {},
    "../common": {
      runCommonTask: async ({ extraParameters }) => {
        calls.judge++;
        assert.equal(extraParameters[0], unzipResult);
        assert.equal(extraParameters[1], options.builtin ? undefined : programs[0]);
        if (options.judgeGate) await options.judgeGate.promise;
        fail("judge");
      }
    },
    "../submissionFile": {}
  };
  const runTask = loadTask(mocks);
  const task = {
    extraInfo: {
      judgeInfo: {
        subtasks: [{ testcases: [{ outputFile: "1.out" }, { outputFile: "2.out", userOutputFilename: "custom.out" }] }],
        checker: { type: options.builtin ? "builtin" : "custom", filename: "checker.cpp", interface: "testlib" }
      },
      testData: { "checker.cpp": "checker" }
    },
    file: {
      waitForDownload: async () => {
        if (options.downloadGate) await options.downloadGate.promise;
        else await nextTurn(); // The default checker completes before the file branch.
        fail("download");
      },
      unzip: async wantedFiles => {
        calls.unzip++;
        assert.deepEqual(Array.from(wantedFiles), ["1.out", "custom.out"]);
        fail("unzip");
        return unzipResult;
      }
    },
    events: {
      compiling: () => {
        calls.compiling++;
        fail("compiling event");
      }
    }
  };
  let settled = false;
  const completion = runTask(task).then(
    () => {
      settled = true;
      return null;
    },
    error => {
      settled = true;
      return error;
    }
  );
  return { Actual, programs, removals, calls, logs, completion, isSettled: () => settled };
}

async function assertReleased(f) {
  for (const program of f.programs) {
    assert.equal(program.releases, 1, "The submission must release its reference exactly once");
    assert.equal(program.referenceCount, 1, "Only the cache reference remains");
  }
  assert.deepEqual(f.removals, [], "The cache binary must remain available");
  for (const program of f.programs) {
    await f.Actual.prototype.dereference.call(program); // Actual cache eviction.
    assert.equal(program.referenceCount, 0, "No ownerless reference survives cache eviction");
  }
  assert.deepEqual(
    f.removals,
    f.programs.map(program => program.binaryDirectory)
  );
}

for (const failure of [null, "download", "unzip", "compiling event", "judge"]) {
  test(`submit-answer: checker released after ${failure || "success"}`, async () => {
    const f = fixture({ failure });
    const error = await f.completion;
    if (failure) assert.equal(error.message, `${failure} failed`);
    else assert.equal(error, null);
    assert.equal(f.calls.judge, failure && failure !== "judge" ? 0 : 1);
    assert.equal(f.calls.compile, 1);
    assert.equal(f.programs.length, 1);
    await assertReleased(f);
  });
}

for (const failure of ["download", "unzip", "compiling event"]) {
  for (const outcome of ["success", "reject", "CE"]) {
    test(`submit-answer: ${failure} fails before late checker ${outcome}`, async () => {
      const compileGate = deferred();
      const f = fixture({ failure, compileGate, compilerThrows: outcome === "reject", compilerCE: outcome === "CE" });
      await nextTurn();
      await nextTurn();
      assert.equal(f.isSettled(), false, "Task cleanup must wait for the pending compile consumer");
      assert.equal(f.programs.length, 0);
      compileGate.resolve();
      const error = await f.completion;
      assert.equal(error.message, `${failure} failed`, "Preserve the first preparation failure");
      assert.equal(f.calls.judge, 0);
      assert.equal(f.programs.length, outcome === "success" ? 1 : 0);
      await assertReleased(f);
    });
  }
}

for (const compilerFailure of ["validate", "read", "reject", "CE"]) {
  for (const failure of [null, "unzip"]) {
    test(`submit-answer: checker ${compilerFailure} before late file ${failure || "success"}`, async () => {
      const downloadGate = deferred();
      const f = fixture({
        downloadGate,
        fileFailure: failure,
        failure: ["validate", "read"].includes(compilerFailure) ? compilerFailure : failure,
        compilerThrows: compilerFailure === "reject",
        compilerCE: compilerFailure === "CE"
      });
      await nextTurn();
      assert.equal(f.isSettled(), false, "Task must wait for the other preparation branch");
      downloadGate.resolve();
      const error = await f.completion;
      assert.equal(
        error.message,
        compilerFailure === "CE"
          ? "Failed to compile custom checker:\n\nsyntax error"
          : `${compilerFailure === "reject" ? "compiler" : compilerFailure} failed`
      );
      assert.equal(f.calls.judge, 0);
      assert.equal(f.calls.unzip, 1);
      assert.equal(f.calls.compiling, failure ? 0 : 1);
      assert.equal(f.programs.length, 0);
      await assertReleased(f);
    });
  }
}

for (const failure of [null, "download", "unzip", "compiling event", "judge"]) {
  test(`submit-answer: builtin checker ${failure || "success"}`, async () => {
    const f = fixture({ builtin: true, failure });
    const error = await f.completion;
    assert.equal(error?.message || null, failure ? `${failure} failed` : null);
    assert.equal(f.calls.compile, 0);
    assert.equal(f.calls.read, 0);
    assert.equal(f.calls.validate, 0);
    await assertReleased(f);
  });
}

test("submit-answer: cleanup failure releases exactly once", async () => {
  const f = fixture({ releaseFails: true });
  const error = await f.completion;
  assert.equal(error.message, "release failed");
  await assertReleased(f);
});

test("submit-answer: cache eviction during judging keeps the task reference alive", async () => {
  const judgeGate = deferred();
  const f = fixture({ judgeGate });
  await nextTurn();
  await nextTurn();
  assert.equal(f.calls.judge, 1);
  assert.equal(f.programs.length, 1);
  const program = f.programs[0];
  await f.Actual.prototype.dereference.call(program);
  assert.equal(program.referenceCount, 1);
  assert.deepEqual(f.removals, []);
  judgeGate.resolve();
  assert.equal(await f.completion, null);
  assert.equal(program.releases, 1);
  assert.equal(program.referenceCount, 0);
  assert.deepEqual(f.removals, [program.binaryDirectory]);
});

for (const failure of [null, "download", "unzip", "compiling event", "judge"]) {
  test(`submit-answer: cache eviction and remove failure after ${failure || "success"}`, async () => {
    const f = fixture({ failure, evictBeforeCleanup: true, removeFails: true });
    const error = await f.completion;
    assert.equal(
      error.message,
      failure ? `${failure} failed` : "remove failed",
      "Preserve a primary failure and propagate independent cleanup failures"
    );
    assert.equal(f.programs.length, 1);
    const program = f.programs[0];
    assert.equal(program.releases, 1, "Cleanup must not retry/double release after remove rejects");
    assert.equal(program.referenceCount, 0, "Cache eviction and task cleanup release their own references");
    assert.deepEqual(f.removals, [program.binaryDirectory], "The actual removal path must be attempted once");
    assert.equal(f.logs.length, failure ? 1 : 0);
    if (failure) assert.match(f.logs[0], /remove failed/);
  });
}
