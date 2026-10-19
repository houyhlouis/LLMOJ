import { ApiProperty } from "@nestjs/swagger";

export class MoveSessionToCookieResponseDto {
  // The marker of the session, now kept in the session cookie; absent if the session stays in the header
  @ApiProperty({ required: false })
  token?: string;
}
