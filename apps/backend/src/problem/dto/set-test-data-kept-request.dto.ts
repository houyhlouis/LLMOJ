import { ApiProperty } from "@nestjs/swagger";

import { IsBoolean, IsInt, Min } from "class-validator";

export class SetTestDataKeptRequestDto {
  @ApiProperty()
  @IsInt()
  readonly problemId: number;

  @ApiProperty({ description: "The problem's data version number" })
  @IsInt()
  @Min(1)
  readonly version: number;

  @ApiProperty({ description: "true keeps its test data until released; false lets the retention policy decide" })
  @IsBoolean()
  readonly keep: boolean;
}
