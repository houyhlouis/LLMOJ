import { ApiProperty } from "@nestjs/swagger";

import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested
} from "class-validator";

import { REGISTRATION_MODES, RegistrationMode } from "../settings/registration-settings.service";
import { AI_POLICY_LIMITS } from "../settings/ai-policy.service";
import { TEST_DATA_RETENTION_LIMITS } from "../settings/test-data-retention-policy.service";
import { TestDataRetentionReasonKind } from "../problem/test-data-retention.service";
import { JUDGE_POLICY_LIMITS } from "../settings/judge-policy.service";
import { AI_ENDPOINT_TYPES, AiEndpointType, MAX_APPROVED_AI_ENDPOINTS } from "../settings/ai-endpoint-policy.service";

export class SiteManagementSettingsDto {
  @ApiProperty({ enum: [...REGISTRATION_MODES] })
  registrationMode: RegistrationMode;

  @ApiProperty({ enum: [...REGISTRATION_MODES] })
  configuredRegistrationMode: RegistrationMode;

  @ApiProperty()
  usesOverride: boolean;
}

export class UpdateRegistrationModeRequestDto {
  @ApiProperty({ enum: [...REGISTRATION_MODES], nullable: true, description: "Null restores the server YAML mode." })
  @ValidateIf((_object, value) => value !== null)
  @IsIn([...REGISTRATION_MODES])
  registrationMode: RegistrationMode | null;
}

const [maxUserTokens, maxUserRequests, maxJobRequests, maxConcurrent] = [
  AI_POLICY_LIMITS.userDailyTokens[1],
  AI_POLICY_LIMITS.userDailyRequests[1],
  AI_POLICY_LIMITS.jobRequests[1],
  AI_POLICY_LIMITS.concurrentRequests[1]
];

export class AiPolicyDto {
  @ApiProperty({ description: "No AI provider request starts while paused." })
  @IsBoolean()
  paused: boolean;

  @ApiProperty({ description: "Tokens per account in any 24 hours; 0 for no limit." })
  @IsInt()
  @Min(0)
  @Max(maxUserTokens)
  userDailyTokens: number;

  @ApiProperty({ description: "Model and search requests per account in any 24 hours; 0 for no limit." })
  @IsInt()
  @Min(0)
  @Max(maxUserRequests)
  userDailyRequests: number;

  @ApiProperty({ description: "Model and search requests per AI job; 0 for no limit." })
  @IsInt()
  @Min(0)
  @Max(maxJobRequests)
  jobRequests: number;

  @ApiProperty({ description: "AI provider requests running at the same time in one backend process." })
  @IsInt()
  @Min(1)
  @Max(maxConcurrent)
  concurrentRequests: number;
}

export class JudgePolicyDto {
  @ApiProperty({
    description:
      "Task threads each judge machine keeps for submissions to running contests while one runs; 0 keeps none."
  })
  @IsInt()
  @Min(0)
  @Max(JUDGE_POLICY_LIMITS.contestReservedThreads[1])
  contestReservedThreads: number;

  @ApiProperty({ description: "Minutes after which a waiting job gets every fifth task; 0 turns this off." })
  @IsInt()
  @Min(0)
  @Max(JUDGE_POLICY_LIMITS.agingMinutes[1])
  agingMinutes: number;
}

export class AiApprovedEndpointDto {
  @ApiProperty({ description: "Shown to users who choose it." })
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiProperty({ enum: [...AI_ENDPOINT_TYPES], description: "The API it speaks." })
  @IsIn([...AI_ENDPOINT_TYPES])
  type: AiEndpointType;

  @ApiProperty({ description: "Requests with this origin, at or below this path, are approved." })
  @IsString()
  @MaxLength(500)
  baseUrl: string;
}

export class AiEndpointPolicyDto {
  @ApiProperty({
    enum: ["public", "approved"],
    description: "Whether accounts may use public addresses that aren't approved. Private ones always need approval."
  })
  @IsIn(["public", "approved"])
  customEndpoints: "public" | "approved";

  @ApiProperty({ type: AiApprovedEndpointDto, isArray: true })
  @IsArray()
  @ArrayMaxSize(MAX_APPROVED_AI_ENDPOINTS)
  @ValidateNested({ each: true })
  @Type(() => AiApprovedEndpointDto)
  endpoints: AiApprovedEndpointDto[];
}

export class TestDataRetentionPolicyDto {
  @ApiProperty({ description: "Days after a contest ends that the test data its submissions were judged with stays." })
  @IsInt()
  @Min(0)
  @Max(TEST_DATA_RETENTION_LIMITS.contestDays[1])
  contestDays: number;

  @ApiProperty({
    description:
      "Days that removed test data stays for the results judged with it, from its removal (or from the rejudge that " +
      "replaced a result judged with it)."
  })
  @IsInt()
  @Min(0)
  @Max(TEST_DATA_RETENTION_LIMITS.resultDays[1])
  resultDays: number;
}

export class TestDataRetentionTotalsDto {
  @ApiProperty()
  files: number;

  @ApiProperty()
  bytes: number;
}

export class TestDataRetentionReasonTotalsDto extends TestDataRetentionTotalsDto {
  @ApiProperty({ enum: TestDataRetentionReasonKind })
  kind: TestDataRetentionReasonKind;
}

export class TestDataRetentionReasonDto {
  @ApiProperty({ enum: TestDataRetentionReasonKind })
  kind: TestDataRetentionReasonKind;

  @ApiProperty({ required: false, description: "When it ends; absent for as long as its cause lasts" })
  until?: Date;

  @ApiProperty({ required: false, description: "The number of the data version it comes from" })
  version?: number;

  @ApiProperty({ required: false })
  contestId?: number;

  @ApiProperty({ required: false })
  contestTitle?: string;

  @ApiProperty({ required: false, description: "Who kept the data version" })
  keptBy?: string;
}

export class RemovedTestDataFileDto {
  @ApiProperty({ required: false, description: "From a data version that uses it; null if none does" })
  problemId: number;

  @ApiProperty({ required: false })
  problemDisplayId: number;

  @ApiProperty({ required: false })
  filename: string;

  @ApiProperty({ required: false, description: "null once the file is gone" })
  size: number;

  @ApiProperty()
  removedAt: Date;

  @ApiProperty({ type: Number, isArray: true, description: "The numbers of the data versions that use it" })
  versions: number[];

  @ApiProperty({
    enum: ["Delete", "Keep", "Release"],
    description: "What the next cleanup does: deletes it, keeps it, or releases it (a problem uses it again)"
  })
  action: "Delete" | "Keep" | "Release";

  @ApiProperty({ required: false, description: "While kept: when its last reason ends; absent while one has no end" })
  keptUntil?: Date;

  @ApiProperty({ type: TestDataRetentionReasonDto, isArray: true })
  reasons: TestDataRetentionReasonDto[];
}

export class TestDataRetentionReportDto {
  @ApiProperty({ type: TestDataRetentionPolicyDto })
  policy: TestDataRetentionPolicyDto;

  @ApiProperty({ type: TestDataRetentionTotalsDto, description: "Test data removed from problems that still exists" })
  removed: TestDataRetentionTotalsDto;

  @ApiProperty({ type: TestDataRetentionTotalsDto, description: "Removed files the next cleanup keeps" })
  kept: TestDataRetentionTotalsDto;

  @ApiProperty({ type: TestDataRetentionTotalsDto, description: "Removed files the next cleanup deletes" })
  deletedAtNextCleanup: TestDataRetentionTotalsDto;

  @ApiProperty({ type: TestDataRetentionReasonTotalsDto, isArray: true, description: "A file counts for each reason" })
  byReason: TestDataRetentionReasonTotalsDto[];

  @ApiProperty({
    type: RemovedTestDataFileDto,
    isArray: true,
    description: "Those the next cleanup deletes first, then the largest it keeps"
  })
  files: RemovedTestDataFileDto[];

  @ApiProperty({ description: "How many removed files there are, including any not looked at" })
  total: number;

  @ApiProperty({ description: "How often the cleanup runs" })
  cleanupMinutes: number;
}
