import { promisify } from "util";

import bindings from "bindings";

import { OmittableString } from "../omittableString";
import { openRegularFile } from "../safeFile";

import { Checker, CheckerResult, parseTestlibMessage } from ".";

const native = bindings("builtin_checkers");
const nativeRunBuiltinChecker = promisify(native.runBuiltinChecker);

/** Opens a file for the checker, which reads it through /proc/self/fd: a link a program left is an empty output. */
async function openForChecker(filePath: string) {
  try {
    return await openRegularFile(filePath);
  } catch (error) {
    if (error.code === "ELOOP" || error.code === "EINVAL") return null;
    throw error;
  }
}

export async function runBuiltinChecker(
  outputFilePath: string,
  answerFilePath: string,
  checker: Checker
): Promise<CheckerResult | OmittableString> {
  const output = await openForChecker(outputFilePath);
  const answer = await openForChecker(answerFilePath);
  try {
    const message = await nativeRunBuiltinChecker(
      output ? `/proc/self/fd/${output.fd}` : "/dev/null",
      answer ? `/proc/self/fd/${answer.fd}` : "/dev/null",
      checker
    );
    return parseTestlibMessage(message);
  } finally {
    await output?.close();
    await answer?.close();
  }
}
