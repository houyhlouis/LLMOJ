import { SubmissionStatus } from "@libreoj/judge-protocol";

import { SubmissionProgress, SubmissionProgressType } from "./submission-progress.interface";

import type { StoredSubmissionProgress } from "./submission-detail.entity";

/** Keep the original judge result in storage while exposing the effective verdict. */
export function submissionDisplayProgress(
  submission: { status: SubmissionStatus; totalOccupiedTime: number },
  result: StoredSubmissionProgress
): SubmissionProgress {
  if (result && "completion" in result) {
    result = { ...result };
    delete result.completion;
  }
  if (![SubmissionStatus.Fake, SubmissionStatus.Hacked].includes(submission.status)) return result;
  return {
    ...result,
    progressType: SubmissionProgressType.Finished,
    status: submission.status,
    score: 0,
    totalOccupiedTime: submission.totalOccupiedTime ?? 0
  };
}
