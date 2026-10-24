import { ApiProperty } from "@nestjs/swagger";

import { SubmissionStatus } from "@libreoj/judge-protocol";

import { JudgeRuntimeDto } from "../../judge/dto/judge-runtime.dto";
import { TestDataAvailabilityDto } from "../../problem/dto/test-data-availability.dto";

export class SubmissionDataVersionDto {
  @ApiProperty({ description: "The problem's data version number the submission is (being) judged with" })
  version: number;

  @ApiProperty({ description: "Whether the problem's test data and judge settings are still that version" })
  current: boolean;

  @ApiProperty({ type: TestDataAvailabilityDto, description: "Whether its test data is all still there" })
  testData: TestDataAvailabilityDto;
}

export class SubmissionJudgeRuntimeDto extends JudgeRuntimeDto {
  @ApiProperty({ required: false, description: "The judge machine's name now; null if it was deleted" })
  judgeMachine: string;
}

export class SubmissionEarlierResultDto {
  @ApiProperty({ enum: SubmissionStatus })
  status: SubmissionStatus;

  @ApiProperty({ required: false })
  score: number;

  @ApiProperty({ required: false })
  timeUsed: number;

  @ApiProperty({ required: false })
  memoryUsed: number;

  @ApiProperty({ required: false, description: "The data version it was judged with; null if not recorded" })
  dataVersion: number;

  @ApiProperty({
    type: TestDataAvailabilityDto,
    required: false,
    description: "Whether that data version's test data is all still there; absent if not recorded"
  })
  testData?: TestDataAvailabilityDto;

  @ApiProperty({
    type: SubmissionJudgeRuntimeDto,
    required: false,
    description: "What it was judged with; null if not recorded"
  })
  judgeRuntime: SubmissionJudgeRuntimeDto;

  @ApiProperty({ description: "When a rejudge replaced it" })
  replacedAt: Date;
}
