import { ApiProperty } from "@nestjs/swagger";

export enum DownloadProblemStatementResponseError {
  NO_SUCH_PROBLEM = "NO_SUCH_PROBLEM",
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class DownloadProblemStatementResponseDto {
  @ApiProperty()
  error?: DownloadProblemStatementResponseError;

  /** The problem's name as a file name ("A+B Problem.md") */
  @ApiProperty()
  filename?: string;

  @ApiProperty()
  markdown?: string;
}
