/**
 * Where a problem's preprocessed judge info is cached (see `ProblemService.getProblemPreprocessedJudgeInfo()`). The
 * cache is cleared when the problem's judge info or test data change.
 */
export function preprocessedJudgeInfoCacheKey(problemId: number): string {
  return `problem-preprocessed-judge-info-and-submittable:${problemId}`;
}
