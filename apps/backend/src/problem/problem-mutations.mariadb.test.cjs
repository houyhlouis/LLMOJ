// Opt-in actual service/MariaDB regressions; random tables, no production rows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => {
  const source = process.env.HYHOJ_PROBLEM_TEST_BASELINE && filename.endsWith('/problem.service.ts')
    ? process.env.HYHOJ_PROBLEM_TEST_BASELINE : filename;
  module._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true
  } }).outputText, filename);
};
String.prototype.format ||= function (...args) { return require('node:util').format(this, ...args); };
const { DataSource, EntitySchema } = require('typeorm');
const { ProblemService } = require('./problem.service.ts');
const { ProblemEntity } = require('./problem.entity.ts');
const { ProblemSampleEntity } = require('./problem-sample.entity.ts');
const { ProblemJudgeInfoEntity } = require('./problem-judge-info.entity.ts');
const { ProblemFileEntity, ProblemFileType } = require('./problem-file.entity.ts');
const { LocalizedContentEntity, LocalizedContentType } = require('../localized-content/localized-content.entity.ts');

test('problem mutations preserve concurrent fields and file ownership (real MariaDB)',
  { skip: !process.env.HYHOJ_PROBLEM_TEST_DB_CONFIG, timeout: 60000 }, async t => {
  const cfg = require('js-yaml').load(fs.readFileSync(process.env.HYHOJ_PROBLEM_TEST_DB_CONFIG, 'utf8')).services.database;
  const prefix = 'qa_finalfix_problem_' + crypto.randomBytes(8).toString('hex') + '_';
  const int = { type: Number }, json = { type: 'json' };
  const defs = [
    [ProblemEntity, 'problem', { id: { ...int, primary: true, generated: true }, displayId: { ...int, nullable: true, unique: true },
      type: { type: String }, isPublic: { type: Boolean }, publicTime: { type: 'datetime', nullable: true }, ownerId: int,
      locales: json, difficulty: { ...int, nullable: true }, originalProblem: { type: String }, originalProblemTitle: { type: String },
      submissionCount: int, acceptedSubmissionCount: int }],
    [ProblemSampleEntity, 'sample', { problemId: { ...int, primary: true }, data: json }],
    [ProblemJudgeInfoEntity, 'judgeinfo', { problemId: { ...int, primary: true }, judgeInfo: json, submittable: { type: Boolean } }],
    [ProblemFileEntity, 'file', { problemId: { ...int, primary: true }, type: { type: String, primary: true },
      filename: { type: String, length: 256, primary: true }, uuid: { type: String } }],
    [LocalizedContentEntity, 'localized', { objectId: { ...int, primary: true }, type: { type: String, primary: true },
      locale: { type: String, primary: true }, data: { type: 'text' } }]
  ];
  const db = new DataSource({ ...cfg, entities: defs.map(([target, name, columns]) => new EntitySchema({
    name: target.name, target, tableName: prefix + name, columns })), synchronize: true, logging: false });
  const report = { prefix, cases: [], baseline: !!process.env.HYHOJ_PROBLEM_TEST_BASELINE };
  try {
    await db.initialize();
    const repo = db.getRepository(ProblemEntity), files = db.getRepository(ProblemFileEntity);
    const sample = db.getRepository(ProblemSampleEntity), info = db.getRepository(ProblemJudgeInfoEntity);
    const localized = db.getRepository(LocalizedContentEntity);
    const svc = Object.create(ProblemService.prototype);
    Object.assign(svc, { connection: db, problemRepository: repo, problemFileRepository: files,
      submissionService: { setSubmissionsPublic: async () => {}, problemHasAnySubmission: async () => false },
      redisService: { cacheDelete: async () => {} },
      problemTypeFactoryService: { type: () => ({ getDefaultJudgeInfo: () => ({ default: true }) }) },
      localizedContentService: {
        createOrUpdate: async (objectId, type, locale, data, manager) => manager.save(LocalizedContentEntity, { objectId, type, locale, data }),
        delete: async (objectId, type, locale, manager) => manager.delete(LocalizedContentEntity, { objectId, type, locale }),
        invalidateCache: async () => {},
        getOfAllLocales: async (objectId, type) => Object.fromEntries((await localized.findBy({ objectId, type })).map(x => [x.locale, x.data]))
      }, setProblemTags: async () => {} });
    // Only the Redis distributed lock is substituted; actual find/update SQL runs.
    svc.lockManageProblemFile = async (id, type, callback) => callback(await repo.findOneBy({ id }));
    async function fixture() {
      const p = await repo.save(repo.create({ displayId: null, type: 'Traditional', isPublic: true, publicTime: new Date('2026-01-01Z'),
        ownerId: 99, locales: ['en_US'], difficulty: 1000, originalProblem: 'old source', originalProblemTitle: 'old title',
        submissionCount: 2, acceptedSubmissionCount: 1 }));
      await sample.save({ problemId: p.id, data: [{ inputData: '1', outputData: '1' }] });
      await info.save({ problemId: p.id, judgeInfo: { old: true }, submittable: true });
      await localized.save([{ objectId: p.id, type: LocalizedContentType.ProblemTitle, locale: 'en_US', data: 'Initial title' },
        { objectId: p.id, type: LocalizedContentType.ProblemContent, locale: 'en_US', data: '[{"type":"Text","text":"Initial body"}]' }]);
      return p;
    }
    async function run(name, callback) {
      await t.test(name, async () => { await callback(); report.cases.push({ name, passed: true }); });
    }
    for (const action of ['visibility', 'display ID', 'statement', 'type']) await run('stale ' + action + ' preserves unrelated committed fields', async () => {
      const p = await fixture();
      await svc.updateProblemStatistics(p.id, 1, 1);
      await repo.update(p.id, { isPublic: false, difficulty: 1800, originalProblemTitle: 'Concurrent title' });
      if (action === 'visibility') await svc.setProblemPublic(p, false);
      if (action === 'display ID') await svc.setProblemDisplayId(p, p.id + 10000);
      if (action === 'statement') await svc.updateProblemStatement(p, { localizedContents: [{ locale: 'en_US', title: 'Edited', contentSections: [] }] }, []);
      if (action === 'type') await svc.changeProblemType(p, 'Communication');
      const after = await repo.findOneBy({ id: p.id });
      assert.equal(after.submissionCount, 3); assert.equal(after.acceptedSubmissionCount, 2);
      assert.equal(after.isPublic, false); assert.equal(after.difficulty, 1800); assert.equal(after.originalProblemTitle, 'Concurrent title');
    });
    await run('stale equal display ID still applies requested ID to current row', async () => {
      const p = await fixture(); await repo.update(p.id, { displayId: 777 });
      assert.equal(await svc.setProblemDisplayId(p, null), true);
      assert.equal((await repo.findOneBy({ id: p.id })).displayId, null);
    });
    await run('display ID conflict is expected and preserves rows/object', async () => {
      const p = await fixture(), other = await fixture(); await svc.setProblemDisplayId(other, 777);
      assert.equal(await svc.setProblemDisplayId(p, 777), false); assert.equal(p.displayId, null);
      assert.equal((await repo.findOneBy({ id: p.id })).displayId, null);
      await svc.setProblemDisplayId(other, null); assert.equal(await svc.setProblemDisplayId(p, 777), true);
    });
    await run('hide retains current publication time', async () => {
      const p = await fixture(), currentTime = new Date('2026-02-01Z'); await repo.update(p.id, { publicTime: currentTime });
      await svc.setProblemPublic(p, false); assert.equal(+(await repo.findOneBy({ id: p.id })).publicTime, +currentTime);
    });
    for (const mode of ['omitted', 'same current source', 'changed source']) await run('statement source title: ' + mode, async () => {
      const p = await fixture(); await repo.update(p.id, { originalProblem: 'current source', originalProblemTitle: 'Current source title' });
      const request = { localizedContents: [{ locale: 'en_US', title: 'Edit', contentSections: [] }] };
      if (mode !== 'omitted') request.originalProblem = mode === 'changed source' ? 'new source' : 'current source';
      await svc.updateProblemStatement(p, request, []); const after = await repo.findOneBy({ id: p.id });
      assert.equal(after.originalProblem, mode === 'changed source' ? 'new source' : 'current source');
      assert.equal(after.originalProblemTitle, mode === 'changed source' ? '' : 'Current source title');
    });
    await run('omitted title/content reads under the current problem lock', async () => {
      const p = await fixture(), original = svc.connection;
      svc.connection = { transaction: async (level, callback) => {
        await localized.update({ objectId: p.id, type: LocalizedContentType.ProblemTitle }, { data: 'Concurrent title' });
        await localized.update({ objectId: p.id, type: LocalizedContentType.ProblemContent }, { data: '[{"type":"Text","text":"Concurrent body"}]' });
        return db.transaction(level, callback);
      } };
      try { await svc.updateProblemStatement(p, { localizedContents: [{ locale: 'en_US' }] }, []); }
      finally { svc.connection = original; }
      assert.equal((await localized.findOneBy({ objectId: p.id, type: LocalizedContentType.ProblemTitle })).data, 'Concurrent title');
      assert.match((await localized.findOneBy({ objectId: p.id, type: LocalizedContentType.ProblemContent })).data, /Concurrent body/);
    });
    await run('statement write failure rolls metadata/sample/text back', async () => {
      const p = await fixture(), before = await repo.findOneBy({ id: p.id }), original = svc.localizedContentService.createOrUpdate;
      svc.localizedContentService.createOrUpdate = async (...args) => { await original(...args); throw new Error('injected write failure'); };
      try { await assert.rejects(svc.updateProblemStatement(p, { difficulty: 2000, samples: [],
        localizedContents: [{ locale: 'en_US', title: 'Edit', contentSections: [] }] }, []), /injected write failure/); }
      finally { svc.localizedContentService.createOrUpdate = original; }
      assert.deepEqual(await repo.findOneBy({ id: p.id }), before); assert.equal((await sample.findOneBy({ problemId: p.id })).data.length, 1);
      assert.equal((await localized.findOneBy({ objectId: p.id, type: LocalizedContentType.ProblemTitle })).data, 'Initial title');
    });
    for (const type of Object.values(ProblemFileType)) {
      for (const mode of ['collision', 'case-insensitive collision', 'same name', 'case-only rename', 'fresh name', 'missing source']) {
        await run(type + ' rename: ' + mode, async () => {
          const p = await fixture();
          await files.save([{ problemId: p.id, type, filename: 'first.in', uuid: crypto.randomUUID() },
            { problemId: p.id, type, filename: 'second.in', uuid: crypto.randomUUID() }]);
          const before = await files.findBy({ problemId: p.id, type });
          const from = mode === 'missing source' ? 'absent.in' : 'first.in';
          const to = { collision: 'second.in', 'case-insensitive collision': 'SECOND.IN', 'same name': 'first.in',
            'case-only rename': 'FIRST.IN', 'fresh name': 'third.in', 'missing source': 'third.in' }[mode];
          const result = await svc.renameProblemFile(p, type, from, to);
          if (mode.includes('collision')) { assert.equal(result, 'FILE_ALREADY_EXISTS'); assert.deepEqual(await files.findBy({ problemId: p.id, type }), before); }
          else if (mode === 'missing source') { assert.equal(result, false); assert.deepEqual(await files.findBy({ problemId: p.id, type }), before); }
          else { assert.equal(result, true); assert.equal((await files.findOneBy({ problemId: p.id, type, filename: to })).uuid, before.find(x => x.filename === from).uuid); }
        });
      }
    }
    await run('rename duplicate between lookup and update returns conflict', async () => {
      const p = await fixture(), type = ProblemFileType.TestData;
      await files.save({ problemId: p.id, type, filename: 'first.in', uuid: crypto.randomUUID() });
      const first = await files.findOneBy({ problemId: p.id, type, filename: 'first.in' });
      svc.problemFileRepository = { findOneBy: where => files.findOneBy(where), update: async (where, changes) => {
        await files.save({ problemId: p.id, type, filename: changes.filename, uuid: crypto.randomUUID() });
        return files.update(where, changes);
      } };
      try { assert.equal(await svc.renameProblemFile(p, type, 'first.in', 'race.in'), 'FILE_ALREADY_EXISTS'); }
      finally { svc.problemFileRepository = files; }
      assert.equal((await files.findOneBy({ problemId: p.id, type, filename: 'first.in' })).uuid, first.uuid);
    });
    await run('rename unexpected database error remains an error', async () => {
      const p = await fixture(), type = ProblemFileType.TestData;
      await files.save({ problemId: p.id, type, filename: 'first.in', uuid: crypto.randomUUID() });
      svc.problemFileRepository = { findOneBy: where => files.findOneBy(where), update: async () => { throw new Error('unexpected DB failure'); } };
      try { await assert.rejects(svc.renameProblemFile(p, type, 'first.in', 'new.in'), /unexpected DB failure/); }
      finally { svc.problemFileRepository = files; }
    });
  } finally {
    if (db.isInitialized) {
      for (const [,name] of [...defs].reverse()) await db.query('DROP TABLE `' + prefix + name + '`');
      report.remainingTables = (await db.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE ?', [prefix + '%'])).length;
      await db.destroy();
    }
    if (process.env.HYHOJ_PROBLEM_TEST_REPORT) fs.writeFileSync(process.env.HYHOJ_PROBLEM_TEST_REPORT, JSON.stringify(report, null, 2));
  }
});
