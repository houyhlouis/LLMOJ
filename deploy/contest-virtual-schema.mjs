// Frozen MariaDB DDL for the virtual participation entity. The upgrade never rewrites a submission.
const table = "contest_virtual_participation";
const create =
  "CREATE TABLE `contest_virtual_participation` (`id` int NOT NULL AUTO_INCREMENT, " +
  "`contestId` int NOT NULL, `userId` int NOT NULL, `startTime` datetime NOT NULL, " +
  "`endTime` datetime NOT NULL, `createdAt` datetime NOT NULL, " +
  "UNIQUE INDEX `IDX_72a190fa00f8389a2defa0880a` (`contestId`, `userId`), PRIMARY KEY (`id`)) ENGINE=InnoDB";
const keys = [
  ["FK_784844c4bc1f7a1b9156c2b8ed0", "contestId", "contest"],
  ["FK_8c1cc120f1e8f6625b652cb4e6a", "userId", "user"]
];
export const CONTEST_VIRTUAL_SQL = Object.freeze([
  create,
  ...keys.map(
    ([name, column, target]) =>
      `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${name}\` FOREIGN KEY (\`${column}\`) ` +
      `REFERENCES \`${target}\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`
  )
]);

// MariaDB DDL autocommits. An interrupted upgrade can add just the missing constraints on retry.
export async function validateContestVirtualSchema(ds, queries, ErrorType = Error) {
  const sql = queries.map(query => (typeof query === "string" ? query : query.query));
  const expect = (statement, needed) => {
    if (sql.filter(query => query === statement).length !== Number(needed))
      throw new ErrorType("Virtual participation addition does not match the existing schema");
  };
  const tables = await ds.query(
    "SELECT ENGINE AS engine, TABLE_TYPE AS type FROM information_schema.TABLES " +
      "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
    [table]
  );
  if (tables.length && (tables.length !== 1 || tables[0].engine !== "InnoDB" || tables[0].type !== "BASE TABLE"))
    throw new ErrorType("Unsupported existing virtual participation table");
  expect(create, !tables.length);
  if (tables.length) {
    const index = await ds.query(
      `SELECT COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique,
      SEQ_IN_INDEX AS position, SUB_PART AS prefixLength, INDEX_TYPE AS type FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='IDX_72a190fa00f8389a2defa0880a'
      ORDER BY SEQ_IN_INDEX`,
      [table]
    );
    if (
      index.length !== 2 ||
      ["contestId", "userId"].some(
        (column, i) =>
          index[i].columnName !== column ||
          Number(index[i].position) !== i + 1 ||
          Number(index[i].nonUnique) !== 0 ||
          index[i].prefixLength !== null ||
          index[i].type !== "BTREE"
      )
    )
      throw new ErrorType("Unsupported existing virtual participation unique index");
  }
  const foreign = tables.length
    ? await ds.query(
        `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS columnName,
    k.REFERENCED_TABLE_NAME AS target, k.REFERENCED_COLUMN_NAME AS targetColumn,
    k.REFERENCED_TABLE_SCHEMA=DATABASE() AS localTarget, r.DELETE_RULE AS onDelete, r.UPDATE_RULE AS onUpdate
    FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
    ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=?`,
        [table]
      )
    : [];
  for (const row of foreign) {
    if (
      !keys.some(([name, column, target]) => name === row.name && column === row.columnName && target === row.target) ||
      row.targetColumn !== "id" ||
      !Number(row.localTarget) ||
      row.onDelete !== "CASCADE" ||
      row.onUpdate !== "NO ACTION"
    )
      throw new ErrorType("Unsupported existing virtual participation foreign key");
  }
  keys.forEach(([name], index) => expect(CONTEST_VIRTUAL_SQL[index + 1], !foreign.some(row => row.name === name)));
}
