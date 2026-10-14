import { ApiProperty } from "@nestjs/swagger";

import { IsBoolean, IsEnum, IsInt, IsOptional, Length, Min } from "class-validator";

import { Locale } from "../../common/locale.type";
import { DiscussionType } from "../discussion-type.enum";

export class QueryDiscussionsRequestDto {
  @ApiProperty({ enum: DiscussionType, required: false })
  @IsEnum(DiscussionType)
  @IsOptional()
  type?: DiscussionType;

  @ApiProperty({ enum: Locale })
  @IsEnum(Locale)
  locale: Locale;

  @ApiProperty()
  @Length(0, 100)
  @IsOptional()
  keyword?: string;

  @ApiProperty({ description: "`null` for global. `-1` for all problems. `-2` for global and problem discussions." })
  @IsInt()
  @IsOptional()
  problemId?: number;

  @ApiProperty()
  @IsInt()
  @IsOptional()
  publisherId?: number;

  @ApiProperty()
  @IsBoolean()
  @IsOptional()
  nonpublic?: boolean;

  @ApiProperty({
    description: "Pass true to return discussion title only. For a preview in search bar."
  })
  @IsBoolean()
  @IsOptional()
  titleOnly?: boolean;

  @ApiProperty()
  @IsInt()
  @Min(0)
  skipCount: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  takeCount: number;
}
