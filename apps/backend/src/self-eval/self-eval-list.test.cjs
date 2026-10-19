const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require("reflect-metadata");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true }
}).outputText, filename);
const { SelfEvalService } = require("./self-eval.service.ts");
const { UserPrivilegeType: P } = require("../user/user-privilege.service.ts");
const { ForbiddenException, BadRequestException } = require("@nestjs/common");

function fixture() {
  const user = { id: 7, allowed: [P.ViewSite, P.ViewProblem, P.CreateSelfEval] };
  const records = [
    ...Array.from({ length: 35 }, (_, index) => ({ id: index + 1, problemId: 1, contestId: 7, scope: "contest:7:problem:1", submitterId: 7, status: "Accepted", score: 100, content: {code: "private code"}, snapshot: {cases: "hidden data"} })),
    { id: 40, problemId: 2, contestId: 7, scope: "contest:7:problem:2", submitterId: 7, status: "Accepted" },
    { id: 41, problemId: 3, contestId: 2, scope: "contest:2:problem:3", submitterId: 7, status: "Accepted" },
    { id: 42, problemId: 1, contestId: 7, scope: "malformed-scope", submitterId: 7, status: "Accepted" },
    { id: 43, problemId: 1, contestId: 7, scope: "contest:7:problem:1", submitterId: 8, status: "Accepted" }
  ];
  const denied = new Set(["contest:7:problem:2", "contest:2:problem:3"]);
  const calls = { contexts: [], counts: 0, reads: 0, conditions: [] };
  function makeQuery(initial = []) {
    let conditions = [...initial], offset = 0, limit = 30;
    const q = {
      where: (sql, params) => { conditions = [{ sql, params }]; return q; },
      andWhere: (sql, params) => { conditions.push({ sql, params }); calls.conditions.push(sql); return q; },
      clone: () => makeQuery(conditions),
      select: names => { assert.deepEqual(names, ["e.scope AS scope", "e.problemId AS problemId", "e.contestId AS contestId"]); return q; },
      distinct: enabled => { assert.equal(enabled, true); return q; },
      orderBy: () => q, skip: value => { offset = value; return q; }, take: value => { limit = value; return q; },
      getRawMany: async () => {
        const distinct = new Map();
        for (const record of selected()) distinct.set(record.scope, { scope: record.scope, problemId: record.problemId, contestId: record.contestId });
        return [...distinct.values()];
      },
      getManyAndCount: async () => {
        calls.counts++;
        assert(conditions.some(condition => condition.sql.includes("visibleScopes")), "authorization must constrain the database count");
        const rows = selected().sort((a,b) => b.id - a.id);
        return [rows.slice(offset, offset + limit), rows.length];
      }
    };
    function selected() {
      return records.filter(record => conditions.every(({ sql, params = {} }) =>
        (!sql.includes("IS NOT NULL") || record.contestId != null) &&
        (params.id == null || record.submitterId === params.id) &&
        (params.problem == null || record.problemId === params.problem) &&
        (params.contest == null || record.contestId === params.contest) &&
        (params.visibleScopes == null || params.visibleScopes.includes(record.scope))));
    }
    return q;
  }
  const service = Object.create(SelfEvalService.prototype);
  service.privileges = { userHasPrivilege: async (actor, permission) => !!actor?.allowed.includes(permission) };
  service.db = { getRepository: () => ({ createQueryBuilder: () => { calls.reads++; return makeQuery(); } }) };
  service.context = async (_actor, record) => {
    const scope = record.contestId ? `contest:${record.contestId}:problem:${record.problemId}` : `problem:${record.problemId}`;
    calls.contexts.push(scope);
    if (denied.has(scope)) throw new ForbiddenException();
    return { scope };
  };
  service.contestAccess = { get: async () => ({ contest: { rule: "noi", ruleOptions: { selfEvalEnabled: true } } }) };
  return { service, user, records, denied, calls };
}

test("revoked private resources are excluded before pagination and total", async () => {
  const f = fixture();
  const first = await f.service.list(f.user, {contestId:7});
  assert.equal(first.total, 35);
  assert.equal(first.records.length, 30);
  assert.deepEqual(first.records.map(record => record.id), Array.from({length:30}, (_,i) => 35-i));
  const second = await f.service.list(f.user, {contestId:7,page:2});
  assert.equal(second.total, 35);
  assert.deepEqual(second.records.map(record => record.id), [5,4,3,2,1]);
  assert(first.records.every(record => !record.content && !record.snapshot && !record.scope));
});

test("each distinct scope is checked once, instead of reauthorizing all history rows", async () => {
  const f = fixture();
  await f.service.list(f.user, {contestId:7});
  assert.equal(f.calls.contexts.length, 3);
  assert.equal(f.calls.counts, 1);
});

test("resource filters preserve their AND conditions alongside authorized scopes", async () => {
  const f = fixture();
  const hidden = await f.service.list(f.user, {contestId:7,problemId:2});
  assert.deepEqual(hidden, {records:[],total:0,pageSize:30});
  assert.equal(f.calls.counts, 0, "no authorized context cannot reveal a hidden count");
  const publicRows = await f.service.list(f.user, {contestId:7,problemId:1});
  assert.equal(publicRows.total, 35);
  const deniedContest = await f.service.list(f.user, {contestId:2});
  assert.equal(deniedContest.total, 0);
});

test("a global ViewProblem, ViewSite or CreateSelfEval deny blocks list reads", async () => {
  for (const permission of [P.ViewProblem, P.ViewSite, P.CreateSelfEval]) {
    const f = fixture();
    f.user.allowed = f.user.allowed.filter(value => value !== permission);
    await assert.rejects(f.service.list(f.user, {contestId:7}), ForbiddenException);
    assert.equal(f.calls.reads, 0);
  }
});

test("inaccessible contexts cannot leave the original unfiltered total behind", async () => {
  const f = fixture();
  f.denied.add("contest:7:problem:1");
  assert.deepEqual(await f.service.list(f.user, {contestId:7}), {records:[],total:0,pageSize:30});
  assert.equal(f.calls.counts, 0);
});

test("invalid pagination and filter identifiers are rejected before database access", async () => {
  for (const request of [{ page:0 },{page:1.5},{page:1000001},{problemId:-1},{contestId:Infinity}]) {
    const f = fixture();
    await assert.rejects(f.service.list(f.user, request), BadRequestException);
    assert.equal(f.calls.reads, 0);
  }
});


test("list rejects unscoped requests and non-NOI or disabled contests before counting any rows", async () => {
  const f=fixture();await assert.rejects(f.service.list(f.user,{}),BadRequestException);
  for(const rule of ["ioi","strictioi","acm"]) {
    f.service.contestAccess.get=async()=>({contest:{rule,ruleOptions:{selfEvalEnabled:true}}});
    await assert.rejects(f.service.list(f.user,{contestId:7}),BadRequestException);
  }
  f.service.contestAccess.get=async()=>({contest:{rule:"noi",ruleOptions:{selfEvalEnabled:false}}});
  await assert.rejects(f.service.list(f.user,{contestId:7}),BadRequestException);assert.equal(f.calls.reads,0);
});
