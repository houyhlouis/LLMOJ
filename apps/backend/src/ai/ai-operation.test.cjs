/* Credential-free tests of logical AI operations and their records (review Part III, H07/W03). */
// A run of an AI job's programs is a logical operation whose key changes with anything the run depends on, and never
// otherwise; only a result made under the current AI execution contract is reused, and only cases that are exactly the
// files the run made are published.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText,
    filename
  );
const protocol = require("@libreoj/judge-protocol");
const {
  aiOperationKey,
  currentExecution,
  executionProvenance,
  verifiedCorpus,
  corpusDigest
} = require("./ai-operation.ts");

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const JOB = "0f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
const request = () => ({
  jobId: JOB,
  problemType: "Traditional",
  makeCode: "int main(){}",
  stdCode: "int main(){return 0;}",
  validatorCode: "int main(){}",
  cases: [
    { subtask: 1, seed: 1 },
    { subtask: 1, seed: 2 }
  ],
  samples: [{ input: "1\n", output: "1\n" }],
  sampleFiles: [{ inputFile: "1.in", outputFile: "1.out", inputUuid: "u-in", outputUuid: "u-out" }],
  checker: { type: "tokens", caseSensitive: true },
  profiles: { version: 1, roles: { std: { timeLimitMs: 1000, memoryLimitMiB: 256 } } }
});
const record = (overrides = {}) => ({
  contract: protocol.AI_EXECUTION_PROTOCOL_VERSION,
  attemptId: crypto.randomUUID(),
  runtime: { judgeProgram: "a".repeat(64), sandboxImage: "bbe9c69b2027", arch: "x64" },
  startedAt: "2026-11-04T10:00:00.000Z",
  finishedAt: "2026-11-04T10:05:00.000Z",
  reuse: { builds: 2, inputs: 0 },
  ...overrides
});

test("an operation's key changes with anything its run depends on, and never otherwise", () => {
  const base = aiOperationKey(JOB, request());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(aiOperationKey(JOB, request()), base);
  const reordered = Object.fromEntries(Object.entries(request()).reverse());
  assert.equal(aiOperationKey(JOB, reordered), base, "whatever order its fields are in");
  assert.equal(aiOperationKey(JOB, { ...request(), operationKey: "f".repeat(64) }), base, "not its own key");
  assert.equal(aiOperationKey(JOB, { ...request(), operation: "generate" }), base, "generate is the default");
  const changes = [
    ["another job", key => aiOperationKey("1f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f", key)],
    ["a reference check", key => aiOperationKey(JOB, { ...key, operation: "validate-reference" })],
    ["a changed generator", key => aiOperationKey(JOB, { ...key, makeCode: "int main(){ }" })],
    ["a changed reference solution", key => aiOperationKey(JOB, { ...key, stdCode: "int main(){return 1;}" })],
    ["another case", key => aiOperationKey(JOB, { ...key, cases: [...key.cases, { subtask: 1, seed: 3 }] })],
    ["another sample", key => aiOperationKey(JOB, { ...key, samples: [{ input: "2\n", output: "2\n" }] })],
    [
      "another stored sample file",
      key => aiOperationKey(JOB, { ...key, sampleFiles: [{ ...key.sampleFiles[0], inputUuid: "u-other" }] })
    ],
    ["another comparison", key => aiOperationKey(JOB, { ...key, checker: { type: "lines", caseSensitive: true } })],
    [
      "another profile",
      key =>
        aiOperationKey(JOB, { ...key, profiles: { version: 1, roles: { std: { timeLimitMs: 2000, memoryLimitMiB: 256 } } } })
    ]
  ];
  const keys = new Set([base]);
  for (const [what, change] of changes) {
    const key = change(request());
    assert.notEqual(key, base, what);
    keys.add(key);
  }
  assert.equal(keys.size, changes.length + 1);
});

test("only a result made under the current contract is reused", () => {
  const made = record();
  assert.deepEqual(currentExecution({ execution: made }), made);
  assert.equal(currentExecution({ execution: record({ contract: protocol.AI_EXECUTION_PROTOCOL_VERSION - 1 }) }), null);
  assert.equal(currentExecution({}), null, "a runner of protocol version 7 reports none");
  assert.equal(currentExecution(null), null);
  for (const broken of [
    { attemptId: "x" },
    { runtime: { judgeProgram: "short", sandboxImage: "i", arch: "x64" } },
    { runtime: { judgeProgram: "a".repeat(64), sandboxImage: "../x", arch: "x64" } },
    { startedAt: "yesterday" },
    { reuse: { builds: -1, inputs: 0 } },
    { reuse: { builds: 1 } }
  ])
    assert.equal(currentExecution({ execution: record(broken) }), null, JSON.stringify(broken));
});

test("the provenance published with test data: where its run was made, and how the job came by it", () => {
  const made = record();
  assert.deepEqual(
    executionProvenance(protocol.parseAiExecutionRecord(made), {
      key: "k".repeat(64),
      origin: "judge",
      result: "collected-again",
      task: "t",
      judgeRuntimeId: 3
    }),
    {
      operation: "k".repeat(64),
      origin: "judge",
      task: "t",
      judgeRuntimeId: 3,
      result: "collected-again",
      attempt: made.attemptId,
      runtime: made.runtime,
      startedAt: made.startedAt,
      finishedAt: made.finishedAt,
      reuse: made.reuse
    }
  );
  const local = executionProvenance(protocol.parseAiExecutionRecord(made), { key: "k", origin: "local", result: "new" });
  assert.equal("task" in local || "judgeRuntimeId" in local, false);
});

test("the cases published are exactly the files the run reported", () => {
  const files = new Map();
  const cases = [1, 2].map(index => {
    const input = Buffer.from(`${index} input\n`);
    const output = Buffer.from(`${index} output\n`);
    files.set(`${index}.in`, { sha256: sha256(input), size: input.length });
    files.set(`${index}.out`, { sha256: sha256(output), size: output.length });
    return {
      index,
      subtask: 1,
      scenarioIndex: index,
      origin: index === 2 ? "adversarial" : "generated",
      input: files.get(`${index}.in`),
      output: files.get(`${index}.out`)
    };
  });
  assert.deepEqual(verifiedCorpus(cases, 2, files), cases);
  assert.match(corpusDigest(cases), /^[0-9a-f]{64}$/);
  assert.notEqual(corpusDigest(cases), corpusDigest([cases[1], cases[0]]));
  const tampered = new Map(files);
  tampered.set("2.out", { sha256: sha256("other"), size: 5 });
  assert.equal(verifiedCorpus(cases, 2, tampered), null, "a file that isn't the reported case");
  assert.equal(verifiedCorpus(cases, 3, files), null, "a case missing");
  assert.equal(verifiedCorpus([cases[1], cases[0]], 2, files), null, "out of order");
  assert.equal(verifiedCorpus([{ ...cases[0], origin: "made-up" }, cases[1]], 2, files), null);
  assert.equal(verifiedCorpus([{ ...cases[0], input: { sha256: "x", size: 1 } }, cases[1]], 2, files), null);
  assert.equal(verifiedCorpus(undefined, 2, files), null, "a runner of protocol version 7 reports none");
});

test("replay requests are checked field by field, and their runs say whether the failure reproduced", () => {
  const replay = {
    check: "compare",
    role: "quality-alt-1",
    against: "quality-oracle",
    files: { input: "replay.input" },
    repeat: 3,
    programs: { "quality-alt-1": "int main(){}", "quality-oracle": "int main(){}" }
  };
  assert.equal(protocol.aiReplayRequestError(replay), null);
  for (const [broken, error] of [
    [{ check: "exec" }, /check/],
    [{ role: "../std" }, /program/],
    [{ role: "grader" }, /program/],
    [{ repeat: 4 }, /count/],
    [{ repeat: 0 }, /count/],
    [{ programs: {} }, /programs/],
    [{ programs: { "quality-alt-1": "x", "quality-oracle": "y", std: "z", checker: "c", validator: "v" } }, /programs/],
    [{ programs: { "quality-alt-1": "x" } }, /compared output is missing/],
    [{ files: { input: "../etc/passwd" } }, /files/],
    [{ files: { input: "replay.input", other: "replay.actual" } }, /files/],
    [{ files: {} }, /input is missing/],
    [{ against: "expected" }, /compared output is missing/]
  ])
    assert.match(protocol.aiReplayRequestError({ ...replay, ...broken }) || "", error, JSON.stringify(broken));
  assert.match(
    protocol.aiReplayRequestError({ ...replay, check: "validate", role: "validator", programs: { validator: "v" } }),
    /arguments/
  );
  assert.equal(
    protocol.aiReplayRequestError({
      check: "checker",
      role: "checker",
      expect: "reject",
      files: { input: "replay.input", actual: "replay.actual", expected: "replay.expected" },
      repeat: 3,
      programs: { checker: "c" }
    }),
    null
  );

  const failed = kind => ({ outcome: "failed", kind, summary: "" });
  const passed = { outcome: "passed", summary: "" };
  assert.equal(protocol.aiReplayOutcome("time_limit", [failed("time_limit"), failed("time_limit")]), "reproduced");
  assert.equal(protocol.aiReplayOutcome("time_limit", [passed, passed, passed]), "not_reproduced");
  assert.equal(protocol.aiReplayOutcome("time_limit", [failed("time_limit"), passed]), "unstable");
  assert.equal(protocol.aiReplayOutcome("time_limit", [failed("runtime_error"), failed("runtime_error")]), "different");
  assert.equal(protocol.aiReplayOutcome("time_limit", [failed("runtime_error"), failed("memory_limit")]), "unstable");

  assert.deepEqual(protocol.parseAiReplayRuns([failed("time_limit"), passed], 2), [failed("time_limit"), passed]);
  assert.equal(protocol.parseAiReplayRuns([passed], 2), null, "as many runs as asked for");
  assert.equal(protocol.parseAiReplayRuns([{ ...passed, outcome: "ok" }], 1), null);
  assert.equal(protocol.parseAiReplayRuns([failed("made_up")], 1), null);
  assert.deepEqual(protocol.parseAiReplayRuns([{ outcome: "failed", summary: "x".repeat(3000) }], 1), [
    { outcome: "failed", kind: "unclassified", summary: "x".repeat(2000) }
  ]);
});
