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

  /**
   * Expected AI failures are answered like the rest of the API: HTTP 200 with an error code. Anything else is
   * a server error, which the global error filter logs (redacted) and answers with HTTP 500 and the request ID.
   */
  private async call<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      return { error: error.code, message: error.message };
    }
  }

  @Post("getConfiguration") getConfiguration(@CurrentUser() user: UserEntity) {
    return this.call(() => this.ai.getConfiguration(user));
  }

  @Post("saveConfiguration") saveConfiguration(@CurrentUser() user: UserEntity, @Body() body: SaveAiConfigurationDto) {
    return this.call(() => this.ai.saveConfiguration(user, body));
  }

  @Post("listEndpointUsage") listEndpointUsage(@CurrentUser() user: UserEntity) {
    return this.call(() => this.ai.endpointUsage(user));
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
