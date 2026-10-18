// Exact, additive schema of reproducible judging: problem data versions that submissions are pinned to, test data
// files whose deletion waits for pinned submissions, the results rejudges replaced, and the outbox of count changes.
// Imported only by the offline upgrader.
export const PROBLEM_DATA_VERSION_CREATE_SQL = "CREATE TABLE `problem_data_version` (`id` int NOT NULL AUTO_INCREMENT, " +
  "`problemId` int NOT NULL, `version` int NOT NULL, `digest` char(64) NOT NULL, `problemType` varchar(24) NOT NULL, " +
  "`judgeInfo` longtext NOT NULL, `testData` longtext NOT NULL, `samples` longtext NULL, `createdAt` datetime NOT NULL, " +
  "UNIQUE INDEX `IDX_b1e411e5d7ad0294826be57cdc` (`problemId`, `digest`), " +
  "UNIQUE INDEX `IDX_e6b06c47e949420ad6d1a0e461` (`problemId`, `version`), PRIMARY KEY (`id`)) ENGINE=InnoDB";
export const PROBLEM_DATA_VERSION_FOREIGN_KEY_SQL = "ALTER TABLE `problem_data_version` ADD CONSTRAINT " +
  "`FK_05762355b24930fc4cb753a1124` FOREIGN KEY (`problemId`) REFERENCES `problem`(`id`) ON DELETE CASCADE " +
  "ON UPDATE NO ACTION";
export const DEFERRED_FILE_DELETION_CREATE_SQL = "CREATE TABLE `deferred_file_deletion` (`uuid` char(36) NOT NULL, " +
  "`requestedAt` datetime NOT NULL, PRIMARY KEY (`uuid`)) ENGINE=InnoDB";
// Created with its judge runtime column (runtime-identity-schema.mjs adds it to an existing table)
export const SUBMISSION_RESULT_HISTORY_CREATE_SQL = "CREATE TABLE `submission_result_history` (" +
  "`id` int NOT NULL AUTO_INCREMENT, `submissionId` int NOT NULL, `problemDataVersionId` int NULL, " +
  "`judgeRuntimeId` int NULL, `status` varchar(32) NOT NULL, `score` int NULL, `timeUsed` int NULL, `memoryUsed` int NULL, " +
  "`totalOccupiedTime` int NULL, `result` longtext NULL, `replacedAt` datetime NOT NULL, `replacedBy` int NULL, " +
  "INDEX `IDX_a3609d25edf881ba0e109380f6` (`submissionId`), PRIMARY KEY (`id`)) ENGINE=InnoDB";
export const SUBMISSION_RESULT_HISTORY_FOREIGN_KEY_SQL = "ALTER TABLE `submission_result_history` ADD CONSTRAINT " +
  "`FK_a3609d25edf881ba0e109380f60` FOREIGN KEY (`submissionId`) REFERENCES `submission`(`id`) ON DELETE CASCADE " +
  "ON UPDATE NO ACTION";
export const STATISTICS_OUTBOX_CREATE_SQL = "CREATE TABLE `statistics_outbox` (`id` int NOT NULL AUTO_INCREMENT, " +
  "`kind` varchar(8) NOT NULL, `targetId` int NOT NULL, `submissions` int NOT NULL, `accepted` int NOT NULL, " +
  "`createdAt` datetime(3) NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB";
export const SUBMISSION_DATA_VERSION_SQL = "ALTER TABLE `submission` ADD `problemDataVersionId` int NULL";
const TABLES = Object.freeze([
  ["problem_data_version", PROBLEM_DATA_VERSION_CREATE_SQL, PROBLEM_DATA_VERSION_FOREIGN_KEY_SQL],
  ["deferred_file_deletion", DEFERRED_FILE_DELETION_CREATE_SQL, null],
  ["submission_result_history", SUBMISSION_RESULT_HISTORY_CREATE_SQL, SUBMISSION_RESULT_HISTORY_FOREIGN_KEY_SQL],
  ["statistics_outbox", STATISTICS_OUTBOX_CREATE_SQL, null]
]);
export const DATA_VERSION_TABLES = Object.freeze(TABLES.map(([name]) => name));
export const DATA_VERSION_SQL = Object.freeze([
  ...TABLES.flatMap(([, create, foreignKey]) => (foreignKey ? [create, foreignKey] : [create])),
  SUBMISSION_DATA_VERSION_SQL
]);
const sqlOf = value => (typeof value === "string" ? value : value.query);
const count = (queries, sql) => queries.filter(query => sqlOf(query) === sql).length;

// Each table is created together with its foreign key, exactly once, and only when it is absent; the submission
// column likewise. TypeORM proposes any other change to an existing table, which the general contract refuses.
export async function validateDataVersionSchema(ds, queries, ErrorType = Error) {
  const rows = await ds.query(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('problem_data_version','deferred_file_deletion',
    'submission_result_history','statistics_outbox')`);
  for (const [table, create, foreignKey] of TABLES) {
    const pending = Number(!rows.some(row => row.name === table));
    if (count(queries, create) !== pending || (foreignKey && count(queries, foreignKey) !== pending))
      throw new ErrorType("Data version table addition does not match the existing schema");
  }
  const columns = await ds.query(`SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
    COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='submission' AND COLUMN_NAME='problemDataVersionId'`);
  const [column] = columns;
  if (column && (columns.length !== 1 || !["int", "int(11)"].includes(column.columnType) ||
      column.isNullable !== "YES" || ![null, "NULL"].includes(column.defaultValue) || column.extra !== "" ||
      column.comment !== ""))
    throw new ErrorType("Unsupported existing submission data version column");
  if (count(queries, SUBMISSION_DATA_VERSION_SQL) !== Number(!column))
    throw new ErrorType("Submission data version column addition does not match the existing schema");
}
