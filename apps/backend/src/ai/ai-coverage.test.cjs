/* Credential-free tests of coverage-aware test selection (review Part III, H06/W05, probes E01–E04). */
// Every target gets a case built for it and a case the search could replace; the runner's selection report (distinct
// differential inputs, tested outcomes, replacements, the search) is checked against the receipt before anything is
// published.
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
const { allocateAiTestcases } = require("./ai-case-allocation.ts");
const { assertAiQualityResult } = require("./ai-testdata-quality.ts");

const subtasks = (...points) => points.map((value, index) => ({ id: index + 1, points: value }));

test("a low-weight subtask gets a case for each target that has none, and keeps its points (E01)", () => {
  // Without targets: the points' shares, 98 and 2 of 5 requested cases
  const plain = allocateAiTestcases(subtasks(98, 2), 5);
  assert.deepEqual(
    plain.allocations.map(item => item.count),
    [49, 1]
  );
  assert.equal(plain.pointsPerCase, 2);
  assert.deepEqual(plain.capacity, []);
  // A target of the second subtask only: its one case is the minimum one, never built for it nor replaceable
  const result = allocateAiTestcases(subtasks(98, 2), 5, [{ id: "low", subtasks: [2] }]);
  assert.deepEqual(
    result.allocations.map(item => [item.id, item.points, item.count]),
    [
      [1, 98, 49],
      [2, 2, 3]
    ]
  );
  assert.equal(result.count, 52);
  assert.equal(result.cases.length, 52);
  assert.deepEqual(result.cases.slice(-3), [
    { subtask: 2, seed: 1 },
    { subtask: 2, seed: 2 },
    { subtask: 2, seed: 3 }
  ]);
  assert.deepEqual(result.capacity, [{ subtask: 2, from: 1, to: 3, targets: ["low"] }]);
  // The cases no longer share points equally: each subtask's share is stated
  assert.equal(result.pointsPerCase, null);
  assert.deepEqual(
    result.allocations.map(item => item.pointsPerCase),
    [2, 2 / 3]
  );
});

test("a target with a case somewhere, or targets of a large subtask, change nothing; two targets get two cases", () => {
  for (const targets of [
    [{ id: "both", subtasks: [1, 2] }],
    [{ id: "big", subtasks: [1] }],
    [{ id: "unknown", subtasks: [7] }]
  ])
    assert.deepEqual(allocateAiTestcases(subtasks(98, 2), 5, targets).capacity, [], JSON.stringify(targets));
  const two = allocateAiTestcases(subtasks(98, 2), 5, [
    { id: "a", subtasks: [2] },
    { id: "b", subtasks: [2] }
  ]);
  assert.deepEqual(two.capacity, [{ subtask: 2, from: 1, to: 4, targets: ["a", "b"] }]);
  // A target of two small subtasks goes to the larger one
  const three = allocateAiTestcases(subtasks(96, 2, 2), 50, [{ id: "c", subtasks: [2, 3] }]);
  assert.deepEqual(
    three.allocations.map(item => item.count),
    [48, 3, 1]
  );
  // A subtask of two cases needs one more
  const pair = allocateAiTestcases(subtasks(96, 4), 50, [{ id: "d", subtasks: [2] }]);
  assert.deepEqual(pair.capacity, [{ subtask: 2, from: 2, to: 3, targets: ["d"] }]);
});

test("capacity never takes the total over 1000 cases", () => {
  const points = [99.9, 0.1];
  assert.equal(allocateAiTestcases(subtasks(...points), 1000).count, 1000);
  assert.throws(
    () => allocateAiTestcases(subtasks(...points), 1000, [{ id: "rare", subtasks: [2] }]),
    /TEST_COUNT_RATIO_UNREPRESENTABLE/
  );
});

// A receipt of a judge of this version: five cases of one subtask, two targets
const request = {
  version: 1,
  fuzzCases: Array.from({ length: 64 }, (_, seed) => ({ subtask: 1, seed })),
  smallMakeCode: "s",
  oracleCode: "o",
  alternatives: [{ id: "independent", code: "a" }],
  challenges: [
    { id: "greedy", code: "g", kind: "wrong", subtasks: [1], reason: "r" },
    { id: "slow", code: "q", kind: "slow", subtasks: [1], reason: "r" }
  ],
  extraAttempts: 16
};
const cases = Array.from({ length: 5 }, (_, index) => ({ subtask: 1, seed: index + 1 }));
const receipt = () => ({
  version: 1,
  fuzzPassed: 64,
  fuzzDistinct: 40,
  alternativeCount: 1,
  alternativesPassed: 5,
  challengeCount: 2,
  challengesKilled: 2,
  challengeResults: [
    { id: "greedy", kind: "wrong", killedBy: 3, verdict: "WA", tested: 3, kills: 1 },
    { id: "slow", kind: "slow", killedBy: 4, verdict: "TLE", tested: 4, kills: 1 }
  ],
  extraAttemptsUsed: 2,
  replacements: [{ case: 4, source: "small_counterexample", kills: ["slow"], moved: [] }],
  search: { attempts: 2, budget: 16, found: 2, unplaced: 1, promoted: 1 },
  matrix: [
    { case: 1, killed: [], passed: ["greedy", "slow"] },
    { case: 2, killed: [], passed: ["greedy", "slow"] },
    { case: 3, killed: ["greedy"], passed: ["slow"] },
    { case: 4, killed: ["slow"], passed: [] }
  ]
});

test("a consistent selection report is accepted, and so is a receipt without one (an older judge)", () => {
  assertAiQualityResult(receipt(), request, cases);
  const old = receipt();
  for (const field of ["fuzzDistinct", "replacements", "search", "matrix"]) delete old[field];
  for (const item of old.challengeResults) {
    delete item.tested;
    delete item.kills;
  }
  assertAiQualityResult(old, request, cases);
});

test("an inconsistent selection report qualifies nothing", () => {
  for (const [name, change] of [
    ["more distinct inputs than checks", result => (result.fuzzDistinct = 65)],
    ["no distinct input", result => (result.fuzzDistinct = 0)],
    ["more rejecting cases than tested", result => (result.challengeResults[0].kills = 4)],
    ["a witness its row doesn't name", result => (result.matrix[2].killed = [])],
    ["a row twice", result => result.matrix.push({ case: 1, killed: [], passed: [] })],
    ["a challenge both passed and failed", result => (result.matrix[0].killed = ["greedy"])],
    ["an unknown challenge", result => (result.matrix[0].passed = ["other"])],
    ["a case out of range", result => (result.matrix[3].case = 6)],
    ["a replacement that rejects nothing", result => (result.replacements[0].kills = [])],
    ["a moved witness the new case doesn't reject", result => (result.replacements[0].moved = ["greedy"])],
    ["another source", result => (result.replacements[0].source = "model")],
    ["search attempts that aren't the receipt's", result => (result.search.attempts = 3)],
    ["another budget", result => (result.search.budget = 32)],
    ["more unplaced than found", result => (result.search.unplaced = 3)],
    ["promotions the replacements don't show", result => (result.search.promoted = 0)]
  ]) {
    const result = receipt();
    change(result);
    assert.throws(() => assertAiQualityResult(result, request, cases), /TESTDATA_QUALITY_GATE_FAILED/, name);
  }
  // A challenge of another subtask can't be in a row
  const twoSubtasks = {
    ...request,
    fuzzCases: [...request.fuzzCases, { subtask: 2, seed: 0 }],
    challenges: [request.challenges[0], { ...request.challenges[1], subtasks: [2] }]
  };
  const mixed = [...cases.slice(0, 4), { subtask: 2, seed: 1 }];
  const result = receipt();
  result.challengeResults[1].killedBy = 5;
  result.matrix[3] = { case: 4, killed: ["slow"], passed: [] };
  assert.throws(() => assertAiQualityResult(result, twoSubtasks, mixed), /TESTDATA_QUALITY_GATE_FAILED/);
});
