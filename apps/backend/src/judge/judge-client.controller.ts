import { Controller, Post, Body, Get, Req } from "@nestjs/common";
import { ApiOperation, ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { JudgeClientService } from "./judge-client.service";
import { JudgeQueueService } from "./judge-queue.service";

import {
  AddJudgeClientRequestDto,
  AddJudgeClientResponseDto,
  AddJudgeClientResponseError,
  DeleteJudgeClientRequestDto,
  DeleteJudgeClientResponseDto,
  DeleteJudgeClientResponseError,
  GetJudgeClientKeyRequestDto,
  GetJudgeClientKeyResponseDto,
  GetJudgeClientKeyResponseError,
  GetJudgeQueueStatusResponseDto,
  GetJudgeQueueStatusResponseError,
  ListJudgeClientsResponseDto,
  ResetJudgeClientKeyRequestDto,
  ResetJudgeClientKeyResponseDto,
  ResetJudgeClientKeyResponseError,
  SetJudgeClientDrainingRequestDto,
  SetJudgeClientDrainingResponseDto,
  SetJudgeClientDrainingResponseError
} from "./dto";

import { CurrentUser } from "../common/user.decorator";
import { UserEntity } from "../user/user.entity";
import { AuditService } from "../audit/audit.service";
import { AuthSessionService } from "../auth/auth-session.service";
import { RequestWithSession } from "../auth/auth.middleware";

@ApiTags("Judge Client")
@Controller("judgeClient")
export class JudgeClientController {
  constructor(
    private readonly judgeClientService: JudgeClientService,
    private readonly judgeQueueService: JudgeQueueService,
    private readonly auditService: AuditService,
    private readonly authSessionService: AuthSessionService
  ) {}

  /** A judge key lets a machine receive test data and report results, so issuing or showing one needs the password. */
  private async recentlyAuthenticated(req: RequestWithSession, user: UserEntity): Promise<boolean> {
    return await this.authSessionService.isRecentlyAuthenticated(user.id, req.session?.sessionId);
  }

  @ApiOperation({
    summary: "Add a new judge client."
  })
  @ApiBearerAuth()
  @Post("addJudgeClient")
  async addJudgeClient(
    @Req() req: RequestWithSession,
    @CurrentUser() user: UserEntity,
    @Body() request: AddJudgeClientRequestDto
  ): Promise<AddJudgeClientResponseDto> {
    if (!user || !user.isAdmin)
      return {
        error: AddJudgeClientResponseError.PERMISSION_DENIED
      };
    if (!(await this.recentlyAuthenticated(req, user)))
      return { error: AddJudgeClientResponseError.REAUTHENTICATION_REQUIRED };

    const judgeClient = await this.judgeClientService.addJudgeClient(request.name, request.allowedHosts);
    await this.auditService.log("judge_client.add", { judgeClientId: judgeClient.id, name: judgeClient.name });

    return {
      judgeClient: await this.judgeClientService.getJudgeClientInfo(judgeClient, true)
    };
  }

  @ApiOperation({
    summary: "Delete a judge client."
  })
  @ApiBearerAuth()
  @Post("deleteJudgeClient")
  async deleteJudgeClient(
    @Req() req: RequestWithSession,
    @CurrentUser() user: UserEntity,
    @Body() request: DeleteJudgeClientRequestDto
  ): Promise<DeleteJudgeClientResponseDto> {
    if (!user || !user.isAdmin)
      return {
        error: DeleteJudgeClientResponseError.PERMISSION_DENIED
      };
    if (!(await this.recentlyAuthenticated(req, user)))
      return { error: DeleteJudgeClientResponseError.REAUTHENTICATION_REQUIRED };

    const judgeClient = await this.judgeClientService.findJudgeClientById(request.id);
    if (!judgeClient)
      return {
        error: DeleteJudgeClientResponseError.NO_SUCH_JUDGE_CLIENT
      };

    await this.judgeClientService.deleteJudgeClient(judgeClient);
    await this.auditService.log("judge_client.delete", { judgeClientId: judgeClient.id, name: judgeClient.name });

    return {};
  }

  @ApiOperation({
    summary: "Reset the key of a judge client."
  })
  @ApiBearerAuth()
  @Post("resetJudgeClientKey")
  async resetJudgeClientKey(
    @Req() req: RequestWithSession,
    @CurrentUser() user: UserEntity,
    @Body() request: ResetJudgeClientKeyRequestDto
  ): Promise<ResetJudgeClientKeyResponseDto> {
    if (!user || !user.isAdmin)
      return {
        error: ResetJudgeClientKeyResponseError.PERMISSION_DENIED
      };
    if (!(await this.recentlyAuthenticated(req, user)))
      return { error: ResetJudgeClientKeyResponseError.REAUTHENTICATION_REQUIRED };

    const judgeClient = await this.judgeClientService.findJudgeClientById(request.id);
    if (!judgeClient)
      return {
        error: ResetJudgeClientKeyResponseError.NO_SUCH_JUDGE_CLIENT
      };

    await this.judgeClientService.resetJudgeClientKey(judgeClient);
    await this.auditService.log("judge_client.reset_key", { judgeClientId: judgeClient.id, name: judgeClient.name });

    return {
      key: judgeClient.key
    };
  }

  @ApiOperation({
    summary: "Show the key of a judge client (site administrators only, with the password entered recently)."
  })
  @ApiBearerAuth()
  @Post("getJudgeClientKey")
  async getJudgeClientKey(
    @Req() req: RequestWithSession,
    @CurrentUser() user: UserEntity,
    @Body() request: GetJudgeClientKeyRequestDto
  ): Promise<GetJudgeClientKeyResponseDto> {
    if (!user || !user.isAdmin) return { error: GetJudgeClientKeyResponseError.PERMISSION_DENIED };
    const judgeClient = await this.judgeClientService.findJudgeClientById(request.id);
    if (!judgeClient) return { error: GetJudgeClientKeyResponseError.NO_SUCH_JUDGE_CLIENT };
    if (!(await this.recentlyAuthenticated(req, user)))
      return { error: GetJudgeClientKeyResponseError.REAUTHENTICATION_REQUIRED };
    await this.auditService.log("judge_client.show_key", { judgeClientId: judgeClient.id, name: judgeClient.name });
    return { key: judgeClient.key };
  }

  @ApiOperation({
    summary:
      "Stop sending new tasks to a judge client, which finishes the ones it has (e.g. before maintenance), or resume it."
  })
  @ApiBearerAuth()
  @Post("setJudgeClientDraining")
  async setJudgeClientDraining(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: SetJudgeClientDrainingRequestDto
  ): Promise<SetJudgeClientDrainingResponseDto> {
    if (!currentUser || !currentUser.isAdmin) return { error: SetJudgeClientDrainingResponseError.PERMISSION_DENIED };
    const judgeClient = await this.judgeClientService.findJudgeClientById(request.id);
    if (!judgeClient) return { error: SetJudgeClientDrainingResponseError.NO_SUCH_JUDGE_CLIENT };
    await this.judgeClientService.setJudgeClientDraining(judgeClient, request.draining);
    await this.auditService.log(request.draining ? "judge_client.drain" : "judge_client.resume", {
      judgeClientId: judgeClient.id,
      name: judgeClient.name
    });
    return {};
  }

  @ApiOperation({
    summary: "List all judge clients."
  })
  @ApiBearerAuth()
  @Get("listJudgeClients")
  async listJudgeClients(@CurrentUser() currentUser: UserEntity): Promise<ListJudgeClientsResponseDto> {
    const judgeClients = await this.judgeClientService.listJudgeClients();
    return {
      judgeClients: await Promise.all(
        judgeClients.map(
          async judgeClient =>
            // Keys are shown one at a time with getJudgeClientKey, which asks for the password.
            await this.judgeClientService.getJudgeClientInfo(judgeClient, currentUser && currentUser.isAdmin, false)
        )
      ),
      hasManagePermission: currentUser && currentUser.isAdmin
    };
  }

  @ApiOperation({
    summary: "Get the judge queue: tasks queued or being judged, and recent failures (site administrators only)."
  })
  @ApiBearerAuth()
  @Post("getJudgeQueueStatus")
  async getJudgeQueueStatus(@CurrentUser() currentUser: UserEntity): Promise<GetJudgeQueueStatusResponseDto> {
    if (!currentUser || !currentUser.isAdmin) return { error: GetJudgeQueueStatusResponseError.PERMISSION_DENIED };
    const status = await this.judgeQueueService.getStatus();
    return {
      status: {
        ...status,
        oldestQueuedAt: status.oldestQueuedAt ?? undefined,
        jobs: status.jobs.map(job => ({
          ...job,
          judgeClientId: job.judgeClientId ?? undefined,
          lastError: job.lastError ?? undefined,
          finishedAt: job.finishedAt ?? undefined
        }))
      }
    };
  }
}
