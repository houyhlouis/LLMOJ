/* Run: node --test apps/judge/src/aiQuality.test.cjs */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText,
    filename
  );
const { AiQuality, validateQuality, qualitySources } = require("./aiQuality.ts");
const cases = Array.from({ length: 5 }, (_, index) => ({ subtask: 1, seed: index + 1 }));
const request = (overrides = {}) => ({
  version: 1,
  fuzzCases: Array.from({ length: 64 }, (_, index) => ({ subtask: 1, seed: index })),
  smallMakeCode: "small-generator",
  oracleCode: "bruteforce",
  alternatives: [{ id: "alternative", code: "alternative-source" }],
  challenges: [
    { id: "off-by-one", code: "challenge-source", kind: "wrong", subtasks: [1], reason: "boundary failure" }
  ],
  extraAttempts: 8,
  ...overrides
});
const rejected = verdict => Object.assign(new Error(verdict), { qualityVerdict: verdict });
const fake = (overrides = {}) => ({
  execute: async (name, input, parameters) => {
    if (name === "quality-small-make") return Buffer.from(String((Number(parameters[1]) % 4) + 1));
    if (name === "quality-challenge-0" && Number(input.toString()) > 10) return Buffer.from("wrong");
    return Buffer.from(String(Number(input.toString()) * 2));
  },
  validate: async () => {},
  compare: async (input, actual, expected) => {
    if (!actual.equals(expected)) throw rejected("WA");
  },
  checkCanceled: () => {},
  progress: () => {},
  customChecker: false,
  ...overrides
});

test("quality contract requires independent sources, distinct seeds and every subtask", () => {
  validateQuality(request(), cases, "standard-source");
  assert.throws(() => validateQuality(request({ fuzzCases: request().fuzzCases.slice(0, 32) }), cases, "std"), /64/);
  assert.throws(() => validateQuality(request({ oracleCode: "std" }), cases, "std"), /independently/);
  assert.throws(
    () => validateQuality(request({ fuzzCases: Array(64).fill({ subtask: 1, seed: 1 }) }), cases, "std"),
    /distinct/
  );
  assert.throws(() => validateQuality(request(), [...cases, { subtask: 2, seed: 1 }], "std"), /every subtask/);
  assert.throws(() => validateQuality(request({ extraAttempts: 33 }), cases, "std"), /32/);
  assert.equal(qualitySources(request()).length, 4);
});

test("small differential testing rejects an incorrect standard even after passing samples", async () => {
  const environment = fake();
  const execute = environment.execute;
  environment.execute = async (name, input, parameters) =>
    name === "std" && input.toString() === "4" ? Buffer.from("0") : execute(name, input, parameters);
  const quality = new AiQuality(request(), environment);
  await quality.checkSample(Buffer.from("1"), Buffer.from("2"), 1);
  await assert.rejects(quality.runDifferential(), /WA/);
});

test("invalid small-case inputs stop verification before the oracle is trusted", async () => {
  const quality = new AiQuality(
    request(),
    fake({
      validate: async () => {
        throw new Error("validator rejected input");
      }
    })
  );
  await assert.rejects(quality.runDifferential(), /validator rejected/);
});

test("different valid multi-solution outputs are accepted through the checker", async () => {
  const environment = fake({
    customChecker: true,
    execute: async (name, input, parameters) =>
      name === "quality-small-make"
        ? Buffer.from(String(Number(parameters[1]) + 1))
        : Buffer.from(name === "quality-oracle" ? "1" : "2"),
    compare: async (input, actual) => {
      if (!["1", "2"].includes(actual.toString())) throw rejected("WA");
    }
  });
  const quality = new AiQuality(request(), environment);
  await quality.runDifferential();
  await quality.checkCorrect(Buffer.from("100"), Buffer.from("1"), 1, "full case");
});

test("a checker accepting malformed output is rejected", async () => {
  const quality = new AiQuality(request(), fake({ customChecker: true, compare: async () => {} }));
  await assert.rejects(quality.runDifferential(), /accepted malformed/);
});

test("checker infrastructure failure cannot serve as malformed-output rejection", async () => {
  const environment = fake({ customChecker: true });
  const compare = environment.compare;
  environment.compare = async (input, actual, expected, label) =>
    label.startsWith("malformed") ? Promise.reject(new Error("checker FAIL")) : compare(input, actual, expected, label);
  await assert.rejects(new AiQuality(request(), environment).runDifferential(), /checker FAIL/);
});

test("alternate full-case disagreement aborts before any challenge evidence", async () => {
  const environment = fake();
  const execute = environment.execute;
  environment.execute = async (name, input, parameters) =>
    name.startsWith("quality-alt") && input.toString() === "100"
      ? Buffer.from("bad")
      : execute(name, input, parameters);
  const quality = new AiQuality(request(), environment);
  await quality.runDifferential();
  await assert.rejects(quality.checkCorrect(Buffer.from("100"), Buffer.from("200"), 1, "full case"), /WA/);
});

test("only full exported cases count as kills and report final alternative executions", async () => {
  const quality = new AiQuality(request(), fake());
  await quality.runDifferential();
  assert.throws(() => quality.result(), /survived/);
  for (let index = 0; index < cases.length; index++) {
    const input = Buffer.from(String(100 + index));
    const answer = Buffer.from(String((100 + index) * 2));
    await quality.checkCorrect(input, answer, 1, `case ${index + 1}`);
    quality.recordCase(index, await quality.findKills(input, answer, 1));
  }
  assert.deepEqual(quality.result(), {
    version: 1,
    fuzzPassed: 64,
    alternativeCount: 1,
    alternativesPassed: 5,
    challengeCount: 1,
    challengesKilled: 1,
    challengeResults: [{ id: "off-by-one", kind: "wrong", killedBy: 1, verdict: "WA" }],
    extraAttemptsUsed: 0
  });
});

test("challenge preflight requires samples and one small AC per applicable subtask", async () => {
  const environment = fake();
  const execute = environment.execute;
  environment.execute = async (name, input, parameters) =>
    name.startsWith("quality-challenge") ? Buffer.from("wrong") : execute(name, input, parameters);
  const quality = new AiQuality(request(), environment);
  await assert.rejects(quality.checkSample(Buffer.from("1"), Buffer.from("2"), 1), /failed official sample/);
  await assert.rejects(quality.runDifferential(), /no passing small case/);
});

test("challenge infrastructure errors are fatal, whereas WA RE TLE MLE are kill verdicts", async () => {
  for (const verdict of ["WA", "RE", "TLE", "MLE", null]) {
    const environment = fake();
    const execute = environment.execute;
    environment.execute = async (name, input, parameters) => {
      if (name.startsWith("quality-challenge") && input.toString() === "100")
        throw verdict ? rejected(verdict) : new Error("unknown sandbox failure");
      return execute(name, input, parameters);
    };
    const quality = new AiQuality(request(), environment);
    await quality.runDifferential();
    if (verdict)
      assert.deepEqual(await quality.findKills(Buffer.from("100"), Buffer.from("200"), 1), [{ index: 0, verdict }]);
    else await assert.rejects(quality.findKills(Buffer.from("100"), Buffer.from("200"), 1), /unknown sandbox/);
  }
});

test("additional search protects exported witnesses and uses distinct case indices", async () => {
  const second = { id: "overflow", code: "overflow-source", kind: "wrong", subtasks: [1], reason: "overflow" };
  const quality = new AiQuality(request({ challenges: [...request().challenges, second] }), fake());
  quality.recordCase(0, [{ index: 0, verdict: "WA" }]);
  quality.recordCase(1, []);
  assert.equal(quality.replacementIndex(cases, 1), 2);
  const search = quality.nextSearchCase(cases);
  assert.deepEqual(search, { subtask: 1, seed: 1000000000 });
  quality.recordReplacement(2, [{ index: 1, verdict: "TLE" }]);
  assert.equal(quality.nextSearchCase(cases), null);
  assert.deepEqual(
    quality.result().challengeResults.map(result => result.killedBy),
    [1, 3]
  );
  assert.equal(quality.result().alternativesPassed, 2);
  assert.equal(quality.result().extraAttemptsUsed, 1);
});

test("search never replaces a witness and obeys the extra attempt budget", () => {
  const quality = new AiQuality(request({ extraAttempts: 2 }), fake());
  assert(quality.nextSearchCase(cases));
  assert(quality.nextSearchCase(cases));
  assert.equal(quality.nextSearchCase(cases), null);
  assert.throws(() => quality.result(), /survived/);
});

test("cancellation immediately stops quality execution", async () => {
  const quality = new AiQuality(
    request(),
    fake({
      checkCanceled: () => {
        throw new Error("canceled");
      }
    })
  );
  await assert.rejects(quality.runDifferential(), /canceled/);
  await assert.rejects(quality.findKills(Buffer.from("100"), Buffer.from("200"), 1), /canceled/);
});

test("slow challenges must pass every small case and fail full cases only by resource limits", async () => {
  const slow = {
    id: "quadratic",
    code: "quadratic-source",
    kind: "slow",
    subtasks: [1],
    reason: "quadratic complexity"
  };
  const qualityRequest = request({ challenges: [...request().challenges, slow] });
  const environment = fake();
  const execute = environment.execute;
  environment.execute = async (name, input, parameters) => {
    if (name === "quality-challenge-1" && input.toString() === "4") throw rejected("WA");
    return execute(name, input, parameters);
  };
  await assert.rejects(
    new AiQuality(qualityRequest, environment).runDifferential(),
    /Slow challenge quadratic failed small/
  );
  for (const verdict of ["WA", "RE", "TLE", "MLE"]) {
    const fullEnvironment = fake();
    const fullExecute = fullEnvironment.execute;
    fullEnvironment.execute = async (name, input, parameters) => {
      if (name === "quality-challenge-1" && input.toString() === "100") throw rejected(verdict);
      return fullExecute(name, input, parameters);
    };
    const quality = new AiQuality(qualityRequest, fullEnvironment);
    await quality.runDifferential();
    if (["TLE", "MLE"].includes(verdict))
      assert.deepEqual((await quality.findKills(Buffer.from("100"), Buffer.from("200"), 1))[1], { index: 1, verdict });
    else await assert.rejects(quality.findKills(Buffer.from("100"), Buffer.from("200"), 1), /incorrect on a full case/);
  }
});

test("replacement keeps smallest/largest boundary cases and never overwrites witness cases", () => {
  const quality = new AiQuality(request(), fake());
  assert.equal(quality.replacementIndex(cases, 1), 2);
  quality.recordCase(2, [{ index: 0, verdict: "WA" }]);
  assert.equal(quality.replacementIndex(cases, 1), 3);
  assert.equal(quality.replacementIndex(cases.slice(0, 3), 1), -1);
});

test("large sample outputs can be verified through a streamed file adapter", async () => {
  const verified = [];
  const quality = new AiQuality(
    request(),
    fake({
      execute: async () => {
        throw new Error("samples must not use bounded Buffer output");
      },
      verifySample: async (name, input, expected, label) => verified.push({ name, input, expected, label })
    })
  );
  await quality.checkSample({ path: "/large-input" }, { path: "/large-output" }, 1);
  assert.deepEqual(
    verified.map(value => value.name),
    ["quality-alt-0", "quality-challenge-0"]
  );
  assert(verified.every(value => value.expected.path === "/large-output"));
});

test("additional case indices stay distinct even when the original plan occupies the search range", () => {
  const quality = new AiQuality(request({ extraAttempts: 2 }), fake());
  const reserved = [...cases, { subtask: 1, seed: 1000000000 }];
  assert.equal(quality.nextSearchCase(reserved).seed, 1000000001);
  assert.equal(quality.nextSearchCase(reserved).seed, 1000000002);
});
