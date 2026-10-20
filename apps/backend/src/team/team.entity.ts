import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import { JsonColumn } from "../database/json-column";

export const TEAM_PERMISSIONS = [
  "settings",
  "members",
  "problems",
  "contests",
  "assignments",
  "discussions",
  "files"
] as const;
export type TeamPermission = (typeof TEAM_PERMISSIONS)[number];
export type TeamJoinPolicy = "open" | "approval" | "closed";
export type TeamMemberStatus = "member" | "applicant" | "blocked";
export type TeamResourceKind = "problem" | "contest" | "discussion" | "assignment";
export type TeamResourceVisibility = "private" | "public" | "invite";
export const TEAM_FILE_QUOTA = 10 * 1024 * 1024 * 1024;
export const TEAM_FILE_PART_SIZE = 32 * 1024 * 1024;

@Entity("team")
export class TeamEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column({ length: 80 }) @Index({ unique: true }) name: string;

  @Column({ type: "mediumtext" }) description: string;

  @Column({ type: "mediumtext" }) announcement: string;

  @Column() @Index() ownerId: number;

  @Column() @Index({ unique: true }) permissionGroupId: number;

  @Column({ type: "varchar", length: 16, default: "approval" }) joinPolicy: TeamJoinPolicy;

  @Column({ default: false }) groupChangeLocked: boolean;

  @Column({ default: false }) @Index() archived: boolean;

  @Column({ default: 0 }) memberCount: number;

  @Column({ type: "bigint", default: TEAM_FILE_QUOTA }) quotaLimit: number;

  @Column({ type: "bigint", default: 0 }) quotaUsed: number;

  @Column({ type: "datetime" }) createdAt: Date;
}

@Entity("team_member")
@Index(["teamId", "userId"], { unique: true })
export class TeamMemberEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column() @Index() teamId: number;

  @Column() @Index() userId: number;

  @Column({ type: "varchar", length: 16 }) status: TeamMemberStatus;

  @Column({ type: "integer", nullable: true }) groupId: number | null;

  @Column({ type: "varchar", length: 2000, default: "" }) note: string;

  @Column({ type: "varchar", length: 2000, default: "" }) application: string;

  @JsonColumn() permissions: TeamPermission[];

  @Column({ type: "datetime" }) joinedAt: Date;
}

@Entity("team_member_group")
@Index(["teamId", "name"], { unique: true })
export class TeamMemberGroupEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column() @Index() teamId: number;

  @Column({ length: 80 }) name: string;

  @Column({ default: false }) archived: boolean;
}

@Entity("team_resource")
@Index(["kind", "resourceId"], { unique: true })
export class TeamResourceEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column() @Index() teamId: number;

  @Column({ type: "varchar", length: 16 }) kind: TeamResourceKind;

  @Column() resourceId: number;

  @Column({ type: "varchar", length: 16, default: "private" }) visibility: TeamResourceVisibility;

  @JsonColumn() invitedUserIds: number[];

  @Column({ type: "char", length: 36, nullable: true }) @Index({ unique: true }) inviteCode: string | null;

  @Column({ default: false }) archived: boolean;
}

@Entity("team_invitation")
export class TeamInvitationEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column() @Index() teamId: number;

  @Column({ type: "char", length: 36 }) @Index({ unique: true }) token: string;

  @Column({ type: "integer", nullable: true }) userId: number | null;

  @Column({ default: 1 }) maxUses: number;

  @Column({ default: 0 }) uses: number;

  @Column({ type: "datetime" }) expiresAt: Date;

  @Column({ default: true }) active: boolean;
}

export interface TeamAssignmentItem {
  problemId: number;
  section: string;
  note: string;
}

@Entity("team_assignment")
export class TeamAssignmentEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column() @Index() teamId: number;

  @Column({ length: 160 }) title: string;

  @Column({ type: "mediumtext" }) description: string;

  @JsonColumn() items: TeamAssignmentItem[];

  @Column({ type: "datetime", nullable: true }) deadline: Date | null;

  @JsonColumn() assignedUserIds: number[];

  @JsonColumn() assignedGroupIds: number[];

  @Column({ default: false }) archived: boolean;

  @Column({ type: "datetime" }) createdAt: Date;
}

@Entity("team_file")
export class TeamFileEntity {
  @PrimaryGeneratedColumn() id: number;

  @Column() @Index() teamId: number;

  @Column({ length: 240 }) name: string;

  @Column({ type: "char", length: 36 }) @Index({ unique: true }) uuid: string;

  @Column({ type: "bigint", transformer: { to: (value: number) => value, from: (value: string) => Number(value) } })
  size: number;

  @Column() uploaderId: number;

  @Column({ default: false }) archived: boolean;

  @Column({ type: "datetime" }) createdAt: Date;
}

@Entity("team_file_upload")
export class TeamFileUploadEntity {
  @Column({ type: "char", length: 36, primary: true }) uuid: string;

  @Column() @Index() teamId: number;

  @Column() userId: number;

  @Column({ type: "bigint", transformer: { to: (value: number) => value, from: (value: string) => Number(value) } })
  size: number;

  @JsonColumn() parts: string[];

  @Column({ type: "datetime" }) expiresAt: Date;
}
