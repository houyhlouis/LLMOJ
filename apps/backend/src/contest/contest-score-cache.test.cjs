// A contest's scores are computed from all its submissions once, then reused until a submission of the contest, the
// contest's timing or rule, or its problems change. Without Redis they're computed every time.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2019,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
      }
    }).outputText,
    filename
  );
const main = require.resolve("../main.ts");
require.cache[main] = { id: main, filename: main, loaded: true, exports: { appGitRepoInfo: {} } };
String.prototype.format ||= function format(...args) {
  return require("node:util").format(String(this), ...args);
};

const { ContestScoreService } = require("./contest-score.service.ts");
const { scoreContest } = require("./contest-scoring.ts");
const { ContestScoreRevisionService } = require("../submission/contest-score-revision.service.ts");

const start = new Date("2026-10-17T08:00:00Z");
const contest = { id: 29, rule: "acm", startTime: start, endTime: new Date(+start + 5 * 3600 * 1000) };
const problems = [
  { id: 1, weight: 1 },
  { id: 2, weight: 1 }
];
const at = minutes => new Date(+start + minutes * 60000);

function fixture({ revisions } = {}) {
  const rows = [
    { id: 1, submitterId: 7, contestProblemId: 1, submitTime: at(10), status: "WrongAnswer", score: 0 },
    { id: 2, submitterId: 7, contestProblemId: 1, submitTime: at(20), status: "Accepted", score: 100 },
    { id: 3, submitterId: 8, contestProblemId: 2, submitTime: at(30), status: "Accepted", score: 100 }
  ];
  const reads = { count: 0, selected: null };
  const service = Object.assign(Object.create(ContestScoreService.prototype), {
    db: {
      getRepository: () => ({
        createQueryBuilder: () => {
          const builder = {
            select: columns => ((reads.selected = columns), builder),
            where: () => builder,
            getMany: async () => {
              reads.count++;
              await new Promise(resolve => setTimeout(resolve, 5));
              return rows.map(row => ({ ...row }));
            }
          };
          return builder;
        }
      })
    },
    scoreRevisions: revisions
  });
  return { service, rows, reads };
}

test("scores are reused until a submission of the contest changes", async () => {
  let revision = "4";
  const { service, rows, reads } = fixture({ revisions: { revision: async () => revision } });
  const first = await service.contestScores(contest, problems);
  assert.deepEqual(first, scoreContest(contest.rule, contest.startTime, problems, rows));
  assert.deepEqual(reads.selected, ["s.id", "s.submitterId", "s.contestProblemId", "s.submitTime", "s.status", "s.score", "s.problemDataVersionId"]);
  await service.contestScores(contest, problems);
  await service.contestScores(contest, problems);
  assert.equal(reads.count, 1);
  // A submission changed: the revision moved on
  rows.push({ id: 4, submitterId: 8, contestProblemId: 1, submitTime: at(40), status: "Accepted", score: 100 });
  revision = "5";
  const after = await service.contestScores(contest, problems);
  assert.equal(reads.count, 2);
  assert.equal(after.find(row => row.userId === 8).score, 2);
});

test("a change of the contest or its problems, or the time limit, recomputes", async () => {
  const { service, reads } = fixture({ revisions: { revision: async () => "1" } });
  await service.contestScores(contest, problems);
  await service.contestScores({ ...contest, endTime: new Date(+contest.endTime + 60000) }, problems);
  await service.contestScores({ ...contest, rule: "ioi" }, problems);
  await service.contestScores(contest, [problems[0], { id: 2, weight: 2 }]);
  assert.equal(reads.count, 4);
  service.scoreCache.get(contest.id).at -= 61 * 1000;
  await service.contestScores(contest, [problems[0], { id: 2, weight: 2 }]);
  assert.equal(reads.count, 5);
});

test("requests at the same time share one computation; a failed one isn't kept", async () => {
  const { service, reads } = fixture({ revisions: { revision: async () => "1" } });
  await Promise.all([1, 2, 3, 4].map(() => service.contestScores(contest, problems)));
  assert.equal(reads.count, 1);
  const failing = fixture({ revisions: { revision: async () => "1" } });
  failing.service.db = { getRepository: () => ({ createQueryBuilder: () => { throw new Error("database unavailable"); } }) };
  await assert.rejects(failing.service.contestScores(contest, problems), /database unavailable/);
  assert.equal(failing.service.scoreCache.size, 0);
});

test("without Redis, or without the revision service, scores are computed every time", async () => {
  const down = fixture({ revisions: { revision: async () => Promise.reject(new Error("connection refused")) } });
  await down.service.contestScores(contest, problems);
  await down.service.contestScores(contest, problems);
  assert.equal(down.reads.count, 2);
  const none = fixture();
  await none.service.contestScores(contest, problems);
  await none.service.contestScores(contest, problems);
  assert.equal(none.reads.count, 2);
});

test("strict IOI projects only submissionId and result and scores exactly as a full detail read", async t => {
  const { DatabaseSync } = require("node:sqlite");
  const { DataSource, In } = require("typeorm");
  const { SubmissionDetailEntity } = require("../submission/submission-detail.entity.ts");
  const source = new DataSource({
    type: "mariadb", database: "score_fixture", entities: [require("node:path").join(__dirname, "../**/*.entity.ts")]
  });
  await source.buildMetadatas();
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE submission_detail (submissionId INTEGER PRIMARY KEY, result TEXT, content TEXT, fileUuid TEXT)");
  const insert = db.prepare("INSERT INTO submission_detail VALUES (?, ?, ?, NULL)");
  const first = [50, 50], second = [40, 60];
  const runs = [
    // Same weights across versions, then a different layout within a version and a rounded non-AC.
    [2, 1, 50, 1, first, [50, 0]], [2, 1, 50, 2, first, [0, 50]],
    [2, 1, 40, 2, second, [40, 0]], [2, 1, 60, 2, second, [0, 59.6]],
    [2, 1, 100, 2, second, [40, 60], "Fake"], [2, 1, 100, 2, second, [40, 60], "Hacked"],
    // Result without subtasks, null result and a missing detail row (all accepted legacy shapes).
    [2, 2, 30, null, [], []], [2, 2, 40, null, null, null], [3, 2, 100, null, null, null, "Accepted"]
  ].map(([submitterId, contestProblemId, score, problemDataVersionId, weights, earned, status], i) => {
    if (i !== 8) insert.run(i + 1, weights && JSON.stringify({
      subtasks: weights.map((fullScore, j) => ({ score: earned[j], fullScore })), compile: { success: true }
    }), JSON.stringify({ code: "x".repeat(16384) }));
    return { id: i + 1, submitterId, contestProblemId, submitTime: at(i + 1), score, problemDataVersionId,
      status: status || "PartiallyCorrect" };
  });
  const runner = source.createQueryRunner();
  const queries = [];
  runner.query = async (sql, args) => {
    queries.push(sql);
    return { records: db.prepare(sql).all(...args) };
  };
  const repo = runner.manager.getRepository(SubmissionDetailEntity);
  const oldRows = await repo.findBy({ submissionId: In(runs.map(s => s.id)) });
  assert.match(queries.pop(), /`content`/);
  const expected = scoreContest("strictioi", start, problems, runs.map(s => ({
    ...s, subtasks: oldRows.find(row => row.submissionId === s.id)?.result?.subtasks
  })));
  const { service, rows } = fixture();
  rows.splice(0, rows.length, ...runs);
  const submissions = service.db.getRepository();
  service.db = { getRepository: entity => entity === SubmissionDetailEntity ? repo : submissions };
  const actual = await service.contestScores({ ...contest, rule: "strictioi" }, problems);
  assert.deepEqual(actual, expected);
  assert.equal(actual[0].problems[1].score, 100);
  assert.equal(actual[0].problems[1].status, "PartiallyCorrect");
  assert.equal(actual[0].problems[1].versions, 2);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /`submissionId`/);
  assert.match(queries[0], /`result`/);
  assert.doesNotMatch(queries[0], /`content`|`fileUuid`/);
});

test("a contest's revision moves on only once the transaction that changed its submission commits", async () => {
  const increments = [];
  let fail = false;
  const revisions = new ContestScoreRevisionService(
    { subscribers: [] },
    {
      increment: async (key, seconds) => {
        if (fail) throw new Error("Redis down");
        increments.push([key, seconds]);
      },
      cacheGet: async () => null
    }
  );
  const runner = { isTransactionActive: true, data: {} };
  revisions.noteChange({ queryRunner: runner }, 29);
  revisions.noteChange({ queryRunner: runner }, 29);
  revisions.noteChange({ queryRunner: runner }, 12);
  assert.deepEqual(increments, []);
  // A released savepoint isn't the commit
  revisions.afterTransactionCommit({ queryRunner: runner });
  assert.deepEqual(increments, []);
  runner.isTransactionActive = false;
  revisions.afterTransactionCommit({ queryRunner: runner });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(increments.map(([key]) => key).sort(), ["contest-score-revision:12", "contest-score-revision:29"]);
  assert.equal(increments[0][1], 30 * 24 * 60 * 60);
  // A rolled-back transaction moves nothing on
  increments.length = 0;
  const rolledBack = { isTransactionActive: true, data: {} };
  revisions.noteChange({ queryRunner: rolledBack }, 29);
  rolledBack.isTransactionActive = false;
  revisions.afterTransactionRollback({ queryRunner: rolledBack });
  revisions.afterTransactionCommit({ queryRunner: rolledBack });
  // Outside a transaction, right away
  revisions.noteChange({}, 7);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(increments.map(([key]) => key), ["contest-score-revision:7"]);
  // Redis failing never fails the commit
  fail = true;
  const runner2 = { isTransactionActive: true, data: {} };
  revisions.noteChange({ queryRunner: runner2 }, 29);
  runner2.isTransactionActive = false;
  assert.doesNotThrow(() => revisions.afterTransactionCommit({ queryRunner: runner2 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await revisions.revision(29), "0");
});
