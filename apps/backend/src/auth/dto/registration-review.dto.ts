import { ApiProperty } from "@nestjs/swagger";

import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

import { RegistrationReviewStatus } from "../registration-review.entity";

export class RegistrationReviewDto {
  @ApiProperty()
  applicationId: number;

  @ApiProperty({ nullable: true })
  userId: number;

  @ApiProperty()
  username: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  registrationTime: Date;

  @ApiProperty({ enum: RegistrationReviewStatus })
  status: RegistrationReviewStatus;

  @ApiProperty({ nullable: true })
  reviewedAt: Date;

  @ApiProperty({ nullable: true })
  reviewedBy: number;

  @ApiProperty({ nullable: true })
  reason: string;
}

export class ListRegistrationReviewsRequestDto {
  @ApiProperty({ enum: RegistrationReviewStatus, required: false })
  @IsOptional()
  @IsEnum(RegistrationReviewStatus)
  status?: RegistrationReviewStatus;

  @ApiProperty({ required: false, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000)
  skipCount?: number = 0;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  takeCount?: number = 20;
}

export enum RegistrationReviewResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_APPLICATION = "NO_SUCH_APPLICATION",
  ALREADY_REVIEWED = "ALREADY_REVIEWED",
  DUPLICATE_USERNAME = "DUPLICATE_USERNAME",
  DUPLICATE_EMAIL = "DUPLICATE_EMAIL"
}

export class ListRegistrationReviewsResponseDto {
  @ApiProperty({ enum: RegistrationReviewResponseError })
  error?: RegistrationReviewResponseError;

  @ApiProperty({ type: [RegistrationReviewDto] })
  reviews?: RegistrationReviewDto[];

  @ApiProperty()
  count?: number;
}

export class ReviewRegistrationRequestDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  applicationId: number;

  @ApiProperty({ enum: [RegistrationReviewStatus.Approved, RegistrationReviewStatus.Rejected] })
  @IsIn([RegistrationReviewStatus.Approved, RegistrationReviewStatus.Rejected])
  decision: RegistrationReviewStatus.Approved | RegistrationReviewStatus.Rejected;

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReviewRegistrationResponseDto {
  @ApiProperty({ enum: RegistrationReviewResponseError })
  error?: RegistrationReviewResponseError;

  @ApiProperty({ type: RegistrationReviewDto })
  review?: RegistrationReviewDto;
}
