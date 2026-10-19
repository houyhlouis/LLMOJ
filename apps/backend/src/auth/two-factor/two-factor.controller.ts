import { Body, Controller, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { TwoFactorError, TwoFactorService, TwoFactorStatus } from "./two-factor.service";
import {
  BeginPasskeyRegistrationResponseDto,
  BeginTotpSetupResponseDto,
  CompleteTwoFactorLoginRequestDto,
  CompleteTwoFactorLoginResponseDto,
  ConfirmTotpSetupRequestDto,
  FinishPasskeyRegistrationRequestDto,
  GetReauthenticationOptionsResponseDto,
  GetTwoFactorStatusRequestDto,
  GetTwoFactorStatusResponseDto,
  ReauthenticateRequestDto,
  RecoveryCodesResponseDto,
  RemovePasskeyRequestDto,
  ResetUserTwoFactorRequestDto,
  TwoFactorActionResponseDto,
  TwoFactorResponseError,
  TwoFactorStatusDto
} from "./two-factor.dto";

import { AuthService } from "../auth.service";
import { AuthSessionService } from "../auth-session.service";
import { RequestWithSession } from "../auth.middleware";
import { RegistrationReviewService } from "../registration-review.service";
import { RegistrationReviewStatus } from "../registration-review.entity";
import { CurrentUser } from "../../common/user.decorator";
import { UserEntity } from "../../user/user.entity";
import { UserService } from "../../user/user.service";
import { UserPrivilegeService, UserPrivilegeType } from "../../user/user-privilege.service";
import { AuditLogObjectType, AuditService } from "../../audit/audit.service";

// The service's errors are a subset of the API's.
const apiError = (error: TwoFactorError) => error as unknown as TwoFactorResponseError;

function statusDto(status: TwoFactorStatus): TwoFactorStatusDto {
  return {
    ...status,
    totpEnabledAt: status.totpEnabledAt ?? undefined,
    passkeys: status.passkeys.map(passkey => ({ ...passkey, lastUsedAt: passkey.lastUsedAt ?? undefined }))
  };
}

@ApiTags("Two Factor")
@Controller("twoFactor")
export class TwoFactorController {
  constructor(
    private readonly twoFactorService: TwoFactorService,
    private readonly authService: AuthService,
    private readonly authSessionService: AuthSessionService,
    private readonly registrationReviews: RegistrationReviewService,
    private readonly userService: UserService,
    private readonly userPrivilegeService: UserPrivilegeService,
    private readonly auditService: AuditService
  ) {}

  /** Changing second factors needs a recent password entry, so a stolen session cannot replace them. */
  private async recentlyAuthenticated(req: RequestWithSession, user: UserEntity): Promise<boolean> {
    return await this.authSessionService.isRecentlyAuthenticated(user?.id, req.session?.sessionId);
  }

  @Post("getStatus")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a user's two-factor sign-in settings (the user's own, or as a user manager)." })
  async getStatus(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: GetTwoFactorStatusRequestDto
  ): Promise<GetTwoFactorStatusResponseDto> {
    if (!currentUser) return { error: TwoFactorResponseError.PERMISSION_DENIED };
    const user = request.userId === currentUser.id ? currentUser : await this.userService.findUserById(request.userId);
    if (!user) return { error: TwoFactorResponseError.NO_SUCH_USER };
    if (
      user.id !== currentUser.id &&
      !(await this.userPrivilegeService.userHasPrivilege(currentUser, UserPrivilegeType.ManageUser))
    )
      return { error: TwoFactorResponseError.PERMISSION_DENIED };
    return { status: statusDto(await this.twoFactorService.getStatus(user.id)) };
  }

  @Post("beginTotpSetup")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Generate an authenticator app secret; it is enabled after confirmTotpSetup." })
  async beginTotpSetup(
    @Req() req: RequestWithSession,
    @CurrentUser() currentUser: UserEntity
  ): Promise<BeginTotpSetupResponseDto> {
    if (!currentUser) return { error: TwoFactorResponseError.PERMISSION_DENIED };
    if (!(await this.recentlyAuthenticated(req, currentUser)))
      return { error: TwoFactorResponseError.REAUTHENTICATION_REQUIRED };
    const result = await this.twoFactorService.beginTotpSetup(currentUser);
    if (result.error) return { error: apiError(result.error) };
    return { secret: result.secret, uri: result.uri };
  }

  @Post("confirmTotpSetup")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Enable the authenticator app with one of its codes. Returns new recovery codes once." })
  async confirmTotpSetup(
    @Req() req: RequestWithSession,
    @CurrentUser() currentUser: UserEntity,
    @Body() request: ConfirmTotpSetupRequestDto
  ): Promise<RecoveryCodesResponseDto> {
    if (!currentUser) return { error: TwoFactorResponseError.PERMISSION_DENIED };
    if (!(await this.recentlyAuthenticated(req, currentUser)))
      return { error: TwoFactorResponseError.REAUTHENTICATION_REQUIRED };
    const result = await this.twoFactorService.confirmTotpSetup(currentUser, request.code);
    if (result.error) return { error: apiError(result.error) };
    await this.auditService.log("auth.two_factor.enable_totp");
    return { recoveryCodes: result.recoveryCodes ?? undefined };
  }

  @Post("disableTotp")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Remove the authenticator app." })
  async disableTotp(
    @Req() req: RequestWithSession,
    @CurrentUser() currentUser: UserEntity
  ): Promise<TwoFactorActionResponseDto> {
    if (!currentUser) return { error: TwoFactorResponseError.PERMISSION_DENIED };
    if (!(await this.recentlyAuthenticated(req, currentUser)))
      return { error: TwoFactorResponseError.REAUTHENTICATION_REQUIRED };
    const result = await this.twoFactorService.disableTotp(currentUser.id);
    if (result.error) return { error: apiError(result.error) };
    await this.auditService.log("auth.two_factor.disable_totp");
    return {};
  }

  @Post("beginPasskeyRegistration")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Options for navigator.credentials.create() to add a passkey." })
  async beginPasskeyRegistration(
    @Req() req: RequestWithSession,
    @CurrentUser() currentUser: UserEntity
  ): Promise<BeginPasskeyRegistrationResponseDto> {
    if (!currentUser) return { error: TwoFactorResponseError.PERMISSION_DENIED };
    if (!(await this.recentlyAuthenticated(req, currentUser)))
      return { error: TwoFactorResponseError.REAUTHENTICATION_REQUIRED };
    const result = await this.twoFactorService.beginPasskeyRegistration(currentUser, req.headers.origin);
    if (result.error) return { error: apiError(result.error) };
    return { options: result.options as Record<string, unknown> };
  }

  @Post("finishPasskeyRegistration")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Add the passkey created by navigator.credentials.create()." })
  async finishPasskeyRegistration(
    @Req() req: RequestWithSession,
    @CurrentUser() currentUser: UserEntity,
    @Body() request: FinishPasskeyRegistrationRequestDto
  ): Promise<RecoveryCodesResponseDto> {
    if (!currentUser) return { error: TwoFactorResponseError.PERMISSION_DENIED };
    if (!(await this.recentlyAuthenticated(req, currentUser)))
      return { error: TwoFactorResponseError.REAUTHENTICATION_REQUIRED };
    const result = await this.twoFactorService.finishPasskeyRegistration(
      currentUser,
      req.headers.origin,
      request.name.trim() || "Passkey",
      request.credential
    );
    if (result.error) return { error: apiError(result.error) };
    await this.auditService.log("auth.two_factor.add_passkey", { name: request.name });
    return { recoveryCodes: result.recoveryCodes ?? undefined };
  }

  @Post("removePasskey")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Remove one of the current user's passkeys." })
  async removePasskey(
    @Req() req: RequestWithSession,
    @CurrentUser() currentUser: UserEntity,
    @Body() request: RemovePasskeyRequestDto
  ): Promise<TwoFactorActionResponseDto> {
    if (!currentUser) return { error: TwoFactorResponseError.PERMISSION_DENIED };
    if (!(await this.recentlyAuthenticated(req, currentUser)))
      return { error: TwoFactorResponseError.REAUTHENTICATION_REQUIRED };
    const result = await this.twoFactorService.removePasskey(currentUser.id, request.id);
    if (result.error) return { error: apiError(result.error) };
    await this.auditService.log("auth.two_factor.remove_passkey", { id: request.id });
    return {};
  }

  @Post("regenerateRecoveryCodes")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Replace all recovery codes. Returns the new codes once." })
  async regenerateRecoveryCodes(
    @Req() req: RequestWithSession,
    @CurrentUser() currentUser: UserEntity
  ): Promise<RecoveryCodesResponseDto> {
    if (!currentUser) return { error: TwoFactorResponseError.PERMISSION_DENIED };
    if (!(await this.recentlyAuthenticated(req, currentUser)))
      return { error: TwoFactorResponseError.REAUTHENTICATION_REQUIRED };
    const result = await this.twoFactorService.regenerateRecoveryCodes(currentUser.id);
    if (result.error) return { error: apiError(result.error) };
    await this.auditService.log("auth.two_factor.new_recovery_codes");
    return { recoveryCodes: result.recoveryCodes };
  }

  @Post("resetUserTwoFactor")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Remove all second factors of a user who lost them (user managers only)." })
  async resetUserTwoFactor(
    @Req() req: RequestWithSession,
    @CurrentUser() currentUser: UserEntity,
    @Body() request: ResetUserTwoFactorRequestDto
  ): Promise<TwoFactorActionResponseDto> {
    if (!currentUser) return { error: TwoFactorResponseError.PERMISSION_DENIED };
    const user = await this.userService.findUserById(request.userId);
    if (!user) return { error: TwoFactorResponseError.NO_SUCH_USER };
    if (
      !(await this.userPrivilegeService.userHasPrivilege(currentUser, UserPrivilegeType.ManageUser)) ||
      (user.isAdmin && !currentUser.isAdmin)
    )
      return { error: TwoFactorResponseError.PERMISSION_DENIED };
    if (!(await this.recentlyAuthenticated(req, currentUser)))
      return { error: TwoFactorResponseError.REAUTHENTICATION_REQUIRED };
    await this.twoFactorService.reset(user.id);
    await this.auditService.log("auth.two_factor.reset_by_manager", AuditLogObjectType.User, user.id);
    return {};
  }

  @Post("completeLogin")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Finish signing in with the second factor for the challenge returned by login." })
  async completeLogin(
    @Req() req: RequestWithSession,
    @CurrentUser() currentUser: UserEntity,
    @Body() request: CompleteTwoFactorLoginRequestDto
  ): Promise<CompleteTwoFactorLoginResponseDto> {
    if (currentUser) return { error: TwoFactorResponseError.ALREADY_LOGGEDIN };
    const result = await this.twoFactorService.verifyChallenge(request.challenge, req.headers.origin, request);
    if (result.error) return { error: apiError(result.error) };
    const user = await this.userService.findUserById(result.userId);
    if (!user) return { error: TwoFactorResponseError.NO_SUCH_USER };
    const registrationStatus = await this.registrationReviews.status(user);
    if (registrationStatus === RegistrationReviewStatus.Pending)
      return { error: TwoFactorResponseError.REGISTRATION_PENDING };
    if (registrationStatus === RegistrationReviewStatus.Rejected)
      return { error: TwoFactorResponseError.REGISTRATION_REJECTED };
    const method = request.passkey ? "passkey" : request.recoveryCode ? "recoveryCode" : "totp";
    await this.auditService.log(user.id, "auth.login", { twoFactor: method });
    return {
      token: await this.authSessionService.issueSession(user, req),
      username: user.username
    };
  }

  @Post("getReauthenticationOptions")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Start re-entering credentials for a sensitive change; includes a 2FA challenge if used." })
  async getReauthenticationOptions(
    @Req() req: RequestWithSession,
    @CurrentUser() currentUser: UserEntity
  ): Promise<GetReauthenticationOptionsResponseDto> {
    if (!currentUser) return { error: TwoFactorResponseError.PERMISSION_DENIED };
    if (!(await this.twoFactorService.isEnabled(currentUser.id))) return {};
    return { twoFactor: await this.twoFactorService.createChallenge(currentUser.id, req.headers.origin) };
  }

  @Post("reauthenticate")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Confirm the password (and second factor) to allow sensitive changes for a few minutes." })
  async reauthenticate(
    @Req() req: RequestWithSession,
    @CurrentUser() currentUser: UserEntity,
    @Body() request: ReauthenticateRequestDto
  ): Promise<TwoFactorActionResponseDto> {
    if (!currentUser || !req.session?.sessionId) return { error: TwoFactorResponseError.PERMISSION_DENIED };
    if (await this.twoFactorService.failureLimitReached(currentUser.id))
      return { error: TwoFactorResponseError.TOO_MANY_ATTEMPTS };
    const userAuth = await this.authService.findUserAuthByUserId(currentUser.id);
    if (
      !userAuth ||
      !this.authService.checkUserMigrated(userAuth) ||
      !(await this.authService.checkPassword(userAuth, request.password))
    ) {
      await this.twoFactorService.recordFailure(currentUser.id);
      await this.auditService.log("auth.reauthenticate_failed");
      return { error: TwoFactorResponseError.WRONG_PASSWORD };
    }
    if (await this.twoFactorService.isEnabled(currentUser.id)) {
      if (!request.challenge) return { error: TwoFactorResponseError.CHALLENGE_EXPIRED };
      const result = await this.twoFactorService.verifyChallenge(request.challenge, req.headers.origin, request);
      if (result.error) return { error: apiError(result.error) };
      if (result.userId !== currentUser.id) return { error: TwoFactorResponseError.CHALLENGE_EXPIRED };
    }
    await this.authSessionService.markRecentlyAuthenticated(currentUser.id, req.session.sessionId);
    await this.auditService.log("auth.reauthenticate");
    return {};
  }
}
