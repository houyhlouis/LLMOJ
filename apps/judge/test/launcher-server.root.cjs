// The sandbox launcher's boundary, with real sandboxes: what it gives the sandbox user and back, the descriptors it
// places, and what it refuses. Run as root in a unit with delegated cgroups, from apps/judge:
//   systemd-run --wait --pipe --collect --property="Delegate=cpu memory pids" --property=DelegateSubgroup=supervisor \
//     --working-directory=$PWD node -r @swc-node/register test/launcher-server.root.cjs
// The judge's account is `nobody` here: the launcher only needs its IDs.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.getuid() !== 0) throw new Error("Run as root in a unit with delegated cgroups (see the header)");

const { LauncherServer } = require("../src/launcher/server");
const { loadSettings } = require("../src/launcher/settings");
const native = require("../src/launcher/native");
const { SandboxStatus } = require("simple-sandbox");

const JUDGE = { uid: 65534, gid: 65534 };
const SANDBOX = { uid: 12345, gid: 12345 };
const ID = "c".repeat(64);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-server-"));
fs.chmodSync(root, 0o711);
const at = (...parts) => path.join(root, ...parts);
const rootfs = at("rootfs");
for (const directory of ["etc", "proc", "dev", "tmp", "sandbox/binary", "sandbox/working", "sandbox/source"])
  fs.mkdirSync(path.join(rootfs, directory), { recursive: true });
fs.writeFileSync(
  path.join(rootfs, "etc/passwd"),
  `root:x:0:0::/:/bin/false\nsandbox:x:${SANDBOX.uid}:${SANDBOX.gid}::/:/bin/false\n`
);
fs.writeFileSync(path.join(rootfs, "etc/libreoj-rootfs-id"), `${ID}\n`);
for (const directory of ["work/1/temp", "work/1/working", "cache/bin", "testdata", "samples"])
  fs.mkdirSync(at(directory), { recursive: true });
const compiled = childProcess.spawnSync(
  "cc",
  ["-O2", "-static", path.join(__dirname, "launcher-fixture.c"), "-o", at("cache/bin/fixture")],
  { encoding: "utf8" }
);
if (compiled.status !== 0) throw new Error(`Fixture compilation failed:\n${compiled.stderr}`);
fs.writeFileSync(at("cache/bin/data.txt"), "read-only data\n", { mode: 0o600 });
// The judge's own directories, as the launcher prepares them
for (const directory of ["work/1", "work/1/temp", "work/1/working", "cache", "cache/bin", "testdata"])
  fs.chownSync(at(directory), JUDGE.uid, JUDGE.gid);
for (const file of ["cache/bin/fixture", "cache/bin/data.txt"]) fs.chownSync(at(file), JUDGE.uid, JUDGE.gid);
fs.chmodSync(at("samples"), 0o700);
const CANARY = at("canary");
fs.writeFileSync(CANARY, "root's\n", { mode: 0o600 });

const settings = loadSettings({
  sandbox: { rootfs, rootfsId: ID, user: "sandbox", hostname: "launcher-test", environments: {} },
  taskWorkingDirectories: [at("work/1")],
  dataStore: at("testdata"),
  binaryCacheStore: at("cache"),
  aiRunnerSocket: at("ai.sock"),
  aiGeneratedDirectory: at("ai-generated"),
  aiRunnerGid: 1
});
const logs = [];
const server = new LauncherServer(settings, JUDGE, SANDBOX, at("samples"), message => logs.push(message));
const [launcherEnd, judgeEnd] = native.seqpacketPair();
server.serve(launcherEnd, () => {});

// The judge's side of the channel
const pending = new Map();
let nextId = 1;
const judge = new native.Channel(judgeEnd, (data, descriptors) => {
  if (!data) return;
  const message = JSON.parse(data.toString());
  const handler = pending.get(message.id);
  if (handler) handler(message, descriptors);
  else descriptors.forEach(fd => fs.closeSync(fd));
});
function exchange(message, descriptors, until = ["result", "failed", "sample"]) {
  const id = nextId++;
  const replies = [];
  return {
    id,
    done: new Promise(resolve => {
      pending.set(id, (reply, passed) => {
        replies.push({ ...reply, descriptors: passed });
        if (until.includes(reply.op)) {
          pending.delete(id);
          resolve(replies);
        }
      });
      judge.send(Buffer.from(JSON.stringify({ ...message, id })), descriptors);
    })
  };
}
const request = (parameters, changes = {}) => ({
  time: 2000,
  memory: 64 * 1024 * 1024,
  stackSize: 8 * 1024 * 1024,
  process: 4,
  strategy: "UserProgram",
  executable: "/sandbox/binary/fixture",
  parameters: ["/sandbox/binary/fixture", ...parameters],
  environments: ["PATH=/bin"],
  workingDirectory: "/sandbox/working",
  mounts: [
    { outside: at("work/1/temp"), inside: "/tmp", writable: true },
    { outside: at("cache/bin"), inside: "/sandbox/binary", writable: false },
    { outside: at("work/1/working"), inside: "/sandbox/working", writable: true }
  ],
  descriptors: [],
  stdin: null,
  stdout: null,
  stderr: null,
  ...changes
});
// The judge's pipes belong to its account: made here with its IDs for the moment
function judgePipe() {
  process.setegid(JUDGE.gid);
  process.seteuid(JUDGE.uid);
  try {
    return native.pipe();
  } finally {
    process.seteuid(0);
    process.setegid(0);
  }
}
// Runs a program with its standard output in a pipe; resolves with the replies and what it printed
async function run(parameters, changes = {}, extra = []) {
  const [read, write] = (() => {
    const p = judgePipe();
    return [p.read, p.write];
  })();
  const descriptors = [write, ...extra];
  const { done } = exchange(
    { op: "start", sandbox: request(parameters, { descriptors, stdout: write, ...changes }) },
    descriptors
  );
  fs.closeSync(write);
  const replies = await done;
  const output = fs.readFileSync(read, "utf8");
  fs.closeSync(read);
  return {
    replies,
    output,
    result: replies.find(reply => reply.op === "result")?.result,
    failed: replies.find(reply => reply.op === "failed")
  };
}
const owner = file => {
  const stat = fs.lstatSync(file);
  return { uid: stat.uid, mode: stat.mode & 0o7777 };
};

after(() => {
  judge.close();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a program runs as the sandbox user; what it made in writable directories is given back to the judge", async () => {
  const { result, output } = await run(["id"]);
  assert.equal(result.status, SandboxStatus.OK);
  assert.equal(output, `uid=${SANDBOX.uid} gid=${SANDBOX.gid}\n`);
  const written = await run(["write"]);
  assert.equal(written.result.status, SandboxStatus.OK, JSON.stringify(written));
  assert.deepEqual(owner(at("work/1/working/made-by-sandbox")), { uid: JUDGE.uid, mode: 0o600 });
  assert.equal(owner(at("work/1/working")).uid, JUDGE.uid);
});

test("read-only directories are made readable, not given away", async () => {
  const { result, output } = await run(["read", "/sandbox/binary/data.txt"]);
  assert.equal(result.status, SandboxStatus.OK);
  assert.equal(output, "read-only data\n");
  assert.deepEqual(owner(at("cache/bin/data.txt")), { uid: JUDGE.uid, mode: 0o755 });
});

test("passed descriptors arrive at the judge's numbers", async () => {
  const p = judgePipe();
  // A number the judge holds, which the program must see as the same
  const number = fs.openSync("/dev/null", "r");
  fs.closeSync(number);
  const { result } = await run(["fd", String(p.write)], {}, [p.write]);
  fs.closeSync(p.write);
  assert.equal(result.status, SandboxStatus.OK);
  assert.equal(fs.readFileSync(p.read, "utf8"), "through the passed descriptor\n");
  fs.closeSync(p.read);
});

test("a program's links, pipes and unreadable files: never followed, and the judge can remove everything", async () => {
  const before = owner(CANARY);
  const hostile = await run(["hostile", CANARY]);
  assert.equal(hostile.result.status, SandboxStatus.OK, JSON.stringify(hostile));
  // Preparing the next run in the same directory doesn't follow the link either
  assert.equal((await run(["id"])).result.status, SandboxStatus.OK);
  assert.deepEqual(owner(CANARY), before);
  assert.equal(fs.readFileSync(CANARY, "utf8"), "root's\n");
  for (const name of ["closed", "hidden", "hidden/secret", "unreadable", "deep/deep/deep"])
    assert.equal(owner(at("work/1/working", name)).uid, JUDGE.uid, name);
  // The judge's account empties its directory itself
  const removed = childProcess.spawnSync(
    "rm",
    [
      "-rf",
      "--",
      at("work/1/working/closed"),
      at("work/1/working/hidden"),
      at("work/1/working/unreadable"),
      at("work/1/working/pipe"),
      at("work/1/working/canary"),
      at("work/1/working/deep")
    ],
    { uid: JUDGE.uid, gid: JUDGE.gid, encoding: "utf8" }
  );
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(owner(CANARY), before);
});

test("mounts outside the judge's directories, writable read-only ones, links and paths are refused", async () => {
  const refused = async (changes, pattern) => {
    const { failed } = await run(["id"], changes);
    assert(failed, `refused: ${JSON.stringify(changes)}`);
    assert.match(failed.message, pattern);
  };
  const mounts = extra => [{ outside: at("work/1/temp"), inside: "/tmp", writable: true }, ...extra];
  await refused(
    { mounts: mounts([{ outside: "/etc", inside: "/sandbox/working", writable: false }]) },
    /not in one of the judge's directories/
  );
  await refused(
    { mounts: mounts([{ outside: at("cache/bin"), inside: "/sandbox/binary", writable: true }]) },
    /writable but not in a task working directory/
  );
  fs.symlinkSync("/etc", at("work/1/link"));
  await refused(
    { mounts: mounts([{ outside: at("work/1/link"), inside: "/sandbox/working", writable: false }]) },
    /Not a directory|Too many levels/
  );
  fs.unlinkSync(at("work/1/link"));
  await refused({ stdin: "/etc/shadow" }, /stdin must be one of the passed descriptors/);
  // Only the judge's own pipes and files: not root's, nor a directory a program could open files through
  const rootPipe = native.pipe();
  const directory = fs.openSync("/etc", "r");
  for (const fd of [rootPipe.read, directory]) {
    const { failed } = await run(["id"], {}, [fd]);
    assert.match(failed.message, /Only the judge's own pipes and files/);
  }
  [rootPipe.read, rootPipe.write, directory].forEach(fd => fs.closeSync(fd));
  await refused({ strategy: "Root" }, /strategy/);
  assert.deepEqual(owner(CANARY).uid, 0);
});

test("stopping and the time limit end a program", async () => {
  const p = judgePipe();
  const { id, done } = exchange(
    { op: "start", sandbox: request(["spin"], { descriptors: [p.write], stdout: p.write }) },
    [p.write]
  );
  fs.closeSync(p.write);
  setTimeout(() => judge.send(Buffer.from(JSON.stringify({ op: "stop", id }))), 300);
  const replies = await done;
  fs.closeSync(p.read);
  assert.deepEqual(
    replies.map(reply => reply.op),
    ["started", "result"]
  );
  assert.equal(replies[1].result.status, SandboxStatus.Cancelled);
  const limited = await run(["spin"], { time: 200 });
  assert.equal(limited.result.status, SandboxStatus.TimeLimitExceeded);
});

test("a sample file of a local AI job opens read-only, through no link", async () => {
  const job = "0f8e5a3c-1b2d-4c6e-9a7f-1234567890ab";
  fs.mkdirSync(at("samples", job), { mode: 0o700 });
  fs.writeFileSync(at("samples", job, "1.in"), "20 22\n", { mode: 0o600 });
  fs.symlinkSync("/etc/hostname", at("samples", job, "2.in"));
  const [opened] = await exchange({ op: "openSample", job, name: "1.in" }).done;
  assert.equal(opened.op, "sample");
  assert.equal(fs.readFileSync(opened.descriptors[0], "utf8"), "20 22\n");
  fs.closeSync(opened.descriptors[0]);
  for (const [name, pattern] of [
    ["2.in", /ELOOP|symbolic links/],
    ["../1.in", /Invalid sample file/]
  ]) {
    const [reply] = await exchange({ op: "openSample", job, name }).done;
    assert.equal(reply.op, "failed");
    assert.match(reply.message, pattern);
  }
  const [other] = await exchange({ op: "openSample", job: "../samples", name: "1.in" }).done;
  assert.match(other.message, /Invalid sample file/);
});
