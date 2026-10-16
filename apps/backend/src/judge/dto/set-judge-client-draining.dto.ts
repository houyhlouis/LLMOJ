import { ApiProperty } from "@nestjs/swagger";

import { IsBoolean, IsInt } from "class-validator";

export enum SetJudgeClientDrainingResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_JUDGE_CLIENT = "NO_SUCH_JUDGE_CLIENT"
}

export class SetJudgeClientDrainingRequestDto {
  @ApiProperty()
  @IsInt()
  readonly id: number;

  @ApiProperty({ description: "true: send it no new tasks; false: resume" })
  @IsBoolean()
  readonly draining: boolean;
}

export class SetJudgeClientDrainingResponseDto {
  @ApiProperty({ enum: SetJudgeClientDrainingResponseError, required: false })
  error?: SetJudgeClientDrainingResponseError;
}
