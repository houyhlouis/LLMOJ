import { ApiProperty } from "@nestjs/swagger";

import { IsInt, Min } from "class-validator";

export class FakeSubmissionRequestDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  submissionId: number;
}
