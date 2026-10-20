/* Run with the judge's installed dependencies: node --test apps/judge/src/launcher/policy.test.cjs. */
// The sandbox launcher runs as root and takes requests from the judge, which doesn't: what a request may ask for, and
// what the launcher takes from the configuration instead.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

// Loads a TypeScript module of this directory, and the ones it imports from here
function load(file, cache = {}) {
  if (cache[file]) return cache[file].exports;
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const loaded = { exports: {} };
  cache[file] = loaded;
  new Function("require", "module", "exports", "__dirname", source)(
    name => (name.startsWith("./") ? load(`${name.slice(2)}.ts`, cache) : require(name)),
    loaded,
    loaded.exports,
    __dirname
  );
  return loaded.exports;
}

const { loadSettings, SettingsError } = load("settings.ts");
const { checkSandboxRequest, RequestError, sandboxParameter } = load("policy.ts");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-policy-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const rootfs = path.join(root, "rootfs");
fs.mkdirSync(path.join(rootfs, "etc"), { recursive: true });
const ID = "a".repeat(64);
fs.writeFileSync(path.join(rootfs, "etc/libreoj-rootfs-id"), `${ID}\n`);

const config = (changes = {}) => ({
  sandbox: { rootfs, rootfsId: ID, user: "sandbox", hostname: "libreoj-judge", environments: {} },
  taskWorkingDirectories: ["/srv/judge/work/1", "/srv/judge/work/2"],
  dataStore: "/srv/judge/testdata",
  binaryCacheStore: "/srv/judge/cache",
  cpuAffinity: { compiler: [1], userProgram: [2], interactor: [3], checker: [4] },
  aiRunnerSocket: "/srv/judge/ai-runner.sock",
  aiGeneratedDirectory: "/srv/ai-generated",
  aiRunnerGid: 1234,
  ...changes
});
const settings = loadSettings(config());

const request = (changes = {}) => ({
  time: 1000,
  memory: 256 * 1024 * 1024,
  stackSize: 256 * 1024 * 1024,
  process: 1,
  strategy: "UserProgram",
  executable: "/sandbox/binary/a.out",
  parameters: ["/sandbox/binary/a.out"],
  environments: ["PATH=/usr/bin:/bin"],
  workingDirectory: "/sandbox/working",
  mounts: [
    { outside: "/srv/judge/work/1/temp", inside: "/tmp", writable: true },
    { outside: "/srv/judge/cache/3f2a", inside: "/sandbox/binary", writable: false },
    { outside: "/srv/judge/work/1/working", inside: "/sandbox/working", writable: true }
  ],
  descriptors: [7, 9],
  stdin: 7,
  stdout: 9,
  stderr: null,
  ...changes
});
const refused = (changes, pattern, passed = 2) =>
  assert.throws(
    () => checkSandboxRequest(request(changes), settings, passed),
    error => {
      assert(error instanceof RequestError, String(error));
      assert.match(error.message, pattern);
      return true;
    }
  );

test("the settings come from the configuration, checked", () => {
  assert.equal(settings.rootfs, rootfs);
  assert.equal(settings.syscallFilter, true);
  assert.deepEqual(settings.cpuAffinity.Checker, [4]);
  assert.equal(settings.maxSandboxes, 6);
  assert.equal(settings.aiRunnerGid, 1234);
  assert.equal(loadSettings(config({ sandbox: { ...config().sandbox, syscallFilter: false } })).syscallFilter, false);
  // A remote judge has no local AI runner
  const remote = loadSettings(config({ aiRunnerSocket: null, aiGeneratedDirectory: null, aiRunnerGid: 0 }));
  assert.equal(remote.aiGeneratedDirectory, null);
  for (const [changes, pattern] of [
    [{ sandbox: { ...config().sandbox, rootfsId: "b".repeat(64) } }, /doesn't match the installed image/],
    [{ dataStore: "relative/testdata" }, /dataStore must be an absolute, normalized path/],
    [{ binaryCacheStore: "/srv/judge/../cache" }, /binaryCacheStore must be/],
    [{ taskWorkingDirectories: ["/srv/judge/work/1", "/srv/judge/work/1"] }, /duplicates/],
    [{ taskWorkingDirectories: ["/"] }, /taskWorkingDirectories\[0\]/],
    [{ aiRunnerGid: 0 }, /aiRunnerGid/],
    [{ cpuAffinity: { compiler: ["1"] } }, /cpuAffinity.compiler/]
  ])
    assert.throws(
      () => loadSettings(config(changes)),
      error => error instanceof SettingsError && pattern.test(error.message)
    );
});

test("a request from the judge is checked and resolved against the judge's directories", () => {
  const checked = checkSandboxRequest(request(), settings, 2);
  assert.deepEqual(checked.mounts, [
    { root: "/srv/judge/work/1", relative: "temp", inside: "/tmp", writable: true },
    { root: "/srv/judge/cache", relative: "3f2a", inside: "/sandbox/binary", writable: false },
    { root: "/srv/judge/work/1", relative: "working", inside: "/sandbox/working", writable: true }
  ]);
  assert.deepEqual([checked.stdin, checked.stdout, checked.stderr], [7, 9, null]);
  // Read-only mounts may come from the data store and the AI output root too
  const readOnly = checkSandboxRequest(
    request({
      mounts: [
        { outside: "/srv/judge/testdata/ai-work/1/bin", inside: "/tmp", writable: false },
        { outside: "/srv/ai-generated/job/bin", inside: "/tmp/libreoj/binary", writable: false }
      ]
    }),
    settings,
    2
  );
  assert.deepEqual(
    readOnly.mounts.map(mount => mount.root),
    ["/srv/judge/testdata", "/srv/ai-generated"]
  );
  // The task working directory itself, as a mount
  assert.equal(
    checkSandboxRequest(
      request({ mounts: [{ outside: "/srv/judge/work/2", inside: "/tmp", writable: true }] }),
      settings,
      2
    ).mounts[0].relative,
    ""
  );
});

test("mounts stay in the judge's directories, writable ones in task working directories", () => {
  const mount = (outside, inside = "/sandbox/working", writable = false) => ({
    mounts: [{ outside, inside, writable }]
  });
  refused(mount("/etc"), /not in one of the judge's directories/);
  refused(mount("/srv/judge"), /not in one of the judge's directories/);
  refused(mount("/srv/judge/work/10"), /not in one of the judge's directories/);
  refused(mount("/srv/judge/work/1/../../../etc"), /absolute, normalized/);
  refused(mount("/srv/judge/work/1/a//b"), /absolute, normalized/);
  refused(mount("srv/judge/work/1"), /absolute, normalized/);
  refused(mount("/srv/judge/cache/x", "/sandbox/binary", true), /writable but not in a task working directory/);
  refused(mount("/srv/judge/testdata/x", "/tmp", true), /writable but not in a task working directory/);
  refused(mount("/srv/ai-generated/x", "/tmp", true), /writable but not in a task working directory/);
  refused(mount("/srv/judge/work/1/x", "/etc"), /inside must be/);
  refused(mount("/srv/judge/work/1/x", "/sandbox"), /directory under \/sandbox/);
  refused(mount("/srv/judge/work/1/x", "/tmp/../etc"), /inside must be/);
  refused(mount("/srv/judge/work/1/x", "/"), /inside must be/);
  refused(
    {
      mounts: [
        { outside: "/srv/judge/work/1/a", inside: "/tmp", writable: true },
        { outside: "/srv/judge/work/1/b", inside: "/tmp", writable: true }
      ]
    },
    /mounted twice/
  );
  refused({ mounts: [] }, /mounts must list/);
  refused({ mounts: [{ outside: "/srv/judge/work/1", inside: "/tmp", writable: "yes" }] }, /writable must be/);
});

test("descriptors, standard I/O and limits must be what the launcher can place", () => {
  refused({ descriptors: [2, 9] }, /descriptors\[0\]/);
  refused({ descriptors: [7, 1024] }, /descriptors\[1\]/);
  refused({ descriptors: [7, 7] }, /duplicates/);
  refused({}, /another number of descriptors/, 3);
  refused({ stdin: 8 }, /stdin must be one of the passed descriptors/);
  refused({ stderr: "/etc/shadow" }, /stderr must be one of the passed descriptors/);
  refused({ strategy: "Root" }, /strategy/);
  refused({ time: -1 }, /time must be/);
  refused({ time: 1.5 }, /time must be/);
  refused({ memory: 0 }, /memory must be/);
  refused({ process: 100000 }, /process must be/);
  refused({ executable: "a\0b" }, /executable/);
  refused({ parameters: [] }, /program's name/);
  refused({ parameters: "a.out" }, /parameters must be a list/);
  refused({ environments: ["LD_PRELOAD"] }, /NAME=value/);
  refused({ workingDirectory: "../working" }, /workingDirectory/);
  assert.throws(() => checkSandboxRequest(null, settings, 0), RequestError);
  assert.throws(() => checkSandboxRequest([], settings, 0), RequestError);
});

test("the sandbox gets its image, user, filter, CPUs and resource mode from the settings", () => {
  const user = { uid: 999, gid: 999 };
  const parameter = sandboxParameter(checkSandboxRequest(request(), settings, 2), settings, user, [40, 41]);
  assert.equal(parameter.chroot, rootfs);
  assert.equal(parameter.hostname, "libreoj-judge");
  assert.deepEqual(parameter.user, user);
  assert.equal(parameter.syscallFilter, true);
  assert.equal(parameter.mountProc, true);
  assert.equal(parameter.redirectBeforeChroot, false);
  assert.deepEqual(parameter.cpuAffinity, [2]);
  assert.deepEqual(parameter.descriptors, [
    [40, 7],
    [41, 9]
  ]);
  assert.deepEqual([parameter.stdin, parameter.stdout, parameter.stderr], [7, 9, undefined]);
  assert.deepEqual(parameter.mounts[1], { src: "/srv/judge/cache", beneath: "3f2a", dst: "/sandbox/binary", limit: 0 });
  assert.equal(parameter.mounts[2].limit, -1);
  assert.equal(parameter.resourceMode, "default");
  assert.equal(parameter.addressSpaceLimit, undefined);
  // The arbiter mode applies to the submitted program only
  const arbiter = loadSettings(config({ sandbox: { ...config().sandbox, resourceMode: "arbiter" } }));
  const program = sandboxParameter(checkSandboxRequest(request(), arbiter, 2), arbiter, user, [40, 41]);
  assert.deepEqual([program.resourceMode, program.addressSpaceLimit], ["arbiter", 256 * 1024 * 1024]);
  const compiler = sandboxParameter(
    checkSandboxRequest(request({ strategy: "Compiler" }), arbiter, 2),
    arbiter,
    user,
    [40, 41]
  );
  assert.deepEqual(
    [compiler.resourceMode, compiler.addressSpaceLimit, compiler.cpuAffinity],
    ["default", undefined, [1]]
  );
});
