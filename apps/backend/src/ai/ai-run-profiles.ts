import { type AiProfileInput, resolveAiProfiles } from "./ai-judging-contract";

import type { ProblemType } from "../problem/problem.entity";

/** Resource profiles and their top-level runner budgets. Only a file-based traditional reference uses stdFileIo. */
export function aiRunProfiles(
  problemType: ProblemType,
  judgeInfo: unknown,
  plan: { timeLimitMs: number; memoryLimitMiB: number; needsSpj?: boolean },
  stdFileIo: AiProfileInput["fileIo"]
) {
  const profiles = resolveAiProfiles({
    problemType: problemType as AiProfileInput["problemType"],
    judgeInfo,
    timeLimitMs: plan.timeLimitMs,
    memoryLimitMiB: plan.memoryLimitMiB,
    fileIo: stdFileIo,
    checker: !!plan.needsSpj
  });
  const { generator, std } = profiles.roles;
  return {
    profiles,
    timeLimitMs: generator.timeLimitMs,
    memoryLimitMiB: generator.memoryLimitMiB,
    stdTimeLimitMs: std.timeLimitMs,
    stdMemoryLimitMiB: std.memoryLimitMiB
  };
}
