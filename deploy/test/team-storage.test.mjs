import test from "node:test";
import assert from "node:assert/strict";
import {
  FILE_SIZE_BIGINT_SQL,
  TEAM_FILE_SIZE_BIGINT_SQL,
  TEAM_QUOTA_DEFAULT_SQL,
  normalizeTeamStorageQueries,
  validateTeamStorageSchema,
  inspectTeamStorage,
  migrateTeamStorage
} from "../team-storage.mjs";
import { validateQueries } from "../upgrade-schema.mjs";

const column = (tableName, name, columnType, defaultValue = null) => ({
  tableName,
  name,
  columnType,
  defaultValue,
  isNullable: "NO",
  collation: null,
  extra: "",
  comment: ""
});
const old = [
  column("file", "size", "int(11)"),
  column("team_file", "size", "int(11)"),
  column("team", "quotaLimit", "bigint(20)", "'536870912'")
];
const current = [
  column("file", "size", "bigint(20)"),
  column("team_file", "size", "bigint(20)"),
  column("team", "quotaLimit", "bigint(20)", "'10737418240'")
];
const ddl = [FILE_SIZE_BIGINT_SQL, TEAM_FILE_SIZE_BIGINT_SQL, TEAM_QUOTA_DEFAULT_SQL];
const schema = rows => ({ query: async sql => (sql.includes("information_schema.COLUMNS") ? rows : [{ count: 1 }]) });

test("exact int widening/default migration is accepted; complete storage schemas are no-op", async () => {
  assert.deepEqual(validateQueries(ddl), ddl);
  await validateTeamStorageSchema(schema(old), ddl);
  await validateTeamStorageSchema(schema(current), []);
  await assert.rejects(() => validateTeamStorageSchema(schema(old), ddl.slice(1)));
  await assert.rejects(() => validateTeamStorageSchema(schema(current), ddl));
});
test("all known DROP/ADD proposals become value-preserving CHANGE before executable validation", async () => {
  const proposed = [
    "ALTER TABLE `file` DROP COLUMN `size`",
    "ALTER TABLE `file` ADD `size` bigint NOT NULL",
    "ALTER TABLE `team_file` DROP COLUMN `size`",
    "ALTER TABLE `team_file` ADD `size` bigint NOT NULL",
    TEAM_QUOTA_DEFAULT_SQL
  ];
  const normalized = await normalizeTeamStorageQueries(schema(old), proposed);
  assert.deepEqual(new Set(validateQueries(normalized)), new Set(ddl));
  assert(normalized.every(sql => !sql.includes("DROP")));
  for (const invalid of [
    proposed.slice(1),
    [...proposed, proposed[0]],
    proposed.map(sql => sql.replace("bigint", "int unsigned"))
  ])
    assert.throws(() => validateQueries(invalid));
});
test("unsigned types, nullable/default sizes and unknown quota defaults cannot mutate storage", async () => {
  for (const patch of [
    { columnType: "int(11) unsigned" },
    { isNullable: "YES" },
    { defaultValue: "0" },
    { comment: "custom" }
  ]) {
    const changed = old.map((row, index) => (index === 0 ? { ...row, ...patch } : row));
    await assert.rejects(() => validateTeamStorageSchema(schema(changed), ddl));
  }
  await assert.rejects(() =>
    validateTeamStorageSchema(
      schema(old.map(row => (row.name === "quotaLimit" ? { ...row, defaultValue: "1" } : row))),
      ddl
    )
  );
  for (const changed of ddl.map(sql => sql.replace("bigint", "int unsigned")))
    assert.throws(() => validateQueries([changed]));
});
test("only existing team quotas change; repeat is stable and absent schema is not updated", async () => {
  let pending = 3,
    updates = 0;
  const ds = {
    query: async (sql, parameters) => {
      if (sql.includes("information_schema")) return [{ count: 1 }];
      if (sql.startsWith("SELECT")) return [{ count: pending }];
      assert.equal(sql, "UPDATE team SET quotaLimit = ? WHERE quotaLimit <> ?");
      assert.deepEqual(parameters, [10737418240, 10737418240]);
      updates++;
      pending = 0;
    }
  };
  assert.equal((await migrateTeamStorage(ds)).migrated, 3);
  assert.equal((await migrateTeamStorage(ds)).migrated, 0);
  assert.equal(updates, 2);
  const absent = { query: async () => [{ count: 0 }] };
  assert.deepEqual(await inspectTeamStorage(absent), { pending: 0, schemaPending: true });
  await assert.rejects(() => migrateTeamStorage(absent));
});
