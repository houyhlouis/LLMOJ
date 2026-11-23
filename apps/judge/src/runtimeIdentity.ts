import path from "path";

import { JudgeRuntimeInfo } from "@libreoj/judge-protocol";

import config from "./config";
import getSystemInfo from "./systemInfo";
import { judgeProgramDigest as digest } from "./judge-program";

export { JUDGE_PROGRAM_SOURCES } from "./judge-program";

const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");

export function judgeProgramDigest(root = REPOSITORY_ROOT): string {
  return digest(root);
}

const startupProgramDigest = judgeProgramDigest();
let cachedResult: Promise<JudgeRuntimeInfo>;

/** What this judge judges with, announced to the server and recorded with each result. */
export default function getRuntimeInfo(): Promise<JudgeRuntimeInfo> {
  cachedResult ||= (async () => {
    const systemInfo = await getSystemInfo();
    return {
      judgeProgram: startupProgramDigest,
      sandboxImage: config.sandbox.rootfsId,
      node: process.version,
      os: systemInfo.os,
      kernel: systemInfo.kernel,
      arch: systemInfo.arch,
      cpu: systemInfo.cpu.model
    };
  })();
  return cachedResult;
}
