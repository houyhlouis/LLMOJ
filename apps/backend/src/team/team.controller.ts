import { Body, Controller, Get, Post, Query, BadRequestException } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { TeamService } from "./team.service";
import { TeamRequestDto } from "./team-request.dto";

import { CurrentUser } from "../common/user.decorator";
import { UserEntity } from "../user/user.entity";

@ApiTags("Team")
@Controller("team")
export class TeamController {
  constructor(private readonly teams: TeamService) {}

  @Get("list") list(
    @CurrentUser() user: UserEntity,
    @Query("mine") mine: string,
    @Query("query") query = "",
    @Query("page") page = "1"
  ) {
    const value = Number(page);
    if (!Number.isSafeInteger(value) || value < 1 || value > 100000 || query.length > 200)
      throw new BadRequestException();
    return this.teams.list(user, mine === "1" || mine === "true", query, value);
  }

  @Post("get") get(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.get(user, body.teamId);
  }

  @Post("joinPreview") joinPreview(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.joinPreview(user, body.teamId);
  }

  @Post("create") create(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.create(user, body);
  }

  @Post("save") save(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.save(user, body);
  }

  @Post("join") join(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.join(user, body);
  }

  @Post("leave") leave(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.leave(user, body.teamId);
  }

  @Post("members") members(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.members(user, body.teamId);
  }

  @Post("manageMembers") manageMembers(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.manageMembers(user, body);
  }

  @Post("transfer") transfer(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.transfer(user, body);
  }

  @Post("saveGroup") saveGroup(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.saveGroup(user, body);
  }

  @Post("changeGroup") changeGroup(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.changeGroup(user, body);
  }

  @Post("createProblem") createProblem(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.createProblem(user, body);
  }

  @Post("createContest") createContest(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.createContest(user, body);
  }

  @Post("updateContestAccess") updateContestAccess(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.updateContestAccess(user, body);
  }

  @Post("createDiscussion") createDiscussion(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.createDiscussion(user, body);
  }

  @Post("archiveResource") archiveResource(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.archiveResource(user, body);
  }

  @Post("saveAssignment") saveAssignment(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.saveAssignment(user, body);
  }

  @Post("assignment") assignment(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.assignment(user, body);
  }

  @Post("exportAssignment") exportAssignment(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.exportAssignment(user, body);
  }

  @Post("prepareFileUpload") prepareFileUpload(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.prepareFileUpload(user, body);
  }

  @Post("uploadFile") uploadFile(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.uploadFile(user, body);
  }

  @Post("prepareFileUploadPart") prepareFileUploadPart(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.prepareFileUploadPart(user, body);
  }

  @Post("cancelFileUpload") cancelFileUpload(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.cancelFileUpload(user, body);
  }

  @Post("downloadFile") downloadFile(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.downloadFile(user, body);
  }

  @Post("archiveFile") archiveFile(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.archiveFile(user, body);
  }

  @Post("createInvitation") createInvitation(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.createInvitation(user, body);
  }

  @Post("invitations") invitations(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.invitations(user, body.teamId);
  }

  @Post("deactivateInvitation") deactivateInvitation(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.deactivateInvitation(user, body);
  }

  @Post("acceptInvitation") acceptInvitation(@CurrentUser() user: UserEntity, @Body() body: TeamRequestDto) {
    return this.teams.acceptInvitation(user, body.token);
  }

  @Post("acceptContestInvitation") acceptContestInvitation(
    @CurrentUser() user: UserEntity,
    @Body() body: TeamRequestDto
  ) {
    return this.teams.acceptContestInvitation(user, body.token);
  }
}
