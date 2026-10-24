import { ApiProperty } from "@nestjs/swagger";

import { TestDataRetentionReasonKind, TestDataState } from "../test-data-retention.service";

/** Whether a data version's test data is all still there, so its results can be judged again with the same data. */
export class TestDataAvailabilityDto {
  @ApiProperty({
    enum: TestDataState,
    description:
      "InUse: the problem uses all of it; Retained: some was removed from the problem but is kept; Deleted: some is " +
      "gone, so results judged with it can't be judged again with the same data"
  })
  state: TestDataState;

  @ApiProperty({
    required: false,
    description: "Retained: when the first of its removed files may be deleted; absent while kept as long as needed"
  })
  retainedUntil?: Date;

  @ApiProperty({ required: false, description: "Retained: the next cleanup, within ten minutes, deletes some of it" })
  deletionDue?: boolean;

  @ApiProperty({ required: false, enum: TestDataRetentionReasonKind, isArray: true, description: "Retained: why" })
  reasons?: TestDataRetentionReasonKind[];

  @ApiProperty({ required: false, description: "Who chose to keep it until released; absent if nobody did" })
  keptBy?: string;

  @ApiProperty({ required: false })
  keptAt?: Date;
}
