const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const { HackService } = require('./hack.service.ts');
const { CodeLanguageService } = require('../code-language/code-language.service.ts');
const { HackProblemEntity } = require('./hack.entity.ts');
const { UserEntity } = require('../user/user.entity.ts');
const { createHash } = require('node:crypto');

function fixture() {
  const store = new Map(), user = { id: 7 }, problem = { id: 42, type: 'Traditional' }, calls = { content: 0 };
  const options = { compiler: 'g++', std: 'c++17', O: '2', m: '64' };
  const submission = { id: 10, problemId: 42, status: 'Accepted', taskId: null };
  const content = { language: 'cpp', code: 'int main(){return 0;}', compileAndRunOptions: options };
  let configure = true, view = true;
  const service = Object.create(HackService.prototype);
  Object.assign(service, {
    db: { getRepository: entity => {
      if (entity === UserEntity) return { findOneBy: async () => user };
      assert.equal(entity, HackProblemEntity);
      return { findOneBy: async ({ problemId }) => store.get(problemId), save: async value => {
        store.set(value.problemId, structuredClone(value)); return value;
      }};
    } },
    privileges: { userHasPrivilege: async () => true, permissionDecision: async () => configure },
    problems: { findProblemById: async () => problem, userHasPermission: async () => true,
      getProblemJudgeInfo: async () => [{ subtasks: [] }], getProblemFiles: async () => [] },
    submissions: { findSubmissionById: async () => submission, userHasPermission: async () => view,
      userHasTeamResourceAccess: async () => true, getSubmissionDetail: async () => { calls.content++; return { content }; } },
    languages: new CodeLanguageService(), files: {}
  });
  return { service, user, problem, submission, content, options, calls, store,
    denyConfigure: () => configure = false, denyView: () => view = false };
}

test('managers can save STD code and options without a reference submission ID', async () => {
  const f = fixture();
  await f.service.saveConfig(f.user, { problemId: 42, standardCode: f.content.code, standardLanguage: 'cpp',
    standardCompileAndRunOptions: f.options, validatorCode: 'int main(){}', validatorLanguage: 'cpp' });
  const stored = f.store.get(42);
  assert.equal(stored.referenceSubmissionId, 0);
  assert.deepEqual(stored.standardContent, { ...f.content, fileIo: null });
  assert.equal(f.calls.content, 0);
  assert.equal((await f.service.config(f.user, 42)).standardCode, f.content.code);
});
test('STD source and compilation options must pass language validation', async () => {
  const f = fixture(), request = { problemId: 42, standardCode: 'code', standardLanguage: 'cpp',
    standardCompileAndRunOptions: { ...f.options, compiler: 'arbitrary-shell' }, validatorCode: 'validator', validatorLanguage: 'cpp' };
  await assert.rejects(f.service.saveConfig(f.user, request), /compilation options/);
  await assert.rejects(f.service.saveConfig(f.user, { ...request, standardLanguage: 'shell' }), /language/);
  assert.equal(f.store.size, 0);
});
test('setting a submission as STD copies accepted source, options and provenance', async () => {
  const f = fixture();
  const result = await f.service.useSubmissionReference(f.user, 10);
  assert.equal(result.problemId, 42);
  assert.equal(result.validatorRequired, true);
  assert.equal(f.store.get(42).referenceSubmissionId, 10);
  assert.deepEqual(f.store.get(42).standardContent, { ...f.content, fileIo: null });
  f.content.code = 'changed later';
  assert.equal(f.store.get(42).standardContent.code, 'int main(){return 0;}');
});
test('reference actions do not bypass denied manager or submission-code access', async () => {
  for (const deny of ['denyConfigure', 'denyView']) {
    const f = fixture(); f[deny]();
    await assert.rejects(f.service.useSubmissionReference(f.user, 10));
    assert.equal(f.calls.content, 0); assert.equal(f.store.size, 0);
  }
  const f = fixture(); f.denyConfigure();
  await assert.rejects(f.service.config(f.user, 42));
  await assert.rejects(f.service.saveConfig(f.user, { problemId: 42 }));
});
test('pending, rejected, invalidated and nontraditional sources cannot become STD', async () => {
  for (const state of ['Pending', 'WrongAnswer', 'Fake', 'Hacked', 'CompilationError']) {
    const f = fixture(); f.submission.status = state;
    await assert.rejects(f.service.useSubmissionReference(f.user, 10), /accepted submission/);
    assert.equal(f.store.size, 0);
  }
  const f = fixture(); f.problem.type = 'SubmitAnswer';
  await assert.rejects(f.service.useSubmissionReference(f.user, 10), /traditional/);
});
test('formal validator import verifies the immutable generator profile hash', async () => {
  const f = fixture(), source = '#include <iostream>\nint main(){}';
  f.service.problems.getProblemFiles = async () => [{ filename: 'formal-validator.cpp', uuid: 'source' }];
  const profile = { validatorFile: 'formal-validator.cpp', validatorSha256: createHash('sha256').update(source).digest('hex') };
  f.service.problems.getProblemJudgeInfo = async () => [{ selfEval: profile }];
  f.service.files.downloadFileToPath = async (_uuid, destination) => fs.promises.writeFile(destination, source);
  await f.service.useSubmissionReference(f.user, 10);
  assert.equal(f.store.get(42).validatorCode, source);
  profile.validatorSha256 = '0'.repeat(64);
  await assert.rejects(f.service.formalValidator(42), /validator changed/);
});
test('stored code references survive later source rejudges but stay protected as targets', async () => {
  const f = fixture(); f.store.set(42, { problemId: 42, validatorCode: 'validator', validatorLanguage: 'cpp' }); await f.service.useSubmissionReference(f.user, 10);
  f.submission.status = 'WrongAnswer';
  assert.deepEqual(await f.service.standardContent(f.store.get(42)), { ...f.content, fileIo: null });
  f.submission.status = 'Accepted';
  assert.equal((await f.service.eligibility(f.user, 10)).reason, 'The trusted reference cannot be hacked');
});

test('manual STD stdin/stdout is explicit and independent of formal problem file I/O', async () => {
  const f = fixture();
  const formalIo = { inputFilename: 'formal.in', outputFilename: 'formal.out' };
  f.service.problems.getProblemJudgeInfo = async () => [{ fileIo: formalIo }];
  await f.service.saveConfig(f.user, { problemId: 42, standardCode: f.content.code, standardLanguage: 'cpp',
    standardCompileAndRunOptions: f.options, standardFileIo: null, validatorCode: 'validator', validatorLanguage: 'cpp' });
  assert.equal(f.store.get(42).standardContent.fileIo, null);
  assert.equal((await f.service.config(f.user, 42)).standardFileIo, null);
  const customIo = { inputFilename: '中文 输入.in', outputFilename: '中文 答案.out' };
  await f.service.saveConfig(f.user, { problemId: 42, standardCode: f.content.code, standardLanguage: 'cpp',
    standardCompileAndRunOptions: f.options, standardFileIo: customIo, validatorCode: 'validator', validatorLanguage: 'cpp' });
  assert.deepEqual(f.store.get(42).standardContent.fileIo, customIo);
  assert.deepEqual((await f.service.config(f.user, 42)).standardFileIo, customIo);
});

test('copied references preserve ordinary formal I/O or contest submission filenames', async () => {
  const f = fixture();
  const formalIo = { inputFilename: '.输入.in', outputFilename: '_答案.out' };
  f.service.problems.getProblemJudgeInfo = async () => [{ fileIo: formalIo }];
  await f.service.useSubmissionReference(f.user, 10);
  assert.deepEqual(f.store.get(42).standardContent.fileIo, formalIo);
  Object.assign(f.submission, { contestId: 8, contestInputFilename: '比赛 输入.in', contestOutputFilename: '比赛 答案.out' });
  const contestIo = { inputFilename: f.submission.contestInputFilename, outputFilename: f.submission.contestOutputFilename };
  await f.service.useSubmissionReference(f.user, 10);
  assert.deepEqual(f.store.get(42).standardContent.fileIo, contestIo);
  f.submission.contestInputFilename = 'later.in';
  assert.deepEqual(await f.service.referenceFileIo(f.store.get(42)), contestIo);
  f.submission.contestInputFilename = '';
  f.submission.contestOutputFilename = '';
  await f.service.useSubmissionReference(f.user, 10);
  assert.equal(f.store.get(42).standardContent.fileIo, null);
});

test('STD filenames reject traversal, unsafe names, stderr collisions and oversized UTF-8 names', () => {
  const f = fixture();
  const check = (inputFilename, outputFilename = 'answer.out') => f.service.validateReferenceFileIo({ inputFilename, outputFilename });
  for (const name of ['../x', '/tmp/x', 'a/b', 'a\\b', '.', '..', '..hidden', 'hack-stderr', '', 'a\n', 'a\0', 'x'.repeat(256), '测'.repeat(86)])
    assert.throws(() => check(name), /safe filenames/);
  assert.throws(() => check('same', 'same'), /safe filenames/);
  assert.throws(() => check('input.in', 'hack-stderr'), /safe filenames/);
  assert.throws(() => f.service.validateReferenceFileIo({ inputFilename: 'a', outputFilename: 'b', extra: 'c' }), /safe filenames/);
  assert.throws(() => f.service.validateReferenceFileIo(['a', 'b']), /safe filenames/);
  assert.equal(check('x'.repeat(255)).inputFilename.length, 255);
  assert.equal(check('测'.repeat(85)).inputFilename, '测'.repeat(85));
  assert.deepEqual(check('中文 输入.in'), { inputFilename: '中文 输入.in', outputFilename: 'answer.out' });
  assert.deepEqual(check('.输入.in'), { inputFilename: '.输入.in', outputFilename: 'answer.out' });
});

test('legacy saved references recover source or formal I/O without rewriting queued snapshots', async () => {
  const f = fixture();
  const formalIo = { inputFilename: 'formal.in', outputFilename: 'formal.out' };
  f.service.problems.getProblemJudgeInfo = async () => [{ fileIo: formalIo }];
  const legacy = { problemId: 42, referenceSubmissionId: 10, standardContent: f.content, validatorCode: 'validator', validatorLanguage: 'cpp' };
  f.store.set(42, legacy);
  assert.deepEqual(await f.service.referenceFileIo(legacy), formalIo);
  const snapshot = { reference: structuredClone(f.content), validator: { language: 'cpp', code: 'validator' } };
  const job = { hackerId: 7, submissionId: 10, problemId: 42, snapshot };
  assert.equal(await f.service.taskAuthorised(job), true);
  assert.equal(Object.hasOwn(snapshot, 'referenceFileIo'), false);
  f.service.submissions.findSubmissionById = async () => null;
  assert.deepEqual(await f.service.referenceFileIo(legacy), formalIo);
});

test('new task authorization compares the explicit STD I/O snapshot before applying a verdict', async () => {
  const f = fixture();
  const saved = { problemId: 42, referenceSubmissionId: 0, standardContent: { ...f.content, fileIo: null }, validatorCode: 'validator', validatorLanguage: 'cpp' };
  f.store.set(42, saved);
  const snapshot = { reference: structuredClone(saved.standardContent), referenceFileIo: null, validator: { language: 'cpp', code: 'validator' } };
  const job = { hackerId: 7, submissionId: 10, problemId: 42, snapshot };
  assert.equal(await f.service.taskAuthorised(job), true);
  saved.standardContent.fileIo = { inputFilename: 'new.in', outputFilename: 'new.out' };
  assert.equal(await f.service.taskAuthorised(job), false);
});
