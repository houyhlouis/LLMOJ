/* Run with the judge's installed dependencies: node --test apps/judge/src/checkers/builtin.test.cjs. */
// The built-in checkers run as a program of their own: each check starts it with the two files, a time limit and a
// cap on its message, and only that child is ever signalled. The cases with the real program run once the native
// code is built (pnpm build:native); the others use small stand-in programs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const SOURCE = path.join(__dirname, "..");
const loaded = new Map();

// Loads a source file of the judge with its relative imports, as the judge's TypeScript loader would
function load(file) {
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
    name => (name.startsWith(".") ? load(resolve(name)) : require(name)),
    module,
    module.exports,
    path.dirname(file)
  );
  return module.exports;
}

const builtin = load(path.join(SOURCE, "checkers/builtin.ts"));
const programBuilt = fs.existsSync(builtin.BUILTIN_CHECKER_PROGRAM);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llmoj-builtin-checker-"));
process.on("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
const write = (name, content) => {
  const file = path.join(directory, name);
  fs.writeFileSync(file, content);
  return file;
};

const openDescriptors = () => fs.readdirSync("/proc/self/fd").length;
// Child processes of this test process that still exist (zombies included)
const children = () =>
  fs
    .readdirSync("/proc/self/task")
    .flatMap(task => fs.readFileSync(`/proc/self/task/${task}/children`, "utf8").split(" ").filter(Boolean));

// Every signal the wrapper sends: [pid of the child it signals, its pid as known when started]
const signalled = [];
const originalKill = childProcess.ChildProcess.prototype.kill;
childProcess.ChildProcess.prototype.kill = function kill(signal) {
  signalled.push([this.pid, this.exitCode, this.signalCode]);
  return originalKill.call(this, signal);
};

const LIMITS = { time: 2000, message: 4096 };
async function run(script, limits = LIMITS) {
  const output = fs.openSync(write("output", "1 2 3\n"), "r");
  const answer = fs.openSync(write("answer", "4 5 6\n"), "r");
  try {
    return await builtin.runCheckerProcess("/bin/sh", ["-c", script], [output, answer], limits);
  } finally {
    fs.closeSync(output);
    fs.closeSync(answer);
  }
}

test("a checker's message is what it wrote to standard error, whatever its exit status", async () => {
  assert.deepEqual(await run("printf 'wrong answer 1' >&2; exit 1"), {
    message: "wrong answer 1",
    code: 1,
    signal: null
  });
  // The files are descriptors 3 and 4, standard input and output are /dev/null
  assert.equal((await run("cat <&3 >&2; cat <&4 >&2; cat >&2; echo out")).message, "1 2 3\n4 5 6\n");
});

test("a checker that runs too long, writes too much or crashes fails the check and is reaped", async () => {
  const before = { descriptors: openDescriptors(), children: children().length };
  signalled.length = 0;

  const slow = await run("sleep 30", { time: 200, message: 4096 });
  assert.equal(slow.failure, "The built-in checker didn't finish in 0.2 s");
  assert.equal(slow.signal, "SIGKILL");

  const flood = await run("while :; do printf 0123456789abcdef >&2; done");
  assert.equal(flood.failure, "The built-in checker wrote more than 4096 bytes");

  const crash = await run("kill -SEGV $$");
  assert.deepEqual(crash, { failure: "The built-in checker was killed by SIGSEGV", code: null, signal: "SIGSEGV" });

  // Signals went only to running children this module started, never to 0, -1 or a reaped process
  assert.equal(signalled.length, 2);
  for (const [pid, exitCode, signalCode] of signalled) {
    assert(Number.isInteger(pid) && pid > 0, `signalled ${pid}`);
    assert.equal(exitCode, null);
    assert.equal(signalCode, null);
  }
  assert.equal(openDescriptors(), before.descriptors);
  assert.equal(children().length, before.children);
});

test("a process the checker left behind holding standard error doesn't keep the check waiting", async () => {
  const started = Date.now();
  const result = await run("sleep 5 >&2 & printf 'ok' >&2");
  assert.equal(result.message, "ok");
  assert(Date.now() - started < 4000, "waited for the stray process");
});

test("a checker that can't be started rejects, and nothing is signalled", async () => {
  signalled.length = 0;
  const file = fs.openSync(write("input", ""), "r");
  try {
    await assert.rejects(builtin.runCheckerProcess(path.join(directory, "missing"), [], [file, file], LIMITS), {
      code: "ENOENT"
    });
  } finally {
    fs.closeSync(file);
  }
  assert.deepEqual(signalled, []);
});

test("without descriptors to spare, a check rejects, and nothing is signalled or left open", () => {
  // A judge that ran out of descriptors (EMFILE) when starting a checker: run it with a small descriptor limit
  const script = `
    const childProcess = require("child_process");
    const signalled = [];
    const kill = childProcess.ChildProcess.prototype.kill;
    childProcess.ChildProcess.prototype.kill = function (signal) { signalled.push(this.pid); return kill.call(this, signal); };
    const builtin = (${load.toString()})(${JSON.stringify(path.join(SOURCE, "checkers/builtin.ts"))});
    const file = fs.openSync(${JSON.stringify(write("input", "1\n"))}, "r");
    main();
    async function main() {
    // libuv's first child process sets up its signal handling for good
    await builtin.runCheckerProcess("/bin/true", [], [file, file], { time: 1000, message: 100 });
    const descriptors = fs.readdirSync("/proc/self/fd").length;
    const filler = [];
    for (;;) { try { filler.push(fs.openSync("/dev/null", "r")); } catch { break; } }
    fs.closeSync(filler.pop());
    const done = outcome => {
      for (const fd of filler) fs.closeSync(fd);
      console.log(JSON.stringify({ ...outcome, signalled, leaked: fs.readdirSync("/proc/self/fd").length - descriptors }));
    };
    builtin.runCheckerProcess("/bin/true", [], [file, file], { time: 1000, message: 100 }).then(
      () => done({ started: true }),
      error => done({ code: error.code })
    );
    }
  `;
  const prlimit = ["/usr/bin/prlimit", "/bin/prlimit"].find(candidate => fs.existsSync(candidate));
  if (!prlimit) return;
  const result = childProcess.spawnSync(
    prlimit,
    [
      "--nofile=64",
      process.execPath,
      "-e",
      `
    const ts = require("typescript"), fs = require("fs"), path = require("path");
    const loaded = new Map();
    ${script}`
    ],
    { cwd: __dirname, encoding: "utf8" }
  );
  const outcome = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(outcome.code, "EMFILE", result.stderr);
  assert.deepEqual(outcome.signalled, []);
  assert(outcome.leaked <= 0, `leaked ${outcome.leaked} descriptors`);
});

test("checker arguments", () => {
  assert.deepEqual(builtin.builtinCheckerArguments({ type: "integers" }), ["integers"]);
  assert.deepEqual(builtin.builtinCheckerArguments({ type: "floats", precision: 6 }), ["floats", "6"]);
  assert.deepEqual(builtin.builtinCheckerArguments({ type: "tokens", caseSensitive: false }), ["tokens", "0"]);
  assert.deepEqual(builtin.builtinCheckerArguments({ type: "lines", caseSensitive: true }), ["lines", "1"]);
  assert.deepEqual(builtin.builtinCheckerArguments({ type: "binary" }), ["binary"]);
  assert.throws(() => builtin.builtinCheckerArguments({ type: "floats", precision: 1.5 }));
  assert.throws(() => builtin.builtinCheckerArguments({ type: "custom" }));
});

test("the checker program judges as testlib reports", { skip: !programBuilt && "native code not built" }, async () => {
  const answer = write("answer", "1 2 3\n");
  const check = (output, checker) => builtin.runBuiltinChecker(write("output", output), answer, checker);
  assert.deepEqual(await check("1 2 3", { type: "integers" }), {
    score: 100,
    checkerMessage: 'ok 3 number(s): "1 2 3"\n'
  });
  assert.equal((await check("1 2 4", { type: "integers" })).score, 0);
  assert.equal((await check("1.0000001 2 3", { type: "floats", precision: 6 })).score, 100);
  assert.equal((await check("1 2 3\n\n", { type: "lines", caseSensitive: true })).score, 100);
  assert.equal((await check("1 2 3\n", { type: "binary" })).score, 100);
  assert.equal((await check("1 2 3", { type: "binary" })).score, 0);

  // A link in place of the output is an empty output, never followed
  const link = path.join(directory, "link");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(answer, link);
  const linked = await builtin.runBuiltinChecker(link, answer, { type: "integers" });
  assert.equal(linked.score, 0);
  assert.match(linked.checkerMessage, /expected 3 elements but found 0/);
});

test(
  "checks leave no descriptors or processes behind",
  { skip: !programBuilt && "native code not built" },
  async () => {
    const output = write("output", "1 2 3\n");
    const answer = write("answer", "1 2 3\n");
    await builtin.runBuiltinChecker(output, answer, { type: "integers" });
    const before = { descriptors: openDescriptors(), children: children().length };
    for (let round = 0; round < 50; round++)
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        Array.from({ length: 20 }, () =>
          builtin.runBuiltinChecker(output, answer, { type: "tokens", caseSensitive: true })
        )
      );
    assert.equal(openDescriptors(), before.descriptors);
    assert.equal(children().length, before.children);
  }
);
