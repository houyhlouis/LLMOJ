import { ContestRule } from "./contest.entity";

/** Only this allowlist is serialized for contest submission list/detail metadata. */
export function contestSubmissionFeedback(
  submission: {
    id: number;
    contestProblemId: number;
    submitterId: number;
    submitTime: Date;
    codeLanguage: string;
    status: string;
    score: number;
    timeUsed: number;
    memoryUsed: number;
  },
  rule: ContestRule,
  ended: boolean,
  manager: boolean
) {
  const blind = !manager && !ended && rule === "noi";
  return {
    id: submission.id,
    contestProblemId: submission.contestProblemId,
    submitterId: submission.submitterId,
    submitTime: submission.submitTime,
    codeLanguage: submission.codeLanguage,
    status: blind
      ? ["CompilationError", "Pending"].includes(submission.status)
        ? submission.status
        : "Compiled"
      : submission.status,
    score: blind || (!manager && !ended && rule === "acm") ? null : submission.score,
    timeUsed: !manager && !ended ? null : submission.timeUsed,
    memoryUsed: !manager && !ended ? null : submission.memoryUsed
  };
}
