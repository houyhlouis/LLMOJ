import { ApiProperty } from "@nestjs/swagger";

import { Type } from "class-transformer";
import { IsInt, Min, Length, IsOptional, IsBoolean, ValidateNested } from "class-validator";

import { ProblemFileDto } from "./problem-file.dto";

import { IsValidFilename } from "../../common/validators";
import { FileUploadInfoDto, SignedFileUploadRequestDto } from "../../file/dto";

export class ImportTestDataZipRequestDto {
  @ApiProperty() @IsInt() @Min(1) readonly problemId: number;

  @ApiProperty() @IsValidFilename() @Length(1, 256) readonly filename: string;

  @ApiProperty() @ValidateNested() @Type(() => FileUploadInfoDto) readonly uploadInfo: FileUploadInfoDto;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() readonly replaceExisting?: boolean;
}
export class ArchiveTestcaseDto {
  @ApiProperty() inputFile: string;

  @ApiProperty() outputFile: string;
}
export class ArchiveNameMapDto {
  @ApiProperty() archivePath: string;

  @ApiProperty() filename: string;
}
export class ImportTestDataZipResponseDto {
  @ApiProperty() error?: string;

  @ApiProperty() signedUploadRequest?: SignedFileUploadRequestDto;

  @ApiProperty({ type: [ProblemFileDto] }) importedFiles?: ProblemFileDto[];

  @ApiProperty({ type: [ArchiveTestcaseDto] }) detectedTestcases?: ArchiveTestcaseDto[];

  @ApiProperty({ type: [ArchiveNameMapDto] }) nameMap?: ArchiveNameMapDto[];

  @ApiProperty({ type: [String] }) skippedFiles?: string[];
}
