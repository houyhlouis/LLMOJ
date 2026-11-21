import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTEST_VIRTUAL_SQL, validateContestVirtualSchema } from '../contest-virtual-schema.mjs';
import { validateQueries } from '../upgrade-schema.mjs';

test('the compiled virtual run entity produces the frozen MariaDB DDL without connecting', async () => {
  const backend = createRequire(new URL('../../apps/backend/package.json', import.meta.url));
  backend('reflect-metadata');
  const { DataSource, Table, TableForeignKey } = backend('typeorm');
  const ds = new DataSource({ type: 'mariadb', database: 'llmoj_test_contest_virtual',
    entities: [fileURLToPath(new URL('../../apps/backend/dist/**/*.entity.js', import.meta.url))] });
  await ds.buildMetadatas();
  const meta = ds.getMetadata('contest_virtual_participation');
  const runner = ds.createQueryRunner();
  const table = Table.create(meta, ds.driver);
  const ddl = [runner.createTableSql(table, false), ...meta.foreignKeys.map(key =>
    runner.createForeignKeySql(table, TableForeignKey.create(key, ds.driver)))];
  assert.deepEqual(validateQueries(ddl), CONTEST_VIRTUAL_SQL);
  assert.throws(() => validateQueries([ddl[0].query.replace('UNIQUE INDEX', 'INDEX')]), /compatibility contract/);
  assert.throws(() => validateQueries([ddl[1].query.replace('ON DELETE CASCADE', 'ON DELETE SET NULL')]), /compatibility contract/);
});

const unique = ['contestId', 'userId'].map((columnName, i) => ({
  columnName, position: i + 1, nonUnique: 0, prefixLength: null, type: 'BTREE'
}));
const foreign = [
  ['FK_784844c4bc1f7a1b9156c2b8ed0', 'contestId', 'contest'],
  ['FK_8c1cc120f1e8f6625b652cb4e6a', 'userId', 'user']
].map(([name, columnName, target]) => ({ name, columnName, target, localTarget: 1,
  targetColumn: 'id', onDelete: 'CASCADE', onUpdate: 'NO ACTION' }));

function fixture({ exists = true, keys = foreign, index = unique, engine = 'InnoDB' } = {}) {
  return { query: async (sql, parameters) => {
    assert.deepEqual(parameters, ['contest_virtual_participation']);
    if (sql.includes('information_schema.TABLES')) return exists ? [{ engine, type: 'BASE TABLE' }] : [];
    if (sql.includes('information_schema.STATISTICS')) return index;
    assert.match(sql, /information_schema.REFERENTIAL_CONSTRAINTS/);
    return keys;
  } };
}

test('the upgrader accepts exactly the outstanding DDL before, during and after table creation', async () => {
  await validateContestVirtualSchema(fixture({ exists: false }), CONTEST_VIRTUAL_SQL);
  await validateContestVirtualSchema(fixture({ keys: [] }), CONTEST_VIRTUAL_SQL.slice(1));
  await validateContestVirtualSchema(fixture({ keys: [foreign[0]] }), [CONTEST_VIRTUAL_SQL[2]]);
  await validateContestVirtualSchema(fixture(), []);
  for (const sql of CONTEST_VIRTUAL_SQL) {
    await assert.rejects(validateContestVirtualSchema(fixture({ exists: false }), CONTEST_VIRTUAL_SQL.filter(q => q !== sql)), /addition/);
    await assert.rejects(validateContestVirtualSchema(fixture({ exists: false }), [...CONTEST_VIRTUAL_SQL, sql]), /addition/);
    await assert.rejects(validateContestVirtualSchema(fixture(), [sql]), /addition/);
  }
});

test('existing virtual runs require the ordered unique index and both local cascading foreign keys', async () => {
  await assert.rejects(validateContestVirtualSchema(fixture({ engine: 'MyISAM' }), []), /Unsupported/);
  for (const index of [unique.slice(1), [...unique].reverse(), unique.map(row => ({ ...row, nonUnique: 1 }))])
    await assert.rejects(validateContestVirtualSchema(fixture({ index }), []), /unique index/);
  for (const change of [{ target: 'team' }, { columnName: 'id' }, { targetColumn: 'name' }, { localTarget: 0 },
    { onDelete: 'SET NULL' }, { onUpdate: 'CASCADE' }, { name: 'other' }])
    await assert.rejects(validateContestVirtualSchema(fixture({ keys: [{ ...foreign[0], ...change }, foreign[1]] }), []), /foreign key/);
});
