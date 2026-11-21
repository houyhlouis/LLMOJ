const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(
  ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
  }).outputText, filename
);
const { ContestAccessService } = require("./contest-access.service.ts");
const { ContestService } = require("./contest.service.ts");
const { ContestProblemService } = require("./contest-problem.service.ts");
const { ContestSubmissionService } = require("./contest-submission.service.ts");
const { UserPrivilegeType: P } = require("../user/user-privilege.service.ts");

const second = 1000;
const start = Date.UTC(2026, 0, 1), end = start + 60 * second, virtualStart = end + 123 * second;
const denied = (status, code) => error =>
  error.getStatus() === status && (!code || error.getResponse().error === code);

function fixture(t, rule = "ioi") {
  let wallNow = virtualStart;
  t.mock.method(Date, "now", () => wallNow);
  const contest = { id: 1, rule, ruleOptions: { hackEnabled: true }, startTime: new Date(start),
    endTime: new Date(end), isPublic: true, ownerId: 90, adminIds: [], languages: ["cpp:c++17"] };
  const me = { id: 10, permissions: [P.ViewContest, P.ParticipateContest, P.SubmitProblem, P.ViewSubmission, P.ViewContestScoreboard, P.ViewHiddenContestScoreboard] };
  const problem = { id: 6, type: "Traditional", locales: ["en_US"] };
  const slot = { id: 4, contestId: 1, problemId: 6, problem: Promise.resolve(problem), title: "Problem", weight: 1 };
  const users = [me], runs = [], submissions = [], audits = [];
  let judgedDetailReads = 0;
  const findBy = (items, where) => items.find(item => Object.entries(where).every(([key, value]) => item[key] === value)) ?? null;

  const repo = entity => {
    if (entity.name === "ContestEntity") return { findOneBy: async where => findBy([contest], where) };
    if (entity.name === "UserEntity") return { findOneBy: async where => findBy(users, where), findBy: async () => users };
    if (entity.name === "TeamResourceEntity") return { findOne: async () => null };
    if (entity.name === "ContestVirtualParticipationEntity") return {
      findOneBy: async where => findBy(runs, where),
      existsBy: async where => !!findBy(runs, where)
    };
    if (entity.name === "ContestProblemEntity") return { findOneBy: async where => findBy([slot], where) };
    if (entity.name === "SubmissionEntity") return {
      createQueryBuilder() {
        // The MariaDB suite exercises the actual elapsed-time join and its placement before pagination.
        let params = {};
        const query = {
          where: (_sql, bound) => { Object.assign(params, bound); return query; },
          andWhere: (_sql, bound) => { Object.assign(params, bound); return query; },
          leftJoin: () => query,
          getOne: async () => findBy(submissions, { id: params.submissionId, contestId: params.id }),
          getExists: async () => submissions.some(s => s.contestId === params.contestId && s.submitterId === params.userId &&
            s.submitTime >= params.start && s.submitTime < params.end)
        };
        return query;
      },
      findOneBy: async where => findBy(submissions, where)
    };
    throw new Error("Unexpected entity: " + entity.name);
  };
  const transaction = {
    getRepository: repo,
    findOne: async (entity, { where }) => repo(entity).findOneBy(where),
    insert: async (entity, row) => { assert.equal(entity.name, "ContestVirtualParticipationEntity"); runs.push(row); },
    save: async (entity, row) => { assert.equal(entity.name, "AuditLogEntity"); audits.push(row); }
  };
  const db = { getRepository: repo, transaction: (_isolation, callback) => callback(transaction) };
  const privileges = { userHasPrivilege: async (user, permission) =>
    user ? user.isAdmin || user.permissions.includes(permission) : permission === P.ViewContest };
  const access = new ContestAccessService(db, privileges);
  const own = { userId: me.id, problems: { [slot.id]: { submissionId: 12, status: "Accepted", score: 100, accepted: true } } };
  const scores = {
    contestScores: async () => [],
    virtualScores: async (_contest, _problems, cutoff) => {
      if (cutoff !== undefined) assert.equal(cutoff, wallNow - virtualStart);
      return [own];
    },
    hasVirtualParticipants: async () => true
  };
  const problems = { getProblemJudgeInfo: async () => [{}, true], getProblemLocalizedContent: async () => [], getProblemSamples: async () => [] };
  const contestProblems = new ContestProblemService(db, access, problems);
  const service = new ContestService(db, access, scores, { problemList: async () => [slot] });
  const storage = {
    validateSubmissionContent: async () => [],
    prepareSubmissionFileUpload: async () => ({ method: "POST" }),
    createSubmission: async (user, _p, _data, _upload, context) => {
      const submitTime = await context.admit(transaction);
      const s = { id: 12, contestProblemId: context.contestProblemId, contestId: context.contestId, submitTime,
        submitterId: user.id, status: "Accepted", score: 100, timeUsed: 54, memoryUsed: 64 };
      submissions.push(s);
      return [null, s];
    },
    getSubmissionDetail: async () => { judgedDetailReads++; return { content: { code: "private" }, result: { compile: { message: "private" }, subtasks: [{ score: 100, fullScore: 100, testcases: [] }] } }; }
  };
  const writer = new ContestSubmissionService(db, access, problems, { lockProblemById: (_id, _kind, cb) => cb(problem) }, storage);
  return { me, contest, slot, runs, audits, submissions, service, access, writer, contestProblems, storage, users, transaction,
    setTime: time => { wallNow = time; }, detailReads: () => judgedDetailReads };
}

test("detail and start enforce every eligibility condition with an exclusive official end", async t => {
  const f = fixture(t);
  const { service, me, contest } = f;
  async function reason(user, expected) {
    assert.deepEqual((await service.detail(user, contest.id)).virtualParticipation,
      { canStart: false, reason: expected, run: null });
    await assert.rejects(service.startVirtual(user, contest.id), denied(403, "VIRTUAL_" + expected));
    assert.equal(f.runs.length, 0);
  }
  f.setTime(start - 1);
  await reason(me, "NOT_ENDED");
  f.setTime(end - 1);
  await reason(me, "NOT_ENDED");
  f.setTime(end);
  await reason(null, "NO_PERMISSION");
  me.permissions = me.permissions.filter(p => p !== P.ParticipateContest);
  await reason(me, "NO_PERMISSION");
  me.permissions.push(P.ParticipateContest);
  me.isAdmin = true;
  await reason(me, "MANAGER");
  me.isAdmin = false;
  f.submissions.push({ contestId: 1, submitterId: me.id, submitTime: new Date(start), status: "Fake" });
  await reason(me, "PARTICIPATED");
  f.submissions.pop();
  assert.equal((await service.detail(me, 1)).virtualParticipation.canStart, true, "deleting the last official submission restores eligibility");
  f.submissions.push({ contestId: 1, submitterId: me.id, submitTime: new Date(end), status: "Pending" });
  contest.isPublic = false;
  await assert.rejects(service.startVirtual(me, 1), denied(403));
  contest.isPublic = true;
  me.permissions = me.permissions.filter(p => p !== P.SubmitProblem);
  assert.deepEqual((await service.detail(me, 1)).virtualParticipation, { canStart: true, reason: null, run: null });
  f.setTime(virtualStart + 456);
  const result = await service.startVirtual(me, 1);
  assert.deepEqual(result, { run: { startTime: new Date(virtualStart), endTime: new Date(virtualStart + end - start) } });
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].action, "contest.start_virtual");
  await assert.rejects(service.startVirtual(me, 1), denied(403, "VIRTUAL_ALREADY_USED"));
  f.setTime(virtualStart + end - start);
  assert.deepEqual((await service.detail(me, 1)).virtualParticipation, { canStart: false, reason: "ALREADY_USED", run: result.run });
  await assert.rejects(service.startVirtual(me, 1), denied(403, "VIRTUAL_ALREADY_USED"));
});

test("contest submissions and answer uploads follow the run window and both permissions", async t => {
  const f = fixture(t);
  const submit = () => f.writer.submit(f.me, 1, f.slot.id, {});
  const prepare = () => f.writer.submit(f.me, 1, f.slot.id, { fileSize: 4 }, true);
  await assert.rejects(submit, denied(403));
  await assert.rejects(prepare, denied(403));
  await f.service.startVirtual(f.me, 1);
  f.setTime(virtualStart);
  assert.equal((await f.contestProblems.problem(f.me, 1, f.slot.id, "en_US")).submittable, true);
  assert.deepEqual(await prepare(), { signedUploadRequest: { method: "POST" } });
  for (const privilege of [P.SubmitProblem, P.ParticipateContest]) {
    f.me.permissions = f.me.permissions.filter(p => p !== privilege);
    await assert.rejects(submit, denied(403));
    await assert.rejects(prepare, denied(403));
    assert.equal((await f.service.detail(f.me, 1)).canSubmit, false);
    f.me.permissions.push(privilege);
  }
  const finish = virtualStart + end - start;
  f.setTime(finish - 1);
  assert.deepEqual(await submit(), { submissionId: 12 });
  assert.equal(+f.submissions[0].submitTime, finish - second);
  const create = f.storage.createSubmission;
  f.storage.createSubmission = async (...args) => { f.setTime(finish); return create(...args); };
  await assert.rejects(submit, /Contest has ended/, "admission rechecks at persistence");
  assert.equal(f.submissions.length, 1);
  f.setTime(finish - 1);
  f.storage.validateSubmissionContent = async () => { f.setTime(finish); return []; };
  await assert.rejects(prepare, /Contest has ended/, "expensive validation can span the deadline");
  await assert.rejects(prepare, /Contest has ended/);
  assert.equal((await f.service.detail(f.me, 1)).ended, true);
  assert.equal((await f.contestProblems.problem(f.me, 1, f.slot.id, "en_US")).submittable, false);
});

test("schedule edits hold the exclusive contest lock and preserve every stored run window", async t => {
  const f = fixture(t);
  let saved = { ...f.contest };
  // A database load gives save() a working copy, and the locking reread sees the stored row.
  const originalGet = f.access.get.bind(f.access);
  f.access.get = async (...args) => {
    const state = await originalGet(...args);
    return { ...state, contest: { ...saved }, manager: true };
  };
  const locks = [];
  f.transaction.findOne = async (entity, { where, lock }) => {
    assert.equal(entity.name, "ContestEntity");
    assert.equal(where.id, f.contest.id);
    locks.push(lock.mode);
    return { ...saved };
  };
  f.transaction.save = async row => { saved = { ...row }; };
  const update = extras => f.service.save(f.me, f.contest.id, {
    title: "Title", rule: saved.rule, startTime: saved.startTime.toISOString(), endTime: saved.endTime.toISOString(),
    adminIds: [], languages: saved.languages, isPublic: true, ...extras
  });
  const editedEnd = new Date(+saved.endTime + second);
  await update({ endTime: editedEnd.toISOString() });
  assert.equal(+saved.endTime, +editedEnd);
  f.runs.push({ contestId: saved.id, userId: f.me.id, startTime: new Date(virtualStart), endTime: new Date(virtualStart + end - start) });
  await assert.rejects(update({ startTime: new Date(+saved.startTime - second).toISOString() }), denied(400, "VIRTUAL_RUNS_EXIST"));
  await assert.rejects(update({ endTime: new Date(+saved.endTime + second).toISOString() }), denied(400, "VIRTUAL_RUNS_EXIST"));
  await update({ title: "Edited title", startTime: new Date(start + 987).toISOString(),
    endTime: new Date(+editedEnd + 543).toISOString() });
  assert.equal(+saved.startTime, start);
  assert.equal(+saved.endTime, +editedEnd);
  assert.equal(saved.title, "Edited title");
  await assert.rejects(update({ startTime: new Date(start + 100).toISOString(), endTime: new Date(start + 900).toISOString() }),
    /Invalid time range/);
  assert.deepEqual(locks, Array(4).fill("pessimistic_write"));
});

test("contest deletion drains new submissions outside its finalization lock", async t => {
  const f = fixture(t);
  let locked = false, contestDeleted = false, removedFiles = false;
  const records = [{ id: 8 }], cleaned = [];
  f.me.isAdmin = true;
  f.service.db.transaction = async (isolation, callback) => {
    assert.equal(isolation, "READ COMMITTED");
    locked = true;
    try { return await callback(f.transaction); } finally { locked = false; }
  };
  f.transaction.findOne = async (entity, options) => {
    assert.equal(entity.name, "ContestEntity");
    assert.equal(options.lock.mode, "pessimistic_write");
    return f.contest;
  };
  f.transaction.find = async entity => { assert.equal(entity.name, "SubmissionEntity"); return [...records]; };
  f.transaction.getRepository = () => {
    const query = { where: () => query, setLock: () => query, getMany: async () => [{ attachments: [{ uuid: "file" }] }] };
    return { createQueryBuilder: () => query };
  };
  f.transaction.delete = async () => { assert.equal(records.length, 0); assert.equal(locked, true); contestDeleted = true; };
  f.service.submissions = { deleteSubmission: async s => {
    assert.equal(locked, false);
    cleaned.push(s.id);
    records.shift();
    if (cleaned.length === 1) records.push({ id: 9 }); // A submit admitted while cleanup ran.
  } };
  f.service.files = { deleteFile: async ids => {
    assert.deepEqual(ids, ["file"]); assert.equal(locked, true);
    return () => { assert.equal(locked, false); removedFiles = true; };
  } };
  assert.deepEqual(await f.service.delete(f.me, f.contest.id), {});
  assert.deepEqual(cleaned, [8, 9]);
  assert.equal(contestDeleted, true);
  assert.equal(removedFiles, true);
});

for (const rule of ["noi", "ioi", "strictioi", "acm"]) {
  test(rule + " uses live feedback, visibility and statistics on the viewer's virtual clock", async t => {
    const f = fixture(t, rule);
    const { me, writer, service } = f;
    await service.startVirtual(me, 1);
    f.setTime(virtualStart + 4 * second);
    await writer.submit(me, 1, f.slot.id, {});
    const detail = await service.detail(me, 1);
    assert.equal(detail.started, true);
    assert.equal(detail.ended, false);
    assert.equal(detail.canSubmit, true);
    const live = ["acm", "ioi"].includes(rule);
    assert.equal(detail.canRank, live, "even with ViewHiddenContestScoreboard");
    assert.deepEqual(detail.problemStats[f.slot.id], live ? { attempted: 1, accepted: 1, partially: 1 } : null);
    assert.equal(detail.hasVirtualParticipants, false);
    assert.equal(detail.ownResults[f.slot.id].status, rule === "noi" ? "Compiled" : "Accepted");
    if (rule === "noi") assert.equal("score" in detail.ownResults[f.slot.id], false);
    const own = await writer.submissionDetail(me, 1, 12);
    assert.equal(own.submission.status, rule === "noi" ? "Compiled" : "Accepted");
    assert.equal(own.submission.score, ["acm", "noi"].includes(rule) ? null : 100);
    assert.equal(own.submission.timeUsed, null);
    assert.deepEqual(own.content, { code: "private" });
    assert.equal(own.compile, undefined);
    assert.equal(!!own.subtasks, ["ioi", "strictioi"].includes(rule));
    f.submissions.push({ ...f.submissions[0], id: 14, submitterId: me.id + 1, submitTime: new Date(start) });
    if (rule === "acm") {
      const rival = await writer.submissionDetail(me, 1, 14);
      assert.equal(rival.content, null);
      assert.equal(rival.submission.status, "Accepted");
      assert.equal(rival.subtasks, undefined);
    } else {
      const before = f.detailReads();
      await assert.rejects(writer.submissionDetail(me, 1, 14), denied(403));
      assert.equal(f.detailReads(), before);
    }
    assert.deepEqual(await f.access.hackAccess(me, f.contest), { allowed: false, reason: "Hacks are unavailable during virtual participation" });
    f.contest.hideStatistics = true;
    assert.equal((await service.detail(me, 1)).problemStats[f.slot.id], null);
    f.setTime(virtualStart + end - start);
    const after = await service.detail(me, 1);
    assert.equal(after.ended, true);
    assert.equal(after.canRank, true);
    assert.equal(after.canSubmit, false);
    assert.equal(after.hasVirtualParticipants, true);
    assert.equal(after.problemStats[f.slot.id].attempted, 0, "finished virtual runs do not contribute to official statistics");
    assert.equal(after.ownResults[f.slot.id].score, 100);
  });
}
