/* Independent test-data quality planning validation; no database, model or sandbox connections. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText, filename);
const { normalizeAiQualityPlan, allocateAiFuzzCases, assertAiQualityResult } = require("./ai-testdata-quality.ts");

const subtasks = [{ id: 1, points: 30 }, { id: 3, points: 70 }];
const quality = () => ({
  version: 1,
  correctAlgorithms: ["Dijkstra with a binary heap", "Dijkstra with an ordered set"],
  oracleMethod: "Enumerate simple paths on graphs with at most seven vertices, using 128-bit distances.",
  smallInputStrategy: "Enumerate tiny disconnected, tied and zero-weight directed graphs, then use random small graphs.",
  targets: [
    { id: "int-overflow", kind: "wrong", algorithm: "Dijkstra with 32-bit distances", reason: "A path sum exceeds INT_MAX.", subtasks: [1, 3], construction: "Use a directed chain with legal large edge weights whose total distance exceeds INT_MAX." },
    { id: "spfa-fifo", kind: "slow", algorithm: "FIFO SPFA", reason: "Repeated late improvements re-enqueue long prefixes.", subtasks: [3], construction: "Use a maximum-size layered directed graph with descending shortcut weights and edge order that repeatedly improves prefixes." }
  ]
});
const invalid = value => assert.throws(() => normalizeAiQualityPlan(value, subtasks), /INVALID_AI_QUALITY_PLAN/);

test("quality plans retain independent correct algorithms, oracle and concrete target constructions", () => {
  const input = quality();
  const result = normalizeAiQualityPlan(input, subtasks);
  assert.equal(result.version, 1);
  assert.deepEqual(result.correctAlgorithms, input.correctAlgorithms);
  assert.equal(result.oracleMethod, input.oracleMethod);
  assert.equal(result.smallInputStrategy, input.smallInputStrategy);
  assert.deepEqual(result.targets, input.targets);
  assert.deepEqual(input, quality(), "normalization must not mutate the persisted model response");
});

test("slow candidates are optional and efficient equivalent correct methods are allowed", () => {
  const input = quality();
  input.targets = input.targets.slice(0, 1);
  assert.equal(normalizeAiQualityPlan(input, subtasks).targets.length, 1);
  input.correctAlgorithms = ["Exhaustive search on bounded inputs", "Dynamic programming", "Meet in the middle", "Branch and bound with a proved upper bound"];
  assert.equal(normalizeAiQualityPlan(input, subtasks).correctAlgorithms.length, 4);
});

test("plans cannot omit an independent correct method or inflate the bounded candidate budget", () => {
  for (const algorithms of [[], ["only one method"], Array.from({ length: 5 }, (_, i) => "method " + i), "not an array"]) {
    const input = quality();
    input.correctAlgorithms = algorithms;
    invalid(input);
  }
  for (const targets of [[], Array.from({ length: 5 }, (_, i) => ({ ...quality().targets[0], id: "wrong-" + i })), "not an array"]) {
    const input = quality();
    input.targets = targets;
    invalid(input);
  }
});

test("at least one semantically wrong candidate is required, even if slow targets exist", () => {
  const input = quality();
  input.targets = [input.targets[1]];
  invalid(input);
});

test("target kinds and identifiers reject ambiguity, duplicates and unsafe paths", () => {
  for (const kind of ["correct", "unknown", "", null]) {
    const input = quality();
    input.targets[0].kind = kind;
    invalid(input);
  }
  for (const id of ["", "../wrong", "/absolute", "wrong target", "wrong\nline", "independent", "x".repeat(10000)]) {
    const input = quality();
    input.targets[0].id = id;
    invalid(input);
  }
  const duplicate = quality();
  duplicate.targets[1].id = duplicate.targets[0].id;
  invalid(duplicate);
});

test("every target names existing subtasks without duplicate or invalid subtask identifiers", () => {
  for (const ids of [[], [2], [0], [-1], [1001], [1.5], ["1"], [1, 1], null, "1"]) {
    const input = quality();
    input.targets[0].subtasks = ids;
    invalid(input);
  }
});

test("every algorithm, oracle, strategy, reason and construction must be nonempty bounded text", () => {
  const setters = [
    (input, value) => { input.correctAlgorithms[0] = value; },
    (input, value) => { input.oracleMethod = value; },
    (input, value) => { input.smallInputStrategy = value; },
    (input, value) => { input.targets[0].algorithm = value; },
    (input, value) => { input.targets[0].reason = value; },
    (input, value) => { input.targets[0].construction = value; }
  ];
  for (const set of setters) for (const value of ["", "   ", null, 4, [], "x".repeat(1000001)]) {
    const input = quality();
    set(input, value);
    invalid(input);
  }
});

test("malformed model envelopes and incomplete candidate records never become usable plans", () => {
  for (const value of [undefined, null, [], 3, "plan", {}, { ...quality(), targets: [null] }, { ...quality(), targets: [{}] }]) invalid(value);
});


test("quality versions and duplicate algorithm descriptions cannot bypass independence checks", () => {
  for (const version of [undefined, null, 0, 2, "1"]) invalid({ ...quality(), version });
  const duplicate = quality();
  duplicate.correctAlgorithms = ["Dijkstra", "  DIJKSTRA  "];
  invalid(duplicate);
});

test("fuzz allocation covers every subtask and preserves per-subtask case indices", () => {
  const cases = allocateAiFuzzCases(subtasks);
  assert.equal(cases.length, 64);
  assert.deepEqual(new Set(cases.map(item => item.subtask)), new Set([1, 3]));
  for (const { id } of subtasks) {
    const indices = cases.filter(item => item.subtask === id).map(item => item.seed);
    assert.deepEqual(indices, Array.from({ length: indices.length }, (_, index) => index + 1));
  }
  const manySubtasks = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1 }));
  const expanded = allocateAiFuzzCases(manySubtasks);
  assert.equal(expanded.length, 1000);
  assert.equal(new Set(expanded.map(item => item.subtask)).size, 1000);
});

test("fuzz allocation rejects malformed subtasks or unbounded execution budgets", () => {
  for (const count of [0, 31, 32, 63, 1001, 64.5, "64", NaN]) {
    assert.throws(() => allocateAiFuzzCases(subtasks, count), /INVALID_AI_QUALITY_PLAN/);
  }
  for (const input of [[], [{ id: 1 }, { id: 1 }], [{ id: 0 }], [{ id: 1001 }], [{ id: "1" }], Array.from({ length: 1001 }, (_, index) => ({ id: index + 1 }))]) {
    assert.throws(() => allocateAiFuzzCases(input), /INVALID_AI_QUALITY_PLAN/);
  }
});

const finalCases = [{ subtask: 1 }, { subtask: 3 }, { subtask: 1 }, { subtask: 3 }, { subtask: 3 }];
const request = () => ({
  version: 1,
  fuzzCases: allocateAiFuzzCases(subtasks),
  smallMakeCode: "int main() {}",
  oracleCode: "int main() {}",
  alternatives: [{ id: "alternative-1", code: "int main() {}" }],
  challenges: quality().targets.map(target => ({ id: target.id, code: "int main() {}", kind: target.kind, subtasks: target.subtasks, reason: target.reason })),
  extraAttempts: 16
});
const receipt = () => ({
  version: 1,
  fuzzPassed: 64,
  alternativeCount: 1,
  alternativesPassed: 5,
  challengeCount: 2,
  challengesKilled: 2,
  extraAttemptsUsed: 2,
  challengeResults: [
    { id: "int-overflow", kind: "wrong", killedBy: 1, verdict: "WA" },
    { id: "spfa-fifo", kind: "slow", killedBy: 2, verdict: "TLE" }
  ]
});
const invalidReceipt = value => assert.throws(() => assertAiQualityResult(value, request(), finalCases), /TESTDATA_QUALITY_GATE_FAILED/);

test("complete quality receipts accept real verdicts and final applicable-subtask witnesses", () => {
  for (const verdict of ["WA", "RE", "TLE", "MLE"]) {
    const result = receipt();
    result.challengeResults[0].verdict = verdict;
    assert.doesNotThrow(() => assertAiQualityResult(result, request(), finalCases));
  }
  const reordered = receipt();
  reordered.challengeResults.reverse();
  assert.doesNotThrow(() => assertAiQualityResult(reordered, request(), finalCases));
  for (const extraAttemptsUsed of [0, 16]) assert.doesNotThrow(() => assertAiQualityResult({ ...receipt(), extraAttemptsUsed }, request(), finalCases));
});

test("old, incomplete and inconsistent receipts cannot activate generated data", () => {
  for (const value of [undefined, null, {}, [], { samplesPassed: 3, inputsPassed: 5 }, { ...receipt(), version: 0 }, { ...receipt(), version: "1" }]) invalidReceipt(value);
  for (const field of ["fuzzPassed", "alternativeCount", "alternativesPassed", "challengeCount", "challengesKilled"]) {
    const result = receipt();
    delete result[field];
    invalidReceipt(result);
    for (const value of [0, -1, 10000, String(receipt()[field])]) invalidReceipt({ ...receipt(), [field]: value });
  }
  for (const extraAttemptsUsed of [-1, 17, 0.5, "2", undefined]) invalidReceipt({ ...receipt(), extraAttemptsUsed });
});

test("every challenge must have one matching final witness and genuine rejection verdict", () => {
  for (const witnesses of [undefined, [], receipt().challengeResults.slice(0, 1), [...receipt().challengeResults, receipt().challengeResults[0]], [receipt().challengeResults[0], receipt().challengeResults[0]]]) {
    invalidReceipt({ ...receipt(), challengeResults: witnesses });
  }
  const changes = [
    ["id", "unexpected"], ["kind", "slow"],
    ["killedBy", 0], ["killedBy", 6], ["killedBy", 1.5], ["killedBy", "1"],
    ["verdict", "AC"], ["verdict", "CE"], ["verdict", "Unknown"], ["verdict", "FAIL"], ["verdict", "PE"], ["verdict", null]
  ];
  for (const [field, value] of changes) {
    const result = receipt();
    result.challengeResults[0][field] = value;
    invalidReceipt(result);
  }
  const wrongSubtask = receipt();
  wrongSubtask.challengeResults[1].killedBy = 1;
  invalidReceipt(wrongSubtask);
});

test("receipt expectations follow the actual request rather than hard-coded default counts", () => {
  const expected = request();
  expected.fuzzCases = allocateAiFuzzCases(subtasks, 128);
  expected.alternatives.push({ id: "alternative-2", code: "int main() {}" });
  const result = receipt();
  result.fuzzPassed = 128;
  result.alternativeCount = 2;
  result.alternativesPassed = finalCases.length * 2;
  assert.doesNotThrow(() => assertAiQualityResult(result, expected, finalCases));
  invalidReceipt(result);
});


test("candidate reasons fit the runner receipt bound", () => {
  const input = quality();
  input.targets[0].reason = "x".repeat(2000);
  assert.doesNotThrow(() => normalizeAiQualityPlan(input, subtasks));
  input.targets[0].reason += "x";
  invalid(input);
});

test("slow candidates require actual time or memory degeneration rather than wrong answers", () => {
  for (const verdict of ["TLE", "MLE"]) {
    const result = receipt();
    result.challengeResults[1].verdict = verdict;
    assert.doesNotThrow(() => assertAiQualityResult(result, request(), finalCases));
  }
  for (const verdict of ["WA", "RE"]) {
    const result = receipt();
    result.challengeResults[1].verdict = verdict;
    invalidReceipt(result);
  }
});
