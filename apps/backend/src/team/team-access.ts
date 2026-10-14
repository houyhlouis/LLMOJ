import { ConflictException } from "@nestjs/common";

import { DataSource, EntityManager } from "typeorm";

import { TeamEntity, TeamMemberEntity, TeamPermission, TeamResourceEntity, TeamResourceKind } from "./team.entity";

import { UserPrivilegeEntity, UserPrivilegeType } from "../user/user-privilege.entity";
import { UserPermissionRuleEntity } from "../access/user-permission-rule.entity";

import type { UserEntity } from "../user/user.entity";

export function hasTeamPermission(
  team: TeamEntity,
  member: TeamMemberEntity,
  user: UserEntity,
  permission: TeamPermission,
  globalManager = false
): boolean {
  return (
    !!user &&
    (user.isAdmin ||
      globalManager ||
      team.ownerId === user.id ||
      (member?.status === "member" && member.permissions.includes(permission)))
  );
}

export function teamCapabilitySql(userId: number, permission: "ViewTeam" | "ManageTeams", fallback: boolean): string {
  if (!userId) return fallback ? "1 = 1" : "0 = 1";
  return `(CASE WHEN EXISTS (SELECT 1 FROM user_permission_rule ur WHERE ur.userId = ${userId} AND ur.permission = '${permission}')
    THEN (SELECT ur.allowed FROM user_permission_rule ur WHERE ur.userId = ${userId} AND ur.permission = '${permission}' LIMIT 1)
    WHEN EXISTS (SELECT 1 FROM user_privilege up WHERE up.userId = ${userId} AND up.privilegeType = '${permission}') THEN 1
    ELSE ${fallback ? 1 : 0} END = 1)`;
}

async function teamCapability(
  db: DataSource | EntityManager,
  user: UserEntity,
  permission: UserPrivilegeType,
  fallback: boolean
): Promise<boolean> {
  if (user?.isAdmin) return true;
  if (!user) return fallback;
  const lock = db instanceof EntityManager ? { lock: { mode: "pessimistic_read" as const } } : {};
  const rule = await db
    .getRepository(UserPermissionRuleEntity)
    .findOne({ where: { userId: user.id, permission }, ...lock });
  if (rule) return rule.allowed;
  return (
    !!(await db
      .getRepository(UserPrivilegeEntity)
      .findOne({ where: { userId: user.id, privilegeType: permission }, ...lock })) || fallback
  );
}

/** A team ACL takes precedence over the resource's old public/owner/ACL fields. null identifies ordinary resources. */
async function evaluateTeamResourceAccess(
  db: DataSource | EntityManager,
  user: UserEntity,
  kind: TeamResourceKind,
  resourceId: number,
  permission: TeamPermission | "read" | "post" = "read"
): Promise<boolean | null> {
  const lock = db instanceof EntityManager ? { lock: { mode: "pessimistic_read" as const } } : {};
  let resource = await db.getRepository(TeamResourceEntity).findOne({ where: { kind, resourceId } });
  if (!resource) return null;
  if (!(await teamCapability(db, user, UserPrivilegeType.ViewTeam, true))) return false;
  const globalManager = await teamCapability(db, user, UserPrivilegeType.ManageTeams, false);
  const team = await db.getRepository(TeamEntity).findOne({ where: { id: resource.teamId }, ...lock });
  if (!team) return false;
  // Mutations consistently lock team -> resource -> member, matching TeamService.
  // Locating the team without a lock is safe because resource ownership is immutable.
  if (db instanceof EntityManager) {
    const current = await db.getRepository(TeamResourceEntity).findOne({ where: { kind, resourceId }, ...lock });
    if (!current || current.teamId !== team.id) return false;
    resource = current;
  }
  const member = user
    ? await db.getRepository(TeamMemberEntity).findOne({ where: { teamId: team.id, userId: user.id }, ...lock })
    : null;
  const manager = hasTeamPermission(
    team,
    member,
    user,
    kind === "problem"
      ? "problems"
      : kind === "contest"
      ? "contests"
      : kind === "discussion"
      ? "discussions"
      : "assignments",
    globalManager
  );
  if (team.archived || resource.archived) return manager && permission === "read";
  if (permission === "post") return manager || member?.status === "member";
  if (permission !== "read") return hasTeamPermission(team, member, user, permission, globalManager);
  if (manager || member?.status === "member") return true;
  if (kind === "contest" && resource.visibility === "public") return true;
  return (
    kind === "contest" &&
    resource.visibility === "invite" &&
    !!user &&
    member?.status !== "blocked" &&
    resource.invitedUserIds.includes(user.id)
  );
}

export function rethrowTeamConflict(error: unknown): never {
  const value = error as { code?: string; errno?: number; driverError?: { code?: string; errno?: number } };
  const driver = value?.driverError ?? value;
  if (
    ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ER_CHECKREAD"].includes(driver?.code) ||
    [1020, 1205, 1213].includes(driver?.errno)
  )
    throw new ConflictException("Team permissions or resources changed concurrently; reload and retry");
  throw error;
}

export async function teamResourceAccess(
  db: DataSource | EntityManager,
  user: UserEntity,
  kind: TeamResourceKind,
  resourceId: number,
  permission: TeamPermission | "read" | "post" = "read"
): Promise<boolean | null> {
  try {
    return await evaluateTeamResourceAccess(db, user, kind, resourceId, permission);
  } catch (error) {
    return rethrowTeamConflict(error);
  }
}

/** The predicate is applied before pagination and counting to prevent title/count leaks. IDs are sanitized integers. */
export function teamResourceVisibilitySql(kind: TeamResourceKind, idExpression: string, user: UserEntity): string {
  if (user?.isAdmin) return "1 = 1";
  const userId = Number.isSafeInteger(user?.id) ? user.id : 0;
  const permission =
    kind === "problem"
      ? "problems"
      : kind === "contest"
      ? "contests"
      : kind === "discussion"
      ? "discussions"
      : "assignments";
  const invited =
    kind === "contest"
      ? `OR (tr.visibility = 'public' AND tr.archived = 0 AND t.archived = 0) OR (tr.visibility = 'invite' AND tr.archived = 0 AND t.archived = 0 AND ${userId} > 0 AND JSON_CONTAINS(tr.invitedUserIds, '${userId}') AND NOT EXISTS (SELECT 1 FROM team_member tb WHERE tb.teamId = t.id AND tb.userId = ${userId} AND tb.status = 'blocked'))`
      : "";
  return `(NOT EXISTS (SELECT 1 FROM team_resource tr WHERE tr.kind = '${kind}' AND tr.resourceId = ${idExpression}) OR (${teamCapabilitySql(
    userId,
    "ViewTeam",
    true
  )} AND (${teamCapabilitySql(
    userId,
    "ManageTeams",
    false
  )} OR EXISTS (SELECT 1 FROM team_resource tr INNER JOIN team t ON t.id = tr.teamId LEFT JOIN team_member tm ON tm.teamId = t.id AND tm.userId = ${userId} WHERE tr.kind = '${kind}' AND tr.resourceId = ${idExpression} AND ((tm.status = 'member' AND t.archived = 0 AND tr.archived = 0) OR (${userId} > 0 AND (t.ownerId = ${userId} OR (tm.status = 'member' AND JSON_CONTAINS(tm.permissions, '"${permission}"')))) ${invited})))))`;
}
