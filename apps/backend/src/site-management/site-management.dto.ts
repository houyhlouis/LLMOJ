import { ApiProperty } from "@nestjs/swagger";

import { IsBoolean, IsIn, IsInt, Max, Min, ValidateIf } from "class-validator";

import { REGISTRATION_MODES, RegistrationMode } from "../settings/registration-settings.service";
import { AI_POLICY_LIMITS } from "../settings/ai-policy.service";

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
