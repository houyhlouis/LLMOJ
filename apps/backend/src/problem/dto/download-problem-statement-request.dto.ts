import { ApiProperty } from "@nestjs/swagger";

import { IsEnum, IsInt } from "class-validator";

import { Locale } from "../../common/locale.type";

export class DownloadProblemStatementRequestDto {
  @ApiProperty()
  @IsInt()
  readonly problemId: number;

  /** The statement's language; the problem's first language when it has none in this one. Also the labels'. */
  @ApiProperty({ enum: Locale })
  @IsEnum(Locale)
  readonly locale: Locale;
}
