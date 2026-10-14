const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require('reflect-metadata');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const { HackService, safeHackTargetResult } = require('./hack.service.ts');
const { HackEntity } = require('./hack.entity.ts');
const { ContestEntity } = require('../contest/contest.entity.ts');
const { UserEntity } = require('../user/user.entity.ts');

function fixture() {
  const hack = { id: 1, problemId: 7, submissionId: 11, hackerId: 2, submitterId: 3, status: 'Failed', taskId: null,
    inputData: 'SECRET INPUT', message: 'Safe judge message', timeUsed: 3, memoryUsed: 512,
    snapshot: { judgeInfo: { timeLimit: 1000, memoryLimit: 128 }, target: { code: 'SECRET SOURCE' },
      reference: { code: 'SECRET STD' }, targetResult: { executed: true, status: 'Accepted', score: 100,
        timeUsed: 3, memoryUsed: 512, output: 'SECRET ANSWER', checkerMessage: 'SECRET DIAGNOSTICS' } } };
  const contest = { endTime: new Date(Date.now() + 60000), rule: 'noi' };
  const service = Object.create(HackService.prototype);
  let manage = false, accessible = true;
  Object.assign(service, {
    db: { getRepository: entity => {
      if (entity === HackEntity) return { findOneBy: async () => hack, save: async value => value };
      if (entity === ContestEntity) return { findOneBy: async () => contest };
      assert.equal(entity, UserEntity);
      return { findByIds: async ids => ids.map(id => ({ id, username: 'user' + id })) };
    } },
    canView: async () => accessible,
    canConfigure: async () => manage,
    taskAuthorised: async () => true,
    locks: { lock: async (_key, callback) => callback() }, queue: { pushTask: async () => {} }
  });
  return { service, hack, contest, allowManage: () => manage = true, denyAccess: () => accessible = false };
}

test('Hack target feedback whitelists actual verdicts, bounded scores and resource numbers only', () => {
  assert.deepEqual(safeHackTargetResult({ executed: true, status: 'PartiallyCorrect', score: 37.5,
    timeUsed: 2.3, memoryUsed: 2048.5, userOutput: 'SECRET', checkerMessage: 'SECRET', standardCode: 'SECRET' }),
    { executed: true, status: 'PartiallyCorrect', score: 37.5, timeUsed: 3, memoryUsed: 2049 });
  assert.deepEqual(safeHackTargetResult({ executed: false, status: 'Accepted', score: 100, timeUsed: 1 }), { executed: false });
  for (const status of ['Hacked', 'Fake', 'Pending', 'ConfigurationError', 'invented'])
    assert.deepEqual(safeHackTargetResult({ executed: true, status, score: 100 }), { executed: true });
  for (const value of [null, 'SECRET', [], { status: 'Accepted' }]) assert.equal(safeHackTargetResult(value), undefined);
  for (const score of [NaN, Infinity, -1, 101, '100'])
    assert.deepEqual(safeHackTargetResult({ executed: true, status: 'Accepted', score }), { executed: true, status: 'Accepted' });
});

test('Hack detail exposes a single safe testcase and captured limits, never the private judging snapshot', async () => {
  const f = fixture(), response = await f.service.get({ id: 2 }, 1);
  assert.deepEqual(response.testcaseResult, { executed: true, status: 'Accepted', score: 100, timeUsed: 3, memoryUsed: 512 });
  assert.deepEqual(response.testcaseInfo, { timeLimit: 1000, memoryLimit: 128 });
  assert.doesNotMatch(JSON.stringify(response), /SECRET SOURCE|SECRET STD|SECRET ANSWER|SECRET DIAGNOSTICS|snapshot/);
  assert.equal(response.inputData, 'SECRET INPUT');
});

test('blind contest concealment applies to new testcase details as well as input and messages', async () => {
  const f = fixture(); f.hack.contestId = 8;
  const response = await f.service.get({ id: 3 }, 1);
  for (const key of ['inputData', 'message', 'testcaseResult', 'testcaseInfo']) assert.equal(response[key], undefined);
  assert.doesNotMatch(JSON.stringify(response), /SECRET/);
  assert.equal((await f.service.get({ id: 2 }, 1)).testcaseResult.status, 'Accepted');
  f.allowManage(); assert.equal((await f.service.get({ id: 3 }, 1)).testcaseResult.status, 'Accepted');
  f.denyAccess(); await assert.rejects(f.service.get({ id: 2 }, 1));
});

test('legacy records do not invent a target verdict or invalid resource limits', async () => {
  const f = fixture(); delete f.hack.snapshot.targetResult; f.hack.status = 'Success';
  f.hack.snapshot.judgeInfo = { timeLimit: Infinity, memoryLimit: -1 };
  const response = await f.service.get({ id: 2 }, 1);
  assert.equal(response.testcaseResult, undefined);
  assert.deepEqual(response.testcaseInfo, { timeLimit: undefined, memoryLimit: undefined });
  assert.equal(response.status, 'Success');
});

test('judge callbacks store only safe target metadata in the existing snapshot', async () => {
  const f = fixture(); f.hack.taskId = 'owned-task';
  const progress = { finished: true, status: 'Failed', targetExecuted: true, targetStatus: 'Accepted', targetScore: 100,
    timeUsed: 2.1, memoryUsed: 512, output: 'SECRET ANSWER', checkerMessage: 'SECRET DIAGNOSTICS' };
  assert.equal(await f.service.onTaskProgress('owned-task', progress), true);
  assert.deepEqual(f.hack.snapshot.targetResult, { executed: true, status: 'Accepted', score: 100, timeUsed: 3, memoryUsed: 512 });
  assert.equal(f.hack.snapshot.reference.code, 'SECRET STD');
  assert.doesNotMatch(JSON.stringify(f.hack.snapshot.targetResult), /SECRET/);
});

test('rejudging clears the previous testcase outcome and resources without changing trusted source snapshots', async () => {
  const f = fixture(); f.allowManage();
  await f.service.rejudge({ id: 2 }, 1);
  assert.equal(f.hack.status, 'Pending');
  assert.equal(f.hack.snapshot.targetResult, undefined);
  assert.equal(f.hack.timeUsed, null); assert.equal(f.hack.memoryUsed, null);
  assert.equal(f.hack.snapshot.reference.code, 'SECRET STD');
});
