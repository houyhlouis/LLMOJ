/* AI-only template mapping regression; no DB, network, provider, runner or production data. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText, filename);
const { canonicalizeAiEditorStatement: canonical } = require('./ai-editor-template.ts');
const sample = { inputData: '7\n', outputData: '6\n' };
const text = (sectionTitle, value) => ({ type: 'Text', sectionTitle, text: value });
const fixed = (locale = 'en_US', overrides = {}) => ({ locale, title: 'Fixture', description: 'Task', input: 'Read n.', output: 'Print x.', limitsAndHints: '1 <= n <= 10', ...overrides });
const legacy = (locale, contentSections) => ({ locale, title: 'Fixture', contentSections });
const statement = (content, samples = [sample]) => ({ localizedContents: [content], samples });
const sections = value => value.localizedContents[0].contentSections;
const byTitle = (value, title) => sections(value).find(item => item.sectionTitle === title);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const frontend = fs.readFileSync(path.resolve(__dirname, '../../../../packages/frontend/src/pages/problem/edit/defaultSections.ts'), 'utf8');
const presetTitles = [...frontend.matchAll(/sectionTitle: "([^"]+)"/g)].map(match => match[1]);

test('fixed AI fields reproduce both actual manual-editor preset labels and ordering', () => {
  for (const [locale, expected] of [['zh_CN', presetTitles.slice(0, 5)], ['en_US', presetTitles.slice(5, 10)]]) {
    const result = canonical(statement(fixed(locale)));
    assert.deepEqual(sections(result).map(section => section.sectionTitle), expected);
    assert.deepEqual(sections(result).map(section => section.type), ['Text', 'Text', 'Text', 'Sample', 'Text']);
    assert.equal(sections(result)[3].sampleId, 0);
  }
  assert.equal(presetTitles[9], 'Limits And Hints', 'Case must match the original template exactly');
});

test('no samples creates no fake Sample section while retaining four editable empty Text presets', () => {
  const result = canonical(statement(fixed('en_US', { description: '', input: '', output: '', limitsAndHints: '' }), []));
  assert.deepEqual(sections(result).map(section => section.sectionTitle), ['Description', 'Input', 'Output', 'Limits And Hints']);
  assert(sections(result).every(section => section.type === 'Text' && section.text === ''));
  assert.deepEqual(result.samples, []);
});

test('shared samples keep exact bytes and get sequential references between Output and Limits And Hints', () => {
  const samples = [{ inputData: '  a\r\n\n', outputData: '\\(raw output\\)\t\n' }, sample];
  const result = canonical({ localizedContents: [fixed('zh_CN'), fixed('en_US')], samples });
  assert.deepEqual(result.samples, samples);
  for (const content of result.localizedContents) {
    assert.deepEqual(content.contentSections.map(section => section.type), ['Text', 'Text', 'Text', 'Sample', 'Sample', 'Text']);
    assert.deepEqual(content.contentSections.filter(section => section.type === 'Sample').map(section => section.sampleId), [0, 1]);
  }
  assert.deepEqual(result.localizedContents[1].contentSections.slice(3, 5).map(section => section.sectionTitle), ['Sample 1', 'Sample 2']);
});

test('legacy aliases, reordered content, background and subtasks map without creating extra editor sections', () => {
  const result = canonical(statement(legacy('zh_CN', [
    text('输出说明', '输出最短距离。'), text('题目背景', '朋友们之间相互发消息。'),
    text('【题目描述】', '有 n 个人。'), text('1. 输入格式', '第一行 n,m。'),
    text('子任务', '| 分值 | 范围 |\n|30|n<=100|'), text('数据范围和提示', 'n<=100000。'),
    text('通信规则', '消息仅沿有向边传播。')
  ])));
  assert.deepEqual(sections(result).map(section => section.sectionTitle), presetTitles.slice(0, 5));
  assert.match(byTitle(result, '题目描述').text, /朋友们之间相互发消息。/);
  assert.match(byTitle(result, '题目描述').text, /有 n 个人。/);
  assert.equal(byTitle(result, '输入格式').text, '第一行 n,m。');
  assert.equal(byTitle(result, '输出格式').text, '输出最短距离。');
  const hints = byTitle(result, '数据范围与提示').text;
  for (const phrase of ['子任务', '30', 'n<=100000。', '通信规则', '消息仅沿有向边传播。']) assert(hints.includes(phrase));
});

test('dedicated metadata/tag/source sections are excluded rather than merged into Description or Hints', () => {
  const metadata = ['Tags', '题目标签', 'Time Limit', 'Memory Limit', 'Input file', 'Output Filename', '输入输出方式', '输入输出文件', 'I/O', 'Metadata', 'Source', '难度'];
  const result = canonical(statement(legacy('en_US', [text('Description', 'Effective task.'), ...metadata.map((title, i) => text(title, /^(?:Input file|Output Filename|输入输出方式|输入输出文件|I\/O)$/.test(title) ? "message.in\nmessage.out" : `metadata-${i}`)), text('Input', 'Read the first line of the input file.'), text('Output', 'Print a number.')] )));
  assert.equal(sections(result).filter(section => section.type === 'Text').length, 4);
  assert(!JSON.stringify(result).includes('metadata-'));
  assert.equal(byTitle(result, 'Description').text, 'Effective task.');
  assert.equal(byTitle(result, 'Input').text, 'Read the first line of the input file.', 'Valid input-format prose must not be removed by keyword matching');
});

test('legacy sample explanation Text and Sample sections move to the final preset field', () => {
  const result = canonical(statement(legacy('en_US', [
    text('Sample Explanation', '0 and 6 are both valid.'),
    { type: 'Sample', sectionTitle: 'Example input/output', sampleId: 0, text: 'The checker accepts any even answer.' },
    text('Constraints', 'n >= 1.')
  ])));
  assert.equal(sections(result)[3].sectionTitle, 'Sample');
  assert.equal(sections(result)[3].text, '');
  const hints = byTitle(result, 'Limits And Hints').text;
  assert.match(hints, /0 and 6 are both valid/);
  assert.match(hints, /The checker accepts any even answer/);
  assert.match(hints, /n >= 1/);
});

test('empty legacy sample placeholders do not invent samples or disrupt canonical order', () => {
  const result = canonical(statement(legacy('zh_CN', [{ type: 'Sample', sectionTitle: '样例', sampleId: 0, text: '' }]), []));
  assert.equal(sections(result).length, 4);
  assert(sections(result).every(section => section.type === 'Text'));
});

test('legacy repeated or unordered sample references become one ordered reference per real sample', () => {
  const ref = sampleId => ({ type: 'Sample', sectionTitle: 'Old sample label', sampleId, text: '' });
  const result = canonical(statement(legacy('en_US', [ref(1), text('Task', 'Task'), ref(1), ref(0)]), [sample, sample]));
  assert.deepEqual(sections(result).filter(section => section.type === 'Sample').map(section => section.sampleId), [0, 1]);
});

test('mixed fixed and legacy fields deduplicate exact prose while preserving extra meaningful notes', () => {
  const result = canonical(statement(fixed('en_US', { contentSections: [text('Problem Description', 'Task'), text('Guarantees', 'All endpoints exist.')] })));
  assert.equal(byTitle(result, 'Description').text, 'Task');
  assert.match(byTitle(result, 'Limits And Hints').text, /All endpoints exist/);
  assert.equal(sections(result).length, 5);
});

test('AI-only adapter is pure and idempotent, and strips metadata outside the statement contract', () => {
  const input = freeze({ ...statement(fixed()), judgeInfo: { timeLimit: 1000 }, problemTagIds: [9], arbitrary: 'ignored' });
  const result = canonical(input);
  assert.deepEqual(Object.keys(result).sort(), ['localizedContents', 'samples']);
  assert.deepEqual(canonical(result), result);
  assert.equal(input.judgeInfo.timeLimit, 1000);
  assert.equal(input.localizedContents[0].description, 'Task');
  assert.notEqual(result.samples[0], input.samples[0]);
});

test('math normalization applies to prose but preserves code blocks and sample bytes', () => {
  const result = canonical(statement(fixed('en_US', { description: 'Compute \\(n^2\\).\n\n```cpp\n// keep \\(n\\)\n```' })));
  assert.equal(byTitle(result, 'Description').text, 'Compute $n^2$.\n\n```cpp\n// keep \\(n\\)\n```');
  assert.deepEqual(result.samples[0], sample);
});

test('malformed locale/title/field/section values fail explicitly instead of becoming object strings', () => {
  for (const content of [fixed('ja_JP'), fixed('en_US', { title: '' }), fixed('en_US', { description: {} }), fixed('en_US', { input: null }), fixed('en_US', { contentSections: [{}] }), fixed('en_US', { contentSections: 'not an array' })]) {
    assert.throws(() => canonical(statement(content)), /INVALID_AI_STATEMENT/);
  }
  assert.throws(() => canonical({ localizedContents: [fixed(), fixed()], samples: [] }), /INVALID_AI_STATEMENT/);
});

test('malformed/oversized samples and explained references to nonexistent samples fail explicitly', () => {
  for (const samples of [null, Array(101).fill(sample), [{ inputData: 1, outputData: '2' }], [{ inputData: 'x'.repeat(1000001), outputData: '' }]])
    assert.throws(() => canonical(statement(fixed(), samples)), /INVALID_AI_SAMPLE/);
  assert.throws(() => canonical(statement(legacy('en_US', [{ type: 'Sample', sectionTitle: 'Sample', sampleId: 2, text: 'Explanation' }]))), /INVALID_AI_SAMPLE/);
});

test('merging cannot silently truncate explanations or exceed one editor-field limit', () => {
  assert.throws(() => canonical(statement(legacy('en_US', [text('Notes', 'a'.repeat(300000)), text('Hint', 'b'.repeat(300000))]))), /INVALID_AI_STATEMENT/);
});

test('ambiguous IO headings preserve real input/output rules rather than discarding them as metadata', () => {
  const rules = 'The first line contains n and m. Then m directed edges follow. Output -1 if no path exists.';
  for (const title of ['I/O', '输入输出方式', 'Input Output Method']) {
    const result = canonical(statement(legacy('en_US', [text('Description', 'Find the shortest path.'), text(title, rules)]), []));
    assert(JSON.stringify(result).includes(rules), title);
    assert.equal(sections(result).length, 4);
  }
  const result = canonical(statement(legacy('en_US', [text('Input file', 'The first line contains n and m.'), text('Output file', 'Print -1 if no solution exists.')] ), []));
  assert.equal(byTitle(result, 'Input').text, 'The first line contains n and m.');
  assert.equal(byTitle(result, 'Output').text, 'Print -1 if no solution exists.');
});

test('IO headings containing only concrete submission metadata remain outside the statement', () => {
  for (const value of ['message.in\nmessage.out', 'Input file: message.in\nOutput file: message.out', 'standard input and standard output', '标准输入和标准输出']) {
    const result = canonical(statement(legacy('en_US', [text('Description', 'Real task.'), text('I/O', value)]), []));
    assert.equal(sections(result).filter(item => item.type === 'Text' && item.text).length, 1, value);
  }
});
