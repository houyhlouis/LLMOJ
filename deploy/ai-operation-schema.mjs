// Exact, additive schema of logical AI operations (review Part III, W03): each AI run on a judge machine records the
// operation it's an attempt of and when its job took its result, so that a job attaches to its runs again after a
// restart and collects a completed one until it acknowledges it. Imported only by the offline upgrader.
export const AI_EXECUTION_OPERATION_KEY_SQL = "ALTER TABLE `ai_execution` ADD `operationKey` char(64) NULL";
export const AI_EXECUTION_OPERATION_SQL = "ALTER TABLE `ai_execution` ADD `operation` varchar(20) NULL";
export const AI_EXECUTION_COLLECTED_AT_SQL = "ALTER TABLE `ai_execution` ADD `collectedAt` datetime(3) NULL";
// [column, accepted column types, SQL adding it]
const COLUMNS = Object.freeze([
  ["operationKey", ["char(64)"], AI_EXECUTION_OPERATION_KEY_SQL],
  ["operation", ["varchar(20)"], AI_EXECUTION_OPERATION_SQL],
  ["collectedAt", ["datetime(3)"], AI_EXECUTION_COLLECTED_AT_SQL]
]);
export const AI_OPERATION_COLUMNS = Object.freeze(COLUMNS.map(([column]) => column));
export const AI_OPERATION_SQL = Object.freeze(COLUMNS.map(([, , sql]) => sql));
const sqlOf = value => (typeof value === "string" ? value : value.query);
const count = (queries, sql) => queries.filter(query => sqlOf(query) === sql).length;

// Each column is added exactly once, and only when absent. A table this upgrade creates (from a release before AI runs
// on judge machines) comes with them. An existing column must be exactly the one this release adds.
export async function validateAiOperationSchema(ds, queries, ErrorType = Error) {
  const tables = await ds.query(`SELECT COUNT(*) AS count FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_execution'`);
  const table = Number(tables[0]?.count) > 0;
  const rows = await ds.query(`SELECT COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
    COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_execution'
    AND COLUMN_NAME IN ('operationKey','operation','collectedAt')`);
  for (const [column, types, sql] of COLUMNS) {
    const existing = rows.filter(row => row.columnName === column);
    const [row] = existing;
    if (row && (existing.length !== 1 || !types.includes(row.columnType) || row.isNullable !== "YES" ||
        ![null, "NULL"].includes(row.defaultValue) || row.extra !== "" || row.comment !== ""))
      throw new ErrorType(`Unsupported existing ai_execution ${column} column`);
    if (count(queries, sql) !== Number(table && !row))
      throw new ErrorType(`The ai_execution ${column} column addition does not match the existing schema`);
  }
}
