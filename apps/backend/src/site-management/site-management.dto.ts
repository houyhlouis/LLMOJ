import { ApiProperty } from "@nestjs/swagger";

import { IsIn, ValidateIf } from "class-validator";

import { REGISTRATION_MODES, RegistrationMode } from "../settings/registration-settings.service";

export class SiteManagementSettingsDto {
  @ApiProperty({ enum: [...REGISTRATION_MODES] })
  registrationMode: RegistrationMode;

  @ApiProperty({ enum: [...REGISTRATION_MODES] })
  configuredRegistrationMode: RegistrationMode;

  @ApiProperty()
  usesOverride: boolean;
}

export class UpdateRegistrationModeRequestDto {
  @ApiProperty({ enum: [...REGISTRATION_MODES], nullable: true, description: "Null restores the server YAML mode." })
  @ValidateIf((_object, value) => value !== null)
  @IsIn([...REGISTRATION_MODES])
  registrationMode: RegistrationMode | null;
}
