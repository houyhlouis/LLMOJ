// Run: node --test packages/frontend/test/ai-scoring-review.test.cjs
// A test-data job's scoring change waits for its owner's review, and a finished job says what it did with the problem's
// scoring and judging helpers (review Part III, W02): real component code; widgets are mocked.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

const page = "pages/ai/AiScoringReview.tsx";
// What the AI API module imports; nothing here calls it
const deps = {
  axios: { post: async () => assert.fail("no request"), isCancel: () => false },
  "@/utils/callApiWithFileUpload": { callApiWithFileUpload: async () => ({}) },
  "@/utils/session": { noteSessionEnded() {}, responseRequestId() {}, sessionHeaders: () => ({}) }
};
const text = node =>
  node == null || typeof node === "boolean"
    ? ""
    : typeof node !== "object"
      ? String(node)
      : Array.isArray(node)
        ? node.map(text).join("")
        : text(node.props?.children);

const current = {
  runSamples: false,
  subtasks: [
    { points: 40, scoringType: "GroupMin", dependencies: [], timeLimit: 2000 },
    { points: 60, scoringType: "GroupMul", dependencies: [0] }
  ]
};
const proposed = {
  runSamples: true,
  subtasks: [
    { points: 30, scoringType: "Sum", dependencies: [] },
    { points: 70, scoringType: "Sum", dependencies: [] }
  ]
};
const review = {
  current,
  proposed,
  currentDigest: "a".repeat(64),
  proposedDigest: "b".repeat(64),
  reasons: [
    { code: "SUBTASK_POINTS", subtask: 1, current: 40, proposed: 30 },
    { code: "SUBTASK_LIMITS", subtask: 1 },
    { code: "CASE_POINTS", subtask: 2 }
  ]
};

test("the review says why, and shows the problem's scoring beside what would be published", () => {
  const h = componentHarness(page, { props: { review }, deps });
  const reasons = h.all(node => node.type === "li").map(text);
  assert.deepEqual(reasons, [
    "Subtask 1 is worth 40 points in the problem and 30 in the statement.",
    "Subtask 1 has its own time or memory limit, which the generated data can't be checked with; approving uses the problem's limits.",
    "Test cases of subtask 2 have their own points; new test cases share the subtask's points equally."
  ]);
  const tables = h.all(node => node.type?.name === "PolicyTable");
  assert.deepEqual(
    tables.map(node => node.props.policy),
    [current, proposed]
  );
  const notes = text(h.all(() => true)[0]);
  assert.match(notes, /The problem's settings/);
  assert.match(notes, /Published if you approve/);
  assert.match(notes, /Samples aren't judged first\./);
  assert.match(notes, /A submission that fails a sample gets no points\./);
});

test("each subtask's points, scoring, dependencies and own limits are listed", () => {
  const h = componentHarness(page, { component: "PolicyTable", props: { policy: current }, deps });
  const body = h.all(node => node.type?.name === "Table.Body")[0];
  const rows = h.all(node => node.type?.name === "Table.Row", body);
  assert.deepEqual(
    rows.map(row => h.all(node => node.type?.name === "Table.Cell", row).map(cell => text(cell).replace(/\s+/g, " ").trim())),
    [
      ["1 (2000 ms)", "40", "Lowest test case (all or nothing)", "—"],
      ["2", "60", "Product of test cases", "1"]
    ]
  );
});

test("a finished job says whether it kept, set or replaced the scoring, and how its helpers ran", () => {
  const summary = result => text(componentHarness(page, { component: "AiJudgingSummary", props: { result }, deps }).all(() => true)[0]);
  assert.equal(summary({}), "");
  assert.equal(summary({ scoring: { status: "kept", subtasks: 3, digest: "x" } }), "Scoring settings kept (3 subtasks)");
  assert.equal(summary({ scoring: { status: "new", subtasks: 2, digest: "x" } }), "2 subtasks from the statement");
  assert.equal(
    summary({
      scoring: { status: "replaced", subtasks: 2, digest: "x", previousDigest: "y" },
      helpers: [
        { role: "checker", origin: "problem", options: "clang++ -std=c++20 -O3", timeLimitMs: 2000, memoryLimitMiB: 300 }
      ]
    }),
    "Scoring settings replaced as approved (2 subtasks) · Checker (the problem's): clang++ -std=c++20 -O3, 2000 ms, 300 MiB"
  );
  assert.equal(
    summary({ helpers: [{ role: "interactor", origin: "ai", options: "g++ -std=c++17 -O2", timeLimitMs: 5000, memoryLimitMiB: 256 }] }),
    " · Interactor (AI-written): g++ -std=c++17 -O2, 5000 ms, 256 MiB"
  );
});
