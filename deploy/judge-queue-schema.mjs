// Exact, additive tables of the durable judge queue (its jobs and the retained history of their leases) and the
// judge clients' draining flag. Imported only by the offline upgrader.
export const JUDGE_JOB_CREATE_SQL = "CREATE TABLE `judge_job` (`taskId` char(36) NOT NULL, `type` varchar(24) NOT NULL, " +
  "`priority` double NOT NULL, `state` varchar(10) NOT NULL, `createdAt` datetime(3) NOT NULL, " +
  "`availableAt` datetime(3) NOT NULL, `fence` int UNSIGNED NOT NULL, `leaseOwner` varchar(40) NULL, " +
  "`judgeClientId` int NULL, `leaseUntil` datetime(3) NULL, `unfinishedLeases` smallint UNSIGNED NOT NULL, " +
  "`preparationFailures` smallint UNSIGNED NOT NULL, `lastError` varchar(255) NULL, `resultHash` char(64) NULL, " +
  "`finishedAt` datetime(3) NULL, INDEX `IDX_d78633726d8ce6f8afb263b595` (`state`, `leaseUntil`), " +
  "INDEX `IDX_0c3cfd47a2e867e8b2854b43f6` (`state`, `priority`, `createdAt`), PRIMARY KEY (`taskId`)) ENGINE=InnoDB";
// Created with its judge runtime column (runtime-identity-schema.mjs adds it to an existing table)
export const JUDGE_JOB_ATTEMPT_CREATE_SQL = "CREATE TABLE `judge_job_attempt` (`id` int NOT NULL AUTO_INCREMENT, " +
  "`taskId` char(36) NOT NULL, `fence` int UNSIGNED NOT NULL, `judgeClientId` int NULL, `judgeRuntimeId` int NULL, " +
  "`leaseOwner` varchar(40) NOT NULL, `startedAt` datetime(3) NOT NULL, `endedAt` datetime(3) NULL, " +
  "`outcome` varchar(16) NULL, INDEX `IDX_9bac82304b143c893faecffcdf` (`startedAt`), " +
  "UNIQUE INDEX `IDX_4a6ad01ae52602fbc78c82bba4` (`taskId`, `fence`), PRIMARY KEY (`id`)) ENGINE=InnoDB";
const TABLES = Object.freeze([
  ["judge_job", JUDGE_JOB_CREATE_SQL],
  ["judge_job_attempt", JUDGE_JOB_ATTEMPT_CREATE_SQL]
]);
export const JUDGE_QUEUE_TABLES = Object.freeze(TABLES.map(([name]) => name));
export const JUDGE_QUEUE_SQL = Object.freeze(TABLES.map(([, create]) => create));
export const JUDGE_CLIENT_DRAINING_SQL = "ALTER TABLE `judge_client` ADD `draining` tinyint NOT NULL DEFAULT 0";
const defaultText = value => (typeof value === "string" && /^'[^']*'$/.test(value) ? value.slice(1, -1) : value);
const sqlOf = value => (typeof value === "string" ? value : value.query);
const count = (queries, sql) => queries.filter(query => sqlOf(query) === sql).length;

// Each table is created exactly once, and only when it is absent. TypeORM proposes any other change to an
// existing table, which the general contract refuses.
export async function validateJudgeQueueSchema(ds, queries, ErrorType = Error) {
  const rows = await ds.query(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('judge_job','judge_job_attempt')`);
  for (const [table, create] of TABLES)
    if (count(queries, create) !== Number(!rows.some(row => row.name === table)))
      throw new ErrorType("Judge queue table addition does not match the existing schema");
  const columns = await ds.query(`SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
    COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='judge_client' AND COLUMN_NAME='draining'`);
  const [draining] = columns;
  if (draining && (columns.length !== 1 || !["tinyint", "tinyint(4)"].includes(draining.columnType) ||
      draining.isNullable !== "NO" || String(defaultText(draining.defaultValue)) !== "0" || draining.extra !== "" ||
      draining.comment !== ""))
    throw new ErrorType("Unsupported existing judge client draining column");
  if (count(queries, JUDGE_CLIENT_DRAINING_SQL) !== Number(!draining))
    throw new ErrorType("Judge client draining column addition does not match the existing schema");
}
