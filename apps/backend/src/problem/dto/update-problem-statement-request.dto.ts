import { ApiProperty } from "@nestjs/swagger";

import {
  Min,
  Max,
  ValidateNested,
  IsEnum,
  IsString,
  Length,
  IsOptional,
  IsArray,
  ArrayMaxSize,
  IsInt,
  ArrayNotEmpty
} from "class-validator";

import { Type } from "class-transformer";

import { ProblemContentSectionDto } from "./problem-content-section.dto";

import { ProblemSampleDataMemberDto } from "./problem-sample-data-member.dto";

import { Locale } from "../../common/locale.type";
import { If } from "../../common/validators";

export class UpdateProblemRequestUpdatingLocalizedContentDto {
  @ApiProperty()
  @IsEnum(Locale)
  readonly locale: Locale;

  @ApiProperty()
  @IsString()
  @Length(0, 120)
  @IsOptional()
  readonly title: string;

  @ApiProperty({ type: ProblemContentSectionDto, isArray: true })
  @ValidateNested({ each: true })
  @Type(() => ProblemContentSectionDto)
  @IsArray()
  @ArrayMaxSize(120)
  @If<ProblemContentSectionDto[]>(
    sections =>
      Array.isArray(sections) &&
      sections.filter(section => section?.type === "Text").length <= 20 &&
      sections.filter(section => section?.type === "Sample").length <= 100,
    { message: "at most 20 text sections and 100 sample sections are allowed" }
  )
  @IsOptional()
  readonly contentSections: ProblemContentSectionDto[];
}

export class UpdateProblemStatementRequestDto {
  @ApiProperty({ required: false, nullable: true, minimum: 0, maximum: 4000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4000)
  difficulty?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(0, 2048)
  originalProblem?: string;

  @ApiProperty()
  @IsInt()
  readonly problemId: number;

  @ApiProperty({
    type: UpdateProblemRequestUpdatingLocalizedContentDto,
    isArray: true
  })
  @ValidateNested({ each: true })
  @Type(() => UpdateProblemRequestUpdatingLocalizedContentDto)
  @If<UpdateProblemRequestUpdatingLocalizedContentDto[]>(
    updatingLocalizedContents =>
      Array.isArray(updatingLocalizedContents) &&
      new Set(updatingLocalizedContents.map(updatingLocalizedContent => updatingLocalizedContent?.locale)).size ===
        updatingLocalizedContents.length,
    {
      message: "locale is not unique"
    }
  )
  @IsArray()
  @ArrayNotEmpty()
  readonly localizedContents: UpdateProblemRequestUpdatingLocalizedContentDto[];

  @ApiProperty({ type: ProblemSampleDataMemberDto, isArray: true })
  @ValidateNested({ each: true })
  @Type(() => ProblemSampleDataMemberDto)
  @IsArray()
  @IsOptional()
  readonly samples: ProblemSampleDataMemberDto[];

  @ApiProperty({ type: [Number] })
  @IsInt({ each: true })
  @IsArray()
  @ArrayMaxSize(20)
  readonly problemTagIds: number[];
}
