import { ApiPropertyOptional } from "@nestjs/swagger";

import { IsInt, IsObject, IsOptional, Min, Max } from "class-validator";

import type { SubmissionContent } from "../submission/submission-content.interface";
import type { FileUploadInfoDto } from "../file/dto";
import type { Locale } from "../common/locale.type";

export interface ContestRequestData {
  title?: string;
  subtitle?: string;
  description?: string;
  rule?: string;
  startTime?: string;
  endTime?: string;
  isPublic?: boolean;
  hideStatistics?: boolean;
  adminIds?: number[];
  languages?: string[];
  position?: number;
  weight?: number;
  subtaskAllOrNothing?: boolean;
  inputFilename?: string;
  outputFilename?: string;
  filename?: string;
  uploadInfo?: FileUploadInfoDto;
  fileSize?: number;
  content?: SubmissionContent | string;
  problemId?: number;
  userId?: number;
  locale?: Locale;
  problems?: Array<{ contestProblemId: number; content: string; minutes: number }>;
}

export class ContestRequestDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) id?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) problemId?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) submissionId?: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(100000) page?: number;

  @ApiPropertyOptional() @IsOptional() @IsObject() data?: ContestRequestData;
}
