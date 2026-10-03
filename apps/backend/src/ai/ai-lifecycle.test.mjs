/** Durable-state/cancellation/admission tests, restricted by integration-client.mjs to an explicit disposable test DB. */
import http from "node:http";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, db, close } from "../../test/integration-client.mjs";
import { state, token, fixtureUserId, prepareMockFixture, clearMockFixtureConfiguration } from "./ai-fixture-utils.mjs";
await prepareMockFixture();
const held = [];
let calls = 0;
let generationFixture;
let fixtureHandlerError;
const generationCalls = { plan: 0, makeCode: 0, stdCode: 0, checkerCode: 0, validatorCode: 0 };
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.url, "/chat/completions");
    const prompt = body.messages.at(-1).content;
    const respond = output => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: typeof output === "string" ? output : JSON.stringify(output)
              }
            }
          ]
        })
      );
    };
    if (prompt.startsWith("Estimate Codeforces")) {
      calls++;
      held.push(() => respond({ difficulty: 2800, rationale: "Delayed fixture response" }));
      return;
    }
    assert(generationFixture, "Unexpected inference while cached code should be reused");
    const field = prompt.startsWith("Design a test-data plan")
      ? "plan"
      : [
          ["make", "makeCode"],
          ["std", "stdCode"],
          ["checker", "checkerCode"],
          ["validator", "validatorCode"]
        ].find(([name]) => prompt.startsWith(`Generate ONLY ${name}.cpp`))?.[1];
    assert(field, "Unexpected lifecycle mock prompt");
    generationCalls[field]++;
    const rows = await db.query("SELECT state,step FROM ai_job WHERE id=? AND ownerId=?", [
      generationFixture.jobId,
      fixtureUserId
    ]);
    const durable = parse(rows[0].state);
    const stage = field === "plan" ? "plan" : field.replace("Code", "");
    assert.equal(rows[0].step, `testdata.${stage}`, "model request starts after its progress checkpoint");
    if (field === "plan") {
      assert.notEqual(durable.testdataSnapshotHash, generationFixture.oldSnapshotHash);
      assert.notEqual(durable.testdataSnapshotHash, generationFixture.oldPublishedHash);
      for (const stale of [
        "plan",
        "makeCode",
        "stdCode",
        "checkerCode",
        "validatorCode",
        "generated",
        "testdataPublishedSnapshotHash"
      ])
        assert.equal(durable[stale], undefined, `retry must clear stale ${stale} before fresh planning`);
    }
    respond(generationFixture[field]);
  } catch (error) {
    fixtureHandlerError = error;
    res.statusCode = 500;
    res.end('{"error":"lifecycle mock rejected request"}');
  }
});
await new Promise(resolve => server.listen(2230, "127.0.0.1", resolve));
const poll = async (predicate, label, timeout = 30000) => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error("Timeout: " + label);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
};
const getJob = async id => {
  const rows = await db.query("SELECT problemId FROM ai_job WHERE id=? AND ownerId=?", [id, fixtureUserId]);
  return (await request(token, "ai/jobs", rows[0]?.problemId ? { problemId: rows[0].problemId } : {})).jobs.find(
    x => x.id === id
  );
};
const parse = value => (typeof value === "string" ? JSON.parse(value) : value);
const activeIds = [];
try {
  const config = await request(token, "ai/saveConfiguration", {
    llm: {
      type: "chat",
      baseUrl: "http://127.0.0.1:2230",
      apiKey: "isolated-lifecycle-secret",
      model: "fixture",
      maxTokens: 4096
    },
    search: { type: "tavily", baseUrl: "http://127.0.0.1:2230" },
    autoOnSave: false,
    maxConcurrentJobs: 1
  });
  assert(!config.error, JSON.stringify(config));
  const problems = [];
  for (let i = 0; i < 4; i++) {
    const result = await request(token, "problem/createProblem", {
      type: "Traditional",
      statement: {
        difficulty: 1000,
        originalProblem: "",
        localizedContents: [
          {
            locale: "en_US",
            title: "AI lifecycle fixture " + i,
            contentSections: [
              { sectionTitle: "Description", type: "Text", text: "Read two integers and print their sum." }
            ]
          }
        ],
        samples: [{ inputData: "1 2\n", outputData: "3\n" }],
        problemTagIds: []
      }
    });
    assert(result.id, JSON.stringify(result));
    problems.push(result.id);
  }
  const started = await request(token, "ai/start", { problemId: problems[0], action: "difficulty" });
  assert(started.job?.id, JSON.stringify(started));
  activeIds.push(started.job.id);
  await poll(() => held.length === 1, "first inference");
  const duplicate = await request(token, "ai/start", { problemId: problems[0], action: "difficulty" });
  assert.equal(duplicate.job.id, started.job.id);
  const admission = await Promise.all(
    problems.slice(1).map(problemId => request(token, "ai/start", { problemId, action: "difficulty" }))
  );
  const accepted = admission.filter(x => x.job),
    refused = admission.filter(x => x.error);
  assert.equal(accepted.length, 3);
  assert.equal(refused.length, 0);
  // Fill only this fixture owner's queue while its one real inference is deliberately held.
  const quotaFixtures = Array.from({ length: 96 }, () => randomUUID());
  for (const id of quotaFixtures) {
    await db.query(
      "INSERT INTO ai_job(id,ownerId,problemId,action,status,progress,step,input,state,error) VALUES(?,?,NULL,'difficulty','queued',0,'queued',?,?,NULL)",
      [id, fixtureUserId, JSON.stringify({ count: 5 }), JSON.stringify({ completed: [] })]
    );
    activeIds.push(id);
  }
  const refusedByQuota = await request(token, "ai/start", {
    action: "import",
    markdown: "Synthetic queue capacity check",
    count: 5
  });
  assert.equal(refusedByQuota.error, "TOO_MANY_ACTIVE_JOBS");
  const duplicateAtQuota = await request(token, "ai/start", { problemId: problems[0], action: "difficulty" });
  assert.equal(duplicateAtQuota.job.id, started.job.id);
  activeIds.push(...accepted.map(x => x.job.id));
  const pending = await db.query("SELECT COUNT(*) n FROM ai_job WHERE ownerId=? AND status IN ('queued','running')", [
    fixtureUserId
  ]);
  assert.equal(Number(pending[0].n), 100);
  const failedId = randomUUID();
  await db.query(
    "INSERT INTO ai_job(id,ownerId,problemId,action,status,progress,step,input,state,error) VALUES(?,?,?,?,?,?,?,?,?,?)",
    [
      failedId,
      fixtureUserId,
      problems[0],
      "difficulty",
      "failed",
      0,
      "difficulty",
      JSON.stringify({ count: 20 }),
      JSON.stringify({ completed: [] }),
      "fixture"
    ]
  );
  assert.equal((await request(token, "ai/retry", { id: failedId })).error, "TOO_MANY_ACTIVE_JOBS");
  for (const entry of accepted) await request(token, "ai/cancel", { id: entry.job.id });
  await db.query(
    `UPDATE ai_job SET status='cancelled',step='cancelled' WHERE ownerId=? AND id IN (${quotaFixtures
      .map(() => "?")
      .join(",")})`,
    [fixtureUserId, ...quotaFixtures]
  );
  assert.equal((await request(token, "ai/retry", { id: failedId })).error, "PROBLEM_AI_BUSY");
  await request(token, "ai/cancel", { id: started.job.id });
  held.splice(0).forEach(release => release());
  await poll(async () => (await getJob(started.job.id))?.status === "cancelled", "cancelled state");
  // Wait beyond the worker poll interval so a late model response has been discarded.
  await new Promise(resolve => setTimeout(resolve, 2500));
  const unchanged = await db.query("SELECT difficulty FROM problem WHERE id=?", [problems[0]]);
  assert.equal(Number(unchanged[0].difficulty), 1000);
  assert.equal(calls, 1, "queued cancelled jobs never invoke the provider");
  const raised = await request(token, "ai/saveConfiguration", {
    llm: { type: "chat", baseUrl: "http://127.0.0.1:2230", model: "fixture", maxTokens: 4096 },
    search: { type: "tavily", baseUrl: "http://127.0.0.1:2230" },
    autoOnSave: false,
    maxConcurrentJobs: 2
  });
  assert.equal(raised.maxConcurrentJobs, 2);
  const parallel = await Promise.all(
    problems.slice(1, 3).map(problemId => request(token, "ai/start", { problemId, action: "difficulty" }))
  );
  for (const entry of parallel) {
    assert(entry.job?.id, JSON.stringify(entry));
    activeIds.push(entry.job.id);
  }
  await poll(() => held.length === 2, "two actual concurrent model requests");
  assert.equal(
    (await request(token, "ai/jobs", {})).jobs.filter(
      job => parallel.some(item => item.job.id === job.id) && job.status === "running"
    ).length,
    2
  );
  for (const entry of parallel) await request(token, "ai/cancel", { id: entry.job.id });
  held.splice(0).forEach(release => release());
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(calls, 3);

  const completed = await db.query(
    "SELECT id,problemId,state FROM ai_job WHERE ownerId=? AND action='import' AND status='completed' ORDER BY createdAt DESC LIMIT 1",
    [fixtureUserId]
  );
  assert.equal(completed.length, 1, "run ai-integration.test.mjs first");
  const previous = completed[0],
    checkpoint = parse(previous.state),
    discussionId = checkpoint.discussionId;
  const beforeProblems = await db.query(
    "SELECT COUNT(*) n FROM localized_content WHERE type='ProblemTitle' AND locale='zh_CN' AND data='隔离 AI 验收：两数之和'"
  );
  const beforeDiscussions = await db.query("SELECT COUNT(*) n FROM discussion WHERE problemId=?", [previous.problemId]);
  checkpoint.completed = checkpoint.completed.filter(action => !["import", "tutorial"].includes(action));
  // This is exactly the durable state left after a worker commits artifacts and then exits
  // before it checkpoints completion. The next advisory-lock owner must recover it.
  await db.query("UPDATE ai_job SET status='running',state=?,progress=40,step='tutorial' WHERE id=?", [
    JSON.stringify(checkpoint),
    previous.id
  ]);
  await poll(async () => (await getJob(previous.id))?.status === "completed", "abandoned worker recovery");
  const recovered = await getJob(previous.id);
  assert.equal(recovered.problemId, previous.problemId);
  assert.equal(recovered.result.discussionId, discussionId);
  const afterProblems = await db.query(
    "SELECT COUNT(*) n FROM localized_content WHERE type='ProblemTitle' AND locale='zh_CN' AND data='隔离 AI 验收：两数之和'"
  );
  const afterDiscussions = await db.query("SELECT COUNT(*) n FROM discussion WHERE problemId=?", [previous.problemId]);
  assert.equal(Number(afterProblems[0].n), Number(beforeProblems[0].n));
  assert.equal(Number(afterDiscussions[0].n), Number(beforeDiscussions[0].n));
  assert.equal(calls, 3, "committed import/tutorial recovery makes no new model calls");
  activeIds.push(previous.id);
  const finishedState = async () =>
    parse((await db.query("SELECT state FROM ai_job WHERE id=?", [previous.id]))[0].state);
  const waitCompleted = async label =>
    poll(
      async () => {
        const current = await getJob(previous.id);
        if (current?.status === "failed") throw fixtureHandlerError || new Error(`${label}: ${current.error}`);
        return current?.status === "completed";
      },
      label,
      120000
    );
  const beforePublicationRecovery = await request(token, "problem/getProblem", {
    id: previous.problemId,
    judgeInfo: true,
    testData: true
  });
  const published = await finishedState();
  assert.match(published.testdataSnapshotHash, /^[0-9a-f]{64}$/);
  assert.match(published.testdataPublishedSnapshotHash, /^[0-9a-f]{64}$/);
  // Simulate exactly the crash window after judgeInfo commits but before action completion.
  published.completed = published.completed.filter(action => action !== "testdata");
  await db.query("UPDATE ai_job SET status='running',state=?,progress=98,step='testdata.upload' WHERE id=?", [
    JSON.stringify(published),
    previous.id
  ]);
  await waitCompleted("published testdata checkpoint recovery");
  const afterPublicationRecovery = await request(token, "problem/getProblem", {
    id: previous.problemId,
    judgeInfo: true,
    testData: true,
    localizedContentsOfAllLocales: true,
    samples: true,
    tagsOfAllLocales: true
  });
  assert.notDeepEqual(
    afterPublicationRecovery.judgeInfo.subtasks,
    beforePublicationRecovery.judgeInfo.subtasks,
    "recovery activates a fresh immutable generation without overwriting the previous files"
  );
  const activeFileNames = new Set(afterPublicationRecovery.testData.map(file => file.filename));
  for (const subtask of beforePublicationRecovery.judgeInfo.subtasks)
    for (const testcase of subtask.testcases) {
      assert(activeFileNames.has(testcase.inputFile));
      assert(activeFileNames.has(testcase.outputFile));
    }
  assert.equal(calls, 3);
  assert.equal(
    Object.values(generationCalls).reduce((sum, count) => sum + count, 0),
    0,
    "a matching self-publication reuses cached plan and programs without inference"
  );
  const stableState = await finishedState();
  const statements = structuredClone(afterPublicationRecovery.localizedContentsOfAllLocales);
  const englishDescription = statements
    .find(item => item.locale === "en_US")
    .contentSections.find(section => section.type === "Text");
  englishDescription.text += "\nThis statement was edited for the isolated snapshot recovery test.";
  const edited = await request(token, "problem/updateStatement", {
    problemId: previous.problemId,
    localizedContents: statements,
    problemTagIds: afterPublicationRecovery.tagsOfAllLocales.map(tag => tag.id),
    samples: afterPublicationRecovery.samples
  });
  assert(!edited.error, JSON.stringify(edited));
  stableState.completed = stableState.completed.filter(action => action !== "testdata");
  await db.query("UPDATE ai_job SET status='running',state=?,progress=90,step='testdata.compile' WHERE id=?", [
    JSON.stringify(stableState),
    previous.id
  ]);
  await poll(async () => (await getJob(previous.id))?.status === "failed", "changed snapshot rejected");
  assert.equal((await getJob(previous.id)).error, "PROBLEM_CHANGED_DURING_AI");
  assert.equal(calls, 3);
  assert.equal(
    Object.values(generationCalls).reduce((sum, count) => sum + count, 0),
    0
  );
  const unchangedPublication = await request(token, "problem/getProblem", {
    id: previous.problemId,
    judgeInfo: true,
    testData: true
  });
  assert.deepEqual(unchangedPublication.judgeInfo, afterPublicationRecovery.judgeInfo);
  assert.deepEqual(
    unchangedPublication.testData.map(file => file.filename).sort(),
    afterPublicationRecovery.testData.map(file => file.filename).sort(),
    "stale cache rejection publishes nothing"
  );
  generationFixture = {
    ...stableState,
    jobId: previous.id,
    oldSnapshotHash: stableState.testdataSnapshotHash,
    oldPublishedHash: stableState.testdataPublishedSnapshotHash
  };
  const retried = await request(token, "ai/retry", { id: previous.id });
  assert(!retried.error, JSON.stringify(retried));
  await waitCompleted("fresh inference after changed snapshot retry");
  assert.deepEqual(generationCalls, {
    plan: 1,
    makeCode: 1,
    stdCode: 1,
    checkerCode: stableState.plan.needsSpj ? 1 : 0,
    validatorCode: 1
  });
  const rebuilt = await finishedState();
  assert.notEqual(rebuilt.testdataSnapshotHash, stableState.testdataSnapshotHash);
  assert.deepEqual(rebuilt.generated.sampleValidation, {
    samplesPassed: afterPublicationRecovery.samples.length,
    inputsPassed: 6,
    sampleInputsPassed: afterPublicationRecovery.samples.length
  });
  assert.equal((await getJob(previous.id)).result.discussionId, discussionId);
  assert.equal(
    Number((await db.query("SELECT COUNT(*) n FROM discussion WHERE problemId=?", [previous.problemId]))[0].n),
    Number(beforeDiscussions[0].n)
  );
  console.log(
    JSON.stringify({
      success: true,
      configuredConcurrentLimit: 2,
      actualConcurrentRequests: 2,
      queueLimit: 100,
      duplicateDeduplicated: true,
      retryQuotaEnforced: true,
      retryProblemLockEnforced: true,
      cancelledResultDiscarded: true,
      queuedCancelledBeforeInference: true,
      durableRecoveryWithoutDuplicateArtifacts: true,
      publishedTestdataRecoveryWithoutNewInference: true,
      changedSnapshotRejectedWithoutPublication: true,
      retryClearsBoundCachesAndRegenerates: true,
      modelRequestsObserveCurrentProgress: true,
      freshGenerationRequests: generationCalls
    })
  );
} finally {
  for (const id of activeIds) {
    try {
      await request(token, "ai/cancel", { id });
    } catch {}
  }
  held.splice(0).forEach(release => release());
  await clearMockFixtureConfiguration();
  await new Promise(resolve => server.close(resolve));
  await close();
}
