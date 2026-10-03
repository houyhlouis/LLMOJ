/* Isolated metadata/recovery/scheduler regression tests. No provider credentials or external requests. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
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
const { AiError } = require("./ai.types.ts");
const { generateText, searchWeb, listModels } = require("./ai-provider.ts");
const { withAiRuntime, extractUsage, aiWorkerLockName } = require("./ai-runtime.ts");
const { responsesRecoveryEnabled, recoverableResponse } = require("./ai-responses.ts");
const { AiUsageService } = require("./ai-usage.service.ts");
const { AiService } = require("./ai.service.ts");
const { LlmConfigurationDto, SaveAiConfigurationDto } = require("./ai.dto.ts");
const { validateLlmConfiguration } = require("./ai-validation.ts");
const { validateSync } = require("class-validator");
const { plainToInstance } = require("class-transformer");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const poll = async predicate => {
  const end = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < end, "Timed out");
    await pause(5);
  }
};
const config = {
  type: "responses",
  baseUrl: "https://api.openai.com/v1",
  model: "fixture",
  apiKey: "secret-not-real",
  maxTokens: 4096
};
const checkpointContext = () => {
  const saved = new Map(),
    records = [];
  return {
    saved,
    records,
    ownerId: 1,
    jobId: "mock-job",
    record: async r => records.push(r),
    loadResponse: async key => saved.get(key) || null,
    saveResponse: async (key, value) => {
      saved.set(key, value);
    }
  };
};

test("recovery capabilities are explicit; DeepSeek's stateless Responses never pretend to resume", () => {
  assert.equal(responsesRecoveryEnabled(config), true);
  assert.equal(responsesRecoveryEnabled({ ...config, responsesRecovery: "off" }), false);
  assert.equal(responsesRecoveryEnabled({ ...config, type: "chat" }), false);
  assert.equal(responsesRecoveryEnabled({ ...config, baseUrl: "https://api.deepseek.com" }), false);
  assert.equal(responsesRecoveryEnabled({ ...config, baseUrl: "https://compatible.example/v1" }), false);
  assert.equal(
    responsesRecoveryEnabled({ ...config, baseUrl: "https://compatible.example/v1", responsesRecovery: "background" }),
    true
  );
  assert.throws(
    () => responsesRecoveryEnabled({ ...config, baseUrl: "https://api.deepseek.com", responsesRecovery: "background" }),
    /RESPONSES_RECOVERY_UNSUPPORTED/
  );
  assert.throws(
    () => validateLlmConfiguration({ ...config, baseUrl: "https://api.deepseek.com", responsesRecovery: "background" }),
    /RESPONSES_RECOVERY_UNSUPPORTED/
  );
});
test("background response survives transient GET disconnect without another paid POST", async () => {
  const context = checkpointContext();
  let posts = 0,
    gets = 0;
  const result = await withAiRuntime(context, () =>
    recoverableResponse(
      config,
      { input: "private question" },
      async (suffix, body) => {
        if (!suffix) {
          posts++;
          assert.equal(body.background, true);
          assert.equal(body.store, false);
          return { id: "resp_fixture", status: "queued" };
        }
        gets++;
        assert.equal(body, undefined);
        if (gets === 1) throw new AiError("PROVIDER_NETWORK_ERROR");
        if (gets === 2) return { id: "resp_fixture", status: "in_progress" };
        return { id: "resp_fixture", status: "completed", output_text: "done" };
      },
      { pollMs: 1 }
    )
  );
  assert.equal(result.output_text, "done");
  assert.equal(posts, 1);
  assert.equal(gets, 3);
  assert.equal(context.saved.size, 1);
  assert(!JSON.stringify([...context.saved]).includes("private question"));
  assert(!JSON.stringify([...context.saved]).includes(config.apiKey));
});
test("persisted response checkpoint resumes after process interruption; changed request/credential is separately bound", async () => {
  const context = checkpointContext();
  let posts = 0;
  await assert.rejects(
    withAiRuntime(context, () =>
      recoverableResponse(
        config,
        { input: "A" },
        async suffix => {
          if (!suffix) {
            posts++;
            return { id: "resp_persisted", status: "queued" };
          }
          throw new AiError("PROVIDER_NETWORK_ERROR");
        },
        { pollMs: 1, recoveryWindowMs: 1 }
      )
    ),
    /RESPONSE_RECOVERY_INTERRUPTED/
  );
  const resumed = await withAiRuntime(context, () =>
    recoverableResponse(
      config,
      { input: "A" },
      async suffix => {
        assert.equal(suffix, "/resp_persisted");
        return { id: "resp_persisted", status: "completed", output_text: "recovered" };
      },
      { pollMs: 1 }
    )
  );
  assert.equal(resumed.output_text, "recovered");
  assert.equal(posts, 1);
  await withAiRuntime(context, () =>
    recoverableResponse({ ...config, apiKey: "rotated-fake" }, { input: "A" }, async suffix => {
      assert.equal(suffix, "");
      posts++;
      return { id: "resp_rotated", status: "completed", output_text: "fresh" };
    })
  );
  assert.equal(posts, 2);
});
test("unknown POST acknowledgement and expired response are never automatically resubmitted", async () => {
  let requests = 0;
  await assert.rejects(
    recoverableResponse(
      config,
      {},
      async () => {
        requests++;
        throw new AiError("PROVIDER_NETWORK_ERROR");
      },
      { pollMs: 1 }
    ),
    /PROVIDER_NETWORK_ERROR/
  );
  assert.equal(requests, 1);
  requests = 0;
  const context = checkpointContext();
  context.loadResponse = async () => ({ responseId: "resp_expired", createdAt: Date.now() });
  await assert.rejects(
    withAiRuntime(context, () =>
      recoverableResponse(
        config,
        {},
        async suffix => {
          assert.equal(suffix, "/resp_expired");
          requests++;
          throw new AiError("PROVIDER_HTTP_ERROR", "404");
        },
        { pollMs: 1 }
      )
    ),
    /RESPONSE_RECOVERY_EXPIRED/
  );
  assert.equal(requests, 1);
});
test("background polling checks job cancellation before another request", async () => {
  const context = checkpointContext();
  context.checkActive = async () => {
    throw new AiError("JOB_CANCELLED");
  };
  let calls = 0;
  await assert.rejects(
    withAiRuntime(context, () =>
      recoverableResponse(config, {}, async () => {
        calls++;
        return { id: "resp_cancelled", status: "queued" };
      })
    ),
    /JOB_CANCELLED/
  );
  assert.equal(calls, 1);
});
test("usage parsing keeps provider numbers and unknowns without inventing billing", () => {
  assert.deepEqual(
    extractUsage({
      usage: {
        prompt_tokens: 123,
        completion_tokens: 45,
        prompt_cache_hit_tokens: 12,
        completion_tokens_details: { reasoning_tokens: 30 }
      }
    }),
    {
      inputTokens: 123,
      outputTokens: 45,
      cachedTokens: 12,
      reasoningTokens: 30,
      searchCredits: null,
      usageReported: true
    }
  );
  assert.equal(extractUsage({ usage: { input_tokens: -1, output_tokens: "42" } }).inputTokens, null);
  assert.equal(extractUsage({}).usageReported, false);
  assert.equal(extractUsage({ result: { _meta: { usage: { credits: 1.5 } } } }).searchCredits, 1.5);
});
test("loopback LLM/models/Tavily/MCP requests meter all owners independently, including failures; no payloads leak", async () => {
  process.env.HYHOJ_AI_PRIVATE_HOSTS = "127.0.0.1";
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/models") return res.end(JSON.stringify({ data: [{ id: "fixture" }] }));
    if (req.url === "/search") {
      assert.equal(body.include_usage, true);
      return res.end(
        JSON.stringify({
          usage: { credits: 2 },
          results: [{ title: "Synthetic", url: "https://example.com", content: "Search secret content" }]
        })
      );
    }
    if (req.url === "/mcp")
      return res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "tools/list"
              ? { tools: [{ name: "search", inputSchema: { properties: { query: {} } } }] }
              : body.method === "tools/call"
              ? { content: [{ type: "text", text: "MCP private result" }], _meta: { usage: { credits: 3 } } }
              : { protocolVersion: "2025-03-26" }
        })
      );
    if (body.messages.at(-1).content === "fail") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "provider secret body" }));
    }
    res.end(
      JSON.stringify({
        usage: { prompt_tokens: 8, completion_tokens: 4 },
        choices: [{ finish_reason: "stop", message: { content: "private result" } }]
      })
    );
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const first = checkpointContext(),
    second = { ...checkpointContext(), ownerId: 2 };
  try {
    const llm = { ...config, type: "chat", baseUrl };
    await Promise.all([
      withAiRuntime(first, async () => {
        await listModels(llm);
        await generateText(llm, "private system", "private prompt");
        await searchWeb({ type: "tavily", baseUrl, apiKey: "private-search-key" }, "private query");
      }),
      withAiRuntime(second, async () => {
        await assert.rejects(generateText(llm, "system", "fail"), /PROVIDER_HTTP_ERROR/);
        await searchWeb({ type: "mcp", baseUrl: baseUrl + "/mcp", apiKey: "private-mcp-key" }, "private mcp query");
      })
    ]);
    assert.equal(first.records.length, 3);
    assert.equal(second.records.length, 5);
    assert.equal(first.records[1].inputTokens, 8);
    assert.equal(first.records[1].outputTokens, 4);
    assert.equal(first.records[2].searchCredits, 2);
    assert.equal(second.records.at(-1).searchCredits, 3);
    assert.equal(second.records[0].success, false);
    assert.equal(second.records[0].errorCode, "PROVIDER_HTTP_ERROR");
    for (const secret of [
      "private prompt",
      "private system",
      "private query",
      "private result",
      "private-search-key",
      "private-mcp-key",
      "provider secret body",
      config.apiKey
    ])
      assert(!JSON.stringify([...first.records, ...second.records]).includes(secret));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
test("metering deduplicates tokens from repeated response retrieval but records each HTTP attempt", async () => {
  const rows = [];
  const repo = {
    findOneBy: async filter => rows.find(row => Object.entries(filter).every(([key, value]) => row[key] === value)),
    insert: async row => rows.push(row)
  };
  const usage = new AiUsageService(
    { transaction: async cb => cb({ findOne: async () => ({ id: 1 }), getRepository: () => repo }) },
    repo,
    {}
  );
  const context = usage.context(1, "job");
  const record = {
    target: "llm",
    provider: "responses",
    host: "example.com",
    model: "fixture",
    operation: "responses.poll",
    success: true,
    errorCode: null,
    elapsedMs: 5,
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 0,
    reasoningTokens: 5,
    searchCredits: null,
    usageReported: true,
    responseId: "resp_unique"
  };
  await context.record(record);
  await context.record(record);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].inputTokens, 10);
  assert.equal(rows[1].inputTokens, null);
  assert(!JSON.stringify(rows).includes("resp_unique"));
});
function schedulerFixture(jobs, limits) {
  const service = Object.create(AiService.prototype);
  service.busy = false;
  service.stopped = false;
  const active = new Set(),
    held = new Map(),
    started = [],
    finished = [];
  let releaseAutomatically = false,
    releasedLock = false;
  const matches = (row, where) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "_value" in value ? value._value.includes(row[key]) : row[key] === value
    );
  service.db = {
    createQueryRunner: () => ({
      connect: async () => {},
      query: async sql => {
        if (sql.includes("GET_LOCK")) return [{ acquired: 1 }];
        if (sql.includes("IS_USED_LOCK")) return [{ owned: 1 }];
        releasedLock = true;
        return [];
      },
      release: async () => {
        assert.equal(active.size, 0);
      }
    })
  };
  service.config = async owner => ({ maxConcurrentJobs: limits[owner] || 3 });
  service.jobs = {
    update: async (where, patch) => {
      const matched = jobs.filter(row => matches(row, typeof where === "string" ? { id: where } : where));
      matched.forEach(row => Object.assign(row, patch));
      return { affected: matched.length };
    },
    find: async ({ where }) => jobs.filter(row => matches(row, where)),
    findOneBy: async where => jobs.find(row => matches(row, where))
  };
  service.assertJob = async () => ({ id: 1 });
  service.execute = async job => {
    assert(!releasedLock);
    assert(!active.has(job.problemId), "same-problem execution overlaps");
    active.add(job.problemId);
    started.push(job.id);
    if (!releaseAutomatically) await new Promise(resolve => held.set(job.id, resolve));
    active.delete(job.problemId);
    finished.push(job.id);
  };
  return {
    service,
    active,
    started,
    finished,
    jobs,
    releaseAll: () => {
      releaseAutomatically = true;
      for (const release of held.values()) release();
    }
  };
}
const fakeJob = (id, ownerId, problemId = id, status = "queued") => ({
  id: String(id),
  ownerId,
  problemId,
  status,
  state: { completed: [] },
  input: { count: 5 }
});
test("worker runs jobs concurrently with per-user and global limits, and holds the cluster lock through all siblings", async () => {
  const fixture = schedulerFixture(
    [
      ...Array.from({ length: 4 }, (_, i) => fakeJob(i + 1, 1)),
      ...Array.from({ length: 5 }, (_, i) => fakeJob(i + 10, 2)),
      ...Array.from({ length: 7 }, (_, i) => fakeJob(i + 20, 3))
    ],
    { 1: 2, 2: 3, 3: 8 }
  );
  const work = fixture.service.work();
  await poll(() => fixture.started.length === 8);
  assert.equal(fixture.jobs.filter(row => row.status === "running" && row.ownerId === 1).length, 2);
  assert.equal(fixture.jobs.filter(row => row.status === "running" && row.ownerId === 2).length, 3);
  assert.equal(fixture.active.size, 8);
  fixture.releaseAll();
  await work;
  assert.equal(fixture.finished.length, 16);
  assert(fixture.jobs.every(row => row.status === "completed"));
});
test("worker recovers abandoned jobs and serializes matching problems across owners", async () => {
  const fixture = schedulerFixture([fakeJob(1, 1, 10, "running"), fakeJob(2, 2, 10), fakeJob(3, 1, 20)], {
    1: 2,
    2: 2
  });
  const work = fixture.service.work();
  await poll(() => fixture.started.length === 2);
  assert.deepEqual(fixture.started, ["1", "3"]);
  fixture.releaseAll();
  await work;
  assert.equal(fixture.jobs[1].status, "completed");
  assert.equal(fixture.finished.length, 3);
});
test("configuration DTO validates concurrency and recovery modes", () => {
  const dto = {
    llm: { type: "chat", baseUrl: "https://example.com", model: "x" },
    search: { type: "tavily", baseUrl: "https://example.com" },
    autoOnSave: false
  };
  for (const value of [1, 3, 8])
    assert.equal(validateSync(plainToInstance(SaveAiConfigurationDto, { ...dto, maxConcurrentJobs: value })).length, 0);
  for (const value of [0, 9, 1.2])
    assert(validateSync(plainToInstance(SaveAiConfigurationDto, { ...dto, maxConcurrentJobs: value })).length > 0);
  assert(validateSync(plainToInstance(LlmConfigurationDto, { ...dto.llm, responsesRecovery: "pretend" })).length > 0);
});
test("usage report queries only its authenticated owner and strips internal response hashes", async () => {
  const queries = [];
  const now = new Date();
  const usage = new AiUsageService(
    {
      query: async (sql, args) => {
        queries.push({ sql, args });
        return sql.includes("GROUP BY")
          ? []
          : [
              {
                requests: "2",
                succeeded: "1",
                failed: "1",
                elapsedMs: "10",
                inputTokens: null,
                outputTokens: "5",
                cachedTokens: null,
                reasoningTokens: null,
                searchCredits: null,
                unknownTokenRequests: "1"
              }
            ];
      }
    },
    {
      find: async options => {
        assert.deepEqual(options.where, { ownerId: 7 });
        return [
          {
            id: "a",
            ownerId: 7,
            responseHash: "private-response-hash",
            createdAt: now,
            success: true,
            inputTokens: "3",
            outputTokens: null
          }
        ];
      }
    },
    {}
  );
  const report = await usage.report(7, 7);
  assert.equal(report.totals.inputTokens, null);
  assert.equal(report.totals.outputTokens, 5);
  assert.equal(report.recent[0].inputTokens, 3);
  assert(!JSON.stringify(report).includes("private-response-hash"));
  assert(!("ownerId" in report.recent[0]));
  assert(queries.every(query => query.sql.includes("ownerId=?") && query.args[0] === 7));
  await assert.rejects(usage.report(7, 367), /INVALID_USAGE_PERIOD/);
  const service = Object.create(AiService.prototype);
  service.usage = { report: async (id, days) => ({ id, days }) };
  assert.deepEqual(await service.usageReport({ id: 7 }, 30), { id: 7, days: 30 });
  await assert.rejects(service.usageReport(null, 30), /PERMISSION_DENIED/);
});
test("a cancelled sibling frees capacity and reducing a user's limit prevents new starts without cancelling its running request", async () => {
  const limits = { 1: 2 };
  const fixture = schedulerFixture([fakeJob(1, 1), fakeJob(2, 1), fakeJob(3, 1)], limits);
  const work = fixture.service.work();
  await poll(() => fixture.started.length === 2);
  limits[1] = 1;
  fixture.jobs[1].status = "cancelled";
  // Existing requests remain counted until their safe completion, even after cancellation.
  await pause(20);
  assert.equal(fixture.started.length, 2);
  fixture.releaseAll();
  await work;
  assert.equal(fixture.jobs[1].status, "cancelled");
  assert.equal(fixture.jobs[2].status, "completed");
});
test("automatic requests from stale browsers do not enqueue jobs or access API configuration", async () => {
  const service = Object.create(AiService.prototype);
  service.config = () => {
    throw Error("must not access keys");
  };
  assert.deepEqual(await service.start({ id: 1 }, { action: "metadata", automatic: true, problemId: 1 }), {
    skipped: true
  });
});
test("explicit semantic retry discards old provider results while a short-outage retry preserves its response handle", async () => {
  for (const [error, expectedDeletes] of [
    ["UNVERIFIED_AI_SOURCE", 1],
    ["RESPONSE_RECOVERY_EXPIRED", 1],
    ["RESPONSE_RECOVERY_INTERRUPTED", 0]
  ]) {
    const service = Object.create(AiService.prototype),
      deleted = [];
    const job = {
      id: "retry-job",
      ownerId: 1,
      status: "failed",
      action: "difficulty",
      problemId: null,
      error,
      state: { completed: [] }
    };
    service.requirePrivilege = async () => {};
    service.jobs = { findOneBy: async () => job };
    service.work = async () => {};
    service.db = {
      transaction: async work =>
        work({
          findOne: async () => ({ id: 1 }),
          getRepository: () => ({ countBy: async () => 0, update: async () => ({ affected: 1 }) }),
          delete: async (_entity, where) => deleted.push(where)
        })
    };
    await service.retry({ id: 1 }, job.id);
    assert.equal(deleted.length, expectedDeletes);
    if (deleted.length) assert.deepEqual(deleted[0], { ownerId: 1, jobId: job.id });
  }
});
test("full Responses HTTP integration reconnects a dropped GET without repeating the creation POST", async () => {
  process.env.HYHOJ_AI_PRIVATE_HOSTS = "127.0.0.1";
  let posts = 0,
    gets = 0;
  const context = checkpointContext();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") {
      posts++;
      const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.background, true);
      assert.equal(body.store, false);
      res.end(JSON.stringify({ id: "resp_network", object: "response", status: "queued" }));
      return;
    }
    gets++;
    assert.equal(req.url, "/responses/resp_network");
    if (gets === 1) {
      req.socket.destroy();
      return;
    }
    res.end(
      JSON.stringify({
        id: "resp_network",
        object: "response",
        status: "completed",
        output_text: "reconnected",
        usage: { input_tokens: 3, output_tokens: 4 }
      })
    );
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = { ...config, baseUrl: `http://127.0.0.1:${server.address().port}`, responsesRecovery: "background" };
  try {
    assert.equal(await withAiRuntime(context, () => generateText(provider, "system", "question")), "reconnected");
    assert.equal(posts, 1);
    assert.equal(gets, 2);
    assert.deepEqual(
      context.records.map(record => record.success),
      [true, false, true]
    );
    assert.equal(context.records[2].outputTokens, 4);
    assert.equal(await withAiRuntime(context, () => generateText(provider, "system", "question")), "reconnected");
    assert.equal(posts, 1);
    assert.equal(gets, 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
test("stale run completion and error paths cannot overwrite or audit a newer job claim", async () => {
  const service = Object.create(AiService.prototype),
    audits = [],
    updates = [];
  const job = {
    id: "fenced",
    ownerId: 1,
    problemId: 1,
    runToken: "old",
    input: { count: 5 },
    state: { completed: [] }
  };
  service.recordAiAudit = async (_owner, action) => audits.push(action);
  service.execute = async () => {};
  service.assertJob = async () => {};
  service.jobs = {
    findOneBy: async () => ({ status: "running", runToken: "new" }),
    update: async where => {
      updates.push(where);
      return { affected: 0 };
    }
  };
  await service.runJob(job);
  assert(updates.every(where => where.runToken === "old"));
  assert(!audits.includes("job.complete"));
  assert(!audits.includes("job.fail"));
});
test("model discovery and connection failures are audited without provider error text or credentials",async()=>{
  const service=Object.create(AiService.prototype),audits=[];
  service.requirePrivilege=async()=>{};service.recordAiAudit=async(actor,action,job,details)=>audits.push({actor,action,details});
  service.config=async()=>({llm:{type:"chat",baseUrl:"https://example.org",model:"fixture",apiKey:""},search:{type:"tavily",baseUrl:"https://example.org",apiKey:""}});
  await assert.rejects(service.models({id:7}),/LLM_NOT_CONFIGURED/);
  await assert.rejects(service.test({id:7},"search"),/SEARCH_NOT_CONFIGURED/);
  assert.deepEqual(audits.map(item=>[item.action,item.details.success,item.details.errorCode]),[
    ["models.list",false,"LLM_NOT_CONFIGURED"],["connection.test",false,"SEARCH_NOT_CONFIGURED"]
  ]);
  service.config=async()=>{throw Error("provider-secret-or-body-must-not-appear");};
  await assert.rejects(service.test({id:7},"llm"));
  assert.equal(audits.at(-1).details.errorCode,"INTERNAL_ERROR");
  assert(!JSON.stringify(audits).includes("provider-secret-or-body"));
});
test("a post-commit failure preserves artifact flags and localized discussion IDs stored by the transaction",async()=>{
  const service=Object.create(AiService.prototype);
  const persisted={id:"committed",runToken:"lease",status:"running",state:{completed:["import"],attachmentAdditionalDone:true,attachmentHiddenDone:true,discussionIds:{zh_CN:11,en_US:12}}};
  const job={id:persisted.id,runToken:"lease",ownerId:1,state:{completed:[],discussionIds:{zh_CN:11}},input:{count:5}};
  service.recordAiAudit=async()=>{};service.execute=async()=>{throw Error("Redis disconnected after registration commit");};
  service.jobs={findOneBy:async()=>persisted,update:async(where,patch)=>{assert.equal(where.runToken,"lease");assert(!("state"in patch));Object.assign(persisted,patch);return{affected:1};}};
  await service.runJob(job);
  assert.equal(persisted.status,"failed");assert.equal(persisted.state.attachmentHiddenDone,true);
  assert.deepEqual(persisted.state.discussionIds,{zh_CN:11,en_US:12});assert.deepEqual(persisted.state.completed,["import"]);
});


test("scheduler advisory locks use one parameterized database-specific name for acquire, ownership and release", async () => {
  assert.equal(aiWorkerLockName("production"), aiWorkerLockName("production"));
  assert.notEqual(aiWorkerLockName("production"), aiWorkerLockName("development"));
  assert.equal(aiWorkerLockName(), aiWorkerLockName(undefined));
  assert.match(aiWorkerLockName("a".repeat(4096)), /^hyhoj_ai_worker:[0-9a-f]{48}$/);
  assert.equal(aiWorkerLockName("a".repeat(4096)).length, 64);
  const fixture = schedulerFixture([], {});
  const queries = [];
  fixture.service.db.options = { database: "qa'unsafe-db" };
  fixture.service.db.createQueryRunner = () => ({
    connect: async () => {},
    query: async (sql, args) => {
      queries.push({ sql, args });
      return sql.includes("GET_LOCK") ? [{ acquired: 1 }] : sql.includes("IS_USED_LOCK") ? [{ owned: 1 }] : [];
    },
    release: async () => {}
  });
  await fixture.service.work();
  assert.deepEqual(queries.map(q => q.sql), [
    "SELECT GET_LOCK(?, 0) AS acquired",
    "SELECT (IS_USED_LOCK(?) = CONNECTION_ID()) AS owned",
    "SELECT RELEASE_LOCK(?)"
  ]);
  for (const query of queries) assert.deepEqual(query.args, [aiWorkerLockName("qa'unsafe-db")]);
});

test("cancelling stalled provider traffic destroys its socket and preserves JOB_CANCELLED for chat and search", async () => {
  process.env.HYHOJ_AI_PRIVATE_HOSTS = "127.0.0.1";
  let received = 0, closed = 0;
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    received++;
    res.on("close", () => closed++);
    // A slow external provider never replies; cancellation must close this socket.
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const type of ["chat", "responses", "anthropic", "tavily", "mcp"]) {
      const controller = new AbortController();
      const context = { ...checkpointContext(), signal: controller.signal };
      const before = received;
      const request = withAiRuntime(context, () => ["tavily", "mcp"].includes(type)
        ? searchWeb({ type, baseUrl, apiKey: "synthetic" }, "synthetic query")
        : generateText({ ...config, type, baseUrl, responsesRecovery: "off" }, "system", "prompt"));
      const rejection = assert.rejects(request, error => error instanceof AiError && error.code === "JOB_CANCELLED");
      await poll(() => received === before + 1);
      const started = Date.now();
      controller.abort(new AiError("JOB_CANCELLED"));
      await rejection;
      await poll(() => closed === received);
      assert(Date.now() - started < 1000, "cancellation must not wait for the provider timeout");
      assert.equal(context.records.length, 1);
      assert.equal(context.records[0].errorCode, "JOB_CANCELLED");
      assert.equal(context.records[0].success, false);
      assert.equal(received, before + 1, "cancelled searches must not start a fallback or retry");
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const throughAnotherWorker of [false, true]) {
  test(`a ${throughAnotherWorker ? "remote" : "local"} cancellation unblocks the same problem after request cleanup`, async () => {
    process.env.HYHOJ_AI_PRIVATE_HOSTS = "127.0.0.1";
    const sockets = new Set(), mutations = [];
    let requests = 0, closed = 0;
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {}
      requests++;
      res.on("close", () => closed++);
      if (requests === 2) res.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
    });
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const fixture = schedulerFixture([fakeJob(1, 1, 42), fakeJob(2, 1, 42)], { 1: 1 });
    fixture.service.execute = async job => {
      assert.equal(fixture.active.size, 0, "same-problem execution must wait for the old Promise to finish");
      fixture.active.add(job.problemId);
      fixture.started.push(job.id);
      try {
        await generateText({ ...config, type: "chat", baseUrl: `http://127.0.0.1:${server.address().port}` }, "system", "prompt");
        mutations.push(job.id);
      } finally {
        fixture.active.delete(job.problemId);
        fixture.finished.push(job.id);
      }
    };
    const work = fixture.service.work();
    try {
      await poll(() => requests === 1);
      const started = Date.now();
      if (throughAnotherWorker) fixture.jobs[0].status = "cancelled";
      else await fixture.service.cancel({ id: 1 }, "1");
      await poll(() => fixture.finished.length === 2);
      await work;
      assert(Date.now() - started < 2000, "new work must not wait minutes for the cancelled request");
      assert.deepEqual(fixture.started, ["1", "2"]);
      assert.deepEqual(mutations, ["2"], "the cancelled model result must never reach problem writes");
      assert.equal(fixture.jobs[0].status, "cancelled");
      assert.equal(fixture.jobs[0].error, null);
      assert.equal(fixture.jobs[1].status, "completed");
      assert.equal(fixture.service.activeRuns.size, 0);
      await poll(() => closed === requests);
    } finally {
      for (const socket of sockets) socket.destroy();
      await work;
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test("background polling delay aborts immediately and sends no subsequent retrieval", async () => {
  const controller = new AbortController();
  const context = { ...checkpointContext(), signal: controller.signal };
  let requests = 0;
  const request = withAiRuntime(context, () => recoverableResponse(config, {}, async () => {
    requests++;
    return { id: "resp_cancelled", status: "queued" };
  }, { pollMs: 10000 }));
  const rejection = assert.rejects(request, /JOB_CANCELLED/);
  await poll(() => context.saved.size === 1);
  const started = Date.now();
  controller.abort(new AiError("JOB_CANCELLED"));
  await rejection;
  assert(Date.now() - started < 1000);
  assert.equal(requests, 1);
});

test("old-run cleanup preserves a newer controller with the same job ID", async () => {
  const service = Object.create(AiService.prototype);
  const newer = new AbortController();
  const job = fakeJob("same-id", 1);
  job.runToken = "old";
  service.assertJob = async () => {};
  service.execute = async () => { service.activeRuns.set(job.id, newer); };
  service.jobs = { findOneBy: async () => job, update: async () => ({ affected: 1 }) };
  await service.runJob(job);
  assert.equal(service.activeRuns.get(job.id), newer);
});
