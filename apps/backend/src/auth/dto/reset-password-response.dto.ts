import { ApiProperty } from "@nestjs/swagger";

import { TwoFactorChallengeDto } from "../two-factor/two-factor.dto";

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

  // The password was reset; sign-in continues with twoFactor/completeLogin.
  @ApiProperty({ required: false })
  twoFactorChallenge?: TwoFactorChallengeDto;
}
