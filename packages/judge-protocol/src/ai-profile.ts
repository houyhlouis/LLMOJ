/*
 * The execution profiles of an AI run's programs (review Part III, H03/W02): how each role's program is compiled and
 * run. The backend resolves them once, from the problem's judging settings where a program is published with them,
 * and sends them with the run. The AI runner runs each program with its role's profile and nothing else (no other
 * role's binary, no other role's budget), and the judging settings the backend publishes give each published program
 * the same: a checker is never qualified under a larger budget than the one it's judged with.
 */
import { createHash } from "crypto";

export const AI_PROFILE_VERSION = 1;

export const AI_PROFILE_ROLES = [
  // The reference solution, its alternative correct solutions, and the wrong or slow challenge solutions
  "std",
  "alternative",
  "challenge",
  // The brute-force solution of small cases, and the generators of cases (full and small)
  "oracle",
  "generator",
  "validator",
  "checker",
  "interactor",
  "manager"
] as const;
export type AiProfileRole = (typeof AI_PROFILE_ROLES)[number];

// The CPU affinity strategy of a role's runs, as the judge names them; a user program's also chooses its resource mode
export const AI_CPU_CLASSES = ["UserProgram", "Checker", "Interactor"] as const;
export type AiCpuClass = (typeof AI_CPU_CLASSES)[number];

/** C++ compile options, as a problem's judging settings give them. */
export interface AiCompileOptions {
  compiler: string;
  std: string;
  O: string;
  m: string;
}

export const AI_DEFAULT_COMPILE_OPTIONS: Readonly<AiCompileOptions> = Object.freeze({
  compiler: "g++",
  std: "c++17",
  O: "2",
  m: "64"
});

const COMPILERS = ["g++", "clang++"];
const CPP_STANDARDS = [
  "c++03",
  "c++11",
  "c++14",
  "c++17",
  "c++20",
  "c++23",
  "c++26",
  "gnu++03",
  "gnu++11",
  "gnu++14",
  "gnu++17",
  "gnu++20",
  "gnu++23",
  "gnu++26"
];
const OPTIMIZATIONS = ["0", "1", "2", "3", "fast"];
const ARCHITECTURES = ["64", "32"];

/** How one role's programs are compiled and run. */
export interface AiRoleProfile {
  language: "cpp";
  compileAndRunOptions: AiCompileOptions;
  timeLimitMs: number;
  memoryLimitMiB: number;
  cpu: AiCpuClass;
  // Compiled with the judge's bundled testlib.h, and with the problem's extra source files (e.g. public headers)
  testlib: boolean;
  extraSources: boolean;
  // Reads and writes these files instead of standard input and output (a file-I/O problem's reference solution)
  fileIo?: { inputFilename: string; outputFilename: string };
  // An interactor's shared memory (MiB)
  sharedMemorySize?: number;
  // Where the program and these settings come from: the problem's judging settings, or the AI job (its defaults)
  origin: "problem" | "ai";
}

export interface AiExecutionProfiles {
  version: typeof AI_PROFILE_VERSION;
  roles: Partial<Record<AiProfileRole, AiRoleProfile>>;
}

export const AI_PROFILE_LIMITS = { timeLimitMs: 60000, memoryLimitMiB: 4096, sharedMemorySize: 1024 } as const;

const FILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isWithin = (value: unknown, maximum: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum;
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key));

/** Whether `value` is C++ compile options the judge builds with (an architecture it can't build fails later). */
export function isAiCompileOptions(value: unknown): value is AiCompileOptions {
  return (
    isObject(value) &&
    hasOnly(value, ["compiler", "std", "O", "m"]) &&
    COMPILERS.includes(value.compiler as string) &&
    CPP_STANDARDS.includes(value.std as string) &&
    OPTIMIZATIONS.includes(value.O as string) &&
    ARCHITECTURES.includes(value.m as string)
  );
}

function parseRoleProfile(value: unknown): AiRoleProfile | null {
  if (
    !isObject(value) ||
    !hasOnly(value, [
      "language",
      "compileAndRunOptions",
      "timeLimitMs",
      "memoryLimitMiB",
      "cpu",
      "testlib",
      "extraSources",
      "fileIo",
      "sharedMemorySize",
      "origin"
    ]) ||
    value.language !== "cpp" ||
    !isAiCompileOptions(value.compileAndRunOptions) ||
    !isWithin(value.timeLimitMs, AI_PROFILE_LIMITS.timeLimitMs) ||
    !isWithin(value.memoryLimitMiB, AI_PROFILE_LIMITS.memoryLimitMiB) ||
    !(AI_CPU_CLASSES as readonly unknown[]).includes(value.cpu) ||
    typeof value.testlib !== "boolean" ||
    typeof value.extraSources !== "boolean" ||
    !["problem", "ai"].includes(value.origin as string) ||
    (value.sharedMemorySize !== undefined && !isWithin(value.sharedMemorySize, AI_PROFILE_LIMITS.sharedMemorySize))
  )
    return null;
  let fileIo: AiRoleProfile["fileIo"];
  if (value.fileIo !== undefined) {
    const io = value.fileIo;
    if (
      !isObject(io) ||
      !hasOnly(io, ["inputFilename", "outputFilename"]) ||
      ![io.inputFilename, io.outputFilename].every(name => typeof name === "string" && FILE_NAME.test(name)) ||
      io.inputFilename === io.outputFilename
    )
      return null;
    fileIo = { inputFilename: io.inputFilename as string, outputFilename: io.outputFilename as string };
  }
  const options = value.compileAndRunOptions as AiCompileOptions;
  return {
    language: "cpp",
    compileAndRunOptions: { compiler: options.compiler, std: options.std, O: options.O, m: options.m },
    timeLimitMs: value.timeLimitMs as number,
    memoryLimitMiB: value.memoryLimitMiB as number,
    cpu: value.cpu as AiCpuClass,
    testlib: value.testlib as boolean,
    extraSources: value.extraSources as boolean,
    ...(fileIo ? { fileIo } : {}),
    ...(value.sharedMemorySize !== undefined ? { sharedMemorySize: value.sharedMemorySize as number } : {}),
    origin: value.origin as AiRoleProfile["origin"]
  };
}

/** A run's profiles, checked and copied field by field; null if they aren't valid. */
export function parseAiExecutionProfiles(value: unknown): AiExecutionProfiles | null {
  if (!isObject(value) || !hasOnly(value, ["version", "roles"]) || value.version !== AI_PROFILE_VERSION) return null;
  if (!isObject(value.roles) || !hasOnly(value.roles, AI_PROFILE_ROLES)) return null;
  const roles: AiExecutionProfiles["roles"] = {};
  for (const role of AI_PROFILE_ROLES) {
    if (value.roles[role] === undefined) continue;
    const profile = parseRoleProfile(value.roles[role]);
    if (!profile) return null;
    roles[role] = profile;
  }
  return { version: AI_PROFILE_VERSION, roles };
}

// JSON with sorted keys, so that equal profiles have equal digests whatever order their fields were written in
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(key => value[key] !== undefined)
        .map(key => [key, canonical(value[key])])
    );
  return value;
}

/** SHA-256 of a JSON value with sorted keys: the identity of profiles, or of a scoring policy. */
export function aiContractDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
