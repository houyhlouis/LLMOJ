import { ApiProperty } from "@nestjs/swagger";

export enum SetUserPrivilegesResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_USER = "NO_SUCH_USER",
  FAILED = "FAILED",
  REAUTHENTICATION_REQUIRED = "REAUTHENTICATION_REQUIRED"
}

export class SetUserPrivilegesResponseDto {
  @ApiProperty({ enum: SetUserPrivilegesResponseError })
  error?: SetUserPrivilegesResponseError;
}
