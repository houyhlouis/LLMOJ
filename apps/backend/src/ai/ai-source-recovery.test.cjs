/* Service integration uses the real bounded search module and synthetic providers only. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const { AiService } = require("./ai.service.ts");
const { AiError } = require("./ai.types.ts");
const official = "https://atcoder.jp/contests/abc081/tasks/abc081_b";
const core = "Repeatedly divide every number by two while all numbers are even.";
const bounds = "1 <= N <= 200";
const evidence = JSON.stringify({ results: [{ url: official, title: "Shift only", content: `${core} ${bounds}. Count the number of simultaneous operations.` }] });
function fixture(options = {}) {
  const state = { searches: [], models: [], writes: [], checkpoints: [], snapshotChecks: 0, jobChecks: 0 };
  const service = new AiService({ getRepository: () => ({ update: async (id, value) => state.writes.push({ id, value }) }) }, {}, {}, {}, {}, {}, {});
  service.references = async (_job, _config, query, required) => {
    assert.equal(required, true);
    state.searches.push(query);
    if (options.providerFails) throw new AiError("SEARCH_NETWORK_ERROR");
    return options.noEvidence ? "[]" : evidence;
  };
  service.model = async (_config, prompt) => {
    state.models.push(prompt);
    if (prompt.startsWith("Identify candidate original")) return { candidates: options.noCandidate ? [] : [{ url: official, title: "Shift only" }], queries: [] };
    if (prompt.startsWith("Independently verify")) return {
      sameProblem: !options.mismatch, pageType: "problem", originalTitle: "Shift only", contradictions: [],
      matches: [{ aspect: "core", quote: core }, { aspect: "constraints", quote: bounds }], reason: "Matching operations and constraints."
    };
    throw new Error("Unexpected source prompt");
  };
  service.assertJob = async () => { state.jobChecks++; if (options.cancelBeforeProvider) throw new AiError("JOB_CANCELLED"); return { id: 1 }; };
  service.assertSnapshot = async () => { state.snapshotChecks++; if (options.cancelBeforeWrite) throw new AiError("PROBLEM_CHANGED_DURING_AI"); return { id: 1 }; };
  service.checkpoint = async (job, stage) => {
    state.checkpoints.push({ stage, state: JSON.parse(JSON.stringify(job.state)) });
    if (options.interruptCompleted && stage === "source.completed") throw new AiError("SIMULATED_RESTART");
  };
  const job = { action: options.action || "source", progress: 12, state: options.state || {} };
  const problem = { id: 14, originalProblem: options.existingSource || "" };
  const snapshot = { statements: [{ locale: "en_US", title: "Local renamed division", contentSections: [{ text: core }] }], samples: [], judgeInfo: {} };
  require("./ai-commit.fixture.cjs").commitFixture(service, job, problem, snapshot, async (id, value) => state.writes.push({id, value}));
  const run = () => service.edit(job, { id: 1 }, problem, { search: { apiKey: options.noConfiguration ? "" : "synthetic-unused-key" } }, snapshot, "source");
  return { run, state, job };
}
const assertSourceWrite = state => {
  assert.deepEqual(state.writes, [{ id: 14, value: { originalProblem: official, originalProblemTitle: "Shift only" } }]);
  assert.equal(state.snapshotChecks, 1);
};
test("service writes verified metadata only after snapshot and permission validation", async () => {
  const { run, state, job } = fixture();
  await run();
  assertSourceWrite(state);
  assert.equal(state.searches.length, 3);
  assert.equal(state.models.length, 2);
  assert.deepEqual(job.state.sourceSearch, { status: "verified", searchCount: 3 });
  assert.equal(job.state.sourceSearchTrace.resolved.url, official);
  assert(state.jobChecks > state.searches.length + state.models.length);
  assert(state.checkpoints.some(x => x.stage === "source.verifying"));
});
test("unverified source produces an explicit bounded not-found result and no guessed metadata", async () => {
  const { run, state, job } = fixture({ noEvidence: true, noCandidate: true });
  await run();
  assert.deepEqual(state.writes, []);
  assert.equal(job.state.sourceSearch.status, "not_found");
  assert.equal(job.state.sourceVerification, "no_search_results");
  assert(job.state.warnings.includes("SOURCE_NOT_FOUND"));
  assert(state.searches.length <= 8);
  assert(state.models.length <= 4);
});
test("same URL with incompatible semantics never overwrites source metadata", async () => {
  const { run, state, job } = fixture({ mismatch: true });
  await run();
  assert.deepEqual(state.writes, []);
  assert.equal(job.state.sourceSearch.status, "not_found");
});
test("source search cannot publish after problem or permission changes", async () => {
  const { run, state } = fixture({ cancelBeforeWrite: true });
  await assert.rejects(run(), /PROBLEM_CHANGED_DURING_AI/);
  assert.deepEqual(state.writes, []);
});
test("cancelled jobs do not call search or model providers", async () => {
  const { run, state } = fixture({ cancelBeforeProvider: true });
  await assert.rejects(run(), /JOB_CANCELLED/);
  assert.deepEqual(state.searches, []);
  assert.deepEqual(state.models, []);
  assert.deepEqual(state.writes, []);
});
test("provider network failures stay failures rather than being reported as not-found", async () => {
  const { run, state, job } = fixture({ providerFails: true });
  await assert.rejects(run(), /SEARCH_NETWORK_ERROR/);
  assert.deepEqual(state.writes, []);
  assert.notEqual(job.state.sourceSearch?.status, "not_found");
});
test("restart between verified checkpoint and metadata write reuses evidence without charging another request", async () => {
  const first = fixture({ interruptCompleted: true });
  await assert.rejects(first.run(), /SIMULATED_RESTART/);
  assert.deepEqual(first.state.writes, []);
  const restored = fixture({ state: JSON.parse(JSON.stringify(first.job.state)) });
  await restored.run();
  assertSourceWrite(restored.state);
  assert.deepEqual(restored.state.searches, []);
  assert.deepEqual(restored.state.models, []);
});
test("existing user-entered original source is preserved without calling providers", async () => {
  const { run, state } = fixture({ existingSource: "https://example.org/manual-source" });
  await run();
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.searches, []);
  assert.deepEqual(state.models, []);
});
test("explicit source action requires configured search credentials", async () => {
  const { run, state } = fixture({ noConfiguration: true });
  await assert.rejects(run(), /SEARCH_NOT_CONFIGURED/);
  assert.deepEqual(state.searches, []);
});
test("pipeline without search credentials continues with a visible warning", async () => {
  const { run, state, job } = fixture({ noConfiguration: true, action: "all" });
  await run();
  assert.deepEqual(state.writes, []);
  assert.deepEqual(state.searches, []);
  assert.deepEqual(job.state.sourceSearch, { status: "not_configured", searchCount: 0 });
  assert(job.state.warnings.includes("SEARCH_NOT_CONFIGURED"));
});
test("a newly verified source removes stale not-found warnings without removing unrelated warnings", async () => {
  const { run, job } = fixture({ state: { warnings: ["SOURCE_NOT_FOUND", "OTHER_WARNING"] } });
  await run();
  assert.deepEqual(job.state.warnings, ["OTHER_WARNING"]);
});


test("import admission checkpoints explicit source candidates before the model can strip metadata", async () => {
  const service = Object.create(AiService.prototype);let stored;
  service.requirePrivilege = async () => {};
  service.problems = { userHasCreateProblemPermission: async () => true };
  service.config = async () => ({ llm: { apiKey: "synthetic-not-used", model: "fixture" } });
  const repository = { countBy: async () => 0, save: async row => { stored = row; return row; } };
  service.db = { transaction: async run => run({ findOne: async () => ({}), getRepository: () => repository }) };
  service.recordAiAudit = async () => {};service.work = async () => {};
  await service.start({ id: 4 }, { action: "import", markdown: "原题：https://www.luogu.com.cn/problem/P7077\nRead input and call functions.", count: 5 });
  assert.deepEqual(stored.state.sourceHints, ["https://www.luogu.com.cn/problem/P7077"]);
  assert.deepEqual(stored.state.completed, []);
});

test("persisted import source candidates survive extraction that omitted the original link", async () => {
  const checked = fixture({ state: { sourceHints: [official] } });
  await checked.run();assertSourceWrite(checked.state);assert(checked.state.searches[0].startsWith(official));
  assert.equal(checked.state.models.length, 1);
});
