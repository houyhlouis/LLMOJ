import path from "path";

import type { SandboxParameter } from "simple-sandbox";

import { CPU_AFFINITY_STRATEGIES, SandboxRequest } from "./protocol";
import { LauncherSettings, isCanonicalPath } from "./settings";

/*
 * What a sandbox request may ask for. The launcher runs as root, so everything the judge sends is checked here
 * before a sandbox starts; nothing in a request can choose the image, the user, the hostname, the syscall filter, the
 * CPUs or a mount source outside the judge's own directories.
 */

export class RequestError extends Error {}

function fail(message: string): never {
  throw new RequestError(message);
}

const MAXIMUM_TIME = 24 * 60 * 60 * 1000;
const MAXIMUM_BYTES = 2 ** 46;
const MAXIMUM_PROCESSES = 4096;
const MAXIMUM_ARGUMENTS = 4096;
const MAXIMUM_STRING = 64 * 1024;
const MAXIMUM_MOUNTS = 16;
const MAXIMUM_DESCRIPTORS = 16;
// Numbers a passed descriptor may get in the program: not standard I/O, and below the usual descriptor limit
const DESCRIPTOR_RANGE = [3, 1023];

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    fail(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value as number;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAXIMUM_STRING || value.includes("\0"))
    fail(`${name} must be a nonempty string without NUL`);
  return value;
}

function texts(value: unknown, name: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_ARGUMENTS) fail(`${name} must be a list`);
  return value.map((item, i) => (allowEmpty && item === "" ? "" : text(item, `${name}[${i}]`)));
}

/** Whether `child` is `parent` or inside it. */
function within(child: string, parent: string) {
  return child === parent || child.startsWith(`${parent}/`);
}

export interface CheckedMount {
  // The allowed directory the source is in, and the source relative to it ("" for the directory itself)
  root: string;
  relative: string;
  inside: string;
  writable: boolean;
}

export interface CheckedRequest {
  time: number;
  memory: number;
  stackSize: number;
  process: number;
  strategy: SandboxRequest["strategy"];
  executable: string;
  parameters: string[];
  environments: string[];
  workingDirectory: string;
  mounts: CheckedMount[];
  descriptors: number[];
  stdin: number | null;
  stdout: number | null;
  stderr: number | null;
}

/** The directories a mount may come from, longest first so that the closest one is chosen. */
export function mountRoots(settings: LauncherSettings, writable: boolean): string[] {
  const roots = writable
    ? settings.taskWorkingDirectories
    : [
        ...settings.taskWorkingDirectories,
        settings.binaryCacheStore,
        settings.dataStore,
        ...(settings.aiGeneratedDirectory ? [settings.aiGeneratedDirectory] : [])
      ];
  return [...roots].sort((a, b) => b.length - a.length);
}

/**
 * Checks a request from the judge. `passed` is the number of descriptors that came with it. Throws `RequestError`.
 */
export function checkSandboxRequest(request: unknown, settings: LauncherSettings, passed: number): CheckedRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) fail("The request is not an object");
  const r = request as Record<string, unknown>;

  const memory = integer(r.memory, "memory", 1, MAXIMUM_BYTES);
  const strategy = r.strategy as SandboxRequest["strategy"];
  if (!CPU_AFFINITY_STRATEGIES.includes(strategy)) fail("Unknown CPU affinity strategy");

  const workingDirectory = text(r.workingDirectory, "workingDirectory");
  if (!isCanonicalPath(workingDirectory)) fail("workingDirectory must be an absolute, normalized path");

  const parameters = texts(r.parameters, "parameters", true);
  if (parameters.length === 0) fail("parameters must include the program's name");
  const environments = texts(r.environments, "environments");
  if (environments.some(variable => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(variable)))
    fail("Environment variables must be NAME=value");

  if (!Array.isArray(r.mounts) || r.mounts.length === 0 || r.mounts.length > MAXIMUM_MOUNTS)
    fail(`mounts must list 1 to ${MAXIMUM_MOUNTS} directories`);
  const insides = new Set<string>();
  const mounts = r.mounts.map((value: unknown, i): CheckedMount => {
    if (!value || typeof value !== "object") fail(`mounts[${i}] is not an object`);
    const { outside, inside, writable } = value as Record<string, unknown>;
    if (typeof writable !== "boolean") fail(`mounts[${i}].writable must be true or false`);
    if (!isCanonicalPath(outside)) fail(`mounts[${i}].outside must be an absolute, normalized path`);
    if (!isCanonicalPath(inside) || !(inside === "/tmp" || within(inside, "/tmp") || within(inside, "/sandbox")))
      fail(`mounts[${i}].inside must be /tmp or a directory under /tmp or /sandbox`);
    if (inside === "/sandbox") fail(`mounts[${i}].inside must be a directory under /sandbox`);
    if (insides.has(inside)) fail(`mounts[${i}].inside is mounted twice`);
    insides.add(inside);
    const root = mountRoots(settings, writable).find(directory => within(outside, directory));
    if (!root)
      fail(
        writable
          ? `mounts[${i}] is writable but not in a task working directory`
          : `mounts[${i}] is not in one of the judge's directories`
      );
    return { root, relative: path.posix.relative(root, outside), inside, writable };
  });

  if (!Array.isArray(r.descriptors) || r.descriptors.length > MAXIMUM_DESCRIPTORS)
    fail(`descriptors must list at most ${MAXIMUM_DESCRIPTORS} numbers`);
  const descriptors = r.descriptors.map((value: unknown, i) =>
    integer(value, `descriptors[${i}]`, DESCRIPTOR_RANGE[0], DESCRIPTOR_RANGE[1])
  );
  if (new Set(descriptors).size !== descriptors.length) fail("descriptors contains duplicates");
  if (descriptors.length !== passed) fail("The request lists another number of descriptors than it carries");
  const stdio = (name: "stdin" | "stdout" | "stderr") => {
    const value = r[name];
    if (value === null || value === undefined) return null;
    if (!descriptors.includes(value as number)) fail(`${name} must be one of the passed descriptors`);
    return value as number;
  };

  return {
    time: integer(r.time, "time", 1, MAXIMUM_TIME),
    memory,
    stackSize: integer(r.stackSize, "stackSize", 1, MAXIMUM_BYTES),
    process: integer(r.process, "process", 1, MAXIMUM_PROCESSES),
    strategy,
    executable: text(r.executable, "executable"),
    parameters,
    environments,
    workingDirectory,
    mounts,
    descriptors,
    stdin: stdio("stdin"),
    stdout: stdio("stdout"),
    stderr: stdio("stderr")
  };
}

/**
 * The sandbox's parameters for a checked request: everything that matters for isolation comes from the settings.
 * `received` are the launcher's copies of the passed descriptors, in order.
 */
export function sandboxParameter(
  checked: CheckedRequest,
  settings: LauncherSettings,
  sandboxUser: { uid: number; gid: number },
  received: number[]
): SandboxParameter {
  const userProgram = checked.strategy === "UserProgram";
  return {
    time: checked.time,
    memory: checked.memory,
    process: checked.process,
    stackSize: checked.stackSize,
    resourceMode: userProgram ? settings.resourceMode : "default",
    addressSpaceLimit: userProgram && settings.resourceMode === "arbiter" ? checked.memory : undefined,
    chroot: settings.rootfs,
    hostname: settings.hostname,
    mounts: checked.mounts.map(mount => ({
      // Opened by the sandbox through directories only, as by the launcher
      src: mount.root,
      beneath: mount.relative,
      dst: mount.inside,
      limit: mount.writable ? -1 : 0
    })),
    redirectBeforeChroot: false,
    mountProc: true,
    executable: checked.executable,
    parameters: checked.parameters,
    environments: checked.environments,
    workingDirectory: checked.workingDirectory,
    stdin: checked.stdin ?? undefined,
    stdout: checked.stdout ?? undefined,
    stderr: checked.stderr ?? undefined,
    user: sandboxUser,
    cpuAffinity: settings.cpuAffinity[checked.strategy],
    syscallFilter: settings.syscallFilter,
    descriptors: received.map((fd, i): [number, number] => [fd, checked.descriptors[i]])
  };
}
