/* Credential-free tests of the AI judging contract's scoring policy (review Part III, H04). */
// Regenerating a problem's test data changes its cases, not how it awards points: the scoring the problem's judging
// settings establish is kept, with the same digest, and any change waits for its owner's approval of exactly that change.
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
  decideScoring,
  existingScoring,
  planDifferences,
  publishedSubtasks,
  scoringDigest
} = require("./ai-judging-contract.ts");

const cases = (subtask, count) => Array.from({ length: count }, () => ({ subtask }));
const testcase = (subtask, index) => ({ inputFile: `old-${subtask}-${index}.in`, outputFile: `old-${subtask}-${index}.out` });
const old = (subtask, count, fields = {}) => Array.from({ length: count }, (_, index) => ({ ...testcase(subtask, index), ...fields }));

// Fixtures of established scoring: each a problem's judging settings and the plan of a statement that matches it
const FIXTURES = {
  "a sum": { subtasks: [{ points: 100, scoringType: "Sum", testcases: old(1, 3) }] },
  "groups scored by their lowest case (all or nothing), with automatic points": {
    runSamples: true,
    subtasks: [
      { scoringType: "GroupMin", testcases: old(1, 2) },
      { scoringType: "GroupMin", testcases: old(2, 2) },
      { scoringType: "GroupMin", testcases: old(3, 2) }
    ]
  },
  "a product, and dependencies": {
    subtasks: [
      { points: 20, scoringType: "GroupMin", testcases: old(1, 1) },
      { points: 30, scoringType: "Sum", dependencies: [0], testcases: old(2, 2) },
      { points: 50, scoringType: "GroupMul", dependencies: [1, 0], testcases: old(3, 2) }
    ]
  },
  "manual settings: subtask limits equal to the problem's, and points given to some subtasks only": {
    timeLimit: 1000,
    memoryLimit: 256,
    subtasks: [
      { points: 40, timeLimit: 1000, scoringType: "GroupMin", testcases: old(1, 2) },
      { memoryLimit: 256, scoringType: "GroupMin", testcases: old(2, 1, { points: 30 }) },
      { scoringType: "GroupMin", testcases: old(3, 1) }
    ]
  }
};
const planOf = judgeInfo =>
  existingScoring(judgeInfo).policy.subtasks.map((subtask, index) => ({ id: index + 1, points: Math.round(subtask.points * 100) / 100 }));

for (const [name, fixture] of Object.entries(FIXTURES))
  test(`regenerated data keeps the scoring and its digest: ${name}`, () => {
    const judgeInfo = { timeLimit: 1000, memoryLimit: 256, ...structuredClone(fixture) };
    const before = existingScoring(judgeInfo);
    assert.deepEqual(before.unsupported, []);
    const plan = planOf(judgeInfo);
    const { decision } = decideScoring(before, plan, true);
    assert.equal(decision.status, "kept");
    assert.equal(decision.problemSubtasks, true);
    // The traditional and protocol paths publish through the same builder; only their case files differ
    for (const files of [index => ({ inputFile: `new-${index}.in`, outputFile: `new-${index}.out` }), index => ({ inputFile: `new-${index}.in` })]) {
      const subtasks = publishedSubtasks(decision, plan.map(item => item.id), plan.flatMap(item => cases(item.id, 2)), files);
      const after = { ...judgeInfo, subtasks };
      assert.equal(existingScoring(after).digest, before.digest, "the same scoring-policy digest");
      subtasks.forEach((subtask, index) => {
        const { testcases, ...settings } = judgeInfo.subtasks[index];
        const { testcases: published, ...kept } = subtask;
        assert.deepEqual(kept, settings, "each subtask's own settings, as they were");
        assert.equal(published.length, 2);
        assert(published.every(item => item.inputFile.startsWith("new-")), "only the cases change");
      });
    }
  });

test("a statement whose subtasks don't match the problem's is reviewed, never mapped onto them", () => {
  const existing = existingScoring({ subtasks: [{ points: 100, scoringType: "GroupMin", testcases: old(1, 2) }] });
  const proposedPlan = [
    { id: 1, points: 30 },
    { id: 2, points: 70 }
  ];
  const { review } = decideScoring(existing, proposedPlan, true);
  assert.deepEqual(review.reasons, [{ code: "SUBTASK_COUNT", current: 1, proposed: 2 }]);
  assert.equal(review.currentDigest, existing.digest);
  assert.deepEqual(review.current.subtasks, [{ points: 100, scoringType: "GroupMin", dependencies: [] }]);
  assert.deepEqual(
    review.proposed.subtasks.map(subtask => [subtask.points, subtask.scoringType]),
    [
      [30, "Sum"],
      [70, "Sum"]
    ]
  );
  assert.equal(review.proposedDigest, scoringDigest(review.proposed));
  // Approved exactly: the change is published, saying what it replaced
  const { decision } = decideScoring(existing, proposedPlan, true, {
    currentDigest: review.currentDigest,
    proposedDigest: review.proposedDigest
  });
  assert.deepEqual([decision.status, decision.digest, decision.previousDigest], ["replaced", review.proposedDigest, existing.digest]);
  assert.deepEqual(decision.settings, [
    { points: 30, scoringType: "Sum" },
    { points: 70, scoringType: "Sum" }
  ]);
  // An approval is of that change only: another plan, or a problem changed since, is reviewed again
  const replanned = decideScoring(existing, [{ id: 1, points: 40 }, { id: 2, points: 60 }], true, {
    currentDigest: review.currentDigest,
    proposedDigest: review.proposedDigest
  });
  assert(replanned.review);
  const changed = existingScoring({ subtasks: [{ points: 100, scoringType: "Sum", testcases: old(1, 2) }] });
  assert(decideScoring(changed, proposedPlan, true, { currentDigest: review.currentDigest, proposedDigest: review.proposedDigest }).review);
});

test("points that differ, or subtasks out of order, are differences; rounding to the hundredth isn't", () => {
  const existing = existingScoring({
    subtasks: [{ scoringType: "GroupMin", testcases: old(1, 1) }, { scoringType: "GroupMin", testcases: old(2, 1) }, { scoringType: "GroupMin", testcases: old(3, 1) }]
  });
  assert.deepEqual(planDifferences(existing, [{ id: 1, points: 33.33 }, { id: 2, points: 33.33 }, { id: 3, points: 33.34 }]), []);
  assert.deepEqual(planDifferences(existing, [{ id: 1, points: 20 }, { id: 2, points: 40 }, { id: 3, points: 40 }]), [
    { code: "SUBTASK_POINTS", subtask: 1, current: 100 / 3, proposed: 20 },
    { code: "SUBTASK_POINTS", subtask: 2, current: 100 / 3, proposed: 40 },
    { code: "SUBTASK_POINTS", subtask: 3, current: 100 / 3, proposed: 40 }
  ]);
  assert.deepEqual(planDifferences(existing, [{ id: 2, points: 33.33 }, { id: 1, points: 33.33 }, { id: 3, points: 33.34 }]), [{ code: "SUBTASK_ORDER" }]);
  // Kept points are the problem's, not the plan's rounding
  const { decision } = decideScoring(existing, [{ id: 1, points: 33.33 }, { id: 2, points: 33.33 }, { id: 3, points: 33.34 }], true);
  assert.deepEqual(decision.policy.subtasks.map(subtask => subtask.points), [100 / 3, 100 / 3, 100 / 3]);
});

test("settings bound to the cases a job replaces, or limits it can't check with, are reviewed even when the subtasks match", () => {
  const judgeInfo = {
    timeLimit: 1000,
    memoryLimit: 256,
    subtasks: [
      { points: 40, scoringType: "GroupMin", timeLimit: 2000, dependencies: [], testcases: old(1, 2) },
      { points: 30, scoringType: "Sum", testcases: [{ ...testcase(2, 0), points: 70 }, { ...testcase(2, 1), points: 30 }] },
      { points: 30, scoringType: "GroupMin", dependencies: [0], testcases: [{ ...testcase(3, 0), memoryLimit: 512 }] }
    ]
  };
  const existing = existingScoring(judgeInfo);
  assert.deepEqual(existing.unsupported, [
    { code: "SUBTASK_LIMITS", subtask: 1 },
    { code: "CASE_POINTS", subtask: 2 },
    { code: "CASE_LIMITS", subtask: 3 }
  ]);
  const plan = [
    { id: 1, points: 40 },
    { id: 2, points: 30 },
    { id: 3, points: 30 }
  ];
  const { review } = decideScoring(existing, plan, true);
  assert.deepEqual(review.reasons, existing.unsupported);
  // What's proposed is the problem's own scoring without the subtask's limit
  assert.deepEqual(review.proposed.subtasks, [
    { points: 40, scoringType: "GroupMin", dependencies: [] },
    { points: 30, scoringType: "Sum", dependencies: [] },
    { points: 30, scoringType: "GroupMin", dependencies: [0] }
  ]);
  const { decision } = decideScoring(existing, plan, true, { currentDigest: review.currentDigest, proposedDigest: review.proposedDigest });
  assert.equal(decision.status, "replaced");
  assert.equal(decision.problemSubtasks, true);
  const subtasks = publishedSubtasks(decision, [1, 2, 3], [...cases(1, 1), ...cases(2, 1), ...cases(3, 1)], index => ({ inputFile: `${index}.in` }));
  assert.deepEqual(
    subtasks.map(({ testcases, ...settings }) => settings),
    [
      { points: 40, scoringType: "GroupMin", dependencies: [] },
      { points: 30, scoringType: "Sum" },
      { points: 30, scoringType: "GroupMin", dependencies: [0] }
    ]
  );
  // Case points under a lowest-case or product score don't count: they aren't reviewed
  const group = existingScoring({ subtasks: [{ scoringType: "GroupMin", testcases: [{ ...testcase(1, 0), points: 100 }] }] });
  assert.deepEqual(group.unsupported, []);
});

test("a problem without subtasks of its own gets the statement's, each a sum of its cases", () => {
  for (const judgeInfo of [{}, { subtasks: null }, { subtasks: [] }, null]) assert.equal(existingScoring(judgeInfo), null);
  const plan = [
    { id: 1, points: 25 },
    { id: 2, points: 75 }
  ];
  for (const runSamples of [true, false]) {
    const { decision } = decideScoring(null, plan, runSamples);
    assert.equal(decision.status, "new");
    assert.equal(decision.policy.runSamples, runSamples);
    assert.deepEqual(
      publishedSubtasks(decision, [1, 2], [...cases(1, 1), ...cases(2, 3)], index => ({ inputFile: `${index}.in` })).map(subtask => [
        subtask.points,
        subtask.scoringType,
        subtask.testcases.length
      ]),
      [
        [25, "Sum", 1],
        [75, "Sum", 3]
      ]
    );
  }
});

test("whether samples are judged first is part of the policy and kept", () => {
  const without = existingScoring({ runSamples: false, subtasks: [{ points: 100, scoringType: "Sum", testcases: old(1, 1) }] });
  const withSamples = existingScoring({ runSamples: true, subtasks: [{ points: 100, scoringType: "Sum", testcases: old(1, 1) }] });
  assert.notEqual(without.digest, withSamples.digest);
  assert.equal(decideScoring(without, [{ id: 1, points: 100 }], true).decision.policy.runSamples, false);
  // Dependencies in another order are the same dependencies
  const a = existingScoring({ subtasks: [{ testcases: old(1, 1) }, { testcases: old(2, 1) }, { dependencies: [1, 0], testcases: old(3, 1) }] });
  const b = existingScoring({ subtasks: [{ testcases: old(1, 1) }, { testcases: old(2, 1) }, { dependencies: [0, 1], testcases: old(3, 1) }] });
  assert.equal(a.digest, b.digest);
});
