import { ApiProperty } from "@nestjs/swagger";

export enum GetJudgeQueueStatusResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class JudgeJobInfoDto {
  @ApiProperty()
  taskId: string;

  @ApiProperty({ description: "Submission, Hack, SelfEvalPrepare or SelfEval" })
  type: string;

  @ApiProperty({ enum: ["Queued", "Leased", "Failed"] })
  state: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ required: false, description: "The judge client of the current or last lease" })
  judgeClientId?: number;

  @ApiProperty({ description: "How many times the task has been sent to a judge client" })
  fence: number;

  @ApiProperty({ description: "Leases that ended without a result" })
  unfinishedLeases: number;

  @ApiProperty()
  preparationFailures: number;

  @ApiProperty({ required: false })
  lastError?: string;

  @ApiProperty({ required: false })
  finishedAt?: Date;
}

export class JudgeQueueStatusDto {
  @ApiProperty()
  queued: number;

  @ApiProperty({ description: "Being judged" })
  leased: number;

  @ApiProperty({ description: "Given up on in the last 7 days" })
  failedRecently: number;

  @ApiProperty({ required: false })
  oldestQueuedAt?: Date;

  @ApiProperty({ type: [JudgeJobInfoDto], description: "Up to 100: being judged, queued, then failed" })
  jobs: JudgeJobInfoDto[];
}

export class GetJudgeQueueStatusResponseDto {
  @ApiProperty({ enum: GetJudgeQueueStatusResponseError, required: false })
  error?: GetJudgeQueueStatusResponseError;

  @ApiProperty({ type: JudgeQueueStatusDto, required: false })
  status?: JudgeQueueStatusDto;
}
