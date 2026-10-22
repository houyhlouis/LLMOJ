/* Run with the judge's installed dependencies: node --test apps/judge/src/checkers/score.test.cjs. */
// A checker's score is its whole first token (review N06): testlib's points may be decimal, Lemon and legacy scores
// are whole numbers, and anything malformed or above 100 is the checker's failure, never a truncated score.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const loaded = new Map();
function load(file, overrides = {}) {
  if (loaded.has(file)) return loaded.get(file).exports;
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const module = { exports: {} };
  loaded.set(file, module);
  const resolve = name => {
    const base = path.resolve(path.dirname(file), name);
    return [`${base}.ts`, path.join(base, "index.ts")].find(candidate => fs.existsSync(candidate));
  };
  new Function("require", "module", "exports", "__dirname", source)(
    name => (name in overrides ? overrides[name] : name.startsWith(".") ? load(resolve(name)) : require(name)),
    module,
    module.exports,
    path.dirname(file)
  );
  return module.exports;
}

const { parseCheckerScore, parseTestlibMessage } = load(path.join(__dirname, "index.ts"));
const score = message => {
  const result = parseTestlibMessage(message);
  return typeof result === "string" ? result : result.score;
};

test("testlib's points: the whole number, decimal or not, from 0 to 100", () => {
  for (const [message, expected] of [
    ["points 37", 37],
    ["points 37.5", 37.5],
    ["points 37.5 partial answer", 37.5],
    ["points 0", 0],
    ["points 100", 100],
    ["points 100.0", 100],
    ["points 0.0000000001", 0.0000000001],
    ["points 42\n", 42]
  ])
    assert.equal(score(message), expected, message);
});

test("malformed or out-of-range points are the checker's failure, not a truncated score", () => {
  for (const message of [
    "points 37abc",
    "points 37.5.1",
    "points 1e2",
    "points -5",
    "points NaN",
    "points Infinity",
    "points .5",
    "points 5.",
    "points",
    "points ",
    "points\t37",
    "points37"
  ]) {
    const result = parseTestlibMessage(message);
    assert.equal(typeof result, "string", message);
    assert.match(result, /^Couldn't parse testlib's message: /, message);
  }
  for (const message of ["points 100.9", "points 101", "points 1000000"])
    assert.match(parseTestlibMessage(message), /^Got an invalid score from testlib's message: /, message);
});

test("partially correct (N) is N / 2; other verdicts are as before", () => {
  assert.equal(score("partially correct (75) close"), 37.5);
  assert.equal(score("partially correct (200)"), 100);
  assert.match(parseTestlibMessage("partially correct (201)"), /invalid score/);
  assert.match(parseTestlibMessage("partially correct (75x)"), /Couldn't parse/);
  assert.equal(score("ok 3 numbers"), 100);
  assert.equal(score("wrong answer 1st differs"), 0);
  assert.equal(score("wrong output format Expected integer"), 0);
  const fail = parseTestlibMessage("FAIL answer file is broken");
  assert.equal(fail.score, undefined, "FAIL is a judgement failure");
  assert.match(parseTestlibMessage("unknown verdict"), /Couldn't parse/);
  assert.match(parseTestlibMessage(""), /\(empty\)/);
});

test("Lemon and legacy scores are whole numbers: the first token, from 0 to 100", () => {
  for (const [text, expected] of [
    ["100", 100],
    ["37\n", 37],
    ["  42  ", 42],
    ["0", 0],
    ["88 points", 88],
    ["37.5", "malformed"],
    ["37abc", "malformed"],
    ["-1", "malformed"],
    ["1e2", "malformed"],
    ["", "malformed"],
    ["101", "range"],
    ["100.9", "malformed"]
  ])
    assert.equal(parseCheckerScore(text, false), expected, JSON.stringify(text));
});

test("a testlib checker that reports success must also exit successfully", async () => {
  // simple-sandbox's statuses (the module itself only loads in the judge's systemd unit)
  const SandboxStatus = { OK: 1, RuntimeError: 3, 1: "OK", 3: "RuntimeError" };
  const { checker } = load(path.join(__dirname, "custom/testlib.ts"), {
    "simple-sandbox": { SandboxStatus },
    uuid: { v4: () => "message" },
    "../../utils": {
      safelyJoinPath: (directory, name) => ({
        inside: `${directory.inside}/${name}`,
        outside: `${directory.outside}/${name}`
      })
    },
    "../../omittableString": {
      omittableStringToString: value => value,
      readFileOmitted: async () => messages.shift()
    }
  });
  const messages = [];
  const run = async (status, code, message) => {
    messages.push(message);
    return checker.runChecker(
      {},
      { inside: "/in" },
      { inside: "/out" },
      { inside: "/ans" },
      null,
      { inside: "/w", outside: "/tmp" },
      async () => ({ status, code, termination: "exited" })
    );
  };
  assert.equal((await run(SandboxStatus.OK, 0, "ok fine")).score, 100);
  assert.match(await run(SandboxStatus.RuntimeError, 1, "ok fine"), /reported success but exited with code 1/);
  assert.equal((await run(SandboxStatus.RuntimeError, 7, "points 37.5 half")).score, 37.5);
  assert.match(await run(SandboxStatus.RuntimeError, 7, "points 37abc"), /Couldn't parse/);
});
