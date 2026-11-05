/* Run: node --test apps/judge/src/aiEvidence.test.cjs (after building packages/judge-protocol) */
// A failed AI run keeps its evidence before the runner cleans up (review Part III, W01): typed observations from the
// quality checks, the exact bytes within limits, and what the backend accepts of what a judge sends.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText,
    filename
  );
const { describe, detailsOf, within } = require("./aiFailure.ts");
const { keepFailure, pinEvidence, profileOf, sourceHashesOf, FAILURE_FILE } = require("./aiEvidence.ts");
const { AiQuality } = require("./aiQuality.ts");
const {
  AI_EVIDENCE_LIMITS,
  firstDifference,
  parseAiRunFailure,
  textPreview
} = require("@libreoj/judge-protocol");

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const attemptId = "dddddddd-0000-4000-8000-000000000001";

function options(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-ai-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shared = [];
  return {
    root,
    shared,
    options: {
      directory: path.join(root, "job", "failure"),
      share: async filename => shared.push(path.relative(root, filename)),
      attemptId,
      operation: "generate",
      sourceHashes: sourceHashesOf([["std", "int main(){}"], ["checker", undefined]], { "x.h": "#pragma once" }),
      profile: profileOf(
        {
          auxiliary: { timeLimitMs: 5000, memoryLimitMiB: 512 },
          solution: { timeLimitMs: 1000, memoryLimitMiB: 256 },
          oracle: { timeLimitMs: 5000, memoryLimitMiB: 512 }
        },
        "g++ -std=c++17 -O2",
        "tokens"
      ),
      comparison: { type: "tokens", caseSensitive: true },
      measures: new Map([["std", { status: "OK", exitCode: 0, timeMs: 3.5, memoryBytes: 1048576 }]]),
      ...overrides
    }
  };
}

const rejected = verdict => Object.assign(new Error(verdict), { qualityVerdict: verdict });

test("a failure keeps its exact bytes, a preview, where outputs differ and the program's run", async t => {
  const { root, shared, options: o } = options(t);
  const sample = path.join(root, "sample.in");
  fs.writeFileSync(sample, "3\n1 2 3\n");
  const error = describe(new Error("Output mismatch: sample 1"), {
    kind: "solver_disagreement",
    verdict: "WA",
    subject: "sample 1",
    data: { input: { path: sample }, actual: Buffer.from("6\r\n"), expected: Buffer.from("7\n") }
  });
  await within({ phase: "validate-samples", role: "std", classification: "public", expectedBasis: "official_sample" }, async () => {
    throw error;
  }).catch(() => {});
  const failure = await keepFailure(error, "compile-std", o);
  assert.equal(parseAiRunFailure(JSON.parse(JSON.stringify(failure))) !== null, true, "the backend accepts it");
  assert.deepEqual(failure.sourceHashes, { std: sha256("int main(){}"), "file:x.h": sha256("#pragma once") });
  const [observation] = failure.observations;
  assert.equal(observation.kind, "solver_disagreement");
  assert.equal(observation.fatal, true);
  assert.equal(observation.phase, "validate-samples", "the place that knew says, not the last progress");
  assert.equal(observation.role, "std");
  assert.equal(observation.expectedBasis, "official_sample");
  assert.deepEqual(observation.execution, { status: "OK", exitCode: 0, timeMs: 3.5, memoryBytes: 1048576 });
  assert.deepEqual(observation.difference, { unit: "token", index: 1, actualLine: 1, expectedLine: 1, actual: "6", expected: "7" });
  assert.deepEqual(
    observation.artifacts.map(({ name, role, classification, size, sha256: hash }) => [name, role, classification, size, hash]),
    [
      ["0.input", "input", "public", 8, sha256("3\n1 2 3\n")],
      ["0.actual", "actual", "public", 3, sha256("6\r\n")],
      ["0.expected", "expected", "public", 2, sha256("7\n")]
    ]
  );
  assert.equal(observation.artifacts[1].preview, "6\\r\n", "a CR is visible");
  for (const artifact of observation.artifacts)
    assert.equal(sha256(fs.readFileSync(path.join(o.directory, artifact.name))), artifact.sha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(o.directory, FAILURE_FILE))), JSON.parse(JSON.stringify(failure)));
  assert.deepEqual(shared.sort(), ["job", "job/failure", "job/failure/0.actual", "job/failure/0.expected", "job/failure/0.input", "job/failure/failure.json"].sort());
});

test("evidence is bounded: a large artifact keeps its start, and the run's budget is shared", async t => {
  const { options: o } = options(t);
  const big = Buffer.alloc(AI_EVIDENCE_LIMITS.artifactBytes + 10, 65);
  const error = describe(new Error("Output mismatch"), {
    kind: "solver_disagreement",
    data: { input: big, actual: big, expected: big, diagnostics: big }
  });
  const failure = await keepFailure(error, "generate", o);
  const sizes = failure.observations[0].artifacts.map(artifact => [artifact.size, artifact.originalSize]);
  assert.deepEqual(sizes, [
    [AI_EVIDENCE_LIMITS.artifactBytes, big.length],
    [AI_EVIDENCE_LIMITS.artifactBytes, big.length],
    [AI_EVIDENCE_LIMITS.artifactBytes, big.length],
    [AI_EVIDENCE_LIMITS.runBytes - 3 * AI_EVIDENCE_LIMITS.artifactBytes, big.length]
  ]);
  assert.match(failure.observations[0].evidenceError, /Only the start/);
  assert.notEqual(parseAiRunFailure(JSON.parse(JSON.stringify(failure))), null);
});

test("a canceled run keeps nothing, and the runner's own failures are typed by what they say", async t => {
  const { options: o } = options(t);
  let failure = await keepFailure(describe(new Error("Generation canceled"), { data: { input: Buffer.from("1") } }), "generate", o);
  assert.equal(failure.observations[0].kind, "canceled");
  assert.deepEqual(failure.observations[0].artifacts, []);
  assert.equal(fs.existsSync(o.directory), false, "nothing written");
  failure = await keepFailure(new Error("Generation exceeded its 9-minute execution budget"), "generate", o);
  assert.equal(failure.observations[0].kind, "budget_exhausted");
  failure = await keepFailure(new Error("Generated data exceeds the 16 MiB/file or 8 GiB/job limit"), "generate", o);
  assert.deepEqual([failure.observations[0].kind, failure.observations[0].role], ["output_limit", "make"]);
  failure = await keepFailure(new Error("Insufficient disk space: generation reserves 2 GiB for the server"), "generate", o);
  assert.equal(failure.observations[0].kind, "infrastructure_error");
  const diagnostics = Buffer.from("\u001b[01;31m\u001b[Kerror: \u001b[m\u001b[Kexpected ';'");
  failure = await keepFailure(describe(new Error("make compilation failed"), { kind: "compile_error", role: "make", data: { diagnostics } }), "compile-make", o);
  const [kept] = failure.observations[0].artifacts;
  assert.deepEqual([kept.preview, kept.size, kept.sha256], ["error: expected ';'", diagnostics.length, sha256(diagnostics)], "previewed plain, kept as it was");
});

test("evidence in a directory about to be removed is read into memory first", async t => {
  const { root, options: o } = options(t);
  const temporary = path.join(root, "quality-sample-1");
  fs.mkdirSync(temporary);
  fs.writeFileSync(path.join(temporary, "output"), "wrong\n");
  const error = describe(new Error("mismatch"), { kind: "solver_disagreement", data: { actual: { path: path.join(temporary, "output") } } });
  await pinEvidence(error, temporary);
  fs.rmSync(temporary, { recursive: true });
  const failure = await keepFailure(error, "validate-samples", o);
  assert.equal(failure.observations[0].artifacts[0].sha256, sha256("wrong\n"));
});

// The quality checks' failures, as the runner gets them

const request = (overrides = {}) => ({
  version: 1,
  fuzzCases: Array.from({ length: 64 }, (_, index) => ({ subtask: 1, seed: index })),
  smallMakeCode: "small-generator",
  oracleCode: "bruteforce",
  alternatives: [{ id: "alternative", code: "alternative-source" }],
  challenges: [{ id: "off-by-one", code: "challenge-source", kind: "wrong", subtasks: [1], reason: "boundary failure" }],
  extraAttempts: 16,
  ...overrides
});
const fake = (overrides = {}) => ({
  execute: async (name, input, parameters) => {
    if (name === "quality-small-make") return Buffer.from(String((Number(parameters[1]) % 4) + 1));
    return Buffer.from(String(Number(input.toString()) * 2));
  },
  validate: async () => {},
  compare: async (input, actual, expected) => {
    if (!actual.equals(expected)) throw rejected("WA");
  },
  checkCanceled: () => {},
  progress: () => {},
  customChecker: false,
  ...overrides
});

test("a standard that disagrees with the oracle names the program, the case and what it was compared with", async () => {
  const environment = fake();
  const execute = environment.execute;
  environment.execute = async (name, input, parameters) =>
    name === "std" && input.toString() === "3" ? Buffer.from("7") : execute(name, input, parameters);
  const error = await new AiQuality(request(), environment).runDifferential().catch(e => e);
  const details = detailsOf(error);
  assert.deepEqual(
    [details.phase, details.role, details.subject, details.subtask, details.scenarioIndex, details.expectedBasis],
    ["quality-differential", "std", "differential case 3", 1, 2, "candidate_oracle"]
  );
  assert.deepEqual([details.data.input.toString(), details.data.expected.toString()], ["3", "6"]);
});

test("a checker that accepts malformed output is the checker's failure, with the output it accepted", async () => {
  const error = await new AiQuality(request(), fake({ customChecker: true, compare: async () => {} }))
    .runDifferential()
    .catch(e => e);
  const details = detailsOf(error);
  assert.deepEqual([details.kind, details.role], ["checker_failure", "checker"]);
  assert.match(details.data.actual.toString("latin1"), /LLMOJ_INVALID_OUTPUT/);
});

test("a challenge that fails only an unexported small case survives with that counterexample as related evidence", async () => {
  // E04 of the review: a small legal failure is observed, then the challenge passes every exported case
  const environment = fake();
  const execute = environment.execute;
  environment.execute = async (name, input, parameters) =>
    name === "quality-challenge-0" && input.toString() === "1" ? Buffer.from("5") : execute(name, input, parameters);
  const quality = new AiQuality(request(), environment);
  await quality.runDifferential();
  const cases = Array.from({ length: 5 }, (_, index) => ({ subtask: 1, seed: index + 1 }));
  for (const [index] of cases.entries()) {
    const input = Buffer.from(String(100 + index));
    quality.recordCase(index, await quality.findKills(input, Buffer.from(String((100 + index) * 2)), 1));
  }
  // Its small counterexample can't be placed here (it isn't evaluated), and the budget runs out: each search input
  // passes too
  const first = quality.nextCandidate(cases);
  assert.equal(first.promoted, 0, "the small counterexample is tried first");
  for (let next = quality.nextCandidate(cases); next; next = quality.nextCandidate(cases));
  const error = (() => {
    try {
      quality.result();
    } catch (e) {
      return e;
    }
  })();
  assert.match(error.message, /challenges survived \(off-by-one\)/);
  const details = detailsOf(error);
  assert.deepEqual([details.kind, details.role, details.candidate], ["challenge_survived", "quality-challenge-0", "off-by-one"]);
  assert.deepEqual(details.search, { attempts: 16, budget: 16, stoppedBy: "budget" });
  assert.equal(details.related.length, 1);
  const [counterexample] = details.related;
  assert.deepEqual(
    [counterexample.relation, counterexample.verdict, counterexample.subject, counterexample.scenarioIndex],
    ["small_counterexample", "WA", "differential case 1", 0]
  );
  assert.deepEqual(
    ["input", "actual", "expected"].map(role => counterexample.data[role].toString()),
    ["1", "5", "2"]
  );
});

test("a survivor with no replaceable case says the search couldn't run, not that it failed", async () => {
  // E01 of the review: the low-weight subtask has one boundary case, so no extra search is possible
  const quality = new AiQuality(request({ challenges: [{ id: "low", code: "c", kind: "wrong", subtasks: [2], reason: "r" }], fuzzCases: [...request().fuzzCases, { subtask: 2, seed: 0 }] }), fake());
  const cases = [{ subtask: 1, seed: 1 }, { subtask: 1, seed: 2 }, { subtask: 1, seed: 3 }, { subtask: 1, seed: 4 }, { subtask: 2, seed: 1 }];
  assert.equal(quality.nextCandidate(cases), null);
  const details = detailsOf((() => { try { quality.result(); } catch (e) { return e; } })());
  assert.deepEqual(details.search, { attempts: 0, budget: 16, stoppedBy: "capacity" });
});

test("a slow challenge that is merely wrong on a full case is an invalid challenge, with that case", async () => {
  const slow = request({ challenges: [{ id: "slow", code: "s", kind: "slow", subtasks: [1], reason: "n^2" }] });
  const environment = fake();
  const execute = environment.execute;
  environment.execute = async (name, input, parameters) =>
    name === "quality-challenge-0" && Number(input.toString()) >= 100 ? Buffer.from("0") : execute(name, input, parameters);
  const quality = new AiQuality(slow, environment);
  await quality.runDifferential();
  const error = await quality.findKills(Buffer.from("100"), Buffer.from("200"), 1).catch(e => e);
  assert.match(error.message, /Slow challenge slow is incorrect on a full case \(WA\)/);
  const details = detailsOf(error);
  assert.deepEqual([details.kind, details.role, details.candidate], ["invalid_challenge", "quality-challenge-0", "slow"]);
  assert.deepEqual([details.data.input.toString(), details.data.expected.toString()], ["100", "200"]);
});

// The shared contract

test("the backend accepts only well-formed failures within the limits", () => {
  const valid = {
    schemaVersion: 2,
    attemptId,
    operation: "generate",
    sourceHashes: { std: "a".repeat(64) },
    profile: { hash: "b".repeat(64), architecture: "x64", compiler: "g++", auxiliary: { timeLimitMs: 1, memoryLimitMiB: 1 }, solution: { timeLimitMs: 1, memoryLimitMiB: 1 }, oracle: { timeLimitMs: 1, memoryLimitMiB: 1 }, checker: "tokens" },
    observations: [
      {
        kind: "runtime_error",
        fatal: true,
        phase: "generate",
        summary: "std: RuntimeError",
        artifacts: [{ name: "0.input", role: "input", classification: "hidden-test", size: 1, originalSize: 1, sha256: "c".repeat(64), preview: "1", binary: false }]
      }
    ]
  };
  assert.deepEqual(parseAiRunFailure(valid), valid);
  const variants = [
    v => (v.observations[0].artifacts[0].name = "../etc/passwd"),
    v => (v.observations[0].artifacts[0].name = "1.input"),
    v => (v.observations[0].artifacts[0].size = AI_EVIDENCE_LIMITS.artifactBytes + 1),
    v => (v.observations[0].artifacts[0].originalSize = 0),
    v => (v.observations[0].kind = "fine"),
    v => (v.observations[0].fatal = false),
    v => v.observations.push({ ...v.observations[0], artifacts: [] }),
    v => (v.observations = Array(9).fill(v.observations[0])),
    v => (v.observations[0].summary = "x".repeat(2001)),
    v => (v.sourceHashes["../x"] = "a".repeat(64)),
    v => (v.attemptId = "not-a-uuid"),
    v => (v.profile.hash = "x")
  ];
  for (const change of variants) {
    const copy = JSON.parse(JSON.stringify(valid));
    change(copy);
    assert.equal(parseAiRunFailure(copy), null, change.toString());
  }
  // Unknown fields aren't copied
  assert.equal("extra" in parseAiRunFailure({ ...valid, extra: 1 }), false);
});

test("previews escape control characters and show binary data as hex; differences follow the builtin comparisons", () => {
  assert.deepEqual(textPreview(Buffer.from("a\tb\r\n\u0007")), { text: "a\tb\\r\n\\x07", binary: false, bytes: 6 });
  assert.equal(textPreview(Buffer.from([0, 159, 146, 150])).binary, true);
  const multibyte = Buffer.from("ab日");
  assert.equal(textPreview(multibyte, 4).bytes, 2, "a character cut by the limit isn't shown");
  // A compiler's diagnostics are shown without their terminal colours
  const coloured = Buffer.from("\u001b[01m\u001b[Kmain.cpp:3:5:\u001b[m\u001b[K \u001b[01;31m\u001b[Kerror: \u001b[m\u001b[Kno\n");
  assert.deepEqual(textPreview(coloured, undefined, undefined, true), { text: "main.cpp:3:5: error: no\n", binary: false, bytes: coloured.length });
  assert.equal(textPreview(Buffer.from("\u001b[1mbold\n")).text, "\\x1b[1mbold\n", "an output keeps them, escaped");
  assert.equal(firstDifference(Buffer.from("1  2\n3"), Buffer.from("1 2 3"), { type: "tokens", caseSensitive: true }), null);
  assert.equal(firstDifference(Buffer.from("YES"), Buffer.from("yes"), { type: "tokens", caseSensitive: false }), null);
  assert.deepEqual(firstDifference(Buffer.from("a\nb\n"), Buffer.from("a\nc\n\n\n"), { type: "lines", caseSensitive: true }), {
    unit: "line", index: 2, actualLine: 2, expectedLine: 2, actual: "b", expected: "c"
  });
  assert.equal(firstDifference(Buffer.from("a  \n\n"), Buffer.from("a\n"), { type: "lines", caseSensitive: true }), null);
  assert.equal(firstDifference(Buffer.from("0.1000001"), Buffer.from("0.1"), { type: "floats", precision: 6 }), null);
  assert.deepEqual(firstDifference(Buffer.from("1 2"), Buffer.from("1 2 3"), { type: "integers" }), {
    unit: "token", index: 3, expectedLine: 1, actual: "", expected: "3"
  });
  assert.deepEqual(firstDifference(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]), { type: "binary" }).index, 2);
});
