import { ProblemType } from "./problem.entity";

import type { GenerationCache } from "../redis/generation-cache";

export const JUDGE_INFO_CACHE_SECONDS = 5 * 60;

/** Each problem type has its own field in the problem's cache generation. */
export function preprocessedJudgeInfoCacheKey(problemId: number): string {
  return `v2:problem-preprocessed-judge-info-and-submittable:${problemId}`;
}

export async function invalidatePreprocessedJudgeInfo(cache: GenerationCache, problemId: number): Promise<void> {
  await cache.invalidate(
    preprocessedJudgeInfoCacheKey(problemId),
    Object.values(ProblemType),
    JUDGE_INFO_CACHE_SECONDS
  );
}
