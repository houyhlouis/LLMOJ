/* The operational gauges' queries on a disposable MariaDB database (never a production one): waiting and leased
   judge jobs, expired leases, recent failures, statistics lag and AI jobs, as the metrics endpoint reports them. */
const test = require("node:test");
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
require("@nestjs/common").Logger.overrideLogger(false);
const { DataSource } = require("typeorm");
const { MetricsService } = require("./metrics.service.ts");
const { JudgeJobEntity, JudgeJobAttemptEntity, JudgeJobState } = require("../judge/judge-job.entity.ts");
const { JudgeQueueService } = require("../judge/judge-queue.service.ts");
const { StatisticsOutboxEntity, StatisticsOutboxKind } = require("../submission/statistics-outbox.entity.ts");
const { StatisticsOutboxService } = require("../submission/statistics-outbox.service.ts");
const { AiJobEntity } = require("../ai/ai.entity.ts");
const { AiJobCoordinator } = require("../ai/ai-job-coordinator.service.ts");

const configPath = process.env.LLMOJ_OPERATIONS_TEST_DB_CONFIG;

/** `name{labels} value` lines of the exposition, by series. */
function values(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .filter(line => line && !line.startsWith("#"))
      .map(line => {
        const index = line.lastIndexOf(" ");
        return [line.slice(0, index), Number(line.slice(index + 1))];
      })
  );
}

test("operational gauges read the queue, statistics and AI tables", { skip: !configPath && "needs LLMOJ_OPERATIONS_TEST_DB_CONFIG" }, async t => {
  const { database } = JSON.parse(fs.readFileSync(configPath, "utf8")).services;
  const ds = new DataSource({
    ...database,
    entities: [JudgeJobEntity, JudgeJobAttemptEntity, StatisticsOutboxEntity, AiJobEntity],
    synchronize: true,
    dropSchema: true,
    logging: false
  });
  await ds.initialize();
  t.after(() => ds.destroy());

  const ago = seconds => () => `NOW(3) - INTERVAL ${seconds} SECOND`;
  const job = (taskId, state, fields) =>
    ds
      .createQueryBuilder()
      .insert()
      .into(JudgeJobEntity)
      .values({
        taskId,
        type: "Submission",
        priority: 0,
        state,
        createdAt: ago(5),
        availableAt: ago(5),
        fence: 1,
        unfinishedLeases: 0,
        preparationFailures: 0,
        ...fields
      })
      .execute();
  await job("queued-old", JudgeJobState.Queued, { createdAt: ago(120) });
  await job("queued-new", JudgeJobState.Queued, { createdAt: ago(10) });
  // An older queued job that's been finished must not count
  await job("finished", JudgeJobState.Finished, { createdAt: ago(900), finishedAt: ago(800) });
  await job("leased-expired", JudgeJobState.Leased, { leaseUntil: ago(20), leaseOwner: "x" });
  await job("leased", JudgeJobState.Leased, { leaseUntil: () => "NOW(3) + INTERVAL 60 SECOND", leaseOwner: "x" });
  await job("failed-recently", JudgeJobState.Failed, { finishedAt: ago(3600) });
  await job("failed-long-ago", JudgeJobState.Failed, { finishedAt: ago(3 * 86400) });
  for (const seconds of [30, 5])
    // eslint-disable-next-line no-await-in-loop
    await ds
      .createQueryBuilder()
      .insert()
      .into(StatisticsOutboxEntity)
      .values({ kind: StatisticsOutboxKind.Problem, targetId: 1, submissions: 1, accepted: 0, createdAt: ago(seconds) })
      .execute();
  for (const [id, status, seconds] of [
    ["ai-queued", "queued", 60],
    ["ai-running", "running", 30],
    ["ai-done", "completed", 600]
  ])
    // eslint-disable-next-line no-await-in-loop
    await ds
      .createQueryBuilder()
      .insert()
      .into(AiJobEntity)
      .values({ id, ownerId: 1, action: "all", status, input: { count: 1 }, state: {}, createdAt: ago(seconds) })
      .execute();

  const metrics = new MetricsService({ config: {} });
  // eslint-disable-next-line no-new
  new JudgeQueueService(ds, { getClient: () => ({}) }, metrics);
  Object.assign(Object.create(StatisticsOutboxService.prototype), { connection: ds, metricsService: metrics }).registerMetrics();
  const ai = new AiJobCoordinator(ds, {}, {}, {}, {}, {});
  Object.assign(ai, {
    metricsService: metrics,
    admission: { load: () => ({ running: 1, waiting: 2 }) },
    policies: { get: async () => ({ paused: true }) }
  });
  ai.registerMetrics();

  const read = values(await metrics.registry.metrics());
  const near = (name, expected) =>
    assert(read[name] >= expected - 1 && read[name] < expected + 30, `${name} = ${read[name]}, about ${expected}`);
  assert.equal(read['libreoj_judge_jobs{state="Queued"}'], 2);
  assert.equal(read['libreoj_judge_jobs{state="Leased"}'], 2);
  assert.equal(read.libreoj_judge_expired_leases, 1);
  assert.equal(read.libreoj_judge_failed_jobs_last_day, 1);
  near("libreoj_judge_oldest_queued_job_seconds", 120);
  assert.equal(read.libreoj_statistics_outbox_pending, 2);
  near("libreoj_statistics_outbox_oldest_seconds", 30);
  assert.equal(read['libreoj_ai_jobs{state="queued"}'], 1);
  assert.equal(read['libreoj_ai_jobs{state="running"}'], 1);
  near("libreoj_ai_oldest_queued_job_seconds", 60);
  assert.equal(read['libreoj_ai_provider_requests{state="running"}'], 1);
  assert.equal(read['libreoj_ai_provider_requests{state="waiting"}'], 2);
  assert.equal(read.libreoj_ai_paused, 1);

  // Nothing waiting: the ages are 0, not unknown
  await ds.query("DELETE FROM judge_job WHERE state = 'Queued'");
  await ds.query("DELETE FROM statistics_outbox");
  await ds.query("DELETE FROM ai_job WHERE status = 'queued'");
  await new Promise(resolve => setTimeout(resolve, 1100));
  const empty = values(await metrics.registry.metrics());
  assert.equal(empty.libreoj_judge_oldest_queued_job_seconds, 0);
  assert.equal(empty.libreoj_statistics_outbox_oldest_seconds, 0);
  assert.equal(empty.libreoj_ai_oldest_queued_job_seconds, 0);
  assert.equal(empty['libreoj_judge_jobs{state="Queued"}'], 0);
});
