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
