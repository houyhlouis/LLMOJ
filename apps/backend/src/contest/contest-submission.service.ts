import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";

import { ContestEntity } from "./contest.entity";
import { ContestProblemEntity } from "./contest-problem.entity";
import { ContestAccessService } from "./contest-access.service";
import { contestSubmissionFeedback } from "./contest-feedback";
import {
  contestEnded,
  contestSubmissionsOpen,
  contestSubmissionsPublic,
  contestSubmissionVisibility
} from "./contest-policy";
import { isContestLanguageAllowed } from "./contest-languages";

import type { ContestRequestData } from "./contest-request.dto";

import type { SubmissionContentTraditional } from "../problem-type/types/traditional/submission-content.interface";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeType } from "../user/user-privilege.service";
import { ProblemService } from "../problem/problem.service";
import { SubmissionService } from "../submission/submission.service";
import { SubmissionAccessService, SubmissionPermissionType } from "../submission/submission-access.service";
import { SubmissionJudgingService } from "../submission/submission-judging.service";
import { SubmissionEntity } from "../submission/submission.entity";

/**
 * Submissions in contests: taking them while the contest's time and language rules allow, listing and showing them
 * with what the contest's rule lets each viewer see (contest-policy.ts), and the contest's rejudges.
 */
@Injectable()
export class ContestSubmissionService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly access: ContestAccessService,
    private readonly problems: ProblemService,
    private readonly submissions: SubmissionService,
    private readonly submissionAccess: SubmissionAccessService,
    private readonly submissionJudging: SubmissionJudgingService
  ) {}

  async submit(user: UserEntity, id: number, problemId: number, data: ContestRequestData, prepare = false) {
    await this.access.requirePrivilege(user, UserPrivilegeType.ParticipateContest);
    const { contest, manager } = await this.access.get(user, id, true);
    if (!manager && contestEnded(contest)) throw new ForbiddenException("Contest has ended");
    const row = await this.db.getRepository(ContestProblemEntity).findOneBy({ id: problemId, contestId: id });
    if (!row) throw new NotFoundException();
    return await this.problems.lockProblemById(row.problemId, "Read", async problem => {
      if (!contestSubmissionsOpen(contest, manager)) throw new ForbiddenException("Contest is not running");
      if (!problem || !(await this.problems.getProblemJudgeInfo(problem))[1])
        throw new BadRequestException("Problem cannot be submitted");
      const payload = data.content as Partial<SubmissionContentTraditional> & {
        userProgram?: SubmissionContentTraditional;
      };
      const codeContent = payload?.language ? payload : payload?.userProgram;
      if (
        codeContent?.language &&
        !isContestLanguageAllowed(
          contest.languages,
          codeContent.language,
          codeContent.compileAndRunOptions as Record<string, unknown>
        )
      )
        throw new ForbiddenException("Language is not allowed in this contest");
      const errors = await this.submissions.validateSubmissionContent(problem, data.content);
      if (errors.length) throw new BadRequestException(errors);
      if (prepare) {
        if (!Number.isInteger(data.fileSize) || data.fileSize < 0) throw new BadRequestException();
        const result = await this.submissions.prepareSubmissionFileUpload(problem, data.fileSize);
        return typeof result === "string" ? { error: result } : { signedUploadRequest: result };
      }
      const [error, submission] = await this.submissions.createSubmission(
        user,
        problem,
        data.content,
        data.uploadInfo,
        {
          contestId: id,
          contestProblemId: row.id,
          contestInputFilename: row.inputFilename,
          contestOutputFilename: row.outputFilename,
          contestSubtaskAllOrNothing: row.subtaskAllOrNothing
        }
      );
      if (error) return typeof error === "string" ? { error } : { signedUploadRequest: error };
      return { submissionId: submission.id };
    });
  }

  async submissionList(user: UserEntity, id: number, page = 1, data: ContestRequestData = {}) {
    const { contest, manager } = await this.access.get(user, id, true);
    const query = this.db.getRepository(SubmissionEntity).createQueryBuilder("s").where("s.contestId = :id", { id });
    if (!contestSubmissionsPublic(contest, manager))
      query.andWhere("s.submitterId = :userId", { userId: user?.id ?? -1 });
    if (data.userId && Number.isSafeInteger(data.userId))
      query.andWhere("s.submitterId = :filterUser", { filterUser: data.userId });
    if (data.problemId && Number.isSafeInteger(data.problemId))
      query.andWhere("s.contestProblemId = :filterProblem", { filterProblem: data.problemId });
    const [rows, total] = await query
      .orderBy("s.id", "DESC")
      .skip((page - 1) * 50)
      .take(50)
      .getManyAndCount();
    return {
      total,
      submissions: await Promise.all(
        rows.map(async s => {
          const submitter = await s.submitter;
          return { ...this.safeSubmission(s, contest, manager), username: submitter.username };
        })
      )
    };
  }

  private safeSubmission(s: SubmissionEntity, contest: ContestEntity, manager: boolean) {
    return contestSubmissionFeedback(s, contest.rule, contestEnded(contest), manager);
  }

  async submissionDetail(user: UserEntity, id: number, submissionId: number) {
    const { contest, manager } = await this.access.get(user, id, true);
    const s = await this.db.getRepository(SubmissionEntity).findOneBy({ id: submissionId, contestId: id });
    if (!s) throw new NotFoundException();
    const see = contestSubmissionVisibility(contest, s, { manager, userId: user?.id });
    if (!see.visible) throw new ForbiddenException();
    const detail = await this.submissions.getSubmissionDetail(s);
    // Full judge results contain filenames and checker output, which are never public contest metadata.
    const { result } = detail;
    const subtasks = see.results
      ? result?.subtasks?.map(st => ({
          score: st.score,
          fullScore: st.fullScore,
          testcases: st.testcases?.map(ref => {
            const tc = result.testcaseResult?.[ref.testcaseHash];
            return { status: tc?.status, score: tc?.score, timeUsed: tc?.time, memoryUsed: tc?.memory };
          })
        }))
      : undefined;
    return {
      submission: this.safeSubmission(s, contest, manager),
      content: see.code ? detail.content : null,
      compile: see.compile ? result?.compile : undefined,
      subtasks,
      permissionFake:
        manager && (await this.submissionAccess.userHasPermission(user, s, SubmissionPermissionType.Fake)),
      permissionRejudge:
        manager && (await this.submissionAccess.userHasPermission(user, s, SubmissionPermissionType.Rejudge))
    };
  }

  async rejudge(user: UserEntity, id: number, submissionId?: number) {
    if (!(await this.access.get(user, id)).manager || !(await this.access.canRejudge(user)))
      throw new ForbiddenException();
    const rows = await this.db
      .getRepository(SubmissionEntity)
      .findBy(submissionId ? { contestId: id, id: submissionId } : { contestId: id });
    let count = 0;
    for (const s of rows) {
      if (["Fake", "Hacked"].includes(s.status)) {
        if (!submissionId) continue;
        // eslint-disable-next-line no-await-in-loop
        if (!(await this.submissionAccess.userHasPermission(user, s, SubmissionPermissionType.Rejudge)))
          throw new ForbiddenException();
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.submissionJudging.rejudgeSubmission(s, user);
      } catch (error) {
        // Concurrent invalidation must remain in effect during a mass rejudge.
        let isInvalidated = false;
        if (!submissionId && error instanceof ForbiddenException) {
          // eslint-disable-next-line no-await-in-loop -- Recheck the raced record before deciding to skip it.
          isInvalidated = ["Fake", "Hacked"].includes((await this.submissions.findSubmissionById(s.id))?.status);
        }
        if (isInvalidated) continue;
        throw error;
      }
      count++;
    }
    return { count };
  }
}
