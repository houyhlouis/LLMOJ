// Exact, additive schema of AI request identity (review Part IV, W01): each recorded provider request says what it
// was for when it was sent (its purpose) and which logical generation it belongs to (a generation and the polls that
// recover its response share one ID), so usage reports count generations apart from transport requests and attribute
// every request to its purpose, even one recorded just before a job failed. Imported only by the offline upgrader.
export const AI_USAGE_PURPOSE_SQL = "ALTER TABLE `ai_usage` ADD `purpose` varchar(20) NULL";
export const AI_USAGE_GENERATION_SQL = "ALTER TABLE `ai_usage` ADD `generationId` varchar(36) NULL";
// [column, accepted column types, SQL adding it]
const COLUMNS = Object.freeze([
  ["purpose", ["varchar(20)"], AI_USAGE_PURPOSE_SQL],
  ["generationId", ["varchar(36)"], AI_USAGE_GENERATION_SQL]
]);
export const AI_USAGE_IDENTITY_COLUMNS = Object.freeze(COLUMNS.map(([column]) => column));
export const AI_USAGE_IDENTITY_SQL = Object.freeze(COLUMNS.map(([, , sql]) => sql));
const sqlOf = value => (typeof value === "string" ? value : value.query);
const count = (queries, sql) => queries.filter(query => sqlOf(query) === sql).length;

// Each column is added exactly once, and only when absent from an existing table. An existing column must be exactly
// the one this release adds.
export async function validateAiUsageIdentitySchema(ds, queries, ErrorType = Error) {
  const tables = await ds.query(`SELECT COUNT(*) AS count FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_usage'`);
  const table = Number(tables[0]?.count) > 0;
  const rows = await ds.query(`SELECT COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
    COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_usage' AND COLUMN_NAME IN ('purpose','generationId')`);
  for (const [column, types, sql] of COLUMNS) {
    const existing = rows.filter(row => row.columnName === column);
    const [row] = existing;
    if (row && (existing.length !== 1 || !types.includes(row.columnType) || row.isNullable !== "YES" ||
        ![null, "NULL"].includes(row.defaultValue) || row.extra !== "" || row.comment !== ""))
      throw new ErrorType(`Unsupported existing ai_usage ${column} column`);
    if (count(queries, sql) !== Number(table && !row))
      throw new ErrorType(`The ai_usage ${column} column addition does not match the existing schema`);
  }
}
