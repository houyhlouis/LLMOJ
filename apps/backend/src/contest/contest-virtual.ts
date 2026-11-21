import type { DataSource, EntityManager } from "typeorm";

import type { ContestEntity } from "./contest.entity";
import { ContestVirtualParticipationEntity } from "./contest-virtual-participation.entity";
import { contestEnded } from "./contest-policy";

import type { UserEntity } from "../user/user.entity";

export type VirtualRun = Pick<ContestVirtualParticipationEntity, "startTime" | "endTime">;

export function runTimes(run: VirtualRun): VirtualRun {
  return { startTime: run.startTime, endTime: run.endTime };
}

export function activeVirtualRun(run: ContestVirtualParticipationEntity, manager: boolean, wallNow: number) {
  return !manager && run && +run.startTime <= wallNow && wallNow < +run.endTime ? run : null;
}

export async function findActiveVirtualRun(
  db: DataSource | EntityManager,
  user: UserEntity,
  contest: ContestEntity,
  manager: boolean,
  wallNow = Date.now()
) {
  if (!user || manager || !contestEnded(contest, wallNow)) return null;
  const run = await db
    .getRepository(ContestVirtualParticipationEntity)
    .findOneBy({ contestId: contest.id, userId: user.id });
  return activeVirtualRun(run, manager, wallNow);
}

export function contestViewerTime(contest: ContestEntity, run: VirtualRun, wallNow = Date.now()) {
  return run && +run.startTime <= wallNow && wallNow < +run.endTime
    ? +contest.startTime + (wallNow - +run.startTime)
    : wallNow;
}
