/* Run: node --test apps/judge/src/aiCheckpoint.test.cjs (after building packages/judge-protocol) */
// What an AI run keeps for its next attempt (review Part III, W03/W04): a job's builds, by everything their binary
// depends on, and the inputs its generators made, by generator build; and their cleanup.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const protocol = require("@libreoj/judge-protocol");

const RUNTIME = { judgeProgram: "a".repeat(64), sandboxImage: "bbe9c69b2027", arch: "x64" };
const JOB = "0f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
const KEY = "b".repeat(64);

// `free`: bytes the data store's file system has free
function load(t, free = 1e12) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-ai-checkpoint-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "aiCheckpoint.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const loaded = { exports: {} };
  const runtime = { ...RUNTIME };
  const stubs = {
    winston: { __esModule: true, default: { warn: () => {} } },
    "@libreoj/judge-protocol": protocol,
    "./config": { __esModule: true, default: { dataStore: root } },
    "./runtimeIdentity": {
      __esModule: true,
      default: async () => ({ ...runtime, node: "v24", os: "x", kernel: "y", cpu: "z" })
    }
  };
  new Function("require", "module", "exports", source)(
    name => {
      if (name === "fs")
        return { ...fs, promises: { ...fs.promises, statfs: async () => ({ bavail: free, bsize: 1 }) } };
      return ["crypto", "path"].includes(name)
        ? require(name)
        : stubs[name] || assert.fail(`Unexpected import ${name}`);
    },
    loaded,
    loaded.exports
  );
  return { ...loaded.exports, root, runtime };
}

const inputs = (overrides = {}) => ({
  source: "int main(){}",
  options: { compiler: "g++", std: "c++17", O: "2", m: "64" },
  testlib: false,
  extraSources: null,
  grader: null,
  runtime: RUNTIME,
  ...overrides
});

test("a build's key covers its source, options, headers, extra sources, grader and the judge's runtime", t => {
  const { buildKey } = load(t);
  const base = buildKey(inputs());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(buildKey(inputs()), base, "stable");
  assert.equal(
    buildKey({ ...inputs(), options: { m: "64", O: "2", std: "c++17", compiler: "g++" } }),
    base,
    "whatever order the fields are in"
  );
  for (const changed of [
    { source: "int main(){return 0;}" },
    { options: { compiler: "g++", std: "c++20", O: "2", m: "64" } },
    { options: { compiler: "clang++", std: "c++17", O: "2", m: "64" } },
    { testlib: true },
    { extraSources: { "lib.h": "int f();" } },
    { grader: "int main(){}" },
    { runtime: { ...RUNTIME, judgeProgram: "c".repeat(64) } },
    { runtime: { ...RUNTIME, sandboxImage: "bdbacc14b183" } },
    { runtime: { ...RUNTIME, arch: "arm64" } }
  ])
    assert.notEqual(buildKey(inputs(changed)), base, JSON.stringify(changed));
});

test("a job's builds are taken back exactly, counted, and never from another job", async t => {
  const { JobBuilds, buildKey, root } = load(t);
  const builds = new JobBuilds(JOB);
  const key = buildKey(inputs());
  assert.equal(await builds.take(key), null);
  const binary = crypto.randomBytes(4096);
  await builds.keep(key, binary);
  const file = path.join(root, "ai-builds", JOB, key);
  assert.equal(fs.statSync(file).mode & 0o777, 0o500);
  assert.deepEqual(await builds.take(key), binary);
  assert.equal(builds.reused, 1);
  assert.equal(await new JobBuilds("1f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f").take(key), null, "another job's");
  assert.equal(await builds.take("../" + key), null, "only keys");
  assert.throws(() => new JobBuilds("../x"), /Invalid job UUID/);
  // A link where a build would be isn't followed
  const other = buildKey(inputs({ source: "x" }));
  fs.symlinkSync(file, path.join(root, "ai-builds", JOB, other));
  assert.equal(await builds.take(other), null);
  assert.equal(builds.reused, 1);
});

test("a generator's inputs are replayed only for the same generator build on the same runtime", async t => {
  const { GeneratorInputs, root } = load(t);
  const first = new GeneratorInputs(JOB, KEY, RUNTIME);
  assert.equal(await first.take("make", 1, 7), null);
  await first.keep("make", 1, 7, Buffer.from("5\n1 2 3 4 5\n"));
  await first.keep("quality-small-make", 2, 3, Buffer.from("1\n"));
  // Whatever else of the run changed: another reference solution or checker is checked on the same inputs
  const again = new GeneratorInputs(JOB, KEY, RUNTIME);
  assert.equal((await again.take("make", 1, 7)).toString(), "5\n1 2 3 4 5\n");
  assert.equal((await again.take("quality-small-make", 2, 3)).toString(), "1\n");
  assert.equal(await again.take("make", 1, 8), null, "another case index");
  assert.equal(await again.take("quality-small-make", 1, 7), null, "another generator");
  assert.equal(again.reused, 2);
  assert.equal(await new GeneratorInputs(JOB, "c".repeat(64), RUNTIME).take("make", 1, 7), null, "another build");
  assert.equal(
    await new GeneratorInputs(JOB, KEY, { ...RUNTIME, judgeProgram: "d".repeat(64) }).take("make", 1, 7),
    null,
    "after the judge was upgraded"
  );
  for (const name of ["std", "checker", "../make"])
    await assert.rejects(() => again.take(name, 1, 7), /Invalid generated input/);
  assert.throws(() => new GeneratorInputs(JOB, "short", RUNTIME), /Invalid AI generator/);
  // Kept files are written whole: no temporary file is left
  const directory = fs.readdirSync(path.join(root, "ai-corpus", JOB));
  assert.equal(directory.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, "ai-corpus", JOB, directory[0])).sort(), [
    "make-1-7.in",
    "quality-small-make-2-3.in"
  ]);
  await again.discard();
  assert.equal(await new GeneratorInputs(JOB, KEY, RUNTIME).take("make", 1, 7), null, "discarded once completed");
});

test("no input is kept when the disk is nearly full: they're only an optimization", async t => {
  const { GeneratorInputs } = load(t, 2 * 1024 * 1024 * 1024);
  const inputs = new GeneratorInputs(JOB, KEY, RUNTIME);
  await inputs.keep("make", 1, 7, Buffer.from("1\n"));
  assert.equal(await inputs.take("make", 1, 7), null);
});

test("a generator keeps at most so many bytes of inputs; past them, inputs are generated again", async t => {
  const { GeneratorInputs } = load(t);
  const inputs = new GeneratorInputs(JOB, KEY, RUNTIME, 10);
  await inputs.keep("make", 1, 1, Buffer.from("123456\n"));
  await inputs.keep("make", 1, 2, Buffer.from("123456\n"));
  // Counted again after a restart, from what's there
  const again = new GeneratorInputs(JOB, KEY, RUNTIME, 14);
  await again.keep("make", 1, 3, Buffer.from("1234\n"));
  await again.keep("make", 1, 4, Buffer.from("123456\n"));
  assert.deepEqual(
    await Promise.all([1, 2, 3, 4].map(async index => (await again.take("make", 1, index))?.toString() ?? null)),
    ["123456\n", null, "1234\n", null]
  );
});

test("what's kept goes a day after its last use, never while a run holds the job; a job's cleanup deletes it", async t => {
  const { JobBuilds, GeneratorInputs, buildKey, holdingJob, discardJob, pruneAiCheckpoints, root } = load(t);
  const old = "2f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
  const task = "3f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
  const activeTask = "4f6c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f";
  for (const job of [JOB, old]) {
    await new JobBuilds(job).keep(buildKey(inputs()), Buffer.from("binary"));
    await new GeneratorInputs(job, KEY, RUNTIME).keep("make", 1, 1, Buffer.from("1\n"));
  }
  for (const id of [task, activeTask]) fs.mkdirSync(path.join(root, "ai-work", id, "output"), { recursive: true });
  fs.mkdirSync(path.join(root, "ai-work", "not-a-task"), { recursive: true });
  const day = 24 * 60 * 60 * 1000;
  const later = Date.now() + day + 60000;
  const exists = (...parts) => fs.existsSync(path.join(root, ...parts));
  await holdingJob(JOB, async () => {
    await pruneAiCheckpoints(new Set([activeTask]), later);
    assert(exists("ai-builds", JOB) && exists("ai-corpus", JOB), "held by a run");
    await discardJob(JOB);
    assert(exists("ai-builds", JOB), "not even by its cleanup");
  });
  assert(!exists("ai-builds", old) && !exists("ai-corpus", old), "a day after its last use");
  assert(!exists("ai-work", task), "a workspace a restart left behind");
  assert(exists("ai-work", activeTask) && exists("ai-work", "not-a-task"), "a running task's, and nothing else");
  await pruneAiCheckpoints(new Set(), Date.now());
  assert(exists("ai-builds", JOB), "not before a day");
  await discardJob(JOB);
  assert(!exists("ai-builds", JOB) && !exists("ai-corpus", JOB));
  await discardJob("../x");
});
