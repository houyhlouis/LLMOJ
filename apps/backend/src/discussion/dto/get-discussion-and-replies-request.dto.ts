import { ApiProperty } from "@nestjs/swagger";

import { IsBoolean, IsEnum, IsInt, IsOptional, Min } from "class-validator";

import { Locale } from "../../common/locale.type";

export enum GetDiscussionAndRepliesRequestQueryRepliesType {
  HeadTail = "HeadTail",
  IdRange = "IdRange"
}

export class GetDiscussionAndRepliesRequestDto {
  @IsEnum(Locale)
  @ApiProperty()
  locale: Locale;

  @IsInt()
  @ApiProperty()
  discussionId: number;

  @IsEnum(GetDiscussionAndRepliesRequestQueryRepliesType)
  @IsOptional()
  @ApiProperty({
    description: "`HeadTail` is for the first query of a discussion page while `IdRange` is for loading the ramaining."
  })
  queryRepliesType?: GetDiscussionAndRepliesRequestQueryRepliesType;

  @IsBoolean()
  @IsOptional()
  @ApiProperty()
  getDiscussion?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @ApiProperty({
    required: false,
    description: "Only valid for `queryRepliesType` = `HeadTail`. Omitted means no replies from this end."
  })
  headTakeCount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @ApiProperty({
    required: false,
    description: "Only valid for `queryRepliesType` = `HeadTail`. Omitted means no replies from this end."
  })
  tailTakeCount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiProperty({ description: "Only valid for `type` = `IdRange`." })
  beforeId?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @ApiProperty({ description: "Only valid for `type` = `IdRange`." })
  afterId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @ApiProperty({
    required: false,
    description: "Only valid for `queryRepliesType` = `IdRange`. Omitted means no replies."
  })
  idRangeTakeCount?: number;
}
