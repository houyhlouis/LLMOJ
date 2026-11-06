/* AI budgets on a disposable MariaDB database (tables created from the real entities; never a production database):
   the site AI policy, reservations that can't overshoot a budget under concurrency, and their settlement with
   reported, unknown and background usage. Opt in with LLMOJ_AI_BUDGET_TEST_DB_CONFIG. No provider or network. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
String.prototype.format ||= function (...args) {
  return require("node:util").format(this, ...args);
};
require("@nestjs/common").Logger.overrideLogger(false);
const { DataSource } = require("typeorm");
const { withAiRuntime, meterProviderRequest } = require("./ai-runtime.ts");
const { AiAdmissionService } = require("./ai-admission.service.ts");
const { AiUsageService } = require("./ai-usage.service.ts");
const { AiUsageEntity, AiResponseCheckpointEntity } = require("./ai-usage.entity.ts");
const { AiReservationEntity } = require("./ai-reservation.entity.ts");
const { AiPolicyService, DEFAULT_AI_POLICY } = require("../settings/ai-policy.service.ts");
const { SettingsEntity } = require("../settings/settings.entity.ts");
const { AuditLogEntity } = require("../audit/audit-log.entity.ts");
const { UserEntity } = require("../user/user.entity.ts");
const { UserAuthEntity } = require("../auth/user-auth.entity.ts");

const configPath = process.env.LLMOJ_AI_BUDGET_TEST_DB_CONFIG;
const generate = { target: "llm", provider: "chat", host: "api.example.com", model: "m", operation: "generate" };

test("AI budgets (real MariaDB)", { skip: !configPath && "needs LLMOJ_AI_BUDGET_TEST_DB_CONFIG", timeout: 120000 }, async t => {
  const config = require("js-yaml").load(fs.readFileSync(configPath, "utf8")).services.database;
  const ds = new DataSource({
    ...config,
    entities: [
      UserEntity,
      UserAuthEntity,
      AuditLogEntity,
      SettingsEntity,
      AiUsageEntity,
      AiResponseCheckpointEntity,
      AiReservationEntity
    ],
    synchronize: false,
    logging: false
  });
  await ds.initialize();
  try {
    const [{ count }] = await ds.query("SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
    assert.equal(Number(count), 0, "the test database must start empty");
    await ds.synchronize();
    const users = ds.getRepository(UserEntity);
    const user = (id, isAdmin) =>
      users.save({
        id,
        username: "budget" + id,
        email: `budget${id}@example.test`,
        publicEmail: false,
        avatarInfo: "",
        nickname: "",
        bio: "",
        isAdmin,
        acceptedProblemCount: 0,
        submissionCount: 0,
        rating: 0,
        registrationTime: new Date()
      });
    const admin = await user(1, true);
    const member = await user(2, false);
    const policies = new AiPolicyService(ds);
    const admission = new AiAdmissionService(ds, policies);
    const usage = new AiUsageService(ds, ds.getRepository(AiUsageEntity), ds.getRepository(AiResponseCheckpointEntity));
    usage.admission = admission;
    const runtime = (ownerId, jobId) => ({
      ...usage.context(ownerId, jobId),
      admit: metadata => admission.admit(ownerId, jobId, metadata)
    });
    const reservations = () => ds.getRepository(AiReservationEntity).find({ order: { createdAt: "ASC" } });

    await t.test("only site administrators change the AI policy, and every change is audited", async () => {
      assert.deepEqual(await policies.get(), DEFAULT_AI_POLICY);
      await assert.rejects(policies.update(member, { ...DEFAULT_AI_POLICY, paused: true }, "127.0.0.1"), /Forbidden/);
      await assert.rejects(policies.update(admin, { ...DEFAULT_AI_POLICY, jobRequests: -1 }, "127.0.0.1"), /Invalid/);
      const saved = await policies.update(admin, { ...DEFAULT_AI_POLICY, userDailyTokens: 1000 }, "127.0.0.1");
      assert.equal(saved.userDailyTokens, 1000);
      assert.equal((await policies.get()).userDailyTokens, 1000);
      const [audit] = await ds.getRepository(AuditLogEntity).find({ where: { action: "site.ai_policy.update" } });
      assert.equal(audit.userId, admin.id);
      assert.equal(audit.details.new.userDailyTokens, 1000);
      // A damaged stored policy pauses AI rather than lifting its limits.
      await ds.query("UPDATE settings SET value = ? WHERE `key` = 'ai-policy'", [JSON.stringify({ paused: false })]);
      assert.equal((await policies.get()).paused, true);
      await policies.update(admin, { ...DEFAULT_AI_POLICY, userDailyTokens: 1000 }, "127.0.0.1");
    });

    await t.test("simultaneous requests never reserve more than the budget", async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () => admission.admit(member.id, "race", { ...generate, reserveTokens: 300 }))
      );
      const admitted = results.filter(result => result.status === "fulfilled");
      assert.equal(admitted.length, 3);
      assert(results.every(result => result.status === "fulfilled" || /AI_BUDGET_EXCEEDED/.test(result.reason.message)));
      assert.deepEqual(await admission.usage(member.id), { tokens: 900, requests: 3, heldTokens: 900 });
      for (const result of admitted) result.value.release();
      await ds.getRepository(AiReservationEntity).clear();
    });

    await t.test("reported usage replaces the reservation; unknown usage keeps it", async () => {
      const respond = data => withAiRuntime(runtime(member.id, "job"), () =>
        meterProviderRequest({ ...generate, reserveTokens: 400 }, async () => ({ data })));
      await respond({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 50, completion_tokens: 70 } });
      assert.deepEqual(await reservations(), []);
      assert.deepEqual(await admission.usage(member.id), { tokens: 120, requests: 1, heldTokens: 0 });
      await respond({ choices: [{ message: { content: "ok" } }] });
      const [kept] = await reservations();
      assert.equal(Number(kept.tokens), 400);
      assert(kept.settledAt);
      // Counted once as a request (its usage row), and at its reserved maximum.
      assert.deepEqual(await admission.usage(member.id), { tokens: 520, requests: 2, heldTokens: 400 });
      // 520 used: another 400-token request would leave 80, but 600 would not fit.
      await assert.rejects(
        withAiRuntime(runtime(member.id, "job"), () =>
          meterProviderRequest({ ...generate, reserveTokens: 600 }, async () => assert.fail("must not be sent"))),
        /AI_BUDGET_EXCEEDED/
      );
      await ds.getRepository(AiReservationEntity).clear();
      await ds.getRepository(AiUsageEntity).clear();
    });

    await t.test("a background response's usage, reported by its last poll, releases the reservation", async () => {
      const context = runtime(member.id, "background");
      await withAiRuntime(context, () =>
        meterProviderRequest({ ...generate, reserveTokens: 400 }, async () => ({
          data: { id: "resp_1", object: "response", status: "queued" }
        })));
      assert.equal((await reservations()).length, 1);
      for (const status of ["in_progress", "completed"])
        await withAiRuntime(context, () =>
          meterProviderRequest({ ...generate, operation: "responses.poll" }, async () => ({
            data: {
              id: "resp_1",
              object: "response",
              status,
              ...(status === "completed" ? { usage: { input_tokens: 30, output_tokens: 40 } } : {})
            }
          })));
      assert.deepEqual(await reservations(), []);
      // Polls aren't billable requests.
      assert.deepEqual(await admission.usage(member.id), { tokens: 70, requests: 1, heldTokens: 0 });
    });

    await t.test("a job's request limit counts its recorded and running requests", async () => {
      await policies.update(admin, { ...DEFAULT_AI_POLICY, jobRequests: 2 }, "127.0.0.1");
      const call = () => withAiRuntime(runtime(member.id, "limited"), () =>
        meterProviderRequest(generate, async () => ({ data: { usage: { prompt_tokens: 1, completion_tokens: 1 } } })));
      await call();
      await call();
      await assert.rejects(call(), /AI_JOB_REQUEST_LIMIT/);
    });

    // Review Part IV, W01: logical generations apart from transport requests, the purpose each request was sent for,
    // and usage resolved per generation; a repeated retrieval still isn't counted twice
    await t.test("a generation and its 100 polls: one generation, 101 requests, its usage once", async () => {
      await policies.update(admin, { ...DEFAULT_AI_POLICY }, "127.0.0.1");
      const job = "11111111-1111-4111-8111-111111111111";
      const context = runtime(member.id, job);
      const send = (metadata, data) =>
        withAiRuntime(context, () => meterProviderRequest({ ...generate, ...metadata }, async () => ({ data })));
      const identity = { generationId: "22222222-2222-4222-8222-222222222222", purpose: "plan" };
      await send({ ...identity, reserveTokens: 400 }, { id: "resp_9", object: "response", status: "queued" });
      for (let index = 0; index < 99; index++)
        await send({ ...identity, operation: "responses.poll" }, { id: "resp_9", object: "response", status: "in_progress" });
      const completed = { id: "resp_9", object: "response", status: "completed", usage: { input_tokens: 100, output_tokens: 200 } };
      await send({ ...identity, operation: "responses.poll" }, completed);
      // A later run of the job recovers the same response again: its usage is already counted
      await send({ generationId: "33333333-3333-4333-8333-333333333333", purpose: "plan", operation: "responses.poll" }, completed);
      // A generation whose provider never reports usage stays unresolved, in another purpose
      await send({ generationId: "44444444-4444-4444-8444-444444444444", purpose: "programs" }, { choices: [{ message: { content: "x" } }] });
      // A request recorded before generations had IDs counts by itself
      await ds.query(
        `INSERT INTO ai_usage (id, ownerId, jobId, target, provider, host, model, operation, success, errorCode, elapsedMs,
          usageReported, createdAt) VALUES ('55555555-5555-4555-8555-555555555555', ?, ?, 'llm', 'chat', 'api.example.com',
          'm', 'generate', 1, NULL, 1, 0, NOW(6))`,
        [member.id, job]
      );
      const totals = (await usage.jobTotals(member.id, [job], new Date(Date.now() - 3600000))).get(job);
      assert.deepEqual(totals, {
        generations: 3,
        requests: 104,
        searches: 0,
        failed: 0,
        inputTokens: 100,
        outputTokens: 200,
        cachedTokens: null,
        reasoningTokens: null,
        unreported: 2,
        // The request recorded before purposes isn't counted by one
        purposes: { plan: { generations: 1, requests: 102 }, programs: { generations: 1, requests: 1 } }
      });
      const report = await usage.report(member.id, 1);
      assert.equal(report.totals.generations >= 3, true);
      assert.equal(report.totals.requests >= 104, true);
    });
  } finally {
    await ds.dropDatabase();
    await ds.destroy();
  }
});
