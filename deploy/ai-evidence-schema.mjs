// Exact, additive schema of AI failure evidence (review Part III, W01): the observations of failed AI runs, whose
// evidence is kept in storage for the job's owner. Imported only by the offline upgrader.
export const AI_OBSERVATION_CREATE_SQL = "CREATE TABLE `ai_observation` (`id` char(36) NOT NULL, " +
  "`jobId` varchar(36) NOT NULL, `runToken` varchar(36) NULL, `fatal` tinyint NOT NULL, `kind` varchar(32) NOT NULL, " +
  "`evidence` varchar(16) NOT NULL, `bytes` int NOT NULL, `observation` longtext NOT NULL, " +
  "`createdAt` datetime(3) NOT NULL, `expiresAt` datetime(3) NOT NULL, " +
  "INDEX `IDX_30548bb9050e89aeed2af058f5` (`expiresAt`), INDEX `IDX_f5ff9ed3910f2f8c09e089232e` (`jobId`, `createdAt`), " +
  "PRIMARY KEY (`id`)) ENGINE=InnoDB";
export const AI_EVIDENCE_TABLES = Object.freeze(["ai_observation"]);
export const AI_EVIDENCE_SQL = Object.freeze([AI_OBSERVATION_CREATE_SQL]);
const sqlOf = value => (typeof value === "string" ? value : value.query);

// The table is created exactly once, and only when it is absent. TypeORM proposes any other change to an existing
// table, which the general contract refuses.
export async function validateAiEvidenceSchema(ds, queries, ErrorType = Error) {
  const rows = await ds.query(`SELECT COUNT(*) AS count FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_observation'`);
  const pending = Number(!Number(rows[0]?.count));
  if (queries.filter(query => sqlOf(query) === AI_OBSERVATION_CREATE_SQL).length !== pending)
    throw new ErrorType("AI failure evidence table addition does not match the existing schema");
}
