// Exact, additive schema of sealed uploads (review N03): each file records the upload it was copied from, and an
// upload becomes at most one file. Imported only by the offline upgrader.
export const FILE_UPLOAD_UUID_SQL = "ALTER TABLE `file` ADD `uploadUuid` char(36) NULL";
export const FILE_UPLOAD_UUID_INDEX = "IDX_73778d921dce5689d691d393ef";
export const FILE_UPLOAD_UUID_INDEX_SQL = "ALTER TABLE `file` ADD UNIQUE INDEX `" + FILE_UPLOAD_UUID_INDEX +
  "` (`uploadUuid`)";
export const SEALED_UPLOAD_SQL = Object.freeze([FILE_UPLOAD_UUID_SQL, FILE_UPLOAD_UUID_INDEX_SQL]);
const sqlOf = value => (typeof value === "string" ? value : value.query);
const count = (queries, sql) => queries.filter(query => sqlOf(query) === sql).length;

// The column and its unique index are added exactly once, and only when absent. An existing column must be exactly
// the one this release adds, and an existing index exactly its unique index on that column alone. Every installation
// has a `file` table, so neither comes with a table this upgrade creates.
export async function validateSealedUploadSchema(ds, queries, ErrorType = Error) {
  const columns = await ds.query(`SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
    COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='file' AND COLUMN_NAME='uploadUuid'`);
  const [column] = columns;
  if (column && (columns.length !== 1 || column.columnType !== "char(36)" || column.isNullable !== "YES" ||
      ![null, "NULL"].includes(column.defaultValue) || column.extra !== "" || column.comment !== ""))
    throw new ErrorType("Unsupported existing file uploadUuid column");
  if (count(queries, FILE_UPLOAD_UUID_SQL) !== Number(!column))
    throw new ErrorType("The file uploadUuid column addition does not match the existing schema");
  const indexes = await ds.query(`SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS position,
    COLUMN_NAME AS columnName FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='file' AND (INDEX_NAME=? OR COLUMN_NAME='uploadUuid')`,
  [FILE_UPLOAD_UUID_INDEX]);
  const index = indexes.filter(row => row.name === FILE_UPLOAD_UUID_INDEX);
  if (indexes.some(row => row.name !== FILE_UPLOAD_UUID_INDEX) || (index.length && (index.length !== 1 ||
      Number(index[0].nonUnique) !== 0 || Number(index[0].position) !== 1 || index[0].columnName !== "uploadUuid")))
    throw new ErrorType("Unsupported existing file uploadUuid index");
  if (count(queries, FILE_UPLOAD_UUID_INDEX_SQL) !== Number(!index.length))
    throw new ErrorType("The file uploadUuid index addition does not match the existing schema");
}
