// Run: node --test packages/frontend/test/ai-evidence.test.cjs
// A job's evidence and cost, each repair's change, and the jobs waiting for their owner (review Part III, §8.1/§8.4):
// real component code; the AI API and widgets are mocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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

function aiApi(answers, calls) {
  return {
    axios: {
      post: async (url, body) => {
        const method = url.replace(/^.*api\/ai\//, "");
        calls.push({ method, body });
        const answer = answers[method];
        if (!answer) return { status: 200, data: { error: "NO_SUCH_REPAIR" }, headers: {} };
        return { status: 200, data: answer, headers: {} };
      },
      isCancel: () => false
    },
    "@/utils/callApiWithFileUpload": { callApiWithFileUpload: async () => ({}) },
    "@/utils/session": { noteSessionEnded() {}, responseRequestId() {}, sessionHeaders: () => ({}) }
  };
}

const spending = (requests, inputTokens, outputTokens, extra = {}) => ({
  requests,
  failed: 0,
  searches: 0,
  inputTokens,
  outputTokens,
  unreported: 0,
  ...extra
});
const job = evidence => ({
  id: "11111111-2222-4333-8444-555555555555",
  action: "testdata",
  status: "completed",
  progress: 100,
  step: "completed",
  result: { warnings: [], evidence }
});
const runs = [
  { at: "2026-11-05T10:00:00.000Z", operation: "generate", seconds: 14.2, result: "compile_error", origin: "judge" },
  {
    at: "2026-11-05T10:00:20.000Z",
    operation: "replay",
    seconds: 3.4,
    result: "not_reproduced",
    repair: 1,
    origin: "judge"
  },
  {
    at: "2026-11-05T10:00:30.000Z",
    operation: "generate",
    seconds: 61,
    result: "passed",
    repair: 1,
    origin: "judge",
    reuse: { builds: 5, inputs: 65 }
  }
];

test("a job's requests by purpose, the tokens reported, and its runs with how long they took", async () => {
  const h = componentHarness("pages/ai/AiEvidence.tsx", {
    props: {
      job: job({
        runs,
        spending: {
          plan: spending(2, 3000, 500),
          programs: spending(7, 20000, 9000),
          repairs: spending(1, 4000, 800, { failed: 0 }),
          source: spending(0, 0, 0, { searches: 2 })
        },
        // The recorded requests: one the job didn't count by purpose (it failed right after)
        usage: { requests: 11, searches: 2, failed: 1, inputTokens: 27500, outputTokens: 10300, unreported: 1 }
      })
    },
    deps: aiApi({}, [])
  });
  const line = text(h.all(node => node.type === "p"));
  assert.equal(
    line,
    "Evidence and cost · 11 model requests (1 failed): plans 2, programs 7, repairs 1, other 1 · 27,500 tokens in, 10,300 out (the provider reported no usage for 1) · 2 searches · 3 runs of the programs, 1 min 19 s in all Show runs"
  );
  await h.click("Button");
  assert.deepEqual(h.all(node => node.type === "li").map(text), [
    "failed: Compilation failed · 14 s · on a judge machine",
    "replay of the kept failure, testing repair 1: not reproduced · 3.4 s · on a judge machine",
    "all programs passed (after repair 1) · 1 min 1 s · on a judge machine · 5 programs and 65 inputs reused"
  ]);
  assert.equal(text(h.find("Button")), "Hide runs");
});

test("a run says only what it reused, in the singular for one", async () => {
  const h = componentHarness("pages/ai/AiEvidence.tsx", {
    props: {
      job: job({
        runs: [
          {
            at: "2026-11-05T10:00:00.000Z",
            operation: "generate",
            seconds: 59.6,
            result: "passed",
            origin: "local",
            reuse: { builds: 1, inputs: 0 }
          }
        ],
        spending: { programs: spending(7, 700, 70) }
      })
    },
    deps: aiApi({}, [])
  });
  await h.click("Button");
  assert.deepEqual(h.all(node => node.type === "li").map(text), [
    "all programs passed · 1 min 0 s · on this server · 1 program reused"
  ]);
});

test("without recorded totals the job's own counts are shown; a job without evidence shows nothing", () => {
  const counted = componentHarness("pages/ai/AiEvidence.tsx", {
    props: { job: job({ runs: [], spending: { tutorial: spending(1, 100, 50) } }) },
    deps: aiApi({}, [])
  });
  assert.equal(
    text(counted.all(node => node.type === "p")),
    "Evidence and cost · 1 model request: tutorial 1 · 100 tokens in, 50 out"
  );
  const none = componentHarness("pages/ai/AiEvidence.tsx", { props: { job: job(undefined) }, deps: aiApi({}, []) });
  assert.equal(text(none.all(() => true)[0]), "");
});

test("a repair's change is read when asked for, and shown as a diff", async () => {
  const calls = [];
  const revision = {
    round: 2,
    role: "std",
    by: "automatic",
    failure: { kind: "time_limit", phase: "generate" },
    from: "a",
    to: "b",
    at: "",
    diff: { added: 1, removed: 1, truncated: false }
  };
  const change = { text: "@@ -1,2 +1,2 @@\n #include <cstdio>\n-slow();\n+fast();\n", truncated: false };
  const h = componentHarness("pages/ai/AiRepairs.tsx", {
    component: "RepairChange",
    props: { jobId: "j", revision },
    deps: aiApi({ repairChange: change }, calls)
  });
  assert.equal(text(h.find("Button")), "Show change (+1 −1)");
  await h.click("Button");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ method: "repairChange", body: { jobId: "j", round: 2 } }]);
  // One line each (the harness has no styles: removed and added lines get their colours from Ai.module.less)
  assert.deepEqual(h.all(node => node.type === "span").map(text), [
    "@@ -1,2 +1,2 @@\n",
    " #include <cstdio>\n",
    "-slow();\n",
    "+fast();\n",
    "\n"
  ]);
  assert.equal(text(h.find("Button")), "Hide change");
  // Read once: hiding and showing again asks nothing more
  await h.click("Button");
  await h.click("Button");
  assert.equal(calls.length, 1);
});

test("a change that can't be read says why", async () => {
  const h = componentHarness("pages/ai/AiRepairs.tsx", {
    component: "RepairChange",
    props: { jobId: "j", revision: { round: 9, diff: { added: 0, removed: 0, truncated: false } } },
    deps: aiApi({}, [])
  });
  await h.click("Button");
  assert.match(text(h.all(node => node.type === "span")), /This repair doesn't exist, or its change wasn't kept\./);
});

test("My AI jobs counts the jobs waiting for a decision and can show only them", () => {
  // The list polls the server; its source is checked instead of rendered
  const source = fs.readFileSync(path.join(__dirname, "../src/pages/ai/AiJobs.tsx"), "utf8");
  assert.match(source, /job\.status === "failed" && \(job\.result\.repair\?\.review \|\| job\.result\.scoringReview\)/);
  assert.match(source, /jobs are"\} waiting for your decision\./);
  assert.match(source, /"Show only these"/);
  assert.match(source, /<AiEvidence job=\{job\} \/>/);
});
