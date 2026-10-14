import { ApiProperty } from "@nestjs/swagger";

export enum FakeSubmissionResponseError {
  NO_SUCH_SUBMISSION = "NO_SUCH_SUBMISSION",
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class FakeSubmissionResponseDto {
  @ApiProperty()
  error?: FakeSubmissionResponseError;
}
