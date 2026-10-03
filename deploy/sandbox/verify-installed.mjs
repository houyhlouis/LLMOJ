#!/usr/bin/env node
// The installer runs this in its own delegated transient unit before starting judge.
import { promises as fs, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export class VerificationError extends Error {}

export const verificationSource = String.raw`
#include <iostream>
#include <string>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/statvfs.h>
#include <netinet/in.h>
#include <arpa/inet.h>
static bool cannot_read(const std::string &name) {
    FILE *file = std::fopen(name.c_str(), "r");
    if (!file) return true;
    std::fclose(file);
    return false;
}
int main(int argc, char **argv) {
    if (argc != 5) return 10;
    if (getuid() == 0 || getuid() != static_cast<unsigned>(std::strtoul(argv[4], nullptr, 10))) return 11;
    if (getpid() != 1) return 12;
    struct statvfs filesystem;
    if (statvfs("/", &filesystem) != 0 || !(filesystem.f_flag & ST_RDONLY)) return 13;
    if (!cannot_read(argv[1]) || !cannot_read(std::string("/proc/1/root") + argv[1])) return 14;
    char namespace_name[256] = {};
    const auto length = readlink("/proc/self/ns/net", namespace_name, sizeof(namespace_name) - 1);
    if (length < 0 || std::string(namespace_name, length) == argv[3]) return 15;
    const int descriptor = socket(AF_INET, SOCK_STREAM, 0);
    if (descriptor < 0) return 16;
    timeval timeout{1, 0};
    if (setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) != 0) return 17;
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<unsigned short>(std::strtoul(argv[2], nullptr, 10)));
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    const int connected = connect(descriptor, reinterpret_cast<sockaddr *>(&address), sizeof(address));
    close(descriptor);
    if (connected == 0) return 18;
    long long a = 0, b = 0;
    if (!(std::cin >> a >> b)) return 19;
    std::cout << (a + b) << '\n';
    return 0;
}
`;

export function assertCgroupSettings(settings, parameter) {
  // native/addon.cc GetEffectiveMemoryLimit keeps the upstream 25% hard-limit
  // margin; JS still classifies the result against the requested memory budget.
  const effectiveMemory = parameter.memory < 0 ? "max" : String(Math.trunc(parameter.memory / 4) * 5);
  if (parameter.resourceMode !== "default" || settings.memory.trim() !== effectiveMemory ||
      settings.pids.trim() !== String(parameter.process) || settings.swap.trim() !== "0") {
    throw new VerificationError("The installed sandbox did not apply the required default cgroup memory/process limits.");
  }
}

function listSandboxGroups(delegatedRoot) {
  return readdirSync(delegatedRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^sandbox-[0-9a-f]{32}$/.test(entry.name))
    .map(entry => entry.name).sort();
}

function inspectNewCgroup(delegatedRoot, baseline, parameter) {
  // Synchronous inspection runs before JS completion callbacks can remove the
  // native child's cgroup, including when the tiny executable finishes quickly.
  const created = listSandboxGroups(delegatedRoot).filter(name => !baseline.includes(name));
  if (created.length !== 1) throw new VerificationError("The installed sandbox did not create exactly one isolated execution cgroup.");
  const directory = path.join(delegatedRoot, created[0]);
  assertCgroupSettings({
    memory: readFileSync(path.join(directory, "memory.max"), "utf8"),
    pids: readFileSync(path.join(directory, "pids.max"), "utf8"),
    swap: readFileSync(path.join(directory, "memory.swap.max"), "utf8")
  }, parameter);
}

export async function verifyWithSandbox({ Sandbox, config, workingDirectory, markerPath,
  hostNetworkNamespace, hostPort, user, delegatedRoot, active = new Set(),
  listGroups = listSandboxGroups, inspectCgroup = inspectNewCgroup, interrupted = () => false }) {
  if (config.sandbox.resourceMode !== "default" || !Number.isSafeInteger(user.uid) || user.uid <= 0 ||
      !Number.isSafeInteger(user.gid) || user.gid < 0) {
    throw new VerificationError("Installation verification requires the non-root LibreOJ sandbox user and resourceMode default.");
  }
  await fs.writeFile(path.join(workingDirectory, "main.cpp"), verificationSource, { mode: 0o644 });
  await fs.writeFile(path.join(workingDirectory, "input.txt"), "42 1\n", { mode: 0o644 });
  const environments = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp", LC_ALL: "C", ...config.sandbox.environments };
  const common = {
    resourceMode: "default", process: 16, chroot: config.sandbox.rootfs,
    hostname: config.sandbox.hostname || "libreoj-install-check", user,
    mounts: [{ src: workingDirectory, dst: "/tmp", limit: -1 }],
    redirectBeforeChroot: false, mountProc: true, workingDirectory: "/tmp",
    environments: Object.entries(environments).map(([key, value]) => `${key}=${value}`)
  };
  const run = async (stage, parameter) => {
    if (interrupted()) throw new VerificationError("Sandbox installation verification was interrupted.");
    const baseline = listGroups(delegatedRoot);
    const sandbox = Sandbox.startSandbox(parameter);
    active.add(sandbox);
    const completion = sandbox.waitForStop();
    void completion.catch(() => {});
    try {
      inspectCgroup(delegatedRoot, baseline, parameter);
      const result = await completion;
      if (result.status !== Sandbox.SandboxStatus.OK || result.code !== 0 ||
          (result.termination && result.termination !== "exited") ||
          !Number.isFinite(result.time) || result.time < 0 || !Number.isFinite(result.memory) || result.memory <= 0) {
        throw new VerificationError(`${stage} failed in the installed sandbox; compilation/execution and cgroup accounting must succeed before starting judge.`);
      }
      if (listGroups(delegatedRoot).some(name => !baseline.includes(name))) {
        throw new VerificationError("The installed sandbox did not remove its execution cgroup after completion.");
      }
      return result;
    } finally {
      if (sandbox.running) sandbox.stop();
      // The native finalizer kills all descendants and removes the cgroup.
      await completion.catch(() => {});
      active.delete(sandbox);
    }
  };
  const compilation = await run("C++ compilation", {
    ...common, time: 20000, memory: 256 * 1024 * 1024, stackSize: 64 * 1024 * 1024,
    // The upstream image exposes its pinned compiler through /usr/local/bin.
    cpuAffinity: config.cpuAffinity?.compiler || [], executable: "/usr/local/bin/g++",
    parameters: ["/usr/local/bin/g++", "-std=c++17", "-O2", "-pipe", "/tmp/main.cpp", "-o", "/tmp/a.out"],
    stdin: "/dev/null", stdout: "compile.out", stderr: "compile.err"
  });
  const execution = await run("C++ execution/isolation", {
    ...common, time: 3000, memory: 64 * 1024 * 1024, stackSize: 64 * 1024 * 1024,
    cpuAffinity: config.cpuAffinity?.userProgram || [], executable: "/tmp/a.out",
    parameters: ["/tmp/a.out", markerPath, String(hostPort), hostNetworkNamespace, String(user.uid)],
    stdin: "input.txt", stdout: "run.out", stderr: "run.err"
  });
  if (await fs.readFile(path.join(workingDirectory, "run.out"), "utf8") !== "43\n") {
    throw new VerificationError("The installed C++ sandbox produced an unexpected result for 42 + 1.");
  }
  return { compilation, execution };
}

function readDelegatedRoot() {
  const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find(value => value.startsWith("0::"));
  const ownPath = line?.slice(3);
  if (!ownPath || path.basename(ownPath) !== "supervisor" ||
      path.basename(path.dirname(ownPath)) !== "libreoj-install-sandbox-check.service") {
    throw new VerificationError("Run this check in the libreoj-install-sandbox-check transient unit with Delegate=cpu memory pids and DelegateSubgroup=supervisor.");
  }
  return path.join("/sys/fs/cgroup", path.dirname(ownPath));
}

async function installedWorkspace(root, config) {
  if (!Array.isArray(config.taskWorkingDirectories) || !config.taskWorkingDirectories.length || config.sandbox?.resourceMode !== "default") {
    throw new VerificationError("The generated judge configuration must contain workspaces and resourceMode default.");
  }
  const workspace = await fs.realpath(config.taskWorkingDirectories[0]);
  const workspaceParent = await fs.realpath(path.join(root, "data/judge/work"));
  const relative = path.relative(workspaceParent, workspace);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new VerificationError("The configured verification workspace is outside this installation.");
  const mountinfo = await fs.readFile("/proc/self/mountinfo", "utf8");
  const mounted = mountinfo.split("\n").some(line => {
    const [left, right] = line.split(" - ");
    const target = left?.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    return target === workspace && right?.split(" ")[0] === "tmpfs";
  });
  if (!mounted || (await fs.statfs(workspace, { bigint: true })).type !== 0x01021994n) {
    throw new VerificationError("The configured judge workspace must already be mounted as tmpfs before sandbox verification.");
  }
  const embeddedId = (await fs.readFile(path.join(config.sandbox.rootfs, "etc/libreoj-rootfs-id"), "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(embeddedId) || embeddedId !== config.sandbox.rootfsId) {
    throw new VerificationError("The installed LibreOJ rootfs ID does not match the judge configuration.");
  }
  return workspace;
}

async function cleanupNewCgroups(delegatedRoot, baseline) {
  let failed = false;
  for (const name of listSandboxGroups(delegatedRoot).filter(value => !baseline.includes(value))) {
    const directory = path.join(delegatedRoot, name);
    try {
      await fs.writeFile(path.join(directory, "cgroup.kill"), "1");
      const deadline = Date.now() + 5000;
      while (!/^populated 0$/m.test(await fs.readFile(path.join(directory, "cgroup.events"), "utf8"))) {
        if (Date.now() > deadline) throw new VerificationError("Sandbox verification could not stop all remaining sandbox processes.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      await fs.rmdir(directory);
    } catch (error) { if (error.code !== "ENOENT") failed = true; }
  }
  if (failed) throw new VerificationError("Sandbox verification could not clean up every execution cgroup.");
}

async function main() {
  if (process.getuid?.() !== 0) throw new VerificationError("Run the sandbox installation check with sudo through the installer.");
  const arguments_ = process.argv.slice(2);
  if (arguments_.length && (arguments_.length !== 2 || arguments_[0] !== "--root")) {
    throw new VerificationError("Usage: node verify-installed.mjs [--root /opt/LibreOJ]");
  }
  const root = await fs.realpath(arguments_[1] || "/opt/LibreOJ");
  const require = createRequire(path.join(root, "apps/judge/package.json"));
  const config = require("js-yaml").load(await fs.readFile(path.join(root, "config/judge.yaml"), "utf8"));
  const delegatedRoot = readDelegatedRoot();
  const baseline = listSandboxGroups(delegatedRoot);
  const workspace = await installedWorkspace(root, config);
  const sandboxRequire = createRequire(path.join(root, "packages/simple-sandbox/package.json"));
  const Sandbox = sandboxRequire("./lib/index.js");
  const user = Sandbox.getUidAndGidInSandbox(config.sandbox.rootfs, config.sandbox.user);
  const active = new Set();
  let interrupted = false;
  const onSignal = () => { interrupted = true; for (const sandbox of active) sandbox.stop(); };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  let temporary;
  let server;
  try {
    temporary = await fs.mkdtemp(path.join(workspace, ".install-sandbox-check-"));
    // The dummy host marker is deliberately world-readable, so failure to read
    // it proves the filesystem boundary rather than host directory permissions.
    await fs.chmod(temporary, 0o755);
    const workingDirectory = path.join(temporary, "working");
    await fs.mkdir(workingDirectory, { mode: 0o755 });
    await fs.chown(workingDirectory, user.uid, user.gid);
    const markerPath = path.join(temporary, "host-only-marker");
    await fs.writeFile(markerPath, randomBytes(32), { mode: 0o644 });
    // Only workingDirectory is mounted inside the sandbox; its sibling marker
    // remains on the host and must be unreachable, including through /proc.
    server = createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const hostNetworkNamespace = await fs.readlink("/proc/self/ns/net");
    await verifyWithSandbox({ Sandbox, config, workingDirectory, markerPath, hostNetworkNamespace,
      hostPort: server.address().port, user, delegatedRoot, active, interrupted: () => interrupted });
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    for (const sandbox of active) sandbox.stop();
    await Promise.allSettled([...active].map(sandbox => sandbox.waitForStop()));
    // Attempt every cleanup even when an earlier cleanup operation fails.
    let cleanupFailed = false;
    try { await cleanupNewCgroups(delegatedRoot, baseline); } catch { cleanupFailed = true; }
    try { if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    catch { cleanupFailed = true; }
    try { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    if (cleanupFailed) throw new VerificationError("Sandbox installation verification failed to clean up all temporary resources; judge was not started by this check.");
  }
  process.stdout.write("Installed LibreOJ sandbox verified: C++ 42 + 1 = 43; filesystem/PID/network isolation and default cgroup v2 limits passed.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Avoid raw config/native error dumps because judge.yaml contains its key.
    process.stderr.write(error instanceof VerificationError ? `${error.message}\n`
      : "Installed sandbox verification failed while loading or using the installed runtime; no judge credentials were displayed.\n");
    process.exitCode = 1;
  });
}
