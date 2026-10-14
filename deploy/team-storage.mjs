// Exact, additive storage widening and the requested per-team quota migration.
// Imported only by the offline upgrader, never by the live application.
export const TEAM_STORAGE_QUOTA = 10737418240;
export const FILE_SIZE_BIGINT_SQL = "ALTER TABLE `file` CHANGE `size` `size` bigint NOT NULL";
export const TEAM_FILE_SIZE_BIGINT_SQL = "ALTER TABLE `team_file` CHANGE `size` `size` bigint NOT NULL";
export const TEAM_QUOTA_DEFAULT_SQL =
  "ALTER TABLE `team` CHANGE `quotaLimit` `quotaLimit` bigint NOT NULL DEFAULT '10737418240'";
export const TEAM_STORAGE_SQL = Object.freeze([
  FILE_SIZE_BIGINT_SQL,
  TEAM_FILE_SIZE_BIGINT_SQL,
  TEAM_QUOTA_DEFAULT_SQL
]);
const sqlOf = value => (typeof value === "string" ? value : value.query);
const count = (queries, sql) => queries.filter(query => sqlOf(query) === sql).length;
const defaultText = value => (typeof value === "string" && /^'[^']*'$/.test(value) ? value.slice(1, -1) : value);

export async function validateTeamStorageSchema(ds, queries, ErrorType = Error) {
  const rows = await ds.query(`SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name,
    COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS defaultValue,
    COLLATION_NAME AS collation, EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND
    ((TABLE_NAME IN ('file','team_file') AND COLUMN_NAME='size') OR
     (TABLE_NAME='team' AND COLUMN_NAME='quotaLimit'))`);
  for (const [table, name, sql] of [
    ["file", "size", FILE_SIZE_BIGINT_SQL],
    ["team_file", "size", TEAM_FILE_SIZE_BIGINT_SQL],
    ["team", "quotaLimit", TEAM_QUOTA_DEFAULT_SQL]
  ]) {
    const matches = rows.filter(row => row.tableName === table && row.name === name);
    if (!matches.length && table !== "file") {
      const [exists] = await ds.query(
        "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
        [table]
      );
      if (!Number(exists.count) && !count(queries, sql)) continue;
    }
    const row = matches[0],
      quota = name === "quotaLimit";
    const type = row?.columnType?.replace(/\(\d+\)$/, "");
    if (
      matches.length !== 1 ||
      !row ||
      row.isNullable !== "NO" ||
      row.collation !== null ||
      row.extra !== "" ||
      row.comment !== "" ||
      (quota
        ? type !== "bigint" || !["536870912", "10737418240"].includes(String(defaultText(row.defaultValue)))
        : !["int", "bigint"].includes(type) || row.defaultValue !== null)
    )
      throw new ErrorType("Unsupported existing team storage column");
    const pending = quota ? String(defaultText(row.defaultValue)) !== String(TEAM_STORAGE_QUOTA) : type !== "bigint";
    if (count(queries, sql) !== Number(pending))
      throw new ErrorType("Team storage widening does not match the existing schema");
  }
}

export async function normalizeTeamStorageQueries(ds, queries, ErrorType = Error) {
  let changed = false;
  for (const [table, column, add, change] of [
    ["file", "size", "ALTER TABLE `file` ADD `size` bigint NOT NULL", FILE_SIZE_BIGINT_SQL],
    ["team_file", "size", "ALTER TABLE `team_file` ADD `size` bigint NOT NULL", TEAM_FILE_SIZE_BIGINT_SQL],
    [
      "team",
      "quotaLimit",
      "ALTER TABLE `team` ADD `quotaLimit` bigint NOT NULL DEFAULT '10737418240'",
      TEAM_QUOTA_DEFAULT_SQL
    ]
  ]) {
    const drop = "ALTER TABLE `" + table + "` DROP COLUMN `" + column + "`";
    if (count(queries, drop) === 1 && count(queries, add) === 1) {
      const replacement = queries.filter(query => ![drop, add].includes(sqlOf(query)));
      replacement.push(change);
      queries = replacement;
      changed = true;
    }
  }
  if (changed) await validateTeamStorageSchema(ds, queries, ErrorType);
  return queries;
}

export async function inspectTeamStorage(ds) {
  const [exists] = await ds.query(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='team'"
  );
  if (!Number(exists.count)) return { pending: 0, schemaPending: true };
  const [row] = await ds.query("SELECT COUNT(*) AS count FROM team WHERE quotaLimit <> ?", [TEAM_STORAGE_QUOTA]);
  return { pending: Number(row.count), schemaPending: false };
}

export async function migrateTeamStorage(ds) {
  const before = await inspectTeamStorage(ds);
  if (before.schemaPending) throw new Error("Create team before migrating its storage quota");
  await ds.query("UPDATE team SET quotaLimit = ? WHERE quotaLimit <> ?", [TEAM_STORAGE_QUOTA, TEAM_STORAGE_QUOTA]);
  const after = await inspectTeamStorage(ds);
  if (after.pending || after.schemaPending) throw new Error("Team storage quota migration did not finish");
  return { ...after, migrated: before.pending };
}
