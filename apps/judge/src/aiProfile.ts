import path from "path";

import {
  AI_DEFAULT_COMPILE_OPTIONS,
  AiCpuClass,
  AiExecutionProfiles,
  AiProfileRole,
  AiRoleProfile
} from "@libreoj/judge-protocol";

/** The role of an AI run's program, by the name the runner gives it: its profile is that role's. */
export function profileRole(name: string): AiProfileRole {
  if (name === "make" || name === "quality-small-make") return "generator";
  if (name === "quality-oracle") return "oracle";
  if (name.startsWith("quality-alt-")) return "alternative";
  if (name.startsWith("quality-challenge-")) return "challenge";
  if (["std", "validator", "checker", "interactor", "manager"].includes(name)) return name as AiProfileRole;
  throw new Error(`No execution profile role for the program ${name}`);
}

export function roleProfile(profiles: AiExecutionProfiles, name: string): AiRoleProfile {
  const profile = profiles.roles[profileRole(name)];
  if (!profile) throw new Error(`The request has no execution profile for ${profileRole(name)}`);
  return profile;
}

// Its limits are checked (and defaulted) before
interface LegacyRequest {
  timeLimitMs?: number;
  memoryLimitMiB?: number;
  stdTimeLimitMs?: number;
  stdMemoryLimitMiB?: number;
  stdFileIo?: { inputFilename: string; outputFilename: string } | null;
}

/**
 * The profiles of a request without any (from a backend older than judge protocol version 7): what every program got
 * before, compiled with the same options, testlib.h and extra source files, the solutions run with the problem's limits
 * and everything else with the auxiliary ones, as user programs.
 */
export function legacyProfiles(request: LegacyRequest): AiExecutionProfiles {
  const program = (
    timeLimitMs: number,
    memoryLimitMiB: number,
    cpu: AiCpuClass = "UserProgram",
    extra: Partial<AiRoleProfile> = {}
  ): AiRoleProfile => ({
    language: "cpp",
    compileAndRunOptions: { ...AI_DEFAULT_COMPILE_OPTIONS },
    timeLimitMs,
    memoryLimitMiB,
    cpu,
    testlib: true,
    extraSources: true,
    origin: "ai",
    ...extra
  });
  const solution = program(request.stdTimeLimitMs, request.stdMemoryLimitMiB);
  const auxiliary = program(request.timeLimitMs, request.memoryLimitMiB);
  return {
    version: 1,
    roles: {
      std: request.stdFileIo ? { ...solution, fileIo: { ...request.stdFileIo } } : solution,
      alternative: solution,
      challenge: solution,
      oracle: program(5000, 512),
      generator: auxiliary,
      validator: auxiliary,
      checker: auxiliary,
      interactor: program(request.timeLimitMs, request.memoryLimitMiB, "Interactor"),
      manager: program(request.timeLimitMs, request.memoryLimitMiB, "Interactor")
    }
  };
}

/** Where each program's binary is: a directory of its own, which is all of the binaries its runs can see. */
export function programDirectory(binaryRoot: string, name: string) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid program name ${name}`);
  return path.join(binaryRoot, name);
}

export const PROGRAM_FILE = "a.out";

/**
 * How the sandbox runs a program of an AI run: its own binary directory alone (read-only), its working directory and
 * the files it's given (read-only), and its role's limits and CPU class.
 */
export function programSandbox(
  profile: AiRoleProfile,
  binary: { outside: string; inside: string },
  working: { outside: string; inside: string },
  references: { outside: string; inside: string }
) {
  return {
    executable: `${binary.inside}/${PROGRAM_FILE}`,
    time: profile.timeLimitMs,
    memory: profile.memoryLimitMiB * 1024 * 1024,
    stackSize: profile.memoryLimitMiB * 1024 * 1024,
    extraMounts: [
      { mappedPath: binary, readOnly: true },
      { mappedPath: working, readOnly: false },
      { mappedPath: references, readOnly: true }
    ],
    cpuAffinity: profile.cpu
  };
}
