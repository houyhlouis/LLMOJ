/* On a disposable MariaDB database (never a production one): a contest's score revision moves on after the real
   COMMIT of a transaction that changed one of its submissions, not after a savepoint or a rollback. */
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
const { StatisticsOutboxEntity } = require("../submission/statistics-outbox.entity.ts");
const { StatisticsOutboxService } = require("../submission/statistics-outbox.service.ts");
const { ContestScoreRevisionService } = require("../submission/contest-score-revision.service.ts");

const configPath = process.env.LLMOJ_OPERATIONS_TEST_DB_CONFIG;

test("contest score revisions follow commits", { skip: !configPath && "needs LLMOJ_OPERATIONS_TEST_DB_CONFIG" }, async t => {
  const { database } = JSON.parse(fs.readFileSync(configPath, "utf8")).services;
  const ds = new DataSource({ ...database, entities: [StatisticsOutboxEntity], synchronize: true, dropSchema: true, logging: false });
  await ds.initialize();
  t.after(() => ds.destroy());

  const counters = new Map();
  const redis = {
    increment: async key => counters.set(key, (counters.get(key) ?? 0) + 1),
    cacheGet: async key => (counters.has(key) ? String(counters.get(key)) : null)
  };
  const revisions = new ContestScoreRevisionService(ds, redis);
  revisions.onModuleInit();
  const outbox = Object.assign(Object.create(StatisticsOutboxService.prototype), { connection: ds, contestScores: revisions });
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const submission = (contestId, status) => ({ problemId: 1, submitterId: 2, contestId, status });

  assert.equal(await revisions.revision(29), "0");
  await ds.transaction(async manager => {
    assert.deepEqual(await outbox.record(manager, null, submission(29, "Pending")), []);
    await settle();
    assert.equal(await revisions.revision(29), "0", "not before the commit");
  });
  await settle();
  assert.equal(await revisions.revision(29), "1");

  // Rolled back: nothing changed
  await assert.rejects(
    ds.transaction(async manager => {
      await outbox.record(manager, submission(29, "Pending"), submission(29, "Accepted"));
      throw new Error("rolled back");
    }),
    /rolled back/
  );
  await settle();
  assert.equal(await revisions.revision(29), "1");

  // A savepoint released inside the transaction isn't its commit
  await ds.transaction(async manager => {
    await manager.transaction(async inner => outbox.record(inner, submission(12, "Pending"), submission(12, "Accepted")));
    await settle();
    assert.equal(await revisions.revision(12), "0");
  });
  await settle();
  assert.equal(await revisions.revision(12), "1");

  // Non-contest submissions keep their count records, and touch no contest
  const ids = await ds.transaction(manager => outbox.record(manager, null, submission(null, "Accepted")));
  assert.equal(ids.length, 2);
  await settle();
  assert.deepEqual([...counters.keys()].sort(), ["contest-score-revision:12", "contest-score-revision:29"]);
});
