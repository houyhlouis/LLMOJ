/* Run with the judge's installed dependencies: node --test apps/judge/src/fileContent.test.cjs. */
// A judge checks the files of a task against the SHA-256 recorded when they were uploaded, also the copies it keeps,
// and announces a digest of its own program that only its source files change.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const noop = () => {};

function load(file, overrides) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", "__dirname", source)(
    name => (name in overrides ? overrides[name] : require(name)),
    loaded,
    loaded.exports,
    __dirname
  );
  return loaded.exports;
}

// The file cache with a server whose stored files are `stored` (by UUID)
function fileCache() {
  const dataStore = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-judge-files-"));
  const stored = {};
  const downloads = [];
  const file = load("file.ts", {
    "./config": { __esModule: true, default: { dataStore, maxConcurrentDownloads: 2 } },
    "./rpc": { __esModule: true, default: { requestFiles: async uuids => uuids.map(uuid => `http://minio/${uuid}`) } },
    "./fsNative": {
      exists: async p => fs.existsSync(p),
      ensureDir: async p => fs.mkdirSync(p, { recursive: true })
    },
    "./utils": {
      safelyJoinPath: (...parts) => path.join(...parts),
      download: async (url, destination) => {
        const uuid = url.split("/").pop();
        downloads.push(uuid);
        fs.writeFileSync(destination, stored[uuid]);
      }
    },
    winston: { __esModule: true, default: { info: noop, verbose: noop, warn: noop, error: noop } }
  });
  return { file, dataStore, stored, downloads, kept: uuid => path.join(dataStore, uuid) };
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

test("a file with its recorded content is downloaded and kept; one without is neither", async t => {
  const { file, dataStore, stored, downloads, kept } = fileCache();
  t.after(() => fs.rmSync(dataStore, { recursive: true, force: true }));
  stored[A] = "1 2\n";
  stored[B] = "changed after upload\n";
  await file.ensureFiles([A], { [A]: sha256("1 2\n") });
  assert.equal(fs.readFileSync(kept(A), "utf8"), "1 2\n");
  assert.equal(await file.getFileHash(A), sha256("1 2\n"));

  await assert.rejects(file.ensureFiles([B], { [B]: sha256("original\n") }), error => {
    assert(error instanceof file.FileContentError);
    assert.match(error.message, new RegExp(`^Test data file ${B} doesn't match its recorded content`));
    assert.match(error.message, new RegExp(sha256("original\n").slice(0, 12)));
    return true;
  });
  assert.equal(fs.existsSync(kept(B)), false, "not kept");
  assert.deepEqual(fs.readdirSync(path.join(dataStore, "temp")), [], "and not left behind");
  assert.deepEqual(downloads, [A, B]);
});

test("a kept copy that doesn't match is downloaded again, and used once it matches", async t => {
  const { file, dataStore, stored, downloads, kept } = fileCache();
  t.after(() => fs.rmSync(dataStore, { recursive: true, force: true }));
  stored[A] = "input\n";
  const expected = { [A]: sha256("input\n") };
  await file.ensureFiles([A], expected);
  // Damaged on the judge's disk (the hash cache of a running judge is kept too)
  fs.writeFileSync(kept(A), "inpu\n");
  await file.ensureFiles([A], expected);
  assert.deepEqual(downloads, [A], "the cached hash of the copy it checked is trusted");

  // A new judge process doesn't trust the copy it finds
  const restarted = load("file.ts", {
    "./config": { __esModule: true, default: { dataStore, maxConcurrentDownloads: 2 } },
    "./rpc": { __esModule: true, default: { requestFiles: async uuids => uuids.map(uuid => `http://minio/${uuid}`) } },
    "./fsNative": { exists: async p => fs.existsSync(p), ensureDir: async p => fs.mkdirSync(p, { recursive: true }) },
    "./utils": {
      safelyJoinPath: (...parts) => path.join(...parts),
      download: async (url, destination) => {
        downloads.push(url.split("/").pop());
        fs.writeFileSync(destination, stored[url.split("/").pop()]);
      }
    },
    winston: { __esModule: true, default: { info: noop, verbose: noop, warn: noop, error: noop } }
  });
  await restarted.ensureFiles([A], expected);
  assert.deepEqual(downloads, [A, A]);
  assert.equal(fs.readFileSync(kept(A), "utf8"), "input\n");

  // Changed in storage too: the task fails instead of judging with other data
  fs.writeFileSync(kept(A), "other\n");
  stored[A] = "other\n";
  const again = load("file.ts", {
    "./config": { __esModule: true, default: { dataStore, maxConcurrentDownloads: 2 } },
    "./rpc": { __esModule: true, default: { requestFiles: async uuids => uuids.map(uuid => `http://minio/${uuid}`) } },
    "./fsNative": { exists: async p => fs.existsSync(p), ensureDir: async p => fs.mkdirSync(p, { recursive: true }) },
    "./utils": {
      safelyJoinPath: (...parts) => path.join(...parts),
      download: async (url, destination) => fs.writeFileSync(destination, stored[url.split("/").pop()])
    },
    winston: { __esModule: true, default: { info: noop, verbose: noop, warn: noop, error: noop } }
  });
  await assert.rejects(again.ensureFiles([A], expected), again.FileContentError);
  assert.equal(fs.existsSync(kept(A)), false);
});

test("without recorded hashes (an older server, or files from before), files are used as before", async t => {
  const { file, dataStore, stored, downloads, kept } = fileCache();
  t.after(() => fs.rmSync(dataStore, { recursive: true, force: true }));
  stored[A] = "x\n";
  await file.ensureFiles([A]);
  fs.writeFileSync(kept(A), "y\n");
  await file.ensureFiles([A], { [B]: sha256("unrelated") });
  assert.deepEqual(downloads, [A]);
  assert.equal(fs.readFileSync(kept(A), "utf8"), "y\n");
});

test("the judge program digest covers its source files, not its tests, and is the same for the same sources", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-judge-program-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { judgeProgramDigest, JUDGE_PROGRAM_SOURCES } = load("runtimeIdentity.ts", {
    "./config": { __esModule: true, default: { sandbox: { rootfsId: "f".repeat(64) } } },
    "./systemInfo": { __esModule: true, default: async () => ({}) }
  });
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  write("apps/judge/index.mjs", "start");
  write("apps/judge/src/rpc.ts", "rpc");
  write("apps/judge/src/task/submission/index.ts", "judge");
  const first = judgeProgramDigest(root);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(judgeProgramDigest(root), first);

  write("apps/judge/src/rpc.test.cjs", "a test");
  write("apps/judge/native/builtin_checkers/smoke-test.mjs", "a smoke test");
  write("apps/judge/vendor/testlib/README.md", "not compiled");
  write("apps/judge/dist/build.js", "build output");
  assert.equal(judgeProgramDigest(root), first, "tests and other files don't count");

  write("apps/judge/src/task/submission/index.ts", "judge differently");
  const changed = judgeProgramDigest(root);
  assert.notEqual(changed, first);
  write("apps/judge/vendor/testlib/testlib.h", "#pragma once");
  assert.notEqual(judgeProgramDigest(root), changed, "the bundled testlib header counts");

  // A file moved to another name is a different program
  fs.renameSync(path.join(root, "apps/judge/src/rpc.ts"), path.join(root, "apps/judge/src/rpc2.ts"));
  assert.notEqual(judgeProgramDigest(root), changed);
  assert(JUDGE_PROGRAM_SOURCES.includes("packages/simple-sandbox/native"));

  // This repository's judge
  assert.match(judgeProgramDigest(), /^[0-9a-f]{64}$/);
});

test("the announced runtime names the judge program, the sandbox image, Node.js and the machine", async () => {
  const { default: getRuntimeInfo, judgeProgramDigest } = load("runtimeIdentity.ts", {
    "./config": { __esModule: true, default: { sandbox: { rootfsId: "f".repeat(64) } } },
    "./systemInfo": {
      __esModule: true,
      default: async () => ({ os: "Ubuntu 26.04", kernel: "Linux 7.0.0", arch: "x64", cpu: { model: "Intel i7" } })
    }
  });
  const runtime = await getRuntimeInfo();
  assert.deepEqual(runtime, {
    judgeProgram: judgeProgramDigest(),
    sandboxImage: "f".repeat(64),
    node: process.version,
    os: "Ubuntu 26.04",
    kernel: "Linux 7.0.0",
    arch: "x64",
    cpu: "Intel i7"
  });
  assert.equal(await getRuntimeInfo(), runtime, "computed once");
});
