import { ApiProperty } from "@nestjs/swagger";

import { Locale } from "../../common/locale.type";

import { ProblemType } from "../problem.entity";

export class ProblemMetaDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  displayId?: number;

  @ApiProperty()
  type: ProblemType;

  @ApiProperty()
  isPublic: boolean;

  @ApiProperty()
  publicTime: Date;

  @ApiProperty()
  ownerId: number;

  @ApiProperty({ enum: Locale, isArray: true })
  locales: Locale[];

  @ApiProperty({ nullable: true })
  difficulty: number;

  @ApiProperty()
  originalProblem: string;

  @ApiProperty()
  originalProblemTitle?: string;

  @ApiProperty()
  originalProblemLabel?: string;

  @ApiProperty()
  submissionCount?: number;

  @ApiProperty()
  acceptedSubmissionCount?: number;
}
