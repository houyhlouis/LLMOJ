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
const { aiServices, bareAiServices } = require("./ai-test-services.cjs");
const { qualityState, qualityReceipt } = require("./ai-quality.fixture.cjs");
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
    if (state.active.selfEval) {
      const recipe = state.active.selfEval;
      for (const role of ["generator", "standard", "validator"]) {
        const source = state.files.get(recipe[role + "File"]);
        assert.notEqual(
          source,
          undefined,
          "a committed self-evaluation recipe must reference an existing immutable program"
        );
        assert.equal(crypto.createHash("sha256").update(source).digest("hex"), recipe[role + "Sha256"]);
      }
    }
  }
  const service = aiServices(
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
  service.runSandbox = async (_job, request) => {
    state.attempts++;
    fs.mkdirSync(directory, { recursive: true });
    const files = [];
    // Every run independently generates a different, valid identity-task dataset.
    for (let i = 1; i <= request.cases.length; i++)
      for (const extension of ["in", "out"]) {
        const name = `${i}.${extension}`;
        fs.writeFileSync(path.join(directory, name), `${state.attempts}\n`);
        files.push(name);
      }
    return {
      directory,
      files,
      validation: {
        samplesPassed: 0,
        inputsPassed: request.cases.length,
        sampleInputsPassed: 0,
        quality: qualityReceipt(request)
      }
    };
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
      ...qualityState(),
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
    await work({ state, job, service, run, retry, activePairs, assertActiveConsistent });
  } finally {
    if (oldDirectory === undefined) delete process.env.HYHOJ_AI_GENERATED_DIR;
    else process.env.HYHOJ_AI_GENERATED_DIR = oldDirectory;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const uploadFailure = () => new AiError("UPLOAD_GENERATED_FILE_FAILED", "synthetic interrupted upload");

test("formal generation freezes all three exact programs before activating the self-evaluation recipe", async () => {
  await fixture(async ({ state, job, run, assertActiveConsistent }) => {
    await run();
    const recipe = state.active.selfEval;
    assert(recipe);
    const activation = state.events.indexOf("activate");
    for (const [role, sourceKey, artifact] of [
      ["generator", "makeCode", "make.cpp"],
      ["standard", "stdCode", "std.cpp"],
      ["validator", "validatorCode", "validator.cpp"]
    ]) {
      assert.match(
        recipe[role + "File"],
        new RegExp("^ai-managed-[0-9a-f-]{36}-" + artifact.replace(".", "\\.") + "$")
      );
      assert.equal(state.files.get(recipe[role + "File"]), job.state[sourceKey]);
      assert.equal(recipe[role + "Sha256"], crypto.createHash("sha256").update(job.state[sourceKey]).digest("hex"));
      assert(state.events.indexOf(recipe[role + "File"]) < activation);
      state.files.set(artifact, "changed mutable download artifact");
    }
    assertActiveConsistent();
    assert.deepEqual(
      recipe.subtaskIds,
      job.state.plan.subtasks.map(subtask => subtask.id)
    );
  });
});

test("an immutable recipe source upload failure or cancellation never activates partial formal data", async () => {
  for (const scenario of ["failure", "cancel"])
    await fixture(async ({ state, run }) => {
      const original = structuredClone(state.active);
      if (scenario === "failure")
        state.beforeWrite = async name => {
          if (/^ai-managed-.*-validator\.cpp$/.test(name)) throw uploadFailure();
        };
      else
        state.afterWrite = async name => {
          if (/^ai-managed-.*-make\.cpp$/.test(name)) state.cancelled = true;
        };
      await assert.rejects(run(), scenario === "failure" ? /UPLOAD_GENERATED_FILE_FAILED/ : /JOB_CANCELLED/);
      assert.equal(state.activations, 0);
      assert.deepEqual(state.active, original);
    });
});

test("formal self-evaluation recipes reject missing sources, malformed hashes and unsafe standard filenames", async () => {
  await fixture(async ({ state, run }) => {
    await run();
    const problemType = new ProblemTypeTraditionalService(
      { config: { resourceLimit: {} } },
      { validateCompileAndRunOptions: () => [] }
    );
    const files = [...state.files.keys()].map(filename => ({ filename }));
    for (const mutation of [
      recipe => {
        recipe.generatorFile = "missing.cpp";
      },
      recipe => {
        recipe.standardSha256 = "bad";
      },
      recipe => {
        recipe.subtaskIds = [1, 1];
      },
      recipe => {
        recipe.standardFileIo = { inputFilename: "../secret", outputFilename: "out" };
      },
      recipe => {
        recipe.standardFileIo = { inputFilename: "same", outputFilename: "same" };
      },
      recipe => {
        delete recipe.validatorFile;
      },
      recipe => {
        recipe.validatorSha256 = "bad";
      },
      recipe => {
        recipe.subtaskIds = [99];
      },
      recipe => {
        recipe.limits = { generator: { timeLimit: 0, memoryLimit: 512 } };
      },
      recipe => {
        recipe.limits = { generator: { timeLimit: 5000 } };
      },
      recipe => {
        recipe.limits = { checker: { timeLimit: 1, memoryLimit: 1 } };
      },
      recipe => {
        recipe.limits = { validator: { timeLimit: 60001, memoryLimit: 512 } };
      },
      recipe => {
        recipe.limits = [];
      }
    ]) {
      const info = structuredClone(state.active);
      mutation(info.selfEval);
      assert.throws(
        () => problemType.validateAndFilterJudgeInfo(info, files, true),
        error => Array.isArray(error) && error.includes("INVALID_SELF_EVAL_RECIPE")
      );
    }
    const manual = structuredClone(state.active);
    delete manual.selfEval.validatorFile;
    delete manual.selfEval.validatorSha256;
    assert.doesNotThrow(() => problemType.validateAndFilterJudgeInfo(manual, files, true));
    // Without its validator, a recipe keeps no limits for it
    assert.deepEqual(manual.selfEval.limits, { generator: { timeLimit: 5000, memoryLimit: 512 } });
    const extra = structuredClone(state.active);
    extra.selfEval.limits.generator.note = "dropped";
    problemType.validateAndFilterJudgeInfo(extra, files, true);
    assert.deepEqual(extra.selfEval.limits.generator, { timeLimit: 5000, memoryLimit: 512 });
  });
});

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
    // The run's result stays until the job's checkpoint acknowledges it (review Part III, W03)
    assert.deepEqual(state.events.slice(activation + 1), []);
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

function addQualityTarget(job, id, kind) {
  const base = job.state.qualityPlan.targets[0];
  const target = {
    ...base,
    id,
    kind,
    algorithm:
      kind === "slow" ? "Naturally quadratic fixture algorithm" : "Second boundary-assumption fixture algorithm"
  };
  job.state.qualityPlan.targets.push(target);
  job.state.qualityArtifacts.challenges.push({
    id,
    kind,
    code: "int main(){return 0;}",
    subtasks: [...target.subtasks],
    reason: target.reason
  });
}

for (const scenario of [
  {
    name: "missing quality receipt",
    mutate: result => {
      delete result.validation.quality;
    }
  },
  {
    name: "unsupported quality receipt version",
    mutate: result => {
      result.validation.quality.version = 2;
    }
  },
  {
    name: "a surviving candidate after another candidate is killed",
    prepare: job => addQualityTarget(job, "second_boundary", "wrong"),
    mutate: result => {
      result.validation.quality.challengesKilled = 1;
      result.validation.quality.challengeResults[1].verdict = "AC";
    }
  },
  {
    name: "a slow candidate rejected only for a wrong answer",
    prepare: job => addQualityTarget(job, "quadratic", "slow"),
    mutate: result => {
      result.validation.quality.challengeResults.find(item => item.kind === "slow").verdict = "WA";
    }
  }
]) {
  test(`valid generated files cannot publish with ${scenario.name}`, async () => {
    await fixture(async ({ state, job, service, run }) => {
      const original = structuredClone(state.active);
      scenario.prepare?.(job);
      const sandbox = service.runSandbox;
      let generatedDirectory;
      service.runSandbox = async (...args) => {
        const result = await sandbox(...args);
        generatedDirectory = result.directory;
        assert.equal(result.files.length, 10, "the quality gate must reject otherwise valid generated files");
        scenario.mutate(result);
        return result;
      };
      await assert.rejects(run(), /TESTDATA_QUALITY_GATE_FAILED/);
      assert.equal(state.attempts, 1);
      assert.equal(state.writes.length, 0, "failed quality proof must prevent every putFile call");
      assert.equal(state.activations, 0);
      assert.deepEqual(state.active, original);
      // The step cleans nothing up itself: the job releases its runs (see ai-execution.service.ts)
      assert.deepEqual(state.events, []);
      assert.equal(fs.existsSync(generatedDirectory), true);
      assert.equal(job.state.generated, undefined);
      assert.equal(job.state.qualityValidation, undefined);
    });
  });
}

test("successful publication stores the quality receipt and YAML verification sources with final searched case indices", async () => {
  await fixture(async ({ state, job, service, run }) => {
    const sandbox = service.runSandbox;
    let request, receipt, finalCases;
    service.runSandbox = async (currentJob, currentRequest) => {
      request = currentRequest;
      const result = await sandbox(currentJob, currentRequest);
      receipt = result.validation.quality;
      receipt.extraAttemptsUsed = 1;
      finalCases = request.cases.map((item, index) => ({ ...item, seed: index === 4 ? item.seed + 16 : item.seed }));
      result.finalCases = finalCases;
      return result;
    };
    await run();
    assert.equal(state.activations, 1);
    assert.deepEqual(job.state.qualityValidation, receipt);
    assert.deepEqual(job.state.generated.qualityValidation, receipt);
    const generation = require("js-yaml").load(state.files.get("data.yaml")).generation;
    assert.deepEqual(generation.qualityValidation, receipt);
    assert.deepEqual(generation.qualityPlan, job.state.qualityPlan);
    assert.deepEqual(
      generation.finalCaseIndices,
      finalCases,
      "record search replacements rather than original indices"
    );
    const digest = source => crypto.createHash("sha256").update(source).digest("hex");
    assert.deepEqual(generation.verificationSources, {
      standard: digest(job.state.stdCode),
      oracle: digest(request.quality.oracleCode),
      smallGenerator: digest(request.quality.smallMakeCode),
      alternatives: request.quality.alternatives.map(item => ({ id: item.id, sha256: digest(item.code) })),
      challenges: request.quality.challenges.map(item => ({ id: item.id, sha256: digest(item.code) }))
    });
    assert.equal(state.events.at(-1), "activate", "nothing cleaned up before the job's checkpoint");
  });
});

// Review Part III, W02: the judging contract a regeneration works within
const { existingScoring } = require("./ai-judging-contract.ts");
const { aiContractDigest, AI_EXECUTION_PROTOCOL_VERSION } = require("@libreoj/judge-protocol");

// A run's requests, as the runner gets them
function recordRequests(service) {
  const sandbox = service.runSandbox;
  const requests = [];
  service.runSandbox = async (job, request) => {
    requests.push(request);
    return await sandbox(job, request);
  };
  return requests;
}

const establishedJudgeInfo = () => ({
  timeLimit: 1000,
  memoryLimit: 128,
  fileIo: null,
  extraSourceFiles: {},
  runSamples: false,
  // The problem's own checker, with options and limits of its own
  checker: {
    type: "custom",
    interface: "testlib",
    language: "cpp",
    compileAndRunOptions: { compiler: "clang++", std: "c++20", O: "3", m: "64" },
    filename: "old-checker.cpp",
    timeLimit: 2000,
    memoryLimit: 300
  },
  subtasks: [
    { points: 20, scoringType: "GroupMin", testcases: [{ inputFile: "old-1.in", outputFile: "old-1.out" }] },
    { scoringType: "Sum", dependencies: [0], testcases: [{ inputFile: "old-2.in", outputFile: "old-2.out" }] },
    { scoringType: "GroupMul", dependencies: [0, 1], testcases: [{ inputFile: "old-3.in", outputFile: "old-3.out" }] }
  ]
});

test("regenerated data keeps the problem's scoring and its own checker's settings, and is checked with them", async () => {
  const initial = establishedJudgeInfo();
  await fixture(async ({ state, job, service, run }) => {
    job.state.plan.subtasks = [
      { id: 1, points: 20 },
      { id: 2, points: 40 },
      { id: 3, points: 40 }
    ];
    const requests = recordRequests(service);
    await run();
    assert.equal(state.activations, 1);
    // The same types, dependencies and points as before (automatic ones stay automatic), and only new cases
    assert.deepEqual(
      state.active.subtasks.map(({ testcases, ...settings }) => settings),
      initial.subtasks.map(({ testcases, ...settings }) => settings)
    );
    // The fixture's one target is of the first subtask: it gets cases built for it (review Part III, W05)
    assert.deepEqual(
      state.active.subtasks.map(subtask => subtask.testcases.length),
      [3, 2, 2]
    );
    assert.equal(state.active.runSamples, false);
    assert.equal(existingScoring(state.active).digest, existingScoring(initial).digest);
    assert.deepEqual(job.state.generated.scoring, {
      status: "kept",
      subtasks: 3,
      digest: existingScoring(initial).digest
    });
    // The checker is judged with the settings it was checked with: its own
    const [request] = requests;
    assert.deepEqual({ ...state.active.checker, filename: "old-checker.cpp" }, initial.checker);
    assert.match(state.active.checker.filename, /^ai-managed-.*-checker\.cpp$/);
    assert.deepEqual(request.profiles.roles.checker, {
      language: "cpp",
      compileAndRunOptions: { compiler: "clang++", std: "c++20", O: "3", m: "64" },
      timeLimitMs: 2000,
      memoryLimitMiB: 300,
      cpu: "Checker",
      testlib: true,
      extraSources: false,
      origin: "problem"
    });
    assert.deepEqual(state.active.selfEval.limits, {
      generator: { timeLimit: 5000, memoryLimit: 512 },
      validator: { timeLimit: 5000, memoryLimit: 512 }
    });
    const generation = require("js-yaml").load(state.files.get("data.yaml")).generation;
    assert.deepEqual(generation.scoring, { status: "kept", digest: existingScoring(initial).digest });
    assert.equal(generation.executionProfiles.digest, aiContractDigest(request.profiles));
    assert.deepEqual(job.state.generated.helpers, [
      { role: "checker", origin: "problem", options: "clang++ -std=c++20 -O3", timeLimitMs: 2000, memoryLimitMiB: 300 }
    ]);
  }, initial);
});

test("subtasks that differ from the problem's stop for review before any program runs; only the approved change goes on", async () => {
  await fixture(async ({ state, job, service, run }) => {
    const before = existingScoring(state.active);
    job.state.plan.subtasks = [
      { id: 1, points: 40 },
      { id: 2, points: 60 }
    ];
    const requests = recordRequests(service);
    await assert.rejects(run(), /AI_SCORING_REVIEW_REQUIRED/);
    assert.equal(requests.length, 0, "nothing ran");
    assert.equal(state.activations, 0);
    const review = job.state.scoringReview;
    assert.deepEqual(review.reasons, [{ code: "SUBTASK_COUNT", current: 1, proposed: 2 }]);
    assert.equal(review.currentDigest, before.digest);
    Object.assign(job, { status: "failed", error: "AI_SCORING_REVIEW_REQUIRED" });
    assert.deepEqual(service.retryOptions(job), ["replace-scoring"]);
    // Retried as it is (after the owner changed the subtasks), it's planned again
    const plain = service.retryState(job);
    assert.equal(plain.plan, undefined);
    assert.equal(plain.scoringReview, undefined);
    assert.equal(plain.testdataSnapshotHash, undefined);
    // Approved: the job goes on with exactly the reviewed change
    job.state = service.retryState(job, "replace-scoring");
    assert.deepEqual(job.state.scoringApproval, {
      currentDigest: review.currentDigest,
      proposedDigest: review.proposedDigest
    });
    await run();
    assert.equal(state.activations, 1);
    assert.deepEqual(
      state.active.subtasks.map(subtask => [subtask.points, subtask.scoringType, subtask.testcases.length]),
      // The fixture's one target is of the first subtask: it gets a case built for it (review Part III, W05)
      [
        [40, "Sum", 3],
        [60, "Sum", 3]
      ]
    );
    assert.equal(state.active.runSamples, true);
    assert.deepEqual(job.state.generated.scoring, {
      status: "replaced",
      subtasks: 2,
      digest: review.proposedDigest,
      previousDigest: before.digest
    });
    // The checker the job wrote is published with the limits it was checked with
    const request = requests.at(-1);
    assert.deepEqual(
      [request.profiles.roles.checker.timeLimitMs, request.profiles.roles.checker.memoryLimitMiB],
      [5000, 256]
    );
    assert.deepEqual([state.active.checker.timeLimit, state.active.checker.memoryLimit], [5000, 256]);
    assert.deepEqual(state.active.checker.compileAndRunOptions, { compiler: "g++", std: "c++17", O: "2", m: "64" });
  });
});

test("an approval is of the change it was shown: another plan is reviewed again", async () => {
  await fixture(async ({ state, job, service, run }) => {
    job.state.plan.subtasks = [
      { id: 1, points: 40 },
      { id: 2, points: 60 }
    ];
    await assert.rejects(run(), /AI_SCORING_REVIEW_REQUIRED/);
    Object.assign(job, { status: "failed", error: "AI_SCORING_REVIEW_REQUIRED" });
    job.state = service.retryState(job, "replace-scoring");
    job.state.plan.subtasks = [
      { id: 1, points: 60 },
      { id: 2, points: 40 }
    ];
    await assert.rejects(run(), /AI_SCORING_REVIEW_REQUIRED/);
    assert.equal(state.activations, 0);
    // Nothing to approve on another failure
    Object.assign(job, { error: "SANDBOX_GENERATION_FAILED" });
    assert.throws(() => service.retryState(job, "replace-scoring"), /INVALID_RETRY_MODE/);
  });
});

test("published test data records where its run was made and the exact bytes of its cases", async () => {
  await fixture(async ({ state, job, service, run }) => {
    const sandbox = service.runSandbox;
    let reported;
    service.runSandbox = async (...args) => {
      reported = await sandbox(...args);
      reported.operation = {
        key: "k".repeat(64),
        origin: "judge",
        result: "collected-again",
        task: "t",
        judgeRuntimeId: 4
      };
      return reported;
    };
    await run();
    const generation = require("js-yaml").load(state.files.get("data.yaml")).generation;
    assert.deepEqual(generation.execution, {
      operation: "k".repeat(64),
      origin: "judge",
      task: "t",
      judgeRuntimeId: 4,
      result: "collected-again",
      attempt: reported.execution.attemptId,
      runtime: reported.execution.runtime,
      startedAt: reported.execution.startedAt,
      finishedAt: reported.execution.finishedAt,
      reuse: reported.execution.reuse
    });
    assert.deepEqual(generation.corpus.cases, reported.corpus);
    assert.equal(generation.corpus.digest, aiContractDigest(reported.corpus));
    assert.deepEqual(job.state.generated.execution, generation.execution);
    // The fixture's runner writes the same input for every case: reported, not refused (review Part III, W05)
    assert.deepEqual(job.state.generated.corpus, {
      digest: generation.corpus.digest,
      cases: 5,
      adversarial: 0,
      distinct: 1
    });
    assert.equal(generation.corpus.distinct, 1);
    assert(job.state.warnings.includes("FINAL_CASES_REPEATED"));
  });
  // Files that aren't the cases the run reported publish nothing
  for (const tamper of [
    result => (result.corpus[2].output.sha256 = "0".repeat(64)),
    result => result.corpus.pop(),
    // A runner of protocol version 7 reports none
    result => (result.corpus = null)
  ])
    await fixture(async ({ state, service, run }) => {
      const sandbox = service.runSandbox;
      service.runSandbox = async (...args) => {
        const result = await sandbox(...args);
        tamper(result);
        return result;
      };
      await assert.rejects(run(), /INVALID_SANDBOX_RESPONSE: The generated files aren't the cases the run reported/);
      assert.equal(state.writes.length, 0);
      assert.equal(state.activations, 0);
    });
});

test("the job's test data step acknowledges its run only after its checkpoint, and stops it when it fails", async () => {
  const run = async (testdata, signal) => {
    const service = bareAiServices();
    const events = [];
    const job = { id: "job", action: "testdata", ownerId: 1, problemId: 1, state: { completed: [] } };
    Object.assign(service, {
      config: async () => ({}),
      assertJob: async () => ({ id: 1 }),
      recordAiAudit: async () => {},
      editable: async () => ({ id: 1, type: "Traditional" }),
      snapshot: async () => ({}),
      checkpoint: async (_job, step, progress) => events.push(`checkpoint ${step} ${progress}`),
      testdata,
      execution: {
        acknowledge: async id => events.push(`acknowledge ${id}`),
        release: async id => events.push(`release ${id}`),
        discard: async id => events.push(`discard ${id}`)
      }
    });
    const running = Promise.resolve().then(() => service.execute(job));
    return { running, events, service };
  };
  let f = await run(async () => {});
  await f.running;
  assert.deepEqual(f.events, ["checkpoint testdata 0", "checkpoint testdata 100", "acknowledge job"]);
  // Published and checkpointed, the job completes even if its runs can't be cleaned up now
  f = await run(async () => {});
  f.service.execution.acknowledge = async () => {
    throw new Error("storage is unavailable");
  };
  await f.running;
  for (const [error, expected] of [
    [new AiError("AI_PROFILE_MISMATCH"), ["checkpoint testdata 0", "release job"]],
    [new AiError("JOB_CANCELLED"), ["checkpoint testdata 0", "discard job"]],
    // Another backend runs the job now: its runs are left to it
    [new AiError("JOB_LEASE_LOST"), ["checkpoint testdata 0"]]
  ]) {
    f = await run(async () => {
      throw error;
    });
    await assert.rejects(f.running, error);
    assert.deepEqual(f.events, expected, error.code);
  }
});

test("a runner that doesn't report the profiles it was sent qualifies nothing", async () => {
  const service = bareAiServices();
  service.coordinator = { assertJob: async () => ({ id: 1 }) };
  const profiles = { version: 1, roles: {} };
  for (const reported of [undefined, "0".repeat(64)]) {
    service.execution = { run: async () => ({ validation: { profiles: reported } }) };
    await assert.rejects(
      service.runSandbox({ id: "job" }, { profiles }, async () => {}),
      /INVALID_SANDBOX_RESPONSE/
    );
  }
  // Nor one that doesn't say how it made its result, under the current contract (review Part III, W03)
  const execution = {
    contract: AI_EXECUTION_PROTOCOL_VERSION,
    attemptId: "0f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f",
    runtime: { judgeProgram: "a".repeat(64), sandboxImage: "bbe9c69b2027", arch: "x64" },
    startedAt: "2026-11-04T10:00:00.000Z",
    finishedAt: "2026-11-04T10:01:00.000Z",
    reuse: { builds: 0, inputs: 0 }
  };
  const operation = { key: "k".repeat(64), origin: "local", result: "new" };
  for (const reported of [
    {},
    { execution },
    { operation },
    { execution: { ...execution, contract: AI_EXECUTION_PROTOCOL_VERSION - 1 }, operation }
  ]) {
    service.execution = { run: async () => ({ validation: { profiles: aiContractDigest(profiles) }, ...reported }) };
    await assert.rejects(
      service.runSandbox({ id: "job" }, { profiles }, async () => {}),
      /how it made its result/
    );
  }
  service.execution = {
    run: async () => ({ validation: { profiles: aiContractDigest(profiles) }, execution, operation })
  };
  assert.deepEqual(await service.runSandbox({ id: "job" }, { profiles }, async () => {}), {
    validation: { profiles: aiContractDigest(profiles) },
    execution,
    operation
  });
});

// Review Part III, W05: coverage-aware selection
test("a target whose subtasks have no case to build for it gets one, before any program is written", async () => {
  await fixture(
    async ({ job, service, run }) => {
      job.state.plan.subtasks = [
        { id: 1, points: 98 },
        { id: 2, points: 2 }
      ];
      Object.assign(job.state, qualityState([2]));
      let request;
      service.runSandbox = async (_job, current) => {
        request = current;
        throw new AiError("JOB_CANCELLED");
      };
      await assert.rejects(run(), /JOB_CANCELLED/);
      assert.deepEqual(job.state.caseAllocation.capacity, [
        { subtask: 2, from: 1, to: 3, targets: ["misses_boundary"] }
      ]);
      assert.equal(request.cases.filter(item => item.subtask === 2).length, 3);
      assert.equal(request.cases.length, 52);
      assert(job.state.warnings.includes("CASE_CAPACITY_ADJUSTED"));
      assert(job.state.warnings.includes("TEST_COUNT_ADJUSTED"));
    },
    { ...originalJudgeInfo(), subtasks: null, checker: { type: "lines", caseSensitive: false } }
  );
});

test("the selection report is published with the data; repeated differential inputs are reported", async () => {
  await fixture(async ({ state, job, service, run }) => {
    const sandbox = service.runSandbox;
    let receipt;
    service.runSandbox = async (...args) => {
      const result = await sandbox(...args);
      receipt = result.validation.quality;
      Object.assign(receipt, {
        fuzzDistinct: 3,
        extraAttemptsUsed: 1,
        replacements: [{ case: 3, source: "search", kills: ["misses_boundary"], moved: [] }],
        search: { attempts: 1, budget: receipt.extraAttemptsUsed, found: 1, unplaced: 0, promoted: 0 },
        matrix: [{ case: 1, killed: ["misses_boundary"], passed: [] }]
      });
      receipt.search.budget = args[1].quality.extraAttempts;
      receipt.challengeResults[0] = { ...receipt.challengeResults[0], tested: 1, kills: 1 };
      return result;
    };
    await run();
    assert.equal(state.activations, 1);
    const generation = require("js-yaml").load(state.files.get("data.yaml")).generation;
    assert.deepEqual(generation.qualityValidation, receipt);
    assert.deepEqual(job.state.generated.qualityValidation, receipt);
    assert(job.state.warnings.includes("DIFFERENTIAL_INPUTS_REPEATED"));
  });
  // A report that doesn't agree with its witnesses publishes nothing
  await fixture(async ({ state, service, run }) => {
    const sandbox = service.runSandbox;
    service.runSandbox = async (...args) => {
      const result = await sandbox(...args);
      result.validation.quality.matrix = [{ case: 1, killed: [], passed: ["misses_boundary"] }];
      return result;
    };
    await assert.rejects(run(), /TESTDATA_QUALITY_GATE_FAILED: Invalid test selection report/);
    assert.equal(state.writes.length, 0);
    assert.equal(state.activations, 0);
  });
});
