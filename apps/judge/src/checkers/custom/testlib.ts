import { v4 as uuid } from "uuid";
import { SandboxStatus } from "simple-sandbox";

import { safelyJoinPath } from "../../utils";
import { omittableStringToString, readFileOmitted } from "../../omittableString";

import { CustomChecker } from ".";
import { parseTestlibMessage } from "..";

export const checker: CustomChecker = {
  validate(checkerConfig) {
    if (checkerConfig.language !== "cpp") return "testlib checkers must be written in C++";
    return null;
  },

  async runChecker(
    checkerConfig,
    inputFile,
    outputFile,
    answerFile,
    code,
    workingDirectory,
    runSandboxForCustomChecker
  ) {
    const stderrFile = safelyJoinPath(workingDirectory, uuid());
    const sandboxResult = await runSandboxForCustomChecker(null, null, stderrFile.inside, [
      inputFile.inside,
      outputFile.inside,
      answerFile.inside
    ]);

    // testlib normally exits nonzero for WA/PE/FAIL and partial scores. Only accept
    // actual exits here; signals and resource-limit failures are still checker errors.
    const protocolExit = sandboxResult.status === SandboxStatus.RuntimeError && sandboxResult.termination === "exited";
    if (sandboxResult.status !== SandboxStatus.OK && !protocolExit) {
      return `Custom checker encountered a ${SandboxStatus[sandboxResult.status]}`;
    }

    const MESSAGE_LENGTH_LIMIT = 256;
    const message = await readFileOmitted(stderrFile.outside, MESSAGE_LENGTH_LIMIT);

    // WA/PE/partial scores legitimately use a nonzero testlib exit. The ordinary
    // success verdict must agree with the process exit status.
    if (protocolExit && omittableStringToString(message).startsWith("ok"))
      return `Custom checker reported success but exited with code ${sandboxResult.code}`;

    return parseTestlibMessage(message);
  }
};
