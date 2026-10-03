import { SubmissionProgress } from "./submission-progress.interface";

/** Retain verdict/progress structure without testcase contents, checker output or private filenames. */
export function withoutTestData(progress: SubmissionProgress): SubmissionProgress {
  if (!progress) return progress;
  const safe: Record<string, unknown> = {};
  for (const key of ["progressType", "status", "score", "totalOccupiedTime", "compile", "samples", "subtasks"])
    if (key in progress) safe[key] = progress[key];
  if (progress.testcaseResult)
    safe.testcaseResult = Object.fromEntries(
      Object.entries(progress.testcaseResult).map(([hash, testcase]) => [
        hash,
        {
          status: testcase.status,
          score: testcase.score,
          time: testcase.time,
          memory: testcase.memory,
          testcaseInfo: { timeLimit: testcase.testcaseInfo?.timeLimit, memoryLimit: testcase.testcaseInfo?.memoryLimit }
        }
      ])
    );
  return safe as unknown as SubmissionProgress;
}
