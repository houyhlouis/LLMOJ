/* Run with the judge's installed dependencies: node --test apps/judge/src/task/ai-execution/ai-execution.test.cjs. */
// A judge machine runs an AI job's programs like the local AI runner, with the sample files it's sent (checked against
// their content hashes), and uploads the files they generated to the forms the server gives.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

class CanceledError extends Error {}
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");

function load(stubs) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "index.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", source)(
    name => {
      if (["fs", "path"].includes(name)) return require(name);
      if (!(name in stubs)) throw new Error(`Unexpected runtime import ${name}`);
      return stubs[name];
    },
    loaded,
    loaded.exports
  );
  return loaded.exports.default;
}

function fixture(t, generation, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-ai-task-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = path.join(root, "store");
  fs.mkdirSync(store);
  const stored = { "aaaaaaaa-0000-4000-8000-000000000001": "5 6\n", "aaaaaaaa-0000-4000-8000-000000000002": "11\n" };
  for (const [uuid, data] of Object.entries(stored)) fs.writeFileSync(path.join(store, uuid), data);
  const calls = { ensured: [], uploads: [], requested: [], progress: [], layouts: [], downloads: [] };
  let canceled = false;
  const onAiExecution = load({
    winston: { __esModule: true, default: { error: () => {}, warn: () => {} } },
    "../../config": { __esModule: true, default: { dataStore: path.join(root, "data") } },
    "../../rpc": {
      __esModule: true,
      default: {
        isCanceled: () => canceled,
        ensureNotCanceled: () => {
          if (canceled) throw new CanceledError();
        },
        requestUploads: async request => {
          calls.requested.push(request);
          return options.refuse ? [] : request.files.map(file => ({ name: file.name, url: "u", extraFormData: {}, fileFieldName: "file" }));
        }
      }
    },
    "../../error": { CanceledError },
    "../../file": {
      ensureFiles: async (uuids, hashes) => calls.ensured.push([uuids, hashes]),
      getFile: uuid => path.join(store, uuid),
      hashFileAtPath: async filename => sha256(fs.readFileSync(filename))
    },
    "../../aiRunner": {
      validate: request => {
        if (!request?.jobId) throw new Error("Invalid job UUID");
      },
      runGeneration: async (request, emit, isCanceled, layout, key) => {
        calls.layouts.push({ ...layout, key });
        if (options.cancel) canceled = true;
        await generation(request, emit, layout, isCanceled);
      }
    },
    "../../utils": {
      safelyJoinPath: (...parts) => path.join(...parts),
      uploadWithForm: async (form, data) => calls.uploads.push([form.name, data.toString()]),
      download: async (url, destination) => {
        calls.downloads.push(url);
        fs.writeFileSync(destination, (options.stored || {})[url] ?? "");
      }
    }
  });
  const run = async extraInfo =>
    await onAiExecution({
      taskId: "bbbbbbbb-0000-4000-8000-000000000003",
      type: "AiExecution",
      fileHashes: { "aaaaaaaa-0000-4000-8000-000000000001": sha256("5 6\n") },
      extraInfo,
      reportProgressRaw: progress => calls.progress.push(progress)
    });
  return { run, calls, root };
}

const jobId = "cccccccc-0000-4000-8000-000000000004";
const extraInfo = {
  request: { operation: "generate", jobId, cases: [{ subtask: 1, seed: 1 }], sampleFiles: [{ inputFile: "1.in", outputFile: "1.out" }] },
  sampleFiles: [
    { name: "1.in", uuid: "aaaaaaaa-0000-4000-8000-000000000001" },
    { name: "1.out", uuid: "aaaaaaaa-0000-4000-8000-000000000002" }
  ]
};
// Like the AI runner: test data in the job's own directory under the output root, then the result
async function generate(request, emit, layout) {
  assert.equal(fs.readFileSync(path.join(layout.sampleDirectory, "1.in"), "utf8"), "5 6\n");
  assert.equal(fs.readFileSync(path.join(layout.sampleDirectory, "1.out"), "utf8"), "11\n");
  emit({ type: "progress", phase: "generate", completed: 1, total: 1 });
  const directory = path.join(layout.outputRoot, request.jobId);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "1.in"), "1 2\n");
  fs.writeFileSync(path.join(directory, "1.out"), "3\n");
  emit({ type: "complete", directory, files: ["1.in", "1.out"], validation: { samplesPassed: 1 }, requestHash: "h" });
}

test("the programs run with the sample files sent, and the generated files are uploaded and reported", async t => {
  const { run, calls, root } = fixture(t, generate);
  await run(extraInfo);
  assert.deepEqual(calls.ensured, [
    [
      ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"],
      { "aaaaaaaa-0000-4000-8000-000000000001": sha256("5 6\n") }
    ]
  ]);
  assert.equal(calls.layouts[0].key, "bbbbbbbb-0000-4000-8000-000000000003", "admitted by task, not by job");
  assert.equal(calls.layouts[0].outputGroup, undefined, "not shared with a local backend");
  assert.deepEqual(calls.requested, [
    {
      taskId: "bbbbbbbb-0000-4000-8000-000000000003",
      files: [
        { name: "1.in", size: 4 },
        { name: "1.out", size: 2 }
      ]
    }
  ]);
  assert.deepEqual(calls.uploads.sort(), [
    ["1.in", "1 2\n"],
    ["1.out", "3\n"]
  ]);
  assert.deepEqual(calls.progress, [
    { finished: false, phase: "generate", completed: 1, total: 1 },
    {
      finished: true,
      status: "Complete",
      result: { validation: { samplesPassed: 1 }, requestHash: "h" },
      files: [
        { name: "1.in", size: 4, sha256: sha256("1 2\n") },
        { name: "1.out", size: 2, sha256: sha256("3\n") }
      ]
    }
  ]);
  assert.deepEqual(fs.readdirSync(path.join(root, "data", "ai-work")), [], "nothing is left behind");
});

test("a reference check without generated files uploads nothing", async t => {
  const { run, calls } = fixture(t, async (request, emit) => emit({ type: "complete", files: [], validation: { samplesPassed: 1 } }));
  await run({ ...extraInfo, request: { ...extraInfo.request, operation: "validate-reference" } });
  assert.deepEqual(calls.requested, []);
  assert.deepEqual(calls.progress, [
    { finished: true, status: "Complete", result: { validation: { samplesPassed: 1 } }, files: [] }
  ]);
});

test("failures are reported as the local runner reports them", async t => {
  const failing = error => async () => {
    throw error;
  };
  const candidate = Object.assign(new Error("Reference solution failed sample 1"), { candidateFailure: true });
  for (const [operation, candidateFailure] of [
    ["validate-reference", true],
    ["generate", false]
  ]) {
    const { run, calls } = fixture(t, failing(candidate));
    await run({ ...extraInfo, request: { ...extraInfo.request, operation } });
    assert.deepEqual(calls.progress, [
      { finished: true, status: "Failed", message: "Reference solution failed sample 1", candidateFailure }
    ]);
  }
  for (const [info, message] of [
    [{ ...extraInfo, sampleFiles: [] }, /A sample file of the request wasn't sent/],
    [{ ...extraInfo, request: { ...extraInfo.request, operation: "cleanup" } }, /Unsupported AI runner operation/],
    [{ ...extraInfo, request: {} }, /Invalid job UUID/]
  ]) {
    const { run, calls } = fixture(t, generate);
    await run(info);
    assert.equal(calls.progress.at(-1).status, "Failed");
    assert.match(calls.progress.at(-1).message, message);
  }
  const unexpected = fixture(t, async (request, emit, layout) => {
    fs.writeFileSync(path.join(layout.outputRoot, "result.json"), "{}");
    emit({ type: "complete", directory: layout.outputRoot, files: ["result.json"] });
  });
  await unexpected.run(extraInfo);
  assert.match(unexpected.calls.progress.at(-1).message, /Unexpected generated file/);
  const refused = fixture(t, generate, { refuse: true });
  await refused.run(extraInfo);
  assert.match(refused.calls.progress.at(-1).message, /The server refused to take the generated files/);
  assert.deepEqual(refused.calls.uploads, []);
});

test("a canceled run reports nothing more", async t => {
  const { run, calls } = fixture(t, generate, { cancel: true });
  await assert.rejects(run(extraInfo), CanceledError);
  assert.deepEqual(calls.uploads, []);
  assert.equal(calls.progress.some(progress => progress.finished), false);
});

// A failed run's evidence (review Part III, W01): uploaded before the failure is reported and the workspace removed
const evidenceFailure = artifacts => ({
  schemaVersion: 2,
  attemptId: "bbbbbbbb-0000-4000-8000-000000000003",
  operation: "generate",
  sourceHashes: {},
  profile: {},
  observations: [{ kind: "solver_disagreement", fatal: true, phase: "generate", summary: "Output mismatch", artifacts }]
});
async function failWithEvidence(request, emit, layout) {
  assert.equal(layout.attemptId, "bbbbbbbb-0000-4000-8000-000000000003", "the task is the run's attempt");
  fs.mkdirSync(layout.evidenceDirectory, { recursive: true });
  fs.writeFileSync(path.join(layout.evidenceDirectory, "0.input"), "1 2\n");
  fs.writeFileSync(path.join(layout.evidenceDirectory, "0.actual"), "4\n");
  throw Object.assign(new Error("Output mismatch"), {
    failure: evidenceFailure([
      { name: "0.input", role: "input", size: 4 },
      { name: "0.actual", role: "actual", size: 2 }
    ])
  });
}

test("a failure's evidence is uploaded, named as evidence, before the failure is reported", async t => {
  const { run, calls, root } = fixture(t, failWithEvidence);
  await run(extraInfo);
  assert.deepEqual(calls.requested, [
    {
      taskId: "bbbbbbbb-0000-4000-8000-000000000003",
      files: [
        { name: "0.input", size: 4 },
        { name: "0.actual", size: 2 }
      ],
      evidence: true
    }
  ]);
  assert.deepEqual(calls.uploads, [
    ["0.input", "1 2\n"],
    ["0.actual", "4\n"]
  ]);
  const [report] = calls.progress;
  assert.equal(report.status, "Failed");
  assert.deepEqual(
    report.failure.observations[0].artifacts.map(artifact => artifact.name),
    ["0.input", "0.actual"]
  );
  assert.deepEqual(fs.readdirSync(path.join(root, "data", "ai-work")), [], "then the workspace is removed");
});

test("evidence the server won't take is reported as not kept, and the failure still is", async t => {
  const { run, calls } = fixture(t, failWithEvidence, { refuse: true });
  await run(extraInfo);
  assert.deepEqual(calls.uploads, []);
  const [observation] = calls.progress[0].failure.observations;
  assert.deepEqual(observation.artifacts, []);
  assert.match(observation.evidenceError, /The evidence couldn't be uploaded \(The server refused to take the evidence\)/);
  assert.equal(calls.progress[0].message, "Output mismatch");
});

test("a canceled run uploads no evidence", async t => {
  const { run, calls } = fixture(t, failWithEvidence, { cancel: true });
  await assert.rejects(run(extraInfo), CanceledError);
  assert.deepEqual(calls.requested, []);
  assert.deepEqual(calls.uploads, []);
});

test("a replay's kept files are downloaded from the links sent and checked before it runs", async t => {
  const stored = { "https://storage/input": "3\n1 2 3\n", "https://storage/expected": "6\n" };
  const request = {
    operation: "replay",
    jobId,
    replay: { check: "compare", role: "std", against: "expected", files: { input: "replay.input", expected: "replay.expected" } }
  };
  const transfers = [
    { name: "replay.input", url: "https://storage/input", size: 8, sha256: sha256("3\n1 2 3\n") },
    { name: "replay.expected", url: "https://storage/expected", size: 2, sha256: sha256("6\n") }
  ];
  let seen = null;
  const replay = async (_request, emit, layout) => {
    seen = ["replay.input", "replay.expected"].map(name => fs.readFileSync(path.join(layout.sampleDirectory, name), "utf8"));
    emit({ type: "complete", files: [], replay: { runs: [{ outcome: "failed", kind: "solver_disagreement", summary: "" }] } });
  };
  let { run, calls } = fixture(t, replay, { stored });
  await run({ request, transfers });
  assert.deepEqual(seen, ["3\n1 2 3\n", "6\n"]);
  assert.deepEqual(calls.downloads, ["https://storage/input", "https://storage/expected"]);
  assert.equal(calls.requested.length, 0, "a replay uploads nothing");
  assert.deepEqual(calls.progress.at(-1), {
    finished: true,
    status: "Complete",
    result: { replay: { runs: [{ outcome: "failed", kind: "solver_disagreement", summary: "" }] } },
    files: []
  });

  // Not what the server recorded, a file the replay doesn't name, or a missing one: it doesn't run
  for (const [sent, error] of [
    [[{ ...transfers[0], sha256: sha256("other") }, transfers[1]], /replay.input isn't what the server recorded/],
    [[{ ...transfers[0], size: 9 }, transfers[1]], /replay.input isn't what the server recorded/],
    [[transfers[0], { ...transfers[1], name: "../escape" }], /kept files weren't sent/],
    [[transfers[0]], /kept files weren't sent/],
    [[transfers[0], { ...transfers[1], size: 17 * 1024 * 1024 }], /Invalid kept file/]
  ]) {
    seen = null;
    ({ run, calls } = fixture(t, replay, { stored }));
    await run({ request, transfers: sent });
    assert.equal(seen, null);
    assert.equal(calls.progress.at(-1).status, "Failed");
    assert.match(calls.progress.at(-1).message, error);
  }
});
