// Exact, additive schema of AI runs on judge machines: the runs an AI job sends to the judge queue instead of the
// local AI runner. Imported only by the offline upgrader.
export const AI_EXECUTION_CREATE_SQL = "CREATE TABLE `ai_execution` (`taskId` char(36) NOT NULL, " +
  "`jobId` varchar(36) NOT NULL, `state` varchar(10) NOT NULL, `sampleFiles` longtext NOT NULL, " +
  "`progress` longtext NULL, `result` longtext NULL, `uploads` longtext NULL, `createdAt` datetime(3) NOT NULL, " +
  "`finishedAt` datetime(3) NULL, INDEX `IDX_f406176b1abd93cce8909f3e8c` (`state`, `createdAt`), " +
  "INDEX `IDX_b1cb845eda11bbedb12e38812c` (`jobId`), PRIMARY KEY (`taskId`)) ENGINE=InnoDB";
export const AI_EXECUTION_TABLES = Object.freeze(["ai_execution"]);
export const AI_EXECUTION_SQL = Object.freeze([AI_EXECUTION_CREATE_SQL]);
const sqlOf = value => (typeof value === "string" ? value : value.query);

// The table is created exactly once, and only when it is absent. TypeORM proposes any other change to an existing
// table, which the general contract refuses.
export async function validateAiExecutionSchema(ds, queries, ErrorType = Error) {
  const rows = await ds.query(`SELECT COUNT(*) AS count FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_execution'`);
  const pending = Number(!Number(rows[0]?.count));
  if (queries.filter(query => sqlOf(query) === AI_EXECUTION_CREATE_SQL).length !== pending)
    throw new ErrorType("AI execution table addition does not match the existing schema");
}
