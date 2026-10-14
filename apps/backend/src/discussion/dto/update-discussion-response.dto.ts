import { ApiProperty } from "@nestjs/swagger";

export enum UpdateDiscussionResponseError {
  SOLUTION_REQUIRES_PROBLEM = "SOLUTION_REQUIRES_PROBLEM",
  NO_SUCH_PROBLEM = "NO_SUCH_PROBLEM",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_DISCUSSION = "NO_SUCH_DISCUSSION"
}

export class UpdateDiscussionResponseDto {
  @ApiProperty()
  error?: UpdateDiscussionResponseError;
}
