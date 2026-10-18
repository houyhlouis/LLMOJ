// Exact, additive schema of what each result was judged with: the content hashes of stored files, the recorded judge
// runtimes, and the runtime of each judge job lease, submission result and replaced result. Imported only by the
// offline upgrader.
export const JUDGE_RUNTIME_CREATE_SQL = "CREATE TABLE `judge_runtime` (`id` int NOT NULL AUTO_INCREMENT, " +
  "`digest` char(64) NOT NULL, `judgeClientId` int NOT NULL, `judgeProgram` char(64) NOT NULL, " +
  "`sandboxImage` char(64) NOT NULL, `details` longtext NOT NULL, `firstSeenAt` datetime NOT NULL, " +
  "UNIQUE INDEX `IDX_5ceb6ff08697faa921df3e46ec` (`digest`), PRIMARY KEY (`id`)) ENGINE=InnoDB";
export const FILE_SHA256_SQL = "ALTER TABLE `file` ADD `sha256` char(64) NULL";
export const JUDGE_JOB_ATTEMPT_RUNTIME_SQL = "ALTER TABLE `judge_job_attempt` ADD `judgeRuntimeId` int NULL";
export const SUBMISSION_RUNTIME_SQL = "ALTER TABLE `submission` ADD `judgeRuntimeId` int NULL";
export const SUBMISSION_RESULT_HISTORY_RUNTIME_SQL = "ALTER TABLE `submission_result_history` ADD `judgeRuntimeId` int NULL";
// [table, column, accepted column types, SQL adding it]
const COLUMNS = Object.freeze([
  ["file", "sha256", ["char(64)"], FILE_SHA256_SQL],
  ["judge_job_attempt", "judgeRuntimeId", ["int", "int(11)"], JUDGE_JOB_ATTEMPT_RUNTIME_SQL],
  ["submission", "judgeRuntimeId", ["int", "int(11)"], SUBMISSION_RUNTIME_SQL],
  ["submission_result_history", "judgeRuntimeId", ["int", "int(11)"], SUBMISSION_RESULT_HISTORY_RUNTIME_SQL]
]);
export const RUNTIME_IDENTITY_TABLES = Object.freeze(["judge_runtime"]);
export const RUNTIME_IDENTITY_COLUMNS = Object.freeze(COLUMNS.map(([table, column]) => [table, column]));
export const RUNTIME_IDENTITY_SQL = Object.freeze([JUDGE_RUNTIME_CREATE_SQL, ...COLUMNS.map(([, , , sql]) => sql)]);
const sqlOf = value => (typeof value === "string" ? value : value.query);
const count = (queries, sql) => queries.filter(query => sqlOf(query) === sql).length;

// The table and each column are added exactly once, and only when absent. A table that is created by this upgrade
// (from a release before the judge queue or data versions) comes with its column. An existing column must be exactly
// the one this release adds. TypeORM proposes any other change, which the general contract refuses.
export async function validateRuntimeIdentitySchema(ds, queries, ErrorType = Error) {
  const tables = (await ds.query(`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME IN ('judge_runtime','file','judge_job_attempt','submission','submission_result_history')`))
    .map(row => row.name);
  if (count(queries, JUDGE_RUNTIME_CREATE_SQL) !== Number(!tables.includes("judge_runtime")))
    throw new ErrorType("Judge runtime table addition does not match the existing schema");
  const rows = await ds.query(`SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
    IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='file' AND COLUMN_NAME='sha256')
    OR (COLUMN_NAME='judgeRuntimeId' AND TABLE_NAME IN ('judge_job_attempt','submission','submission_result_history')))`);
  for (const [table, column, types, sql] of COLUMNS) {
    const existing = rows.filter(row => row.tableName === table && row.columnName === column);
    const [row] = existing;
    if (row && (existing.length !== 1 || !types.includes(row.columnType) || row.isNullable !== "YES" ||
        ![null, "NULL"].includes(row.defaultValue) || row.extra !== "" || row.comment !== ""))
      throw new ErrorType(`Unsupported existing ${table} ${column} column`);
    if (count(queries, sql) !== Number(tables.includes(table) && !row))
      throw new ErrorType(`The ${table} ${column} column addition does not match the existing schema`);
  }
}
