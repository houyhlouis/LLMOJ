/* Pure image-import regressions: model fixtures only; no keys, HTTP, DB or real image API. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const { AiService } = require('./ai.service.ts');
const { AiError } = require('./ai.types.ts');
const { AiJobEntity } = require('./ai.entity.ts');
const { ProblemJudgeInfoEntity } = require('../problem/problem-judge-info.entity.ts');
const { resolveAiFileIo } = require('./ai-file-io.ts');
const files = { inputFilename: 'task.in', outputFilename: 'task.out' };
const namedEvidence = '输入文件：task.in\n输出文件：task.out';
const fixtureStatement = (locale = 'zh_CN', text = '输入文件的第一行包含一个整数 n。输出文件包含一个整数。') => ({
  localizedContents: [{ locale, title: 'Synthetic import fixture', contentSections: [{ type: 'Text', sectionTitle: locale === 'zh_CN' ? '题目描述' : 'Description', text }] }],
  samples: [], judgeInfo: { fileIo: { inputFilename: 'sample.in', outputFilename: 'sample.out' } }
});
const fixtureJob = (input = {}) => ({ id: '00000000-0000-4000-8000-000000000001', ownerId: 1, action: 'import', step: 'import', status: 'running', progress: 0, input, state: { completed: [] } });
const fixtureService = response => {
  const svc = Object.create(AiService.prototype), calls = [];
  svc.model = async (...args) => { calls.push(args); return typeof response === 'function' ? response(...args) : response; };
  return { svc, calls };
};
const fails = code => error => error instanceof AiError && error.code === code;
function fullImportService(responseForCall) {
  const { svc, calls } = fixtureService(responseForCall), events = [];
  svc.requirePrivilege = async () => {};
  svc.assertJob = async () => ({ id: 1 });
  svc.checkpoint = async job => { events.push({ kind: 'checkpoint', state: structuredClone(job.state) }); };
  svc.installAttachment = async () => { events.push({ kind: 'attachment' }); };
  svc.problems = {
    userHasCreateProblemPermission: async () => true,
    createProblem: async (_user, _type, value, _tags, onCreated) => {
      events.push({ kind: 'create', statement: structuredClone(value) });
      await onCreated({ id: 15 }, {
        findOneBy: async () => ({ judgeInfo: { timeLimit: 1000, memoryLimit: 256, fileIo: null } }),
        update: async (entity, where, patch) => {
          events.push({ kind: entity === ProblemJudgeInfoEntity ? 'judge' : entity === AiJobEntity ? 'job' : 'other', where, patch });
          return { affected: 1 };
        }
      });
      return { id: 15 };
    }
  };
  return { svc, calls, events };
}

test('plain Markdown ignores guessed metadata and attachment sample basenames without changing the statement', async () => {
  const { svc, calls } = fixtureService(() => { throw new Error('Unexpected model request'); });
  const job = fixtureJob({ markdown: 'Read an integer and print it.', attachmentToken: 'synthetic-attachment' });
  job.state.attachmentContext = { files: [{ filename: 'sample.in' }, { filename: 'sample.out' }] };
  const statement = fixtureStatement(), original = structuredClone(statement);
  assert.equal(await svc.resolveImportedFileIo(job, {}, statement), null);
  assert.equal(calls.length, 0);
  assert.deepEqual(statement, original);
  assert.deepEqual(job.state.importIoVerification, { kind: 'unspecified', fileIo: null });
});

test('explicit fileio sets authoritative task metadata and never appends adaptation prose', async () => {
  for (const [hint, expected] of [['fileio: custom', { inputFilename: 'custom.in', outputFilename: 'custom.out' }], ['fileio: stdio', null]]) {
    const { svc, calls } = fixtureService(() => { throw new Error('No OCR needed for explicit user input'); });
    const job = fixtureJob({ image: 'synthetic-image', markdown: hint });
    const statement = fixtureStatement('en_US', 'Input file: task.in\nOutput file: task.out'), original = structuredClone(statement);
    assert.deepEqual(await svc.resolveImportedFileIo(job, {}, statement), expected);
    assert.deepEqual(job.state.importIoVerification, { kind: expected ? 'named' : 'standard', fileIo: expected, source: 'user' });
    assert.deepEqual(statement, original);
    assert.equal(calls.length, 0);
  }
  await assert.rejects(fixtureService(null).svc.resolveImportedFileIo(fixtureJob({ markdown: 'fileio: ../escape' }), {}, fixtureStatement()), fails('INVALID_AI_FILE_IO'));
});

test('Filename badge in user notes maps to .in/.out without becoming statement content', async () => {
  const { svc, calls } = fixtureService(() => { throw new Error('Metadata badge is already explicit'); });
  const job = fixtureJob({ markdown: 'Filename: message', image: 'synthetic-image' });
  const statement = fixtureStatement(), original = structuredClone(statement);
  const expected = { inputFilename: 'message.in', outputFilename: 'message.out' };
  assert.deepEqual(await svc.resolveImportedFileIo(job, {}, statement), expected);
  assert.deepEqual(job.state.importIoVerification, { kind: 'named', fileIo: expected, source: 'user' });
  assert.deepEqual(statement, original);
  assert.equal(calls.length, 0);
});

test('readable legacy declarations are used without a redundant image call or statement mutation', async () => {
  for (const [body, expected] of [[namedEvidence, files], ['使用标准输入和标准输出。', null]]) {
    const { svc, calls } = fixtureService(() => { throw new Error('Already explicit'); });
    const job = fixtureJob({ image: 'synthetic-image' }), statement = fixtureStatement('zh_CN', body), original = structuredClone(statement);
    assert.deepEqual(await svc.resolveImportedFileIo(job, {}, statement), expected);
    assert.deepEqual(statement, original);
    assert.equal(calls.length, 0);
  }
});

test('weak image prose triggers metadata-only OCR; unspecified does not fabricate a field', async () => {
  const { svc, calls } = fixtureService({ kind: 'unspecified', fileIo: null, evidence: '' });
  const job = fixtureJob({ image: 'synthetic-original-image', markdown: 'Time limit: 2 seconds' });
  job.state.attachmentContext = { files: [{ filename: 'secret-archive-example.in' }] };
  const statement = fixtureStatement(), original = structuredClone(statement);
  assert.equal(await svc.resolveImportedFileIo(job, {}, statement), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], job.input.image);
  assert.match(calls[0][1], /original problem image.*file-I\/O metadata/);
  assert(!calls[0][1].includes('secret-archive-example.in'));
  assert.deepEqual(job.state.importIoVerification, { kind: 'unspecified', fileIo: null });
  assert.deepEqual(statement, original);
});

test('verified named OCR evidence stays exclusively in durable task metadata in either locale', async () => {
  for (const locale of ['zh_CN', 'en_US']) {
    const { svc } = fixtureService({ kind: 'named', fileIo: files, evidence: namedEvidence });
    const job = fixtureJob({ image: 'synthetic-image' }), statement = fixtureStatement(locale), original = structuredClone(statement);
    assert.deepEqual(await svc.resolveImportedFileIo(job, {}, statement), files);
    assert.deepEqual(job.state.importIoVerification, { kind: 'named', fileIo: files, evidence: namedEvidence });
    assert.deepEqual(statement, original, 'No new IO section and no evidence appended to existing text');
  }
});

test('verified standard IO evidence is saved without rewriting any statement field', async () => {
  const evidence = 'Read from standard input and write to standard output.';
  const { svc } = fixtureService({ kind: 'standard', fileIo: null, evidence });
  const job = fixtureJob({ image: 'synthetic-image' }), statement = fixtureStatement(), original = structuredClone(statement);
  assert.equal(await svc.resolveImportedFileIo(job, {}, statement), null);
  assert.deepEqual(job.state.importIoVerification, { kind: 'standard', fileIo: null, evidence });
  assert.deepEqual(statement, original);
});

test('Filename evidence from extraction is corroborated without a second OCR request', async () => {
  const expected = { inputFilename: 'message.in', outputFilename: 'message.out' };
  const { svc, calls } = fixtureService(() => { throw new Error('No extra OCR is needed'); });
  const statement = fixtureStatement(), original = structuredClone(statement), job = fixtureJob({ image: 'synthetic-image' });
  assert.deepEqual(await svc.resolveImportedFileIo(job, {}, statement, { judgeInfo: { fileIo: expected, fileIoEvidence: 'Filename: message' } }), expected);
  assert.deepEqual(job.state.importIoVerification, { kind: 'named', fileIo: expected, evidence: 'Filename: message' });
  assert.deepEqual(statement, original);
  assert.equal(calls.length, 0);
  await assert.rejects(svc.resolveImportedFileIo(fixtureJob({ image: 'synthetic-image' }), {}, statement, { judgeInfo: { fileIo: files, fileIoEvidence: 'Filename: message' } }), fails('UNVERIFIED_AI_FILE_IO'));
});

test('unsafe paths, mismatched proposals and sample-only evidence remain rejected without mutation', async () => {
  for (const [response, code] of [
    [{ kind: 'named', fileIo: { inputFilename: '../task.in', outputFilename: 'task.out' }, evidence: namedEvidence }, 'INVALID_AI_FILE_IO'],
    [{ kind: 'named', fileIo: { inputFilename: 'wrong.in', outputFilename: 'task.out' }, evidence: namedEvidence }, 'UNVERIFIED_AI_FILE_IO'],
    [{ kind: 'named', fileIo: files, evidence: '输入文件：../task.in\n输出文件：task.out' }, 'INVALID_AI_FILE_IO'],
    [{ kind: 'named', fileIo: files, evidence: 'Sample input file: task.in\nSample output file: task.out' }, 'UNVERIFIED_AI_FILE_IO'],
    [{ kind: 'named', fileIo: files, evidence: 'The input file contains an integer. The output file contains the answer.' }, 'UNVERIFIED_AI_FILE_IO'],
    [{ kind: 'standard', fileIo: null, evidence: namedEvidence }, 'UNVERIFIED_AI_FILE_IO']
  ]) {
    const { svc } = fixtureService(response), statement = fixtureStatement(), original = structuredClone(statement);
    await assert.rejects(svc.resolveImportedFileIo(fixtureJob({ image: 'synthetic-image' }), {}, statement), fails(code));
    assert.deepEqual(statement, original);
  }
});

test('invalid OCR response shapes fail predictably', async () => {
  for (const response of [null, {}, [], { kind: 'guessed', evidence: '' }, { kind: 'named', evidence: 42 }, { kind: 'named', evidence: 'x'.repeat(4001) }])
    await assert.rejects(fixtureService(response).svc.resolveImportedFileIo(fixtureJob({ image: 'synthetic-image' }), {}, fixtureStatement()), fails('UNVERIFIED_AI_FILE_IO'));
});

test('unspecified second OCR cannot silently accept conflicting original declarations', async () => {
  const { svc } = fixtureService({ kind: 'unspecified', fileIo: null, evidence: '' });
  const statement = fixtureStatement('zh_CN', '输入文件：a.in\n输出文件：a.out\n输入文件：b.in');
  await assert.rejects(svc.resolveImportedFileIo(fixtureJob({ image: 'synthetic-image' }), {}, statement), fails('UNVERIFIED_AI_FILE_IO'));
});

test('retry clears unpublished OCR but preserves a committed problem and unrelated artifacts', () => {
  const { svc } = fixtureService(null);
  const state = { completed: [], importStatement: fixtureStatement(), importIoVerification: { kind: 'named', fileIo: files }, attachmentInstalled: true, discussionIds: { zh_CN: 4, en_US: 5 } };
  const job = { ...fixtureJob(), state, error: 'UNVERIFIED_AI_FILE_IO' }, retried = svc.retryState(job);
  assert.equal(retried.importStatement, undefined);
  assert.equal(retried.importIoVerification, undefined);
  assert.deepEqual(retried.discussionIds, state.discussionIds);
  assert(state.importStatement, 'Loaded checkpoint is immutable');
  const committed = svc.retryState({ ...job, problemId: 8 });
  assert.equal(committed.importStatement, state.importStatement);
  assert.equal(committed.importIoVerification, state.importIoVerification);
  assert.equal(committed.attachmentInstalled, true);
});

test('full legacy image import persists IO in judge settings and state without adding any editor column', async () => {
  const { svc, calls, events } = fullImportService((_config, prompt) => prompt.startsWith('Extract this programming problem') ? fixtureStatement() : { kind: 'named', fileIo: files, evidence: namedEvidence });
  const job = fixtureJob({ image: 'synthetic-image', attachmentToken: 'synthetic-attachment' });
  await svc.importProblem(job, { id: 1 }, {});
  assert.equal(calls.length, 2);
  assert.equal(job.problemId, 15);
  assert.deepEqual(events.find(event => event.kind === 'judge').patch.judgeInfo.fileIo, files);
  assert.equal(events.find(event => event.kind === 'job').patch.problemId, 15);
  assert.deepEqual(job.state.importStatement.judgeInfo.fileIo, files);
  assert.equal(job.state.importIoVerification.evidence, namedEvidence);
  const created = events.find(event => event.kind === 'create').statement.localizedContents[0];
  assert.deepEqual(created.contentSections.map(section => section.sectionTitle), ['题目描述', '输入格式', '输出格式', '数据范围与提示']);
  assert(!JSON.stringify(created).includes(namedEvidence));
  assert.equal(events.at(-1).kind, 'attachment');
});

test('fixed fields create the exact original preset layout while tags/time/memory/Filename remain metadata', async () => {
  for (const locale of ['zh_CN', 'en_US']) {
    const expected = { inputFilename: 'message.in', outputFilename: 'message.out' };
    const response = { localizedContents: [{ locale, title: '发消息', description: '传播消息并计算答案。', input: '第一行 n。', output: '输出答案。', limitsAndHints: 'n<=100000。\n\n样例解释：共有3种方案。' }], samples: [{ inputData: '3\n', outputData: '3\n' }], sourceTags: ['DP', '', 42], judgeInfo: { timeLimit: 2000, memoryLimit: 512, fileIo: expected, fileIoEvidence: 'Filename: message' } };
    const original = structuredClone(response), { svc, calls, events } = fullImportService(response), job = fixtureJob({ image: 'synthetic-image' });
    await svc.importProblem(job, { id: 1 }, {});
    assert.equal(calls.length, 1);
    const created = events.find(event => event.kind === 'create').statement;
    const names = locale === 'zh_CN' ? ['题目描述', '输入格式', '输出格式', '样例', '数据范围与提示'] : ['Description', 'Input', 'Output', 'Sample', 'Limits And Hints'];
    assert.deepEqual(created.localizedContents[0].contentSections.map(section => section.sectionTitle), names);
    assert.deepEqual(created.localizedContents[0].contentSections.map(section => section.type), ['Text', 'Text', 'Text', 'Sample', 'Text']);
    assert.equal(created.localizedContents[0].contentSections[3].sampleId, 0);
    assert.match(created.localizedContents[0].contentSections[4].text, /样例解释/);
    assert.deepEqual(created.samples, response.samples);
    assert.deepEqual(created.problemTagIds, []);
    assert(!JSON.stringify(created.localizedContents).match(/DP|Filename|2000|512|message\.(?:in|out)/));
    assert.deepEqual(job.state.importSourceTags, ['DP']);
    const judge = events.find(event => event.kind === 'judge').patch.judgeInfo;
    assert.equal(judge.timeLimit, 2000); assert.equal(judge.memoryLimit, 512); assert.deepEqual(judge.fileIo, expected);
    assert.equal(job.state.importIoVerification.evidence, 'Filename: message');
    assert.deepEqual(response, original, 'The model response is not rewritten in place');
  }
});

test('retry after failed evidence performs fresh extraction before creating a problem', async () => {
  let attempt = 0;
  const { svc, calls, events } = fullImportService((_config, prompt) => {
    if (prompt.startsWith('Extract this programming problem')) { attempt++; return fixtureStatement(); }
    return { kind: 'named', fileIo: attempt === 1 ? { inputFilename: 'wrong.in', outputFilename: 'wrong.out' } : files, evidence: namedEvidence };
  });
  const job = fixtureJob({ image: 'synthetic-image' });
  await assert.rejects(svc.importProblem(job, { id: 1 }, {}), fails('UNVERIFIED_AI_FILE_IO'));
  assert(!events.some(event => event.kind === 'create'));
  job.error = 'UNVERIFIED_AI_FILE_IO'; job.state = svc.retryState(job);
  await svc.importProblem(job, { id: 1 }, {});
  assert.equal(attempt, 2); assert.equal(calls.length, 4); assert.equal(job.problemId, 15);
  assert.equal(events.filter(event => event.kind === 'create').length, 1);
});

test('own null judge setting remains authoritative without visible adaptations in either language', async () => {
  const { svc, calls } = fixtureService(() => { throw new Error('Explicit stdio must not call the model'); });
  const statement = fixtureStatement('zh_CN', namedEvidence);
  statement.localizedContents.push(fixtureStatement('en_US', 'Input file: task.in\nOutput file: task.out').localizedContents[0]);
  const original = structuredClone(statement), job = fixtureJob({ markdown: 'fileio: stdio', image: 'synthetic-image' });
  assert.equal(await svc.resolveImportedFileIo(job, {}, statement), null);
  assert.equal(resolveAiFileIo({ fileIo: null }, statement.localizedContents), null);
  for (const content of statement.localizedContents) assert.equal(resolveAiFileIo({ fileIo: null }, [content]), null);
  assert.deepEqual(statement, original);
  assert.deepEqual(job.state.importIoVerification, { kind: 'standard', fileIo: null, source: 'user' });
  assert.equal(calls.length, 0);
});

test('saved verified metadata survives a checkpoint restore without another OCR or any statement mutation', async () => {
  const { svc, calls } = fixtureService(() => { throw new Error('Use the saved verification'); });
  const job = fixtureJob({ image: 'synthetic-image' });
  job.state.importIoVerification = { kind: 'standard', fileIo: null, evidence: 'Input: standard input\nOutput: standard output' };
  const statement = fixtureStatement('zh_CN', namedEvidence), original = structuredClone(statement);
  assert.equal(await svc.resolveImportedFileIo(job, {}, statement), null);
  assert.equal(await svc.resolveImportedFileIo(job, {}, statement), null);
  assert.deepEqual(statement, original); assert.equal(calls.length, 0);
});

// Redundant model metadata must not override a deterministically parsed badge.
test('valid Filename evidence survives alternate model fileIo shape, without accepting guessed fields', async () => {
  for (const proposed of ['message', {input:'message.in',output:'message.out'}, {}]) {
    const {svc,calls}=fixtureService(() => { throw new Error('Valid badge needs no OCR retry'); });
    const job=fixtureJob({image:'synthetic-image'}), statement=fixtureStatement();
    assert.deepEqual(await svc.resolveImportedFileIo(job,{},statement,{judgeInfo:{fileIo:proposed,fileIoEvidence:'Filename: message'}}), {inputFilename:'message.in',outputFilename:'message.out'});
    assert.equal(calls.length,0);
  }
});

test('plain Markdown cannot acquire named IO from model-invented evidence or legacy extracted sections', async () => {
  for (const extracted of [
    { judgeInfo: { fileIo: files, fileIoEvidence: 'Filename: task' } },
    { judgeInfo: { fileIo: files, fileIoEvidence: namedEvidence } },
    { judgeInfo: { fileIo: files }, localizedContents: fixtureStatement('zh_CN', namedEvidence).localizedContents }
  ]) {
    const { svc, calls } = fixtureService(() => { throw new Error('Markdown has no original image to verify'); });
    const job = fixtureJob({ markdown: '# Problem\nRead an integer and print twice its value.\nThe input file contains one integer.', attachmentToken: 'synthetic-attachment' });
    const statement = fixtureStatement(), before = structuredClone(statement);
    assert.equal(await svc.resolveImportedFileIo(job, {}, statement, extracted), null);
    assert.equal(job.state.importIoVerification.kind, 'unspecified');
    assert.equal(job.state.importIoVerification.fileIo, null);
    assert.equal(calls.length, 0);
    assert.deepEqual(statement, before);
  }
});


test('explicit image OCR standard input/output wording is independently corroborated without named IO', async () => {
  const { svc, calls } = fixtureService({ kind: 'standard', fileIo: null, evidence: 'Standard input/output.' });
  const job = fixtureJob({ image: 'data:image/png;base64,c3ludGhldGlj' });
  const statement = fixtureStatement('en_US', 'Read two integers and print their sum.');
  assert.equal(await svc.resolveImportedFileIo(job, {}, statement), null);
  assert.equal(job.state.importIoVerification.kind, 'standard');
  assert.equal(calls.length, 1);
});


test('original Markdown read/write filenames stay authoritative without model-invented IO evidence', async () => {
  const { svc, calls } = fixtureService(() => { throw new Error('Plain Markdown must need no OCR'); });
  const job = fixtureJob({ markdown: 'Read input.txt and write output.txt (required file input/output).' });
  const statement = fixtureStatement('en_US', 'Sum the integers.');
  assert.deepEqual(await svc.resolveImportedFileIo(job, {}, statement, { judgeInfo: { fileIo: null } }), { inputFilename: 'input.txt', outputFilename: 'output.txt' });
  assert.equal(calls.length, 0);
  assert.equal(job.state.importIoVerification.source, 'user');
});


const atCoderInputEvidence = 'The input is given from Standard Input in the following format:';
const countSortedArraysStatement = () => ({
  problemType: 'Traditional',
  localizedContents: [{
    locale: 'en_US', title: 'F - Count Sorted Arrays',
    description: 'Initially, you have all N! permutations. For each operation, count the permutations already sorted in ascending order.',
    input: `${atCoderInputEvidence}\n\nN M\nx_1 y_1\n...\nx_M y_M`,
    output: 'Print M lines. The i-th line should contain S_i.',
    limitsAndHints: '2 <= N <= 15; 1 <= M <= 500000.'
  }],
  samples: [{ inputData: '2 1\n1 1\n', outputData: '2\n' }],
  judgeInfo: { timeLimit: 2000, memoryLimit: 1024, fileIo: null, fileIoEvidence: atCoderInputEvidence }
});

test('AtCoder Standard Input evidence in the initial image extraction imports without a redundant OCR request', async () => {
  const response = countSortedArraysStatement(), before = structuredClone(response);
  const { svc, calls, events } = fullImportService((_config, prompt) => {
    assert(prompt.startsWith('Extract this programming problem'), 'The original exact quotation is sufficient evidence');
    return response;
  });
  const job = fixtureJob({ image: 'synthetic-count-sorted-arrays-image' });
  await svc.importProblem(job, { id: 1 }, {});
  assert.equal(calls.length, 1);
  assert.equal(job.problemId, 15);
  assert.deepEqual(job.state.importIoVerification, { kind: 'standard', fileIo: null, evidence: atCoderInputEvidence });
  const judgeInfo = events.find(event => event.kind === 'judge').patch.judgeInfo;
  assert.equal(judgeInfo.fileIo, null);
  assert.equal(judgeInfo.timeLimit, 2000);
  assert.equal(judgeInfo.memoryLimit, 1024);
  assert.deepEqual(events.find(event => event.kind === 'create').statement.samples, response.samples);
  assert.deepEqual(response, before);
});

test('AtCoder fixed input/output fields corroborate standard IO when metadata quotation is absent', async () => {
  const response = countSortedArraysStatement();
  response.judgeInfo.fileIoEvidence = '';
  const { svc, calls, events } = fullImportService((_config, prompt) => {
    assert(prompt.startsWith('Extract this programming problem'), 'Canonical editor input retains the explicit Standard Input declaration');
    return response;
  });
  const job = fixtureJob({ image: 'synthetic-count-sorted-arrays-image' });
  await svc.importProblem(job, { id: 1 }, {});
  assert.equal(calls.length, 1);
  assert.equal(job.problemId, 15);
  assert.deepEqual(job.state.importIoVerification, { kind: 'standard', fileIo: null });
  assert.equal(events.find(event => event.kind === 'judge').patch.judgeInfo.fileIo, null);
});

test('metadata-only second OCR accepts AtCoder Standard Input and output-only standard quotations', async () => {
  for (const evidence of [atCoderInputEvidence, 'Print the answer to standard output.']) {
    const { svc, calls } = fixtureService({ kind: 'standard', fileIo: null, evidence });
    const job = fixtureJob({ image: 'synthetic-count-sorted-arrays-image' });
    const statement = fixtureStatement('en_US', 'Read N and M. Print M lines.');
    assert.equal(await svc.resolveImportedFileIo(job, {}, statement, { judgeInfo: { fileIo: null } }), null);
    assert.equal(calls.length, 1);
    assert.deepEqual(job.state.importIoVerification, { kind: 'standard', fileIo: null, evidence });
  }
});

test('image OCR still rejects standard claims backed only by negated, sample, or mixed file evidence', async () => {
  for (const evidence of [
    'Do not use standard input.', 'Sample uses standard output.',
    `${atCoderInputEvidence}\nOutput file: answer.out`,
    'Input file: task.in\nWrite to standard output.'
  ]) {
    const { svc } = fixtureService({ kind: 'standard', fileIo: null, evidence });
    const job = fixtureJob({ image: 'synthetic-image' }), statement = fixtureStatement('en_US', 'Read N. Print the answer.');
    await assert.rejects(svc.resolveImportedFileIo(job, {}, statement), fails('UNVERIFIED_AI_FILE_IO'), evidence);
    assert.equal(job.state.importIoVerification, undefined);
  }
});

test('retry of an unpublished AtCoder IO rejection re-extracts and creates exactly one standard IO problem', async () => {
  const response = countSortedArraysStatement();
  const { svc, calls, events } = fullImportService((_config, prompt) => {
    assert(prompt.startsWith('Extract this programming problem'));
    return response;
  });
  const job = fixtureJob({ image: 'synthetic-count-sorted-arrays-image' });
  job.error = 'UNVERIFIED_AI_FILE_IO';
  job.state.importStatement = fixtureStatement();
  job.state.importIoVerification = { kind: 'named', fileIo: files };
  job.state = svc.retryState(job);
  await svc.importProblem(job, { id: 1 }, {});
  assert.equal(calls.length, 1);
  assert.equal(job.problemId, 15);
  assert.equal(events.filter(event => event.kind === 'create').length, 1);
  assert.equal(events.find(event => event.kind === 'judge').patch.judgeInfo.fileIo, null);
  assert.equal(job.state.importIoVerification.kind, 'standard');
});
