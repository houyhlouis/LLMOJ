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
  const calls = { ensured: [], uploads: [], requested: [], progress: [], layouts: [] };
  let canceled = false;
  const onAiExecution = load({
    winston: { __esModule: true, default: { error: () => {} } },
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
      uploadWithForm: async (form, data) => calls.uploads.push([form.name, data.toString()])
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
