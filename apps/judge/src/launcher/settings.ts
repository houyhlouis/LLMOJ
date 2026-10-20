import fs from "fs";
import path from "path";

import { CPU_AFFINITY_STRATEGIES, CpuAffinityStrategyName } from "./protocol";

/**
 * What the launcher takes from the judge's configuration: where sandboxes may mount from and how they run. It reads
 * the file itself, as root, so that the judge can't widen any of it.
 */
export interface LauncherSettings {
  rootfs: string;
  hostname: string;
  // The sandbox user's name in the image
  sandboxUser: string;
  syscallFilter: boolean;
  resourceMode: "default" | "arbiter";
  cpuAffinity: Record<CpuAffinityStrategyName, number[] | undefined>;
  // Mount sources: writable ones only from the task working directories
  taskWorkingDirectories: string[];
  dataStore: string;
  binaryCacheStore: string;
  // The local AI runner, if any
  aiGeneratedDirectory: string | null;
  aiRunnerSocket: string | null;
  aiRunnerGid: number | null;
  // Sandboxes that may run at the same time: two per slot (an interactor and a program), and two more
  maxSandboxes: number;
}

export class SettingsError extends Error {}

function fail(message: string): never {
  throw new SettingsError(message);
}

/** An absolute, normalized path: no "..", ".", doubled or trailing slashes. */
export function isCanonicalPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.length < 4096 &&
    !value.includes("\0") &&
    path.posix.normalize(value) === value &&
    (value === "/" || !value.endsWith("/"))
  );
}

function directory(value: unknown, name: string): string {
  if (!isCanonicalPath(value) || value === "/") fail(`${name} must be an absolute, normalized path`);
  return value;
}

function cpus(value: unknown, name: string): number[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some(cpu => !Number.isInteger(cpu) || cpu < 0 || cpu > 4095))
    fail(`cpuAffinity.${name} must list CPU numbers`);
  return value as number[];
}

export function loadSettings(config: unknown): LauncherSettings {
  if (!config || typeof config !== "object") fail("The judge configuration is not an object");
  const c = config as Record<string, unknown>;
  const sandbox = (c.sandbox || {}) as Record<string, unknown>;
  const rootfs = directory(sandbox.rootfs, "sandbox.rootfs");
  if (typeof sandbox.rootfsId !== "string" || !/^[0-9a-f]{64}$/.test(sandbox.rootfsId))
    fail("sandbox.rootfsId must be a SHA-256 digest");
  const idFile =
    sandbox.rootfsIdFile == null
      ? path.join(rootfs, "etc/libreoj-rootfs-id")
      : directory(sandbox.rootfsIdFile, "sandbox.rootfsIdFile");
  if (fs.readFileSync(idFile, "utf-8").trim() !== sandbox.rootfsId)
    fail("The configured sandbox image ID doesn't match the installed image");
  if (typeof sandbox.user !== "string" || !/^[a-z_][a-z0-9_-]*$/.test(sandbox.user)) fail("sandbox.user is invalid");
  if (
    sandbox.hostname != null &&
    (typeof sandbox.hostname !== "string" || !/^[A-Za-z0-9.-]{1,64}$/.test(sandbox.hostname))
  )
    fail("sandbox.hostname is invalid");
  if (sandbox.resourceMode != null && !["default", "arbiter"].includes(sandbox.resourceMode as string))
    fail("sandbox.resourceMode is invalid");
  if (sandbox.syscallFilter != null && typeof sandbox.syscallFilter !== "boolean")
    fail("sandbox.syscallFilter must be true or false");

  if (!Array.isArray(c.taskWorkingDirectories) || c.taskWorkingDirectories.length === 0)
    fail("taskWorkingDirectories must list directories");
  const taskWorkingDirectories = c.taskWorkingDirectories.map((value, i) =>
    directory(value, `taskWorkingDirectories[${i}]`)
  );
  if (new Set(taskWorkingDirectories).size !== taskWorkingDirectories.length)
    fail("taskWorkingDirectories contains duplicates");

  const affinity = (c.cpuAffinity || {}) as Record<string, unknown>;
  const keys: Record<CpuAffinityStrategyName, string> = {
    Compiler: "compiler",
    UserProgram: "userProgram",
    Interactor: "interactor",
    Checker: "checker"
  };
  const cpuAffinity = Object.fromEntries(
    CPU_AFFINITY_STRATEGIES.map(strategy => [strategy, cpus(affinity[keys[strategy]], keys[strategy])])
  ) as LauncherSettings["cpuAffinity"];

  const localAi = c.aiRunnerSocket != null && c.aiGeneratedDirectory != null;
  if (localAi && (!Number.isInteger(c.aiRunnerGid) || (c.aiRunnerGid as number) <= 0))
    fail("aiRunnerGid must name the backend's group");

  return {
    rootfs,
    hostname: (sandbox.hostname as string) || "",
    sandboxUser: sandbox.user,
    syscallFilter: sandbox.syscallFilter !== false,
    resourceMode: (sandbox.resourceMode as "default" | "arbiter") || "default",
    cpuAffinity,
    taskWorkingDirectories,
    dataStore: directory(c.dataStore, "dataStore"),
    binaryCacheStore: directory(c.binaryCacheStore, "binaryCacheStore"),
    aiGeneratedDirectory: localAi ? directory(c.aiGeneratedDirectory, "aiGeneratedDirectory") : null,
    aiRunnerSocket: localAi ? directory(c.aiRunnerSocket, "aiRunnerSocket") : null,
    aiRunnerGid: localAi ? (c.aiRunnerGid as number) : null,
    maxSandboxes: taskWorkingDirectories.length * 2 + 2
  };
}
