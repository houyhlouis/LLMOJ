import { EntityManager, LessThanOrEqual, MoreThan, SelectQueryBuilder } from "typeorm";

import type { ContestEntity } from "./contest.entity";
import { ContestVirtualParticipationEntity } from "./contest-virtual-participation.entity";

import type { SubmissionEntity } from "../submission/submission.entity";

// Each (contest, user) has at most one run. An out-of-window submission by a manager does not belong to it.
export const virtualSubmissionJoin =
  "virtualRun.contestId = s.contestId AND virtualRun.userId = s.submitterId " +
  "AND s.submitTime >= virtualRun.startTime AND s.submitTime < virtualRun.endTime";

export async function isVirtualContestSubmission(
  manager: EntityManager,
  submission: Pick<SubmissionEntity, "contestId" | "submitterId" | "submitTime">
) {
  return (
    !!submission.contestId &&
    (await manager.getRepository(ContestVirtualParticipationEntity).existsBy({
      contestId: submission.contestId,
      userId: submission.submitterId,
      startTime: LessThanOrEqual(submission.submitTime),
      endTime: MoreThan(submission.submitTime)
    }))
  );
}

/** Limit contest submission reads (alias s) to what an active virtual participant has reached on their clock. */
export function applyContestElapsedCutoff(
  query: SelectQueryBuilder<SubmissionEntity>,
  contest: ContestEntity,
  elapsedMs: number
) {
  return query
    .leftJoin(ContestVirtualParticipationEntity, "virtualRun", virtualSubmissionJoin)
    .andWhere(
      "((virtualRun.id IS NULL AND s.submitTime >= :officialStart AND s.submitTime < :officialEnd " +
        "AND s.submitTime <= :officialCutoff) OR (virtualRun.id IS NOT NULL " +
        "AND s.submitTime <= TIMESTAMPADD(SECOND, :elapsedSeconds, virtualRun.startTime)))",
      {
        officialStart: contest.startTime,
        officialEnd: contest.endTime,
        officialCutoff: new Date(+contest.startTime + elapsedMs),
        // Both persisted timestamps have second precision.
        elapsedSeconds: Math.floor(elapsedMs / 1000)
      }
    );
}
