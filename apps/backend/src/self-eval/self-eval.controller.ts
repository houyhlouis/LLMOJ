import { Body, Controller, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { SelfEvalService } from "./self-eval.service";
import { SelfEvalRequestDto } from "./self-eval-request.dto";

import { CurrentUser } from "../common/user.decorator";
import { UserEntity } from "../user/user.entity";

@ApiTags("Self evaluation")
@ApiBearerAuth()
@Controller("selfEval")
export class SelfEvalController {
  constructor(private readonly service: SelfEvalService) {}

  @Post("info") info(@CurrentUser() user: UserEntity, @Body() request: SelfEvalRequestDto) {
    return this.service.info(user, request);
  }

  @Post("configureProfile") configureProfile(@CurrentUser() user: UserEntity, @Body() request: SelfEvalRequestDto) {
    return this.service.configureProfile(user, request);
  }

  @Post("prepare") prepare(@CurrentUser() user: UserEntity, @Body() request: SelfEvalRequestDto) {
    return this.service.prepare(user, request);
  }

  @Post("create") create(@CurrentUser() user: UserEntity, @Body() request: SelfEvalRequestDto) {
    return this.service.create(user, request);
  }

  @Post("get") get(@CurrentUser() user: UserEntity, @Body() request: SelfEvalRequestDto) {
    return this.service.get(user, request.id);
  }

  @Post("list") list(@CurrentUser() user: UserEntity, @Body() request: SelfEvalRequestDto) {
    return this.service.list(user, request);
  }
}
