import { ApiProperty } from "@nestjs/swagger";

import { SubmissionStatus } from "@libreoj/judge-protocol";

export class SubmissionDataVersionDto {
  @ApiProperty({ description: "The problem's data version number the submission is (being) judged with" })
  version: number;

  @ApiProperty({ description: "Whether the problem's test data and judge settings are still that version" })
  current: boolean;
}

export class SubmissionEarlierResultDto {
  @ApiProperty({ enum: SubmissionStatus })
  status: SubmissionStatus;

  @ApiProperty({ required: false })
  score: number;

  @ApiProperty({ required: false })
  timeUsed: number;

  @ApiProperty({ required: false })
  memoryUsed: number;

  @ApiProperty({ required: false, description: "The data version it was judged with; null if not recorded" })
  dataVersion: number;

  @ApiProperty({ description: "When a rejudge replaced it" })
  replacedAt: Date;
}
