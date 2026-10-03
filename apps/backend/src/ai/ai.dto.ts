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
  IsDefined
} from "class-validator";
import { Type } from "class-transformer";

import { AiAction } from "./ai.entity";
import { MAX_CONFIGURED_OUTPUT_TOKENS } from "./ai-validation";

export class LlmConfigurationDto {
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
export class SaveAiConfigurationDto {
  @IsDefined() @ValidateNested() @Type(() => LlmConfigurationDto) llm: LlmConfigurationDto;

  @IsDefined() @ValidateNested() @Type(() => SearchConfigurationDto) search: SearchConfigurationDto;

  @IsBoolean() autoOnSave: boolean;

  @IsOptional() @IsInt() @Min(1) @Max(8) maxConcurrentJobs?: number;

  @IsOptional() @IsBoolean() clearLlmKey?: boolean;

  @IsOptional() @IsBoolean() clearSearchKey?: boolean;
}
export class StartAiJobDto {
  @IsOptional() @IsInt() @Min(1) problemId?: number;

  @IsIn(["metadata", "tags", "source", "difficulty", "translate", "tutorial", "testdata", "all", "import"])
  action: AiAction;

  @IsOptional() @IsString() @Length(1, 4096) attachmentToken?: string;

  @IsOptional() @IsInt() @Min(5) @Max(1000) count?: number;

  @IsOptional() @IsString() @Length(0, 500000) markdown?: string;

  @IsOptional() @IsString() @Length(0, 15000000) image?: string;

  @IsOptional() @IsBoolean() automatic?: boolean;

  @IsOptional() @IsIn(["Traditional", "Interaction", "Communication"]) problemType?:
    | "Traditional"
    | "Interaction"
    | "Communication";

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
  @IsOptional() @IsIn(["validate-samples", "std"]) retryFrom?: "validate-samples" | "std";
}

export class AiPrepareAttachmentDto {
  @IsString() @Length(1, 256) filename: string;

  @IsInt() @Min(1) @Max(67108864) size: number;
}
