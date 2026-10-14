import { ApiProperty } from "@nestjs/swagger";

export enum CreateDiscussionResponseError {
  SOLUTION_REQUIRES_PROBLEM = "SOLUTION_REQUIRES_PROBLEM",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_PROBLEM = "NO_SUCH_PROBLEM"
}

export class CreateDiscussionResponseDto {
  @ApiProperty()
  error?: CreateDiscussionResponseError;

  @ApiProperty()
  discussionId?: number;
}
