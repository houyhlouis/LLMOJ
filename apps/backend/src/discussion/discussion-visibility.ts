import { teamResourceVisibilitySql } from "../team/team-access";

import type { UserEntity } from "../user/user.entity";

export interface DiscussionVisibilityDecisions {
  viewDiscussions: boolean;
  viewProblems: boolean;
  manageDiscussions: boolean;
  manageProblems: boolean;
  hiddenProblemWithGrant: boolean;
  hiddenProblemWithoutGrant: boolean;
}

function teamResourceExists(kind: "problem" | "discussion", id: string): string {
  return `EXISTS (SELECT 1 FROM team_resource tr WHERE tr.kind = '${kind}' AND tr.resourceId = ${id})`;
}

function objectReadPermission(objectType: "Problem" | "Discussion", id: string, userId: number): string {
  if (!userId) return "0 = 1";
  return `(EXISTS (SELECT 1 FROM permission_for_user pu WHERE pu.objectType = '${objectType}'
    AND pu.objectId = ${id} AND pu.userId = ${userId} AND pu.permissionLevel >= 1)
    OR EXISTS (SELECT 1 FROM permission_for_group pg INNER JOIN group_membership gm ON gm.groupId = pg.groupId
      WHERE pg.objectType = '${objectType}' AND pg.objectId = ${id} AND gm.userId = ${userId}
      AND pg.permissionLevel >= 1))`;
}

/** Compile the same View floors as DiscussionService/ProblemService before
 * counting and pagination. Capability decisions are constant per request;
 * indexed EXISTS joins evaluate object ACLs without loading every discussion. */
export function discussionVisibilitySql(user: UserEntity, decisions: DiscussionVisibilityDecisions): string {
  if (!decisions.viewDiscussions) return "0 = 1";
  const userId = Number.isSafeInteger(user?.id) && user.id > 0 ? user.id : 0;
  const ownDiscussion = userId ? `discussion.publisherId = ${userId}` : "0 = 1";
  const ordinaryDiscussion = decisions.manageDiscussions
    ? "1 = 1"
    : `(discussion.isPublic = 1 OR ${ownDiscussion}
        OR ${objectReadPermission("Discussion", "discussion.id", userId)})`;
  const discussionAcl = `(${teamResourceVisibilitySql("discussion", "discussion.id", user)}
    AND (${teamResourceExists("discussion", "discussion.id")} OR ${ordinaryDiscussion}))`;
  if (!decisions.viewProblems) return `(${discussionAcl} AND discussion.problemId IS NULL)`;
  const ownProblem = userId ? `visible_problem.ownerId = ${userId}` : "0 = 1";
  const legacyHidden = decisions.manageProblems
    ? "1 = 1"
    : objectReadPermission("Problem", "visible_problem.id", userId);
  const hiddenProblem = decisions.hiddenProblemWithoutGrant
    ? "1 = 1"
    : decisions.hiddenProblemWithGrant
    ? legacyHidden
    : "0 = 1";
  const problemAcl = `(discussion.problemId IS NULL OR EXISTS (
    SELECT 1 FROM problem visible_problem WHERE visible_problem.id = discussion.problemId
      AND ${teamResourceVisibilitySql("problem", "visible_problem.id", user)}
      AND (${teamResourceExists("problem", "visible_problem.id")}
        OR visible_problem.isPublic = 1 OR ${ownProblem} OR ${hiddenProblem})))`;
  return `(${discussionAcl} AND ${problemAcl})`;
}
