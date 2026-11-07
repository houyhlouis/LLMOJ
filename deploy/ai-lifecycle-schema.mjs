// Exact additive Part 38 lifecycle and compact job projection contract. Never rewrites historical rows.
// Defaults below are SQL literals: TypeORM's MariaDB driver quotes numeric defaults too.
const columns = [
  ['ai_usage', 'stageId', 'varchar(36)', true, null],
  ['ai_usage', 'requestAttempt', 'int', true, null],
  ['ai_usage', 'diagnostics', 'longtext', true, null],
  ['ai_response_checkpoint', 'stageId', 'varchar(36)', true, null],
  ['ai_response_checkpoint', 'generationId', 'varchar(36)', true, null],
  ['ai_response_checkpoint', 'purpose', 'varchar(20)', true, null],
  ['ai_response_checkpoint', 'requestAttempts', 'int', false, "'0'"],
  ['ai_response_checkpoint', 'bindingHash', 'varchar(64)', true, null],
  ['ai_response_checkpoint', 'lifecycle', 'varchar(20)', false, "'legacy'"],
  ['ai_response_checkpoint', 'terminalStatus', 'varchar(20)', true, null],
  ['ai_response_checkpoint', 'cancellation', 'varchar(20)', false, "'not_requested'"],
  ['ai_response_checkpoint', 'cancellationError', 'varchar(80)', true, null],
  ['ai_job', 'revision', 'int', false, "'1'"],
  ['ai_job', 'attempt', 'int', false, "'0'"],
  ['ai_job', 'stageStartedAt', 'datetime(6)', true, null],
  ['ai_job', 'stageEndedAt', 'datetime(6)', true, null],
  ['ai_job', 'projection', 'longtext', true, null],
  ['ai_job', 'timeline', 'longtext', true, null]
];
export const AI_LIFECYCLE_COLUMNS = Object.freeze(columns);
export const AI_JOB_QUEUE_INDEX_SQL = "CREATE INDEX `IDX_ai_job_owner_status_created` ON `ai_job` (`ownerId`, `status`, `createdAt`, `id`)";
export const AI_LIFECYCLE_SQL = Object.freeze([...columns.map(([table, name, type, nullable, value]) =>
  `ALTER TABLE \`${table}\` ADD \`${name}\` ${type} ${nullable ? 'NULL' : 'NOT NULL'}${value === null ? '' : ` DEFAULT ${value}`}`), AI_JOB_QUEUE_INDEX_SQL]);
const sqlOf = value => typeof value === 'string' ? value : value.query;
const normalizeDefault = value => value === null || value === 'NULL' ? null : String(value).replace(/^'(.*)'$/, '$1');
export async function validateAiLifecycleSchema(ds, queries, ErrorType = Error) {
  for (const table of [...new Set(columns.map(row => row[0]))]) {
    const tables = await ds.query(`SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${table}'`);
    const rows = await ds.query(`SELECT COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable,
      COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${table}'`);
    for (const [index, [nameTable, name, type, nullable, value]] of columns.entries()) {
      if (nameTable !== table) continue;
      const found = rows.filter(row => row.columnName === name);
      const row = found[0];
      if (row && (found.length !== 1 || row.columnType.replace(/^int\(11\)$/, 'int') !== type ||
          row.isNullable !== (nullable ? 'YES' : 'NO') || normalizeDefault(row.defaultValue) !== normalizeDefault(value) ||
          row.extra !== '' || row.comment !== '')) throw new ErrorType(`Unsupported existing ${table} ${name} column`);
      if (queries.filter(q => sqlOf(q) === AI_LIFECYCLE_SQL[index]).length !== Number(Number(tables[0]?.count) > 0 && !row))
        throw new ErrorType(`The ${table} ${name} addition does not match the existing schema`);
    }
  }
  const tables = await ds.query("SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_job'");
  const indexes = await ds.query("SELECT COLUMN_NAME AS name, SEQ_IN_INDEX AS position, NON_UNIQUE AS nonUnique, SUB_PART AS subPart, INDEX_TYPE AS indexType FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_job' AND INDEX_NAME='IDX_ai_job_owner_status_created' ORDER BY SEQ_IN_INDEX");
  const expected = ['ownerId', 'status', 'createdAt', 'id'];
  if (indexes.length && (indexes.length !== expected.length || indexes.some((row, i) => row.name !== expected[i] || Number(row.position) !== i + 1 || Number(row.nonUnique) !== 1 || row.subPart !== null || row.indexType !== 'BTREE')))
    throw new ErrorType('Unsupported existing ai_job queue index');
  if (queries.filter(q => sqlOf(q) === AI_JOB_QUEUE_INDEX_SQL).length !== Number(Number(tables[0]?.count) > 0 && !indexes.length))
    throw new ErrorType('The ai_job queue index addition does not match the existing schema');

}

export const SCHEMA_MIGRATION_VERSION = 'part38-b-v1';
export async function recordSchemaMigration(ds) {
  await ds.query('INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
    ['deployment.schema', JSON.stringify({ version: SCHEMA_MIGRATION_VERSION, appliedAt: new Date().toISOString() })]);
}
