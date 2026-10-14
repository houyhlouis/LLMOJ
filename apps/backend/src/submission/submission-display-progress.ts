import { SubmissionStatus } from "@libreoj/judge-protocol";

import { SubmissionProgress, SubmissionProgressType } from "./submission-progress.interface";

/** Keep the original judge result in storage while exposing the effective verdict. */
export function submissionDisplayProgress(
  submission: { status: SubmissionStatus; totalOccupiedTime: number },
  result: SubmissionProgress
): SubmissionProgress {
  if (![SubmissionStatus.Fake, SubmissionStatus.Hacked].includes(submission.status)) return result;
  return {
    ...result,
    progressType: SubmissionProgressType.Finished,
    status: submission.status,
    score: 0,
    totalOccupiedTime: submission.totalOccupiedTime ?? 0
  };
}
