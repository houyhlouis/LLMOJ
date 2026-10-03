/* Original-page metadata parsing only. No database, images, network or provider credentials. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText, filename);
const { detectImportFileIoEvidence } = require('./ai-import-metadata.ts');
const { AiError } = require('./ai.types.ts');
const named = base => ({ kind: 'named', fileIo: { inputFilename: `${base}.in`, outputFilename: `${base}.out` } });
const unspecified = { kind: 'unspecified', fileIo: null };

test('whole-line Filename badges identify the common basename in supported spelling and markup', () => {
  for (const text of ['Filename: message', 'File name = message', '文件名：message', '**Filename: message**', '**Filename**: `message`', 'FileIO: message', '  filename: data_01-test  ']) {
    assert.deepEqual(detectImportFileIoEvidence(text), named(text.includes('data_01-test') ? 'data_01-test' : 'message'));
  }
});

test('explicit standard-IO metadata remains distinguishable from an absent declaration', () => {
  for (const name of ['stdio', 'standard', 'none', 'null']) assert.deepEqual(detectImportFileIoEvidence(`Filename: ${name}`), { kind: 'standard', fileIo: null });
  assert.deepEqual(detectImportFileIoEvidence('Input: standard input\nOutput: standard output'), { kind: 'standard', fileIo: null });
  assert.deepEqual(detectImportFileIoEvidence(''), unspecified);
});

test('input and output declarations retain exact names instead of applying the basename convention', () => {
  assert.deepEqual(detectImportFileIoEvidence('输入文件：data_in.txt\n输出文件：data_out.txt'), { kind: 'named', fileIo: { inputFilename: 'data_in.txt', outputFilename: 'data_out.txt' } });
  assert.deepEqual(detectImportFileIoEvidence('Input file: message.in\nOutput file: message.out'), named('message'));
});

test('incidental filename mentions, downloaded samples, tags and resource limits never imply named IO', () => {
  for (const text of [
    'Tags: DP\nTime limit: 2000 ms\nMemory limit: 512 MiB',
    'The ZIP contains message1.in and message1.ans.',
    'Sample input file: message.in\nSample output file: message.out',
    'Use a filename: message for the attachment download.',
    'https://example.invalid/Filename:message',
    'Read n from the input file. Write the answer to the output file.',
    'Filename: message is only an example mentioned in this sentence.'
  ]) assert.deepEqual(detectImportFileIoEvidence(text), unspecified, text);
});

test('Filename text inside Markdown fences is code data, including longer/nested-looking fences', () => {
  for (const text of [
    '```text\nFilename: message\n```',
    '~~~text\nFilename: message\n~~~',
    '````text\n```\nFilename: message\n```\n````',
    '```text\nFilename: message'
  ]) assert.deepEqual(detectImportFileIoEvidence(text), unspecified);
  assert.deepEqual(detectImportFileIoEvidence('```text\nFilename: ignored\n```\nFilename: message'), named('message'));
});

test('unsafe whole-line basename values are rejected without deriving path-based judge files', () => {
  for (const base of ['../message', '/absolute', '.', '..', 'folder/message', 'folder\\message']) {
    assert.throws(() => detectImportFileIoEvidence(`Filename: ${base}`), error => error instanceof AiError && error.code === 'INVALID_AI_FILE_IO');
  }
});

test('conflicting basename or explicit filename declarations fail instead of selecting an arbitrary one', () => {
  for (const text of ['Filename: a\nFilename: b', 'Filename: message\nInput file: other.in\nOutput file: other.out']) {
    assert.throws(() => detectImportFileIoEvidence(text), /INVALID_AI_FILE_IO/);
  }
});

test('metadata detector rejects non-text and oversized evidence', () => {
  for (const value of [null, undefined, [], {}, 42, 'x'.repeat(1000001)]) assert.throws(() => detectImportFileIoEvidence(value), /INVALID_AI_FILE_IO/);
});

test('Filename badges under sample or attachment headings never become judging requirements', () => {
  for (const heading of ['## Sample attachment', '## Samples', '### 附件', '## 下载', '**Sample files**', '附件：']) {
    const evidence = `${heading}\nFilename: example\nThe archive contains local test data.`;
    assert.deepEqual(detectImportFileIoEvidence(evidence), unspecified, heading);
  }
  assert.deepEqual(detectImportFileIoEvidence('## Samples\n### Input\nFilename: example\nInput file: example.in\nOutput file: example.out'), unspecified);
});

test('a same-level or higher real metadata heading ends the sample-only context', () => {
  assert.deepEqual(detectImportFileIoEvidence('## Samples\nFilename: example\n### Extra local tests\nFilename: more\n## Judge Settings\nFilename: message'), named('message'));
  assert.deepEqual(detectImportFileIoEvidence('Filename: message\n## 附件\nFilename: sample'), named('message'));
  assert.deepEqual(detectImportFileIoEvidence('## 附件\nFilename: ../sample\n# Judge Settings\nFilename: message'), named('message'));
});
