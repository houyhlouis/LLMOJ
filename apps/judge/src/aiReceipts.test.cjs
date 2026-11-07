const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, f);
const { AiReceipts, receiptKey } = require('./aiReceipts.ts');
const runtime = { judgeProgram: 'a'.repeat(64), sandboxImage: 'synthetic', arch: 'x64' };
const base = { kind: 'execution', build: 'b'.repeat(64), input: 'c'.repeat(64), arguments: [], profile: { time: 1000 }, runtime, policy: 'v9' };
test('receipts invalidate exactly their source, input, arguments, runtime, profile, checker and policy dependencies', () => {
  for (const over of [{ build: 'alt-v2' }, { input: 'other' }, { arguments: ['2'] }, { profile: { time: 900 } }, { runtime: { ...runtime, sandboxImage: 'new' } }, { policy: 'v10' }])
    assert.notEqual(receiptKey(base), receiptKey({ ...base, ...over }));
  const comparison = { ...base, kind: 'comparison', build: 'checker-v1', actual: 'answer1', expected: 'answer2' };
  assert.notEqual(receiptKey(comparison), receiptKey({ ...comparison, build: 'checker-v2' }));
  assert.notEqual(receiptKey(comparison), receiptKey({ ...comparison, actual: 'changed-alt-output' }));
  const legality = { ...base, kind: 'legality', build: 'validator-v1' };
  assert.notEqual(receiptKey(legality), receiptKey({ ...legality, build: 'validator-v2' }));
  assert.equal(receiptKey(base), receiptKey({ ...base }), 'unrelated alternative changes do not affect standard outputs');
});
test('durable receipts reuse successful outputs with labelled timing; confirmations stay fresh and failures are not kept', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoj-receipts-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = '11111111-1111-4111-8111-111111111111';
  let executions = 0;
  const run = async () => { executions++; return { output: Buffer.from('42'), measure: { timeMs: 3, memoryBytes: 40, status: 'OK', exitCode: 0 } }; };
  const first = new AiReceipts(root, job);
  assert.equal((await first.run(base, false, run)).timing, 'fresh');
  const resumed = new AiReceipts(root, job);
  assert.equal((await resumed.run(base, false, run)).timing, 'reused');
  assert.equal(executions, 1); assert.equal(resumed.counts.reusedTiming, 1);
  assert.equal((await resumed.run(base, true, run)).timing, 'fresh'); assert.equal(executions, 2);
  const failure = { ...base, input: 'fails' };
  for (let n = 0; n < 2; n++) await assert.rejects(resumed.run(failure, false, async () => { throw new Error('TLE'); }), /TLE/);
  assert.equal(fs.existsSync(path.join(root, 'ai-receipts', job, receiptKey(failure))), false);
});

test('receipt reuse requires the advertised receipt and quality-policy versions', async t => {
  const protocol = require('@libreoj/judge-protocol');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmoj-receipt-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = '22222222-2222-4222-8222-222222222222';
  const file = path.join(root, 'ai-receipts', job, receiptKey(base));
  const run = async () => ({ output: Buffer.from('synthetic') });
  await new AiReceipts(root, job).run(base, false, run);
  const receipt = JSON.parse(fs.readFileSync(file));
  assert.equal(receipt.version, protocol.AI_RECEIPT_VERSION);
  assert.equal(receipt.qualityPolicy, protocol.AI_QUALITY_POLICY_VERSION);
  for (const field of ['version', 'qualityPolicy']) {
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify({ ...receipt, [field]: 999 }));
    assert.equal((await new AiReceipts(root, job).run(base, false, run)).timing, 'fresh');
  }
});
