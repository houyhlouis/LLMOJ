import { ApiProperty } from "@nestjs/swagger";

import { Type } from "class-transformer";
import { ArrayMaxSize, IsInt, IsOptional, IsString, Length, Matches, MaxLength, ValidateNested } from "class-validator";

export enum TwoFactorResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_USER = "NO_SUCH_USER",
  ALREADY_LOGGEDIN = "ALREADY_LOGGEDIN",
  REAUTHENTICATION_REQUIRED = "REAUTHENTICATION_REQUIRED",
  WRONG_PASSWORD = "WRONG_PASSWORD",
  REGISTRATION_PENDING = "REGISTRATION_PENDING",
  REGISTRATION_REJECTED = "REGISTRATION_REJECTED",
  ALREADY_ENABLED = "ALREADY_ENABLED",
  NOT_ENABLED = "NOT_ENABLED",
  SETUP_EXPIRED = "SETUP_EXPIRED",
  INVALID_CODE = "INVALID_CODE",
  INVALID_PASSKEY = "INVALID_PASSKEY",
  PASSKEY_UNAVAILABLE = "PASSKEY_UNAVAILABLE",
  TOO_MANY_PASSKEYS = "TOO_MANY_PASSKEYS",
  NO_SUCH_PASSKEY = "NO_SUCH_PASSKEY",
  CHALLENGE_EXPIRED = "CHALLENGE_EXPIRED",
  TOO_MANY_ATTEMPTS = "TOO_MANY_ATTEMPTS"
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export class PasskeyInfoDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: "The site domain the passkey works on." })
  rpId: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ required: false })
  lastUsedAt?: Date;
}

export class TwoFactorStatusDto {
  @ApiProperty()
  enabled: boolean;

  @ApiProperty()
  totp: boolean;

  @ApiProperty({ required: false })
  totpEnabledAt?: Date;

  @ApiProperty()
  recoveryCodesRemaining: number;

  @ApiProperty({ type: PasskeyInfoDto, isArray: true })
  passkeys: PasskeyInfoDto[];
}

export class TwoFactorChallengeDto {
  @ApiProperty({ description: "Single-use, expires after 5 minutes." })
  token: string;

  @ApiProperty({ enum: ["totp", "passkey", "recoveryCode"], isArray: true })
  methods: ("totp" | "passkey" | "recoveryCode")[];

  @ApiProperty({ required: false, description: "PublicKeyCredentialRequestOptions with base64url binary fields." })
  passkey?: Record<string, unknown>;
}

export class GetTwoFactorStatusRequestDto {
  @ApiProperty()
  @IsInt()
  readonly userId: number;
}

export class GetTwoFactorStatusResponseDto {
  @ApiProperty({ enum: TwoFactorResponseError })
  error?: TwoFactorResponseError;

  @ApiProperty({ required: false })
  status?: TwoFactorStatusDto;
}

export class TwoFactorActionResponseDto {
  @ApiProperty({ enum: TwoFactorResponseError })
  error?: TwoFactorResponseError;
}

export class RecoveryCodesResponseDto {
  @ApiProperty({ enum: TwoFactorResponseError })
  error?: TwoFactorResponseError;

  @ApiProperty({ required: false, description: "Shown once: only hashes are stored." })
  recoveryCodes?: string[];
}

export class BeginTotpSetupResponseDto {
  @ApiProperty({ enum: TwoFactorResponseError })
  error?: TwoFactorResponseError;

  @ApiProperty({ required: false })
  secret?: string;

  @ApiProperty({ required: false, description: "otpauth:// URI for authenticator apps" })
  uri?: string;
}

export class ConfirmTotpSetupRequestDto {
  @ApiProperty()
  @IsString()
  @Matches(/^\d{6}$/)
  readonly code: string;
}

export class BeginPasskeyRegistrationResponseDto {
  @ApiProperty({ enum: TwoFactorResponseError })
  error?: TwoFactorResponseError;

  @ApiProperty({ required: false, description: "PublicKeyCredentialCreationOptions with base64url binary fields." })
  options?: Record<string, unknown>;
}

export class PasskeyRegistrationDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1400)
  @Matches(BASE64URL)
  readonly id: string;

  @ApiProperty()
  @IsString()
  @MaxLength(8192)
  @Matches(BASE64URL)
  readonly clientDataJSON: string;

  @ApiProperty()
  @IsString()
  @MaxLength(65536)
  @Matches(BASE64URL)
  readonly attestationObject: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  readonly transports?: string[];
}

export class FinishPasskeyRegistrationRequestDto {
  @ApiProperty()
  @IsString()
  @Length(1, 80)
  readonly name: string;

  @ApiProperty()
  @ValidateNested()
  @Type(() => PasskeyRegistrationDto)
  readonly credential: PasskeyRegistrationDto;
}

export class RemovePasskeyRequestDto {
  @ApiProperty()
  @IsInt()
  readonly id: number;
}

export class ResetUserTwoFactorRequestDto {
  @ApiProperty()
  @IsInt()
  readonly userId: number;
}

export class PasskeyAssertionDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1400)
  @Matches(BASE64URL)
  readonly id: string;

  @ApiProperty()
  @IsString()
  @MaxLength(8192)
  @Matches(BASE64URL)
  readonly clientDataJSON: string;

  @ApiProperty()
  @IsString()
  @MaxLength(8192)
  @Matches(BASE64URL)
  readonly authenticatorData: string;

  @ApiProperty()
  @IsString()
  @MaxLength(2048)
  @Matches(BASE64URL)
  readonly signature: string;
}

/** Exactly one second factor. */
export class TwoFactorProofDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  readonly totpCode?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  readonly recoveryCode?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @ValidateNested()
  @Type(() => PasskeyAssertionDto)
  readonly passkey?: PasskeyAssertionDto;
}

export class CompleteTwoFactorLoginRequestDto extends TwoFactorProofDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  readonly challenge: string;
}

export class CompleteTwoFactorLoginResponseDto {
  @ApiProperty({ enum: TwoFactorResponseError })
  error?: TwoFactorResponseError;

  @ApiProperty({ required: false })
  token?: string;

  @ApiProperty({ required: false })
  username?: string;
}

export class GetReauthenticationOptionsResponseDto {
  @ApiProperty({ enum: TwoFactorResponseError })
  error?: TwoFactorResponseError;

  @ApiProperty({
    required: false,
    type: TwoFactorChallengeDto,
    description: "Present when the account uses two-factor sign-in."
  })
  twoFactor?: TwoFactorChallengeDto;
}

export class ReauthenticateRequestDto extends TwoFactorProofDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  readonly password: string;

  @ApiProperty({ required: false, description: "The challenge from getReauthenticationOptions, with 2FA." })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly challenge?: string;
}
