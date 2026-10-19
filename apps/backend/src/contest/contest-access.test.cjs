const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(
  ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
  }).outputText, filename);
const { ContestService } = require("./contest.service.ts");
const { ContestAccessService } = require("./contest-access.service.ts");
const { ContestScoreService } = require("./contest-score.service.ts");
const { ContestSubmissionService } = require("./contest-submission.service.ts");
const { UserPrivilegeType: P } = require("../user/user-privilege.service.ts");
const { ForbiddenException } = require("@nestjs/common");

function fixture(rule = "strictioi") {
  const now = Date.now();
  const contest = { id: 1, rule, ruleOptions: {}, startTime: new Date(now - 60000), endTime: new Date(now + 60000), hideStatistics: false };
  const user = { id: 7, allowed: [P.ViewContestScoreboard, P.ViewSubmission, P.ParticipateContest] };
  const runs = [
    { id: 1, contestId: 1, contestProblemId: 2, submitterId: 7, submitTime: new Date(now - 30000), status: "PartiallyCorrect", score: 40, codeLanguage: "cpp", timeUsed: 55, memoryUsed: 64 },
    { id: 2, contestId: 1, contestProblemId: 2, submitterId: 7, submitTime: new Date(now - 20000), status: "PartiallyCorrect", score: 60, codeLanguage: "cpp", timeUsed: 55, memoryUsed: 64 }
  ];
  const result = (a, b) => ({ subtasks: [{ score: a, fullScore: 40, testcases: [] }, { score: b, fullScore: 60, testcases: [] }], testcaseResult: {}, compile: { success: true, message: "private compile" } });
  const details = [ { submissionId: 1, result: result(40, 0), content: { code: "owner code" } }, { submissionId: 2, result: result(0, 60), content: { code: "owner code" } } ];
  const privileges = { userHasPrivilege: async (who, privilege) => !!who?.allowed.includes(privilege) };
  const db = { getRepository: entity => {
    if (entity.name === "SubmissionEntity") return {
      createQueryBuilder: () => { const q = { select: () => q, where: () => q, andWhere: () => q, getMany: async () => runs }; return q; },
      findOneBy: async query => runs.find(run => run.id === query.id && run.contestId === query.contestId)
    };
    if (entity.name === "SubmissionDetailEntity") return { findBy: async () => details };
    if (entity.name === "UserEntity") return { findBy: async () => [{ id: 7, username: "owner" }] };
    throw new Error("Unexpected repository: " + entity.name);
  } };
  const access = Object.assign(Object.create(ContestAccessService.prototype), { db, privileges });
  access.get = async who => ({ contest, manager: !!who?.manager });
  const scores = Object.assign(Object.create(ContestScoreService.prototype), { db });
  const contestProblems = { problemList: async () => [{ id: 2, weight: 1, title: "Merged subtasks" }] };
  const service = Object.assign(Object.create(ContestService.prototype), { db, access, scores, contestProblems });
  const submissions = Object.assign(Object.create(ContestSubmissionService.prototype), {
    db,
    access,
    submissions: { getSubmissionDetail: async submission => details.find(detail => detail.submissionId === submission.id) },
    submissionAccess: { userHasPermission: async () => false }
  });
  return { service, submissions, access, contest, user, runs, details };
}

test("Strict IOI service aggregates persisted judge subtasks for own results while protecting live rank/statistics", async () => {
  const f = fixture();
  const result = await f.service.detail(f.user, 1);
  assert.equal(result.ownResults[2].score, 100);
  assert.equal(result.canRank, false);
  assert.equal(result.problemStats[2], null);
  await assert.rejects(f.service.ranklist(f.user, 1), ForbiddenException);
});

test("Strict IOI hidden-scoreboard privilege permits access but explicit scoreboard deny always applies", async () => {
  const f = fixture();
  f.user.allowed.push(P.ViewHiddenContestScoreboard);
  assert.equal((await f.service.ranklist(f.user, 1)).rows[0].score, 100);
  f.user.allowed = f.user.allowed.filter(privilege => privilege !== P.ViewContestScoreboard);
  await assert.rejects(f.service.ranklist(f.user, 1), ForbiddenException);
});

test("IOI scoreboard becomes live while NOI protects official own results", async () => {
  const ioi = fixture("ioi");
  assert.equal((await ioi.service.detail(ioi.user, 1)).canRank, true);
  assert.equal((await ioi.service.ranklist(ioi.user, 1)).rows[0].score, 60);
  const noi = fixture("noi");
  const own = (await noi.service.detail(noi.user, 1)).ownResults[2];
  assert.equal(own.status, "Compiled");
  assert.equal("score" in own, false);
  assert.equal("subtasks" in own, false);
});

test("Strict IOI self detail contains permitted feedback while rival live detail is denied", async () => {
  const f = fixture();
  const detail = await f.submissions.submissionDetail(f.user, 1, 1);
  assert.equal(detail.submission.score, 40);
  assert.equal(detail.subtasks[0].score, 40);
  const rival = { ...f.user, id: 8 };
  await assert.rejects(f.submissions.submissionDetail(rival, 1, 1), ForbiddenException);
});

test("NOI formal judge detail remains hidden independently of self-evaluation settings", async () => {
  const f = fixture("noi");
  f.contest.ruleOptions = { selfEvalEnabled: true, selfEvalMaxAttempts: 30 };
  const detail = await f.submissions.submissionDetail(f.user, 1, 1);
  assert.equal(detail.submission.score, null);
  assert.equal(detail.subtasks, undefined);
  assert.equal(detail.submission.status, "Compiled");
});

test("Fake and Hacked records lose their Strict IOI contribution while preserving judge evidence", async () => {
  for (const status of ["Fake", "Hacked"]) {
    const f = fixture();
    f.runs[1].status = status;
    const own = (await f.service.detail(f.user, 1)).ownResults[2];
    assert.equal(own.score, 40);
    assert.equal(f.details[1].result.subtasks[1].score, 60);
  }
});

test("after Strict IOI ends, equal totals and detailed aggregates are available", async () => {
  const f = fixture();
  f.contest.endTime = new Date(Date.now() - 1);
  const result = await f.service.ranklist(f.user, 1);
  assert.equal(result.rows[0].score, 100);
  assert.equal(result.rows[0].rank, 1);
  assert.equal(result.rows[0].problems[2].subtasks.length, 2);
});

test("hack access requires enabled setting, participation and the configured window", async () => {
  const f = fixture("acm");
  assert.equal((await f.access.hackAccess(f.user, f.contest)).allowed, false);
  f.contest.ruleOptions = { hackEnabled: true, hackStartTime: f.contest.startTime.toISOString(), hackEndTime: f.contest.endTime.toISOString() };
  assert.equal((await f.access.hackAccess(f.user, f.contest)).allowed, true);
  f.user.allowed = f.user.allowed.filter(privilege => privilege !== P.ParticipateContest);
  assert.equal((await f.access.hackAccess(f.user, f.contest)).allowed, false);
});

test("NOI and Strict IOI cannot expose live records through a configured hack window", async () => {
  for (const rule of ["noi", "strictioi"]) {
    const f = fixture(rule);
    f.contest.ruleOptions = { hackEnabled: true, hackStartTime: f.contest.startTime.toISOString() };
    assert.equal((await f.access.hackAccess(f.user, f.contest)).allowed, false);
    f.user.manager = true;
    assert.equal((await f.access.hackAccess(f.user, f.contest)).allowed, true);
    f.contest.ruleOptions.hackEnabled = false;
    assert.equal((await f.access.hackAccess(f.user, f.contest)).allowed, false);
  }
});
