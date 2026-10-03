import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { AiService } from "./ai.service";
import { AiError } from "./ai.types";
import {
  SaveAiConfigurationDto,
  StartAiJobDto,
  AiJobQueryDto,
  AiJobIdDto,
  AiTestDto,
  AiUsageQueryDto,
  AiPrepareAttachmentDto,
  AiRetryJobDto
} from "./ai.dto";

import { UserEntity } from "../user/user.entity";
import { CurrentUser } from "../common/user.decorator";

@ApiTags("AI")
@Controller("ai")
export class AiController {
  constructor(private readonly ai: AiService) {}

  private async call<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      return {
        error: error instanceof AiError ? error.code : "INTERNAL_ERROR",
        message: error instanceof AiError ? error.message : "INTERNAL_ERROR"
      };
    }
  }

  @Post("getConfiguration") getConfiguration(@CurrentUser() user: UserEntity) {
    return this.call(() => this.ai.getConfiguration(user));
  }

  @Post("saveConfiguration") saveConfiguration(@CurrentUser() user: UserEntity, @Body() body: SaveAiConfigurationDto) {
    return this.call(() => this.ai.saveConfiguration(user, body));
  }

  @Post("models") models(@CurrentUser() user: UserEntity) {
    return this.call(() => this.ai.models(user));
  }

  @Post("test") test(@CurrentUser() user: UserEntity, @Body() body: AiTestDto) {
    return this.call(() => this.ai.test(user, body.target));
  }

  @Post("prepareAttachment") prepareAttachment(@CurrentUser() user: UserEntity, @Body() body: AiPrepareAttachmentDto) {
    return this.call(() => this.ai.prepareAttachment(user, body));
  }

  @Post("usage") usage(@CurrentUser() user: UserEntity, @Body() body: AiUsageQueryDto) {
    return this.call(() => this.ai.usageReport(user, body.days));
  }

  @Post("start") start(@CurrentUser() user: UserEntity, @Body() body: StartAiJobDto) {
    return this.call(() => this.ai.start(user, body));
  }

  @Post("jobs") jobs(@CurrentUser() user: UserEntity, @Body() body: AiJobQueryDto) {
    return this.call(() => this.ai.listJobs(user, body.problemId));
  }

  @Post("cancel") cancel(@CurrentUser() user: UserEntity, @Body() body: AiJobIdDto) {
    return this.call(() => this.ai.cancel(user, body.id));
  }

  @Post("retry") retry(@CurrentUser() user: UserEntity, @Body() body: AiRetryJobDto) {
    return this.call(() => this.ai.retry(user, body.id, body.retryFrom));
  }
}
