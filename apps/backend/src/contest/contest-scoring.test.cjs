const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const ts = require("typescript");
const filename = require("node:path").join(__dirname, "contest-scoring.ts");
const moduleObject = new Module(filename, module);
moduleObject._compile(
  ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText,
  filename
);
const { scoreContest } = moduleObject.exports;
const start = new Date("2026-01-01T00:00:00Z");
const problems = [
  { id: 1, weight: 1 },
  { id: 2, weight: 2 }
];
const submission = (id, user, problem, seconds, status, score) => ({
  id,
  submitterId: user,
  contestProblemId: problem,
  submitTime: new Date(+start + seconds * 1000),
  status,
  score
});
const runs = [
  submission(1, 1, 1, 100, "Accepted", 100),
  submission(2, 1, 1, 200, "WrongAnswer", 0),
  submission(3, 1, 2, 250, "PartiallyCorrect", 40)
];
assert.equal(
  scoreContest("noi", start, problems, runs)[0].score,
  80,
  "NOI uses the last attempt even when it is worse"
);
assert.equal(
  scoreContest("ioi", start, problems, runs)[0].score,
  180,
  "IOI uses the best score and per-problem weights"
);
assert.equal(
  scoreContest("noi", start, problems, [...runs, submission(4, 1, 2, 300, "Pending", null)])[0].score,
  0,
  "NOI pending last attempts do not retain an old score"
);
const icpc = [
  submission(1, 1, 1, 60, "CompilationError", 0),
  submission(2, 1, 1, 120, "WrongAnswer", 0),
  submission(3, 1, 1, 181, "Accepted", 100),
  submission(4, 1, 1, 240, "WrongAnswer", 0)
];
const acm = scoreContest("acm", start, problems, icpc)[0];
assert.equal(acm.score, 1);
assert.equal(acm.penalty, 1381, "ICPC excludes compilation errors and attempts after AC; keeps second precision");
assert.equal(acm.problems[1].wrong, 1);
const tie = [
  submission(1, 1, 1, 122, "Accepted", 100),
  submission(2, 2, 1, 121, "Accepted", 100),
  submission(3, 3, 1, 121, "Accepted", 100)
];
assert.deepEqual(
  scoreContest("ioi", start, problems, tie).map(r => [r.userId, r.rank]),
  [
    [2, 1],
    [3, 1],
    [1, 3]
  ],
  "IOI ties use scoring-attempt time, with shared ranks"
);
assert.deepEqual(
  scoreContest("acm", start, problems, []).map(r => r.rank),
  []
);
assert.equal(scoreContest("ioi", start, problems, [submission(1, 1, 1, 100, "Pending", null)])[0].score, 0);
const auditStart = new Date("2026-10-01T04:25:00Z");
const auditSubmissions = [
  {
    id: 32,
    submitterId: 5,
    contestProblemId: 3,
    submitTime: new Date("2026-10-01T04:43:19Z"),
    status: "CompilationError",
    score: 0
  },
  {
    id: 33,
    submitterId: 5,
    contestProblemId: 3,
    submitTime: new Date("2026-10-01T04:43:25Z"),
    status: "WrongAnswer",
    score: 0
  },
  {
    id: 34,
    submitterId: 5,
    contestProblemId: 3,
    submitTime: new Date("2026-10-01T04:43:30Z"),
    status: "Accepted",
    score: 100
  }
];
const auditScore = scoreContest("acm", auditStart, [{ id: 3, weight: 1 }], auditSubmissions)[0];
assert.equal(auditScore.score, 1);
assert.equal(
  auditScore.penalty,
  2310,
  "Real audit CE(score=0), WA, AC fixture must incur exactly one 20-minute penalty"
);
assert.equal(auditScore.problems[3].wrong, 1);
for (const score of [0, null]) {
  const row = scoreContest("acm", start, problems, [submission(1, 1, 1, 60, "CompilationError", score)])[0];
  assert.equal(
    row.problems[1].wrong,
    0,
    "Compilation errors never count as wrong attempts, regardless of score storage"
  );
  assert.equal(row.penalty, 0);
}
console.log("Contest scoring regression assertions passed.");
const feedbackFile = require("node:path").join(__dirname, "contest-feedback.ts");
const feedbackModule = new Module(feedbackFile, module);
feedbackModule._compile(
  ts.transpileModule(fs.readFileSync(feedbackFile, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText,
  feedbackFile
);
const { contestSubmissionFeedback } = feedbackModule.exports;
const full = {
  ...submission(10, 1, 1, 10, "Accepted", 100),
  codeLanguage: "cpp",
  timeUsed: 18,
  memoryUsed: 2048,
  taskId: "secret",
  input: "private testcase"
};
const blind = contestSubmissionFeedback(full, "noi", false, false);
assert.equal(blind.status, "Compiled");
assert.equal(blind.score, null);
assert.equal(blind.timeUsed, null);
assert.equal(blind.memoryUsed, null);
assert.equal("taskId" in blind, false);
assert.equal("input" in blind, false);
assert.equal(
  contestSubmissionFeedback({ ...full, status: "CompilationError", score: null }, "noi", false, false).status,
  "CompilationError"
);
assert.equal(contestSubmissionFeedback(full, "noi", true, false).score, 100);
assert.equal(contestSubmissionFeedback(full, "noi", false, true).score, 100);
assert.equal(contestSubmissionFeedback(full, "acm", false, false).score, null);
assert.equal(contestSubmissionFeedback(full, "ioi", false, false).score, 100);
console.log("Contest privacy: 11 assertions passed.");
