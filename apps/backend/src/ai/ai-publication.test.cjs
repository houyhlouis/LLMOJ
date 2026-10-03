/* Credential-free publication failure/retry tests. No database, provider or sandbox connection is used. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
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
const { AiService } = require("./ai.service.ts");
const { AiError } = require("./ai.types.ts");
const { autoMatchInputToOutput, autoMatchOutputToInput } = require("../problem-type/common/auto-match-input-output.ts");
const { ProblemTypeTraditionalService } = require("../problem-type/types/traditional/problem-type.service.ts");

const originalJudgeInfo = () => ({
  timeLimit: 1000,
  memoryLimit: 128,
  fileIo: null,
  extraSourceFiles: {},
  checker: { type: "custom", filename: "old-checker.cpp" },
  subtasks: [{ points: 100, scoringType: "GroupMin", testcases: [{ inputFile: "old.in", outputFile: "old.out" }] }]
});

async function fixture(work, initial = originalJudgeInfo()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hyhoj-ai-publication-"));
  const oldDirectory = process.env.HYHOJ_AI_GENERATED_DIR;
  process.env.HYHOJ_AI_GENERATED_DIR = root;
  const id = crypto.randomUUID(),
    directory = path.join(root, id),
    user = { id: 1 };
  const state = {
    active: structuredClone(initial),
    files: new Map(),
    events: [],
    writes: [],
    attempts: 0,
    activations: 0,
    cancelled: false,
    beforeWrite: async () => {},
    afterWrite: async () => {},
    beforeActivate: async () => null,
    afterActivate: async () => {}
  };
  const initialSubtasks = state.active.subtasks || originalJudgeInfo().subtasks;
  for (const group of initialSubtasks)
    for (const pair of group.testcases || []) {
      state.files.set(pair.inputFile, "0\n");
      state.files.set(pair.outputFile, "0\n");
    }
  if (state.active.checker?.type === "custom") state.files.set(state.active.checker.filename, "original checker");
  function activePairs() {
    const subtasks =
      state.active.subtasks || autoMatchInputToOutput([...state.files.keys()].map(filename => ({ filename })));
    return subtasks
      .flatMap(group => group.testcases)
      .map(pair => ({
        ...pair,
        input: state.files.get(pair.inputFile),
        output: state.files.get(pair.outputFile)
      }));
  }
  function assertActiveConsistent() {
    for (const pair of activePairs()) {
      assert.notEqual(pair.input, undefined, "an active input cannot disappear");
      assert.equal(pair.input, pair.output, "identity-task active input and answer must stay matched");
    }
    if (state.active.checker?.type === "custom")
      assert(state.files.has(state.active.checker.filename), "an active checker must already exist");
  }
  const service = new AiService(
    {},
    {},
    {},
    {
      userHasPrivilege: async () => true,
      permissionDecision: async () => true
    },
    {
      updateProblemJudgeInfo: async (_problem, info) => {
        const errors = await state.beforeActivate(info);
        if (errors) return errors;
        state.active = structuredClone(info);
        state.activations++;
        state.events.push("activate");
        assertActiveConsistent();
        await state.afterActivate(info);
        return null;
      }
    },
    {},
    {}
  );
  service.assertJob = async () => {
    if (state.cancelled) throw new AiError("JOB_CANCELLED");
    return user;
  };
  service.assertSnapshot = async (_job, snapshot) => {
    await service.assertJob();
    assert.deepEqual(snapshot.judgeInfo, state.active, "fixture has no concurrent problem edits");
    return user;
  };
  service.checkpoint = async () => {};
  service.runSandbox = async () => {
    state.attempts++;
    fs.mkdirSync(directory, { recursive: true });
    const files = [];
    // Every run independently generates a different, valid identity-task dataset.
    for (let i = 1; i <= 5; i++)
      for (const extension of ["in", "out"]) {
        const name = `${i}.${extension}`;
        fs.writeFileSync(path.join(directory, name), `${state.attempts}\n`);
        files.push(name);
      }
    return { directory, files, validation: { samplesPassed: 0, inputsPassed: 5, sampleInputsPassed: 0 } };
  };
  service.cleanupSandbox = async () => {
    state.events.push("cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  };
  service.putFile = async (_problem, name, data) => {
    assertActiveConsistent();
    await state.beforeWrite(name);
    state.files.set(name, Buffer.isBuffer(data) ? data.toString() : fs.readFileSync(data, "utf8"));
    state.events.push(name);
    state.writes.push({ attempt: state.attempts, name });
    assertActiveConsistent();
    await state.afterWrite(name);
  };
  const code = "int main(){return 0;}";
  const job = {
    id,
    input: { count: 5 },
    progress: 0,
    state: {
      completed: [],
      plan: {
        subtasks: [{ id: 1, points: 100 }],
        needsSpj: true,
        timeLimitMs: 1000,
        memoryLimitMiB: 128,
        fileIo: null
      },
      makeCode: code,
      stdCode: code,
      checkerCode: code,
      validatorCode: code
    }
  };
  job.state.testdataSnapshotHash = service.testdataFingerprint({
    samples: [],
    submittable: true,
    judgeInfo: structuredClone(state.active)
  });
  const run = () =>
    service.testdata(
      job,
      user,
      { id: 1, type: "Traditional" },
      {},
      {
        samples: [],
        submittable: true,
        judgeInfo: structuredClone(state.active)
      },
      0,
      100
    );
  const retry = error => {
    job.error = error;
    job.state = service.retryState(job);
    return run();
  };
  try {
    await work({ state, job, run, retry, activePairs, assertActiveConsistent });
  } finally {
    if (oldDirectory === undefined) delete process.env.HYHOJ_AI_GENERATED_DIR;
    else process.env.HYHOJ_AI_GENERATED_DIR = oldDirectory;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const uploadFailure = () => new AiError("UPLOAD_GENERATED_FILE_FAILED", "synthetic interrupted upload");

test("a fixed-artifact upload failure and an interrupted retry leave the old active data untouched", async () => {
  await fixture(async ({ state, run, retry, activePairs }) => {
    const original = structuredClone(state.active);
    state.beforeWrite = async name => {
      if (state.attempts === 1 && name === "validator.cpp") throw uploadFailure();
      if (state.attempts === 2 && name.endsWith("-1.out")) throw uploadFailure();
    };
    await assert.rejects(run(), /UPLOAD_GENERATED_FILE_FAILED/);
    assert.equal(state.activations, 0);
    await assert.rejects(retry("UPLOAD_GENERATED_FILE_FAILED"), /UPLOAD_GENERATED_FILE_FAILED/);
    assert.equal(state.activations, 0);
    assert.deepEqual(state.active, original);
    assert.deepEqual(
      activePairs().map(pair => [pair.input, pair.output]),
      [["0\n", "0\n"]]
    );
    const first = state.writes.find(entry => entry.attempt === 1 && entry.name.endsWith("-1.in")).name;
    const second = state.writes.find(entry => entry.attempt === 2 && entry.name.endsWith("-1.in")).name;
    assert.notEqual(first, second, "one job's retry must use a new generation namespace");
    assert.equal(state.files.get("old-checker.cpp"), "original checker");
  });
});

test("recovery after an activation with a missing job checkpoint never overwrites the committed generation", async () => {
  await fixture(async ({ state, run, retry, activePairs }) => {
    state.afterActivate = async () => {
      throw new Error("synthetic disconnect after commit");
    };
    await assert.rejects(run(), /disconnect after commit/);
    assert.equal(state.activations, 1);
    const committed = structuredClone(state.active);
    assert(activePairs().every(pair => pair.input === "1\n" && pair.output === "1\n"));
    state.afterActivate = async () => {};
    state.beforeWrite = async name => {
      if (name.endsWith("-1.out")) throw uploadFailure();
    };
    await assert.rejects(retry("INTERNAL_ERROR"), /UPLOAD_GENERATED_FILE_FAILED/);
    assert.equal(state.activations, 1);
    assert.deepEqual(state.active, committed);
    assert(activePairs().every(pair => pair.input === "1\n" && pair.output === "1\n"));
  });
});

for (const cancelAfter of ["-1.in", "data.yaml"]) {
  test(`cancellation after ${cancelAfter} preserves every active input, answer and checker`, async () => {
    await fixture(async ({ state, run }) => {
      const original = structuredClone(state.active);
      state.afterWrite = async name => {
        if (name.endsWith(cancelAfter)) state.cancelled = true;
      };
      await assert.rejects(run(), /JOB_CANCELLED/);
      assert.equal(state.activations, 0);
      assert.deepEqual(state.active, original);
      assert.equal(state.files.get("old-checker.cpp"), "original checker");
    });
  });
}

test("all case, checker, source and YAML uploads precede the single activation", async () => {
  await fixture(async ({ state, run, job, activePairs }) => {
    await run();
    assert.equal(state.activations, 1);
    const activation = state.events.indexOf("activate");
    assert(activation > 0);
    for (const { name } of state.writes) assert(state.events.indexOf(name) < activation);
    assert.deepEqual(state.events.slice(activation + 1), ["cleanup"]);
    assert.equal(job.state.generated.count, 5);
    assert(activePairs().every(pair => pair.input === "1\n" && pair.output === "1\n"));
    assert.equal(state.files.get("old-checker.cpp"), "original checker");
  });
});

test("judge configuration rejection keeps the original selected generation", async () => {
  await fixture(async ({ state, run }) => {
    const original = structuredClone(state.active);
    state.beforeActivate = async () => ["SYNTHETIC_CONFIGURATION_REJECTION"];
    await assert.rejects(run(), /INVALID_GENERATED_JUDGE_INFO/);
    assert.equal(state.activations, 0);
    assert.deepEqual(state.active, original);
  });
});

for (const dependency of ["checker", "input", "output", "extra-source"]) {
  test(`reserved artifact names cannot overwrite a currently selected ${dependency}`, async () => {
    const original = originalJudgeInfo();
    if (dependency === "checker") original.checker.filename = "validator.cpp";
    if (dependency === "input") original.subtasks[0].testcases[0].inputFile = "std.cpp";
    if (dependency === "output") original.subtasks[0].testcases[0].outputFile = "data.yaml";
    if (dependency === "extra-source") original.extraSourceFiles = { cpp: { "helper.h": "make.cpp" } };
    await fixture(async ({ state, run }) => {
      await assert.rejects(run(), /GENERATOR_FILENAME_CONFLICT/);
      assert.equal(state.attempts, 0);
      assert.equal(state.writes.length, 0);
    }, original);
  });
}

for (const interrupt of ["upload", "cancel"]) {
  test(`automatic old testcase discovery ignores a ${interrupt}-interrupted new generation`, async () => {
    const initial = { ...originalJudgeInfo(), subtasks: null };
    await fixture(async ({ state, run, activePairs }) => {
      const oldPairs = activePairs();
      state.afterWrite = async name => {
        assert.deepEqual(
          activePairs(),
          oldPairs,
          "staged files must not join the old automatically discovered dataset"
        );
        if (name === "validator.cpp") {
          if (interrupt === "cancel") state.cancelled = true;
          else throw uploadFailure();
        }
      };
      await assert.rejects(run(), interrupt === "cancel" ? /JOB_CANCELLED/ : /UPLOAD_GENERATED_FILE_FAILED/);
      assert.equal(state.activations, 0);
      assert.equal(state.active.subtasks, null);
      assert.deepEqual(activePairs(), oldPairs);
    }, initial);
  });
}

test("only exact reserved UUID testcase names are omitted by both automatic matchers", () => {
  const uuid = "7426ba21-95a0-4432-94a1-3e26849fced2";
  const normal = ["normal", "ai-custom", `ai-${uuid}-1`, "ai-managed-not-a-uuid-1", `ai-managed-${uuid}-0`];
  const filenames = [...normal, `ai-managed-${uuid}-1`].flatMap(name => [`${name}.in`, `${name}.out`]);
  const files = filenames.map(filename => ({ filename }));
  const expected = normal.map(name => `${name}.in`).sort();
  for (const match of [autoMatchInputToOutput, autoMatchOutputToInput])
    assert.deepEqual(
      match(files)
        .flatMap(group => group.testcases.map(pair => pair.inputFile))
        .sort(),
      expected
    );
});

test("the explicit published configuration validates and selects managed .in/.out files", async () => {
  await fixture(
    async ({ state, run, activePairs }) => {
      await run();
      const problemType = new ProblemTypeTraditionalService(
        { config: { resourceLimit: {} } },
        {
          validateCompileAndRunOptions: () => []
        }
      );
      const files = [...state.files.keys()].map(filename => ({ filename }));
      const info = structuredClone(state.active);
      assert.doesNotThrow(() => problemType.validateAndFilterJudgeInfo(info, files, true));
      const selected = problemType.preprocessJudgeInfo(info, files).subtasks.flatMap(group => group.testcases);
      assert.equal(selected.length, 5);
      assert(selected.every(pair => /^ai-managed-[0-9a-f-]{36}-[1-9]\d*\.in$/.test(pair.inputFile)));
      assert(selected.every(pair => pair.outputFile === pair.inputFile.replace(/\.in$/, ".out")));
      assert(activePairs().every(pair => pair.input === "1\n" && pair.output === "1\n"));
    },
    { ...originalJudgeInfo(), subtasks: null }
  );
});
