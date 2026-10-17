/* Admission of AI provider requests: the site pause, simultaneous requests, job limits, 24-hour budgets with
   reservations, and their settlement. Isolated: no database, provider or network. */
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
const { AiError } = require("./ai.types.ts");
const {
  withAiRuntime,
  meterProviderRequest,
  currentAiRuntime,
  isBillableRequest,
  estimateTokens
} = require("./ai-runtime.ts");
const { AiAdmissionService, aiResponseHash } = require("./ai-admission.service.ts");
const { AiReservationEntity } = require("./ai-reservation.entity.ts");
const { AiService } = require("./ai.service.ts");
const { parseAiPolicy, DEFAULT_AI_POLICY } = require("../settings/ai-policy.service.ts");

const generate = { target: "llm", provider: "chat", host: "api.example.com", model: "m", operation: "generate" };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** An admission service over an in-memory ledger. */
function harness(policy = {}, { usageRows = [], jobRequests = 0 } = {}) {
  const reservations = [];
  const queries = [];
  const current = { ...DEFAULT_AI_POLICY, ...policy };
  const sum = (rows, field) => rows.reduce((total, row) => total + (row[field] || 0), 0);
  const repository = {
    delete: async where => {
      for (let index = reservations.length - 1; index >= 0; index--)
        if (Object.entries(where).every(([key, value]) => reservations[index][key] === value))
          reservations.splice(index, 1);
    },
    update: async (where, values) => {
      for (const row of reservations)
        if (Object.entries(where).every(([key, value]) => row[key] === value)) Object.assign(row, values);
    }
  };
  const manager = {
    findOne: async () => ({ id: 1 }),
    insert: async (entity, row) => {
      assert.equal(entity, AiReservationEntity);
      reservations.push({ settledAt: null, ...row });
    },
    getRepository: () => repository,
    query: async sql => {
      queries.push(sql);
      if (sql.includes("FROM ai_usage"))
        return [{ requests: usageRows.length, tokens: sum(usageRows, "tokens") }];
      return [
        {
          tokens: sum(reservations, "tokens"),
          requests: reservations.filter(row => row.settledAt === null).length
        }
      ];
    }
  };
  const db = {
    manager,
    transaction: async work => await work(manager),
    query: async () => [{ count: jobRequests }],
    getRepository: () => ({ delete: async () => undefined })
  };
  const service = new AiAdmissionService(db, { get: async () => ({ ...current }) });
  return { service, reservations, queries, policy: current, manager };
}

test("billable requests and token estimates", () => {
  assert.equal(isBillableRequest(generate), true);
  assert.equal(isBillableRequest({ ...generate, operation: "responses.poll" }), false);
  assert.equal(isBillableRequest({ ...generate, operation: "models" }), false);
  assert.equal(isBillableRequest({ target: "search", operation: "search" }), true);
  assert.equal(isBillableRequest({ target: "search", operation: "tools/call" }), true);
  for (const operation of ["initialize", "notifications/initialized", "tools/list"])
    assert.equal(isBillableRequest({ target: "search", operation }), false);
  // English is estimated at three characters a token (it averages four), other text at one a character.
  assert.equal(estimateTokens("abcdef"), 2);
  assert.equal(estimateTokens("题目描述"), 4);
  assert.equal(estimateTokens("😀"), 1);
});

test("a stored AI policy is used only when every value is valid", () => {
  assert.deepEqual(parseAiPolicy({ ...DEFAULT_AI_POLICY, userDailyTokens: 1000 }), {
    ...DEFAULT_AI_POLICY,
    userDailyTokens: 1000
  });
  for (const broken of [
    null,
    [],
    { ...DEFAULT_AI_POLICY, paused: "no" },
    { ...DEFAULT_AI_POLICY, userDailyTokens: -1 },
    { ...DEFAULT_AI_POLICY, userDailyRequests: 1.5 },
    { ...DEFAULT_AI_POLICY, concurrentRequests: 0 },
    { ...DEFAULT_AI_POLICY, jobRequests: 100001 },
    { paused: false }
  ])
    assert.equal(parseAiPolicy(broken), null);
});

test("every provider request is admitted first, and its slot is released whatever happens", async () => {
  const events = [];
  const context = {
    ownerId: 1,
    admit: async metadata => {
      events.push(["admit", metadata.operation, metadata.reserveTokens]);
      return { reservationId: "r1", release: () => events.push(["release"]) };
    },
    record: async (record, reservationId) => {
      events.push(["record", reservationId, "reserveTokens" in record, record.success]);
    }
  };
  await withAiRuntime(context, () =>
    meterProviderRequest({ ...generate, reserveTokens: 100 }, async () => {
      events.push(["request"]);
      return { data: { choices: [{ message: { content: "ok" } }] } };
    })
  );
  assert.deepEqual(events, [
    ["admit", "generate", 100],
    ["request"],
    ["record", "r1", false, true],
    ["release"]
  ]);
  events.length = 0;
  await assert.rejects(
    withAiRuntime(context, () =>
      meterProviderRequest(generate, async () => {
        throw new AiError("PROVIDER_TIMEOUT");
      })
    ),
    /PROVIDER_TIMEOUT/
  );
  assert.deepEqual(
    events.map(([name]) => name),
    ["admit", "record", "release"]
  );
  // A refused request is never sent and never recorded.
  events.length = 0;
  context.admit = async () => {
    throw new AiError("AI_PAUSED");
  };
  await assert.rejects(
    withAiRuntime(context, () =>
      meterProviderRequest(generate, async () => {
        events.push(["request"]);
        return { data: {} };
      })
    ),
    /AI_PAUSED/
  );
  assert.deepEqual(events, []);
});

test("a background response's reservation is tied to the response that will report its usage", async () => {
  const records = [];
  await withAiRuntime(
    { ownerId: 1, record: async record => records.push(record), admit: async () => ({ release() {} }) },
    () =>
      meterProviderRequest(generate, async () => ({
        data: { id: "resp_1", object: "response", status: "queued" }
      }))
  );
  assert.equal(records[0].pendingResponseId, "resp_1");
  assert.equal(records[0].responseId, undefined);
});

test("pausing stops every request; a full site refuses interactive requests but makes jobs wait", async () => {
  const paused = harness({ paused: true });
  await assert.rejects(paused.service.admit(1, "job", generate), /AI_PAUSED/);
  await assert.rejects(paused.service.admit(1, undefined, { ...generate, operation: "models" }), /AI_PAUSED/);

  const { service, policy } = harness({ concurrentRequests: 1 });
  const first = await service.admit(1, "job-a", generate);
  await assert.rejects(service.admit(2, undefined, { ...generate, operation: "models" }), /AI_BUSY/);
  let admitted = false;
  const waiting = service.admit(2, "job-b", generate).then(admission => {
    admitted = true;
    return admission;
  });
  await pause(30);
  assert.equal(admitted, false);
  first.release();
  first.release(); // releasing twice frees one slot
  (await waiting).release();
  assert.equal(admitted, true);

  // Pausing while a job waits stops it, and cancelling a waiting job returns at once.
  const holder = await service.admit(1, "job-a", generate);
  const stopped = service.admit(2, "job-b", generate);
  policy.paused = true;
  await assert.rejects(stopped, /AI_PAUSED/);
  policy.paused = false;
  const controller = new AbortController();
  const cancelled = service.admit(2, "job-b", generate, controller.signal);
  controller.abort(new AiError("JOB_CANCELLED"));
  await assert.rejects(cancelled, /JOB_CANCELLED/);
  holder.release();
});

test("a job may make only so many billable requests", async () => {
  const { service } = harness({ jobRequests: 3 }, { jobRequests: 2 });
  const third = await service.admit(1, "job", generate);
  // The one still running counts too.
  await assert.rejects(service.admit(1, "job", generate), /AI_JOB_REQUEST_LIMIT/);
  // Polls aren't billable and don't count.
  (await service.admit(1, "job", { ...generate, operation: "responses.poll" })).release();
  third.release();
  const unlimited = harness({ jobRequests: 0 }, { jobRequests: 10000 });
  (await unlimited.service.admit(1, "job", generate)).release();
});

test("budgets hold a reservation for each billable request and refuse what would exceed them", async () => {
  // No budget: nothing is reserved.
  const free = harness();
  assert.equal((await free.service.admit(1, "job", { ...generate, reserveTokens: 50 })).reservationId, undefined);
  assert.equal(free.reservations.length, 0);

  const { service, reservations } = harness({ userDailyTokens: 1000 }, { usageRows: [{ tokens: 600 }] });
  const first = await service.admit(1, "job", { ...generate, reserveTokens: 300 });
  assert(first.reservationId);
  assert.deepEqual(
    reservations.map(row => [row.tokens, row.settledAt]),
    [[300, null]]
  );
  // 600 used and 300 held: another 300 would exceed 1000.
  await assert.rejects(service.admit(1, "job", { ...generate, reserveTokens: 300 }), /AI_BUDGET_EXCEEDED/);
  // A refused request takes no slot and holds nothing.
  assert.equal(reservations.length, 1);
  await assert.rejects(service.admit(1, "job", { ...generate, reserveTokens: 1001 }), /AI_REQUEST_EXCEEDS_BUDGET/);
  // Searches reserve no tokens but count as requests.
  const searches = harness({ userDailyRequests: 2 }, { usageRows: [{ tokens: 0 }] });
  const search = await searches.service.admit(1, undefined, { target: "search", operation: "search" });
  await assert.rejects(searches.service.admit(1, undefined, { target: "search", operation: "search" }), /AI_BUDGET/);
  search.release();
  // Model listings are admitted without counting.
  (await searches.service.admit(1, undefined, { ...generate, operation: "models" })).release();
});

test("settling releases confirmed or unbilled requests and keeps the rest at their reserved maximum", async () => {
  const { service, reservations, manager } = harness({ userDailyTokens: 100000 });
  const reserve = async () => (await service.admit(1, "job", { ...generate, reserveTokens: 500 })).reservationId;
  const record = values => ({ ...generate, success: true, errorCode: null, usageReported: false, ...values });

  const confirmed = await reserve();
  await service.settle(manager, 1, "job", record({ usageReported: true }), confirmed, true, null);
  assert(!reservations.some(row => row.id === confirmed));

  const rejected = await reserve();
  await service.settle(manager, 1, "job", record({ success: false, errorCode: "PROVIDER_HTTP_ERROR" }), rejected, false, null);
  assert(!reservations.some(row => row.id === rejected));

  const unknown = await reserve();
  await service.settle(manager, 1, "job", record({ success: false, errorCode: "PROVIDER_TIMEOUT" }), unknown, false, null);
  const kept = reservations.find(row => row.id === unknown);
  assert(kept.settledAt instanceof Date);
  assert.equal(kept.tokens, 500);

  // A background response: kept until the poll that completes it reports usage.
  const background = await reserve();
  await service.settle(manager, 1, "job", record({ pendingResponseId: "resp_9" }), background, false, null);
  const hash = aiResponseHash("job", generate.host, "resp_9");
  assert.equal(reservations.find(row => row.id === background).responseHash, hash);
  await service.settle(manager, 1, "job", record({ operation: "responses.poll" }), undefined, false, hash);
  assert(reservations.some(row => row.id === background), "unconfirmed usage keeps the reservation");
  await service.settle(manager, 1, "job", record({ operation: "responses.poll" }), undefined, true, hash);
  assert(!reservations.some(row => row.id === background));
  assert.deepEqual(
    reservations.map(row => row.id),
    [unknown]
  );
});

test("the AI service admits configuration-page requests and returns paused jobs to the queue", async () => {
  const service = Object.create(AiService.prototype);
  const admitted = [];
  service.admission = { admit: async (...args) => (admitted.push(args), { release() {} }) };
  service.isSiteAdministrator = async () => false;
  const admit = await service.withRuntime(5, undefined, async () => currentAiRuntime().admit);
  await admit(generate);
  assert.deepEqual(admitted, [[5, undefined, generate, undefined]]);

  const updates = [];
  const audits = [];
  const job = { id: "j1", ownerId: 5, runToken: "token", action: "tags", input: {}, state: { completed: [] } };
  service.jobs = {
    findOneBy: async () => ({ ...job, status: "running" }),
    update: async (where, values) => (updates.push([where, values]), { affected: 1 })
  };
  service.recordAiAudit = async (_owner, action) => audits.push(action);
  service.withRuntime = async () => {
    throw new AiError("AI_PAUSED");
  };
  await service.runJob(job);
  assert.deepEqual(updates, [
    [
      { id: "j1", status: "running", runToken: "token" },
      { status: "queued", runToken: null }
    ]
  ]);
  assert.deepEqual(audits, ["job.start", "job.pause"]);
});
