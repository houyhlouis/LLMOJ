/* Real judge completions through the backend contract, without fabricated execution records or native sandboxes. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const ts = require("typescript");

require("reflect-metadata");
const compile = filename =>
  ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true
    }
  }).outputText;
require.extensions[".ts"] = (module, filename) => module._compile(compile(filename), filename);
const protocol = require("@libreoj/judge-protocol");
const { AiExecutionService } = require("./ai-execution.service.ts");
const { AiWorkflowService } = require("./ai-workflow.service.ts");
const { currentExecution } = require("./ai-operation.ts");
const { resolveAiProfiles } = require("./ai-judging-contract.ts");
const judgeDirectory = path.resolve(__dirname, "../../../judge/src");
const judgeRequire = createRequire(path.join(judgeDirectory, "aiRunner.ts"));
const esm = value => ({ __esModule: true, default: value });

// Load the entire runner and its real quality/checkpoint/receipt modules. Only native execution,
// compiler metadata, scheduling, configuration, and runtime discovery use test doubles.
function runnerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-runner-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputRoot = path.join(root, "output");
  const sampleDirectory = path.join(root, "samples");
  fs.mkdirSync(outputRoot);
  fs.mkdirSync(sampleDirectory);
  const layout = { outputRoot, sampleDirectory, evidenceDirectory: path.join(root, "evidence") };
  const calls = { compiled: [], executed: [], events: [] };
  const status = { OK: 0, 0: "OK" };
  const SOURCE = "/sandbox/source",
    BINARY = "/sandbox/binary",
    WORKING = "/sandbox/working";
  const stubs = {
    winston: esm({ warn() {} }),
    "simple-sandbox": { SandboxStatus: status },
    "./config": esm({ dataStore: root, aiGeneratedDirectory: outputRoot }),
    "./runtimeIdentity": esm(async () => ({
      judgeProgram: "a".repeat(64),
      sandboxImage: "contract-fixture",
      arch: "x64",
      node: "test-node",
      os: "test-os",
      kernel: "test-kernel",
      cpu: "test-cpu"
    })),
    "./architecture": { cArchitectureUnavailable: () => null },
    "./languages": esm(() => ({
      compile: () => ({
        executable: "/usr/bin/fixture-cxx",
        parameters: [`${SOURCE}/main.cpp`, "-o", `${BINARY}/a.out`]
      })
    })),
    "./executionScheduler": { COMPILE_RESERVATION: 512 },
    "./utils": { ensureDirectoryEmpty: directory => fs.promises.mkdir(directory, { recursive: true }) },
    "./taskQueue": {
      runTaskQueued: async (_reservation, run) => {
        const directory = await fs.promises.mkdtemp(path.join(root, "task-"));
        try {
          return await run(directory);
        } finally {
          await fs.promises.rm(directory, { recursive: true, force: true });
        }
      }
    },
    "./sandbox": {
      CpuAffinityStrategy: { Compiler: "Compiler" },
      SANDBOX_INSIDE_PATH_SOURCE: SOURCE,
      SANDBOX_INSIDE_PATH_BINARY: BINARY,
      SANDBOX_INSIDE_PATH_WORKING: WORKING,
      runSandbox: async (_task, options) => {
        const outside = inside => {
          const mount = options.extraMounts.find(item => inside.startsWith(`${item.mappedPath.inside}/`));
          assert(mount, `No mount for ${inside}`);
          return path.join(mount.mappedPath.outside, inside.slice(mount.mappedPath.inside.length + 1));
        };
        if (options.cpuAffinity === "Compiler") {
          const source = fs.readFileSync(outside(`${SOURCE}/main.cpp`));
          calls.compiled.push(source.toString());
          // An opaque synthetic binary: the real runner installs it and keys it by the real compile inputs.
          fs.writeFileSync(outside(`${BINARY}/a.out`), source);
        } else {
          const name = path.basename(path.dirname(outside(options.executable)));
          assert(fs.statSync(outside(options.executable)).isFile());
          const input = fs.readFileSync(outside(options.stdin), "utf8");
          calls.executed.push(name);
          let output;
          if (name === "make") output = `${100 + Number(options.parameters[1])}\n`;
          else if (name === "quality-small-make") output = `${1 + (Number(options.parameters[1]) % 4)}\n`;
          else if (name === "validator") output = "";
          else if (name === "quality-challenge-0" && Number(input) > 10) output = "wrong\n";
          else output = `${2 * Number(input)}\n`;
          fs.writeFileSync(outside(options.stdout), output);
          fs.writeFileSync(outside(options.stderr), "");
        }
        return { status: status.OK, code: 0, termination: "exited", time: 1000000, memory: 1024 };
      }
    },
    "./checkers/builtin": {
      runBuiltinChecker: async (actual, expected) => ({
        score: fs.readFileSync(actual).equals(fs.readFileSync(expected)) ? 100 : 0
      })
    },
    // These native adapters belong to other task types or the Unix socket listener, neither used here.
    "./posixUtils": {},
    "./compile": {},
    "./task/submission/interaction": {},
    "./launcherClient": {},
    "./launcher/protocol": {},
    "./launcher/native": {}
  };
  const modules = new Map();
  const load = filename => {
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const localRequire = name => {
      if (Object.hasOwn(stubs, name)) return stubs[name];
      if (!name.startsWith(".")) {
        if (name === "bindings") throw new Error(`Unexpected native import from ${filename}`);
        return judgeRequire(name);
      }
      const resolved = path.resolve(path.dirname(filename), name);
      return load(fs.existsSync(`${resolved}.ts`) ? `${resolved}.ts` : path.join(resolved, "index.ts"));
    };
    new Function("require", "module", "exports", "__dirname", `${compile(filename)}\n//# sourceURL=${filename}`)(
      localRequire,
      module,
      module.exports,
      path.dirname(filename)
    );
    return module.exports;
  };
  const runner = load(path.join(judgeDirectory, "aiRunner.ts"));
  const execution = Object.create(AiExecutionService.prototype);
  execution.mode = () => "local";
  execution.harvestLocal = async () => {};
  execution.runLocal = async (_job, request, progress) => {
    runner.validate(request);
    let complete;
    await runner.runGeneration(
      request,
      event => {
        calls.events.push(event);
        if (event.type === "complete") complete = event;
        else progress(event);
      },
      () => false,
      layout
    );
    assert(complete, "the real runner emitted a completion");
    return complete;
  };
  const workflow = Object.create(AiWorkflowService.prototype);
  workflow.execution = execution;
  workflow.coordinator = { checkpoint: async () => {}, assertJob: async () => {} };
  return { runner, layout, workflow, calls, root };
}

const source = role => `int main() { return 0; } // synthetic ${role}`;
function requestFor(operation) {
  const request = {
    operation,
    jobId: crypto.randomUUID(),
    problemType: "Traditional",
    makeCode: source("make"),
    stdCode: source("std"),
    validatorCode: source("validator"),
    cases: Array.from({ length: 5 }, (_, i) => ({ subtask: 1, seed: i + 1 })),
    samples: [{ input: "2\n", output: "4\n" }],
    profiles: resolveAiProfiles({
      problemType: "Traditional",
      judgeInfo: { timeLimit: 1000, memoryLimit: 64 },
      timeLimitMs: 1000,
      memoryLimitMiB: 64,
      checker: false
    }),
    quality: {
      version: 1,
      smallMakeCode: source("small-make"),
      oracleCode: source("oracle"),
      alternatives: [{ id: "alternate", code: source("alternate") }],
      challenges: [{ id: "boundary", code: source("boundary"), kind: "wrong", subtasks: [1], reason: "boundary" }],
      fuzzCases: Array.from({ length: 64 }, (_, seed) => ({ subtask: 1, seed })),
      extraAttempts: 0
    }
  };
  if (["validate-reference", "replay"].includes(operation)) {
    request.cases = [];
    delete request.quality;
  }
  if (operation === "replay")
    request.replay = {
      check: "run",
      role: "std",
      files: { input: "replay.input" },
      repeat: 3,
      programs: { std: request.stdCode }
    };
  return request;
}

async function consume(fixture, request) {
  const job = { id: request.jobId, state: {}, input: {}, step: "testdata.candidate-preflight", progress: 50 };
  // AiExecutionService supplies its own logical-operation metadata; it cannot repair a missing execution field.
  const result = await fixture.workflow.runSandbox(job, request, async () => {});
  const emitted = fixture.calls.events.filter(event => event.type === "complete").at(-1);
  assert.equal(result.execution, emitted.execution, "the backend consumed the exact runner record");
  assert.deepEqual(currentExecution(emitted), emitted.execution);
  assert.equal(emitted.execution.contract, protocol.AI_EXECUTION_PROTOCOL_VERSION);
  assert.equal(emitted.execution.qualityPolicy, protocol.AI_QUALITY_POLICY_VERSION);
  assert.equal(emitted.execution.receiptVersion, protocol.AI_RECEIPT_VERSION);
  assert.equal(result.operation.origin, "local");
  assert.equal(result.validation.profiles, protocol.aiContractDigest(request.profiles));
  return result;
}

for (const operation of ["qualify", "generate", "validate-reference", "replay"]) {
  test(`real ${operation} completion satisfies the backend execution and workflow contracts`, async t => {
    const fixture = runnerFixture(t);
    const request = requestFor(operation);
    if (operation === "replay") fs.writeFileSync(path.join(fixture.layout.sampleDirectory, "replay.input"), "3\n");
    const result = await consume(fixture, request);
    assert(fixture.calls.compiled.length > 0);
    assert(fixture.calls.executed.length > 0);
    if (operation === "qualify") {
      assert.equal(result.qualification.fuzzPassed, 64);
      assert.deepEqual(result.qualification.candidates, ["boundary"]);
      assert.equal(result.validation.samplesPassed, 1);
      assert.equal(result.validation.sampleInputsPassed, 1);
    } else if (operation === "generate") {
      assert.equal(result.corpus.length, 5);
      assert.equal(result.validation.quality.challengesKilled, 1);
    } else if (operation === "validate-reference") {
      assert.equal(result.validation.samplesPassed, 1);
      assert.deepEqual(result.files, []);
    } else
      assert.deepEqual(
        result.replay.runs.map(run => run.outcome),
        ["passed", "passed", "passed"]
      );
  });
}

test("qualification resumes actual build/input checkpoints and still emits a current execution record", async t => {
  const fixture = runnerFixture(t);
  const request = requestFor("qualify");
  // The normal backend adapter supplies an operation key for resumable generator inputs.
  const interrupted = { ...structuredClone(request), operationKey: "b".repeat(64) };
  fixture.runner.validate(interrupted);
  let canceled = false;
  await assert.rejects(
    fixture.runner.runGeneration(
      interrupted,
      event => {
        if (event.phase === "quality-differential" && event.completed === 8) canceled = true;
      },
      () => canceled,
      fixture.layout
    ),
    /Generation canceled/
  );
  const builds = fixture.calls.compiled.length;
  assert(builds > 0);
  assert.equal(fixture.calls.executed.filter(name => name === "quality-small-make").length, 8);
  assert(fs.existsSync(path.join(fixture.root, "ai-corpus", request.jobId)));

  const result = await consume(fixture, request);
  assert.equal(result.execution.reuse.builds, builds, "all unchanged binaries came from the checkpoint");
  assert.equal(fixture.calls.compiled.length, builds, "resuming compiled no unchanged program again");
  assert.equal(result.execution.reuse.inputs, 8);
  assert.equal(
    fixture.calls.executed.filter(name => name === "quality-small-make").length,
    64,
    "the eight retained inputs were not generated twice"
  );
  assert.equal(result.qualification.fuzzPassed, 64);
});

test("legacy parsing remains separate from strict current execution acceptance", async t => {
  const fixture = runnerFixture(t);
  const result = await consume(fixture, requestFor("validate-reference"));
  for (const field of ["qualityPolicy", "receiptVersion"]) {
    const legacy = { ...result.execution };
    delete legacy[field];
    assert(protocol.parseAiExecutionRecord(legacy));
    assert.equal(currentExecution({ execution: legacy }), null);
    fixture.workflow.execution = { run: async () => ({ ...result, execution: legacy }) };
    await assert.rejects(
      fixture.workflow.runSandbox(
        { id: "legacy", state: {}, input: {}, step: "validation", progress: 0 },
        { operation: "validate-reference" },
        async () => {}
      ),
      error => error.code === "INVALID_SANDBOX_RESPONSE"
    );
  }
});
