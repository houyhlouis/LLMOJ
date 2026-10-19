// Run: node --test apps/backend/src/contest/contest-boundaries.test.cjs
// Who owns what in the contest module, so the split stays a split:
// - contest-policy.ts decides what each contest rule shows to whom, and when;
// - ContestAccessService makes every privilege check on contests;
// - ContestScoreService computes and keeps the scores; ContestProblemService and ContestSubmissionService own a
//   contest's problems and submissions; ContestService the contests themselves. None of them depends on ContestService.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const src = path.join(__dirname, "..");

const read = relative => fs.readFileSync(path.join(src, relative), "utf8");
const SERVICES = [
  "contest/contest-access.service.ts",
  "contest/contest-score.service.ts",
  "contest/contest-problem.service.ts",
  "contest/contest-submission.service.ts",
  "contest/contest.service.ts"
];
function sourceFiles(directory = src) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [file] : [];
  });
}

test("no contest service depends on ContestService", () => {
  for (const file of SERVICES.filter(file => file !== "contest/contest.service.ts"))
    assert.doesNotMatch(read(file), /from "\.\/contest\.service"/, file);
  // Outside the module, only the controller uses it
  const users = sourceFiles().filter(file => /from "(\.\.\/contest|\.)\/contest\.service"/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(users.map(file => path.relative(src, file)).sort(), ["contest/contest.controller.ts", "contest/contest.module.ts"]);
});

test("only ContestAccessService checks privileges on contests", () => {
  for (const file of SERVICES) {
    const uses = /privileges\.|UserPrivilegeService\b/.test(read(file));
    assert.equal(uses, file === "contest/contest-access.service.ts", file);
  }
});

test("the contest manager rule is written once", () => {
  const writers = sourceFiles().filter(file => /adminIds\.includes\(/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(writers.map(file => path.relative(src, file)), ["contest/contest-manager.ts"]);
  assert.match(read("contest/contest-access.service.ts"), /isContestManager\(/);
  assert.match(read("submission/submission-access.service.ts"), /isContestManager\(/);
});

test("the contest rules' secrecy is decided in contest-policy.ts", () => {
  // The rules' properties are read only there (and defined in contest-rules.ts)
  const readers = sourceFiles().filter(file =>
    /contestHas(BlindFeedback|LiveScoreboard|DetailedSelfFeedback)\(/.test(fs.readFileSync(file, "utf8"))
  );
  assert.deepEqual(readers.map(file => path.relative(src, file)).sort(), ["contest/contest-policy.ts", "contest/contest-rules.ts"]);
  // Nothing else compares the time with a contest's start or end
  const timing = /Date\.now\(\)\s*[<>]=?\s*\+?[\w.]*contest\.(startTime|endTime)|\+?[\w.]*contest\.(startTime|endTime)\s*[<>]=?\s*Date\.now\(\)/;
  const comparing = sourceFiles().filter(file => timing.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(comparing.map(file => path.relative(src, file)), []);
});

test("hacks show contest submissions to the same viewers as the contest does", () => {
  const hacks = read("hack/hack.service.ts");
  assert.match(hacks, /contestSubmissionVisibility\(/);
  assert.match(hacks, /contestSubmissions\.submissionDetail\(/);
  assert.doesNotMatch(hacks, /rule (!==|===) "acm"|\["noi", "strictioi"\]/);
});

test("scores are computed only by ContestScoreService", () => {
  const scorers = sourceFiles().filter(file => /scoreContest\(/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(scorers.map(file => path.relative(src, file)).sort(), [
    "contest/contest-score.service.ts",
    "contest/contest-scoring.ts"
  ]);
});
