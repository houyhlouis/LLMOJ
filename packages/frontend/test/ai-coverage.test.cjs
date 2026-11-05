// Run: node --test packages/frontend/test/ai-coverage.test.cjs
// How a test data job's cases cover its quality targets (review Part III, W05): distinct differential inputs, each
// target's witness and tested cases, replaced cases, the extra search, subtasks given more cases, and distinct final
// inputs. Real component code; the AI API and widgets are mocked.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

const text = node =>
  node == null || typeof node === "boolean"
    ? ""
    : typeof node !== "object"
      ? String(node)
      : Array.isArray(node)
        ? node.map(text).join("")
        : text(node.props?.children);

// The modules the AI API module imports; no request is made here
const deps = {
  axios: { post: async () => assert.fail("no request"), isCancel: () => false },
  "@/utils/callApiWithFileUpload": { callApiWithFileUpload: async () => ({}) },
  "@/utils/session": { noteSessionEnded() {}, responseRequestId() {}, sessionHeaders: () => ({}) }
};
const page = "pages/ai/AiCoverage.tsx";

// A receipt as a judge before this part sends it
const oldReceipt = () => ({
  version: 1,
  fuzzPassed: 64,
  alternativeCount: 1,
  alternativesPassed: 8,
  challengeCount: 2,
  challengesKilled: 2,
  extraAttemptsUsed: 0,
  challengeResults: [
    { id: "greedy", kind: "wrong", killedBy: 3, verdict: "WA" },
    { id: "slow_dp", kind: "slow", killedBy: 5, verdict: "TLE" }
  ]
});
const lines = result =>
  componentHarness(page, { deps, props: { result } })
    .all(node => node.type === "p")
    .map(text);

test("an old judge's receipt shows the checks as before, and nothing new", () => {
  assert.deepEqual(lines({ warnings: [], testdataQuality: oldReceipt() }), [
    "64 differential checks passed · 1 alternative correct solution(s) passed 8 data checks · 2/2 wrong or slow algorithms rejected",
    "greedy · Test case 3: WA",
    "slow_dp · Test case 5: TLE"
  ]);
  // No receipt, no capacity: nothing at all
  assert.deepEqual(lines({ warnings: [] }), []);
});

test("distinct differential inputs, and how many of the cases each target ran on rejected it", () => {
  const receipt = {
    ...oldReceipt(),
    fuzzDistinct: 12,
    challengeResults: [
      { id: "greedy", kind: "wrong", killedBy: 3, verdict: "WA", tested: 8, kills: 5 },
      { id: "slow_dp", kind: "slow", killedBy: 5, verdict: "TLE", tested: 1, kills: 1 }
    ],
    search: { attempts: 0, budget: 16, found: 0, unplaced: 0, promoted: 0 }
  };
  assert.deepEqual(lines({ warnings: [], testdataQuality: receipt }), [
    "64 differential checks passed on 12 distinct inputs · 1 alternative correct solution(s) passed 8 data checks · 2/2 wrong or slow algorithms rejected",
    "greedy · Test case 3: WA · rejected by 5 of the 8 test cases it ran on",
    "slow_dp · Test case 5: TLE · rejected by 1 of the 1 test case it ran on"
  ]);
  assert.match(
    lines({ warnings: [], testdataQuality: { ...receipt, fuzzDistinct: 1 } })[0],
    /^64 differential checks passed on 1 distinct input ·/
  );
});

test("replaced cases say where their counterexample came from, what it rejects and whose witness moved", () => {
  const receipt = {
    ...oldReceipt(),
    challengeCount: 4,
    challengesKilled: 4,
    extraAttemptsUsed: 3,
    replacements: [
      { case: 3, source: "search", kills: ["a", "d"], moved: ["a"] },
      { case: 4, source: "small_counterexample", kills: ["equal_pair"], moved: [] }
    ],
    search: { attempts: 3, budget: 16, found: 2, unplaced: 1, promoted: 1 }
  };
  const shown = lines({ warnings: [], testdataQuality: receipt });
  assert(
    shown.includes(
      "Test case 3 replaced by a counterexample found by search (rejects a, d; the witness for a moved to it)"
    )
  );
  assert(
    shown.includes("Test case 4 replaced by a small counterexample from differential testing (rejects equal_pair)")
  );
  assert(
    shown.includes(
      "Extra search: 3 of 16 attempts · 1 counterexample found, 1 not placed · 1 small counterexample from differential testing used"
    )
  );
  // A small counterexample used without any search attempt: no search is mentioned
  const promotedOnly = lines({
    warnings: [],
    testdataQuality: { ...receipt, search: { attempts: 0, budget: 16, found: 1, unplaced: 0, promoted: 1 } }
  });
  assert(promotedOnly.includes("1 small counterexample from differential testing used"));
  assert(!promotedOnly.some(line => line.startsWith("Extra search")));
});

test("a subtask given more cases than its share of points says why, also before any receipt", () => {
  const caseCapacity = [{ subtask: 2, from: 1, to: 3, targets: ["only_two", "edge"] }];
  assert.deepEqual(lines({ warnings: [], caseCapacity }), [
    "Subtask 2 has 3 test cases instead of 1, so that a counterexample can be built for only_two, edge; its points are shared by its 3 test cases."
  ]);
  const both = lines({ warnings: [], caseCapacity, testdataQuality: oldReceipt() });
  assert.equal(both.length, 4);
  assert.match(both[0], /^Subtask 2 has 3 test cases/);
});

test("the run summary counts distinct final inputs when some repeat", () => {
  const result = {
    execution: {
      operation: "k".repeat(64),
      origin: "local",
      result: "new",
      attempt: "a",
      runtime: { judgeProgram: "j".repeat(64), sandboxImage: "s", arch: "x64" },
      startedAt: "2026-11-05T10:00:00.000Z",
      finishedAt: "2026-11-05T10:01:00.000Z",
      reuse: { builds: 0, inputs: 0 }
    }
  };
  const summary = corpus =>
    text(
      componentHarness("pages/ai/AiScoringReview.tsx", {
        deps,
        component: "AiRunSummary",
        props: { result: { ...result, corpus } }
      }).all(() => true)[0]
    );
  assert.match(
    summary({ digest: "d", cases: 12, adversarial: 2, distinct: 10 }),
    /^Made on this server · 12 cases \(2 adversarial, 10 distinct inputs\)$/
  );
  assert.match(
    summary({ digest: "d", cases: 12, adversarial: 0, distinct: 11 }),
    / · 12 cases \(11 distinct inputs\)$/
  );
  // All distinct, or a receipt without the count: as before
  assert.match(summary({ digest: "d", cases: 12, adversarial: 0, distinct: 12 }), / · 12 cases$/);
  assert.match(summary({ digest: "d", cases: 12, adversarial: 0 }), / · 12 cases$/);
});

test("the new warnings have messages and are listed with the job", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = name => fs.readFileSync(path.join(__dirname, "../src/pages/ai", name), "utf8");
  const api = source("api.ts");
  const jobs = source("AiJobs.tsx");
  const shown = jobs.slice(jobs.indexOf("GENERATED_DATA_REVIEW_RECOMMENDED"), jobs.indexOf("].includes(warning)"));
  for (const warning of ["CASE_CAPACITY_ADJUSTED", "DIFFERENTIAL_INPUTS_REPEATED", "FINAL_CASES_REPEATED"]) {
    assert.match(api, new RegExp(`\\n  ${warning}: \\[\\n    "[^"]+",\\n    "[^"]+"\\n  \\]`), warning);
    assert(shown.includes(`"${warning}"`), warning);
  }
});
