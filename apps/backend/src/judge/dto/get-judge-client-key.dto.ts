import { ApiProperty } from "@nestjs/swagger";

import { IsInt } from "class-validator";

export enum GetJudgeClientKeyResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_JUDGE_CLIENT = "NO_SUCH_JUDGE_CLIENT",
  REAUTHENTICATION_REQUIRED = "REAUTHENTICATION_REQUIRED"
}

export class GetJudgeClientKeyRequestDto {
  @ApiProperty()
  @IsInt()
  readonly id: number;
}

export class GetJudgeClientKeyResponseDto {
  @ApiProperty({ enum: GetJudgeClientKeyResponseError, required: false })
  error?: GetJudgeClientKeyResponseError;

  @ApiProperty({ required: false })
  key?: string;
}
