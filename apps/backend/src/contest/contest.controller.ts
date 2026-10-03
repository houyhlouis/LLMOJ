import { Body, Controller, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { ContestService } from "./contest.service";
import { ContestRequestDto } from "./contest-request.dto";

import { CurrentUser } from "../common/user.decorator";
import { UserEntity } from "../user/user.entity";
import { ProofOfWork } from "../proof-of-work/proof-of-work.decorator";
import { ProofOfWorkAction } from "../proof-of-work/proof-of-work-action.enum";

@ApiTags("Contest")
@ApiBearerAuth()
@Controller("contest")
export class ContestController {
  constructor(private readonly service: ContestService) {}

  @Post("list") list(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.list(u, r.page);
  }

  @Post("detail") detail(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.detail(u, r.id);
  }

  @Post("save") save(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.save(u, r.id, r.data ?? {});
  }

  @Post("delete") delete(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.delete(u, r.id);
  }

  @Post("saveProblem") saveProblem(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.saveProblem(u, r.id, r.data ?? {});
  }

  @Post("removeProblem") removeProblem(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.removeProblem(u, r.id, r.problemId);
  }

  @Post("problem") problem(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.problem(u, r.id, r.problemId, r.data?.locale);
  }

  @Post("attachment") attachment(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.attachment(u, r.id, r.problemId, r.data ?? {});
  }

  @Post("removeAttachment") removeAttachment(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.removeAttachment(u, r.id, r.problemId, r.data?.filename);
  }

  @Post("download") download(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.download(u, r.id, r.problemId, r.data?.filename);
  }

  @ProofOfWork(ProofOfWorkAction.SubmitProblem)
  @Post("submit")
  submit(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.submit(u, r.id, r.problemId, r.data ?? {});
  }

  @ProofOfWork(ProofOfWorkAction.PrepareSubmissionFileUpload)
  @Post("prepareUpload")
  prepareUpload(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.submit(u, r.id, r.problemId, r.data ?? {}, true);
  }

  @Post("submissions") submissions(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.submissionList(u, r.id, r.page, r.data);
  }

  @Post("submission") submission(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.submissionDetail(u, r.id, r.submissionId);
  }

  @Post("ranklist") ranklist(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.ranklist(u, r.id);
  }

  @Post("export") export(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.export(u, r.id);
  }

  @Post("rejudge") rejudge(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.rejudge(u, r.id, r.submissionId);
  }

  @Post("summary") summary(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.summary(u, r.id);
  }

  @Post("saveSummary") saveSummary(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.summary(u, r.id, r.data ?? {});
  }

  @Post("summaries") summaries(@CurrentUser() u: UserEntity, @Body() r: ContestRequestDto) {
    return this.service.summaries(u, r.page);
  }
}
