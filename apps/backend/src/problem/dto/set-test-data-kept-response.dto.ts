import { ApiProperty } from "@nestjs/swagger";

import { TestDataAvailabilityDto } from "./test-data-availability.dto";

export enum SetTestDataKeptResponseError {
  NO_SUCH_PROBLEM = "NO_SUCH_PROBLEM",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_DATA_VERSION = "NO_SUCH_DATA_VERSION",
  // Some of its test data is already deleted: there's nothing left to keep
  TEST_DATA_DELETED = "TEST_DATA_DELETED"
}

export class SetTestDataKeptResponseDto {
  @ApiProperty({ required: false, enum: SetTestDataKeptResponseError })
  error?: SetTestDataKeptResponseError;

  @ApiProperty({ required: false, type: TestDataAvailabilityDto })
  testData?: TestDataAvailabilityDto;
}
