import { ApiProperty } from "@nestjs/swagger";

import { SubmissionMetaDto } from "./submission-meta.dto";
import { SubmissionDataVersionDto, SubmissionEarlierResultDto } from "./submission-judging-data.dto";

import { SubmissionContent } from "../submission-content.interface";
import { SubmissionProgress } from "../submission-progress.interface";

export enum GetSubmissionDetailResponseError {
  NO_SUCH_SUBMISSION = "NO_SUCH_SUBMISSION",
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class GetSubmissionDetailResponseDto {
  @ApiProperty()
  error?: GetSubmissionDetailResponseError;

  @ApiProperty()
  meta?: SubmissionMetaDto;

  @ApiProperty()
  content?: SubmissionContent;

  @ApiProperty()
  progress?: SubmissionProgress;

  @ApiProperty()
  progressSubscriptionKey?: string;

  @ApiProperty()
  permissionRejudge?: boolean;

  @ApiProperty()
  permissionCancel?: boolean;

  @ApiProperty()
  permissionSetPublic?: boolean;

  @ApiProperty()
  permissionDelete?: boolean;

  @ApiProperty()
  permissionFake?: boolean;

  @ApiProperty({
    type: SubmissionDataVersionDto,
    required: false,
    description: "With rejudge permission; absent for submissions from before data versions"
  })
  dataVersion?: SubmissionDataVersionDto;

  @ApiProperty({
    type: [SubmissionEarlierResultDto],
    required: false,
    description: "With rejudge permission: results rejudges replaced, the most recent first"
  })
  earlierResults?: SubmissionEarlierResultDto[];
}
