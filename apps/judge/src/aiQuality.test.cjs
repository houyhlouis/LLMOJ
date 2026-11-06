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
    // The small generator writes 1 to 4
    fuzzDistinct: 4,
    alternativeCount: 1,
    alternativesPassed: 5,
    challengeCount: 1,
    challengesKilled: 1,
    // Rejected by the first case, and not run on the others: they're unknown, not passes
    challengeResults: [{ id: "off-by-one", kind: "wrong", killedBy: 1, verdict: "WA", tested: 1, kills: 1 }],
    extraAttemptsUsed: 0,
    replacements: [],
    search: { attempts: 0, budget: 8, found: 0, unplaced: 0, promoted: 0 },
    matrix: [{ case: 1, killed: ["off-by-one"], passed: [] }]
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
      assert.deepEqual(await quality.findKills(Buffer.from("100"), Buffer.from("200"), 1), {
        killed: [{ index: 0, verdict }],
        passed: []
      });
    else await assert.rejects(quality.findKills(Buffer.from("100"), Buffer.from("200"), 1), /unknown sandbox/);
  }
});

test("additional search protects exported witnesses and uses distinct case indices", async () => {
  const second = { id: "overflow", code: "overflow-source", kind: "wrong", subtasks: [1], reason: "overflow" };
  const quality = new AiQuality(request({ challenges: [...request().challenges, second] }), fake());
  quality.recordCase(0, { killed: [{ index: 0, verdict: "WA" }], passed: [1] });
  quality.recordCase(1, { killed: [], passed: [1] });
  const search = quality.nextCandidate(cases);
  assert.deepEqual(search, { subtask: 1, seed: 1000000000 });
  // The candidate rejects the survivor: it takes the first case that rejects nothing, never a boundary
  const row = { killed: [{ index: 1, verdict: "TLE" }], passed: [0] };
  assert.equal(quality.placement(cases, search, row), 2);
  quality.recordReplacement(2, search, row);
  assert.equal(quality.nextCandidate(cases), null);
  const result = quality.result();
  assert.deepEqual(
    result.challengeResults.map(item => [item.killedBy, item.tested, item.kills]),
    [
      [1, 2, 1],
      [3, 3, 1]
    ]
  );
  assert.equal(result.alternativesPassed, 2);
  assert.equal(result.extraAttemptsUsed, 1);
  assert.deepEqual(result.replacements, [{ case: 3, source: "search", kills: ["overflow"], moved: [] }]);
  assert.deepEqual(result.search, { attempts: 1, budget: 8, found: 1, unplaced: 0, promoted: 0 });
});

test("search obeys the extra attempt budget, which is another reason than capacity", () => {
  const quality = new AiQuality(request({ extraAttempts: 2 }), fake());
  assert(quality.nextCandidate(cases));
  assert(quality.nextCandidate(cases));
  assert.equal(quality.nextCandidate(cases), null);
  assert.throws(
    () => quality.result(),
    error => /survived/.test(error.message) && error.aiFailureDetails?.search?.stoppedBy === "budget"
  );
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
      assert.deepEqual((await quality.findKills(Buffer.from("100"), Buffer.from("200"), 1)).killed[1], {
        index: 1,
        verdict
      });
    else await assert.rejects(quality.findKills(Buffer.from("100"), Buffer.from("200"), 1), /incorrect on a full case/);
  }
});

test("replacement keeps smallest/largest boundary cases, and a witness case only goes to a candidate rejecting its targets", () => {
  const three = ["a", "b", "c", "d"].map(id => ({
    id,
    code: `${id}-source`,
    kind: "wrong",
    subtasks: [1],
    reason: id
  }));
  const quality = new AiQuality(request({ challenges: three }), fake());
  const kill = index => ({ killed: [{ index, verdict: "WA" }], passed: [] });
  // Review Part III, E02: two boundaries and three witnesses; d survives
  quality.recordCase(0, { killed: [], passed: [0, 1, 2, 3] });
  quality.recordCase(1, { killed: [], passed: [0, 1, 2, 3] });
  for (const index of [2, 3, 4]) quality.recordCase(index, kill(index - 2));
  // The search still runs: there are cases it could replace
  const candidate = quality.nextCandidate(cases);
  assert.deepEqual(candidate, { subtask: 1, seed: 1000000000 });
  // A candidate rejecting only d can't take a witness's place
  assert.equal(quality.placement(cases, candidate, { killed: [{ index: 3, verdict: "WA" }], passed: [0, 1, 2] }), -1);
  // One rejecting d and b takes b's case (the fourth)
  const row = {
    killed: [
      { index: 1, verdict: "RE" },
      { index: 3, verdict: "WA" }
    ],
    passed: [0, 2]
  };
  assert.equal(quality.placement(cases, candidate, row), 3);
  quality.recordReplacement(3, candidate, row);
  const result = quality.result();
  assert.deepEqual(
    result.challengeResults.map(item => [item.id, item.killedBy, item.verdict]),
    [
      ["a", 3, "WA"],
      ["b", 4, "RE"],
      ["c", 5, "WA"],
      ["d", 4, "WA"]
    ]
  );
  assert.deepEqual(result.replacements, [{ case: 4, source: "search", kills: ["b", "d"], moved: ["b"] }]);
  assert.deepEqual(result.search, { attempts: 1, budget: 8, found: 2, unplaced: 1, promoted: 0 });
  // Only boundary cases: no search at all, and the reason is capacity
  const small = new AiQuality(request(), fake());
  assert.equal(small.nextCandidate(cases.slice(0, 2)), null);
  assert.throws(
    () => small.result(),
    error =>
      error.aiFailureDetails?.kind === "challenge_survived" && error.aiFailureDetails.search.stoppedBy === "capacity"
  );
});

test("counterexamples found but never placeable are a capacity reason, not the search budget", () => {
  const two = ["a", "b"].map(id => ({ id, code: `${id}-source`, kind: "wrong", subtasks: [1], reason: id }));
  const quality = new AiQuality(request({ challenges: two, extraAttempts: 1 }), fake());
  const three = cases.slice(0, 3);
  quality.recordCase(0, { killed: [], passed: [0, 1] });
  quality.recordCase(1, { killed: [], passed: [0, 1] });
  quality.recordCase(2, { killed: [{ index: 0, verdict: "WA" }], passed: [1] });
  const candidate = quality.nextCandidate(three);
  assert.equal(quality.placement(three, candidate, { killed: [{ index: 1, verdict: "WA" }], passed: [0] }), -1);
  assert.equal(quality.nextCandidate(three), null);
  assert.throws(
    () => quality.result(),
    error => error.aiFailureDetails?.search?.stoppedBy === "capacity"
  );
});

test("a surviving wrong challenge's small counterexample is promoted, before any search input", async () => {
  // Review Part III, E04: the challenge fails small input 3 only; no final case triggers it
  const environment = fake({
    execute: async (name, input, parameters) => {
      if (name === "quality-small-make") return Buffer.from(String((Number(parameters[1]) % 4) + 1));
      if (name === "quality-challenge-0" && input.toString() === "3") return Buffer.from("wrong");
      return Buffer.from(String(Number(input.toString()) * 2));
    }
  });
  const quality = new AiQuality(request(), environment);
  await quality.runDifferential();
  for (let index = 0; index < cases.length; index++) {
    const input = Buffer.from(String(100 + index));
    const answer = Buffer.from(String((100 + index) * 2));
    quality.recordCase(index, await quality.findKills(input, answer, 1));
  }
  const candidate = quality.nextCandidate(cases);
  assert.equal(candidate.promoted, 0);
  assert.equal(candidate.input.toString(), "3");
  assert.equal(candidate.subtask, 1);
  assert.equal(candidate.seed % 4, 2, "the differential case index it came from");
  const row = await quality.findKills(candidate.input, Buffer.from("6"), 1, true);
  assert.deepEqual(row, { killed: [{ index: 0, verdict: "WA" }], passed: [] });
  const index = quality.placement(cases, candidate, row);
  assert.equal(index, 2);
  quality.recordReplacement(index, candidate, row);
  const result = quality.result();
  assert.deepEqual(result.replacements, [
    { case: 3, source: "small_counterexample", kills: ["off-by-one"], moved: [] }
  ]);
  assert.deepEqual(result.search, { attempts: 0, budget: 8, found: 1, unplaced: 0, promoted: 1 });
  // Tried once: a promoted case is no boundary, whatever its case index
  assert.equal(quality.nextCandidate(cases), null);
});

test("repeated differential inputs are counted once", async () => {
  // Review Part III, E03: the small generator writes the same input every time
  const environment = fake({
    execute: async (name, input) => {
      if (name === "quality-small-make") return Buffer.from("7");
      if (name === "quality-challenge-0" && Number(input.toString()) > 10) return Buffer.from("wrong");
      return Buffer.from(String(Number(input.toString()) * 2));
    }
  });
  const quality = new AiQuality(request(), environment);
  await quality.runDifferential();
  quality.recordCase(0, await quality.findKills(Buffer.from("100"), Buffer.from("200"), 1));
  const result = quality.result();
  assert.equal(result.fuzzPassed, 64);
  assert.equal(result.fuzzDistinct, 1);
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
  assert.equal(quality.nextCandidate(reserved).seed, 1000000001);
  assert.equal(quality.nextCandidate(reserved).seed, 1000000002);
});

// A differential input outside the brute-force oracle's small domain is an invalid test configuration made by
// small-make.cpp: the oracle's timeout (or memory limit) and an oversized input are reported as such, and no solution
// is judged on that input
const { detailsOf } = require("./aiFailure.ts");
const { DIFFERENTIAL_INPUT_BYTES } = require("./aiQuality.ts");
const sandboxFailure = (kind, message) => {
  const error = new Error(message);
  const { describe } = require("./aiFailure.ts");
  return describe(error, { kind, execution: { status: kind === "time_limit" ? "TimeLimitExceeded" : "MemoryLimitExceeded", timeMs: 5001 } });
};

for (const [kind, label] of [["time_limit", "time"], ["memory_limit", "memory"]])
  test(`the oracle's ${label} limit on a differential input blames the small-case generator, and nothing is judged on it`, async () => {
    const ran = [];
    const environment = fake();
    const execute = environment.execute;
    environment.execute = async (name, input, parameters) => {
      ran.push(name);
      // The fourth case index makes an input the exponential oracle can't solve in time
      if (name === "quality-oracle" && input.toString() === "4") throw sandboxFailure(kind, "oracle stopped");
      return execute(name, input, parameters);
    };
    const quality = new AiQuality(request(), environment);
    const error = await quality.runDifferential().then(() => null, failure => failure);
    assert.ok(error, "the differential test stops");
    assert.match(error.message, new RegExp(`oracle exceeded its ${label} limit on a differential input of 1 bytes`));
    const details = detailsOf(error);
    assert.equal(details.kind, "oracle_domain_exceeded");
    assert.equal(details.role, "quality-small-make");
    assert.equal(details.phase, "quality-differential");
    assert.equal(details.subtask, 1);
    assert.equal(details.scenarioIndex, 3);
    assert.equal(details.data.input.toString(), "4");
    // The oracle's measurement stays as evidence
    assert.equal(details.execution.timeMs, 5001);
    // Neither the reference solution nor any other program ran on the input the oracle couldn't solve
    const last = ran.lastIndexOf("quality-oracle");
    assert.deepEqual(ran.slice(last + 1), []);
  });

test("a differential input larger than a small case is refused before the oracle or the validator run", async () => {
  const ran = [];
  const environment = fake();
  const execute = environment.execute;
  let validated = 0;
  environment.validate = async () => {
    validated++;
  };
  environment.execute = async (name, input, parameters) => {
    ran.push(name);
    if (name === "quality-small-make" && parameters[1] === "2") return Buffer.alloc(DIFFERENTIAL_INPUT_BYTES + 1, 0x31);
    return execute(name, input, parameters);
  };
  const quality = new AiQuality(request(), environment);
  const error = await quality.runDifferential().then(() => null, failure => failure);
  assert.match(error.message, new RegExp(`differential input of ${DIFFERENTIAL_INPUT_BYTES + 1} bytes, more than`));
  assert.equal(detailsOf(error).kind, "oracle_domain_exceeded");
  assert.equal(detailsOf(error).role, "quality-small-make");
  assert.deepEqual(ran.slice(ran.lastIndexOf("quality-small-make") + 1), []);
  assert.equal(validated, 2, "only the cases before it were validated");
  // Exactly the limit is still a small case
  const fits = fake();
  const fitsExecute = fits.execute;
  fits.execute = async (name, input, parameters) =>
    name === "quality-small-make" && parameters[1] === "1"
      ? Buffer.alloc(DIFFERENTIAL_INPUT_BYTES, 0x31)
      : fitsExecute(name, input, parameters);
  const outcome = await new AiQuality(request(), fits).runDifferential().then(() => null, failure => failure);
  assert.notEqual(detailsOf(outcome)?.kind, "oracle_domain_exceeded");
});

test("an oracle that crashes or disagrees is still the oracle's failure", async () => {
  const crashing = fake();
  const execute = crashing.execute;
  crashing.execute = async (name, input, parameters) => {
    if (name === "quality-oracle") throw sandboxFailure("runtime_error", "oracle crashed");
    return execute(name, input, parameters);
  };
  const error = await new AiQuality(request(), crashing).runDifferential().then(() => null, failure => failure);
  assert.equal(detailsOf(error).kind, "runtime_error");
  assert.equal(detailsOf(error).role, "quality-oracle");
});
