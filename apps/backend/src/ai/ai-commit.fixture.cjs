/* In-memory transaction dependencies for provider/editorial tests. The product's
   commitProblem/lockProblemCommit/authorizeProblemCommit are never replaced;
   current permission/snapshot SQL behavior is covered by opt-in MariaDB tests. */
const assert = require('node:assert/strict');
const {ProblemEntity} = require('../problem/problem.entity.ts');
const {ProblemJudgeInfoEntity} = require('../problem/problem-judge-info.entity.ts');
const {AiJobEntity} = require('./ai.entity.ts');
const {UserEntity} = require('../user/user.entity.ts');
function commitFixture(service, job, problem, snapshot, update = async () => ({affected: 1})) {
  const locks = [];
  job.problemId = problem.id;
  job.id ||= 'fixture-job'; job.ownerId ||= 1; job.status ||= 'running'; job.action ||= 'metadata';
  const manager = {
    findOne: async (entity, options) => {
      locks.push(entity);
      if (entity === UserEntity) {assert.equal(options.lock.mode, 'pessimistic_read'); return {id: job.ownerId};}
      assert.equal(options.lock.mode, 'pessimistic_write');
      if (entity === AiJobEntity) {assert.equal(options.where.id, job.id); return {...job};}
      if (entity === ProblemEntity) {assert.equal(options.where.id, problem.id); return {...problem};}
      assert.equal(entity, ProblemJudgeInfoEntity);
      assert.equal(options.where.problemId, problem.id);
      return {problemId: problem.id, judgeInfo: snapshot.judgeInfo || {}};
    },
    update: async (entity, id, value) => {assert.equal(entity, ProblemEntity); return update(id, value);}
  };
  service.snapshot = async (current, transaction) => {
    assert.equal(transaction, manager);
    assert.equal(current.id, problem.id);
    return structuredClone(snapshot);
  };
  service.privileges ||= {};
  service.privileges.userHasPrivilege ||= async (_user, _privilege, transaction) => {assert.equal(transaction, manager); return true;};
  service.problems ||= {};
  service.problems.userHasPermission ||= async (_user, _problem, _permission, _fallback, transaction) => {assert.equal(transaction, manager); return true;};
  service.db = {transaction: async (isolation, run) => {
    assert.equal(isolation, 'SERIALIZABLE');
    const start = locks.length;
    const result = await run(manager);
    assert.deepEqual(locks.slice(start, start + 2), [ProblemEntity, ProblemJudgeInfoEntity]);
    return result;
  }};
  return manager;
}
module.exports = {commitFixture};
