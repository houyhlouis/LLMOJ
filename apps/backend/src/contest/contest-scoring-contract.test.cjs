// The scoring contract of strict IOI (review N04, N05): subtask results combine only within one data version and one
// subtask layout; acceptance needs full credit in every subtask, never a total that rounds to 100; the best
// combination is chosen by its exact score. Ranks are shared by equal scores and penalties.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { test } = require("node:test");

const filename = path.join(__dirname, "contest-scoring.ts");
const loaded = new Module(filename, module);
loaded._compile(
  ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText,
  filename
);
const { scoreContest } = loaded.exports;

const start = new Date("2026-01-01T00:00:00Z");
const problems = [{ id: 1, weight: 1 }];
const sub = (
  id,
  subtasks,
  { version = 1, user = 1, status = "PartiallyCorrect", score = null, seconds = id } = {}
) => ({
  id,
  submitterId: user,
  contestProblemId: 1,
  submitTime: new Date(+start + seconds * 1000),
  status,
  score: score ?? Math.round(subtasks.reduce((sum, s) => sum + s.score, 0)),
  problemDataVersionId: version,
  subtasks
});
const half = (first, second) => [
  { score: first, fullScore: 50 },
  { score: second, fullScore: 50 }
];
const strict = submissions => scoreContest("strictioi", start, problems, submissions)[0].problems[1];

test("a total of 99.6 shows as 100 but isn't Accepted (review reproduction)", () => {
  const entry = strict([sub(1, half(50, 49.6))]);
  assert.equal(entry.score, 100);
  assert.equal(entry.status, "PartiallyCorrect");
  const full = strict([sub(1, half(50, 49.6)), sub(2, half(0, 50))]);
  assert.equal(full.status, "Accepted");
  assert.deepEqual(
    full.subtasks.map(s => s.submissionId),
    [1, 2]
  );
});

test("results of two data versions never add up, even with the same subtask weights (review reproduction)", () => {
  const entry = strict([sub(1, half(50, 0), { version: 1 }), sub(2, half(0, 50), { version: 2 })]);
  assert.equal(entry.score, 50);
  assert.notEqual(entry.status, "Accepted");
  assert.equal(entry.submissionId, 1, "the earlier of two equal combinations stays");
  assert.equal(entry.versions, 2, "the entry says results of another version don't count");
  // The same results within one version combine
  const same = strict([sub(1, half(50, 0), { version: 2 }), sub(2, half(0, 50), { version: 2 })]);
  assert.equal(same.score, 100);
  assert.equal(same.status, "Accepted");
  assert.equal(same.versions, undefined);
});

test("a new version's better combination replaces the old one; a worse one doesn't", () => {
  const better = strict([
    sub(1, half(50, 0), { version: 1 }),
    sub(2, half(50, 10), { version: 2 }),
    sub(3, half(0, 50), { version: 2 })
  ]);
  assert.equal(better.score, 100);
  assert.deepEqual(
    better.subtasks.map(s => s.submissionId),
    [2, 3]
  );
  const worse = strict([sub(1, half(50, 20), { version: 1 }), sub(2, half(10, 10), { version: 2 })]);
  assert.equal(worse.score, 70);
  assert.equal(worse.submissionId, 1);
});

test("reordered subtasks of a changed problem with equal weights don't combine", () => {
  // Version 2 swapped the subtasks: each submission solved "the easy one"
  const entry = strict([
    sub(
      1,
      [
        { score: 30, fullScore: 50 },
        { score: 0, fullScore: 50 }
      ],
      { version: 1 }
    ),
    sub(
      2,
      [
        { score: 0, fullScore: 50 },
        { score: 30, fullScore: 50 }
      ],
      { version: 2 }
    )
  ]);
  assert.equal(entry.score, 30);
});

test("results from before data versions combine only with each other, as before", () => {
  const entry = strict([sub(1, half(50, 0), { version: null }), sub(2, half(0, 50), { version: null })]);
  assert.equal(entry.score, 100);
  assert.equal(strict([sub(1, half(50, 0), { version: null }), sub(2, half(0, 50), { version: 3 })]).score, 50);
});

test("the best combination is chosen by its exact score, not the rounded one", () => {
  const entry = strict([sub(1, half(50, 49.6), { version: 1 }), sub(2, half(50, 49.8), { version: 2 })]);
  assert.equal(entry.score, 100);
  assert.equal(entry.submissionId, 2);
  assert.deepEqual(
    entry.subtasks.map(s => s.score),
    [50, 49.8]
  );
});

test("rounding boundaries, weights that aren't whole numbers and empty layouts", () => {
  assert.equal(strict([sub(1, half(50, 49.4))]).score, 99);
  assert.equal(strict([sub(1, half(50, 49.5))]).score, 100);
  assert.equal(strict([sub(1, half(0, 0.2))]).score, 0);
  assert.equal(strict([sub(1, half(0, 0.2))]).status, "PartiallyCorrect", "some credit, though it rounds to 0");
  const third = 100 / 3;
  const thirds = [0, 1, 2].map(() => ({ score: (third * 100) / 100, fullScore: third }));
  assert.equal(strict([sub(1, thirds)]).status, "Accepted");
  const empty = strict([sub(1, [{ score: 0, fullScore: 0 }], { status: "WrongAnswer", score: 1 })]);
  assert.equal(empty.score, 0);
  assert.notEqual(empty.status, "Accepted");
});

test("results without subtasks count as Accepted only if their submission was", () => {
  const legacy = (id, status, score) => ({ ...sub(id, [], { status, score }), subtasks: undefined });
  assert.equal(strict([legacy(1, "PartiallyCorrect", 100)]).status, "PartiallyCorrect");
  const later = strict([legacy(1, "PartiallyCorrect", 100), legacy(2, "Accepted", 100)]);
  assert.equal(later.status, "Accepted");
  assert.equal(later.submissionId, 2);
});

test("ranks are shared by equal score and penalty, also with many rows", () => {
  const many = Array.from({ length: 3000 }, (_, i) => ({
    id: i + 1,
    submitterId: i + 1,
    contestProblemId: 1,
    submitTime: new Date(+start + 1000),
    status: i % 3 ? "Accepted" : "WrongAnswer",
    score: i % 3 ? 100 : 0
  }));
  const started = Date.now();
  const rows = scoreContest("ioi", start, problems, many);
  assert(Date.now() - started < 1000, "ranking 3,000 rows takes well under a second");
  assert.deepEqual([...new Set(rows.map(row => row.rank))], [1, 2001]);
  assert.equal(rows.filter(row => row.rank === 1).length, 2000);
});
