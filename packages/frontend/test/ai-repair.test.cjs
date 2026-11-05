// Run: node --test packages/frontend/test/ai-repair.test.cjs
// A job's repairs, and its stop for its owner's decision (review Part III, W04): real component code; the AI API and
// widgets are mocked.
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
const page = "pages/ai/AiRepairs.tsx";
const revision = (overrides = {}) => ({
  round: 1,
  role: "quality-alt-0",
  by: "automatic",
  observationId: "o1",
  failure: { kind: "compile_error", phase: "compile-quality-alt-0" },
  from: "a".repeat(64),
  to: "b".repeat(64),
  at: "2026-11-05T10:00:00.000Z",
  test: "passed",
  result: "passed",
  ...overrides
});
const job = (repair, overrides = {}) => ({
  id: "11111111-2222-4333-8444-555555555555",
  action: "testdata",
  status: "failed",
  progress: 60,
  step: "testdata.quality-differential",
  retryOptions: ["repair", "regenerate"],
  repairRoles: ["std", "quality-oracle"],
  result: {
    warnings: [],
    repair: { automatic: 1, limits: { automatic: 3, total: 8 }, revisions: [], ...repair }
  },
  ...overrides
});
const review = (overrides = {}) => ({
  reason: "ATTRIBUTION",
  roles: ["std", "quality-oracle"],
  observationId: "o2",
  kind: "solver_disagreement",
  role: "std",
  subject: "differential case 4",
  at: "2026-11-05T10:05:00.000Z",
  ...overrides
});

test("a job that stopped for its owner says why and offers to repair each program involved, or write them all again", () => {
  const calls = [];
  const h = componentHarness(page, {
    deps,
    props: { job: job({ review: review() }), busy: false, onRetry: (...args) => calls.push(args) }
  });
  const box = text(h.find("Message"));
  assert.match(box, /^The job stopped for your decision/);
  assert.match(box, /Outputs differ · std\.cpp · differential case 4/);
  // Not twice when the job's card shows the failure
  const shown = componentHarness(page, {
    deps,
    props: {
      job: {
        ...job({ review: review() }),
        result: { ...job({ review: review() }).result, failure: { kind: "solver_disagreement" } }
      },
      busy: false,
      onRetry() {}
    }
  });
  assert.doesNotMatch(text(shown.find("Message")), /differential case 4/);
  assert.match(box, /nothing trusted \(such as a statement sample\) says which one is wrong/);
  const buttons = h.all(node => node.type?.name === "Button");
  assert.deepEqual(
    buttons.map(button => text(button)),
    ["Repair std.cpp", "Repair brute-force oracle", "Write all programs again"]
  );
  assert.equal(buttons[0].props.primary, true);
  for (const button of buttons) button.props.onClick();
  assert.deepEqual(calls, [["repair", "std"], ["repair", "quality-oracle"], ["regenerate"]]);
});

test("each reason reads as a decision for the owner", () => {
  for (const [reason, shown, roles = []] of [
    ["PROBLEM_HELPER", /The problem's own checker failed\. The job never changes the problem's own programs/],
    ["TUTORIAL_REFERENCE", /the tutorial stays as it is/, ["std"]],
    ["CAPACITY", /no test case could be replaced/],
    ["REPAIR_LIMIT", /made its 3 automatic repairs/, ["make"]],
    ["REPAIR_LIMIT", /made all 8 repairs it may make/],
    ["UNCHANGED", /still fails the same way/, ["make", "validator"]],
    ["IDENTICAL", /proposed the program unchanged/, ["make"]],
    ["INFRASTRUCTURE", /not the programs\)\. Retry later/],
    ["EVIDENCE", /couldn't be tested against it/, ["make"]],
    ["UNCLASSIFIED", /Nothing in the failure says which/]
  ]) {
    const h = componentHarness(page, {
      deps,
      props: {
        job: job(
          { review: review({ reason, roles, role: reason === "PROBLEM_HELPER" ? "checker" : "make" }) },
          { repairRoles: roles }
        ),
        busy: false,
        onRetry() {}
      }
    });
    assert.match(text(h.find("Message")), shown, reason);
    assert.equal(
      h.all(node => node.type?.name === "Button" && /^Repair/.test(text(node))).length,
      roles.length,
      reason
    );
  }
});

test("the repairs say which program changed, for what, who chose it, and what came of it", () => {
  const revisions = [
    revision(),
    revision({
      round: 2,
      role: "make",
      failure: { kind: "validator_rejection", phase: "generate", subject: "case 3 (subtask 1, case index 3)" },
      test: "untested",
      result: "validator_rejection"
    }),
    revision({ round: 3, role: "std", by: "owner", test: "failed", result: undefined }),
    revision({ round: 4, role: "quality-challenge-1", rejected: "IDENTICAL", test: undefined, result: undefined })
  ];
  const h = componentHarness(page, {
    deps,
    props: { job: job({ revisions, automatic: 3 }, { status: "running" }), busy: false, onRetry() {} }
  });
  assert.equal(h.all(node => node.type?.name === "Message").length, 0, "no decision while it runs");
  assert.match(text(h.all(node => node.type === "p")), /Repairs · 3 of 3 automatic repairs made/);
  const items = h.all(node => node.type === "li").map(text);
  assert.deepEqual(items, [
    "alternative 1 · Compilation failed · made by the job · passed the kept failure · the run after it passed",
    "make.cpp · The input validator rejected an input (case 3 (subtask 1, case index 3)) · made by the job · not tested alone (the failure isn't this program's, or wasn't kept) · the run after it: The input validator rejected an input",
    "std.cpp · Compilation failed · you chose it · still fails the kept failure",
    "challenge 2 · Compilation failed · made by the job · not used: the program was unchanged"
  ]);
});

test("a job without repairs shows nothing; a queued owner's repair says what happens next", () => {
  const none = componentHarness(page, {
    deps,
    props: { job: { ...job({}), result: { warnings: [] } }, busy: false, onRetry() {} }
  });
  assert.equal(text(none.all(() => true)[0]), "");
  const queued = componentHarness(page, {
    deps,
    props: {
      job: job({ pending: { role: "quality-oracle", observationId: "o2" } }, { status: "queued" }),
      busy: false,
      onRetry() {}
    }
  });
  assert.match(
    text(queued.all(node => node.type === "p")),
    /Repairing brute-force oracle first, then running all programs again/
  );
});

test("a finished job's summary counts the repairs its test data was made after", () => {
  const h = componentHarness("pages/ai/AiScoringReview.tsx", {
    deps,
    component: "AiRunSummary",
    props: {
      result: {
        execution: {
          operation: "k".repeat(64),
          origin: "local",
          result: "new",
          attempt: "a",
          runtime: { judgeProgram: "j".repeat(64), sandboxImage: "s", arch: "x64" },
          startedAt: "2026-11-05T10:00:00.000Z",
          finishedAt: "2026-11-05T10:01:00.000Z",
          reuse: { builds: 7, inputs: 40 }
        },
        corpus: { digest: "d", cases: 10, adversarial: 0 },
        revision: { digest: "r", repairs: 2 }
      }
    }
  });
  assert.match(
    text(h.all(() => true)[0]),
    /Made on this server · 7 programs taken from earlier builds · 40 inputs the same generator made in an earlier run · after 2 repairs · 10 cases/
  );
});
