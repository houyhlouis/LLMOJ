import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Request } from "express";

import { AiPolicyDto, SiteManagementSettingsDto, UpdateRegistrationModeRequestDto } from "./site-management.dto";

import { RegistrationSettingsService } from "../settings/registration-settings.service";
import { AiPolicyService } from "../settings/ai-policy.service";
import { CurrentUser } from "../common/user.decorator";
import { UserEntity } from "../user/user.entity";
import { AuthSessionService } from "../auth/auth-session.service";
import { RequestWithSession } from "../auth/auth.middleware";

@ApiTags("SiteManagement")
@ApiBearerAuth()
@Controller("site-management")
export class SiteManagementController {
  constructor(
    private readonly registrationSettings: RegistrationSettingsService,
    private readonly aiPolicy: AiPolicyService,
    private readonly sessions: AuthSessionService
  ) {}

  /** Site settings change for everyone at once, so administrators confirm their password first. */
  private async confirmAdministrator(user: UserEntity, request: Request): Promise<void> {
    // Others are refused by the settings services, without being asked for a password.
    if (user?.isAdmin)
      await this.sessions.requireRecentAuthentication(user, (request as RequestWithSession)?.session?.sessionId);
  }

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
    await this.confirmAdministrator(user, request);
    return await this.registrationSettings.updateRegistrationMode(user, body.registrationMode, request.ip);
  }

  @Get("getAiPolicy")
  @ApiOperation({ summary: "Get the site's AI pause switch and limits (site administrators only)." })
  async getAiPolicy(@CurrentUser() user: UserEntity): Promise<AiPolicyDto> {
    return await this.aiPolicy.getForAdministrator(user);
  }

  @Post("updateAiPolicy")
  @ApiOperation({ summary: "Pause AI or change its limits, effective immediately (site administrators only)." })
  async updateAiPolicy(
    @CurrentUser() user: UserEntity,
    @Body() body: AiPolicyDto,
    @Req() request: Request
  ): Promise<AiPolicyDto> {
    await this.confirmAdministrator(user, request);
    return await this.aiPolicy.update(user, body, request.ip);
  }
}
