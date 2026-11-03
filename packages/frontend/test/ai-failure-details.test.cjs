// Run: node --test packages/frontend/test/ai-failure-details.test.cjs
// A failed AI job's runs with their evidence (review Part III, W01): real component code; the AI API and widgets are
// mocked.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { componentHarness } = require("./helpers/component-harness.cjs");

const page = "pages/ai/AiFailureDetails.tsx";
const plain = value => JSON.parse(JSON.stringify(value));
const text = node => (node == null || typeof node === "boolean" ? "" : typeof node !== "object" ? String(node) : Array.isArray(node) ? node.map(text).join("") : text(node.props?.children));

// The AI API as aiCall reaches it, answering from `answers` by method
function aiApi(answers, calls) {
  return {
    axios: {
      post: async (url, body) => {
        const method = url.replace(/^.*api\/ai\//, "");
        calls.push({ method, body });
        const answer = answers[method];
        if (!answer) return { status: 200, data: { error: "NO_SUCH_JOB" }, headers: {} };
        return { status: 200, data: typeof answer === "function" ? answer(body) : answer, headers: {} };
      },
      isCancel: () => false
    },
    "@/utils/callApiWithFileUpload": { callApiWithFileUpload: async () => ({}) },
    "@/utils/session": { noteSessionEnded() {}, responseRequestId() {}, sessionHeaders: () => ({}) }
  };
}

const job = (overrides = {}) => ({
  id: "11111111-2222-4333-8444-555555555555",
  action: "testdata",
  status: "failed",
  progress: 50,
  step: "testdata.quality-differential",
  error: "SANDBOX_GENERATION_FAILED: Output mismatch: standard differential case 7",
  result: { observationCount: 2, warnings: [], ...overrides }
});
const artifact = (role, overrides = {}) => ({
  name: `0.${role}`,
  role,
  classification: "author-private",
  size: 9,
  originalSize: 9,
  sha256: "a".repeat(64),
  preview: `${role} text`,
  binary: false,
  stored: true,
  ...overrides
});
const observation = (overrides = {}) => ({
  id: "aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee",
  createdAt: "2026-11-03T10:00:00.000Z",
  expiresAt: "2026-11-17T10:00:00.000Z",
  evidence: "stored",
  current: true,
  kind: "solver_disagreement",
  fatal: true,
  origin: "judge",
  operation: "generate",
  phase: "quality-differential",
  role: "std",
  subject: "differential case 7",
  subtask: 2,
  scenarioIndex: 31,
  verdict: "WA",
  expectedBasis: "candidate_oracle",
  execution: { status: "OK", exitCode: 0, timeMs: 12.4, memoryBytes: 3145728, timeLimitMs: 1000, memoryLimitBytes: 268435456 },
  difference: { unit: "token", index: 3, actualLine: 1, expectedLine: 1, actual: "5", expected: "6" },
  summary: "Output mismatch: standard differential case 7",
  artifacts: [artifact("input"), artifact("actual"), artifact("expected")],
  ...overrides
});

test("nothing is shown for a job without kept failures", () => {
  const calls = [];
  const h = componentHarness(page, { props: { job: job({ observationCount: 0 }) }, deps: aiApi({}, calls) });
  assert.equal(h.all(node => node.type?.name === "Button").length, 0);
});

test("the details load the job's failures when opened, and hide again", async () => {
  const calls = [];
  const failures = [observation(), observation({ id: "bbbbbbbb-bbbb-5ccc-8ddd-eeeeeeeeeeee", current: false })];
  const h = componentHarness(page, { props: { job: job() }, deps: aiApi({ failures: { failures } }, calls) });
  assert.equal(text(h.find("Button")), "Failure details (2)");
  await h.click("Button");
  assert.deepEqual(plain(calls), [{ method: "failures", body: { jobId: "11111111-2222-4333-8444-555555555555" } }]);
  const shown = h.all(node => node.type?.name === "ObservationView");
  assert.deepEqual(shown.map(node => node.props.observation.id), failures.map(failure => failure.id));
  assert.equal(h.find("Button").props["aria-expanded"], true);
  await h.click("Button");
  assert.equal(h.all(node => node.type?.name === "ObservationView").length, 0);
});

test("a refusal (e.g. the problem can no longer be edited) is shown instead", async () => {
  const calls = [];
  const h = componentHarness(page, { props: { job: job() }, deps: aiApi({ failures: { error: "PERMISSION_DENIED" } }, calls) });
  await h.click("Button");
  assert.match(h.find("Message").props.content, /permission/i);
});

test("an observation says what failed, how, and what it was compared with", () => {
  const h = componentHarness(page, { component: "ObservationView", props: { job: job(), observation: observation() }, deps: aiApi({}, []) });
  const all = text(h.all(node => node.type === "p"));
  assert.match(all, /Outputs differ · std\.cpp · Check random and boundary inputs · ended the latest run/);
  assert.match(all, /differential case 7 · subtask 2 · case index 31 \(not a seed/);
  assert.match(all, /WA · OK · exit code 0 · 12 ms \/ 1000 ms · 3145728 B \/ 268435456 B/);
  assert.match(all, /Compared with the oracle's output \(also AI-written; not proof\)/);
  assert.match(all, /First difference at token 3 \(line 1\): expected 6, found 5/);
  assert.match(all, /Evidence kept until /);
  assert.deepEqual(h.all(node => node.type?.name === "ArtifactView").map(node => node.props.artifact.role), ["input", "actual", "expected"]);
});

test("a challenge that survived says whether its search could run, and its small counterexample isn't a rejection", () => {
  const survived = observation({
    kind: "challenge_survived",
    role: "quality-challenge-0",
    candidate: "greedy",
    phase: "quality-adversarial",
    subject: undefined,
    subtask: undefined,
    scenarioIndex: undefined,
    verdict: undefined,
    execution: undefined,
    difference: undefined,
    expectedBasis: undefined,
    search: { attempts: 0, budget: 16, stoppedBy: "capacity" },
    evidence: "none",
    artifacts: []
  });
  let h = componentHarness(page, { component: "ObservationView", props: { job: job(), observation: survived }, deps: aiApi({}, []) });
  let all = text(h.all(node => node.type === "p"));
  assert.match(all, /A wrong or slow algorithm wasn't rejected · challenge greedy/);
  assert.match(all, /stopped after 0 of 16 attempts: no test case could be replaced, so it couldn't go on/);
  assert.doesNotMatch(all, /Evidence kept/);
  const related = observation({ fatal: false, current: false, relation: "small_counterexample", role: "quality-challenge-0", candidate: "greedy", execution: undefined });
  h = componentHarness(page, { component: "ObservationView", props: { job: job(), observation: related }, deps: aiApi({}, []) });
  all = text(h.all(node => node.type === "p"));
  assert.match(all, /related: a small counterexample \(not exported, so it rejects nothing\)/);
  assert(h.all(node => node.type === "p").some(node => text(node) === "WA"), "no run measured: nothing after the verdict");
  assert.doesNotMatch(all, /ended the latest run/);
});

test("a long message (a compiler's) is shortened: all of it is in the diagnostics", () => {
  const long = observation({ kind: "compile_error", role: "make", summary: `make compilation failed: ${"x".repeat(1000)}` });
  const h = componentHarness(page, { component: "ObservationView", props: { job: job(), observation: long }, deps: aiApi({}, []) });
  const summary = text(h.all(node => node.type === "p" && /compilation failed/.test(text(node))));
  assert.equal(summary.length, 401);
  assert.match(summary, /…$/);
});

test("evidence that couldn't be kept or has expired says so", () => {
  for (const [overrides, expected] of [
    [{ evidence: "unavailable", evidenceError: "The judge machine kept no evidence: update it (judge protocol version 6)", artifacts: [] }, /The evidence couldn't be kept: The judge machine kept no evidence/],
    [{ evidence: "expired" }, /The evidence has expired and was deleted/],
    [{ evidence: "partial", evidenceError: "Only the start of an artifact was kept: the evidence limit" }, /some of it couldn't be kept: Only the start/]
  ]) {
    const h = componentHarness(page, { component: "ObservationView", props: { job: job(), observation: observation(overrides) }, deps: aiApi({}, []) });
    assert.match(text(h.all(node => node.type === "p")), expected);
  }
});

test("an artifact shows its preview, reads more in parts, and downloads through a short-lived link", async () => {
  const calls = [];
  const opened = [];
  const big = artifact("input", { size: 70000, originalSize: 300000000, preview: "1 2 3", classification: "hidden-test" });
  const parts = { 0: { offset: 0, bytes: 65536, size: 70000, text: "A", binary: false }, 65536: { offset: 65536, bytes: 4464, size: 70000, text: "B", binary: false } };
  const h = componentHarness(page, {
    component: "ArtifactView",
    props: { job: job(), observation: observation(), artifact: big },
    deps: aiApi({ failureArtifact: body => parts[body.offset], downloadFailureArtifact: { url: "https://storage.invalid/evidence" } }, calls),
    window: { open: (...args) => opened.push(args) }
  });
  assert.match(text(h.all(node => node.type === "span")), /70000 B \(of 300000000 B: only the start was kept\) · hidden test data/);
  assert.match(text(h.all(node => node.type === "pre")), /^1 2 3\n…/);
  await h.click("Button", p => text(p.children) === "Show more");
  await h.click("Button", p => text(p.children) === "Show more");
  assert.deepEqual(plain(calls.map(call => [call.method, call.body.offset])), [["failureArtifact", 0], ["failureArtifact", 65536]]);
  assert.equal(text(h.all(node => node.type === "pre")), "AB");
  assert.equal(h.all(node => node.type?.name === "Button" && text(node.props.children) === "Show more").length, 0, "all of it is shown");
  await h.click("Button", p => text(p.children) === "Download");
  assert.deepEqual(plain(calls.at(-1)), { method: "downloadFailureArtifact", body: { jobId: job().id, id: observation().id, role: "input" } });
  assert.deepEqual(plain(opened), [["https://storage.invalid/evidence", "_blank", "noopener"]]);
});

test("an artifact that wasn't kept, or whose evidence expired, offers nothing to read", () => {
  for (const [shown, props] of [
    ["Not kept: It isn't what the run reported", { artifact: artifact("actual", { stored: false, missing: "It isn't what the run reported" }) }],
    ["", { artifact: artifact("actual"), observation: observation({ evidence: "expired" }) }]
  ]) {
    const h = componentHarness(page, { component: "ArtifactView", props: { job: job(), observation: observation(), ...props }, deps: aiApi({}, []) });
    assert.equal(h.all(node => node.type?.name === "Button").length, 0);
    if (shown) assert.match(text(h.all(node => node.type === "p")), new RegExp(shown));
  }
});
