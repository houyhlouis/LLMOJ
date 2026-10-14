import { promises as fs } from "fs";
import os from "os";
import path from "path";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager, In } from "typeorm";
import { v4 as uuid } from "uuid";

import {
  TeamEntity,
  TeamMemberEntity,
  TeamMemberGroupEntity,
  TeamResourceEntity,
  TeamAssignmentEntity,
  TeamFileEntity,
  TeamFileUploadEntity,
  TeamInvitationEntity,
  TeamPermission,
  TeamResourceKind,
  TEAM_PERMISSIONS,
  TEAM_FILE_QUOTA,
  TEAM_FILE_PART_SIZE
} from "./team.entity";
import { hasTeamPermission, rethrowTeamConflict } from "./team-access";
import { TeamRequestDto } from "./team-request.dto";

import { UserEntity } from "../user/user.entity";
import { UserService } from "../user/user.service";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { GroupEntity } from "../group/group.entity";
import { GroupMembershipEntity } from "../group/group-membership.entity";
import { PermissionForGroupEntity } from "../permission/permission-for-group.entity";
import { PermissionObjectType } from "../permission/permission-object-type.enum";
import { ProblemService, ProblemPermissionType } from "../problem/problem.service";
import { ProblemEntity, ProblemType } from "../problem/problem.entity";
import { ProblemContentSectionType } from "../problem/problem-content.interface";
import { ProblemFileEntity } from "../problem/problem-file.entity";
import { ProblemJudgeInfoEntity } from "../problem/problem-judge-info.entity";
import { ProblemSampleEntity } from "../problem/problem-sample.entity";
import { ProblemTagMapEntity } from "../problem/problem-tag-map.entity";
import { LocalizedContentEntity, LocalizedContentType } from "../localized-content/localized-content.entity";
import { Locale } from "../common/locale.type";
import { DiscussionService } from "../discussion/discussion.service";
import { DiscussionEntity } from "../discussion/discussion.entity";
import { ContestEntity } from "../contest/contest.entity";
import { normalizeContestLanguages } from "../contest/contest-languages";

import { isContestRule } from "../contest/contest-rules";
import { SubmissionEntity } from "../submission/submission.entity";
import { FileService, MinioSignFor } from "../file/file.service";
import { FileEntity } from "../file/file.entity";
import { AuditService, AuditLogObjectType } from "../audit/audit.service";

const FILE_UPLOAD_LIFETIME = 24 * 3600 * 1000;

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new BadRequestException("Invalid ID");
  return Number(value);
}
function text(value: unknown, limit: number, required = false): string {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim()))
    throw new BadRequestException("Invalid text");
  return value;
}
export function teamCsvCell(value: unknown): string {
  const content = String(value ?? "");
  // eslint-disable-next-line no-control-regex -- Spreadsheet formulas can start after whitespace/control bytes.
  return `"${(/^[\s\u0000-\u001f]*[=+@-]/u.test(content) ? `'${content}` : content).replace(/"/g, '""')}"`;
}

@Injectable()
export class TeamService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly users: UserService,
    private readonly privileges: UserPrivilegeService,
    private readonly problems: ProblemService,
    private readonly discussions: DiscussionService,
    private readonly files: FileService,
    private readonly audit: AuditService
  ) {}

  private async isManager(user: UserEntity, db: DataSource | EntityManager = this.db): Promise<boolean> {
    return (
      !!user &&
      (await this.privileges.userHasPrivilege(
        user,
        UserPrivilegeType.ManageTeams,
        db instanceof EntityManager ? db : undefined
      ))
    );
  }

  private login(user: UserEntity): void {
    if (!user) throw new ForbiddenException("Login required");
  }

  async access(
    user: UserEntity,
    teamId: number,
    permission?: TeamPermission,
    db: DataSource | EntityManager = this.db,
    lock = false
  ) {
    if (
      !(await this.privileges.userHasPrivilege(
        user,
        UserPrivilegeType.ViewSite,
        db instanceof EntityManager ? db : undefined
      ))
    )
      throw new ForbiddenException();
    let team: TeamEntity;
    try {
      team = await db
        .getRepository(TeamEntity)
        .findOne({ where: { id: integer(teamId) }, ...(lock ? { lock: { mode: "pessimistic_write" as const } } : {}) });
    } catch (error) {
      rethrowTeamConflict(error);
    }
    if (!team) throw new NotFoundException("Team not found");
    const member = user
      ? await db.getRepository(TeamMemberEntity).findOneBy({ teamId: team.id, userId: user.id })
      : null;
    const isTeamManager = await this.isManager(user, db);
    if (
      !(await this.privileges.userHasPrivilege(
        user,
        UserPrivilegeType.ViewTeam,
        db instanceof EntityManager ? db : undefined
      ))
    )
      throw new ForbiddenException();
    if (permission && !hasTeamPermission(team, member, user, permission, isTeamManager))
      throw new ForbiddenException("Team permission required");
    if (team.archived && !(isTeamManager || team.ownerId === user?.id)) throw new NotFoundException("Team archived");
    return { team, member, isTeamManager };
  }

  private async requireMember(user: UserEntity, teamId: number, db: DataSource | EntityManager = this.db) {
    const result = await this.access(user, teamId, undefined, db);
    if (!result.isTeamManager && result.member?.status !== "member")
      throw new ForbiddenException("Team membership required");
    return result;
  }

  private async activeAccess(user: UserEntity, teamId: number, permission: TeamPermission, manager: EntityManager) {
    const result = await this.access(user, teamId, permission, manager, true);
    if (result.team.archived) throw new ConflictException("Restore the team before changing its resources");
    return result;
  }

  private meta(team: TeamEntity) {
    const meta = { ...team };
    delete meta.permissionGroupId;
    return {
      ...meta,
      quotaUsed: Number(team.quotaUsed),
      quotaLimit: Number(team.quotaLimit)
    };
  }

  private joinMeta(team: TeamEntity) {
    return { id: team.id, name: team.name, joinPolicy: team.joinPolicy };
  }

  /** Knowing a team ID permits an explicit join request, never browsing private team content. */
  async joinPreview(user: UserEntity, teamId: number) {
    this.login(user);
    const { team, member } = await this.access(user, teamId);
    if (member?.status === "blocked") throw new ForbiddenException("You are on the team blacklist");
    return {
      team: this.joinMeta(team),
      membership: member ? { status: member.status, application: member.application } : null
    };
  }

  async list(user: UserEntity, mine = false, query = "", page = 1) {
    this.login(user);
    if (typeof mine !== "boolean") throw new BadRequestException("Invalid team filter");
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSite))) throw new ForbiddenException();
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewTeam))) throw new ForbiddenException();
    const qb = this.db.getRepository(TeamEntity).createQueryBuilder("t");
    // The legacy mine flag is accepted for compatibility, but no public directory exists.
    qb.where(
      "EXISTS (SELECT 1 FROM team_member m WHERE m.teamId = t.id AND m.userId = :userId AND m.status IN ('member','applicant'))",
      { userId: user.id }
    );
    if (query) qb.andWhere("t.name LIKE :query", { query: `%${query.replace(/[\\%_]/g, c => `\\${c}`)}%` });
    const [teams, total] = await qb
      .orderBy("t.id", "DESC")
      .skip((page - 1) * 30)
      .take(30)
      .getManyAndCount();
    const memberships = teams.length
      ? await this.db
          .getRepository(TeamMemberEntity)
          .findBy({ teamId: In(teams.map(team => team.id)), userId: user.id })
      : [];
    return {
      teams: teams.map(team => {
        const membership = memberships.find(member => member.teamId === team.id);
        return membership?.status === "member"
          ? { ...this.meta(team), membershipStatus: "member" }
          : { ...this.joinMeta(team), membershipStatus: "applicant" };
      }),
      total,
      pageSize: 30
    };
  }

  async create(user: UserEntity, data: TeamRequestDto) {
    this.login(user);
    if (
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSite)) ||
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewTeam))
    )
      throw new ForbiddenException();
    if (!(await this.privileges.permissionDecision(user, UserPrivilegeType.CreateTeam, true)))
      throw new ForbiddenException();
    const name = text(data.name, 80, true).trim();
    let team: TeamEntity;
    try {
      await this.db.transaction(async manager => {
        if (
          !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSite, manager)) ||
          !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewTeam, manager)) ||
          !(await this.privileges.permissionDecision(user, UserPrivilegeType.CreateTeam, true, manager))
        )
          throw new ForbiddenException();
        const group = await manager.save(
          GroupEntity,
          manager.create(GroupEntity, { name: `team:${uuid()}`, memberCount: 1 })
        );
        team = await manager.save(
          TeamEntity,
          manager.create(TeamEntity, {
            name,
            ownerId: user.id,
            description: text(data.description ?? "", 200000),
            announcement: "",
            permissionGroupId: group.id,
            joinPolicy: data.joinPolicy ?? "approval",
            groupChangeLocked: false,
            archived: false,
            memberCount: 1,
            quotaLimit: TEAM_FILE_QUOTA,
            quotaUsed: 0,
            createdAt: new Date()
          })
        );
        await manager.save(
          TeamMemberEntity,
          manager.create(TeamMemberEntity, {
            teamId: team.id,
            userId: user.id,
            status: "member",
            groupId: null,
            note: "",
            application: "",
            permissions: [],
            joinedAt: new Date()
          })
        );
        await manager.save(
          GroupMembershipEntity,
          manager.create(GroupMembershipEntity, { userId: user.id, groupId: group.id, isGroupAdmin: false })
        );
      });
    } catch (error) {
      if (await this.db.getRepository(TeamEntity).countBy({ name }))
        throw new ConflictException("Team name already exists");
      throw error;
    }
    await this.audit.log("team.create", AuditLogObjectType.Group, team.permissionGroupId, { teamId: team.id, name });
    return { teamId: team.id };
  }

  async save(user: UserEntity, data: TeamRequestDto) {
    const result = await this.db.transaction(async manager => {
      const { team } = await this.access(user, data.teamId, "settings", manager, true);
      if (
        data.archived !== undefined &&
        data.archived !== team.archived &&
        !((await this.isManager(user, manager)) || user?.id === team.ownerId)
      )
        throw new ForbiddenException("Only the owner may archive or restore a team");
      Object.assign(team, {
        name: text(data.name, 80, true).trim(),
        description: text(data.description ?? "", 200000),
        announcement: text(data.announcement ?? "", 200000),
        joinPolicy: data.joinPolicy ?? team.joinPolicy,
        groupChangeLocked: data.groupChangeLocked ?? team.groupChangeLocked,
        archived: data.archived ?? team.archived
      });
      return await manager.save(team);
    });
    await this.audit.log("team.update", AuditLogObjectType.Group, result.permissionGroupId, { teamId: result.id });
    return {};
  }

  async get(user: UserEntity, teamId: number) {
    const { team, member, isTeamManager } = await this.access(user, teamId);
    const permissions = TEAM_PERMISSIONS.filter(permission =>
      hasTeamPermission(team, member, user, permission, isTeamManager)
    );
    const empty = { problems: [], contests: [], discussions: [], assignments: [], files: [] };
    if (!(isTeamManager || member?.status === "member")) {
      if (member?.status !== "applicant") throw new ForbiddenException("Team membership required");
      return {
        team: this.joinMeta(team),
        membership: { status: "applicant", userId: member.userId, application: member.application },
        permissions: [],
        groups: [],
        resources: empty
      };
    }
    const [groups, resources, assignments, files] = await Promise.all([
      this.db.getRepository(TeamMemberGroupEntity).findBy({ teamId }),
      this.db.getRepository(TeamResourceEntity).findBy({ teamId }),
      this.db.getRepository(TeamAssignmentEntity).findBy({ teamId }),
      this.db.getRepository(TeamFileEntity).findBy({ teamId })
    ]);
    const visible = resources.filter(
      resource => !resource.archived || permissions.includes(this.resourcePermission(resource.kind))
    );
    const problemIds = visible.filter(r => r.kind === "problem").map(r => r.resourceId);
    const contestIds = visible.filter(r => r.kind === "contest").map(r => r.resourceId);
    const discussionIds = visible.filter(r => r.kind === "discussion").map(r => r.resourceId);
    const [problemRows, contestRows, discussionRows] = await Promise.all([
      problemIds.length ? this.db.getRepository(ProblemEntity).findBy({ id: In(problemIds) }) : [],
      contestIds.length ? this.db.getRepository(ContestEntity).findBy({ id: In(contestIds) }) : [],
      discussionIds.length ? this.db.getRepository(DiscussionEntity).findBy({ id: In(discussionIds) }) : []
    ]);
    const titles = new Map<number, string>(
      await Promise.all(
        problemRows.map(
          async p => [p.id, await this.problems.getProblemLocalizedTitle(p, p.locales[0])] as [number, string]
        )
      )
    );
    const mapped = (kind: TeamResourceKind) =>
      visible
        .filter(r => r.kind === kind)
        .map(r => ({
          id: r.resourceId,
          resourceId: r.resourceId,
          title:
            kind === "problem"
              ? titles.get(r.resourceId)
              : kind === "contest"
              ? contestRows.find(c => c.id === r.resourceId)?.title
              : discussionRows.find(d => d.id === r.resourceId)?.title,
          archived: r.archived,
          visibility: r.visibility,
          ...(kind === "contest" && permissions.includes("contests")
            ? { inviteCode: r.inviteCode, invitedUserIds: r.invitedUserIds }
            : {})
        }));
    return {
      team: this.meta(team),
      membership: member ? { ...member, note: permissions.includes("members") ? member.note : undefined } : null,
      permissions,
      groups,
      resources: {
        problems: mapped("problem"),
        contests: mapped("contest"),
        discussions: mapped("discussion"),
        assignments: assignments
          .filter(a => permissions.includes("assignments") || (!a.archived && this.assigned(a, member)))
          .map(a => ({
            id: a.id,
            title: a.title,
            deadline: a.deadline,
            archived: a.archived,
            itemCount: a.items.length
          })),
        files: files.filter(f => !f.archived || permissions.includes("files")).map(f => ({ ...f, uuid: undefined }))
      }
    };
  }

  private async setStatus(
    manager: EntityManager,
    team: TeamEntity,
    member: TeamMemberEntity,
    status: "member" | "applicant" | "blocked" | null
  ) {
    const wasMember = member.status === "member";
    if (wasMember && status !== "member") {
      await manager.delete(GroupMembershipEntity, { userId: member.userId, groupId: team.permissionGroupId });
      team.memberCount--;
      member.permissions = [];
      member.groupId = null;
    }
    if (!wasMember && status === "member") {
      await manager.save(
        GroupMembershipEntity,
        manager.create(GroupMembershipEntity, {
          userId: member.userId,
          groupId: team.permissionGroupId,
          isGroupAdmin: false
        })
      );
      team.memberCount++;
      member.joinedAt = new Date();
    }
    if (status) {
      member.status = status;
      await manager.save(member);
    } else await manager.remove(member);
    await manager.update(GroupEntity, team.permissionGroupId, { memberCount: team.memberCount });
    await manager.save(team);
  }

  async join(user: UserEntity, data: TeamRequestDto) {
    this.login(user);
    return await this.db.transaction(async manager => {
      const { team, member: existing } = await this.access(user, data.teamId, undefined, manager, true);
      if (team.archived || team.joinPolicy === "closed")
        throw new ForbiddenException("Team is not accepting applications");
      if (existing?.status === "blocked") throw new ForbiddenException("You are on the team blacklist");
      if (existing?.status === "member") return { status: "member" };
      const member =
        existing ??
        manager.create(TeamMemberEntity, {
          teamId: team.id,
          userId: user.id,
          status: "applicant",
          groupId: null,
          permissions: [],
          note: "",
          joinedAt: new Date()
        });
      member.application = text(data.message ?? "", 2000);
      const status = team.joinPolicy === "open" ? "member" : "applicant";
      await this.setStatus(manager, team, member, status);
      return { status };
    });
  }

  async leave(user: UserEntity, teamId: number) {
    this.login(user);
    await this.db.transaction(async manager => {
      const { team, member } = await this.access(user, teamId, undefined, manager, true);
      if (team.ownerId === user.id) throw new ForbiddenException("Transfer ownership before leaving");
      if (!member || member.status === "blocked") throw new ForbiddenException();
      await this.setStatus(manager, team, member, null);
    });
    return {};
  }

  async members(user: UserEntity, teamId: number) {
    const { team, member, isTeamManager } = await this.requireMember(user, teamId);
    const manage = hasTeamPermission(team, member, user, "members", isTeamManager);
    const members = await this.db
      .getRepository(TeamMemberEntity)
      .find({ where: { teamId, ...(manage ? {} : { status: "member" as const }) }, order: { joinedAt: "ASC" } });
    const userRows = await this.users.findUsersByExistingIds(members.map(m => m.userId));
    return {
      members: await Promise.all(
        members.map(async (m, i) => ({
          ...m,
          userMeta: userRows[i] ? await this.users.getUserMeta(userRows[i], user) : null,
          note: manage ? m.note : undefined,
          application: manage ? m.application : undefined
        }))
      ),
      groups: await this.db.getRepository(TeamMemberGroupEntity).findBy({ teamId })
    };
  }

  async manageMembers(user: UserEntity, data: TeamRequestDto) {
    if (!data.userIds?.length || data.userIds.length > 1000) throw new BadRequestException("Select members");
    const { action } = data;
    if (!["approve", "reject", "remove", "block", "unblock", "setGroup", "note", "permissions"].includes(action))
      throw new BadRequestException("Invalid action");
    await this.db.transaction(async manager => {
      const { team, isTeamManager } = await this.activeAccess(user, data.teamId, "members", manager);
      if (action === "permissions" && user.id !== team.ownerId && !isTeamManager)
        throw new ForbiddenException("Only the owner may appoint administrators");
      if (
        action === "permissions" &&
        (!Array.isArray(data.permissions) || data.permissions.some(p => !TEAM_PERMISSIONS.includes(p)))
      )
        throw new BadRequestException("Invalid permissions");
      if (
        action === "setGroup" &&
        data.groupId &&
        !(await manager.findOneBy(TeamMemberGroupEntity, { id: data.groupId, teamId: team.id, archived: false }))
      )
        throw new BadRequestException("Unknown member group");
      for (const userId of [...new Set(data.userIds)]) {
        if (userId === team.ownerId && !["note", "setGroup"].includes(action))
          throw new ForbiddenException("The team owner cannot be removed or demoted");
        // eslint-disable-next-line no-await-in-loop
        let member = await manager.findOneBy(TeamMemberEntity, { teamId: team.id, userId: integer(userId) });
        if (!member && action === "block") {
          // eslint-disable-next-line no-await-in-loop
          if (!(await manager.countBy(UserEntity, { id: userId }))) throw new BadRequestException("User not found");
          member = manager.create(TeamMemberEntity, {
            teamId: team.id,
            userId,
            status: "applicant",
            groupId: null,
            permissions: [],
            note: "",
            application: "",
            joinedAt: new Date()
          });
        }
        if (!member) throw new NotFoundException("Member not found");
        if (
          member.permissions.length &&
          !["note", "setGroup"].includes(action) &&
          user.id !== team.ownerId &&
          !isTeamManager
        )
          throw new ForbiddenException("Only the owner may remove or change administrators");
        if (action === "approve") {
          if (member.status !== "applicant") throw new ConflictException("Not an application");
          // eslint-disable-next-line no-await-in-loop
          await this.setStatus(manager, team, member, "member");
        } else if (action === "reject") {
          if (member.status !== "applicant") throw new ConflictException("Not an application");
          // eslint-disable-next-line no-await-in-loop
          await this.setStatus(manager, team, member, null);
        } else if (action === "remove" || action === "unblock") {
          if (action === "unblock" && member.status !== "blocked") throw new ConflictException("Not blacklisted");
          // eslint-disable-next-line no-await-in-loop
          await this.setStatus(manager, team, member, null);
        } else if (action === "block") {
          // eslint-disable-next-line no-await-in-loop
          await this.setStatus(manager, team, member, "blocked");
        } else {
          if (member.status !== "member") throw new ConflictException("User is not a member");
          if (action === "setGroup") member.groupId = data.groupId ?? null;
          else if (action === "note") member.note = text(data.note ?? "", 2000);
          else member.permissions = [...new Set(data.permissions)];
          // eslint-disable-next-line no-await-in-loop
          await manager.save(member);
        }
      }
    });
    await this.audit.log("team.members", AuditLogObjectType.User, user.id, {
      teamId: data.teamId,
      action,
      userIds: data.userIds
    });
    return {};
  }

  async transfer(user: UserEntity, data: TeamRequestDto) {
    await this.db.transaction(async manager => {
      const { team } = await this.activeAccess(user, data.teamId, "settings", manager);
      if (user.id !== team.ownerId && !(await this.isManager(user, manager)))
        throw new ForbiddenException("Only the owner may transfer ownership");
      const newOwner = await manager.findOneBy(TeamMemberEntity, {
        teamId: team.id,
        userId: integer(data.userId),
        status: "member"
      });
      if (!newOwner) throw new BadRequestException("The new owner must be a team member");
      team.ownerId = newOwner.userId;
      await manager.save(team);
    });
    await this.audit.log("team.transfer", AuditLogObjectType.User, user.id, {
      teamId: data.teamId,
      userId: data.userId
    });
    return {};
  }

  async saveGroup(user: UserEntity, data: TeamRequestDto) {
    return await this.db.transaction(async manager => {
      await this.activeAccess(user, data.teamId, "members", manager);
      let group = data.id
        ? await manager.findOneBy(TeamMemberGroupEntity, { id: data.id, teamId: data.teamId })
        : manager.create(TeamMemberGroupEntity, { teamId: data.teamId });
      if (!group) throw new NotFoundException();
      group.name = text(data.name, 80, true).trim();
      group.archived = data.archived ?? false;
      group = await manager.save(group);
      if (group.archived)
        await manager.update(TeamMemberEntity, { teamId: data.teamId, groupId: group.id }, { groupId: null });
      return { id: group.id };
    });
  }

  async changeGroup(user: UserEntity, data: TeamRequestDto) {
    this.login(user);
    await this.db.transaction(async manager => {
      const { team, member } = await this.access(user, data.teamId, undefined, manager, true);
      if (member?.status !== "member" || team.archived) throw new ForbiddenException();
      if (team.groupChangeLocked) throw new ForbiddenException("Changing member groups is locked");
      if (
        data.groupId &&
        !(await manager.findOneBy(TeamMemberGroupEntity, { id: data.groupId, teamId: team.id, archived: false }))
      )
        throw new BadRequestException("Group not found");
      member.groupId = data.groupId ?? null;
      await manager.save(member);
    });
    return {};
  }

  private resourcePermission(kind: TeamResourceKind): TeamPermission {
    return { problem: "problems", contest: "contests", discussion: "discussions", assignment: "assignments" }[
      kind
    ] as TeamPermission;
  }

  private async registerResource(manager: EntityManager, team: TeamEntity, kind: TeamResourceKind, resourceId: number) {
    await manager.save(
      TeamResourceEntity,
      manager.create(TeamResourceEntity, {
        teamId: team.id,
        kind,
        resourceId,
        visibility: "private",
        invitedUserIds: [],
        inviteCode: null,
        archived: false
      })
    );
    if (kind === "problem" || kind === "discussion")
      await manager.save(
        PermissionForGroupEntity,
        manager.create(PermissionForGroupEntity, {
          groupId: team.permissionGroupId,
          objectType: kind === "problem" ? PermissionObjectType.Problem : PermissionObjectType.Discussion,
          objectId: resourceId,
          permissionLevel: 1
        })
      );
  }

  async createProblem(user: UserEntity, data: TeamRequestDto) {
    const { team } = await this.access(user, data.teamId, "problems");
    if (team.archived) throw new ConflictException("Restore the team first");
    if (!(await this.privileges.permissionDecision(user, UserPrivilegeType.CreateProblem, true)))
      throw new ForbiddenException();
    if (!data.sourceProblemId) {
      const problem = await this.problems.createProblem(
        user,
        ProblemType.Traditional,
        {
          localizedContents: [
            {
              locale: Locale.zh_CN,
              title: "新建团队题目",
              contentSections: [{ type: ProblemContentSectionType.Text, sectionTitle: "题目描述", text: "" }]
            }
          ],
          samples: [],
          problemTagIds: []
        },
        [],
        async (created, manager) => {
          const current = await this.activeAccess(user, team.id, "problems", manager);
          await this.registerResource(manager, current.team, "problem", created.id);
        },
        async manager => {
          await this.activeAccess(user, team.id, "problems", manager);
          if (!(await this.privileges.permissionDecision(user, UserPrivilegeType.CreateProblem, true, manager)))
            throw new ForbiddenException();
        }
      );
      return { problemId: problem.id };
    }
    const source = await this.problems.findProblemById(integer(data.sourceProblemId));
    if (!source || !(await this.problems.userHasPermission(user, source, ProblemPermissionType.Modify)))
      throw new ForbiddenException("Copying judge data requires permission to modify the source problem");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "llmoj-team-copy-"));
    const clonedFiles: { source: ProblemFileEntity; uuid: string; size: number }[] = [];
    let committed = false;
    try {
      const sourceFiles = await this.db.getRepository(ProblemFileEntity).findBy({ problemId: source.id });
      if (sourceFiles.length > 10000) throw new BadRequestException("Too many problem files");
      for (const file of sourceFiles) {
        const local = path.join(directory, uuid());
        // eslint-disable-next-line no-await-in-loop
        const size = await this.files.downloadFileToPath(file.uuid, local, 2147483647);
        const copiedUuid = uuid();
        clonedFiles.push({ source: file, uuid: copiedUuid, size });
        // eslint-disable-next-line no-await-in-loop
        await this.files.uploadFile(copiedUuid, local);
        // eslint-disable-next-line no-await-in-loop
        await fs.unlink(local);
      }
      const problemId = await this.db.transaction("SERIALIZABLE", async manager => {
        const lockedSource = await manager.findOne(ProblemEntity, {
          where: { id: source.id },
          lock: { mode: "pessimistic_read" }
        });
        if (!lockedSource) throw new NotFoundException();
        const sourceResource = await manager.findOneBy(TeamResourceEntity, { kind: "problem", resourceId: source.id });
        const teamIds = [...new Set([team.id, ...(sourceResource ? [sourceResource.teamId] : [])])].sort(
          (a, b) => a - b
        );
        // Problem edits lock the source first. Cross-team copies then take all team locks in ID order.
        for (const id of teamIds) {
          // eslint-disable-next-line no-await-in-loop -- Preserve deterministic team row order across opposite-direction copies.
          await manager.findOne(TeamEntity, { where: { id }, lock: { mode: "pessimistic_write" } });
        }
        const current = await this.activeAccess(user, team.id, "problems", manager);
        if (!(await this.privileges.permissionDecision(user, UserPrivilegeType.CreateProblem, true, manager)))
          throw new ForbiddenException();
        if (
          !lockedSource ||
          !(await this.problems.userHasPermission(user, lockedSource, ProblemPermissionType.Modify, undefined, manager))
        )
          throw new ForbiddenException();
        const currentFiles = await manager.findBy(ProblemFileEntity, { problemId: source.id });
        if (
          currentFiles.length !== clonedFiles.length ||
          currentFiles.some(
            f =>
              !clonedFiles.some(
                c => c.source.filename === f.filename && c.source.type === f.type && c.source.uuid === f.uuid
              )
          )
        )
          throw new ConflictException("Source files changed; retry copying");
        const problem = await manager.save(
          ProblemEntity,
          manager.create(ProblemEntity, {
            displayId: null,
            type: lockedSource.type,
            isPublic: false,
            publicTime: null,
            ownerId: user.id,
            locales: lockedSource.locales,
            difficulty: lockedSource.difficulty,
            originalProblem: lockedSource.originalProblem,
            originalProblemTitle: lockedSource.originalProblemTitle,
            submissionCount: 0,
            acceptedSubmissionCount: 0
          })
        );
        const [judge, sample, localized, tags] = await Promise.all([
          manager.findOneBy(ProblemJudgeInfoEntity, { problemId: source.id }),
          manager.findOneBy(ProblemSampleEntity, { problemId: source.id }),
          manager.findBy(LocalizedContentEntity, {
            objectId: source.id,
            type: In([LocalizedContentType.ProblemTitle, LocalizedContentType.ProblemContent])
          }),
          manager.findBy(ProblemTagMapEntity, { problemId: source.id })
        ]);
        if (!judge || !sample) throw new ConflictException("Source problem is incomplete");
        await manager.save(
          ProblemJudgeInfoEntity,
          manager.create(ProblemJudgeInfoEntity, {
            problemId: problem.id,
            judgeInfo: judge.judgeInfo,
            submittable: judge.submittable
          })
        );
        await manager.save(
          ProblemSampleEntity,
          manager.create(ProblemSampleEntity, { problemId: problem.id, data: sample.data })
        );
        await manager.save(
          LocalizedContentEntity,
          localized.map(l =>
            manager.create(LocalizedContentEntity, {
              objectId: problem.id,
              type: l.type,
              locale: l.locale,
              data: l.data
            })
          )
        );
        if (tags.length)
          await manager.save(
            ProblemTagMapEntity,
            tags.map(t => manager.create(ProblemTagMapEntity, { problemId: problem.id, problemTagId: t.problemTagId }))
          );
        for (const clone of clonedFiles) {
          // eslint-disable-next-line no-await-in-loop
          await manager.save(
            FileEntity,
            manager.create(FileEntity, { uuid: clone.uuid, size: clone.size, uploadTime: new Date() })
          );
          // eslint-disable-next-line no-await-in-loop
          await manager.save(
            ProblemFileEntity,
            manager.create(ProblemFileEntity, {
              problemId: problem.id,
              type: clone.source.type,
              filename: clone.source.filename,
              uuid: clone.uuid
            })
          );
        }
        await this.registerResource(manager, current.team, "problem", problem.id);
        return problem.id;
      });
      committed = true;
      return { problemId };
    } catch (error) {
      return rethrowTeamConflict(error);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      if (!committed) clonedFiles.forEach(file => this.files.deleteUnfinishedUploadedFile(file.uuid));
    }
  }

  async createContest(user: UserEntity, data: TeamRequestDto) {
    const startTime = new Date(data.startTime);
    const endTime = new Date(data.endTime);
    if (
      !Number.isFinite(+startTime) ||
      !Number.isFinite(+endTime) ||
      +startTime >= +endTime ||
      !isContestRule(data.rule)
    )
      throw new BadRequestException("Invalid contest time or rule");
    return await this.db.transaction(async manager => {
      const { team } = await this.activeAccess(user, data.teamId, "contests", manager);
      if (!(await this.privileges.permissionDecision(user, UserPrivilegeType.CreateContest, true, manager)))
        throw new ForbiddenException();
      const invitedUserIds = await this.validUserIds(manager, data.invitedUserIds ?? []);
      const contest = await manager.save(
        ContestEntity,
        manager.create(ContestEntity, {
          title: text(data.title, 160, true),
          subtitle: text(data.subtitle ?? "", 20000),
          description: text(data.description ?? "", 200000),
          rule: data.rule,
          ruleOptions: null,
          startTime,
          endTime,
          ownerId: user.id,
          adminIds: [],
          isPublic: data.visibility === "public",
          hideStatistics: false,
          languages: normalizeContestLanguages(data.languages?.length ? data.languages : ["cpp", "python"]),
          createdAt: new Date()
        })
      );
      await this.registerResource(manager, team, "contest", contest.id);
      await manager.update(
        TeamResourceEntity,
        { kind: "contest", resourceId: contest.id },
        {
          visibility: data.visibility ?? "private",
          invitedUserIds,
          inviteCode: data.visibility === "invite" ? uuid() : null
        }
      );
      return { contestId: contest.id };
    });
  }

  async updateContestAccess(user: UserEntity, data: TeamRequestDto) {
    if (!["private", "public", "invite"].includes(data.visibility)) throw new BadRequestException();
    return await this.db.transaction(async manager => {
      await this.activeAccess(user, data.teamId, "contests", manager);
      const resource = await manager.findOneBy(TeamResourceEntity, {
        teamId: data.teamId,
        kind: "contest",
        resourceId: integer(data.contestId)
      });
      if (!resource) throw new NotFoundException();
      resource.visibility = data.visibility;
      resource.invitedUserIds = await this.validUserIds(manager, data.invitedUserIds ?? []);
      resource.inviteCode = data.visibility === "invite" ? resource.inviteCode ?? uuid() : null;
      await manager.save(resource);
      await manager.update(ContestEntity, resource.resourceId, { isPublic: resource.visibility === "public" });
      return { inviteCode: resource.inviteCode };
    });
  }

  async createDiscussion(user: UserEntity, data: TeamRequestDto) {
    const { team } = await this.requireMember(user, data.teamId);
    if (team.archived) throw new ConflictException("Restore the team first");
    if (!(await this.discussions.userHasCreateDiscussionPermission(user)))
      throw new ForbiddenException("Posting discussions is disabled for this user");
    const problem = data.problemId ? await this.problems.findProblemById(integer(data.problemId)) : null;
    if (
      data.problemId &&
      (!problem || !(await this.problems.userHasPermission(user, problem, ProblemPermissionType.View)))
    )
      throw new ForbiddenException("Problem unavailable");
    const discussion = await this.discussions.createDiscussion(
      user,
      text(data.title, 80, true),
      text(data.content ?? "", 2000000),
      problem,
      async (created, manager) => {
        const current = await this.requireMember(user, team.id, manager);
        created.isPublic = false;
        await manager.update(DiscussionEntity, created.id, { isPublic: false });
        await this.registerResource(manager, current.team, "discussion", created.id);
      },
      async manager => {
        const current = await this.access(user, team.id, undefined, manager, true);
        if (current.team.archived || (!current.isTeamManager && current.member?.status !== "member"))
          throw new ForbiddenException();
        if (!(await this.discussions.userHasCreateDiscussionPermission(user, undefined, manager)))
          throw new ForbiddenException();
        if (
          problem &&
          !(await this.problems.userHasPermission(user, problem, ProblemPermissionType.View, undefined, manager))
        )
          throw new ForbiddenException();
      }
    );
    return { discussionId: discussion.id };
  }

  async archiveResource(user: UserEntity, data: TeamRequestDto) {
    if (!["problem", "contest", "discussion", "assignment"].includes(data.kind) || typeof data.archived !== "boolean")
      throw new BadRequestException();
    await this.db.transaction(async manager => {
      await this.activeAccess(user, data.teamId, this.resourcePermission(data.kind), manager);
      const resource = await manager.findOneBy(TeamResourceEntity, {
        teamId: data.teamId,
        kind: data.kind,
        resourceId: integer(data.resourceId)
      });
      if (!resource) throw new NotFoundException();
      resource.archived = data.archived;
      await manager.save(resource);
      if (data.kind === "assignment")
        await manager.update(
          TeamAssignmentEntity,
          { teamId: data.teamId, id: data.resourceId },
          { archived: data.archived }
        );
    });
    return {};
  }

  private assigned(assignment: TeamAssignmentEntity, member: TeamMemberEntity): boolean {
    return (
      member?.status === "member" &&
      ((!assignment.assignedUserIds.length && !assignment.assignedGroupIds.length) ||
        assignment.assignedUserIds.includes(member.userId) ||
        assignment.assignedGroupIds.includes(member.groupId))
    );
  }

  async saveAssignment(user: UserEntity, data: TeamRequestDto) {
    if (
      !Array.isArray(data.items) ||
      data.items.length > 1000 ||
      new Set(data.items.map(i => i.problemId)).size !== data.items.length
    )
      throw new BadRequestException("Invalid or duplicate assignment items");
    const deadline = data.deadline ? new Date(data.deadline) : null;
    if (deadline && !Number.isFinite(+deadline)) throw new BadRequestException("Invalid deadline");
    return await this.db.transaction(async manager => {
      const { team } = await this.activeAccess(user, data.teamId, "assignments", manager);
      const assignedUserIds = [...new Set(data.assignedUserIds ?? [])];
      const assignedGroupIds = [...new Set(data.assignedGroupIds ?? [])];
      if (
        assignedUserIds.length &&
        (await manager.countBy(TeamMemberEntity, {
          teamId: team.id,
          userId: In(assignedUserIds),
          status: "member"
        })) !== assignedUserIds.length
      )
        throw new BadRequestException("Assignments may target team members only");
      if (
        assignedGroupIds.length &&
        (await manager.countBy(TeamMemberGroupEntity, {
          teamId: team.id,
          id: In(assignedGroupIds),
          archived: false
        })) !== assignedGroupIds.length
      )
        throw new BadRequestException("Unknown assignment group");
      for (const item of data.items) {
        // eslint-disable-next-line no-await-in-loop
        const problem = await manager.findOneBy(ProblemEntity, { id: integer(item.problemId) });
        let available = false;
        if (problem) {
          // eslint-disable-next-line no-await-in-loop -- Authorization uses this transaction's locking reads.
          available = await this.problems.userHasPermission(
            user,
            problem,
            ProblemPermissionType.View,
            undefined,
            manager
          );
        }
        if (!available) throw new ForbiddenException("Problem unavailable");
      }
      let assignment = data.id
        ? await manager.findOneBy(TeamAssignmentEntity, { id: data.id, teamId: team.id })
        : manager.create(TeamAssignmentEntity, { teamId: team.id, createdAt: new Date() });
      if (!assignment) throw new NotFoundException();
      Object.assign(assignment, {
        title: text(data.title, 160, true),
        description: text(data.description ?? "", 200000),
        items: data.items,
        deadline,
        assignedUserIds,
        assignedGroupIds,
        archived: data.archived ?? false
      });
      assignment = await manager.save(assignment);
      if (!data.id) await this.registerResource(manager, team, "assignment", assignment.id);
      await manager.update(
        TeamResourceEntity,
        { kind: "assignment", resourceId: assignment.id },
        { archived: assignment.archived }
      );
      return { id: assignment.id };
    });
  }

  async assignment(user: UserEntity, data: TeamRequestDto) {
    const { team, member, isTeamManager } = await this.requireMember(user, data.teamId);
    const assignment = await this.db
      .getRepository(TeamAssignmentEntity)
      .findOneBy({ teamId: team.id, id: integer(data.id) });
    if (!assignment) throw new NotFoundException();
    const canManage = hasTeamPermission(team, member, user, "assignments", isTeamManager);
    if (!canManage && (assignment.archived || !this.assigned(assignment, member)))
      throw new ForbiddenException("This assignment is not assigned to you");
    const members = (
      await this.db.getRepository(TeamMemberEntity).findBy({ teamId: team.id, status: "member" })
    ).filter(m => this.assigned(assignment, m) && (canManage || m.userId === user.id));
    const userRows = await this.users.findUsersByExistingIds(members.map(m => m.userId));
    const scores = new Map<number, SubmissionEntity[]>();
    if (members.length && assignment.items.length) {
      const qb = this.db
        .getRepository(SubmissionEntity)
        .createQueryBuilder("s")
        .where("s.submitterId IN (:...ids) AND s.problemId IN (:...problems) AND s.contestId IS NULL", {
          ids: members.map(m => m.userId),
          problems: assignment.items.map(i => i.problemId)
        });
      if (assignment.deadline) qb.andWhere("s.submitTime <= :deadline", { deadline: assignment.deadline });
      const submissions = await qb.orderBy("s.id", "ASC").getMany();
      submissions.forEach(s => scores.set(s.submitterId, [...(scores.get(s.submitterId) ?? []), s]));
    }
    const rows = members.map((m, i) => {
      const results = {};
      let total = 0;
      for (const item of assignment.items) {
        const submissions = (scores.get(m.userId) ?? []).filter(s => s.problemId === item.problemId && s.score != null);
        const score = (s: SubmissionEntity) =>
          s.status === "Accepted"
            ? 100
            : ["Fake", "Hacked"].includes(s.status)
            ? 0
            : Math.max(0, Math.min(100, Number(s.score) || 0));
        const best = submissions.sort((a, b) => score(b) - score(a) || b.id - a.id)[0];
        results[item.problemId] = best
          ? { score: score(best), status: best.status, submissionId: best.id, accepted: best.status === "Accepted" }
          : { score: 0, status: null, submissionId: null, accepted: false };
        total += best ? score(best) : 0;
      }
      return {
        userId: m.userId,
        username: userRows[i]?.username ?? String(m.userId),
        note: canManage ? m.note : undefined,
        groupId: m.groupId,
        total,
        problems: results
      };
    });
    const details = [];
    for (const item of assignment.items) {
      // eslint-disable-next-line no-await-in-loop
      const problem = await this.problems.findProblemById(item.problemId);
      // eslint-disable-next-line no-await-in-loop
      const available = problem && (await this.problems.userHasPermission(user, problem, ProblemPermissionType.View));
      // eslint-disable-next-line no-await-in-loop -- Only fetch a title after its view authorization succeeds.
      const title = available ? await this.problems.getProblemLocalizedTitle(problem, problem.locales[0]) : undefined;
      details.push(!available ? { ...item, unavailable: true } : { ...item, title });
    }
    return { assignment, details, rows, canManage };
  }

  async exportAssignment(user: UserEntity, data: TeamRequestDto) {
    await this.access(user, data.teamId, "assignments");
    const { assignment, rows } = await this.assignment(user, data);
    return {
      filename: `team-${data.teamId}-assignment-${assignment.id}.csv`,
      csv: `\ufeff${[
        ["用户ID", "用户名", "分组ID", "备注", "总分", ...assignment.items.map(i => `题目${i.problemId}`)]
          .map(teamCsvCell)
          .join(","),
        ...rows.map(row =>
          [
            row.userId,
            row.username,
            row.groupId,
            row.note,
            row.total,
            ...assignment.items.map(i => row.problems[i.problemId].score)
          ]
            .map(teamCsvCell)
            .join(",")
        )
      ].join("\r\n")}`
    };
  }

  async prepareFileUpload(user: UserEntity, data: TeamRequestDto) {
    if (!Number.isSafeInteger(data.size) || data.size < 0) throw new BadRequestException("Invalid file size");
    let expiredObjects: string[] = [];
    const result = await this.db.transaction(async manager => {
      const { team } = await this.access(user, data.teamId, undefined, manager, true);
      await this.requireMember(user, team.id, manager);
      if (team.archived) throw new ConflictException();
      const reservations = await manager.findBy(TeamFileUploadEntity, { teamId: team.id });
      const expired = reservations.filter(upload => +upload.expiresAt <= Date.now());
      expiredObjects = expired.flatMap(upload => [upload.uuid, ...upload.parts]);
      if (expired.length) await manager.delete(TeamFileUploadEntity, { uuid: In(expired.map(upload => upload.uuid)) });
      const reserved = reservations
        .filter(upload => +upload.expiresAt > Date.now())
        .reduce((sum, upload) => sum + upload.size, 0);
      if (Number(team.quotaUsed) + reserved + data.size > Math.min(Number(team.quotaLimit), TEAM_FILE_QUOTA))
        throw new BadRequestException("TEAM_QUOTA_EXCEEDED");
      const upload = await manager.save(
        TeamFileUploadEntity,
        manager.create(TeamFileUploadEntity, {
          uuid: uuid(),
          teamId: team.id,
          userId: user.id,
          size: data.size,
          parts:
            data.size > TEAM_FILE_PART_SIZE
              ? Array.from({ length: Math.ceil(data.size / TEAM_FILE_PART_SIZE) }, () => uuid())
              : [],
          expiresAt: new Date(Date.now() + FILE_UPLOAD_LIFETIME)
        })
      );
      return {
        uploadSession: {
          uuid: upload.uuid,
          size: upload.size,
          partSize: TEAM_FILE_PART_SIZE,
          partCount: upload.parts.length
        },
        ...(upload.parts.length
          ? {}
          : { signedUploadRequest: await this.files.signTeamUploadPart(upload.uuid, upload.size, upload.expiresAt) })
      };
    });
    if (expiredObjects.length) await this.files.discardTeamUploadObjects(expiredObjects).catch(() => undefined);
    return result;
  }

  private async pendingFileUpload(manager: EntityManager, user: UserEntity, teamId: number, objectUuid: string) {
    if (typeof objectUuid !== "string" || !objectUuid) throw new BadRequestException("Upload UUID required");
    const upload = await manager.findOneBy(TeamFileUploadEntity, { uuid: objectUuid, teamId, userId: user.id });
    if (!upload || +upload.expiresAt <= Date.now()) throw new BadRequestException("FILE_UPLOAD_EXPIRED");
    return upload;
  }

  async prepareFileUploadPart(user: UserEntity, data: TeamRequestDto) {
    return await this.db.transaction(async manager => {
      const { team } = await this.access(user, data.teamId, undefined, manager, true);
      await this.requireMember(user, team.id, manager);
      if (team.archived) throw new ConflictException();
      const upload = await this.pendingFileUpload(manager, user, team.id, data.uuid);
      if (!Number.isSafeInteger(data.part) || data.part < 1 || data.part > upload.parts.length)
        throw new BadRequestException("Invalid upload part");
      const size = Math.min(TEAM_FILE_PART_SIZE, upload.size - (data.part - 1) * TEAM_FILE_PART_SIZE);
      return {
        signedUploadRequest: await this.files.signTeamUploadPart(upload.parts[data.part - 1], size, upload.expiresAt)
      };
    });
  }

  async cancelFileUpload(user: UserEntity, data: TeamRequestDto) {
    if (typeof data.uuid !== "string" || !data.uuid) throw new BadRequestException("Upload UUID required");
    const upload = await this.db.transaction(async manager => {
      await this.access(user, data.teamId, undefined, manager, true);
      await this.requireMember(user, data.teamId, manager);
      const pending = await manager.findOneBy(TeamFileUploadEntity, {
        uuid: data.uuid,
        teamId: data.teamId,
        userId: user.id
      });
      if (pending) await manager.delete(TeamFileUploadEntity, { uuid: pending.uuid });
      return pending;
    });
    if (upload) await this.files.discardTeamUploadObjects([upload.uuid, ...upload.parts]).catch(() => undefined);
    return {};
  }

  async uploadFile(user: UserEntity, data: TeamRequestDto) {
    if (!data.uploadInfo) throw new BadRequestException("Upload information required");
    if (!data.uploadInfo.uuid)
      return await this.prepareFileUpload(user, { teamId: data.teamId, size: data.uploadInfo.size });
    let uploadedParts: string[] = [];
    const completed = await this.db.transaction(async manager => {
      const { team } = await this.access(user, data.teamId, undefined, manager, true);
      await this.requireMember(user, team.id, manager);
      if (team.archived) throw new ConflictException();
      const name = text(data.name, 240, true);
      // eslint-disable-next-line no-control-regex -- File names must exclude control bytes and path separators.
      if (/[\u0000-\u001f/\\]/.test(name)) throw new BadRequestException("Invalid filename");
      const upload = await this.pendingFileUpload(manager, user, team.id, data.uploadInfo.uuid);
      if (upload.size !== data.uploadInfo.size) throw new BadRequestException("FILE_SIZE_MISMATCH");
      if (await manager.countBy(FileEntity, { uuid: upload.uuid })) throw new BadRequestException("FILE_UUID_EXISTS");
      if (upload.parts.length)
        await this.files.composeTeamUpload(
          upload.uuid,
          upload.parts.map((part, index) => ({
            uuid: part,
            size: Math.min(TEAM_FILE_PART_SIZE, upload.size - index * TEAM_FILE_PART_SIZE)
          }))
        );
      const result = await this.files.processUploadRequest(
        data.uploadInfo,
        size =>
          !Number.isSafeInteger(size) || size < 0 || size !== upload.size
            ? "FILE_SIZE_MISMATCH"
            : size + Number(team.quotaUsed) > Math.min(Number(team.quotaLimit), TEAM_FILE_QUOTA)
            ? "TEAM_QUOTA_EXCEEDED"
            : null,
        manager
      );
      if (typeof result === "string") throw new BadRequestException(result);
      if (!(result instanceof FileEntity)) return { signedUploadRequest: result };
      const file = await manager.save(
        TeamFileEntity,
        manager.create(TeamFileEntity, {
          teamId: team.id,
          name,
          uuid: result.uuid,
          size: result.size,
          uploaderId: user.id,
          archived: false,
          createdAt: new Date()
        })
      );
      team.quotaUsed = Number(team.quotaUsed) + result.size;
      await manager.save(team);
      await manager.delete(TeamFileUploadEntity, { uuid: upload.uuid });
      uploadedParts = upload.parts;
      return { fileId: file.id };
    });
    if (uploadedParts.length) await this.files.discardTeamUploadObjects(uploadedParts).catch(() => undefined);
    return completed;
  }

  async downloadFile(user: UserEntity, data: TeamRequestDto) {
    const { team, member, isTeamManager } = await this.requireMember(user, data.teamId);
    const file = await this.db.getRepository(TeamFileEntity).findOneBy({ id: integer(data.id), teamId: team.id });
    if (!file || (file.archived && !hasTeamPermission(team, member, user, "files", isTeamManager)))
      throw new NotFoundException();
    return {
      url: await this.files.signDownloadLink({
        uuid: file.uuid,
        downloadFilename: file.name,
        signFor: MinioSignFor.UserDownload,
        expiresSeconds: 60
      })
    };
  }

  async archiveFile(user: UserEntity, data: TeamRequestDto) {
    if (typeof data.archived !== "boolean") throw new BadRequestException();
    await this.db.transaction(async manager => {
      await this.activeAccess(user, data.teamId, "files", manager);
      const result = await manager.update(
        TeamFileEntity,
        { id: integer(data.id), teamId: data.teamId },
        { archived: data.archived }
      );
      if (!result.affected) throw new NotFoundException();
    });
    return {};
  }

  private async validUserIds(manager: EntityManager, ids: number[]) {
    if (!Array.isArray(ids) || ids.length > 10000 || ids.some(id => !Number.isSafeInteger(id) || id < 1))
      throw new BadRequestException("Invalid users");
    const unique = [...new Set(ids)];
    if (unique.length && (await manager.countBy(UserEntity, { id: In(unique) })) !== unique.length)
      throw new BadRequestException("User not found");
    return unique;
  }

  async createInvitation(user: UserEntity, data: TeamRequestDto) {
    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : new Date(Date.now() + 7 * 24 * 3600 * 1000);
    if (!Number.isFinite(+expiresAt) || +expiresAt <= Date.now())
      throw new BadRequestException("Invalid invitation expiry");
    return await this.db.transaction(async manager => {
      const { team } = await this.activeAccess(user, data.teamId, "members", manager);
      if (data.userId) await this.validUserIds(manager, [data.userId]);
      const invitation = await manager.save(
        TeamInvitationEntity,
        manager.create(TeamInvitationEntity, {
          teamId: team.id,
          token: uuid(),
          userId: data.userId ?? null,
          maxUses: data.userId ? 1 : data.maxUses ?? 1,
          uses: 0,
          expiresAt,
          active: true
        })
      );
      return { invitation };
    });
  }

  async invitations(user: UserEntity, teamId: number) {
    await this.access(user, teamId, "members");
    return {
      invitations: await this.db.getRepository(TeamInvitationEntity).find({ where: { teamId }, order: { id: "DESC" } })
    };
  }

  async deactivateInvitation(user: UserEntity, data: TeamRequestDto) {
    await this.db.transaction(async manager => {
      await this.activeAccess(user, data.teamId, "members", manager);
      if (
        !(await manager.update(TeamInvitationEntity, { teamId: data.teamId, id: integer(data.id) }, { active: false }))
          .affected
      )
        throw new NotFoundException();
    });
    return {};
  }

  async acceptInvitation(user: UserEntity, token: string) {
    this.login(user);
    if (!token) throw new BadRequestException();
    const invitation = await this.db.getRepository(TeamInvitationEntity).findOneBy({ token });
    if (!invitation) throw new NotFoundException("Invitation not found");
    return await this.db.transaction(async manager => {
      const { team, member: existing } = await this.access(user, invitation.teamId, undefined, manager, true);
      const locked = await manager.findOne(TeamInvitationEntity, {
        where: { id: invitation.id },
        lock: { mode: "pessimistic_write" }
      });
      if (
        team.archived ||
        !locked.active ||
        locked.uses >= locked.maxUses ||
        +locked.expiresAt <= Date.now() ||
        (locked.userId && locked.userId !== user.id)
      )
        throw new ForbiddenException("Invitation expired, exhausted, or assigned to another user");
      if (existing?.status === "blocked") throw new ForbiddenException("You are on the team blacklist");
      if (existing?.status === "member") return { teamId: team.id, status: "member" };
      const member =
        existing ??
        manager.create(TeamMemberEntity, {
          teamId: team.id,
          userId: user.id,
          status: "applicant",
          groupId: null,
          note: "",
          application: "",
          permissions: [],
          joinedAt: new Date()
        });
      await this.setStatus(manager, team, member, "member");
      locked.uses++;
      await manager.save(locked);
      return { teamId: team.id, status: "member" };
    });
  }

  async acceptContestInvitation(user: UserEntity, token: string) {
    this.login(user);
    if (!token) throw new BadRequestException();
    const invitation = await this.db
      .getRepository(TeamResourceEntity)
      .findOneBy({ kind: "contest", inviteCode: token });
    if (!invitation) throw new NotFoundException("Invitation not found");
    return await this.db.transaction(async manager => {
      const { team, member } = await this.access(user, invitation.teamId, undefined, manager, true);
      const locked = await manager.findOne(TeamResourceEntity, {
        where: { id: invitation.id },
        lock: { mode: "pessimistic_write" }
      });
      if (team.archived || locked.archived || locked.visibility !== "invite" || member?.status === "blocked")
        throw new ForbiddenException();
      if (!locked.invitedUserIds.includes(user.id)) {
        if (locked.invitedUserIds.length >= 10000) throw new ConflictException("Invitation participant limit reached");
        locked.invitedUserIds.push(user.id);
        await manager.save(locked);
      }
      return { contestId: locked.resourceId };
    });
  }
}
