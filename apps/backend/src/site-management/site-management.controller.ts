import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Request } from "express";

import { SiteManagementSettingsDto, UpdateRegistrationModeRequestDto } from "./site-management.dto";

import { RegistrationSettingsService } from "../settings/registration-settings.service";
import { CurrentUser } from "../common/user.decorator";
import { UserEntity } from "../user/user.entity";

@ApiTags("SiteManagement")
@ApiBearerAuth()
@Controller("site-management")
export class SiteManagementController {
  constructor(private readonly registrationSettings: RegistrationSettingsService) {}

  @Get("getSettings")
  @ApiOperation({ summary: "Get the effective registration mode and its source (site administrators only)." })
  async getSettings(@CurrentUser() user: UserEntity): Promise<SiteManagementSettingsDto> {
    return await this.registrationSettings.getForAdministrator(user);
  }

  @Post("updateRegistrationMode")
  @ApiOperation({ summary: "Change registration mode immediately or restore YAML (site administrators only)." })
  async updateRegistrationMode(
    @CurrentUser() user: UserEntity,
    @Body() body: UpdateRegistrationModeRequestDto,
    @Req() request: Request
  ): Promise<SiteManagementSettingsDto> {
    return await this.registrationSettings.updateRegistrationMode(user, body.registrationMode, request.ip);
  }
}
