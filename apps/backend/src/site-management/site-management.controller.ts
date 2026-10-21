import { Body, Controller, Get, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Request } from "express";

import {
  AiEndpointPolicyDto,
  AiPolicyDto,
  JudgePolicyDto,
  SiteManagementSettingsDto,
  UpdateRegistrationModeRequestDto
} from "./site-management.dto";

import { RegistrationSettingsService } from "../settings/registration-settings.service";
import { AiPolicyService } from "../settings/ai-policy.service";
import { JudgePolicyService } from "../settings/judge-policy.service";
import { AiEndpointPolicyService } from "../settings/ai-endpoint-policy.service";
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
    private readonly judgePolicy: JudgePolicyService,
    private readonly aiEndpoints: AiEndpointPolicyService,
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

  @Get("getJudgePolicy")
  @ApiOperation({ summary: "Get how judge machines choose their tasks (site administrators only)." })
  async getJudgePolicy(@CurrentUser() user: UserEntity): Promise<JudgePolicyDto> {
    return await this.judgePolicy.getForAdministrator(user);
  }

  @Post("updateJudgePolicy")
  @ApiOperation({ summary: "Change how judge machines choose their tasks, within seconds (site administrators only)." })
  async updateJudgePolicy(
    @CurrentUser() user: UserEntity,
    @Body() body: JudgePolicyDto,
    @Req() request: Request
  ): Promise<JudgePolicyDto> {
    await this.confirmAdministrator(user, request);
    return await this.judgePolicy.update(user, body, request.ip);
  }

  @Get("getAiEndpointPolicy")
  @ApiOperation({ summary: "Get the approved AI addresses and whether others may be used (site administrators only)." })
  async getAiEndpointPolicy(@CurrentUser() user: UserEntity): Promise<AiEndpointPolicyDto> {
    return await this.aiEndpoints.getForAdministrator(user);
  }

  @Post("updateAiEndpointPolicy")
  @ApiOperation({ summary: "Change the approved AI addresses, effective within seconds (site administrators only)." })
  async updateAiEndpointPolicy(
    @CurrentUser() user: UserEntity,
    @Body() body: AiEndpointPolicyDto,
    @Req() request: Request
  ): Promise<AiEndpointPolicyDto> {
    await this.confirmAdministrator(user, request);
    return await this.aiEndpoints.update(user, body, request.ip);
  }
}
