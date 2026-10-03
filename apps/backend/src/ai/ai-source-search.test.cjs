/* All provider responses are synthetic. These tests never make API or HTTP calls. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const { discoverProblemSource, initialSourceQueries, sourceSearchDocuments } = require("./ai-source-search.ts");
const { AiError } = require("./ai.types.ts");
const clone = value => JSON.parse(JSON.stringify(value));
// Real candidate URL, but paraphrased fixture content. The product contains no hardcoded candidate.
const official = "https://qoj.ac/problem/19013";
const core = "Each day generates messages; valid unsent messages and sent unanswered messages incur different costs.";
const domain = "n <= 5000; a, b, c1, c2, d <= 100000";
const excerpt = `${core} A reply cycle begins with the first unacknowledged message and replies after d days; later sends do not move it. Daily order: send, reply, then cost. ${domain}. Sample input 3 1 3 1 1 3 yields 6.`;
const page = { url: official, title: "小 X 今天心情怎么样？", content: excerpt };
const refs = JSON.stringify({ results: [page] });
const snapshot = {
  statements: [{ locale: "zh_CN", title: "发消息", contentSections: [
    { type: "Text", sectionTitle: "题目描述", text: "每天产生a条消息，未发送和等待回复的消息各有焦虑值。首条消息开启回复周期，后续消息不改变回复时间。" },
    { type: "Text", sectionTitle: "输入格式", text: "n,a,b,c1,c2,d；n<=5000，其余<=100000。" },
    { type: "Text", sectionTitle: "数据范围与提示", text: "6个子任务，分值10/15/15/15/20/25。" }
  ] }],
  samples: [{ inputData: "3 1 3 1 1 3", outputData: "6" }, { inputData: "1 2 1 5 1 1", outputData: "2" }],
  judgeInfo: { timeLimit: 1000, memoryLimit: 256, fileIo: { inputFilename: "message.in", outputFilename: "message.out" } }
};
const candidate = { candidates: [{ url: official, title: page.title }], queries: [] };
const confirmation = { sameProblem: true, pageType: "problem", originalTitle: page.title,
  matches: [{ aspect: "core", quote: core }, { aspect: "constraints", quote: domain }], contradictions: [], reason: "Core rules and full bounds agree; local adaptations are preserved." };
function fixture(overrides = {}, options = {}, problem = snapshot) {
  const calls = { search: [], model: [], progress: [], checks: 0 };
  const dependencies = {
    checkActive: async () => { calls.checks++; await overrides.checkActive?.(calls); },
    search: async query => { calls.search.push(query); return overrides.search ? overrides.search(query, calls) : refs; },
    model: async prompt => { calls.model.push(prompt); return overrides.model ? overrides.model(prompt, calls) : clone(prompt.startsWith("Independently verify") ? confirmation : candidate); },
    onProgress: async progress => { calls.progress.push(clone(progress)); await overrides.onProgress?.(progress, calls); }
  };
  return { calls, run: () => discoverProblemSource(clone(problem), dependencies, options) };
}

test("structured result documents ignore metadata and distinguish cited links", () => {
  const other = "https://example.org/editorial";
  const docs = sourceSearchDocuments(JSON.stringify({ query: "https://fake.org/query", answer: "https://fake.org/answer",
    request: { url: "https://fake.org/request" }, results: [{ url: other, title: "editorial", content: `Original ${official}. ${core}` }] }));
  assert.deepEqual(docs.map(x => x.url), [other, official]);
  assert.equal(docs[0].citation, undefined);
  assert.equal(docs[1].citation, true);
});
test("nested MCP JSON exposes actual result content without scanning metadata", () => {
  const docs = sourceSearchDocuments(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ results: [page], query: "https://fake.org" }) }] }));
  assert.deepEqual(docs, [page]);
  assert.deepEqual(sourceSearchDocuments('{"results": [{"url":"https://fake.org"'), []);
});
test("a direct problem result takes precedence over a longer editorial citation", () => {
  const docs = sourceSearchDocuments(JSON.stringify({ results: [{ url: "https://example.org/editorial", content: `${official} ${"editorial ".repeat(100)}` }, page] }));
  const actual = docs.find(item => item.url === official);
  assert.equal(actual.citation, undefined);
  assert.equal(actual.content, excerpt);
});
test("initial queries prioritize the actual title and keep filename as a focused fallback without numeric noise", () => {
  const queries = initialSourceQueries(snapshot);
  assert.equal(queries[0].query.replace(/^"|"$/g, ""), "发消息");
  assert(queries.some(item => item.query.includes("message")));
  assert(queries.every(item => !/programming problem|competitive programming|algorithm|5000|100000|3 1 3 1 1 3/.test(item.query)));
  assert.equal(new Set(queries.map(item => item.query.toLowerCase())).size, queries.length);
  assert(queries.every(item => !item.query.includes("19013")));
});
test("renamed message problem verifies with quoted independent evidence while preserving all local adaptations", async () => {
  const before = clone(snapshot);
  const { run, calls } = fixture();
  const result = await run();
  assert.equal(result.status, "verified");
  assert.equal(result.url, official);
  assert.equal(result.title, page.title);
  assert.equal(calls.search.length, 3);
  assert.equal(calls.model.length, 2);
  assert.match(calls.model[1], /rename\/translate.*add samples or subtasks.*change time\/memory.*named-file I\/O/);
  assert.match(calls.model[1], /event order.*full-domain constraints.*overlapping sample/);
  assert.deepEqual(snapshot, before);
  assert.equal(calls.progress.at(-1).trace.resolved.url, official);
});
test("empty generic results trigger distinctive model queries and a new verification round", async () => {
  let reviews = 0;
  const focused = "message anxiety first reply cycle n 5000";
  const { run, calls } = fixture({
    search: (query, c) => query.includes(focused) || query.includes(official) || c.search.length > 2 ? refs : "[]",
    model: prompt => prompt.startsWith("Independently verify") ? confirmation : ++reviews === 1
      ? { candidates: [], queries: [{ strategy: "semantic", query: focused }], reason: "Generic local title is unrelated." } : candidate
  });
  assert.equal((await run()).status, "verified");
  assert(calls.search.includes(focused));
  assert(calls.search.length <= 8);
  assert.equal(calls.model.length, 3);
});
test("an official URL cited by an editorial cannot borrow the editorial text as official-page evidence", async () => {
  const { run, calls } = fixture({ search: async () => JSON.stringify({ results: [{ url: "https://example.org/editorial", content: `${official}\n${excerpt}` }] }) });
  const result = await run();
  assert.equal(result.status, "not_found");
  assert(calls.model.every(prompt => !prompt.startsWith("Independently verify")));
  assert(result.trace.rejected.some(item => item.reason === "candidate_not_in_search_evidence"));
});
test("hallucinated URL and metadata echoes cannot verify a candidate", async () => {
  const { run, calls } = fixture({ search: () => JSON.stringify({ query: official, answer: `${official} ${excerpt}`, results: [] }) });
  assert.equal((await run()).status, "not_found");
  assert(calls.model.every(prompt => !prompt.startsWith("Independently verify")));
});
for (const [name, value] of [
  ["fabricated quote", { ...confirmation, matches: [{ aspect: "core", quote: "This quotation is invented and absent from evidence." }, confirmation.matches[1]] }],
  ["only a title", { ...confirmation, matches: [{ aspect: "core", quote: page.title }] }],
  ["different event ordering", { ...confirmation, contradictions: ["Reply occurs before the day's send."] }],
  ["editorial page", { ...confirmation, pageType: "editorial" }],
  ["string true", { ...confirmation, sameProblem: "true" }],
  ["null result", null]
]) test(`rejects ${name} despite a matching URL`, async () => {
  const { run } = fixture({ model: prompt => prompt.startsWith("Independently verify") ? value : candidate });
  assert.equal((await run()).status, "not_found");
});
test("all provider calls stay within budgets and repeated query suggestions are deduplicated", async () => {
  const { run, calls } = fixture({ search: () => "[]", model: () => ({ candidates: [], queries: ["focus query", " focus   query ", "FOCUS QUERY", "focus query"] }) });
  const result = await run();
  assert.equal(result.status, "not_found");
  assert.equal(result.reason, "no_search_results");
  assert(calls.search.length > 0 && calls.search.length <= 8);
  assert(calls.model.length <= 4);
  assert.equal(calls.search.length, new Set(calls.search.map(x => x.replace(/\s+/g, " ").trim().toLowerCase())).size);
});
test("provider failure is not silently rewritten as not-found", async () => {
  const { run, calls } = fixture({ search: () => { throw new AiError("SEARCH_NETWORK_ERROR"); } });
  await assert.rejects(run(), /SEARCH_NETWORK_ERROR/);
  assert.equal(calls.model.length, 0);
  assert.equal(calls.progress.at(-1).trace.searches[0].status, "failed");
});
test("cancellation is checked before any provider operation", async () => {
  const { run, calls } = fixture({ checkActive: () => { throw new AiError("JOB_CANCELLED"); } });
  await assert.rejects(run(), /JOB_CANCELLED/);
  assert.equal(calls.search.length, 0);
  assert.equal(calls.model.length, 0);
});
test("cancel after search completion stops the next paid model request", async () => {
  let cancel = false;
  const { run, calls } = fixture({ checkActive: () => { if (cancel) throw new AiError("JOB_CANCELLED"); }, onProgress: progress => { if (progress.trace.searches.some(x => x.status === "completed")) cancel = true; } });
  await assert.rejects(run(), /JOB_CANCELLED/);
  assert.equal(calls.search.length, 1);
  assert.equal(calls.model.length, 0);
});
test("verified checkpoint resumes without repeating searches or models before metadata publication", async () => {
  let saved;
  const first = fixture({ onProgress: progress => { if (progress.phase === "completed") { saved = clone(progress.trace); throw new AiError("SIMULATED_RESTART"); } } });
  await assert.rejects(first.run(), /SIMULATED_RESTART/);
  assert.equal(saved.resolved.url, official);
  const resumed = fixture({}, { initialTrace: saved });
  assert.equal((await resumed.run()).status, "verified");
  assert.equal(resumed.calls.search.length, 0);
  assert.equal(resumed.calls.model.length, 0);
});
test("candidate checkpoint resumes with a verification call instead of rediscovery", async () => {
  let saved;
  const first = fixture({ onProgress: progress => { if (progress.trace.pendingCandidates?.length && progress.trace.modelCount === 1) { saved = clone(progress.trace); throw new AiError("SIMULATED_RESTART"); } } });
  await assert.rejects(first.run(), /SIMULATED_RESTART/);
  const resumed = fixture({}, { initialTrace: saved });
  assert.equal((await resumed.run()).status, "verified");
  assert.equal(resumed.calls.model.length, 1);
  assert.match(resumed.calls.model[0], /^Independently verify/);
  assert.equal(resumed.calls.search.length, 1);
});
test("completed search checkpoint survives interruption without repeating that query", async () => {
  let saved;
  const first = fixture({ onProgress: progress => { if (progress.trace.searches[0]?.status === "completed") { saved = clone(progress.trace); throw new AiError("SIMULATED_RESTART"); } } });
  await assert.rejects(first.run(), /SIMULATED_RESTART/);
  const resumed = fixture({}, { initialTrace: saved });
  assert.equal((await resumed.run()).status, "verified");
  assert(!resumed.calls.search.includes(saved.searches[0].query));
});
test("changed statement invalidates resolved search evidence", async () => {
  const initial = await fixture().run();
  const changed = clone(snapshot);
  changed.statements[0].contentSections[0].text += " Rules changed.";
  const resumed = fixture({}, { initialTrace: initial.trace }, changed);
  assert.equal((await resumed.run()).status, "verified");
  assert(resumed.calls.search.length > 0);
  assert(resumed.calls.model.length > 0);
});
test("corrupt optional trace fields and nonfinite limits never throw TypeError or create unbounded calls", async () => {
  const original = (await fixture().run()).trace;
  const bad = { ...original, searches: [{ ...original.searches[0], documents: {} }], resolved: null,
    pendingQueries: {}, pendingCandidates: 9, evaluations: [null], rejected: "invalid", modelCount: NaN };
  const check = fixture({}, { initialTrace: bad, maxSearches: Infinity, maxModelCalls: NaN });
  await check.run();
  assert(check.calls.search.length <= 8);
  assert(check.calls.model.length <= 4);
});
test("unsafe candidate URLs are never targeted or accepted", async () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:password@example.org/problem", null]) {
    const check = fixture({ model: () => ({ candidates: [{ url }], queries: [] }) });
    assert.equal((await check.run()).status, "not_found");
    assert(check.calls.model.every(prompt => !prompt.startsWith("Independently verify")));
  }
});

test('bilingual initial searches use both locales rather than only a translated generic title', () => {
  const bilingual = clone(snapshot);
  bilingual.statements.unshift({ locale: 'en_US', title: 'A. Sending Messages', contentSections: [{ text: 'Every day send some messages and settle the pending cost.' }] });
  const queries = initialSourceQueries(bilingual);
  assert.match(queries[0].query, /Sending Messages/);
  assert.equal(queries[1].query.replace(/^"|"$/g, ""), '发消息');
});

test('late targeted documents are retained after more than 32 earlier irrelevant results', async () => {
  let reviews = 0;
  const { run, calls } = fixture({
    search: (query, state) => JSON.stringify({ results: state.search.length <= 4
      ? Array.from({length: 8}, (_, index) => ({url: `https://example.org/unrelated/${state.search.length}/${index}`, content: 'Unrelated content.'}))
      : [page] }),
    model: prompt => prompt.startsWith('Independently verify') ? confirmation : ++reviews === 1
      ? {candidates: [], queries: ['distinctive focused rules', 'full numeric signature', 'exact example values']}
      : candidate
  });
  assert.equal((await run()).status, 'verified');
  assert(calls.search.length >= 5);
});

test('failure of the fourth logical model request resumes that reserved call and verifies instead of returning not-found', async () => {
  const firstUrl = 'https://example.org/first-candidate';
  let saved, modelCalls = 0;
  const first = fixture({
    search: () => JSON.stringify({results: [{...page, url:firstUrl}, page]}),
    model: () => {
      modelCalls++;
      if (modelCalls === 1) return {candidates:[{url:firstUrl}], queries:[]};
      if (modelCalls === 2) return {sameProblem:false};
      if (modelCalls === 3) return candidate;
      throw new AiError('PROVIDER_NETWORK_ERROR');
    },
    onProgress: progress => { saved=clone(progress.trace); }
  });
  await assert.rejects(first.run(), /PROVIDER_NETWORK_ERROR/);
  assert.equal(saved.modelCount, 4);
  assert.equal(saved.pendingModel.phase, 'verifying');
  const resumed = fixture({model: () => confirmation}, {initialTrace:saved});
  const result = await resumed.run();
  assert.equal(result.status, 'verified');
  assert.equal(result.trace.modelCount, 4, 'same logical call must not consume a fifth slot');
  assert.equal(result.trace.pendingModel, undefined);
  assert.equal(resumed.calls.model.length, 1);
  assert.equal(resumed.calls.search.length, 0);
});

test('an interrupted final allowed review reuses its reservation before confirming the candidate', async () => {
  let saved, calls = 0;
  const first = fixture({
    model: () => { calls++; if(calls < 3) return {candidates:[],queries:['focused distinct query '+calls]}; throw new AiError('RESPONSE_RECOVERY_INTERRUPTED'); },
    onProgress: progress => { saved=clone(progress.trace); }
  });
  await assert.rejects(first.run(), /RESPONSE_RECOVERY_INTERRUPTED/);
  assert.equal(saved.modelCount, 3);
  assert.equal(saved.pendingModel.phase, 'evaluating');
  const resumed = fixture({}, {initialTrace:saved});
  assert.equal((await resumed.run()).status, 'verified');
  assert.equal(resumed.calls.model.length, 2);
});

test('failed search reservations retry once per resumed execution and never reuse failure as negative evidence', async () => {
  let saved;
  const first = fixture({search: () => { throw new AiError('SEARCH_NETWORK_ERROR'); }, onProgress: progress => { saved=clone(progress.trace); }});
  await assert.rejects(first.run(), /SEARCH_NETWORK_ERROR/);
  assert.equal(saved.searchCount, 1);
  const resumed = fixture({}, {initialTrace:saved});
  assert.equal((await resumed.run()).status, 'verified');
  assert.equal(resumed.calls.search[0], first.calls.search[0]);
  assert.equal(resumed.calls.search.filter(query => query === first.calls.search[0]).length, 1);
  const stillFailing = fixture({search: () => {throw new AiError('SEARCH_NETWORK_ERROR');}}, {initialTrace:saved});
  await assert.rejects(stillFailing.run(), /SEARCH_NETWORK_ERROR/);
  assert.equal(stillFailing.calls.search.length, 1, 'provider failure escapes instead of an internal retry loop');
});

test('known source page suffixes are removed only for the matching platform host', () => {
  const {sourceProblemTitle}=require('./ai-source-search.ts');
  assert.equal(sourceProblemTitle(official, '小 X 今天心情怎么样？ - Problem - QOJ.ac'), '小 X 今天心情怎么样？');
  assert.equal(sourceProblemTitle('https://qoj.ac/contest/3945/problem/19013', 'A+B Problem - Problem - QOJ.ac'), 'A+B Problem');
  assert.equal(sourceProblemTitle('https://www.luogu.com.cn/problem/P3372', '【模板】线段树 1 - 洛谷'), '【模板】线段树 1');
  for (const url of ['https://example.org/problem', 'https://qoj.ac.evil.example/problem/19013', 'https://qoj.ac:8443/problem/19013'])
    assert.equal(sourceProblemTitle(url, 'A+B Problem - Problem - QOJ.ac'), 'A+B Problem - Problem - QOJ.ac');
  assert.equal(sourceProblemTitle(official, 'The Problem - QOJ.ac Experiment'), 'The Problem - QOJ.ac Experiment');
});

test('verified and resumed source results store the problem title without known SEO suffixes', async () => {
  const first=fixture({model: prompt => prompt.startsWith('Independently verify') ? {...confirmation, originalTitle:page.title+' - Problem - QOJ.ac'} : candidate});
  const result=await first.run();
  assert.equal(result.title,page.title);
  result.trace.resolved.title=page.title+' - Problem - QOJ.ac';
  const resumed=fixture({}, {initialTrace:result.trace});
  assert.equal((await resumed.run()).title,page.title);
  assert.equal(resumed.calls.model.length,0);
});


test("explicit source links survive as bounded candidate hints, excluding code and unrelated links", () => {
  const { importSourceCandidates } = require("./ai-source-search.ts");
  assert.deepEqual(importSourceCandidates("原题：https://www.luogu.com.cn/problem/P7077\nSource: [same](https://qoj.ac/problem/19013)\nUnrelated https://example.org/other\n```text\nSource: https://example.org/code\n```"), ["https://www.luogu.com.cn/problem/P7077", official]);
  assert.deepEqual(importSourceCandidates("Source: https://secret@example.org/problem/1"), []);
});

test("user source hint gets targeted evidence search before generic queries and still requires independent agreement", async () => {
  const checked = fixture({ model: prompt => { assert(prompt.startsWith("Independently verify")); return clone(confirmation); } }, { sourceHints: [official] });
  const result = await checked.run();
  assert.equal(result.status, "verified");assert(checked.calls.search[0].startsWith(official));assert.equal(checked.calls.model.length, 1);
  const resumed = fixture({ search: () => assert.fail("saved verified evidence should be reused"), model: () => assert.fail("saved verification must not bill again") }, { sourceHints: [official], initialTrace: result.trace });
  assert.equal((await resumed.run()).status, "verified");
});

test("source candidate text can repair a previously imported statement through the ordinary editor", async () => {
  const problem = clone(snapshot);problem.statements[0].contentSections.push({ type: "Text", sectionTitle: "Hints", text: "原题候选：" + official });
  const checked = fixture({ model: () => clone(confirmation) }, {}, problem);
  assert.equal((await checked.run()).status, "verified");assert(checked.calls.search[0].startsWith(official));
});

test("user links without actual target-page evidence cannot mark a source verified", async () => {
  const checked = fixture({ search: () => JSON.stringify({ query: official, results: [] }), model: () => ({ candidates: [], queries: [] }) }, { sourceHints: [official] });
  const result = await checked.run();assert.equal(result.status, "not_found");assert(!result.url);
  assert(result.trace.rejected.some(item => item.url === official && item.reason === "candidate_not_in_search_evidence"));
});

test("a hinted page with contradictory task semantics is rejected despite exact URL evidence", async () => {
  const checked = fixture({ model: prompt => prompt.startsWith("Independently verify") ? { ...confirmation, sameProblem: false, contradictions: ["Different task"] } : { candidates: [], queries: [] } }, { sourceHints: [official] });
  assert.equal((await checked.run()).status, "not_found");
});


test("rejecting an explicit source hint retains later hints for independent verification", async () => {
  const wrong = "https://example.org/wrong-problem";
  const checked = fixture({
    search: query => JSON.stringify({ results: [query.startsWith(wrong) ? { ...page, url: wrong } : page] }),
    model: prompt => prompt.includes("Candidate: " + wrong + "\n")
      ? { ...confirmation, sameProblem: false, contradictions: ["Different task"] }
      : clone(confirmation)
  }, { sourceHints: [wrong, official] });
  const result = await checked.run();
  assert.equal(result.status, "verified");
  assert.equal(result.url, official);
  assert(checked.calls.search[0].startsWith(wrong));
  assert(checked.calls.search[1].startsWith(official));
  assert.deepEqual(result.trace.evaluations.map(item => item.status), ["rejected", "verified"]);
  assert.equal(checked.calls.model.length, 2);
});

test("later explicit hints survive a checkpoint immediately after rejecting the first", async () => {
  const wrong = "https://example.org/wrong-problem";
  let saved;
  const first = fixture({
    search: () => JSON.stringify({ results: [{ ...page, url: wrong }] }),
    model: () => ({ ...confirmation, sameProblem: false, contradictions: ["Different task"] }),
    onProgress: progress => {
      if (progress.trace.evaluations.length) {
        saved = clone(progress.trace);
        throw new AiError("SIMULATED_RESTART");
      }
    }
  }, { sourceHints: [wrong, official] });
  await assert.rejects(first.run(), /SIMULATED_RESTART/);
  assert.deepEqual(saved.pendingCandidates.map(item => item.url), [official]);
  const resumed = fixture({ model: () => clone(confirmation) }, { sourceHints: [wrong, official], initialTrace: saved });
  assert.equal((await resumed.run()).status, "verified");
  assert(resumed.calls.search[0].startsWith(official));
  assert.equal(resumed.calls.model.length, 1);
});

// Search-plan regressions reproduce the real decorated-title failure without provider access.
const plainQuery = value => value.replace(/^"|"$/g, "");
function titleSnapshot(titles, text = "There is a tree with N nodes and N minus one edges.\nN <= 200000; $a_1,\\dots,a_N$.") {
  return { id: 91234567, statements: titles.map((title, index) => ({ locale: index ? "zh_CN" : "en_US", title,
    contentSections: [{ type: "Text", sectionTitle: "Description", text }] })),
    samples: [{ inputData: "987654 345678\n", outputData: "876543\n" }], judgeInfo: {} };
}
test("the real JAG-style title searches its clean name before the full contest prefix and generic tree prose", () => {
  const original = "[JAG 2023 Summer Camp #3] Many-hued Tree";
  const queries = initialSourceQueries(titleSnapshot([original]));
  assert.equal(plainQuery(queries[0].query), "Many-hued Tree");
  assert(queries.some(item => item.query.includes(original)), "preserve the full original title as a fallback");
  assert(queries.every(item => !/There is a tree|200000|987654|345678|876543|dots|programming problem|competitive programming|algorithm/.test(item.query)));
});
test("both clean language titles precede original-prefix and other fallback searches", () => {
  const queries = initialSourceQueries(titleSnapshot(["[JAG 2023 Summer Camp #3] Many-hued Tree", "[JAG 2023 Summer Camp #3] 多彩树"]));
  assert.deepEqual(queries.slice(0, 2).map(item => plainQuery(item.query)), ["Many-hued Tree", "多彩树"]);
});
test("template markers, mathematical brackets and unrecognized bracketed words remain part of titles", () => {
  for (const title of ["【模板】线段树 1", "[0,1] 区间", "(a+b)^2", "[Workshop] Invariants"]) {
    const queries = initialSourceQueries(titleSnapshot([title]));
    assert.equal(plainQuery(queries[0].query), title);
  }
});
test("a one-character title stays searchable without expanding into formula or sample noise", () => {
  const queries = initialSourceQueries(titleSnapshot(["换"]));
  assert.equal(plainQuery(queries[0].query), "换");
  assert(queries.every(item => !/dots|200000|987654|345678|876543/.test(item.query)));
});
test("explicit Codeforces and Luogu IDs get focused priority but local database IDs never become source IDs", () => {
  for (const [title, expected] of [["CF868F Yet Another Minimization Problem", /CF868F|codeforces\.com(?:\/.*868\/F|\s+868F)/i], ["P7077 [CSP-S 2020] 函数调用", /P7077|luogu\.com\.cn\/problem\/P7077/i]]) {
    const queries = initialSourceQueries(titleSnapshot([title]));
    assert.match(queries[0].query, expected);
    assert(queries.every(item => !item.query.includes("91234567")));
  }
});
test("missing titles do not fabricate a programming-problem title or promote constraint numbers to source IDs", () => {
  const queries = initialSourceQueries(titleSnapshot([""], "P = 7077 and CF = 868; there is an array with many elements."));
  assert.deepEqual(queries, []);
});
test("mandatory title variants survive a flood of model-generated semantic refinements", async () => {
  const local = titleSnapshot(["[JAG 2023 Summer Camp #3] Many-hued Tree", "多彩树"]);
  const checked = fixture({ search: () => "[]", model: () => ({ candidates: [], queries: Array.from({ length: 6 }, (_, i) => "semantic distraction query " + i) }) }, {}, local);
  const result = await checked.run();
  const queries = checked.calls.search;
  assert(queries.some(query => plainQuery(query) === "Many-hued Tree"));
  assert(queries.some(query => plainQuery(query) === "多彩树"));
  assert(queries.some(query => query.includes("[JAG 2023 Summer Camp #3] Many-hued Tree")), "the original-title fallback must not starve behind model refinements");
  assert(result.trace.searchCount <= 8 && result.trace.modelCount <= 4);
});
test("a returned original problem page is verified before an earlier model-only URL hypothesis", async () => {
  const guessed = "https://judge.u-aizu.ac.jp/onlinejudge/description.jsp?id=3615";
  const checked = fixture({
    model: prompt => prompt.startsWith("Independently verify") ? clone(confirmation) : {
      candidates: [{ url: guessed, title: "Guessed candidate" }, { url: official, title: page.title }], queries: []
    }
  });
  const result = await checked.run();
  assert.equal(result.status, "verified");
  assert.equal(result.url, official);
  const verification = checked.calls.model.find(prompt => prompt.startsWith("Independently verify"));
  assert(verification.includes("Candidate: " + official + "\n"));
  assert(!checked.calls.search.some(query => query.startsWith(guessed)), "do not spend targeted searches ahead of already returned evidence");
});
test("rejecting one grounded candidate retains the next without paying for rediscovery", async () => {
  const wrong = "https://example.org/wrong-grounded";
  const checked = fixture({
    search: () => JSON.stringify({ results: [{ ...page, url: wrong }, page] }),
    model: prompt => !prompt.startsWith("Independently verify") ? { candidates: [{ url: wrong }, { url: official }], queries: [] }
      : prompt.includes("Candidate: " + wrong + "\n") ? { ...confirmation, sameProblem: false, contradictions: ["Different objective"] } : clone(confirmation)
  });
  const result = await checked.run();
  assert.equal(result.status, "verified");
  assert.equal(checked.calls.model.filter(prompt => prompt.startsWith("Identify candidate original")).length, 1);
  assert.deepEqual(result.trace.evaluations.map(item => [item.url, item.status]), [[wrong, "rejected"], [official, "verified"]]);
  assert.equal(result.trace.modelCount, 3);
});
test("a later model candidate survives interruption after the first semantic rejection", async () => {
  const wrong = "https://example.org/wrong-grounded";
  let saved;
  const first = fixture({
    search: () => JSON.stringify({ results: [{ ...page, url: wrong }, page] }),
    model: prompt => !prompt.startsWith("Independently verify") ? { candidates: [{ url: wrong }, { url: official }], queries: [] }
      : { ...confirmation, sameProblem: false, contradictions: ["Different objective"] },
    onProgress: progress => { if (progress.trace.evaluations.length) { saved = clone(progress.trace); throw new AiError("SIMULATED_RESTART"); } }
  });
  await assert.rejects(first.run(), /SIMULATED_RESTART/);
  assert.deepEqual(saved.pendingCandidates.map(item => item.url), [official]);
  const resumed = fixture({ model: prompt => { assert(prompt.startsWith("Independently verify")); return clone(confirmation); } }, { initialTrace: saved });
  assert.equal((await resumed.run()).status, "verified");
  assert.equal(resumed.calls.model.length, 1);
  assert.equal(resumed.calls.model.filter(prompt => prompt.startsWith("Identify candidate original")).length, 0);
});
test("resuming an in-flight verification preserves candidate order and the reserved prompt", async () => {
  const firstUrl = "https://example.org/first-reserved";
  let saved;
  const first = fixture({
    search: () => JSON.stringify({ results: [{ ...page, url: firstUrl }, page] }),
    model: prompt => { if (prompt.startsWith("Independently verify")) throw new AiError("RESPONSE_RECOVERY_INTERRUPTED"); return { candidates: [{ url: firstUrl }, { url: official }], queries: [] }; },
    onProgress: progress => { saved = clone(progress.trace); }
  });
  await assert.rejects(first.run(), /RESPONSE_RECOVERY_INTERRUPTED/);
  assert.equal(saved.pendingCandidates[0].url, firstUrl);
  assert.equal(saved.pendingModel.phase, "verifying");
  const resumed = fixture({ search: () => assert.fail("do not repeat a completed targeted query"), model: prompt => {
    assert(prompt.includes("Candidate: " + firstUrl + "\n")); return clone(confirmation);
  } }, { initialTrace: saved });
  const result = await resumed.run();
  assert.equal(result.status, "verified");
  assert.equal(result.url, firstUrl);
  assert.equal(result.trace.modelCount, saved.modelCount);
  assert.equal(resumed.calls.model.length, 1);
});

test("a pre-upgrade pending review resumes its exact old prompt reservation without rebilling", async () => {
  let saved, currentPrompt;
  const first = fixture({
    model: prompt => { currentPrompt = prompt; throw new AiError("RESPONSE_RECOVERY_INTERRUPTED"); },
    onProgress: progress => { saved = clone(progress.trace); }
  });
  await assert.rejects(first.run(), /RESPONSE_RECOVERY_INTERRUPTED/);
  assert.equal(saved.pendingModel.phase, "evaluating");
  const start = currentPrompt.indexOf(" Search the concise problem name,");
  const end = currentPrompt.indexOf("A local copy may rename/translate");
  assert(start >= 0 && end > start, "fixture must remove only the new query guidance to recreate the old prompt");
  const legacyPrompt = currentPrompt.slice(0, start) + currentPrompt.slice(end);
  delete saved.queryPlanVersion;
  saved.pendingModel.promptHash = require("node:crypto").createHash("sha256").update(legacyPrompt).digest("hex");
  const resumed = fixture({ model: prompt => {
    if (prompt.startsWith("Identify candidate original")) { assert.equal(prompt, legacyPrompt); return clone(candidate); }
    return clone(confirmation);
  } }, { initialTrace: saved });
  const result = await resumed.run();
  assert.equal(result.status, "verified");
  assert.equal(result.trace.modelCount, saved.modelCount + 1, "only the new verification consumes a reservation");
  assert.equal(resumed.calls.model.length, 2);
  assert.equal(result.trace.pendingModel, undefined);
});
test("a matching returned Luogu statement omitted by the model still receives independent semantic verification", async () => {
  const url = "https://www.luogu.com.cn/problem/P15721";
  const local = clone(snapshot); local.statements[0].title = "[JAG 2023 Summer Camp #3] Many-hued Tree";
  const checked = fixture({
    search: () => JSON.stringify({ results: [{ ...page, url, title: "P15721 [JAG 2023 Summer Camp #3] Many-hued Tree - 洛谷" }] }),
    model: prompt => prompt.startsWith("Independently verify") ? { ...confirmation, originalTitle: "Many-hued Tree" }
      : { candidates: [{ url: "https://example.org/guessed-contest-pdf", title: "Guessed contest" }], queries: [] }
  }, {}, local);
  const result = await checked.run();
  assert.equal(result.status, "verified"); assert.equal(result.url, url);
  assert.equal(checked.calls.model.length, 2);
  assert(checked.calls.model[1].includes("Candidate: " + url + "\n"));
  const denied = fixture({ search: () => JSON.stringify({ results: [{ ...page, url, title: "Many-hued Tree - 洛谷" }] }),
    model: prompt => prompt.startsWith("Independently verify") ? { ...confirmation, sameProblem: false, contradictions: ["Different objective despite matching title"] } : { candidates: [], queries: [] }
  }, {}, local);
  assert.equal((await denied.run()).status, "not_found", "title equality alone can never authorize source metadata");
});


test("ID-like title words without a separator remain unchanged", () => {
  for (const title of ["P1000Ways", "CF2024Festival"]) {
    const queries = initialSourceQueries(titleSnapshot([title]));
    assert.equal(plainQuery(queries[0].query), title);
    assert(!queries.some(item => item.strategy === "source_identifier"));
  }
});


test("cancelled search and model calls stop source discovery without retries or fallback", async () => {
  for (const stage of ["search", "model"]) {
    const cancellation = new AiError("JOB_CANCELLED");
    const checked = fixture({ [stage]: () => { throw cancellation; } });
    await assert.rejects(checked.run(), error => error === cancellation);
    assert.equal(checked.calls[stage].length, 1);
    if (stage === "search") assert.equal(checked.calls.model.length, 0);
  }
});
