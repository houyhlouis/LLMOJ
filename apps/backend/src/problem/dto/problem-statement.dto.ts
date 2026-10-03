import { ApiProperty } from "@nestjs/swagger";

import {
  Min,
  Max,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
  IsEnum,
  ArrayNotEmpty,
  IsArray,
  ArrayMaxSize,
  IsInt
} from "class-validator";

import { Type } from "class-transformer";

import { ProblemSampleDataMemberDto } from "./problem-sample-data-member.dto";

import { ProblemContentSectionDto } from "./problem-content-section.dto";

import { Locale } from "../../common/locale.type";
import { If } from "../../common/validators";

export class ProblemLocalizedContentDto {
  @ApiProperty()
  @IsEnum(Locale)
  locale: Locale;

  @ApiProperty()
  @IsString()
  @Length(0, 120)
  title: string;

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
  contentSections: ProblemContentSectionDto[];
}

export class ProblemStatementDto {
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

  @ApiProperty({ type: ProblemLocalizedContentDto, isArray: true })
  @ValidateNested({ each: true })
  @Type(() => ProblemLocalizedContentDto)
  @If<ProblemLocalizedContentDto[]>(
    localizedContents =>
      Array.isArray(localizedContents) &&
      new Set(localizedContents.map(localizedContent => localizedContent?.locale)).size === localizedContents.length,
    {
      message: "locale is not unique"
    }
  )
  @If<ProblemLocalizedContentDto[]>(
    localizedContents =>
      Array.isArray(localizedContents) &&
      localizedContents.some(content => typeof content?.title === "string" && content.title.trim().length > 0),
    { message: "a problem title is required in at least one language" }
  )
  @ArrayNotEmpty()
  @IsArray()
  localizedContents: ProblemLocalizedContentDto[];

  @ApiProperty({ type: ProblemSampleDataMemberDto, isArray: true })
  @ValidateNested({ each: true })
  @Type(() => ProblemSampleDataMemberDto)
  @IsArray()
  samples: ProblemSampleDataMemberDto[];

  @ApiProperty({ type: [Number] })
  @IsInt({ each: true })
  @IsArray()
  @ArrayMaxSize(20)
  problemTagIds: number[];
}
