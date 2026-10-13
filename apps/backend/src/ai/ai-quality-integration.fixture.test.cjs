/* Pure fixture checks: no provider requests, application configuration or database access. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const fixture = import("./ai-quality-integration.fixture.mjs");

test("integration provider fixtures recognize every independent quality stage", async () => {
  const { sumQualityResponse, sumQualityPlan } = await fixture;
  const requests = [
    ["Independently analyze this programming problem to design an executable test-data quality gate.", "qualityPlan", "quality-plan"],
    ["Generate ONLY small-make.cpp, independently designed.", "smallMakeCode", "small-make"],
    ["Generate ONLY oracle.cpp, a simple exact solver.", "oracleCode", "oracle"],
    ["Generate ONLY alternative.cpp, independently derived.", "alternativeCode", "alternative"],
    ["Generate ONLY challenge.cpp implementing a realistic attempted solution.", "challengeCode", "challenge"]
  ];
  for (const [prompt, field, stage] of requests) {
    const response = sumQualityResponse(prompt);
    assert.equal(response.field, field);
    assert.equal(response.stage, stage);
    if (field === "qualityPlan") assert.deepEqual(response.output, sumQualityPlan);
    else assert.match(response.output, /\bmain\s*\(/);
  }
  assert.equal(sumQualityResponse("Generate ONLY validator.cpp"), undefined);
  const response = sumQualityResponse(requests[0][0]);
  response.output.targets[0].subtasks.push(1);
  assert.deepEqual(sumQualityPlan.targets[0].subtasks, [2], "returned plans must not mutate the shared fixture");
});

test("integration receipt checks require actual differential and adversarial evidence", async () => {
  const { assertSumQualityReceipt } = await fixture;
  const receipt = {
    version: 1, fuzzPassed: 64, alternativeCount: 1, alternativesPassed: 6,
    challengeCount: 1, challengesKilled: 1, extraAttemptsUsed: 0,
    challengeResults: [{ id: "clamped-sum", kind: "wrong", killedBy: 5, verdict: "WA" }]
  };
  assertSumQualityReceipt(receipt, 6);
  assert.throws(() => assertSumQualityReceipt({ ...receipt, fuzzPassed: 0 }, 6));
  assert.throws(() => assertSumQualityReceipt({ ...receipt, challengesKilled: 0 }, 6));
  assert.throws(() => assertSumQualityReceipt({ ...receipt,
    challengeResults: [{ ...receipt.challengeResults[0], verdict: "AC" }] }, 6));
});

test("sum fixtures produce legal differential inputs and reject a plausible wrong solution", async t => {
  const f = await fixture;
  const compiler = spawnSync("g++", ["--version"], { encoding: "utf8", timeout: 5000 });
  if (compiler.error?.code === "ENOENT") {
    t.skip("g++ is required for the standalone executable fixture check");
    return;
  }
  assert.equal(compiler.status, 0, compiler.stderr);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-quality-fixture-"));
  const sources = {
    make: f.sumMakeCode, small: f.sumSmallMakeCode, std: f.sumStdCode,
    oracle: f.sumOracleCode, alternative: f.sumAlternativeCode, challenge: f.sumChallengeCode
  };
  const execute = (name, input = "", args = []) => {
    const result = spawnSync(path.join(directory, name), args.map(String), {
      input, encoding: "utf8", timeout: 5000, maxBuffer: 16384, cwd: directory
    });
    assert.equal(result.error, undefined, `${name}: ${result.error}`);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const legal = (input, subtask) => {
    const tokens = input.trim().split(/\s+/);
    assert.equal(tokens.length, 2, "one complete pair of integers is required");
    assert(tokens.every(value => /^-?\d+$/.test(value)));
    const values = tokens.map(BigInt), bound = subtask === 1 ? 10n : 1000000000n;
    assert(values.every(value => value >= -bound && value <= bound));
    return String(values[0] + values[1]);
  };
  try {
    for (const [name, source] of Object.entries(sources)) {
      assert(!Object.entries(sources).some(([other, code]) => other !== name && source === code), "verification sources must be distinct");
      const filename = path.join(directory, `${name}.cpp`);
      fs.writeFileSync(filename, source);
      const result = spawnSync("g++", ["-std=c++17", "-O2", filename, "-o", path.join(directory, name)], {
        encoding: "utf8", timeout: 30000, cwd: directory
      });
      assert.equal(result.error, undefined, `${name}: ${result.error}`);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
    for (const name of ["std", "oracle", "alternative", "challenge"])
      assert.equal(execute(name, "1 2\n"), "3", "every candidate passes the official sample");
    let challengeSmallAccepted = 0;
    for (let index = 0; index < 64; index++) {
      const subtask = index % 2 + 1, seed = Math.floor(index / 2) + 1;
      const input = execute("small", "", [subtask, seed]), expected = legal(input, subtask);
      for (const name of ["std", "oracle", "alternative"])
        assert.equal(execute(name, input), expected, `${name} differential case ${subtask}/${seed}`);
      if (subtask === 2 && execute("challenge", input) === expected) challengeSmallAccepted++;
    }
    assert(challengeSmallAccepted > 0, "the wrong candidate still solves legal small cases in its applicable subtask");
    const witnesses = [];
    for (const subtask of [1, 2]) for (const seed of [1, 2, 3]) {
      const input = execute("make", "", [subtask, seed]), expected = legal(input, subtask);
      for (const name of ["std", "oracle", "alternative"])
        assert.equal(execute(name, input), expected, `${name} full case ${subtask}/${seed}`);
      const accepted = execute("challenge", input) === expected;
      if (subtask === 1) assert(accepted, "the probe must not reject a subtask it solves correctly");
      else if (!accepted) witnesses.push(seed);
    }
    assert(witnesses.includes(2), "the legal full-size maximum input rejects the clamped-sum candidate");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
