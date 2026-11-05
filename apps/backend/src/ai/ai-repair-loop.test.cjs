/* Credential-free tests of the bounded repair loop of AI test data jobs (review Part III, H02/W04, section 10.2). */
// A scripted model and a scripted runner: a failure is repaired by replacing one AI-written program, which is tested
// against the kept failure before the whole run; the infrastructure is retried without a model; and the loop stops
// for the owner on ambiguity, on unchanged or invalid repairs, on stale evidence and at its limits.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
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
const { AI_EXECUTION_PROTOCOL_VERSION, aiContractDigest } = require("@libreoj/judge-protocol");
const provider = require("./ai-provider.ts");
const { aiServices } = require("./ai-test-services.cjs");
const { AiError } = require("./ai.types.ts");
const { AI_REPAIR_LIMITS, generationRevision } = require("./ai-repair.ts");
const { jobProgram } = require("./ai-replay.ts");

const JOB = "0f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
const program = name => `#include <cstdio>\nint main(){/* ${name} */return 0;}`;
const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");

function jobState(extra = {}) {
  return {
    plan: { needsSpj: false, subtasks: [{ id: 1, points: 100 }], timeLimitMs: 1000, memoryLimitMiB: 256 },
    qualityPlan: {
      targets: [{ id: "greedy", kind: "wrong", subtasks: [1], reason: "greedy" }],
      correctAlgorithms: ["dp", "brute"]
    },
    makeCode: program("make"),
    stdCode: program("std"),
    validatorCode: program("validator"),
    referenceSource: { kind: "model", sha256: sha256(program("std")), validated: false },
    qualityArtifacts: {
      version: 1,
      smallMakeCode: program("small"),
      oracleCode: program("oracle"),
      alternatives: [{ id: "independent", code: program("alt") }],
      challenges: [{ id: "greedy", code: program("challenge"), kind: "wrong", subtasks: [1], reason: "greedy" }]
    },
    problemHelpers: [],
    warnings: [],
    ...extra
  };
}

// The request a run is sent, from the job's state
const requestOf = state => ({
  jobId: JOB,
  problemType: "Traditional",
  makeCode: state.makeCode,
  stdCode: state.stdCode,
  validatorCode: state.validatorCode,
  ...(state.plan.needsSpj ? { checkerCode: state.checkerCode } : {}),
  checker: { type: "tokens", caseSensitive: true },
  cases: [{ subtask: 1, seed: 1 }, { subtask: 1, seed: 2 }],
  timeLimitMs: 5000,
  profiles: { version: 1 },
  quality: {
    version: 1,
    fuzzCases: [{ subtask: 1, seed: 1 }],
    smallMakeCode: state.qualityArtifacts.smallMakeCode,
    oracleCode: state.qualityArtifacts.oracleCode,
    alternatives: state.qualityArtifacts.alternatives,
    challenges: state.qualityArtifacts.challenges,
    extraAttempts: 16
  }
});

/**
 * `runs`: what each run of the programs does, in order: an observation (it fails with it), an AiError, or nothing (it
 * passes). `replays`: what each replay of a kept failure does: "failed" (as the failure did) or "passed".
 */
function fixture({ runs = [], replays = [], state = jobState(), privileges } = {}) {
  const user = { id: 1 };
  const job = { id: JOB, ownerId: 1, action: "testdata", status: "running", state, progress: 50, step: "testdata.compile", runToken: "r" };
  const svc = aiServices(
    {},
    {},
    {},
    privileges || { userHasPrivilege: async () => true, permissionDecision: async () => true }
  );
  // Runs again after the infrastructure failed at once
  svc.services.workflow.retryDelay = 0;
  const log = { runs: [], checkpoints: [], audits: [], replays: [], records: [] };
  const rows = new Map();
  let attempts = 0;
  svc.assertSnapshot = async () => user;
  svc.checkpoint = async (_job, step) => {
    log.checkpoints.push({ step, state: structuredClone(job.state) });
  };
  svc.recordAiAudit = async (_user, action, _job, details) => log.audits.push({ action, details });
  svc.runSandbox = async (_job, request) => {
    log.runs.push(structuredClone(request));
    const next = runs.shift();
    if (next instanceof Error) throw next;
    if (!next) return { ok: true };
    // A failure kept with its evidence: of the programs the run had
    const id = `00000000-0000-4000-8000-${String(++attempts).padStart(12, "0")}`;
    const failure = { fatal: true, summary: "It failed", artifacts: [], ...next };
    const error = new AiError("SANDBOX_GENERATION_FAILED", failure.summary);
    error.failure = failure;
    error.observationId = id;
    rows.set(id, {
      id,
      jobId: JOB,
      evidence: failure.artifacts.length ? "stored" : "none",
      expiresAt: new Date(Date.now() + 86400000),
      observation: {
        ...failure,
        origin: "local",
        operation: "generate",
        attemptId: "a",
        sourceHashes: next.sourceHashes || generationRevision(request, {}).sources
      }
    });
    throw error;
  };
  svc.services.workflow.evidence = {
    observation: async (_job, id) => {
      if (!rows.has(id)) throw new AiError("NO_SUCH_OBSERVATION");
      return rows.get(id);
    },
    readText: async () => "error: expected ';' before '}' token",
    addReplay: async (id, record) => log.records.push({ id, record }),
    updateReplay: async (id, replayId, changes) => log.records.push({ id, replayId, changes })
  };
  svc.replayRequest = async (current, _problem, plan) => {
    const programs = Object.fromEntries(plan.programs.map(role => [role, jobProgram(current.state, role)]));
    return {
      request: { operation: "replay", profiles: { version: 1 }, replay: { ...plan, programs } },
      programs,
      profiles: "same"
    };
  };
  svc.execution = {
    replay: async (_job, request) => {
      log.replays.push({ check: request.replay.check, role: request.replay.role, programs: request.replay.programs });
      const outcome = replays.shift() || "passed";
      if (outcome instanceof Error) throw outcome;
      const now = new Date().toISOString();
      return {
        type: "complete",
        validation: { profiles: aiContractDigest({ version: 1 }) },
        execution: {
          contract: AI_EXECUTION_PROTOCOL_VERSION,
          attemptId: crypto.randomUUID(),
          runtime: { judgeProgram: "0".repeat(64), sandboxImage: "test", arch: "x64" },
          startedAt: now,
          finishedAt: now,
          reuse: { builds: 0, inputs: 0 }
        },
        operation: { origin: "local" },
        replay: {
          runs: Array.from({ length: request.replay.repeat }, () =>
            outcome === "failed"
              ? { outcome: "failed", kind: rows.values().next().value?.observation.kind, summary: "again" }
              : { outcome: "passed", summary: "ok" }
          )
        }
      };
    }
  };
  const problem = { id: 8, type: "Traditional" };
  const snapshot = { statements: [{ title: "A + B" }], judgeInfo: {}, samples: [] };
  const config = { llm: { apiKey: "synthetic-llm-secret" }, search: { apiKey: "synthetic-search-secret" } };
  const request = requestOf(state);
  return {
    svc,
    job,
    log,
    rows,
    request,
    run: () => svc.runGenerationSandbox(job, config, problem, snapshot, request, async () => {}),
    ownerRepair: () => svc.ownerRepair(job, config, problem, snapshot)
  };
}

async function withModel(answer, work) {
  const prompts = [];
  const old = provider.generateText;
  provider.generateText = async (_config, _system, prompt) => {
    prompts.push(prompt);
    return typeof answer === "function" ? answer(prompt, prompts.length) : answer;
  };
  try {
    await work();
  } finally {
    provider.generateText = old;
  }
  return prompts;
}

// The programs that differ between two run requests
function changedPrograms(before, after) {
  const a = generationRevision(before, {}).sources;
  const b = generationRevision(after, {}).sources;
  return Object.keys({ ...a, ...b }).filter(role => a[role] !== b[role]);
}
// A request without its programs: what the gates are
function gates(request) {
  const copy = structuredClone(request);
  for (const field of ["makeCode", "stdCode", "validatorCode", "checkerCode", "interactorCode", "managerCode"])
    delete copy[field];
  delete copy.quality.smallMakeCode;
  delete copy.quality.oracleCode;
  copy.quality.alternatives = copy.quality.alternatives.map(({ code, ...rest }) => rest);
  copy.quality.challenges = copy.quality.challenges.map(({ code, ...rest }) => rest);
  return copy;
}

const diagnostics = {
  role: "diagnostics",
  classification: "author-private",
  name: "0.diagnostics",
  size: 40,
  originalSize: 40,
  sha256: "d".repeat(64),
  preview: "error: expected ';' before '}' token",
  binary: false,
  stored: true
};
const altCompile = {
  kind: "compile_error",
  role: "quality-alt-0",
  phase: "compile-quality-alt-0",
  execution: { status: "RuntimeError", exitCode: 1, termination: "exited" },
  artifacts: [diagnostics]
};

test("an alternative that doesn't compile is repaired alone; every other program and every gate stay as they were", async () => {
  const f = fixture({ runs: [altCompile] });
  const before = generationRevision(f.request, {});
  const prompts = await withModel(program("alt fixed"), async () => assert.equal((await f.run()).ok, true));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Repair ONLY alternative-1\.cpp/);
  assert.match(prompts[0], /expected ';' before/, "the compiler's whole kept diagnostics");
  assert.equal(f.log.runs.length, 2);
  assert.deepEqual(changedPrograms(f.log.runs[0], f.log.runs[1]), ["quality-alt-0"]);
  assert.deepEqual(gates(f.log.runs[1]), gates(f.log.runs[0]), "the same cases, limits, checks and targets");
  const after = generationRevision(f.request, f.job.state);
  for (const role of ["make", "std", "validator", "quality-small-make", "quality-oracle", "quality-challenge-0"])
    assert.equal(after.sources[role], before.sources[role], role);
  // Tested against the kept failure first: a compilation of the repaired program
  assert.deepEqual(f.log.replays.map(replay => [replay.check, replay.role]), [["compile", "quality-alt-0"]]);
  assert.equal(f.log.replays[0].programs["quality-alt-0"], program("alt fixed"));
  const { repair } = f.job.state;
  assert.equal(repair.automatic, 1);
  assert.equal(repair.revisions.length, 1);
  assert.deepEqual(
    { ...repair.revisions[0], at: undefined, signature: undefined, observationId: undefined },
    {
      round: 1,
      role: "quality-alt-0",
      by: "automatic",
      failure: { kind: "compile_error", phase: "compile-quality-alt-0" },
      from: sha256(program("alt")),
      to: sha256(program("alt fixed")),
      at: undefined,
      signature: undefined,
      observationId: undefined,
      test: "passed",
      result: "passed"
    }
  );
  // The budget was persisted before the model was asked, and the repair audited
  const spent = f.log.checkpoints.findIndex(item => item.step === "testdata.repair");
  assert.equal(f.log.checkpoints[spent].state.repair.automatic, 1);
  assert.equal(f.log.checkpoints[spent].state.qualityArtifacts.alternatives[0].code, program("alt"));
  assert.deepEqual(f.log.audits.map(item => item.action), ["job.repair"]);
  assert.equal(f.log.records[0].record.repair, 1, "the replay is kept with the failure, naming the repair it tested");
  assert(f.job.state.warnings.includes("AI_PROGRAM_REPAIRED"));
});

test("the infrastructure is retried with the same programs and no model request, a bounded number of times", async () => {
  const infra = { kind: "infrastructure_error", phase: "generate" };
  const f = fixture({ runs: [new AiError("SANDBOX_DISCONNECTED"), infra] });
  const prompts = await withModel(() => assert.fail("no model request"), async () => assert.equal((await f.run()).ok, true));
  assert.equal(prompts.length, 0);
  assert.equal(f.log.runs.length, 3);
  assert.deepEqual(f.log.runs[2], f.log.runs[0], "the same request");
  assert.equal(f.job.state.repair.infrastructure, 2);
  // A third time: the owner decides
  const g = fixture({ runs: [infra, infra, infra] });
  let thrown;
  await withModel(() => assert.fail("no model request"), async () => {
    await g.run().catch(error => (thrown = error));
  });
  assert.equal(thrown.failure.kind, "infrastructure_error");
  assert.equal(g.log.runs.length, 3);
  assert.equal(g.job.state.repair.review.reason, "INFRASTRUCTURE");
});

for (const [name, answer, reason] of [
  ["the same program", program("alt"), "IDENTICAL"],
  ["not a program", "I can't fix this", "INVALID"],
  ["a program too large", `${program("alt")}//${"x".repeat(300 * 1024)}`, "INVALID"]
])
  test(`a proposal that is ${name} stops the job for its owner and replaces nothing`, async () => {
    const f = fixture({ runs: [altCompile] });
    let thrown;
    const prompts = await withModel(answer, async () => {
      await f.run().catch(error => (thrown = error));
    });
    assert.equal(prompts.length, 1);
    assert.equal(thrown.failure.kind, "compile_error", "the job fails with the failure it stopped at");
    assert.equal(f.log.runs.length, 1);
    assert.equal(f.job.state.qualityArtifacts.alternatives[0].code, program("alt"));
    assert.deepEqual(
      f.job.state.repair.revisions.map(revision => [revision.role, revision.rejected, revision.from === sha256(program("alt"))]),
      [["quality-alt-0", reason, true]]
    );
    assert.equal(f.job.state.repair.automatic, 1, "the request was spent");
    assert.deepEqual(
      { ...f.job.state.repair.review, at: undefined },
      {
        reason,
        roles: ["quality-alt-0"],
        observationId: thrown.observationId,
        kind: "compile_error",
        phase: "compile-quality-alt-0",
        role: "quality-alt-0",
        at: undefined
      }
    );
    // Retried as it is: the same failure of the same program isn't sent to the model again
    Object.assign(f.job, { status: "failed", error: thrown.message });
    f.job.state = f.svc.retryState(f.job);
    const g = fixture({ state: f.job.state, runs: [altCompile] });
    const again = await withModel(() => assert.fail("no model request"), async () => {
      await g.run().catch(() => undefined);
    });
    assert.equal(again.length, 0);
    assert.equal(g.job.state.repair.review.reason, "UNCHANGED");
  });

test("a checker repair that gives partial scores is not a valid checker", async () => {
  const state = jobState({ plan: { ...jobState().plan, needsSpj: true }, checkerCode: program("checker") });
  const f = fixture({ state, runs: [{ kind: "checker_failure", role: "checker", phase: "quality-differential" }] });
  await withModel(`${program("checker")} quitp(0.5);`, async () => {
    await f.run().catch(() => undefined);
  });
  assert.equal(f.job.state.repair.review.reason, "INVALID");
  assert.equal(f.job.state.checkerCode, program("checker"));
});

test("a failure of another version of the program is stale: no model request", async () => {
  const f = fixture({ runs: [{ ...altCompile, sourceHashes: { "quality-alt-0": sha256("another version") } }] });
  const prompts = await withModel(() => assert.fail("no model request"), async () => {
    await f.run().catch(() => undefined);
  });
  assert.equal(prompts.length, 0);
  assert.equal(f.job.state.repair.review.reason, "STALE");
  assert.equal(f.job.state.repair.automatic, 0);
});

test("a repair that still fails the kept failure ends there: the whole run isn't made again", async () => {
  const f = fixture({ runs: [altCompile], replays: ["failed"] });
  let thrown;
  await withModel(program("alt still broken"), async () => {
    await f.run().catch(error => (thrown = error));
  });
  assert.equal(thrown.failure.kind, "compile_error");
  assert.equal(f.log.runs.length, 1);
  assert.equal(f.job.state.repair.revisions[0].test, "failed");
  assert.equal(f.job.state.repair.review.reason, "UNCHANGED");
  assert.equal(f.job.state.qualityArtifacts.alternatives[0].code, program("alt still broken"), "kept for the owner");
});

test("a generator whose repair still makes illegal inputs for the scenario stops; the owner may blame the validator", async () => {
  const rejected = { kind: "validator_rejection", role: "validator", phase: "generate", subtask: 1, scenarioIndex: 3, subject: "case 3" };
  const f = fixture({ runs: [rejected, rejected] });
  let thrown;
  const prompts = await withModel(program("make fixed"), async () => {
    await f.run().catch(error => (thrown = error));
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Repair ONLY make\.cpp/);
  assert.equal(f.log.replays.length, 0, "the old input isn't the repaired generator's: the whole run is its test");
  assert.equal(f.log.runs.length, 2);
  assert.deepEqual(changedPrograms(f.log.runs[0], f.log.runs[1]), ["make"]);
  assert.equal(f.job.state.validatorCode, program("validator"), "the validator is never loosened");
  assert.equal(thrown.failure.kind, "validator_rejection");
  assert.deepEqual(
    { reason: f.job.state.repair.review.reason, roles: f.job.state.repair.review.roles },
    { reason: "UNCHANGED", roles: ["make", "validator"] }
  );
  assert.equal(f.job.state.repair.revisions[0].test, "untested");
  assert.equal(f.job.state.repair.revisions[0].result, "validator_rejection");
});

test("repairs are counted for the job's life: a restart or another call doesn't reset them", async () => {
  const failures = [
    { kind: "compile_error", role: "quality-alt-0", phase: "compile-quality-alt-0" },
    { kind: "compile_error", role: "quality-oracle", phase: "compile-quality-oracle" },
    { kind: "compile_error", role: "quality-small-make", phase: "compile-quality-small-make" },
    { kind: "compile_error", role: "validator", phase: "compile-validator" }
  ];
  const f = fixture({ runs: failures.slice(0, 2) });
  let count = 0;
  const answer = () => program(`fix ${++count}`);
  await withModel(answer, async () => assert.equal((await f.run()).ok, true));
  assert.equal(f.job.state.repair.automatic, 2);
  // The job's backend restarted: the same state, a new call
  const g = fixture({ runs: failures.slice(2), state: f.job.state });
  let thrown;
  const prompts = await withModel(answer, async () => {
    await g.run().catch(error => (thrown = error));
  });
  assert.equal(prompts.length, 1, "one repair left of three");
  assert.equal(g.job.state.repair.automatic, AI_REPAIR_LIMITS.automatic);
  assert.equal(thrown.failure.role, "validator");
  assert.deepEqual(
    { reason: g.job.state.repair.review.reason, roles: g.job.state.repair.review.roles },
    { reason: "REPAIR_LIMIT", roles: ["validator"] }
  );
});

test("revoked rights before or after the model request stop the repair; nothing is replaced", async () => {
  for (const when of [1, 2]) {
    let checks = 0;
    const f = fixture({
      runs: [altCompile],
      privileges: {
        userHasPrivilege: async () => true,
        permissionDecision: async () => ++checks !== when
      }
    });
    const prompts = await withModel(program("alt fixed"), async () => {
      await assert.rejects(f.run(), /PERMISSION_DENIED/);
    });
    assert.equal(prompts.length, when === 1 ? 0 : 1);
    assert.equal(f.job.state.qualityArtifacts.alternatives[0].code, program("alt"));
    assert.equal(f.log.runs.length, 1);
  }
});

test("a standard and an oracle that disagree stop for the owner, who chooses which one to repair", async () => {
  const disagreement = {
    kind: "solver_disagreement",
    role: "std",
    phase: "quality-differential",
    subject: "differential case 4",
    subtask: 1,
    scenarioIndex: 4,
    expectedBasis: "candidate_oracle",
    artifacts: [
      { role: "input", classification: "author-private", name: "0.input", size: 4, originalSize: 4, sha256: sha256("1 2\n"), preview: "1 2\n", binary: false, stored: true },
      { role: "expected", classification: "author-private", name: "0.expected", size: 2, originalSize: 2, sha256: sha256("3\n"), preview: "3\n", binary: false, stored: true }
    ]
  };
  const f = fixture({ runs: [disagreement] });
  let thrown;
  const none = await withModel(() => assert.fail("no model request"), async () => {
    await f.run().catch(error => (thrown = error));
  });
  assert.equal(none.length, 0);
  assert.deepEqual(
    { reason: f.job.state.repair.review.reason, roles: f.job.state.repair.review.roles },
    { reason: "ATTRIBUTION", roles: ["std", "quality-oracle"] }
  );
  // The owner's choice
  f.job.status = "failed";
  f.job.error = thrown.message;
  assert.deepEqual(f.svc.retryOptions(f.job), ["repair", "regenerate"]);
  assert.deepEqual(f.svc.repairRoles(f.job), ["std", "quality-oracle"]);
  assert.throws(() => f.svc.retryState(f.job, "repair", "make"), /INVALID_RETRY_MODE/);
  assert.throws(() => f.svc.retryState(f.job, "repair", "../std"), /INVALID_RETRY_MODE/);
  f.job.state = f.svc.retryState(f.job, "repair", "std");
  f.job.status = "running";
  assert.deepEqual(f.job.state.repair.pending, { role: "std", observationId: thrown.observationId });
  assert.equal(f.job.state.repair.review, undefined);
  const prompts = await withModel(program("std fixed"), async () => {
    await f.ownerRepair();
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Repair ONLY std\.cpp/);
  assert.match(prompts[0], /"preview":"1 2\\n"/, "the input the job's own small generator made");
  assert.equal(f.job.state.stdCode, program("std fixed"));
  assert.deepEqual(f.job.state.referenceSource, { kind: "model", sha256: sha256(program("std fixed")), validated: false, repaired: true });
  const { repair } = f.job.state;
  assert.equal(repair.pending, undefined);
  assert.equal(repair.automatic, 0, "an owner's repair isn't the job's own");
  assert.equal(repair.revisions[0].by, "owner");
  // Tested against the kept disagreement first: the repaired standard against the oracle, on the kept input
  assert.deepEqual(f.log.replays.map(replay => [replay.check, replay.role]), [["compare", "std"]]);
  assert.equal(repair.revisions[0].test, "passed");
  // Had the owner blamed the oracle, the same check would test it: it takes part in it
  const g = fixture({ runs: [disagreement] });
  let failed;
  await withModel(() => assert.fail("no model request"), async () => {
    await g.run().catch(error => (failed = error));
  });
  Object.assign(g.job, { status: "failed", error: failed.message });
  g.job.state = g.svc.retryState(g.job, "repair", "quality-oracle");
  await withModel(program("oracle fixed"), async () => {
    await g.ownerRepair();
  });
  assert.deepEqual(g.log.replays.map(replay => [replay.check, replay.role, replay.programs["quality-oracle"]]), [
    ["compare", "std", program("oracle fixed")]
  ]);
  assert.equal(g.job.state.repair.revisions[0].test, "passed");
});

test("a tutorial's solution is the owner's to replace; a repaired one reads stdin and is the model's", async () => {
  const state = jobState({
    referenceSource: { kind: "tutorial", discussionId: 3, sha256: sha256(program("std")), validated: true },
    stdFileIo: { inputFilename: "a.in", outputFilename: "a.out" }
  });
  const f = fixture({ state, runs: [{ kind: "runtime_error", role: "std", phase: "generate", subtask: 1, scenarioIndex: 2 }] });
  let thrown;
  await withModel(() => assert.fail("no model request"), async () => {
    await f.run().catch(error => (thrown = error));
  });
  assert.deepEqual(
    { reason: f.job.state.repair.review.reason, roles: f.job.state.repair.review.roles },
    { reason: "TUTORIAL_REFERENCE", roles: ["std"] }
  );
  Object.assign(f.job, { status: "failed", error: thrown.message });
  f.job.state = f.svc.retryState(f.job, "repair", "std");
  await withModel(program("std fixed"), async () => {
    await f.ownerRepair();
  });
  assert.equal(f.job.state.stdFileIo, null);
  assert.equal(f.job.state.referenceSource.kind, "model");
});

test("a correct program too slow once is replayed before it's rewritten: a failure that doesn't reproduce isn't its", async () => {
  const slow = { kind: "time_limit", role: "std", phase: "generate", subtask: 1, scenarioIndex: 9, artifacts: [
    { role: "input", classification: "hidden-test", name: "0.input", size: 2, originalSize: 2, sha256: sha256("9\n"), preview: "9\n", binary: false, stored: true }
  ] };
  const f = fixture({ runs: [slow], replays: ["passed"] });
  const prompts = await withModel(() => assert.fail("no model request"), async () => assert.equal((await f.run()).ok, true));
  assert.equal(prompts.length, 0);
  assert.deepEqual(f.log.replays.map(replay => [replay.check, replay.role]), [["run", "std"]]);
  assert.equal(f.log.runs.length, 2);
  assert.equal(f.job.state.repair.infrastructure, 1);
  // Reproduced: then it's rewritten, and the rewrite is tested on the same input
  const g = fixture({ runs: [slow], replays: ["failed", "passed"] });
  const asked = await withModel(program("std faster"), async () => assert.equal((await g.run()).ok, true));
  assert.equal(asked.length, 1);
  assert.deepEqual(g.log.replays.map(replay => [replay.check, replay.role]), [["run", "std"], ["run", "std"]]);
  assert.equal(g.job.state.repair.revisions[0].test, "passed");
});

test("the problem's own checker is never repaired, and the repair prompt carries no secret and no private sample", async () => {
  const state = jobState({
    plan: { ...jobState().plan, needsSpj: true },
    checkerCode: program("official checker"),
    problemHelpers: ["checker"]
  });
  const f = fixture({ state, runs: [{ kind: "checker_failure", role: "checker", phase: "quality-differential" }] });
  await withModel(() => assert.fail("no model request"), async () => {
    await f.run().catch(() => undefined);
  });
  assert.equal(f.job.state.repair.review.reason, "PROBLEM_HELPER");
  assert.deepEqual(f.job.state.repair.review.roles, []);
  assert.equal(f.job.state.checkerCode, program("official checker"));
  // A sample file of the problem's own, and secrets in the program
  const mismatch = {
    kind: "solver_disagreement",
    role: "std",
    phase: "validate-samples",
    subject: "sample 3",
    expectedBasis: "official_sample",
    summary: "Output mismatch: 3",
    difference: { unit: "token", index: 1, actual: "private-actual", expected: "private-expected" },
    artifacts: [
      { role: "input", classification: "author-private", name: "0.input", size: 12, originalSize: 12, sha256: "a".repeat(64), preview: "private-file", binary: false, stored: true }
    ]
  };
  const g = fixture({ state: jobState({ stdCode: `${program("std")} // synthetic-llm-secret` }), runs: [mismatch] });
  g.request.stdCode = g.job.state.stdCode;
  const prompts = await withModel(program("std fixed"), async () => {
    await g.run().catch(() => undefined);
  });
  assert.equal(prompts.length, 1);
  for (const secret of ["synthetic-llm-secret", "synthetic-search-secret", "private-file", "private-actual", "private-expected"])
    assert(!prompts[0].includes(secret), secret);
  assert.match(prompts[0], /REDACTED/);
});

test("a plain retry runs the same programs again; regenerating writes them all again; the counts are kept", () => {
  const f = fixture();
  const failed = {
    ...f.job,
    status: "failed",
    error: "SANDBOX_GENERATION_FAILED: alternative compilation failed",
    state: {
      ...jobState(),
      generated: { count: 5 },
      repair: {
        version: 1,
        automatic: 3,
        infrastructure: 2,
        revisions: [{ role: "make" }],
        review: { reason: "REPAIR_LIMIT", roles: ["quality-alt-0"], observationId: "o", kind: "compile_error", at: "" }
      }
    }
  };
  const plain = f.svc.retryState(failed);
  for (const field of ["makeCode", "stdCode", "validatorCode", "qualityArtifacts", "qualityPlan", "plan"])
    assert.deepEqual(plain[field], failed.state[field], field);
  assert.equal(plain.generated, undefined);
  assert.deepEqual({ ...plain.repair }, { version: 1, automatic: 3, infrastructure: 0, revisions: [{ role: "make" }] });
  assert.equal(failed.state.repair.review.reason, "REPAIR_LIMIT", "the job's own state isn't changed");
  const regenerated = f.svc.retryState(failed, "regenerate");
  for (const field of ["makeCode", "stdCode", "validatorCode", "qualityArtifacts", "qualityPlan"])
    assert.equal(regenerated[field], undefined, field);
  assert.deepEqual(regenerated.plan, failed.state.plan);
  assert.equal(regenerated.repair.automatic, 3, "writing the programs again doesn't reset the job's repairs");
  // Without a review there's nothing to choose from
  assert.throws(() => f.svc.retryState({ ...failed, state: jobState() }, "regenerate"), /INVALID_RETRY_MODE/);
  assert.throws(() => f.svc.retryState({ ...failed, state: jobState() }, "repair", "std"), /INVALID_RETRY_MODE/);
});
