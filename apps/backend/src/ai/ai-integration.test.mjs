/** Isolated feature-database verification only. Requires a disposable backend and sandbox test runner. */
import http from "node:http";
import assert from "node:assert/strict";
import { request, db, close } from "../../test/integration-client.mjs";
import { state, token, fixtureUserId, prepareMockFixture, clearMockFixtureConfiguration } from "./ai-fixture-utils.mjs";
await prepareMockFixture();
const useSpj = process.env.HYHOJ_TEST_SPJ === "1";
const testInvalidInput = process.env.HYHOJ_TEST_INVALID_INPUT === "1";
let rejectGeneratedInput = testInvalidInput;
const sourceUrl = "https://example.org/problems/ai-isolated-sum";
const statement = {
  locale: "zh_CN",
  title: "隔离 AI 验收：两数之和",
  contentSections: [
    {
      sectionTitle: "题目描述",
      type: "Text",
      text: "读入两个整数 a 和 b，输出 a+b。时间限制 2 秒，空间限制 128 MiB。子任务 1（50 分）：-10≤a,b≤10。子任务 2（50 分）：-10^9≤a,b≤10^9。"
    }
  ]
};
const translated = {
  locale: "en_US",
  title: "Isolated AI verification: sum",
  contentSections: [
    {
      sectionTitle: "Description",
      type: "Text",
      text: "Read two integers a and b and output a+b. Time limit 2 seconds. Memory limit 128 MiB. Subtask 1 (50 points): -10<=a,b<=10. Subtask 2 (50 points): -10^9<=a,b<=10^9."
    }
  ]
};
const samples = [{ inputData: "1 2\n", outputData: "3\n" }];
const makeCode =
  '#include <bits/stdc++.h>\nusing namespace std; int main(int argc,char**argv){long long sub=stoll(argv[1]), seed=stoll(argv[2]), bound=sub==1?10:1000000000; cout<<(seed==1?-bound:bound)<<" "<<(seed==1?0:bound)<<"\\n";}';
const stdCode =
  '#include <iostream>\nusing namespace std; int main(){long long a,b;if(!(cin>>a>>b))return 1;cout<<a+b<<"\\n";}';
const validatorCode = `#include <bits/stdc++.h>
using namespace std;
int main(int argc, char** argv) {
  if (argc < 2) return 1;
  int subtask = stoi(argv[1]);
  if (subtask < 0 || subtask > 2) return 1;
  long long a, b, bound = subtask == 1 ? 10 : 1000000000;
  if (!(cin >> a >> b)) { cerr << "Two integer tokens required"; return 1; }
  cin >> ws;
  if (!cin.eof()) { cerr << "Unexpected extra input"; return 1; }
  if (a < -bound || a > bound || b < -bound || b > bound) {
    cerr << "Value exceeds subtask bound"; return 1;
  }
  return 0;
}`;
let validatorCalls = 0,
  makeCalls = 0,
  stdCalls = 0,
  modelCalls = 0,
  providerCalls = 0;
const server = http.createServer(async (req, res) => {
  providerCalls++;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/models") return res.end(JSON.stringify({ data: [{ id: "isolated-fixture-model" }] }));
    if (req.url === "/search")
      return res.end(
        JSON.stringify({
          usage: { credits: 2 },
          results: [
            { title: "Fixture source", url: sourceUrl, content: "Two integers, sum; tags mathematics; difficulty 800." }
          ]
        })
      );
    assert.equal(req.url, "/chat/completions");
    modelCalls++;
    const prompt = body.messages.at(-1).content;
    let output;
    if (prompt.startsWith("Extract this programming problem")) output = { localizedContents: [statement], samples };
    else if (prompt.startsWith("Find the exact original"))
      output = { originalProblem: sourceUrl, evidence: "Exact fixture source / 精确匹配测试来源" };
    else if (prompt.startsWith("Translate the statement")) output = translated;
    else if (prompt.startsWith("Classify the algorithms"))
      output = { tags: [{ id: null, zh_CN: "数学", en_US: "Mathematics" }] };
    else if (prompt.startsWith("Estimate Codeforces"))
      output = { difficulty: 800, rationale: "一次加法 / One addition." };
    else if (prompt.startsWith("Write an original"))
      output = { zh_CN: "读入两数并相加，时间复杂度 $O(1)$。", en_US: "Read and add the two integers in $O(1)$ time." };
    else if (prompt.startsWith("Design a test-data plan"))
      output = {
        subtasks: [
          { id: 1, points: 50, constraints: "-10<=a,b<=10", coverage: ["minimum", "maximum"] },
          { id: 2, points: 50, constraints: "-10^9<=a,b<=10^9", coverage: ["minimum", "maximum"] }
        ],
        needsSpj: useSpj,
        spjReason: "Unique integer answer",
        timeLimitMs: 2000,
        memoryLimitMiB: 128
      };
    else if (prompt.startsWith("Generate ONLY make.cpp")) {
      output = rejectGeneratedInput ? '#include <iostream>\nint main(){std::cout<<"1000000001 0\\n";}' : makeCode;
      makeCalls++;
    } else if (prompt.startsWith("Generate ONLY std.cpp")) {
      output = stdCode;
      stdCalls++;
    } else if (prompt.startsWith("Generate ONLY validator.cpp")) {
      assert(prompt.includes(statement.contentSections[0].text));
      assert(!prompt.includes(makeCode));
      assert(!prompt.includes(stdCode));
      output = validatorCode;
      validatorCalls++;
    } else if (prompt.startsWith("Generate ONLY checker.cpp")) {
      output =
        '#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);long long a=inf.readLong(),b=inf.readLong(),got=ouf.readLong();if(!ouf.seekEof())quitf(_pe,"Extra output");if(got!=a+b)quitf(_wa,"Wrong sum");quitf(_ok,"OK");}';
    } else if (prompt === "Reply OK.") output = "OK";
    else throw new Error("Unexpected mock prompt");
    return res.end(
      JSON.stringify({
        usage: { prompt_tokens: 25, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 4 } },
        choices: [
          { finish_reason: "stop", message: { content: typeof output === "string" ? output : JSON.stringify(output) } }
        ]
      })
    );
  } catch {
    res.statusCode = 500;
    res.end('{"error":"mock fixture rejected request"}');
  }
});
await new Promise(resolve => server.listen(2230, "127.0.0.1", resolve));
let problemId, activeJobId;
try {
  const previousUsage = await request(token, "ai/usage", { days: 1 });
  assert(!previousUsage.error, JSON.stringify(previousUsage));
  const configured = await request(token, "ai/saveConfiguration", {
    llm: {
      type: "chat",
      baseUrl: "http://127.0.0.1:2230",
      apiKey: "isolated-fixture-secret",
      model: "isolated-fixture-model",
      maxTokens: 4096
    },
    search: { type: "tavily", baseUrl: "http://127.0.0.1:2230", apiKey: "isolated-search-secret" },
    autoOnSave: false
  });
  assert(!configured.error, JSON.stringify(configured));
  assert.equal(configured.llm.hasKey, true);
  assert.equal(JSON.stringify(configured).includes("fixture-secret"), false);
  assert.deepEqual((await request(token, "ai/models", {})).models, ["isolated-fixture-model"]);
  assert.equal((await request(token, "ai/test", { target: "llm" })).success, true);
  assert.equal((await request(token, "ai/test", { target: "search" })).success, true);
  const started = await request(token, "ai/start", {
    action: "import",
    markdown: statement.contentSections[0].text,
    count: 5
  });
  assert(started.job?.id, JSON.stringify(started));
  const jobId = started.job.id;
  activeJobId = jobId;
  let job;
  const deadline = Date.now() + 300000;
  let rejectedInvalidInput = false;
  do {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const result = await request(token, "ai/jobs", {});
    job = result.jobs.find(item => item.id === jobId);
    if (job?.problemId) problemId = job.problemId;
    if (job?.status === "failed") {
      if (!rejectGeneratedInput) throw new Error(job.error);
      assert.match(job.error, /^SANDBOX_GENERATION_FAILED/);
      assert.match(job.error, /validat/i);
      const untouched = await request(token, "problem/getProblem", { id: problemId, testData: true, judgeInfo: true });
      assert.equal(untouched.testData.length, 0, "illegal inputs must never be published");
      assert.equal(untouched.judgeInfo.subtasks?.length || 0, 0, "illegal inputs must not replace judge configuration");
      const failedState = await db.query("SELECT state FROM ai_job WHERE id=?", [jobId]);
      const checkpoint =
        typeof failedState[0].state === "string" ? JSON.parse(failedState[0].state) : failedState[0].state;
      assert(checkpoint.validatorCode, "failed attempt keeps diagnostic source until retry");
      rejectGeneratedInput = false;
      rejectedInvalidInput = true;
      const retried = await request(token, "ai/retry", { id: jobId });
      assert(!retried.error, JSON.stringify(retried));
    }
  } while (job?.status !== "completed" && Date.now() < deadline);
  assert.equal(job.status, "completed");
  assert.equal(job.progress, 100);
  assert.equal(makeCalls, testInvalidInput ? 2 : 1);
  assert.equal(stdCalls, testInvalidInput ? 2 : 1);
  assert.equal(validatorCalls, testInvalidInput ? 2 : 1);
  assert.equal(rejectedInvalidInput, testInvalidInput);
  const storedState = await db.query("SELECT state FROM ai_job WHERE id=?", [jobId]);
  const checkpoint = typeof storedState[0].state === "string" ? JSON.parse(storedState[0].state) : storedState[0].state;
  assert.deepEqual(checkpoint.generated.sampleValidation, {
    samplesPassed: samples.length,
    inputsPassed: 6,
    sampleInputsPassed: samples.length
  });
  const problem = await request(token, "problem/getProblem", {
    id: problemId,
    localizedContentsOfAllLocales: true,
    samples: true,
    judgeInfo: true,
    testData: true,
    tagsOfAllLocales: true
  });
  assert(!problem.error, JSON.stringify(problem));
  assert.equal(problem.meta.difficulty, 800);
  assert.equal(problem.meta.originalProblem, sourceUrl);
  assert.equal(problem.meta.isPublic, false);
  assert.deepEqual(problem.localizedContentsOfAllLocales.map(x => x.locale).sort(), ["en_US", "zh_CN"]);
  assert.equal(problem.judgeInfo.timeLimit, 2000);
  assert.equal(problem.judgeInfo.memoryLimit, 128);
  assert.equal(problem.judgeInfo.subtasks.length, 2);
  assert(problem.judgeInfo.subtasks.every(x => x.scoringType === "Sum" && x.points === 50));
  assert.equal(
    problem.judgeInfo.subtasks.reduce((sum, x) => sum + x.testcases.length, 0),
    6
  );
  assert.equal(problem.testData.length, useSpj ? 17 : 16);
  assert(problem.testData.some(x => x.filename === "validator.cpp"));
  if (useSpj) {
    assert.equal(problem.judgeInfo.checker.type, "custom");
    assert.match(problem.judgeInfo.checker.filename, /^ai-managed-[0-9a-f-]{36}-checker\.cpp$/);
    assert(problem.testData.some(file => file.filename === problem.judgeInfo.checker.filename));
    assert(!problem.testData.some(file => file.filename === "checker.cpp"));
  }
  assert(problem.testData.some(x => x.filename === "data.yaml"));
  assert(job.result.discussionIds.zh_CN && job.result.discussionIds.en_US);
  assert.notEqual(job.result.discussionIds.zh_CN, job.result.discussionIds.en_US);
  const bilingualDiscussions = await db.query("SELECT title FROM discussion WHERE id IN (?,?)", [job.result.discussionIds.zh_CN, job.result.discussionIds.en_US]);
  assert.deepEqual(bilingualDiscussions.map(item => item.title).sort(), ["Tutorial", "题解"].sort());
  const usage = await request(token, "ai/usage", { days: 1 });
  assert(!usage.error, JSON.stringify(usage));
  assert.equal(usage.totals.requests - previousUsage.totals.requests, providerCalls);
  assert.equal(usage.totals.inputTokens - (previousUsage.totals.inputTokens || 0), modelCalls * 25);
  assert.equal(usage.totals.outputTokens - (previousUsage.totals.outputTokens || 0), modelCalls * 10);
  assert(!JSON.stringify(usage).includes("fixture-secret"));
  const discussion = await db.query("SELECT id,isPublic,title FROM discussion WHERE id=?", [job.result.discussionId]);
  assert.equal(discussion.length, 1);
  assert.equal(Number(discussion[0].isPublic), 0);
  const encrypted = await db.query("SELECT encrypted FROM ai_configuration WHERE userId=?", [fixtureUserId]);
  assert.equal(JSON.stringify(encrypted).includes("isolated-fixture-secret"), false);
  const other = await request(state.tokens.bob, "ai/jobs", {});
  assert(!other.jobs.some(item => item.id === jobId));
  const otherConfig = await request(state.tokens.bob, "ai/getConfiguration", {});
  assert(!otherConfig.llm?.hasKey);
  console.log(
    JSON.stringify({
      success: true,
      mockModelCalls: modelCalls,
      makeRequests: makeCalls,
      stdRequests: stdCalls,
      validatorRequests: validatorCalls,
      inputConstraintsValidated: true,
      invalidInputRejectedAndRetried: rejectedInvalidInput,
      requestedCases: 5,
      cases: 6,
      bilingual: true,
      separateTutorials: true,
      proportionalSumScoring: true,
      usageMetered: true,
      samplesValidated: true,
      uniqueSpj: useSpj,
      secretIsolation: true,
      problemId,
      jobId
    })
  );
} finally {
  // Cancel this job if an assertion failed while it was active, before taking the mock offline.
  if (activeJobId) {
    try {
      await request(token, "ai/cancel", { id: activeJobId });
    } catch {}
  }
  // Remove this disposable test database after completing the integration suites.
  await clearMockFixtureConfiguration();
  await new Promise(resolve => server.close(resolve));
  await close();
}
