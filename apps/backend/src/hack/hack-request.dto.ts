import { ApiPropertyOptional } from "@nestjs/swagger";

import { IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { Type } from "class-transformer";

export class HackRequestDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) id?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) problemId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) submissionId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) contestId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) hackerId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000000) page?: number;

  @IsOptional() @IsString() @MaxLength(80) hacker?: string;

  @IsOptional() @IsString() @MaxLength(24) status?: string;

  @IsOptional() @IsString() @MaxLength(1048576) inputData?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) referenceSubmissionId?: number;

  @IsOptional() @IsString() @MaxLength(1048576) standardCode?: string;

  @IsOptional() @IsString() @MaxLength(20) standardLanguage?: string;

  @IsOptional() @IsObject() standardCompileAndRunOptions?: Record<string, string>;

  @IsOptional() @IsObject() standardFileIo?: { inputFilename: string; outputFilename: string };

  @IsOptional() @IsString() @MaxLength(1048576) validatorCode?: string;

  @IsOptional() @IsString() @MaxLength(20) validatorLanguage?: string;

  // A query string's "1" or "true" (a body may send a boolean)
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  mine?: boolean | string;
}
