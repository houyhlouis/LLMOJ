// Exact, additive schema of AI budgets: tokens held for provider requests whose usage isn't confirmed yet.
// Imported only by the offline upgrader.
export const AI_RESERVATION_CREATE_SQL = "CREATE TABLE `ai_reservation` (`id` varchar(36) NOT NULL, " +
  "`ownerId` int NOT NULL, `jobId` varchar(36) NULL, `tokens` bigint NOT NULL, `responseHash` varchar(64) NULL, " +
  "`createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), `settledAt` datetime NULL, " +
  "INDEX `IDX_6c115949049cce43fecb3fb2c1` (`ownerId`, `responseHash`), " +
  "INDEX `IDX_0e8c512c17d1cabee48536ec1c` (`ownerId`, `createdAt`), PRIMARY KEY (`id`)) ENGINE=InnoDB";
export const AI_BUDGET_TABLES = Object.freeze(["ai_reservation"]);
export const AI_BUDGET_SQL = Object.freeze([AI_RESERVATION_CREATE_SQL]);
const sqlOf = value => (typeof value === "string" ? value : value.query);

// The table is created exactly once, and only when it is absent. TypeORM proposes any other change to an existing
// table, which the general contract refuses.
export async function validateAiBudgetSchema(ds, queries, ErrorType = Error) {
  const rows = await ds.query(`SELECT COUNT(*) AS count FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_reservation'`);
  const pending = Number(!Number(rows[0]?.count));
  if (queries.filter(query => sqlOf(query) === AI_RESERVATION_CREATE_SQL).length !== pending)
    throw new ErrorType("AI budget table addition does not match the existing schema");
}
