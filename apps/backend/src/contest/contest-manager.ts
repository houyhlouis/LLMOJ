import type { DataSource } from "typeorm";

import type { ContestEntity } from "./contest.entity";

import type { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { teamResourceAccess } from "../team/team-access";

/**
 * Whether the user manages the contest. A team's contest is managed by the team members who may manage the team's
 * contests, unless editing contests is explicitly denied to them. Any other contest is managed by administrators,
 * users who may manage all contests, and its owner and appointed administrators while they may edit contests.
 *
 * Contest pages ask ContestAccessService.manager(); the submission permission rules ask this function directly, so
 * the submission module doesn't depend on the contest module.
 */
export async function isContestManager(
  db: DataSource,
  privileges: UserPrivilegeService,
  user: UserEntity,
  contest: Pick<ContestEntity, "id" | "ownerId" | "adminIds">
): Promise<boolean> {
  const team = await teamResourceAccess(db, user, "contest", contest.id, "contests");
  if (team !== null) return team && (await privileges.permissionDecision(user, UserPrivilegeType.EditContest, true));
  return (
    !!user &&
    (user.isAdmin ||
      (await privileges.userHasPrivilege(user, UserPrivilegeType.ManageContest)) ||
      ((await privileges.userHasPrivilege(user, UserPrivilegeType.EditContest)) &&
        (contest.ownerId === user.id || contest.adminIds.includes(user.id))))
  );
}
