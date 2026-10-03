const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const { AiService } = require('./ai.service.ts');
const { AiError } = require('./ai.types.ts');

function fixture(errorAt) {
  let attempts = 0, checks = 0, writes = 0;
  const service = new AiService({ transaction: async (isolation, run) => {
    assert.equal(isolation, 'SERIALIZABLE');
    const result = await run({});
    const error = errorAt(++attempts);
    if (error) throw error;
    return result;
  } });
  service.lockProblemCommit = async () => { checks++; return { problem: { id: 1 }, user: { id: 2 } }; };
  const run = () => service.commitProblem({}, {}, async () => { writes++; return 'committed'; });
  return { service, run, counts: () => ({ attempts, checks, writes }) };
}

test('a transient conflict retries the transaction and rechecks authorization', async () => {
  const f = fixture(attempt => attempt === 1 ? { driverError: { errno: 1213, code: 'ER_LOCK_DEADLOCK' } } : null);
  assert.equal(await f.run(), 'committed');
  assert.deepEqual(f.counts(), { attempts: 2, checks: 2, writes: 2 });
});

test('persistent conflicts have a finite retry budget', async () => {
  const error = { driverError: { sqlState: '40001' } }, f = fixture(() => error);
  await assert.rejects(f.run(), e => e === error);
  assert.equal(f.counts().attempts, 5);
});

test('permission and permanent database failures are never retried', async () => {
  for (const error of [new AiError('PERMISSION_DENIED'), { driverError: { code: 'ER_DUP_ENTRY', errno: 1062 } }]) {
    const f = fixture(() => error);
    await assert.rejects(f.run(), e => e === error);
    assert.equal(f.counts().attempts, 1);
  }
});
