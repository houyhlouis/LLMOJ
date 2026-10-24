// Exact, additive schema of test data retention (review 4.1): the data versions whose test data a problem manager
// chose to keep. Imported only by the offline upgrader.
export const PROBLEM_DATA_VERSION_KEEP_CREATE_SQL = "CREATE TABLE `problem_data_version_keep` (" +
  "`problemDataVersionId` int NOT NULL, `keptBy` int NULL, `keptAt` datetime NOT NULL, " +
  "PRIMARY KEY (`problemDataVersionId`)) ENGINE=InnoDB";
export const PROBLEM_DATA_VERSION_KEEP_FOREIGN_KEY_SQL = "ALTER TABLE `problem_data_version_keep` ADD CONSTRAINT " +
  "`FK_2234fdb4e7ef2d2559efc9c0328` FOREIGN KEY (`problemDataVersionId`) REFERENCES `problem_data_version`(`id`) " +
  "ON DELETE CASCADE ON UPDATE NO ACTION";
export const DATA_RETENTION_TABLES = Object.freeze(["problem_data_version_keep"]);
export const DATA_RETENTION_SQL = Object.freeze([PROBLEM_DATA_VERSION_KEEP_CREATE_SQL, PROBLEM_DATA_VERSION_KEEP_FOREIGN_KEY_SQL]);
const sqlOf = value => (typeof value === "string" ? value : value.query);
const count = (queries, sql) => queries.filter(query => sqlOf(query) === sql).length;

// The table is created together with its foreign key, exactly once, and only when it is absent. TypeORM proposes any
// other change to an existing table, which the general contract refuses.
export async function validateDataRetentionSchema(ds, queries, ErrorType = Error) {
  const rows = await ds.query(`SELECT COUNT(*) AS count FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='problem_data_version_keep'`);
  const pending = Number(!Number(rows[0]?.count));
  if (count(queries, PROBLEM_DATA_VERSION_KEEP_CREATE_SQL) !== pending ||
      count(queries, PROBLEM_DATA_VERSION_KEEP_FOREIGN_KEY_SQL) !== pending)
    throw new ErrorType("Test data retention table addition does not match the existing schema");
}
