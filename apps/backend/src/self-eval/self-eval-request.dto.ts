import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  IsArray,
  ArrayMaxSize,
  ArrayMinSize
} from "class-validator";
import { Type } from "class-transformer";

export class SelfEvalRequestDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) id?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) problemId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) contestId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) submissionId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;

  @IsOptional() @IsObject() content?: { language: string; code: string; compileAndRunOptions: unknown };

  @IsOptional() @IsString() @MaxLength(1048576) generatorCode?: string;

  @IsOptional() @IsString() @MaxLength(1048576) standardCode?: string;

  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsInt({ each: true }) subtaskIds?: number[];

  @IsOptional() @IsBoolean() attestSameGenerator?: boolean;

  @IsOptional() @IsObject() standardFileIo?: { inputFilename: string; outputFilename: string };
}
