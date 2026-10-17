import { ApiProperty } from "@nestjs/swagger";

export enum DeleteJudgeClientResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_JUDGE_CLIENT = "NO_SUCH_JUDGE_CLIENT",
  REAUTHENTICATION_REQUIRED = "REAUTHENTICATION_REQUIRED"
}

export class DeleteJudgeClientResponseDto {
  @ApiProperty()
  error?: DeleteJudgeClientResponseError;
}
