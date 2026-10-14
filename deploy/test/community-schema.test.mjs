import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validateQueries, validateCommunitySchema, LEGACY_SUBMISSION_STATUSES,
  SUBMISSION_FAKE_EXPANSION_SQL, DISCUSSION_TYPE_ADD_SQL, DISCUSSION_TYPE_INDEX_SQL,
  normalizeCommunitySchemaQueries, SUBMISSION_ENUM_INDEXES, validateContestSchema,
  CONTEST_RULE_EXPANSION_SQL, CONTEST_RULE_OPTIONS_SQL, HACK_STANDARD_CONTENT_SQL, validateHackStandardSchema
} from '../upgrade-schema.mjs';
const contracts = JSON.parse(fs.readFileSync(new URL('../community-schema-contract.json', import.meta.url), 'utf8'));
const changes = [SUBMISSION_FAKE_EXPANSION_SQL, DISCUSSION_TYPE_ADD_SQL, DISCUSSION_TYPE_INDEX_SQL];
const rebuild = SUBMISSION_ENUM_INDEXES.flatMap(index => [
  'DROP INDEX `' + index.name + '` ON `submission`',
  'CREATE INDEX `' + index.name + '` ON `submission` (' + index.columns.map(column => '`' + column + '`').join(', ') + ')'
]);
const currentIndexes = SUBMISSION_ENUM_INDEXES.flatMap(index => index.columns.map((columnName, position) => ({
  indexName: index.name, nonUnique: 1, sequence: position + 1, columnName, subPart: null, indexType: 'BTREE'
})));
test('only full exact unchanged enum-index rebuild pairs are omitted; no DROP ever reaches the executable plan', async () => {
  const connection = { query: async () => currentIndexes };
  const raw = [SUBMISSION_FAKE_EXPANSION_SQL, ...rebuild];
  assert.deepEqual(await normalizeCommunitySchemaQueries(connection, raw), [SUBMISSION_FAKE_EXPANSION_SQL]);
  assert.deepEqual(validateQueries(await normalizeCommunitySchemaQueries(connection, raw)), [SUBMISSION_FAKE_EXPANSION_SQL]);
  for (const malformed of [raw.slice(0, -1), [...raw, 'DROP INDEX `future` ON `submission`'],
    [SUBMISSION_FAKE_EXPANSION_SQL, ...rebuild.map(sql => sql.replace('(`submitterId`, `status`)', '(`status`, `submitterId`)'))], rebuild]) {
    const normalized = await normalizeCommunitySchemaQueries(connection, malformed);
    assert.throws(() => validateQueries(normalized));
  }
});
test('enum-index normalization validates parameters and every original index column before mutation', async () => {
  const raw = [SUBMISSION_FAKE_EXPANSION_SQL, ...rebuild];
  await assert.rejects(() => normalizeCommunitySchemaQueries({ query: async () => currentIndexes }, [{ query: raw[0], parameters: ['x'] }, ...raw.slice(1)]));
  const corrupted = currentIndexes.map((row, index) => index === 0 ? { ...row, columnName: 'future' } : row);
  await assert.rejects(() => normalizeCommunitySchemaQueries({ query: async () => corrupted }, raw));
});
test('all frozen community CREATE definitions and exact incremental verdict/category SQL are accepted', () => {
  const sql = [...contracts.tables.map(table => table.createSql), ...changes];
  assert.deepEqual(validateQueries(sql), sql);
  const changedHashes = contracts.tables.map(table => table.createSql.replace(/IDX_[0-9a-f]+/g, 'IDX_abcdef123456'));
  assert.deepEqual(validateQueries(changedHashes), changedHashes);
});
for (const table of contracts.tables) {
  test('reject arbitrary changes to frozen table ' + table.name, () => {
    for (const sql of [
      table.createSql.replace(/\bint\b/, 'bigint'),
      table.createSql.replace(/PRIMARY KEY \([^)]+\)/, 'PRIMARY KEY (`unexpected`)'),
      table.createSql.replace('ENGINE=InnoDB', 'ENGINE=MyISAM'),
      table.createSql.replace(/ \(`[^`]+`/, ' (`other`'),
      table.createSql.replace('CREATE TABLE `' + table.name + '`', 'CREATE TABLE `unexpected`'),
      table.createSql.replace(') ENGINE=InnoDB', ', `future` int NOT NULL) ENGINE=InnoDB')
    ]) assert.throws(() => validateQueries([sql]), table.name);
  });
}
test('community DDL never allows destructive, parameterized or alternate column changes', () => {
  for (const sql of [
    'DROP TABLE `team`', 'TRUNCATE TABLE `submission`', 'ALTER TABLE `team` ADD `extra` int',
    DISCUSSION_TYPE_ADD_SQL.replace("DEFAULT 'Discussion'", "DEFAULT 'Solution'"),
    DISCUSSION_TYPE_ADD_SQL.replace('varchar(20)', 'varchar(80)'),
    DISCUSSION_TYPE_ADD_SQL.replace('NOT NULL', 'NULL'),
    DISCUSSION_TYPE_INDEX_SQL.replace('CREATE INDEX', 'CREATE UNIQUE INDEX'),
    DISCUSSION_TYPE_INDEX_SQL.replace('(`type`)', '(`type`, `id`)'),
    SUBMISSION_FAKE_EXPANSION_SQL.replace("'Pending', 'ConfigurationError'", "'ConfigurationError', 'Pending'"),
    SUBMISSION_FAKE_EXPANSION_SQL.replace("'Fake'", "'Fake', 'FutureStatus'"),
    SUBMISSION_FAKE_EXPANSION_SQL.replace("'Accepted', ", ''),
    SUBMISSION_FAKE_EXPANSION_SQL.replace('NOT NULL', 'NULL'),
    SUBMISSION_FAKE_EXPANSION_SQL + " DEFAULT 'Pending'",
    SUBMISSION_FAKE_EXPANSION_SQL + '; DROP TABLE `user`'
  ]) assert.throws(() => validateQueries([sql]));
  for (const parameters of [['x'], { x: 1 }, 'value']) assert.throws(() => validateQueries([{ query: changes[0], parameters }]));
});
const enumType = values => 'enum(' + values.map(value => "'" + value + "'").join(',') + ')';
const statusColumn = values => ({ columnType: enumType(values), isNullable: 'NO', defaultValue: null,
  collation: 'utf8mb4_unicode_ci', extra: '', comment: '' });
const typeColumn = { columnType: 'varchar(20)', isNullable: 'NO', defaultValue: "'Discussion'",
  collation: 'utf8mb4_unicode_ci', extra: '', comment: '' };
const index = { nonUnique: 1, sequence: 1, columnName: 'type', subPart: null, indexType: 'BTREE' };
function fixture({ status = statusColumn(LEGACY_SUBMISSION_STATUSES), type = [], indexes = [] } = {}) {
  return { query: async sql => sql.includes('STATISTICS') ? indexes :
    sql.includes("TABLE_NAME='submission'") ? (status ? [status] : []) : type };
}
test('old and complete schemas require precisely their pending changes', async () => {
  await validateCommunitySchema(fixture(), changes);
  await validateCommunitySchema(fixture({ status: statusColumn([...LEGACY_SUBMISSION_STATUSES, 'Fake']), type: [typeColumn], indexes: [index] }), [SUBMISSION_FAKE_EXPANSION_SQL]);
  await validateCommunitySchema(fixture({ status: statusColumn([...LEGACY_SUBMISSION_STATUSES, 'Fake', 'Hacked']), type: [typeColumn], indexes: [index] }), []);
  await validateCommunitySchema(fixture({ status: statusColumn([...LEGACY_SUBMISSION_STATUSES, 'Fake', 'Hacked']), type: [typeColumn] }), [DISCUSSION_TYPE_INDEX_SQL]);
  await assert.rejects(() => validateCommunitySchema(fixture(), changes.slice(1)));
  await assert.rejects(() => validateCommunitySchema(fixture(), [...changes, changes[0]]));
  await assert.rejects(() => validateCommunitySchema(fixture({ status: statusColumn([...LEGACY_SUBMISSION_STATUSES, 'Fake', 'Hacked']), type: [typeColumn], indexes: [index] }), [changes[0]]));
});
test('unknown historical status orders, nullability, defaults and custom metadata are rejected', async () => {
  const old = statusColumn(LEGACY_SUBMISSION_STATUSES);
  for (const status of [null, statusColumn([...LEGACY_SUBMISSION_STATUSES].reverse()),
    statusColumn([...LEGACY_SUBMISSION_STATUSES, 'FutureStatus']), { ...old, isNullable: 'YES' },
    { ...old, defaultValue: "'Pending'" }, { ...old, collation: 'utf8mb4_bin' }, { ...old, extra: 'DEFAULT_GENERATED' },
    { ...old, comment: 'custom' }])
    await assert.rejects(() => validateCommunitySchema(fixture({ status }), changes));
});
test('unknown category column attributes and index structures are rejected before mutation', async () => {
  const status = statusColumn([...LEGACY_SUBMISSION_STATUSES, 'Fake', 'Hacked']);
  for (const type of [{ ...typeColumn, columnType: 'varchar(40)' }, { ...typeColumn, isNullable: 'YES' },
    { ...typeColumn, defaultValue: "'Solution'" }, { ...typeColumn, defaultValue: null },
    { ...typeColumn, collation: 'utf8mb4_bin' }, { ...typeColumn, comment: 'custom' }])
    await assert.rejects(() => validateCommunitySchema(fixture({ status, type: [type], indexes: [index] }), []));
  for (const indexes of [[{ ...index, nonUnique: 0 }], [{ ...index, columnName: 'title' }],
    [{ ...index, subPart: 5 }], [{ ...index, indexType: 'HASH' }], [index, index]])
    await assert.rejects(() => validateCommunitySchema(fixture({ status, type: [typeColumn], indexes }), []));
});

const ruleColumn = { name: 'rule', columnType: 'varchar(8)', isNullable: 'NO', defaultValue: null,
  collation: 'utf8mb4_unicode_ci', extra: '', comment: '' };
const optionsColumn = { name: 'ruleOptions', columnType: 'longtext', isNullable: 'YES', defaultValue: 'NULL',
  collation: 'utf8mb4_unicode_ci', extra: '', comment: '' };
const contestFixture = (columns, count = 0) => ({query: async sql => sql.includes('information_schema') ? columns : [{count}]});
test('contest varchar widening preserves stored rules and admits only the exact historical DROP/ADD proposal', async () => {
  const raw = ['ALTER TABLE `contest` DROP COLUMN `rule`', 'ALTER TABLE `contest` ADD `rule` varchar(16) NOT NULL', CONTEST_RULE_OPTIONS_SQL];
  const expected = [CONTEST_RULE_OPTIONS_SQL, CONTEST_RULE_EXPANSION_SQL];
  assert.deepEqual(await normalizeCommunitySchemaQueries(contestFixture([ruleColumn]), raw), expected);
  assert.deepEqual(validateQueries(expected), expected);
  await validateContestSchema(contestFixture([ruleColumn]), expected);
  await validateContestSchema(contestFixture([{...ruleColumn,columnType:'varchar(16)'}, optionsColumn]), []);
  for (const invalid of [raw.slice(1), raw.slice(0,1), [...raw, raw[0]], raw.map(sql=>sql.replace('varchar(16)','varchar(32)'))])
    assert.throws(()=>validateQueries(invalid));
  await assert.rejects(()=>normalizeCommunitySchemaQueries(contestFixture([ruleColumn],1),raw),/rule values/);
});
test('contest migration rejects custom metadata, missing changes and unsupported rule values before mutation', async () => {
  const changes = [CONTEST_RULE_EXPANSION_SQL, CONTEST_RULE_OPTIONS_SQL];
  for (const rule of [null, {...ruleColumn,columnType:'varchar(24)'},{...ruleColumn,isNullable:'YES'},
    {...ruleColumn,defaultValue:'noi'},{...ruleColumn,collation:'utf8mb4_bin'},{...ruleColumn,comment:'custom'}])
    await assert.rejects(()=>validateContestSchema(contestFixture(rule ? [rule] : []),changes));
  for (const options of [{...optionsColumn,columnType:'text'},{...optionsColumn,isNullable:'NO'},
    {...optionsColumn,defaultValue:'{}'},{...optionsColumn,comment:'custom'}])
    await assert.rejects(()=>validateContestSchema(contestFixture([{...ruleColumn,columnType:'varchar(16)'},options]),[]));
  await assert.rejects(()=>validateContestSchema(contestFixture([ruleColumn]),[]));
  await assert.rejects(()=>validateContestSchema(contestFixture([ruleColumn]),[...changes,changes[0]]));
  await assert.rejects(()=>validateContestSchema(contestFixture([{...ruleColumn,columnType:'varchar(16)'},optionsColumn],1),[]));
});

const standardColumn = {columnType:'longtext',isNullable:'YES',defaultValue:'NULL',collation:'utf8mb4_unicode_ci',extra:'',comment:''};
const standardFixture = (exists,columns=[])=>({query:async sql=>sql.includes('information_schema.TABLES')?[{count:exists}]:columns});
test('reference-ID schema receives exactly one nullable STD column; fresh and complete schemas need no ALTER',async()=>{
 await validateHackStandardSchema(standardFixture(0),[]);
 await validateHackStandardSchema(standardFixture(1),[HACK_STANDARD_CONTENT_SQL]);
 await validateHackStandardSchema(standardFixture(1,[standardColumn]),[]);
 assert.deepEqual(validateQueries([HACK_STANDARD_CONTENT_SQL]),[HACK_STANDARD_CONTENT_SQL]);
 for(const [db,sql] of [[standardFixture(0),[HACK_STANDARD_CONTENT_SQL]],[standardFixture(1),[]],
  [standardFixture(1),[HACK_STANDARD_CONTENT_SQL,HACK_STANDARD_CONTENT_SQL]],[standardFixture(1,[standardColumn]),[HACK_STANDARD_CONTENT_SQL]]])
  await assert.rejects(()=>validateHackStandardSchema(db,sql));
});
test('STD migration cannot overwrite custom types, defaults, nullability or metadata',async()=>{
 for(const column of [{...standardColumn,columnType:'text'},{...standardColumn,isNullable:'NO'},
  {...standardColumn,defaultValue:'{}'},{...standardColumn,comment:'custom'},{...standardColumn,collation:'utf8mb4_bin'}])
  await assert.rejects(()=>validateHackStandardSchema(standardFixture(1,[column]),[]));
 for(const sql of [HACK_STANDARD_CONTENT_SQL.replace('NULL','NOT NULL'),HACK_STANDARD_CONTENT_SQL.replace('longtext','text'),
  HACK_STANDARD_CONTENT_SQL+' DEFAULT \'{}\'',HACK_STANDARD_CONTENT_SQL.replace('ADD','DROP COLUMN')])
  assert.throws(()=>validateQueries([sql]));
});
