// Run: node --test apps/backend/src/contest/contest-policy.test.cjs
// What each contest rule shows to whom before, during and after the contest (contest-policy.ts). The tables are the
// rules' secrecy written out: NOI shows participants only whether their submissions compiled until the end, Strict
// IOI hides the scoreboard but shows participants their own results, IOI and ACM have live scoreboards, and only ACM
// shows everyone's submissions while it runs. Managers see everything.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText,
    filename
  );
const policy = require("./contest-policy.ts");

const HOUR = 3600000;
const now = Date.UTC(2026, 9, 19, 12);
const PHASES = {
  before: { startTime: new Date(now + HOUR), endTime: new Date(now + 2 * HOUR) },
  running: { startTime: new Date(now - HOUR), endTime: new Date(now + HOUR) },
  ended: { startTime: new Date(now - 2 * HOUR), endTime: new Date(now - HOUR) }
};
const RULES = ["noi", "ioi", "acm", "strictioi"];
const contest = (rule, phase, extra = {}) => ({ rule, ruleOptions: {}, hideStatistics: false, ...PHASES[phase], ...extra });

// For a participant who doesn't manage the contest: [before, running, ended]
const participant = {
  problems: { noi: [0, 1, 1], ioi: [0, 1, 1], acm: [0, 1, 1], strictioi: [0, 1, 1] },
  submit: { noi: [0, 1, 0], ioi: [0, 1, 0], acm: [0, 1, 0], strictioi: [0, 1, 0] },
  // Statistics before the start are never shown: the contest page has no problems to show them on
  statistics: { noi: [0, 0, 1], ioi: [1, 1, 1], acm: [1, 1, 1], strictioi: [0, 0, 1] },
  scoreboard: { noi: [0, 0, 1], ioi: [1, 1, 1], acm: [1, 1, 1], strictioi: [0, 0, 1] },
  everyonesSubmissions: { noi: [0, 0, 1], ioi: [0, 0, 1], acm: [1, 1, 1], strictioi: [0, 0, 1] },
  ownResults: { noi: [0, 0, 1], ioi: [1, 1, 1], acm: [0, 0, 1], strictioi: [1, 1, 1] },
  othersResults: { noi: [0, 0, 1], ioi: [0, 0, 1], acm: [0, 0, 1], strictioi: [0, 0, 1] },
  onlyWhetherCompiled: { noi: [1, 1, 0], ioi: [0, 0, 0], acm: [0, 0, 0], strictioi: [0, 0, 0] },
  // A hack's input, messages and results, unless they made it
  hackDetailsHidden: { noi: [1, 1, 0], ioi: [0, 0, 0], acm: [0, 0, 0], strictioi: [1, 1, 0] }
};
const own = { submitterId: 7, status: "WrongAnswer" };
const others = { submitterId: 8, status: "WrongAnswer" };
const viewer = { manager: false, userId: 7 };
const actual = {
  problems: c => policy.contestProblemsOpen(c, false, now),
  submit: c => policy.contestSubmissionsOpen(c, false, now),
  statistics: c => policy.contestStatisticsVisible(c, false, now),
  scoreboard: c => policy.contestScoreboardOpen(c, false, now),
  everyonesSubmissions: c => policy.contestSubmissionsPublic(c, false, now),
  ownResults: c => policy.contestSubmissionVisibility(c, own, viewer, now).results,
  othersResults: c => policy.contestSubmissionVisibility(c, others, viewer, now).results,
  onlyWhetherCompiled: c =>
    policy.contestOwnResult({ submissionId: 1, status: "Accepted", score: 100 }, c, false, now).status === "Compiled",
  hackDetailsHidden: c => policy.contestHackDetailsHidden(c, now)
};

for (const [what, byRule] of Object.entries(participant))
  test(`participants: ${what}`, () => {
    for (const rule of RULES)
      ["before", "running", "ended"].forEach((phase, index) =>
        assert.equal(actual[what](contest(rule, phase)), !!byRule[rule][index], `${rule}, ${phase}`)
      );
  });

test("managers see and may do everything at any time", () => {
  for (const rule of RULES)
    for (const phase of Object.keys(PHASES)) {
      const c = contest(rule, phase, { hideStatistics: true });
      for (const check of [
        policy.contestProblemsOpen,
        policy.contestSubmissionsOpen,
        policy.contestStatisticsVisible,
        policy.contestScoreboardOpen,
        policy.contestSubmissionsPublic
      ])
        assert.equal(check(c, true, now), true, `${check.name}: ${rule}, ${phase}`);
      assert.deepEqual(policy.contestSubmissionVisibility(c, others, { manager: true, userId: 1 }, now), {
        visible: true,
        code: true,
        results: true,
        compile: true
      });
      const entry = { submissionId: 1, status: "Accepted", score: 100 };
      assert.equal(policy.contestOwnResult(entry, c, true, now), entry);
    }
});

test("a participant sees their own code and someone else's submission only when everyone's are shown", () => {
  for (const rule of RULES)
    for (const phase of Object.keys(PHASES)) {
      const c = contest(rule, phase);
      const mine = policy.contestSubmissionVisibility(c, own, viewer, now);
      assert.equal(mine.visible, true);
      assert.equal(mine.code, true);
      const theirs = policy.contestSubmissionVisibility(c, others, viewer, now);
      assert.equal(theirs.visible, policy.contestSubmissionsPublic(c, false, now), `${rule}, ${phase}`);
      assert.equal(theirs.code, false);
      assert.equal(theirs.compile, false);
      // Signed out: nothing is their own
      const anonymous = policy.contestSubmissionVisibility(c, own, { manager: false }, now);
      assert.equal(anonymous.code, false);
      assert.equal(anonymous.visible, policy.contestSubmissionsPublic(c, false, now));
    }
});

test("participants see the compiler's output of their own submissions only when compilation failed", () => {
  const c = contest("noi", "running");
  assert.equal(policy.contestSubmissionVisibility(c, own, viewer, now).compile, false);
  assert.equal(policy.contestSubmissionVisibility(c, { ...own, status: "CompilationError" }, viewer, now).compile, true);
});

test("in a running NOI contest, own results show only compiled, compilation error or pending", () => {
  const c = contest("noi", "running");
  for (const [status, shown] of [
    ["Accepted", "Compiled"],
    ["WrongAnswer", "Compiled"],
    ["PartiallyCorrect", "Compiled"],
    ["CompilationError", "CompilationError"],
    ["Pending", "Pending"]
  ])
    assert.deepEqual(policy.contestOwnResult({ submissionId: 3, status, score: 40, subtasks: [] }, c, false, now), {
      submissionId: 3,
      status: shown
    });
});

test("a contest that hides its statistics shows them only after the end", () => {
  for (const rule of RULES) {
    assert.equal(policy.contestStatisticsVisible(contest(rule, "running", { hideStatistics: true }), false, now), false);
    assert.equal(policy.contestStatisticsVisible(contest(rule, "ended", { hideStatistics: true }), false, now), true);
  }
});

test("hacks: only when enabled, after the end for hidden scoreboards, inside the hack window", () => {
  const window = (rule, phase, options) => policy.contestHackWindow(contest(rule, phase, { ruleOptions: options }), false, now);
  assert.deepEqual(window("acm", "ended", {}), { allowed: false, reason: "Hacks are disabled for this contest" });
  assert.deepEqual(window("acm", "ended", { hackEnabled: true }), { allowed: true });
  for (const rule of ["noi", "strictioi"])
    assert.deepEqual(window(rule, "running", { hackEnabled: true, hackStartTime: PHASES.running.startTime.toISOString() }), {
      allowed: false,
      reason: "Hacks open after the contest ends"
    });
  // Live scoreboards: from the window's start (the contest's end unless set) until its end, if set
  for (const rule of ["ioi", "acm"]) {
    assert.deepEqual(window(rule, "running", { hackEnabled: true }), { allowed: false, reason: "The hack window is closed" });
    assert.deepEqual(window(rule, "running", { hackEnabled: true, hackStartTime: new Date(now - 1).toISOString() }), {
      allowed: true
    });
  }
  assert.deepEqual(window("noi", "ended", { hackEnabled: true, hackEndTime: new Date(now).toISOString() }), {
    allowed: false,
    reason: "The hack window is closed"
  });
  assert.deepEqual(policy.contestHackWindow(contest("noi", "running", { ruleOptions: { hackEnabled: true } }), true, now), {
    allowed: true
  });
});
