import { ApiProperty } from "@nestjs/swagger";

import { IsInt } from "class-validator";

export class GetProblemTagDetailRequestDto {
  @ApiProperty()
  @IsInt()
  id: number;
}
