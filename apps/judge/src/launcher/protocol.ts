/*
 * Messages between the judge and its sandbox launcher.
 *
 * The launcher (index.mjs) is the only part of the judge that runs as root. It starts the judge as the account
 * `libreoj-judge` and runs sandboxes for it, one request at a time, after checking each one against the judge's
 * configuration. They talk over a SOCK_SEQPACKET socket: each message is one JSON object, and descriptors (the
 * program's standard I/O, pipes and shared memory) travel with it.
 */

export const CPU_AFFINITY_STRATEGIES = ["Compiler", "UserProgram", "Interactor", "Checker"] as const;
export type CpuAffinityStrategyName = typeof CPU_AFFINITY_STRATEGIES[number];

export interface SandboxMountRequest {
  // A directory of the judge's: a task working directory, the binary cache, the data store or the AI output root
  outside: string;
  // Where the program sees it: /tmp, or a directory under /tmp or /sandbox
  inside: string;
  // Only task working directories may be writable
  writable: boolean;
}

/** A program the judge asks the launcher to run in a sandbox. */
export interface SandboxRequest {
  // Milliseconds of CPU time
  time: number;
  // Bytes
  memory: number;
  stackSize: number;
  // Processes and threads at the same time
  process: number;
  // Which of the configured CPU sets the program runs on; the user program also gets the configured resource mode
  strategy: CpuAffinityStrategyName;
  executable: string;
  // The program's whole argument vector, its name included
  parameters: string[];
  // NAME=value
  environments: string[];
  workingDirectory: string;
  mounts: SandboxMountRequest[];
  // The numbers the program gets the passed descriptors at, in the order they were passed
  descriptors: number[];
  // One of `descriptors`, or null for /dev/null
  stdin: number | null;
  stdout: number | null;
  stderr: number | null;
}

export type JudgeMessage =
  | { op: "start"; id: number; sandbox: SandboxRequest }
  | { op: "stop"; id: number }
  // A sample file the backend stored for a local AI job; the reply carries an open, read-only descriptor
  | { op: "openSample"; id: number; job: string; name: string };

export interface SandboxResultMessage {
  status: number;
  time: number;
  memory: number;
  code: number;
  termination?: "exited" | "signaled";
}

export type LauncherMessage =
  | { op: "started"; id: number }
  | { op: "result"; id: number; result: SandboxResultMessage }
  | { op: "sample"; id: number }
  | { op: "failed"; id: number; message: string };

// The environment variables the launcher starts the judge with
export const LAUNCHER_DESCRIPTOR_VARIABLE = "LIBREOJ_LAUNCHER_FD";
export const CONFIG_DESCRIPTOR_VARIABLE = "LIBREOJ_JUDGE_CONFIG_FD";
export const AI_RUNNER_DESCRIPTOR_VARIABLE = "LIBREOJ_AI_RUNNER_FD";

// The account the judge runs as, unless LIBREOJ_JUDGE_USER names another
export const DEFAULT_JUDGE_ACCOUNT = "libreoj-judge";

export const SAMPLE_JOB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SAMPLE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
