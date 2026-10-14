import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested
} from "class-validator";

import {
  TeamJoinPolicy,
  TeamPermission,
  TeamResourceKind,
  TeamResourceVisibility,
  TEAM_PERMISSIONS
} from "./team.entity";

import { FileUploadInfoDto } from "../file/dto";

import { CONTEST_RULES, ContestRule } from "../contest/contest-rules";

class TeamAssignmentItemDto {
  @IsInt() @Min(1) problemId: number;

  @IsString() @Length(0, 120) section: string;

  @IsString() @Length(0, 10000) note: string;
}

export class TeamRequestDto {
  @IsOptional() @IsInt() @Min(1) teamId?: number;

  @IsOptional() @IsInt() @Min(1) id?: number;

  @IsOptional() @IsString() @Length(1, 240) name?: string;

  @IsOptional() @IsString() @Length(0, 200000) description?: string;

  @IsOptional() @IsString() @Length(0, 200000) announcement?: string;

  @IsOptional() @IsIn(["open", "approval", "closed"]) joinPolicy?: TeamJoinPolicy;

  @IsOptional() @IsBoolean() groupChangeLocked?: boolean;

  @IsOptional() @IsBoolean() archived?: boolean;

  @IsOptional() @IsString() @Length(0, 2000) message?: string;

  @IsOptional() @IsInt() @Min(1) userId?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(1000) @IsInt({ each: true }) @Min(1, { each: true }) userIds?: number[];

  @IsOptional()
  @IsIn(["approve", "reject", "remove", "block", "unblock", "setGroup", "note", "permissions"])
  action?: string;

  @IsOptional() @IsInt() @Min(1) groupId?: number | null;

  @IsOptional() @IsString() @Length(0, 2000) note?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(7) @IsIn([...TEAM_PERMISSIONS], { each: true }) permissions?: TeamPermission[];

  @IsOptional() @IsInt() @Min(1) sourceProblemId?: number;

  @IsOptional() @IsString() @Length(1, 160) title?: string;

  @IsOptional() @IsString() @Length(0, 20000) subtitle?: string;

  @IsOptional() @IsIn([...CONTEST_RULES]) rule?: ContestRule;

  @IsOptional() @IsString() startTime?: string;

  @IsOptional() @IsString() endTime?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) languages?: string[];

  @IsOptional() @IsIn(["private", "public", "invite"]) visibility?: TeamResourceVisibility;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  invitedUserIds?: number[];

  @IsOptional() @IsInt() @Min(1) contestId?: number;

  @IsOptional() @IsInt() @Min(1) problemId?: number;

  @IsOptional() @IsString() @Length(0, 2000000) content?: string;

  @IsOptional() @IsIn(["problem", "contest", "discussion", "assignment"]) kind?: TeamResourceKind;

  @IsOptional() @IsInt() @Min(1) resourceId?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => TeamAssignmentItemDto)
  items?: TeamAssignmentItemDto[];

  @IsOptional() @IsString() deadline?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  assignedUserIds?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  assignedGroupIds?: number[];

  @IsOptional() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) size?: number;

  @IsOptional() @IsUUID() uuid?: string;

  @IsOptional() @IsInt() @Min(1) @Max(320) part?: number;

  @IsOptional() @ValidateNested() @Type(() => FileUploadInfoDto) uploadInfo?: FileUploadInfoDto;

  @IsOptional() @IsUUID() token?: string;

  @IsOptional() @IsInt() @Min(1) @Max(1000) maxUses?: number;

  @IsOptional() @IsString() expiresAt?: string;
}
