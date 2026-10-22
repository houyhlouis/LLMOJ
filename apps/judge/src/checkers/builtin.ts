import { spawn } from "child_process";
import fs from "fs";
import path from "path";

import { OmittableString } from "../omittableString";
import { openRegularFile } from "../safeFile";

import { Checker, CheckerResult, parseTestlibMessage } from ".";

/** The checker program built with the native add-ons (native/builtin_checkers/builtin_checkers.cc). */
export const BUILTIN_CHECKER_PROGRAM = path.resolve(__dirname, "../../build/Release/builtin_checker");

export interface CheckerProcessLimits {
  /** Milliseconds before the checker is killed. Contestants' outputs are bounded, so only a fault takes this long. */
  time: number;
  /** Bytes of message read back. testlib shortens what it quotes, so its messages are short. */
  message: number;
}

export const BUILTIN_CHECKER_LIMITS: CheckerProcessLimits = {
  time: 120_000,
  message: 1024 * 1024
};

export type CheckerProcessResult =
  { message: string; code: number; signal: null } | { failure: string; code: number | null; signal: string | null };

/**
 * Runs a checker program on two open files, which it sees as descriptors 3 and 4, and returns what it wrote to
 * standard error. A program that runs too long or writes too much is killed; the result is known only once it has
 * exited and its descriptors are closed. It is never signalled once it has exited, and when it couldn't be started
 * there is nothing to signal: the promise rejects.
 */
export function runCheckerProcess(
  program: string,
  args: string[],
  files: [output: number, answer: number],
  limits: CheckerProcessLimits
): Promise<CheckerProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["ignore", "ignore", "pipe", files[0], files[1]],
      env: {},
      cwd: "/"
    });
    const running = () => child.pid > 0 && child.exitCode === null && child.signalCode === null;

    const chunks: Buffer[] = [];
    let length = 0;
    let failure: string | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitTimer);
      finish();
    };
    const stop = (reason: string) => {
      failure ??= reason;
      // Only the child this call started, and only while it hasn't exited: its PID can't belong to anyone else yet
      if (running()) child.kill("SIGKILL");
    };

    // Attached first: a program that couldn't be started (no descriptors or memory left, missing) is reported
    // asynchronously, without a process to clean up or standard error to read
    child.on("error", error => {
      // Raised as well when killing a running checker failed
      if (running()) failure ??= `The built-in checker couldn't be stopped: ${error.message}`;
      else settle(() => reject(error));
    });
    if (!child.stderr) return;

    timer = setTimeout(() => stop(`The built-in checker didn't finish in ${limits.time / 1000} s`), limits.time);
    child.stderr.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length <= limits.message) {
        chunks.push(chunk);
        return;
      }
      stop(`The built-in checker wrote more than ${limits.message} bytes`);
      child.stderr.destroy();
    });
    child.on("exit", () => {
      // Whatever it wrote is read by now, unless a process it started holds its standard error open
      exitTimer = setTimeout(() => child.stderr.destroy(), 1000);
    });
    // Once the process exited and its standard error is closed
    child.on("close", (code, signal) =>
      settle(() => {
        if (failure) resolve({ failure, code, signal });
        else if (signal) resolve({ failure: `The built-in checker was killed by ${signal}`, code, signal });
        else resolve({ message: Buffer.concat(chunks).toString(), code, signal: null });
      })
    );
  });
}

/** The program's arguments for a checker type. */
export function builtinCheckerArguments(checker: Checker): string[] {
  switch (checker.type) {
    case "integers":
    case "binary":
      return [checker.type];
    case "floats":
      if (!Number.isSafeInteger(checker.precision)) throw new Error("Invalid floats checker precision");
      return [checker.type, String(checker.precision)];
    case "tokens":
    case "lines":
      return [checker.type, checker.caseSensitive ? "1" : "0"];
    default:
      throw new Error(`Not a built-in checker: ${checker.type}`);
  }
}

/** Opens a file for the checker. A link a program left in place of its output counts as an empty output. */
async function openForChecker(filePath: string) {
  try {
    return await openRegularFile(filePath);
  } catch (error) {
    if (error.code === "ELOOP" || error.code === "EINVAL") return await fs.promises.open("/dev/null", "r");
    throw error;
  }
}

export async function runBuiltinChecker(
  outputFilePath: string,
  answerFilePath: string,
  checker: Checker
): Promise<CheckerResult | OmittableString> {
  const args = builtinCheckerArguments(checker);
  const output = await openForChecker(outputFilePath);
  try {
    const answer = await openForChecker(answerFilePath);
    try {
      const result = await runCheckerProcess(
        BUILTIN_CHECKER_PROGRAM,
        args,
        [output.fd, answer.fd],
        BUILTIN_CHECKER_LIMITS
      );
      // A checker that failed is the judge's failure, not the contestant's
      if ("failure" in result) return result.failure;
      return parseTestlibMessage(result.message);
    } finally {
      await answer.close();
    }
  } finally {
    await output.close();
  }
}
