import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsIn,
  IsBoolean,
  Length,
  ValidateNested,
  IsDefined,
  Matches
} from "class-validator";
import { Type } from "class-transformer";

import { AI_PROGRAM_ROLE } from "@libreoj/judge-protocol";

import { AiAction } from "./ai.entity";
import { AiRetryFrom } from "./ai.types";
import { MAX_CONFIGURED_OUTPUT_TOKENS } from "./ai-validation";

export class LlmConfigurationDto {
  @IsOptional() @IsIn(["off", "json_schema"]) structuredOutput?: "off" | "json_schema";
  @IsOptional() @IsIn(["auto", "off", "background"]) responsesRecovery?: "auto" | "off" | "background";

  @IsIn(["chat", "responses", "anthropic"]) type: "chat" | "responses" | "anthropic";

  @IsString() @Length(1, 2000) baseUrl: string;

  @IsOptional() @IsString() @Length(0, 4096) apiKey?: string;

  @IsString() @Length(0, 200) model: string;

  @IsOptional() @IsString() @Length(0, 50) reasoning?: string;

  @IsOptional() @IsInt() @Min(512) @Max(MAX_CONFIGURED_OUTPUT_TOKENS) maxTokens?: number;
}
export class SearchConfigurationDto {
  @IsIn(["tavily", "mcp"]) type: "tavily" | "mcp";

  @IsString() @Length(1, 2000) baseUrl: string;

  @IsOptional() @IsString() @Length(0, 4096) apiKey?: string;

  @IsOptional() @IsString() @Length(0, 200) tool?: string;
}
export class AiPurposePolicyDto {
  @IsString() @Length(1, 200) model: string;
  @IsOptional() @IsString() @Length(0, 50) reasoning?: string;
  @IsOptional() @IsInt() @Min(512) @Max(MAX_CONFIGURED_OUTPUT_TOKENS) maxTokens?: number;
}
export class AiModelPoliciesDto {
  @IsOptional() @ValidateNested() @Type(() => AiPurposePolicyDto) reasoning?: AiPurposePolicyDto;
  @IsOptional() @ValidateNested() @Type(() => AiPurposePolicyDto) schema_repair?: AiPurposePolicyDto;
  @IsOptional() @ValidateNested() @Type(() => AiPurposePolicyDto) metadata?: AiPurposePolicyDto;
  @IsOptional() @ValidateNested() @Type(() => AiPurposePolicyDto) compiler_fix?: AiPurposePolicyDto;
}
export class SaveAiConfigurationDto {
  @IsOptional() @ValidateNested() @Type(() => AiModelPoliciesDto) modelPolicies?: AiModelPoliciesDto;
  @IsOptional() @IsIn(["optional", "required", "off"]) sourcePolicy?: "optional" | "required" | "off";

  @IsDefined() @ValidateNested() @Type(() => LlmConfigurationDto) llm: LlmConfigurationDto;

  @IsDefined() @ValidateNested() @Type(() => SearchConfigurationDto) search: SearchConfigurationDto;

  @IsBoolean() autoOnSave: boolean;

  @IsOptional() @IsInt() @Min(1) @Max(8) maxConcurrentJobs?: number;

  @IsOptional() @IsBoolean() clearLlmKey?: boolean;

  @IsOptional() @IsBoolean() clearSearchKey?: boolean;
}
export class StartAiJobDto {
  @IsOptional() @IsIn(["default", "qualify_first", "metadata_only"]) workflow?:
    "default" | "qualify_first" | "metadata_only";
  @IsOptional() @IsIn(["private", "summaries", "model_visible"]) corpusPolicy?:
    "private" | "summaries" | "model_visible";

  @IsOptional() @IsInt() @Min(1) problemId?: number;

  @IsIn(["metadata", "tags", "source", "difficulty", "translate", "tutorial", "testdata", "all", "import"])
  action: AiAction;

  @IsOptional() @IsString() @Length(1, 4096) attachmentToken?: string;

  @IsOptional() @IsInt() @Min(5) @Max(1000) count?: number;

  @IsOptional() @IsIn(["coverage", "score_ratio"]) allocationMode?: "coverage" | "score_ratio";

  @IsOptional() @IsString() @Length(0, 500000) markdown?: string;

  @IsOptional() @IsString() @Length(0, 15000000) image?: string;

  @IsOptional() @IsBoolean() automatic?: boolean;

  @IsOptional() @IsIn(["Traditional", "Interaction", "Communication"]) problemType?:
    "Traditional" | "Interaction" | "Communication";

  @IsOptional() @IsIn(["run-twice", "grader"]) communicationMode?: "run-twice" | "grader";
}
export class AiJobQueryDto {
  @IsOptional() @IsInt() @Min(1) problemId?: number;
}
export class AiJobIdDto {
  @IsString() @Length(36, 36) id: string;
}
export class AiTestDto {
  @IsIn(["llm", "search"]) target: "llm" | "search";
}

export class AiUsageQueryDto {
  @IsOptional() @IsInt() @Min(1) @Max(366) days?: number;
}
export class AiRetryJobDto extends AiJobIdDto {
  @IsOptional() @IsIn(["validate-samples", "std", "replace-scoring", "repair", "regenerate"]) retryFrom?: AiRetryFrom;

  // "repair": the program, by the role failures name it with (e.g. "std", "quality-alt-0")
  @IsOptional() @IsString() @Matches(AI_PROGRAM_ROLE) role?: string;
}

export class AiFailuresDto {
  @IsString() @Length(36, 36) jobId: string;
}
export class AiFailureArtifactDto extends AiFailuresDto {
  // The observation
  @IsString() @Length(36, 36) id: string;

  @IsIn(["input", "actual", "expected", "diagnostics"]) role: "input" | "actual" | "expected" | "diagnostics";

  // Where to read from (failureArtifact)
  @IsOptional() @IsInt() @Min(0) @Max(2147483647) offset?: number;
}

export class AiRepairChangeDto extends AiFailuresDto {
  // The repair's round (1, 2, …)
  @IsInt() @Min(1) @Max(1000) round: number;
}

export class AiTutorialStatusDto {
  @IsInt() @Min(1) discussionId: number;
}

export class AiReplayFailureDto extends AiFailuresDto {
  // The observation
  @IsString() @Length(36, 36) id: string;
}

export class AiPrepareAttachmentDto {
  @IsString() @Length(1, 256) filename: string;

  @IsInt() @Min(1) @Max(67108864) size: number;
}

export class AiJobSummaryQueryDto extends AiJobQueryDto {
  @IsOptional() @IsIn(["active", "attention", "history"]) section?: "active" | "attention" | "history";
  @IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() @Length(1, 512) cursor?: string;
  @IsOptional() @IsString() @Matches(/^[a-f0-9]{64}$/) ifVersion?: string;
}
export class AiJobDetailDto extends AiJobIdDto {
  @IsOptional() @IsInt() @Min(1) ifRevision?: number;
}

export class AiAllocationApprovalDto extends AiJobIdDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) digest: string;
}

export class AiDiagnosticExportDto extends AiJobIdDto {
  @IsOptional() @IsBoolean() includeRejectedProposal?: boolean;
}
