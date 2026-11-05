/* Credential-free tests of how AI run failures are routed to repairs (review Part III, H02/W04). */
// A typed failure is routed to running the same programs again, to replacing the one AI-written program the evidence
// blames, or to stopping for the owner; the job's limits and its history of repairs bound it.
const { test } = require("node:test");
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
  AI_REPAIR_LIMITS,
  aiWrittenProgram,
  decideAiRepair,
  failureContext,
  failureSignature,
  generationRevision,
  repairState,
  routeAiFailure,
  routedFailure,
  setJobProgram,
  syncRequestPrograms
} = require("./ai-repair.ts");
const { AiError } = require("./ai.types.ts");

const state = (extra = {}) => ({
  plan: { needsSpj: false },
  makeCode: "make",
  stdCode: "std",
  validatorCode: "validator",
  checkerCode: "checker",
  referenceSource: { kind: "model" },
  qualityArtifacts: {
    version: 1,
    smallMakeCode: "small",
    oracleCode: "oracle",
    alternatives: [{ id: "independent", code: "alt" }],
    challenges: [{ id: "greedy", code: "challenge", kind: "wrong", subtasks: [1] }]
  },
  problemHelpers: [],
  ...extra
});
const context = (jobState = state(), overrides = {}) => ({
  aiWritten: role => aiWrittenProgram(jobState, role),
  tutorialReference: jobState.referenceSource?.kind === "tutorial",
  customChecker: !!jobState.plan?.needsSpj,
  ...overrides
});
const route = (failure, jobState) => routeAiFailure({ phase: "", ...failure }, context(jobState));

test("each kind of failure goes to the program the evidence blames, and only that one", () => {
  const cases = [
    [{ kind: "compile_error", role: "quality-alt-0", phase: "compile-quality-alt-0" }, "quality-alt-0"],
    [{ kind: "compile_error", role: "validator", phase: "compile-validator" }, "validator"],
    // An official sample is legal: the validator is wrong
    [{ kind: "validator_rejection", role: "validator", phase: "validate-samples", subject: "sample 2" }, "validator"],
    // A generated input is the generator's: the validator is never loosened to accept it
    [{ kind: "validator_rejection", role: "validator", phase: "generate", subtask: 2, scenarioIndex: 5 }, "make"],
    [{ kind: "validator_rejection", role: "validator", phase: "quality-search", subtask: 1, scenarioIndex: 40 }, "make"],
    [
      { kind: "validator_rejection", role: "validator", phase: "quality-differential", subtask: 1, scenarioIndex: 3 },
      "quality-small-make"
    ],
    [{ kind: "solver_disagreement", role: "std", expectedBasis: "official_sample", subject: "sample 1" }, "std"],
    [{ kind: "runtime_error", role: "make", subtask: 1, scenarioIndex: 3 }, "make"],
    [{ kind: "output_limit", role: "quality-small-make", subtask: 1, scenarioIndex: 3 }, "quality-small-make"],
    [{ kind: "time_limit", role: "validator" }, "validator"],
    [{ kind: "runtime_error", role: "std" }, "std"],
    [{ kind: "checker_failure", role: "checker" }, "checker"],
    [{ kind: "invalid_challenge", role: "quality-challenge-0", candidate: "greedy" }, "quality-challenge-0"],
    [{ kind: "challenge_survived", role: "quality-challenge-0", search: { stoppedBy: "budget" } }, "make"]
  ];
  for (const [failure, role] of cases)
    assert.deepEqual(route(failure), { action: "repair", role }, JSON.stringify(failure));
  // A correct program too slow or too large is replayed before it's rewritten: once isn't proof
  assert.deepEqual(route({ kind: "time_limit", role: "std" }), { action: "repair", role: "std", confirm: true });
  assert.deepEqual(route({ kind: "memory_limit", role: "quality-alt-0" }), {
    action: "repair",
    role: "quality-alt-0",
    confirm: true
  });
});

test("the infrastructure is retried with the same programs; cancellation stops; no model is asked", () => {
  assert.deepEqual(route({ kind: "infrastructure_error" }), { action: "retry" });
  // A compiler that was killed left no diagnostic: not a program to rewrite
  assert.deepEqual(
    route({ kind: "compile_error", role: "make", execution: { status: "TimeLimitExceeded", termination: "signaled" } }),
    { action: "retry" }
  );
  assert.deepEqual(route({ kind: "canceled" }), { action: "stop" });
  // Errors the backend observes itself
  for (const code of ["SANDBOX_UNAVAILABLE", "SANDBOX_DISCONNECTED", "INVALID_SANDBOX_RESPONSE"])
    assert.deepEqual(routedFailure(new AiError(code)), { kind: "infrastructure_error", phase: "" });
  assert.equal(routedFailure(new AiError("SANDBOX_TIMEOUT")).kind, "budget_exhausted");
  // Not a run's failure
  for (const error of [new AiError("JOB_CANCELLED"), new AiError("PERMISSION_DENIED"), new Error("x")])
    assert.equal(routedFailure(error), null);
  const typed = new AiError("SANDBOX_GENERATION_FAILED", "x");
  typed.failure = { kind: "compile_error", role: "make", phase: "compile-make" };
  assert.equal(routedFailure(typed), typed.failure);
});

test("a disagreement nothing trusted settles stops for the owner, with the programs involved", () => {
  // The standard and the oracle: never decided by replacing whichever is called the standard
  assert.deepEqual(route({ kind: "solver_disagreement", role: "std", expectedBasis: "candidate_oracle" }), {
    action: "review",
    reason: "ATTRIBUTION",
    roles: ["std", "quality-oracle"]
  });
  assert.deepEqual(route({ kind: "solver_disagreement", role: "quality-alt-0", expectedBasis: "reference_output" }), {
    action: "review",
    reason: "ATTRIBUTION",
    roles: ["quality-alt-0", "std"]
  });
  // With a custom checker, an official sample's mismatch may be the checker's
  const spj = state({ plan: { needsSpj: true } });
  assert.deepEqual(route({ kind: "solver_disagreement", role: "std", expectedBasis: "official_sample" }, spj), {
    action: "review",
    reason: "ATTRIBUTION",
    roles: ["std", "checker"]
  });
  // A problem's own checker is never offered for repair
  const problemChecker = state({ plan: { needsSpj: true }, problemHelpers: ["checker"] });
  assert.deepEqual(
    route({ kind: "solver_disagreement", role: "std", expectedBasis: "official_sample" }, problemChecker).roles,
    ["std"]
  );
});

test("the problem's own helpers and a tutorial's solution are never repaired by the job itself", () => {
  const problemChecker = state({ plan: { needsSpj: true }, problemHelpers: ["checker"] });
  for (const failure of [
    { kind: "compile_error", role: "checker", phase: "compile-checker" },
    { kind: "checker_failure", role: "checker" },
    { kind: "runtime_error", role: "checker" }
  ])
    assert.deepEqual(route(failure, problemChecker), { action: "review", reason: "PROBLEM_HELPER", roles: [] });
  const interactor = { ...state(), interactorCode: "official", problemHelpers: ["interactor"] };
  assert.equal(route({ kind: "runtime_error", role: "interactor" }, interactor).reason, "PROBLEM_HELPER");
  const tutorial = state({ referenceSource: { kind: "tutorial", discussionId: 3 } });
  assert.deepEqual(route({ kind: "runtime_error", role: "std" }, tutorial), {
    action: "review",
    reason: "TUTORIAL_REFERENCE",
    roles: ["std"]
  });
  // The owner may still choose it
  assert.equal(aiWrittenProgram(tutorial, "std"), false);
  assert.equal(aiWrittenProgram(tutorial, "std", { tutorial: true }), true);
  assert.equal(aiWrittenProgram(problemChecker, "checker", { tutorial: true }), false);
  assert.equal(aiWrittenProgram(state(), "quality-alt-1"), false, "a program the job doesn't have");
  assert.equal(aiWrittenProgram(state(), "../std"), false);
});

test("capacity, budget and untyped failures stop for the owner", () => {
  assert.deepEqual(route({ kind: "insufficient_case_capacity" }), { action: "review", reason: "CAPACITY", roles: [] });
  assert.deepEqual(route({ kind: "challenge_survived", role: "quality-challenge-0", search: { stoppedBy: "capacity" } }), {
    action: "review",
    reason: "CAPACITY",
    roles: []
  });
  assert.deepEqual(route({ kind: "budget_exhausted" }), { action: "review", reason: "BUDGET", roles: [] });
  for (const failure of [{ kind: "unclassified" }, { kind: "compile_error", role: "grader" }])
    assert.equal(route(failure).reason, "UNCLASSIFIED");
});

test("limits: automatic repairs, all repairs and infrastructure retries; and a repair that changed nothing", () => {
  const jobState = state();
  const repairs = repairState(jobState);
  const failure = { kind: "compile_error", role: "quality-alt-0", phase: "compile-quality-alt-0" };
  assert.deepEqual(decideAiRepair(failure, context(jobState), repairs), { action: "repair", role: "quality-alt-0" });
  // The repair failed the same way: not again
  repairs.revisions.push({ role: "quality-alt-0", signature: failureSignature(failure), failure: {} });
  assert.deepEqual(decideAiRepair(failure, context(jobState), repairs), {
    action: "review",
    reason: "UNCHANGED",
    roles: ["quality-alt-0"]
  });
  // Another failure of it is another repair, while the job has repairs left
  const other = { kind: "solver_disagreement", role: "quality-alt-0", expectedBasis: "official_sample", subject: "sample 1" };
  assert.equal(decideAiRepair(other, context(jobState), repairs).action, "repair");
  repairs.automatic = AI_REPAIR_LIMITS.automatic;
  assert.deepEqual(decideAiRepair(other, context(jobState), repairs), {
    action: "review",
    reason: "REPAIR_LIMIT",
    roles: ["quality-alt-0"]
  });
  repairs.automatic = 0;
  repairs.revisions = Array.from({ length: AI_REPAIR_LIMITS.total }, () => ({ role: "make", signature: "x" }));
  assert.deepEqual(decideAiRepair(other, context(jobState), repairs), { action: "review", reason: "REPAIR_LIMIT", roles: [] });
  repairs.infrastructure = AI_REPAIR_LIMITS.infrastructure;
  assert.deepEqual(decideAiRepair({ kind: "infrastructure_error", phase: "" }, context(jobState), repairs), {
    action: "review",
    reason: "INFRASTRUCTURE",
    roles: []
  });
  // The owner may decide the validator is the wrong one, when the generator's repair didn't help
  const rejected = { kind: "validator_rejection", role: "validator", phase: "generate", subtask: 1, scenarioIndex: 4 };
  const again = repairState(state());
  again.revisions.push({ role: "make", signature: failureSignature(rejected) });
  assert.deepEqual(decideAiRepair(rejected, context(jobState), again).roles, ["make", "validator"]);
  // A job from before repairs were counted here counts the generator repair it made
  assert.equal(repairState({ makeCompileRepairAttempts: 1 }).automatic, 1);
});

test("a failure's signature ignores its bytes but not what failed where", () => {
  const base = { kind: "validator_rejection", role: "validator", phase: "generate", subtask: 1, scenarioIndex: 4 };
  assert.equal(failureSignature(base), failureSignature({ ...base, summary: "another input", artifacts: [1] }));
  for (const changed of [{ scenarioIndex: 5 }, { subtask: 2 }, { kind: "runtime_error" }, { phase: "quality-search" }])
    assert.notEqual(failureSignature({ ...base, ...changed }), failureSignature(base), JSON.stringify(changed));
  assert.notEqual(
    failureSignature({ kind: "solver_disagreement", role: "std", phase: "validate-samples", subject: "sample 1" }),
    failureSignature({ kind: "solver_disagreement", role: "std", phase: "validate-samples", subject: "sample 2" })
  );
});

test("a repair replaces one program of the state and of the request, and nothing else", () => {
  const jobState = state();
  const request = {
    makeCode: "make",
    stdCode: "std",
    validatorCode: "validator",
    checkerCode: "checker",
    cases: [{ subtask: 1, seed: 1 }],
    timeLimitMs: 1000,
    quality: {
      version: 1,
      smallMakeCode: "small",
      oracleCode: "oracle",
      alternatives: [{ id: "independent", code: "alt" }],
      challenges: [{ id: "greedy", code: "challenge", kind: "wrong", subtasks: [1] }],
      fuzzCases: [{ subtask: 1, seed: 1 }],
      extraAttempts: 16
    }
  };
  const before = generationRevision(request, jobState);
  for (const [role, source] of [
    ["quality-alt-0", "alt 2"],
    ["quality-challenge-0", "challenge 2"],
    ["quality-oracle", "oracle 2"],
    ["std", "std 2"]
  ]) {
    const next = structuredClone(request);
    const nextState = structuredClone(jobState);
    setJobProgram(nextState, role, source);
    syncRequestPrograms(next, nextState);
    const after = generationRevision(next, nextState);
    const changed = Object.keys(before.sources).filter(name => before.sources[name] !== after.sources[name]);
    assert.deepEqual(changed, [role]);
    assert.notEqual(after.digest, before.digest);
    // The cases, the limits and the challenge's target stay as they are
    assert.deepEqual(next.cases, request.cases);
    assert.equal(next.timeLimitMs, request.timeLimitMs);
    assert.deepEqual(
      next.quality.challenges.map(({ code, ...rest }) => rest),
      request.quality.challenges.map(({ code, ...rest }) => rest)
    );
  }
  // A request without a checker doesn't get one
  const plain = { makeCode: "make", stdCode: "std", validatorCode: "validator" };
  syncRequestPrograms(plain, jobState);
  assert.equal("checkerCode" in plain, false);
});

test("the model is never sent the bytes of the problem's own sample files", () => {
  const artifact = (role, classification, preview) => ({
    role,
    classification,
    preview,
    size: preview.length,
    originalSize: preview.length,
    stored: true
  });
  const own = {
    kind: "solver_disagreement",
    phase: "validate-samples",
    role: "std",
    subject: "sample 2",
    summary: "Output mismatch: 2 secret-sample-output",
    difference: { unit: "token", index: 3, actual: "secret-actual", expected: "secret-expected" },
    artifacts: [artifact("input", "author-private", "secret-input"), artifact("expected", "author-private", "secret-out")]
  };
  const text = JSON.stringify(failureContext(own, "secret diagnostics"));
  for (const secret of ["secret-input", "secret-out", "secret-actual", "secret-expected", "secret diagnostics", "secret-sample"])
    assert(!text.includes(secret), secret);
  assert.match(text, /isn't shared/);
  // A statement sample and what the job's programs made are shown, bounded
  const generated = {
    ...own,
    phase: "generate",
    subject: "case 3",
    artifacts: [artifact("input", "hidden-test", "3\n1 2 3\n"), artifact("diagnostics", "author-private", "boom")]
  };
  const shown = failureContext(generated, "boom");
  assert.equal(shown.diagnostics, "boom");
  assert.deepEqual(shown.artifacts[0], { role: "input", size: 8, preview: "3\n1 2 3\n", truncated: false });
  assert.equal(shown.difference.actual, "secret-actual");
});
