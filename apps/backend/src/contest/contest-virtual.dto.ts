import { ApiProperty } from "@nestjs/swagger";

import { IsInt, Min } from "class-validator";

export class StartVirtualRequestDto {
  @ApiProperty() @IsInt() @Min(1) id: number;
}

export class ContestVirtualRunDto {
  @ApiProperty() startTime: Date;

  @ApiProperty() endTime: Date;
}

export class StartVirtualResponseDto {
  @ApiProperty() run: ContestVirtualRunDto;
}
