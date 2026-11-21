// The real TypeORM projections, timeline, scoring and contest endpoints. Run with the repository's pinned Node.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const ts = require("typescript");

require("reflect-metadata");
require.extensions[".ts"] = (module, filename) =>
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
      experimentalDecorators: true, emitDecoratorMetadata: true
    }
  }).outputText, filename);
const main = require.resolve("../main.ts");
require.cache[main] = { id: main, filename: main, loaded: true, exports: { appGitRepoInfo: {} } };
String.prototype.format ||= function (...args) { return require("node:util").format(String(this), ...args); };

const { DataSource } = require("typeorm");
const { ContestScoreService } = require("./contest-score.service.ts");
const { ContestService } = require("./contest.service.ts");
const { ContestAccessService } = require("./contest-access.service.ts");
const { ContestController } = require("./contest.controller.ts");
const { applyContestElapsedCutoff } = require("./contest-virtual-timeline.ts");
const { scoreContest } = require("./contest-scoring.ts");
const { SubmissionEntity } = require("../submission/submission.entity.ts");
const { ContestScoreRevisionService } = require("../submission/contest-score-revision.service.ts");
const { StatisticsOutboxService } = require("../submission/statistics-outbox.service.ts");

const source = new DataSource({
  type: "mariadb", database: "virtual_scores_fixture", entities: [path.join(__dirname, "../**/*.entity.ts")]
});
const metadata = source.buildMetadatas();
const start = new Date("2026-01-11T10:20:00Z");
const at = (base, seconds) => new Date(+base + seconds * 1000);
const contest = { id: 6, rule: "ioi", startTime: start, endTime: at(start, 240) };
const virtualA = at(start, 600);
const virtualB = at(start, 1200);
const problems = [{ id: 4, weight: 2, title: "Four" }, { id: 5, weight: 1, title: "Five" }];

async function fixture(t) {
  await metadata;
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE submission (id INTEGER PRIMARY KEY, contestId INTEGER, submitterId INTEGER, contestProblemId INTEGER,
      submitTime TEXT, status TEXT, score INTEGER, problemDataVersionId INTEGER);
    CREATE TABLE submission_detail (submissionId INTEGER PRIMARY KEY, result TEXT);
    CREATE TABLE contest_problem (id INTEGER PRIMARY KEY, contestId INTEGER);
    INSERT INTO contest_problem VALUES (4,6), (5,6);
    CREATE TABLE contest_virtual_participation (id INTEGER PRIMARY KEY, contestId INTEGER, userId INTEGER, startTime TEXT, endTime TEXT);
    CREATE TABLE DUAL (dummy INTEGER);
    INSERT INTO DUAL VALUES (1);
  `);
  db.function("TIMESTAMPADD", (_unit, seconds, date) => at(new Date(date), seconds).toISOString());
  const runner = source.createQueryRunner();
  const queries = [];
  runner.query = async (sql, args) => {
    queries.push(sql);
    // SQLite accepts a quoted function unit. Parameters and timestamps use the same sortable UTC representation.
    const converted = sql.replace(/TIMESTAMPADD\(SECOND,/ig, "TIMESTAMPADD('SECOND',");
    return { records: db.prepare(converted).all(...args.map(v => v instanceof Date ? v.toISOString() : v)) };
  };
  const counters = new Map();
  const revision = new ContestScoreRevisionService(source, {
    increment: async key => counters.set(key, (counters.get(key) || 0) + 1),
    cacheGet: async key => String(counters.get(key) || 0)
  });
  const scores = Object.assign(new ContestScoreService(runner.manager), { scoreRevisions: revision });
  const outbox = Object.assign(Object.create(StatisticsOutboxService.prototype), { contestScores: revision });
  const insertRun = db.prepare("INSERT INTO contest_virtual_participation VALUES (NULL,?,?,?,?)");
  for (const [user, base] of [[7, virtualA], [9, virtualB]]) {
    insertRun.run(contest.id, user, base.toISOString(), at(base, 240).toISOString());
  }
  const insert = db.prepare("INSERT INTO submission VALUES (?,?,?,?,?,?,?,?)");
  const detail = db.prepare("INSERT INTO submission_detail VALUES (?,?)");
  function add(id, user, base, seconds, problemId, status, score, version = 1, subScores, contestId = contest.id) {
    const when = at(base, seconds);
    insert.run(id, contestId, user, problemId, when.toISOString(), status, score, version);
    const subtasks = subScores?.map(value => ({ fullScore: 50, score: value }));
    if (subtasks) detail.run(id, JSON.stringify({ subtasks }));
    return { id, submitterId: user, contestProblemId: problemId, submitTime: when, status, score, problemDataVersionId: version, subtasks };
  }
  const official = [
    add(1, 2, start, 0, 4, "WrongAnswer", 0),
    add(2, 2, start, 20, 4, "Accepted", 100, 1, [50, 50]),
    add(3, 5, start, 21, 4, "PartiallyCorrect", 50, 2, [0, 50]),
    add(4, 2, start, 239, 5, "Accepted", 100)
  ];
  // Expected scoring submissions for each virtual user live directly on the official timeline.
  function virtual(id, user, base, seconds, ...rest) {
    return { ...add(id, user, base, seconds, ...rest), submitTime: at(start, seconds) };
  }
  const replay = [
    virtual(5, 7, virtualA, 0, 4, "WrongAnswer", 0),
    virtual(6, 7, virtualA, 20, 4, "Accepted", 100, 1, [50, 50]),
    virtual(7, 7, virtualA, 23, 5, "WrongAnswer", 0),
    virtual(8, 9, virtualB, 19, 5, "PartiallyCorrect", 50, 1, [50, 0]),
    virtual(9, 9, virtualB, 20, 5, "PartiallyCorrect", 50, 2, [0, 50]),
    virtual(10, 9, virtualB, 22, 5, "PartiallyCorrect", 50, 2, [50, 0])
  ];
  // At the exclusive ends, before start, reserved for a different contest, or by a user with no run.
  add(11, 2, start, 240, 5, "Accepted", 100);
  add(12, 7, virtualA, 240, 5, "Accepted", 100);
  add(13, 7, virtualA, -1, 5, "Accepted", 100);
  add(14, 7, virtualA, 1, 5, "Accepted", 100, 1, null, 99);
  add(15, 8, virtualB, 0, 5, "Accepted", 100);
  return { db, scores, runner, revision, outbox, queries, official, replay };
}

function expectedScores(rule, official, replay, elapsed = Infinity) {
  return scoreContest(rule, start, problems, [...official, ...replay].filter(s => +s.submitTime <= +start + elapsed))
    .map(row => [7, 9].includes(row.userId) ? {
      ...row, virtual: true, virtualStartTime: row.userId === 7 ? virtualA : virtualB
    } : row);
}

test("merged ranking matches an independent official timeline for every rule, at exact cutoff instants", async t => {
  const { scores, official, replay } = await fixture(t);
  for (const rule of ["noi", "ioi", "acm", "strictioi"]) {
    const c = { ...contest, rule };
    for (const elapsed of [0, 19999, 20000, 20999, 21000, 22000, Infinity]) {
      const rows = await scores.virtualScores(c, problems, elapsed);
      assert.deepEqual(rows, expectedScores(rule, official, replay, elapsed), `${rule} at ${elapsed}ms`);
    }
  }
  const strict = await scores.virtualScores({ ...contest, rule: "strictioi" }, problems);
  const entry = strict.find(row => row.userId === 9).problems[5];
  assert.equal(entry.score, 100);
  assert.equal(entry.versions, 2);
  assert.deepEqual(entry.subtasks.map(s => s.submissionId), [10, 9]);
});

test("the contest submission query uses the same half-open windows and exact elapsed cutoff as the scores", async t => {
  const { runner } = await fixture(t);
  const idsAt = async elapsed => {
    const query = runner.manager.getRepository(SubmissionEntity).createQueryBuilder("s")
      .select("s.id").where("s.contestId = :id", { id: contest.id });
    const rows = await applyContestElapsedCutoff(query, contest, elapsed).orderBy("s.id").getMany();
    return rows.map(row => row.id);
  };
  assert.deepEqual(await idsAt(19999), [1, 5, 8]);
  assert.deepEqual(await idsAt(20000), [1, 2, 5, 6, 8, 9]);
  assert.deepEqual(await idsAt(999999), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("each virtual score revision affects only the virtual cache; the exact prefix is shared", async t => {
  const { db, scores, runner, revision, outbox, queries, replay } = await fixture(t);
  const official = await scores.contestScores(contest, problems);
  const initialReads = queries.length;
  const [first, same] = await Promise.all([20000, 20500].map(elapsed => scores.virtualScores(contest, problems, elapsed)));
  assert.equal(first, same);
  assert.equal(queries.length, initialReads + 1, "one projected timeline for concurrent readers");
  const later = await scores.virtualScores(contest, problems, 21000);
  assert.notEqual(first, later);
  assert.equal(queries.length, initialReads + 1, "different elapsed times reuse the projected timeline");
  const virtualSubmission = { ...replay[1], contestId: contest.id, submitTime: at(virtualA, 20) };
  for (const status of ["Fake", "Pending", "Accepted"]) {
    db.prepare("UPDATE submission SET status=?, score=? WHERE id=6").run(status, status === "Accepted" ? 100 : 0);
    await outbox.record(runner.manager, virtualSubmission, { ...virtualSubmission, status });
    assert.equal(await revision.revision(contest.id), "0");
    assert.equal(await scores.contestScores(contest, problems), official);
    const refreshed = await scores.virtualScores(contest, problems, 20000);
    assert.equal(refreshed.find(row => row.userId === 7).score, status === "Accepted" ? 200 : 0);
  }
  // Official changes invalidate both scoreboards.
  revision.noteChange(runner.manager, contest.id);
  assert.notEqual(await scores.contestScores(contest, problems), official);
  assert.notEqual(await scores.virtualScores(contest, problems, 20000), first);
});

test("virtual cache bounds, expiry and Redis failure keep timelines fresh", async t => {
  const { scores, queries } = await fixture(t);
  for (const elapsed of [0, 19000, 20000, 21000, 22000, 23000, 239000]) {
    await scores.virtualScores(contest, problems, elapsed);
    await scores.virtualScores(contest, problems, elapsed, false);
  }
  const cache = scores.virtualCache.get(contest.id);
  assert.equal((await cache.scores).snapshots.size, 8);
  assert.equal(queries.length, 1);
  cache.at -= 61000;
  await scores.virtualScores(contest, problems);
  assert.equal(queries.length, 2);
  for (let id = 100; id < 110; id++) await scores.virtualScores({ ...contest, id }, problems);
  assert.equal(scores.virtualCache.size, 8);
  assert.equal(scores.virtualCache.has(contest.id), false);

  scores.scoreRevisions = { revision: async (_id, virtual) => {
    if (virtual) throw new Error("Redis unavailable");
    return "0";
  } };
  const before = queries.length;
  await scores.virtualScores(contest, problems, 20000);
  await scores.virtualScores(contest, problems, 20000);
  assert.equal(queries.length, before + 2);
  assert.equal(scores.virtualCache.has(contest.id), false);
});

test("ranklist defaults are byte-stable; presence, opt-in, active clocks, CSV, and rule secrecy go through the endpoints", async t => {
  const { db, scores, official, replay } = await fixture(t);
  const access = Object.assign(Object.create(ContestAccessService.prototype), {
    privileges: { userHasPrivilege: async () => true }
  });
  const viewer = { id: 7 };
  const c = { ...contest };
  const ctx = { contest: c, manager: false, now: +virtualB, virtualRun: null };
  access.get = async () => ctx;
  const service = Object.assign(Object.create(ContestService.prototype), {
    access, scores, contestProblems: { problemList: async () => problems },
    db: { getRepository: () => ({ findBy: async () => [2, 5, 7, 9].map(id => ({ id, username: "u" + id })) }) }
  });
  const endpoint = new ContestController(service);
  const body = rows => JSON.stringify({ problems, rows: rows.map(row => ({ ...row, username: "u" + row.userId })) });
  const expected = body(scoreContest(c.rule, start, problems, official));
  const ranklist = (data = {}) => endpoint.ranklist(viewer, { id: contest.id, data });
  assert.equal(JSON.stringify(await ranklist()), expected);
  assert.equal(JSON.stringify(await ranklist({ virtual: "true" })), expected);
  assert.equal(JSON.stringify(await ranklist({ virtual: true })), body(expectedScores(c.rule, official, replay)));
  assert.equal(JSON.stringify(await ranklist({ virtual: false })), expected);
  assert.equal(await scores.hasVirtualParticipants(c), true);
  const csv = () => endpoint.export(viewer, { id: contest.id, data: { virtual: true } }).then(result => result.csv);
  assert.doesNotMatch(await csv(), /"u7"|"u9"/);
  Object.assign(ctx, { now: +at(start, 20), virtualRun: { startTime: virtualA, endTime: at(virtualA, 240) } });
  assert.equal(JSON.stringify(await ranklist()), body(expectedScores(c.rule, official, replay, 20000)));
  const partial = await csv();
  assert.match(partial, /"u2"/);
  assert.doesNotMatch(partial, /"u5"|"u7"|"u9"/, "neither future official rows nor virtual rows in the export");
  for (const rule of ["strictioi", "noi"]) {
    c.rule = rule;
    await assert.rejects(ranklist({ virtual: true }), /Ranklist is hidden/);
    await assert.rejects(csv(), /Ranklist is hidden/);
  }
  db.exec("DELETE FROM submission WHERE submitterId IN (7,9);");
  assert.equal(await scores.hasVirtualParticipants(c), false, "an empty run has no ranked row");
});
