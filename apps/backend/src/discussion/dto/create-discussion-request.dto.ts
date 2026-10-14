import { ApiProperty } from "@nestjs/swagger";

import { IsEnum, IsInt, IsOptional, IsString, Length } from "class-validator";

import { DiscussionType } from "../discussion-type.enum";

export class CreateDiscussionRequestDto {
  @IsEnum(DiscussionType)
  @IsOptional()
  @ApiProperty({ enum: DiscussionType, required: false })
  type?: DiscussionType;

  @IsInt()
  @IsOptional()
  @ApiProperty()
  problemId?: number;

  @IsString()
  @Length(0, 80)
  @ApiProperty()
  title: string;

  @IsString()
  @ApiProperty()
  content: string;

  @IsString()
  @IsOptional()
  @ApiProperty()
  isPublic?: boolean;
}
