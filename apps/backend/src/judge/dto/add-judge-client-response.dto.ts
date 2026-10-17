import { ApiProperty } from "@nestjs/swagger";

import { JudgeClientInfoDto } from "./judge-client-info.dto";

export enum AddJudgeClientResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  REAUTHENTICATION_REQUIRED = "REAUTHENTICATION_REQUIRED"
}

export class AddJudgeClientResponseDto {
  @ApiProperty()
  error?: AddJudgeClientResponseError;

  @ApiProperty()
  judgeClient?: JudgeClientInfoDto;
}
