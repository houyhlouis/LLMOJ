import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { HackService } from "./hack.service";
import { HackRequestDto } from "./hack-request.dto";

import { CurrentUser } from "../common/user.decorator";
import { UserEntity } from "../user/user.entity";

@ApiTags("Hack")
@ApiBearerAuth()
@Controller("hack")
export class HackController {
  constructor(private readonly service: HackService) {}

  @Get() list(@CurrentUser() user: UserEntity, @Query() request: HackRequestDto) {
    return this.service.list(user, request);
  }

  @Post("list") listPost(@CurrentUser() user: UserEntity, @Body() request: HackRequestDto) {
    return this.service.list(user, request);
  }

  @Post("get") get(@CurrentUser() user: UserEntity, @Body() request: HackRequestDto) {
    return this.service.get(user, request.id);
  }

  @Post("eligibility") eligibility(@CurrentUser() user: UserEntity, @Body() request: HackRequestDto) {
    return this.service.eligibility(user, request.submissionId);
  }

  @Post("create") create(@CurrentUser() user: UserEntity, @Body() request: HackRequestDto) {
    return this.service.create(user, request);
  }

  @Post("config") config(@CurrentUser() user: UserEntity, @Body() request: HackRequestDto) {
    return this.service.config(user, request.problemId);
  }

  @Post("saveConfig") saveConfig(@CurrentUser() user: UserEntity, @Body() request: HackRequestDto) {
    return this.service.saveConfig(user, request);
  }

  @Post("useSubmissionReference") useSubmissionReference(
    @CurrentUser() user: UserEntity,
    @Body() request: HackRequestDto
  ) {
    return this.service.useSubmissionReference(user, request.submissionId);
  }

  @Post("rejudge") rejudge(@CurrentUser() user: UserEntity, @Body() request: HackRequestDto) {
    return this.service.rejudge(user, request.id);
  }
}
