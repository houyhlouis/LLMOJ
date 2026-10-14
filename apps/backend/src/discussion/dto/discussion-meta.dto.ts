import { ApiProperty } from "@nestjs/swagger";

import { DiscussionType } from "../discussion-type.enum";

export class DiscussionMetaDto {
  @ApiProperty({ enum: DiscussionType })
  type: DiscussionType;

  @ApiProperty()
  id: number;

  @ApiProperty()
  title: string;

  @ApiProperty()
  publishTime: Date;

  @ApiProperty()
  editTime: Date;

  @ApiProperty()
  sortTime: Date;

  @ApiProperty()
  replyCount: number;

  @ApiProperty()
  isPublic: boolean;

  @ApiProperty()
  publisherId: number;

  @ApiProperty()
  problemId?: number;
}
