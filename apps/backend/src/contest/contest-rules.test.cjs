const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { test } = require("node:test");
function load(file) {
  const filename = path.join(__dirname, file);
  const loaded = new Module(filename, module);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, filename);
  return loaded.exports;
}
const { scoreContest } = load("contest-scoring.ts");
const { CONTEST_RULES, isContestRule, normalizeContestRuleOptions, contestHasBlindFeedback, contestHasLiveScoreboard, contestHasDetailedSelfFeedback } = load("contest-rules.ts");
const { contestSubmissionFeedback } = load("contest-feedback.ts");
const start = new Date("2026-01-01T00:00:00Z");
const end = new Date(+start + 72 * 3600000);
const problems = [{ id: 1, weight: 1 }, { id: 2, weight: 2 }];
const sub = (id, seconds, status, score, user = 1, problem = 1, subtasks) => ({ id, submitTime: new Date(+start + seconds * 1000), submitterId: user, contestProblemId: problem, status, score, subtasks });

test("stored contest rules preserve NOI, IOI and ICPC and add only Strict IOI", () => {
  assert.deepEqual(CONTEST_RULES, ["noi", "ioi", "acm", "strictioi"]);
  for (const rule of CONTEST_RULES) assert.equal(isContestRule(rule), true);
  assert.equal(isContestRule("unknown"), false);
  assert.equal(isContestRule(null), false);
});

test("NOI is the OI format and conceals scores while compilation feedback remains visible", () => {
  assert.equal(contestHasBlindFeedback("noi"), true);
  assert.equal(contestSubmissionFeedback(sub(1, 10, "Accepted", 100), "noi", false, false).status, "Compiled");
  assert.equal(contestSubmissionFeedback(sub(1, 10, "Accepted", 100), "noi", false, false).score, null);
  assert.equal(contestSubmissionFeedback(sub(1, 10, "CompilationError", 0), "noi", false, false).status, "CompilationError");
  assert.equal(contestHasLiveScoreboard("noi"), false);
  assert.equal(contestHasDetailedSelfFeedback("noi"), false);
});

test("Strict IOI provides live self feedback while its scoreboard remains hidden", () => {
  assert.equal(contestHasBlindFeedback("strictioi"), false);
  assert.equal(contestHasDetailedSelfFeedback("strictioi"), true);
  assert.equal(contestHasLiveScoreboard("strictioi"), false);
  assert.equal(contestSubmissionFeedback(sub(1, 10, "PartiallyCorrect", 60), "strictioi", false, false).score, 60);
  for (const rule of ["ioi", "acm"]) assert.equal(contestHasLiveScoreboard(rule), true);
});

test("Strict IOI merges independent subtask maxima and applies problem weights", () => {
  const a = [{ score: 40, fullScore: 40 }, { score: 0, fullScore: 60 }];
  const b = [{ score: 0, fullScore: 40 }, { score: 60, fullScore: 60 }];
  const rows = scoreContest("strictioi", start, problems, [sub(1, 10, "PartiallyCorrect", 40, 1, 2, a), sub(2, 20, "PartiallyCorrect", 60, 1, 2, b)]);
  assert.equal(rows[0].score, 200);
  assert.equal(rows[0].problems[2].status, "Accepted");
  assert.deepEqual(rows[0].problems[2].subtasks.map(st => st.submissionId), [1, 2]);
  assert.equal(rows[0].problems[2].submissionId, 2);
});

test("Strict IOI ignores invalidated original evidence and retains independently valid scores", () => {
  const a = [{ score: 40, fullScore: 40 }, { score: 0, fullScore: 60 }];
  const b = [{ score: 0, fullScore: 40 }, { score: 60, fullScore: 60 }];
  for (const status of ["Fake", "Hacked"]) {
    const row = scoreContest("strictioi", start, problems, [sub(1, 10, "PartiallyCorrect", 40, 1, 2, a), sub(2, 20, status, 100, 1, 2, b)])[0];
    assert.equal(row.score, 80);
    assert.equal(row.problems[2].submissionId, 1);
  }
});

test("Strict IOI pending, compilation failures and equal scores cannot erase a better subtask", () => {
  const a = [{ score: 40, fullScore: 40 }, { score: 20, fullScore: 60 }];
  const rows = scoreContest("strictioi", start, problems, [sub(1, 10, "PartiallyCorrect", 60, 1, 1, a), sub(2, 20, "Pending", null), sub(3, 30, "CompilationError", null), sub(4, 40, "PartiallyCorrect", 60, 1, 1, a)]);
  assert.equal(rows[0].score, 60);
  assert.equal(rows[0].problems[1].submissionId, 1);
  assert.deepEqual(rows[0].problems[1].subtasks.map(st => st.submissionId), [1, 1]);
});

test("Strict IOI does not combine different subtask layouts and recovers after compile-only attempts", () => {
  const rows = scoreContest("strictioi", start, problems, [sub(1, 1, "CompilationError", 0),
    sub(2, 10, "PartiallyCorrect", 40, 1, 1, [{score: 40, fullScore: 40}, {score: 0, fullScore: 60}]),
    sub(3, 20, "PartiallyCorrect", 40, 1, 1, [{score: 0, fullScore: 60}, {score: 40, fullScore: 40}])]);
  assert.equal(rows[0].score, 40);
  const next = scoreContest("strictioi", start, problems, [
    sub(1, 1, "PartiallyCorrect", 60),
    sub(2, 10, "PartiallyCorrect", 40, 1, 1, [{score: 40, fullScore: 40}, {score: 0, fullScore: 60}]),
    sub(3, 20, "PartiallyCorrect", 60, 1, 1, [{score: 0, fullScore: 40}, {score: 60, fullScore: 60}])]);
  assert.equal(next[0].score, 100);
});

test("Strict IOI identical total scores share rank regardless of completion time", () => {
  const rows = scoreContest("strictioi", start, problems, [sub(1, 10, "Accepted", 100), sub(2, 30, "Accepted", 100, 2), sub(3, 50, "PartiallyCorrect", 60, 3)]);
  assert.deepEqual(rows.map(row => [row.userId, row.rank]), [[1, 1], [2, 1], [3, 3]]);
});

test("all formats force invalidated effective scores to zero even if stored evidence is nonzero", () => {
  for (const rule of CONTEST_RULES) for (const status of ["Fake", "Hacked"]) assert.equal(scoreContest(rule, start, problems, [sub(1, 10, status, 100)])[0].score, 0, `${rule}: ${status}`);
  assert.equal(scoreContest("ioi", start, problems, [sub(1, 10, "Accepted", 100, 1, 999) ]).length, 0, "foreign problem rows never affect scores");
});

test("feature options validate switches, hack windows and the whole-contest self-evaluation quota", () => {
  assert.deepEqual(normalizeContestRuleOptions(null, start, end), {});
  assert.deepEqual(normalizeContestRuleOptions({ selfEvalEnabled: true, selfEvalMaxAttempts: 30, hackEnabled: false }, start, end), { selfEvalEnabled: true, selfEvalMaxAttempts: 30, hackEnabled: false });
  for (const value of [1, 1000]) assert.equal(normalizeContestRuleOptions({ selfEvalMaxAttempts: value }, start, end).selfEvalMaxAttempts, value);
  for (const bad of [{ hiddenAdmin: true }, { selfEvalMaxAttempts: 0 }, { selfEvalMaxAttempts: 1001 }, { selfEvalMaxAttempts: 1.5 }, { selfEvalEnabled: "true" }, { hackEnabled: "true" }, { hackStartTime: "invalid" }, { hackStartTime: end.toISOString(), hackEndTime: start.toISOString() }]) assert.throws(() => normalizeContestRuleOptions(bad, start, end));
});


test("Self Eval options are available only in NOI and are removed when changing to another format", () => {
  for(const rule of ["ioi","strictioi","acm"]) assert.deepEqual(normalizeContestRuleOptions({selfEvalEnabled:true,selfEvalMaxAttempts:30,hackEnabled:true},start,end,rule),{hackEnabled:true});
  assert.deepEqual(normalizeContestRuleOptions({selfEvalEnabled:true,selfEvalMaxAttempts:30},start,end,"noi"),{selfEvalEnabled:true,selfEvalMaxAttempts:30});
});
