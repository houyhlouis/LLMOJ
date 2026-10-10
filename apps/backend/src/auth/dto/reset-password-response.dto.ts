import { ApiProperty } from "@nestjs/swagger";

export enum ResetPasswordResponseError {
  REGISTRATION_PENDING = "REGISTRATION_PENDING",
  REGISTRATION_REJECTED = "REGISTRATION_REJECTED",
  ALREADY_LOGGEDIN = "ALREADY_LOGGEDIN",
  NO_SUCH_USER = "NO_SUCH_USER",
  INVALID_EMAIL_VERIFICATION_CODE = "INVALID_EMAIL_VERIFICATION_CODE"
}

export class ResetPasswordResponseDto {
  @ApiProperty({ enum: ResetPasswordResponseError })
  error?: ResetPasswordResponseError;

  @ApiProperty()
  token?: string;
}
