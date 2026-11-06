/* Credential-free tests of a job's evidence and cost (review Part III, §8.1/§8.4). */
// What each repair changed (a bounded unified diff), each run of the programs, and what the model requests were for
// and used, kept with the job and shown to its owner.
const { test } = require("node:test");
const assert = require("node:assert/strict");
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
const { AI_SESSION_LIMITS, purposeOfStep, recordRun, tallyUsage, unifiedDiff } = require("./ai-session.ts");
const { aiServices } = require("./ai-test-services.cjs");
const { currentAiRuntime, currentAiPurpose, withAiPurpose } = require("./ai-runtime.ts");

const lines = count => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

test("a change is a unified diff with three lines of context, removed lines first", () => {
  assert.deepEqual(unifiedDiff("a\nb\nc", "a\nb\nc"), { text: "", added: 0, removed: 0, truncated: false });
  const before = lines(20).join("\n");
  const after = lines(20)
    .map((line, index) => (index === 9 ? "changed 10" : line))
    .join("\n");
  assert.equal(
    unifiedDiff(before, after).text,
    [
      "@@ -7,7 +7,7 @@",
      " line 7",
      " line 8",
      " line 9",
      "-line 10",
      "+changed 10",
      " line 11",
      " line 12",
      " line 13",
      ""
    ].join("\n")
  );
  // Two changes far apart: two hunks; close together: one
  const far = lines(30);
  far[2] = "x";
  far[25] = "y";
  const twoHunks = unifiedDiff(lines(30).join("\n"), far.join("\n"));
  assert.equal(twoHunks.text.match(/^@@/gm).length, 2);
  assert.deepEqual([twoHunks.added, twoHunks.removed], [2, 2]);
  const near = lines(30);
  near[2] = "x";
  near[7] = "y";
  assert.equal(unifiedDiff(lines(30).join("\n"), near.join("\n")).text.match(/^@@/gm).length, 1);
  // Lines added and removed at the start and the end
  assert.deepEqual(unifiedDiff("b\nc", "a\nb\nc\nd"), {
    text: "@@ -1,2 +1,4 @@\n+a\n b\n c\n+d\n",
    added: 2,
    removed: 0,
    truncated: false
  });
  assert.equal(unifiedDiff("a\nb\nc", "a\nc").text, "@@ -1,3 +1,2 @@\n a\n-b\n c\n");
});

test("a change too large to compare line by line is shown as replaced; a long one keeps its start", () => {
  const before = lines(3000).join("\n");
  const after = lines(3000)
    .map(line => `${line}!`)
    .join("\n");
  assert(3000 * 3000 > AI_SESSION_LIMITS.diffCells);
  const replaced = unifiedDiff(before, after);
  assert.deepEqual([replaced.added, replaced.removed], [3000, 3000]);
  assert(replaced.truncated);
  assert(Buffer.byteLength(replaced.text) <= AI_SESSION_LIMITS.diffBytes);
  assert(replaced.text.endsWith("\n"), "whole lines");
  assert(replaced.text.startsWith("@@ -1,3000 +1,3000 @@\n-line 1\n"));
});

test("a request's purpose is the job's step when it was made", () => {
  for (const [step, purpose] of [
    ["import", "import"],
    ["source", "source"],
    ["source.search", "source"],
    ["translate", "translate"],
    ["tags", "tags"],
    ["difficulty", "difficulty"],
    ["tutorial", "tutorial"],
    ["testdata.plan", "plan"],
    ["testdata.quality-plan", "plan"],
    ["testdata.make", "programs"],
    ["testdata.challenge", "programs"],
    ["testdata.std", "programs"],
    ["testdata.repair", "repairs"],
    ["queued", "other"],
    ["", "other"]
  ])
    assert.equal(purposeOfStep(step), purpose, step);
});

test("requests are tallied by purpose; searches, failures and unreported usage apart", () => {
  const state = {};
  const record = (overrides = {}) => ({
    target: "llm",
    operation: "generate",
    success: true,
    inputTokens: 100,
    outputTokens: 20,
    usageReported: true,
    ...overrides
  });
  tallyUsage(state, "testdata.make", record());
  tallyUsage(state, "testdata.validator", record({ inputTokens: 50, outputTokens: 5 }));
  tallyUsage(
    state,
    "testdata.repair",
    record({ success: false, inputTokens: null, outputTokens: null, usageReported: false })
  );
  tallyUsage(state, "source", record({ target: "search", inputTokens: null, outputTokens: null }));
  assert.deepEqual(state.spending, {
    programs: { generations: 2, requests: 2, failed: 0, searches: 0, inputTokens: 150, outputTokens: 25, unreported: 0 },
    repairs: { generations: 1, requests: 1, failed: 1, searches: 0, inputTokens: 0, outputTokens: 0, unreported: 1 },
    source: { generations: 0, requests: 0, failed: 0, searches: 1, inputTokens: 0, outputTokens: 0, unreported: 0 }
  });
});

// Review Part IV, W01: one generation recovered by polling is one generation and as many transport requests as were
// sent; its usage, reported by the poll that completes it, is counted once and resolves the generation
test("one background generation and 100 polls: one generation, 101 requests, usage once", () => {
  const state = {};
  const base = { target: "llm", success: true, inputTokens: null, outputTokens: null, usageReported: false };
  tallyUsage(state, "testdata.make", {
    ...base,
    operation: "generate",
    generationId: "g1",
    purpose: "programs",
    pendingResponseId: "resp_1"
  });
  for (let index = 0; index < 99; index++)
    tallyUsage(state, "testdata.make", { ...base, operation: "responses.poll", generationId: "g1", purpose: "programs" });
  // After the first poll, the job's step changed: the requests still belong to what they were sent for
  tallyUsage(state, "testdata.validator", {
    ...base,
    operation: "responses.poll",
    generationId: "g1",
    purpose: "programs",
    inputTokens: 100,
    outputTokens: 200,
    usageReported: true
  });
  assert.deepEqual(state.spending, {
    programs: { generations: 1, requests: 101, failed: 0, searches: 0, inputTokens: 100, outputTokens: 200, unreported: 0 }
  });
  // A generation whose usage was never reported stays unresolved
  tallyUsage(state, "testdata.validator", { ...base, operation: "generate", generationId: "g2", purpose: "programs" });
  assert.equal(state.spending.programs.unreported, 1);
  assert.equal(state.spending.programs.generations, 2);
});

test("a request is attributed to the purpose it was sent for, not the job's step when it's recorded", () => {
  const state = {};
  tallyUsage(state, "testdata.make", {
    target: "llm",
    operation: "generate",
    purpose: "plan",
    success: true,
    inputTokens: 5,
    outputTokens: 1,
    usageReported: true
  });
  // An unknown purpose falls back to the step
  tallyUsage(state, "testdata.make", {
    target: "llm",
    operation: "generate",
    purpose: "x",
    success: true,
    inputTokens: 5,
    outputTokens: 1,
    usageReported: true
  });
  assert.deepEqual(Object.keys(state.spending).sort(), ["plan", "programs"]);
});

test("a job keeps its latest runs only", () => {
  const state = {};
  for (let index = 0; index < AI_SESSION_LIMITS.runs + 5; index++)
    recordRun(state, { at: new Date().toISOString(), operation: "generate", seconds: index, result: "passed" });
  assert.equal(state.runs.length, AI_SESSION_LIMITS.runs);
  assert.equal(state.runs[0].seconds, 5);
});

test("a job's provider requests are counted by its step as they're recorded", async () => {
  const services = aiServices({}, {}, {}, {});
  const recorded = [];
  services.usage = {
    context: (ownerId, jobId) => ({ ownerId, jobId, record: async record => recorded.push(record) })
  };
  const job = { id: "j", ownerId: 1, step: "testdata.make", state: {} };
  await services.withRuntime(1, job, async () => {
    await currentAiRuntime().record({
      target: "llm",
      success: true,
      inputTokens: 10,
      outputTokens: 2,
      usageReported: true
    });
    job.step = "testdata.repair";
    await currentAiRuntime().record({
      target: "llm",
      success: true,
      inputTokens: 7,
      outputTokens: 1,
      usageReported: true
    });
  });
  assert.equal(recorded.length, 2, "and recorded as before");
  assert.deepEqual(
    Object.fromEntries(Object.entries(job.state.spending).map(([purpose, item]) => [purpose, item.inputTokens])),
    { programs: 10, repairs: 7 }
  );
  // Requests of no job (the configuration page) are only recorded
  await services.withRuntime(1, undefined, async () => {
    await currentAiRuntime().record({ target: "llm", success: true, usageReported: false });
  });
  assert.equal(recorded.length, 3);
});

test("a job's requests carry the purpose of the step they were sent in", async () => {
  const services = aiServices({}, {}, {}, {});
  const recorded = [];
  services.usage = {
    context: (ownerId, jobId) => ({ ownerId, jobId, record: async record => recorded.push(record) })
  };
  const job = { id: "j", ownerId: 1, step: "testdata.quality-plan", state: {} };
  const purposes = [];
  await services.withRuntime(1, job, async () => {
    purposes.push(currentAiPurpose());
    job.step = "testdata.make";
    purposes.push(currentAiPurpose());
    purposes.push(await withAiPurpose("repairs", async () => currentAiPurpose()));
  });
  assert.deepEqual(purposes, ["plan", "programs", "repairs"]);
});

test("the job view shows runs and spending, each repair's size, and its change on request", async () => {
  const diff = unifiedDiff("int main(){}", "int main(){return 0;}");
  const job = {
    id: "0f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f",
    ownerId: 1,
    action: "testdata",
    status: "completed",
    input: { count: 5 },
    state: {
      runs: [{ at: "2026-11-05T10:00:00.000Z", operation: "generate", seconds: 12.5, result: "passed" }],
      spending: {
        programs: { requests: 7, failed: 0, searches: 0, inputTokens: 700, outputTokens: 70, unreported: 0 }
      },
      repair: {
        version: 1,
        automatic: 1,
        infrastructure: 0,
        revisions: [{ round: 1, role: "std", by: "automatic", signature: "s", from: "a", to: "b", diff }]
      }
    }
  };
  const services = aiServices({}, {}, { find: async () => [job], findOneBy: async () => job }, {});
  services.usage = {
    jobTotals: async (ownerId, ids) => {
      assert.deepEqual([ownerId, ids], [1, [job.id]]);
      return new Map([
        [job.id, { requests: 9, searches: 0, failed: 1, inputTokens: 900, outputTokens: 90, unreported: 0 }]
      ]);
    }
  };
  services.policy = async () => ({ paused: false });
  const [view] = (await services.listJobs({ id: 1 })).jobs;
  assert.deepEqual(view.result.evidence, {
    runs: job.state.runs,
    spending: job.state.spending,
    usage: { requests: 9, searches: 0, failed: 1, inputTokens: 900, outputTokens: 90, unreported: 0 }
  });
  // The job list carries each change's size only
  assert.deepEqual(view.result.repair.revisions[0].diff, { added: 1, removed: 1, truncated: false });
  assert.equal(view.result.repair.revisions[0].signature, undefined);
  services.coordinator.assertEvidenceAccess = async () => undefined;
  services.services.facade.evidence = {};
  assert.deepEqual(await services.repairChange({ id: 1 }, { jobId: job.id, round: 1 }), {
    round: 1,
    role: "std",
    from: "a",
    to: "b",
    ...diff
  });
  await assert.rejects(services.repairChange({ id: 1 }, { jobId: job.id, round: 2 }), /NO_SUCH_REPAIR/);
});
