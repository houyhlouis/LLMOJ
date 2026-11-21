import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { seedBatches, seedPlan } from "../benchmark/seed.mjs";
import { measureStrictScore } from "../benchmark/strict-ioi.mjs";

test("the strict fixture, compiled scorer and both measured projections agree on the ranked users", async t => {
  const backend = createRequire(new URL("../../apps/backend/package.json", import.meta.url));
  backend("reflect-metadata");
  const { DataSource } = backend("typeorm");
  const { DateUtils } = backend("typeorm/util/DateUtils");
  const ds = new DataSource({
    type: "mariadb",
    database: "llmoj_bench_test",
    entities: [fileURLToPath(new URL("../../apps/backend/dist/**/*.entity.js", import.meta.url))]
  });
  await ds.buildMetadatas();
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const tables = new Set(["contest", "contest_problem", "submission", "submission_detail"]);
  for (const name of tables) {
    const columns = ds
      .getMetadata(name)
      .columns.map(c => '"' + c.databaseName + '"' + (c.propertyName === "weight" ? " DEFAULT 1" : ""));
    db.exec('CREATE TABLE "' + name + '" (' + columns.join(", ") + ")");
  }
  const plan = seedPlan({ scale: 0.01, "strict-submissions": 100, "source-bytes": 16384, "practice-submissions": 3 });
  for (const batch of seedBatches(plan, { viewer: "", other: "" })) {
    const table = /INSERT INTO `(\w+)`/.exec(batch.sql)[1];
    if (!tables.has(table)) continue;
    const insert = db.prepare(batch.sql);
    for (const row of batch.rows) insert.run(...row.map(value => (typeof value === "boolean" ? Number(value) : value)));
  }
  // Execute the real projections. The test meter counts serialized records in place of MariaDB socket bytes.
  const runner = ds.createQueryRunner();
  const stream = { bytesRead: 0 };
  runner.connect = async () => ({ stream });
  runner.query = async (sql, params) => {
    const records = db
      .prepare(sql)
      .all(...params.map(v => (v instanceof Date ? DateUtils.mixedDateToDatetimeString(v) : v)));
    stream.bytesRead += Buffer.byteLength(JSON.stringify(records));
    return { records };
  };
  const full = await measureStrictScore(runner, plan, "full");
  const projected = await measureStrictScore(runner, plan, "projected");
  assert.equal(full.detailRows, 100);
  assert.equal(projected.detailRows, full.detailRows);
  assert.equal(projected.scoreSha256, full.scoreSha256);
  assert.ok(projected.rankedUsers > 0);
  assert.ok(projected.detailQueryBytes > 0);
  assert.ok(full.detailQueryBytes - projected.detailQueryBytes >= full.detailRows * plan.sourceBytes);
  assert.ok(projected.rssBeforeBytes > 0 && projected.peakRssBytes > 0);
  t.diagnostic(
    `Serialized fixture detail bytes: full ${full.detailQueryBytes}, projected ${projected.detailQueryBytes}`
  );
});
