const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Module, createRequire } = require("node:module");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { test } = require("node:test");
const ts = require("typescript");
const protocol = require("@libreoj/judge-protocol");

require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText,
    filename
  );

const { testcaseResources } = require("./testcaseResources.ts");
const memory = memoryLimit => ({ memoryLimit });

for (const [name, roles, testcase, subtask, expected] of [
  ["Traditional sample with a built-in checker", { checker: { type: "lines" } }, null, null, [192, 0, 0, 192]],
  [
    "Traditional custom checker inherits the problem limit",
    { checker: { type: "custom" } },
    {},
    memory(80),
    [80, 0, 192, 192]
  ],
  [
    "Traditional explicit checker",
    { checker: { type: "custom", memoryLimit: 384 } },
    memory(64),
    memory(96),
    [64, 0, 384, 384]
  ],
  [
    "Traditional larger contestant",
    { checker: { type: "custom", memoryLimit: 48 } },
    memory(128),
    memory(96),
    [128, 0, 48, 128]
  ],
  ["Interaction sample", { interactor: {} }, null, null, [192, 192, 0, 384]],
  ["Interaction interactor inherits the problem limit", { interactor: {} }, memory(96), memory(80), [96, 192, 0, 288]],
  ["Interaction explicit interactor", { interactor: memory(224) }, {}, memory(96), [96, 224, 0, 320]],
  [
    "Interaction larger checker",
    { interactor: {}, checker: { type: "custom", memoryLimit: 512 } },
    memory(96),
    null,
    [96, 192, 512, 512]
  ],
  ["Communication sample", { manager: {} }, null, null, [192, 192, 0, 384]],
  ["Communication manager inherits the problem limit", { manager: {} }, {}, memory(80), [80, 192, 0, 272]],
  ["Communication explicit manager", { manager: memory(384) }, memory(80), memory(96), [80, 384, 0, 464]],
  [
    "Communication only executes its manager and contestant",
    { manager: {}, checker: { type: "custom", memoryLimit: 512 } },
    memory(96),
    null,
    [96, 192, 0, 288]
  ]
]) {
  test(name, () => {
    const resources = testcaseResources({ memoryLimit: 192, ...roles }, testcase, subtask);
    assert.deepEqual(
      [
        resources.program.memoryLimit,
        resources.interactor?.memoryLimit || 0,
        resources.checkerMemory,
        resources.peakMemory
      ],
      expected
    );
  });
}

test("SubmitAnswer reserves only its checker's sandbox", () => {
  assert.equal(testcaseResources({ checker: { type: "lines" } }).peakMemory, 0);
  assert.equal(testcaseResources({ checker: { type: "custom", memoryLimit: 96 } }).peakMemory, 96);
});

function load(file, dependencies) {
  const filename = require.resolve(file);
  const localRequire = createRequire(filename);
  const loaded = new Module(filename);
  loaded.require = name => (Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name));
  require.extensions[".ts"](loaded, filename);
  return loaded.exports;
}

// Run the Communication handler, both interaction stages and the actual execution queue.
// Hold the first manager in its sandbox so the test can observe which slots and MiB are still free.
function communicationJudge(memoryBudget) {
  const managerGate = Promise.withResolvers();
  const starts = [];
  const config = { maxConcurrentTasks: 2, taskWorkingDirectories: ["/slot-a", "/slot-b"], memoryBudget };
  const native = { ensureDir() {}, emptyDir() {}, copy() {} };
  const utils = load("../../utils.ts", { "./config": config, "./fsNative": native });
  const posix = {
    Disposer: class {
      dispose() {}
    },
    createPipe: () => ({ read: { close() {} }, write: { close() {} } })
  };
  const queue = load("../../taskQueue.ts", { "./config": config, "./utils": utils, "./posixUtils": posix });
  const common = load("./common.ts", { ".": protocol, "../../taskQueue": queue, winston: { verbose() {} } });
  class Compiled {
    binaryDirectory = "/compiled";
    success = true;
    async dereference() {}
  }
  const dependencies = {
    "..": protocol,
    "../common": common,
    "../../../compile": { compile: async () => new Compiled(), CompileResultSuccess: Compiled },
    "../../../utils": utils,
    "../../../file": { getFile: key => key }
  };
  const interaction = load("./interaction/index.ts", {
    ...dependencies,
    "./judgeInfo": {},
    "simple-sandbox": { SandboxStatus: { OK: "OK" } },
    "../../../languages": () => ({ run: () => ({}) }),
    "../../../config": { serverSideConfig: { limit: { dataDisplay: 256, stderrDisplay: 256 } } },
    "../../../fsNative": native,
    "../../../posixUtils": posix,
    "../../../omittableString": { ...require("../../omittableString.ts"), readFileOmitted: async () => "ok" },
    "../../../sandbox": {
      SANDBOX_INSIDE_PATH_BINARY: "/binary",
      SANDBOX_INSIDE_PATH_WORKING: "/working",
      CpuAffinityStrategy: { UserProgram: "contestant", Interactor: "manager" },
      async startSandbox(id, { cpuAffinity, memory, time }) {
        starts.push([id, cpuAffinity, memory / 1048576, time]);
        return {
          stop() {},
          async waitForStop() {
            if (id === "first" && cpuAffinity === "manager") await managerGate.promise;
            return { status: "OK", memory: 0, time: 0 };
          }
        };
      }
    }
  });
  const communication = load("./communication/index.ts", {
    ...dependencies,
    fs: { promises: { readFile: async () => "manager" } },
    "../interaction/judgeInfo": {},
    "../interaction": interaction
  });
  function submit(taskId, managerMemory) {
    return communication.runTask({
      taskId,
      extraInfo: {
        problemType: "Communication",
        judgeInfo: {
          memoryLimit: 192,
          timeLimit: 800,
          manager: {
            interface: "run-twice",
            language: "cpp",
            filename: "manager.cpp",
            memoryLimit: managerMemory,
            timeLimit: 500
          },
          subtasks: [{ memoryLimit: 80, timeLimit: 700, scoringType: "Sum", testcases: [{ inputFile: "case.in" }] }]
        },
        submissionContent: { language: "cpp", code: "contestant" },
        testData: { "manager.cpp": "manager", "case.in": "case" }
      },
      events: {
        compiling() {},
        compiled() {},
        startedRunning() {},
        testcaseWillEnqueue() {},
        testcaseRunning() {},
        testcaseFinished(_subtask, _testcase, result) {
          assert.equal(result.runs.length, 2);
        },
        subtaskScoreUpdated() {},
        finished(status, score) {
          assert.deepEqual([status, score], ["Accepted", 100]);
        }
      }
    });
  }
  return { submit, scheduler: queue.executionScheduler, starts, finishManager: managerGate.resolve };
}

test("two individually fitting Communication tasks wait for each other's contestant and manager", async () => {
  const { submit, scheduler, starts, finishManager } = communicationJudge(700);
  const done = Promise.all([submit("first", 384), submit("second", 384)]);
  try {
    await nextTurn();
    assert.deepEqual(starts, [
      ["first", "contestant", 80, 700],
      ["first", "manager", 384, 700]
    ]);
    assert.equal(scheduler.status.freeSlots, 1);
    assert.equal(scheduler.status.freeMemory, 700 - 464);
    assert.equal(scheduler.status.waiting, 1);
  } finally {
    finishManager();
    await done;
  }
  const stage = id => [
    [id, "contestant", 80, 700],
    [id, "manager", 384, 700]
  ];
  assert.deepEqual(starts, [...stage("first"), ...stage("first"), ...stage("second"), ...stage("second")]);
  assert.equal(scheduler.status.freeMemory, 700);
});

test("a Communication task larger than the whole memory budget waits, then takes the whole budget", async () => {
  const { submit, scheduler, starts, finishManager } = communicationJudge(400);
  const release = await scheduler.acquire({ memory: 32 });
  const done = submit("first", 384);
  try {
    await nextTurn();
    assert.equal(scheduler.status.waiting, 1);
    assert.deepEqual(starts, []);
    release();
    await nextTurn();
    assert.equal(scheduler.status.freeSlots, 1);
    assert.equal(scheduler.status.freeMemory, 0);
    assert.deepEqual(starts, [
      ["first", "contestant", 80, 700],
      ["first", "manager", 384, 700]
    ]);
  } finally {
    release();
    finishManager();
    await done;
  }
  assert.equal(scheduler.status.freeMemory, 400);
});
