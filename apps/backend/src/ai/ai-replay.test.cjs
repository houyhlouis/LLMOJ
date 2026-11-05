/* Credential-free tests of replays of kept failures (review Part III, H01/W03). */
// A failure is replayed with the exact bytes kept with it and the same check, by the job's owner, one replay at a time;
// what it runs is decided from what the failure records, and its runs say whether it reproduced.
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
String.prototype.format ||= function format(...args) {
  return require("node:util").format(String(this), ...args);
};
require("@nestjs/common").Logger.overrideLogger(false);
const protocol = require("@libreoj/judge-protocol");
const { replayPlan, jobProgram, replayRevision } = require("./ai-replay.ts");
const { AiReplayService } = require("./ai-replay.service.ts");
const { AiError } = require("./ai.types.ts");
const { bareAiServices } = require("./ai-test-services.cjs");

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const artifact = (role, data = "x", overrides = {}) => ({
  name: `0.${role}`,
  role,
  classification: "hidden-test",
  size: Buffer.byteLength(data),
  originalSize: Buffer.byteLength(data),
  sha256: sha256(data),
  preview: "",
  binary: false,
  stored: true,
  ...overrides
});
const observation = (overrides = {}) => ({
  kind: "solver_disagreement",
  fatal: true,
  phase: "quality-differential",
  role: "std",
  expectedBasis: "candidate_oracle",
  subtask: 1,
  scenarioIndex: 12,
  summary: "standard differential case 3: Output mismatch",
  artifacts: [artifact("input"), artifact("actual"), artifact("expected")],
  origin: "judge",
  operation: "generate",
  attemptId: crypto.randomUUID(),
  ...overrides
});
const traditional = { customChecker: false, protocol: false };

test("what a failure's replay runs, from what the failure records", () => {
  const plan = (overrides, options = traditional) => replayPlan(observation(overrides), options);
  assert.deepEqual(plan({}), {
    plan: {
      check: "compare",
      role: "std",
      against: "quality-oracle",
      artifacts: ["input"],
      programs: ["std", "quality-oracle"],
      repeat: 3
    }
  });
  assert.deepEqual(plan({}, { ...traditional, customChecker: true }).plan.programs, ["std", "quality-oracle", "checker"]);
  assert.deepEqual(plan({ role: "quality-oracle" }).plan, {
    check: "compare",
    role: "quality-oracle",
    against: "self",
    artifacts: ["input"],
    programs: ["quality-oracle"],
    repeat: 3
  });
  assert.equal(plan({ role: "quality-alt-1", expectedBasis: "reference_output" }).plan.against, "std");
  assert.equal(plan({ role: "std", expectedBasis: "reference_output" }).plan.against, "self");
  assert.deepEqual(plan({ expectedBasis: "official_sample", subtask: undefined, subject: "sample 2" }).plan, {
    check: "compare",
    role: "std",
    against: "expected",
    artifacts: ["input", "expected"],
    programs: ["std"],
    repeat: 3
  });
  assert.deepEqual(plan({ kind: "compile_error", role: "quality-alt-0", artifacts: [artifact("diagnostics")] }).plan, {
    check: "compile",
    role: "quality-alt-0",
    artifacts: [],
    programs: ["quality-alt-0"],
    repeat: 1
  });
  assert.deepEqual(plan({ kind: "validator_rejection", role: "validator", phase: "generate" }).plan, {
    check: "validate",
    role: "validator",
    subtask: 1,
    caseIndex: 12,
    artifacts: ["input"],
    programs: ["validator"],
    repeat: 3
  });
  // A sample's input is validated as subtask 0, by its number
  const sample = plan({ kind: "validator_rejection", role: "validator", subtask: undefined, scenarioIndex: undefined, subject: "sample 3" });
  assert.deepEqual([sample.plan.subtask, sample.plan.caseIndex], [0, 3]);
  assert.deepEqual(plan({ kind: "time_limit", role: "quality-challenge-1" }).plan, {
    check: "run",
    role: "quality-challenge-1",
    artifacts: ["input"],
    programs: ["quality-challenge-1"],
    repeat: 3
  });
  assert.deepEqual(plan({ kind: "runtime_error", role: "make", artifacts: [artifact("diagnostics")] }).plan, {
    check: "generate",
    role: "make",
    subtask: 1,
    caseIndex: 12,
    artifacts: [],
    programs: ["make"],
    repeat: 3
  });
  // A checker that accepted the run's malformed output must reject it; one that crashed must give a verdict
  const malformed = artifact("actual", protocol.AI_MALFORMED_OUTPUT);
  const accepted = plan({ kind: "checker_failure", role: "checker", artifacts: [artifact("input"), malformed, artifact("expected")] });
  assert.deepEqual(accepted.plan, {
    check: "checker",
    role: "checker",
    expect: "reject",
    artifacts: ["input", "actual", "expected"],
    programs: ["checker"],
    repeat: 3
  });
  assert.equal(plan({ kind: "checker_failure", role: "checker" }).plan.expect, "verdict");

  for (const [overrides, reason, options] of [
    [{ kind: "challenge_survived", role: "quality-challenge-0" }, "NOT_REPLAYABLE"],
    [{ kind: "infrastructure_error" }, "NOT_REPLAYABLE"],
    [{ kind: "budget_exhausted" }, "NOT_REPLAYABLE"],
    [{ kind: "compile_error", role: "grader" }, "NOT_REPLAYABLE"],
    [{ kind: "runtime_error", role: "interactor" }, "NOT_REPLAYABLE"],
    [{ role: undefined }, "NOT_REPLAYABLE"],
    [{ expectedBasis: undefined }, "NOT_REPLAYABLE"],
    [{ kind: "runtime_error", role: "make", scenarioIndex: undefined }, "NOT_REPLAYABLE"],
    [{ context: "tutorial-reference" }, "TUTORIAL_CODE"],
    [{ operation: "validate-reference" }, "TUTORIAL_CODE"],
    [{ artifacts: [artifact("input", "x", { stored: false, missing: "Expired" })] }, "EVIDENCE_MISSING"],
    [{ artifacts: [artifact("input", "x", { size: 1, originalSize: 2 })] }, "EVIDENCE_MISSING"],
    [{ expectedBasis: "official_sample", artifacts: [artifact("input")] }, "EVIDENCE_MISSING"],
    [{ kind: "checker_failure", role: "checker", artifacts: [artifact("input"), artifact("expected")] }, "EVIDENCE_MISSING"],
    [{}, "PROTOCOL", { ...traditional, protocol: true }]
  ])
    assert.deepEqual(plan(overrides, options), { unsupported: reason }, JSON.stringify(overrides));
  // Interactive and communication problems: compilations and input validation only
  assert.equal(plan({ kind: "compile_error", role: "interactor" }, { ...traditional, protocol: true }).plan.check, "compile");
  assert.equal(
    plan({ kind: "validator_rejection", role: "validator" }, { ...traditional, protocol: true }).plan.check,
    "validate"
  );
});

test("the job's programs as it has them now, and whether they're the ones that failed", () => {
  const state = {
    makeCode: "make",
    stdCode: "std",
    checkerCode: "checker",
    qualityArtifacts: {
      smallMakeCode: "small",
      oracleCode: "oracle",
      alternatives: [{ id: "dp", code: "alt" }],
      challenges: [{ id: "greedy", code: "challenge" }]
    }
  };
  assert.deepEqual(
    ["make", "std", "checker", "quality-small-make", "quality-oracle", "quality-alt-0", "quality-challenge-0"].map(role =>
      jobProgram(state, role)
    ),
    ["make", "std", "checker", "small", "oracle", "alt", "challenge"]
  );
  for (const role of ["validator", "quality-alt-1", "interactor"]) assert.equal(jobProgram(state, role), null);
  assert.equal(jobProgram({ stdCode: "  " }, "std"), null);
  const failed = { sourceHashes: { std: sha256("std"), "quality-oracle": sha256("oracle") } };
  assert.equal(replayRevision(failed, { std: "std", "quality-oracle": "oracle" }), "same");
  assert.equal(replayRevision(failed, { std: "std2", "quality-oracle": "oracle" }), "changed");
  assert.equal(replayRevision({}, { std: "std" }), "unknown");
});

// The replay service with stand-ins: its failure, the job's runs, Redis and the audit
function replayFixture({ job: jobChanges = {}, paused = false, run } = {}) {
  const row = {
    id: crypto.randomUUID(),
    jobId: "job",
    evidence: "stored",
    expiresAt: new Date(Date.now() + 60000),
    observation: observation({ sourceHashes: { std: sha256("std"), "quality-oracle": sha256("oracle") } })
  };
  const job = {
    id: "job",
    ownerId: 1,
    status: "failed",
    state: { plan: { needsSpj: false }, stdCode: "std", qualityArtifacts: { oracleCode: "oracle" } },
    ...jobChanges
  };
  const replays = [];
  const locks = new Map();
  const audits = [];
  const sent = [];
  const evidence = {
    observation: async (_job, id) => {
      if (id !== row.id) throw new AiError("NO_SUCH_OBSERVATION");
      return row;
    },
    addReplay: async (_id, record) => replays.push(record),
    updateReplay: async (_id, replayId, changes) =>
      Object.assign(
        replays.find(record => record.id === replayId),
        changes
      )
  };
  const workflow = {
    replayRequest: async (_job, _problem, plan, digest) => ({
      programs: Object.fromEntries(plan.programs.map(role => [role, jobProgram(job.state, role)])),
      profiles: digest ? "same" : "unknown",
      request: { operation: "replay", jobId: job.id, profiles: { version: 1, roles: {} }, replay: { ...plan } }
    })
  };
  const execution = {
    replay: async (...args) => {
      sent.push(args);
      return run ? await run(...args) : undefined;
    }
  };
  const redis = {
    takeTurn: async key => (locks.has(key) ? false : (locks.set(key, true), true)),
    cacheGet: async key => (locks.has(key) ? "1" : null),
    cacheDelete: async key => locks.delete(key)
  };
  const coordinator = {
    policy: async () => ({ paused }),
    recordAiAudit: async (...args) => audits.push(args)
  };
  const service = new AiReplayService(coordinator, evidence, execution, workflow, redis);
  return { service, row, job, replays, locks, audits, sent };
}

const record = {
  contract: protocol.AI_EXECUTION_PROTOCOL_VERSION,
  attemptId: crypto.randomUUID(),
  runtime: { judgeProgram: "a".repeat(64), sandboxImage: "bbe9c69b2027", arch: "x64" },
  startedAt: "2026-11-04T10:00:00.000Z",
  finishedAt: "2026-11-04T10:00:01.000Z",
  reuse: { builds: 2, inputs: 0 }
};
const until = async condition => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert(condition());
};

test("a replay sends the failure's kept bytes, runs in the background, and is kept with its outcome", async () => {
  const runs = [1, 2, 3].map(() => ({ outcome: "failed", kind: "solver_disagreement", verdict: "WA", summary: "differ" }));
  const f = replayFixture({
    run: async (_job, request) => ({
      type: "complete",
      replay: { runs },
      validation: { profiles: protocol.aiContractDigest(request.profiles) },
      execution: record,
      operation: { key: "k", origin: "judge", result: "new" }
    })
  });
  const problem = { id: 1, type: "Traditional" };
  const started = await f.service.start({ id: 1 }, f.job, problem, f.row.id);
  assert.deepEqual(
    [started.status, started.check, started.revision, started.profiles, started.userId],
    ["running", "compare", "same", "unknown", 1]
  );
  assert(await f.service.running("job"), "the job isn't retried meanwhile");
  await until(() => f.replays[0].status !== "running" && !f.locks.size);
  assert.equal(await f.service.running("job"), false);
  assert.deepEqual(f.replays[0].runs, runs);
  assert.deepEqual([f.replays[0].status, f.replays[0].origin, f.replays[0].runtime], ["reproduced", "judge", record.runtime]);
  const [[, , transfers]] = f.sent;
  assert.deepEqual(transfers, [
    {
      name: "replay.input",
      object: `temporary/ai-evidence/${f.row.id}/input`,
      size: f.row.observation.artifacts[0].size,
      sha256: f.row.observation.artifacts[0].sha256
    }
  ]);
  assert.deepEqual(f.audits.map(([user, action, job, details]) => [user.id, action, job.id, details.check]), [
    [1, "evidence.replay", "job", "compare"]
  ]);
});

test("a replay is refused while its job runs, while AI is paused, while another runs, and when it can't be one", async () => {
  const problem = { id: 1, type: "Traditional" };
  for (const status of ["queued", "running"])
    await assert.rejects(replayFixture({ job: { status } }).service.start({ id: 1 }, replayFixture({ job: { status } }).job, problem, "x"), /AI_JOB_ACTIVE/);
  let f = replayFixture({ paused: true });
  await assert.rejects(f.service.start({ id: 1 }, f.job, problem, f.row.id), /AI_PAUSED/);
  f = replayFixture();
  await assert.rejects(f.service.start({ id: 1 }, f.job, problem, "unknown"), /NO_SUCH_OBSERVATION/);
  await assert.rejects(f.service.start({ id: 1 }, f.job, null, f.row.id), /AI_REPLAY_UNSUPPORTED: NO_PROBLEM/);
  await assert.rejects(f.service.start({ id: 1 }, f.job, { type: "Interaction" }, f.row.id), /AI_REPLAY_UNSUPPORTED: PROTOCOL/);
  f.row.expiresAt = new Date(Date.now() - 1);
  await assert.rejects(f.service.start({ id: 1 }, f.job, problem, f.row.id), /EVIDENCE_MISSING/);
  // One at a time, for the job and for its owner
  f = replayFixture({ run: () => new Promise(() => {}) });
  await f.service.start({ id: 1 }, f.job, problem, f.row.id);
  await assert.rejects(f.service.start({ id: 1 }, f.job, problem, f.row.id), /AI_REPLAY_BUSY/);
  f.locks.delete("ai-replay:job:job");
  await assert.rejects(f.service.start({ id: 1 }, f.job, problem, f.row.id), /AI_REPLAY_BUSY/);
  assert.equal(f.locks.has("ai-replay:job:job"), false, "the job's lock is released when the owner's isn't free");
});

test("a replay that fails itself is kept as failed, and one its backend stopped running as interrupted", async () => {
  const problem = { id: 1, type: "Traditional" };
  for (const [run, error] of [
    [async () => {
      throw new AiError("SANDBOX_UNAVAILABLE");
    }, "SANDBOX_UNAVAILABLE"],
    // A runner that doesn't report the profiles, its record or its runs
    [async () => ({ type: "complete", replay: { runs: [] }, validation: {}, execution: record }), "INVALID_SANDBOX_RESPONSE"]
  ]) {
    const f = replayFixture({ run });
    await f.service.start({ id: 1 }, f.job, problem, f.row.id);
    await until(() => f.replays[0].status !== "running");
    assert.deepEqual([f.replays[0].status, f.replays[0].error], ["failed", error]);
    assert(f.replays[0].finishedAt);
  }
  const f = replayFixture();
  const stale = { id: "r", status: "running", startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() };
  const fresh = { ...stale, id: "s", startedAt: new Date().toISOString() };
  const [annotated] = f.service.annotate(f.job, "Traditional", [
    { ...f.row.observation, id: f.row.id, expiresAt: f.row.expiresAt, evidence: "stored", replays: [stale, fresh] }
  ]);
  assert.deepEqual(
    annotated.replays.map(item => [item.id, item.status, item.error]),
    [
      ["r", "failed", "REPLAY_INTERRUPTED"],
      ["s", "running", undefined]
    ]
  );
  assert.deepEqual(annotated.replay, { available: true });
});

test("each failure says whether it can be replayed now, and why not", () => {
  const f = replayFixture();
  const view = (overrides = {}) => ({
    ...f.row.observation,
    id: f.row.id,
    expiresAt: f.row.expiresAt,
    evidence: "stored",
    ...overrides
  });
  const availability = (failure, job = f.job, type = "Traditional") => f.service.annotate(job, type, [failure])[0].replay;
  assert.deepEqual(availability(view()), { available: true });
  assert.deepEqual(availability(view({ kind: "challenge_survived" })), { available: false, reason: "NOT_REPLAYABLE" });
  assert.deepEqual(availability(view({ evidence: "expired" })), { available: false, reason: "EVIDENCE_MISSING" });
  assert.deepEqual(availability(view(), { ...f.job, state: { plan: {}, stdCode: "std" } }), {
    available: false,
    reason: "PROGRAM_MISSING"
  });
  assert.deepEqual(availability(view(), { ...f.job, status: "running" }), { available: false, reason: "JOB_ACTIVE" });
  assert.deepEqual(availability(view(), f.job, null), { available: false, reason: "NO_PROBLEM" });
  assert.deepEqual(availability(view(), f.job, "Communication"), { available: false, reason: "PROTOCOL" });
});

test("a replay's request: the job's programs now, compared as its plan compares, with the problem's profiles now", async () => {
  const service = bareAiServices();
  service.services.workflow.publisher = { snapshot: async () => ({ judgeInfo: { timeLimit: 1000, memoryLimit: 256 } }) };
  const job = {
    id: "0f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f",
    state: {
      plan: { timeLimitMs: 1000, memoryLimitMiB: 256, needsSpj: true, outputComparison: "lines", caseSensitive: false },
      stdCode: "std",
      checkerCode: "checker",
      graderCode: "grader",
      qualityArtifacts: { oracleCode: "oracle" }
    }
  };
  const plan = replayPlan(observation(), { customChecker: true, protocol: false }).plan;
  const { request, programs, profiles } = await service.replayRequest(job, { id: 1, type: "Traditional" }, plan, "0".repeat(64));
  assert.deepEqual(programs, { std: "std", "quality-oracle": "oracle", checker: "checker" });
  assert.equal(profiles, "changed");
  assert.equal(protocol.aiReplayRequestError(request.replay), null);
  assert.deepEqual(request.replay, {
    check: "compare",
    role: "std",
    against: "quality-oracle",
    files: { input: "replay.input" },
    repeat: 3,
    programs
  });
  assert.deepEqual(request.checker, { type: "lines", caseSensitive: false });
  assert.equal(request.graderCode, undefined, "a grader only for a communication problem");
  assert.equal(request.profiles.roles.checker.origin, "ai");
  assert.deepEqual(request.cases, []);
  const same = await service.replayRequest(job, { id: 1, type: "Traditional" }, plan, protocol.aiContractDigest(request.profiles));
  assert.equal(same.profiles, "same");
  await assert.rejects(
    service.replayRequest({ ...job, state: { ...job.state, qualityArtifacts: {} } }, { type: "Traditional" }, plan),
    /AI_REPLAY_UNSUPPORTED: PROGRAM_MISSING/
  );
});
