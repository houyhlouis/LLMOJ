import { createHash } from "crypto";

import { Injectable, Inject, forwardRef, ForbiddenException, Optional } from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";

import { Repository, DataSource, QueryBuilder, IsNull, EntityManager } from "typeorm";
import { ValidationError } from "class-validator";
import { v4 as uuid } from "uuid";
import moment from "moment-timezone";

import { JudgeTaskType, SubmissionStatus } from "@libreoj/judge-protocol";

import {
  SubmissionFinishedProgress,
  SubmissionProgress,
  SubmissionProgressType
} from "./submission-progress.interface";

import { SubmissionContent } from "./submission-content.interface";
import { submissionDisplayProgress } from "./submission-display-progress";
import { makeSubmissionPriority } from "./submission-priority";

import { SubmissionProgressService, SubmissionEventType } from "./submission-progress.service";

import { SubmissionStatisticsService } from "./submission-statistics.service";

import { SubmissionEntity } from "./submission.entity";

import { SubmissionDetailEntity } from "./submission-detail.entity";
import { SubmissionResultHistoryEntity } from "./submission-result-history.entity";
import { StatisticsOutboxService } from "./statistics-outbox.service";

import {
  SubmissionBasicMetaDto,
  SubmissionDataVersionDto,
  SubmissionEarlierResultDto,
  SubmissionJudgeRuntimeDto
} from "./dto";

import type { ProblemJudgeInfoTraditional } from "../problem-type/types/traditional/problem-judge-info.interface";

import { logger } from "../logger";
import { ProblemPermissionType, ProblemService } from "../problem/problem.service";
import { UserEntity } from "../user/user.entity";
import { ProblemEntity, ProblemType } from "../problem/problem.entity";
import { JudgeQueueService, JudgeTaskPriorityType, JudgeTask, JudgeTaskExtraInfo } from "../judge/judge-queue.service";
import { JudgeTaskCompletion, JudgeTaskService } from "../judge/judge-task-service.interface";
import { ProblemFileType } from "../problem/problem-file.entity";
import { ProblemDataVersionService } from "../problem/problem-data-version.service";
import { ProblemDataVersionEntity, ProblemDataVersionFile } from "../problem/problem-data-version.entity";
import { ProblemJudgeInfo } from "../problem/problem-judge-info.interface";
import { ProblemSampleData } from "../problem/problem-sample-data.interface";
import { LockService } from "../redis/lock.service";
import { JudgeGateway } from "../judge/judge.gateway";
import { JudgeRuntimeService } from "../judge/judge-runtime.service";
import { ProblemTypeFactoryService } from "../problem-type/problem-type-factory.service";
import { AuditLogObjectType, AuditService } from "../audit/audit.service";
import { MinioSignFor, FileService, JUDGE_FILE_DOWNLOAD_EXPIRE_TIME } from "../file/file.service";
import { ConfigService } from "../config/config.service";
import { FileEntity } from "../file/file.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";

import { ContestEntity } from "../contest/contest.entity";
import { teamResourceAccess, teamResourceVisibilitySql } from "../team/team-access";

import { MetricsService } from "../metrics/metrics.service";

import { FileUploadInfoDto, SignedFileUploadRequestDto } from "../file/dto";

export enum SubmissionPermissionType {
  View = "View",
  Cancel = "Cancel",
  Rejudge = "Rejudge",
  ManagePublicness = "ManagePublicness",
  Delete = "Delete",
  Fake = "Fake"
}

interface SubmissionTaskExtraInfo extends JudgeTaskExtraInfo {
  problemType: ProblemType;
  judgeInfo: ProblemJudgeInfo;
  samples?: (ProblemSampleData[number] | { inputFileUuid: string; outputFileUuid: string; hidden: true })[];
  testData: Record<string, string>; // filename -> uuid
  submissionContent: SubmissionContent;
  file?: {
    uuid: string;
    url: string;
  };
}

// The judge task's lease ended before its result was stored: the result is discarded.
class ObsoleteResultError extends Error {}

// Results replaced by rejudges kept per submission
const RESULT_HISTORY_KEPT = 5;

@Injectable()
export class SubmissionService implements JudgeTaskService<SubmissionProgress, SubmissionTaskExtraInfo> {
  @Optional() @Inject(JudgeRuntimeService) private readonly judgeRuntimeService: JudgeRuntimeService;

  constructor(
    @InjectDataSource()
    private connection: DataSource,
    @InjectRepository(SubmissionEntity)
    private readonly submissionRepository: Repository<SubmissionEntity>,
    @InjectRepository(SubmissionDetailEntity)
    private readonly submissionDetailRepository: Repository<SubmissionDetailEntity>,
    private readonly problemService: ProblemService,
    private readonly problemTypeFactoryService: ProblemTypeFactoryService,
    private readonly judgeQueueService: JudgeQueueService,
    private readonly lockService: LockService,
    private readonly submissionProgressService: SubmissionProgressService,
    private readonly submissionStatisticsService: SubmissionStatisticsService,
    private readonly judgeGateway: JudgeGateway,
    private readonly auditService: AuditService,
    private readonly fileService: FileService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => UserPrivilegeService))
    private readonly userPrivilegeService: UserPrivilegeService,
    private readonly metricsService: MetricsService,
    @Inject(forwardRef(() => ProblemDataVersionService))
    private readonly problemDataVersionService: ProblemDataVersionService,
    private readonly statisticsOutboxService: StatisticsOutboxService
  ) {
    this.judgeQueueService.registerTaskType(JudgeTaskType.Submission, this);

    this.auditService.registerObjectTypeQueryHandler(AuditLogObjectType.Submission, async submissionId => {
      const submission = await this.findSubmissionById(submissionId);
      return !submission ? null : await this.getSubmissionBasicMeta(submission);
    });
  }

  private readonly metricSubmissionJudgeTime = this.metricsService.histogram(
    "libreoj_submission_judge_time_seconds",
    this.metricsService.histogram.BUCKETS_TIME_10M_30
  );

  async findSubmissionById(submissionId: number): Promise<SubmissionEntity> {
    return await this.submissionRepository.findOneBy({
      id: submissionId
    });
  }

  async findSubmissionByTaskId(taskId: string): Promise<SubmissionEntity> {
    return await this.submissionRepository.findOneBy({
      taskId
    });
  }

  async findSubmissionsByExistingIds(submissionIds: number[]): Promise<SubmissionEntity[]> {
    if (submissionIds.length === 0) return [];
    const uniqueIds = Array.from(new Set(submissionIds));
    const records = await this.submissionRepository.findByIds(uniqueIds);
    const map = Object.fromEntries(records.map(record => [record.id, record]));
    return submissionIds.map(submissionId => map[submissionId]);
  }

  async userHasPermission(
    user: UserEntity,
    submission: SubmissionEntity,
    type: SubmissionPermissionType,
    problem?: ProblemEntity,
    hasPrivilege?: boolean
  ): Promise<boolean> {
    if (!(await this.userHasTeamResourceAccess(user, submission))) return false;
    // Recheck disqualification authority before allowing a fake to be restored.
    if (
      type === SubmissionPermissionType.Rejudge &&
      submission.status === SubmissionStatus.Fake &&
      !(await this.userHasPermission(user, submission, SubmissionPermissionType.Fake, problem, hasPrivilege))
    )
      return false;

    if (submission.contestId) {
      const contest = await this.connection.getRepository(ContestEntity).findOneBy({ id: submission.contestId });
      if (!contest || !user || !(await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ViewContest)))
        return false;
      const teamManager = await teamResourceAccess(this.connection, user, "contest", submission.contestId, "contests");
      const manager =
        teamManager !== null
          ? teamManager &&
            (await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.EditContest, true))
          : user.isAdmin ||
            (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageContest)) ||
            ((await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.EditContest)) &&
              (contest.ownerId === user.id || contest.adminIds.includes(user.id)));
      // Contest endpoints expose only the feedback permitted by the contest rule.
      if (manager) {
        if (type === SubmissionPermissionType.Rejudge)
          return (
            (submission.status !== SubmissionStatus.Hacked ||
              (await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.ManageHack, true))) &&
            (await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.RejudgeSubmission, true))
          );
        if (type === SubmissionPermissionType.Fake)
          return await this.userPrivilegeService.permissionDecision(
            user,
            UserPrivilegeType.FakeSubmission,
            await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.DeleteSubmission, true)
          );
        if (type === SubmissionPermissionType.Delete)
          return await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.DeleteSubmission, true);
        return true;
      }
      if (
        type === SubmissionPermissionType.ManagePublicness ||
        type === SubmissionPermissionType.Delete ||
        type === SubmissionPermissionType.Fake ||
        type === SubmissionPermissionType.Rejudge
      )
        return false;
      if (type === SubmissionPermissionType.Cancel)
        return user.id === submission.submitterId && Date.now() < +contest.endTime;
      return Date.now() >= +contest.endTime && user.id === submission.submitterId;
    }
    switch (type) {
      // Everyone can read a public submission
      // Submitter and those who has the Modify permission of the submission's problem can View a non-public submission
      case SubmissionPermissionType.View:
        if (!(await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ViewSubmission))) return false;
        if (!user) return submission.isPublic;
        if (user.id === submission.submitterId) return true;
        if (
          await this.userPrivilegeService.permissionDecision(
            user,
            UserPrivilegeType.ReadAnySubmissionCode,
            submission.isPublic
          )
        )
          return true;
        if (
          submission.isPublic &&
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ReadCodeAfterAccepted)) &&
          (await this.getUserProblemAcceptedSubmissionCount(user.id, submission.problemId))
        )
          return true;
        return await this.problemService.userHasPermission(
          user,
          problem ?? (await this.problemService.findProblemById(submission.problemId)),
          ProblemPermissionType.Modify,
          hasPrivilege
        );

      // Submitter and those who has the Modify permission of the submission's problem can Cancel a submission
      case SubmissionPermissionType.Cancel:
        if (!user) return false;
        if (user.id === submission.submitterId) return true;
        return await this.problemService.userHasPermission(
          user,
          problem ?? (await this.problemService.findProblemById(submission.problemId)),
          ProblemPermissionType.Modify,
          hasPrivilege
        );

      // Those who has the Modify permission of the submission's problem can Rejudge a submission
      case SubmissionPermissionType.Rejudge:
        if (
          submission.status === SubmissionStatus.Hacked &&
          !(await this.userPrivilegeService.permissionDecision(
            user,
            UserPrivilegeType.ManageHack,
            await this.problemService.userHasPermission(
              user,
              problem ?? (await this.problemService.findProblemById(submission.problemId)),
              ProblemPermissionType.Modify,
              hasPrivilege
            )
          ))
        )
          return false;
        return await this.userPrivilegeService.permissionDecision(
          user,
          UserPrivilegeType.RejudgeSubmission,
          await this.problemService.userHasPermission(
            user,
            problem ?? (await this.problemService.findProblemById(submission.problemId)),
            ProblemPermissionType.Modify,
            hasPrivilege
          )
        );

      // Admins can manage a submission's publicness or delete a submission
      case SubmissionPermissionType.Delete:
        return await this.userPrivilegeService.permissionDecision(
          user,
          UserPrivilegeType.DeleteSubmission,
          !!user &&
            (user.isAdmin ||
              (hasPrivilege ??
                (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem))))
        );
      case SubmissionPermissionType.Fake:
        return await this.userPrivilegeService.permissionDecision(
          user,
          UserPrivilegeType.FakeSubmission,
          await this.userHasPermission(user, submission, SubmissionPermissionType.Delete, problem, hasPrivilege)
        );
      case SubmissionPermissionType.ManagePublicness:
        return (
          !!user &&
          (user.isAdmin ||
            (hasPrivilege ?? (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem))))
        );

      default:
        return false;
    }
  }

  async userHasTeamResourceAccess(user: UserEntity, submission: SubmissionEntity): Promise<boolean> {
    const resourceKind = submission.contestId ? "contest" : "problem";
    const resourceId = submission.contestId || submission.problemId;
    return (await teamResourceAccess(this.connection, user, resourceKind, resourceId)) !== false;
  }

  async querySubmissions(
    problemId: number,
    submitterId: number,
    codeLanguage: string,
    status: SubmissionStatus,
    minId: number,
    maxId: number,
    publicOnly: boolean,
    takeCount: number,
    currentUser?: UserEntity
  ): Promise<{ result: SubmissionEntity[]; hasSmallerId: boolean; hasLargerId: boolean }> {
    const queryBuilder = this.submissionRepository
      .createQueryBuilder("submission")
      .andWhere("contestId IS NULL")
      .andWhere(teamResourceVisibilitySql("problem", "submission.problemId", currentUser));

    if (publicOnly) {
      queryBuilder.andWhere("isPublic = :isPublic", {
        isPublic: true
      });
    }

    if (problemId) {
      queryBuilder.andWhere("problemId = :problemId", {
        problemId
      });
    }

    if (submitterId) {
      queryBuilder.andWhere("submitterId = :submitterId", {
        submitterId
      });
    }

    if (codeLanguage) {
      queryBuilder.andWhere("codeLanguage = :codeLanguage", {
        codeLanguage
      });
    }

    if (status) {
      queryBuilder.andWhere("status = :status", {
        status
      });
    }

    const queryBuilderWithoutPagination = queryBuilder.clone();

    let reversed = false;
    if (minId != null) {
      queryBuilder.andWhere("id >= :minId", {
        minId
      });
      queryBuilder.orderBy("id", "ASC");
      reversed = true;
    } else if (maxId != null) {
      queryBuilder.andWhere("id <= :maxId", {
        maxId
      });
      queryBuilder.orderBy("id", "DESC");
    } else {
      queryBuilder.orderBy("id", "DESC");
    }

    queryBuilder.take(takeCount);

    const result = await queryBuilder.getMany();
    if (reversed) result.reverse();

    if (result.length === 0)
      return {
        result: [],
        hasSmallerId: false,
        hasLargerId: false
      };

    const largestId = result[0].id;
    const smallestId = result[result.length - 1].id;
    const [hasSmallerId, hasLargerId] = await Promise.all([
      queryBuilderWithoutPagination
        .clone()
        .select("1")
        .andWhere("id < :smallestId", { smallestId })
        .take(1)
        .getRawOne(),
      queryBuilderWithoutPagination.clone().select("1").andWhere("id > :largestId", { largestId }).take(1).getRawOne()
    ]);

    return {
      result,
      hasSmallerId: !!hasSmallerId,
      hasLargerId: !!hasLargerId
    };
  }

  /**
   * @param problem Should be locked by `ProblemService.lockProblemById(id, "Read")`.
   */
  async validateSubmissionContent(problem: ProblemEntity, content: SubmissionContent): Promise<ValidationError[]> {
    return await this.problemTypeFactoryService.type(problem.type).validateSubmissionContent(content);
  }

  async prepareSubmissionFileUpload(
    problem: ProblemEntity,
    size: number
  ): Promise<"FILE_TOO_LARGE" | SignedFileUploadRequestDto> {
    if (!this.problemTypeFactoryService.type(problem.type).shouldUploadAnswerFile()) {
      throw new Error("Cannot prepare a submission file upload for a problem that does not accept answer files");
    }
    return await this.fileService.prepareUploadRequest(size, fileSize =>
      fileSize <= this.configService.config.resourceLimit.submissionFileSize ? null : "FILE_TOO_LARGE"
    );
  }

  /**
   * @param problem Should be locked by `ProblemService.lockProblemById(id, "Read")`.
   * @param content Should be validated with `validateSubmissionContent` before calling this method.
   */
  async createSubmission(
    submitter: UserEntity,
    problem: ProblemEntity,
    content: SubmissionContent,
    uploadInfo: FileUploadInfoDto,
    contestContext?: Pick<
      SubmissionEntity,
      "contestId" | "contestProblemId" | "contestInputFilename" | "contestOutputFilename" | "contestSubtaskAllOrNothing"
    >
  ): Promise<
    [
      fileUploadErrorOrRequest:
        | "FILE_UUID_EXISTS"
        | "FILE_NOT_UPLOADED"
        | "FILE_TOO_LARGE"
        | SignedFileUploadRequestDto,
      submission: SubmissionEntity
    ]
  > {
    const problemTypeService = this.problemTypeFactoryService.type(problem.type);
    const dataVersion = await this.dataVersionToPin(problem);
    let countChanges: number[] = [];

    const [fileUploadErrorOrRequest, submission] = await this.connection.transaction<
      [
        fileUploadErrorOrRequest:
          | "FILE_UUID_EXISTS"
          | "FILE_NOT_UPLOADED"
          | "FILE_TOO_LARGE"
          | SignedFileUploadRequestDto,
        submission: SubmissionEntity
      ]
    >("READ COMMITTED", async transactionalEntityManager => {
      let file: FileEntity = null;
      if (problemTypeService.shouldUploadAnswerFile()) {
        const result = await this.fileService.processUploadRequest(
          uploadInfo,
          size => (size <= this.configService.config.resourceLimit.submissionFileSize ? null : "FILE_TOO_LARGE"),
          transactionalEntityManager
        );

        if (result instanceof FileEntity) file = result;
        else return [result, null];
      }

      // eslint-disable-next-line @typescript-eslint/no-shadow
      const submission = new SubmissionEntity();
      submission.isPublic = contestContext ? false : problem.isPublic;
      if (contestContext) Object.assign(submission, contestContext);
      const pair = await problemTypeService.getCodeLanguageAndAnswerSizeFromSubmissionContentAndFile(content, file);
      submission.codeLanguage = pair.language;
      submission.answerSize = pair.answerSize;
      submission.score = null;
      submission.status = SubmissionStatus.Pending;
      submission.submitTime = new Date();
      submission.problemId = problem.id;
      submission.submitterId = submitter.id;
      submission.problemDataVersionId = dataVersion?.id ?? null;
      await transactionalEntityManager.save(submission);

      const submissionDetail = new SubmissionDetailEntity();
      submissionDetail.submissionId = submission.id;
      submissionDetail.content = content;
      submissionDetail.fileUuid = uploadInfo?.uuid;
      submissionDetail.result = null;
      await transactionalEntityManager.save(submissionDetail);

      // The submission and its judge task are committed together, so a new submission is never left unjudged.
      await this.queueJudgeTask(submission, false, transactionalEntityManager);
      countChanges = await this.statisticsOutboxService.record(transactionalEntityManager, null, submission);

      return [null, submission];
    });

    if (submission) {
      this.judgeQueueService.notifyJobsAvailable();
      await this.statisticsOutboxService.apply(countChanges);
      return [null, submission];
    }

    return [fileUploadErrorOrRequest, null];
  }

  async getSubmissionBasicMeta(submission: SubmissionEntity): Promise<SubmissionBasicMetaDto> {
    return {
      id: submission.id,
      isPublic: submission.isPublic,
      codeLanguage: submission.codeLanguage,
      answerSize: submission.answerSize,
      score: submission.score,
      status: submission.status,
      submitTime: submission.submitTime,
      timeUsed: submission.timeUsed,
      memoryUsed: submission.memoryUsed
    };
  }

  async getSubmissionDetail(submission: SubmissionEntity): Promise<SubmissionDetailEntity> {
    return await this.submissionDetailRepository.findOneBy({
      submissionId: submission.id
    });
  }

  async getUserRecentlySubmissionCountPerDay(
    user: UserEntity,
    days: number,
    timezone: string,
    now: string
  ): Promise<number[]> {
    if (!moment.tz.zone(timezone)) timezone = "UTC";

    const startDate = moment(now)
      .tz(timezone)
      .startOf("day")
      .subtract(days - 1, "day");

    const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const getConvertTimezoneExpression = (valueToBeConverted: string) =>
      timezone === localTimezone ? valueToBeConverted : `CONVERT_TZ(${valueToBeConverted}, :localTimezone, :timezone)`;
    const queryResult: { submitDate: Date; count: string }[] = await this.submissionRepository
      .createQueryBuilder()
      .select(`DATE(${getConvertTimezoneExpression("submitTime")})`, "submitDate")
      .addSelect("COUNT(*)", "count")
      .where("submitterId = :submitterId", { submitterId: user.id })
      .andWhere("contestId IS NULL")
      .andWhere(`submitTime >= DATE_SUB(${getConvertTimezoneExpression(":now")}, INTERVAL :offsetDays DAY)`, {
        now,
        offsetDays: days - 1
      })
      .groupBy("submitDate")
      .setParameters({
        localTimezone,
        timezone
      })
      .getRawMany();

    // The database doesn't support timezone
    if (queryResult.length === 1 && queryResult[0].submitDate === null) return new Array(days).fill(0);

    const map = new Map(
      queryResult.map(row => [
        // Get the timestemp of result datetime
        // 1. Get the date string of result datetime
        // 2. Get the moment() object in requested timezone of the date
        // 3. Get its timestamp
        moment.tz(moment(row.submitDate).format("YYYY-MM-DD"), timezone).valueOf(),
        Number(row.count)
      ])
    );

    const result = [...new Array(days).keys()].map(i => map.get(startDate.clone().add(i, "day").valueOf()) || 0);

    return result;
  }

  /**
   * Judges the submission again with the problem's current data. Its result is kept in its history.
   *
   * @param submission Must be locked.
   */
  async judgeSubmission(
    submission: SubmissionEntity,
    isRejudge?: boolean,
    problem?: ProblemEntity,
    actingUserId?: number
  ): Promise<void> {
    const oldSubmission = { ...submission };

    if (submission.taskId) {
      this.judgeGateway.cancelTask(submission.taskId);
    }

    const dataVersion = problem ? await this.dataVersionToPin(problem) : null;

    let countChanges: number[] = [];
    await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
      submission.problemDataVersionId = dataVersion?.id ?? null;
      // Writes the submission first, so that its history row's foreign key check finds it locked by this transaction
      await this.queueJudgeTask(submission, isRejudge, transactionalEntityManager);
      if (isRejudge) await this.retainResult(transactionalEntityManager, oldSubmission, actingUserId);
      countChanges = await this.statisticsOutboxService.record(transactionalEntityManager, oldSubmission, submission);
    });
    this.judgeQueueService.notifyJobsAvailable();
    await this.statisticsOutboxService.apply(countChanges);

    await this.onSubmissionUpdated(oldSubmission, submission);
  }

  /**
   * The problem's current data version to judge a submission with, or `null` (judged with the current data when its
   * task is sent, as before data versions) if it can't be taken.
   */
  private async dataVersionToPin(problem: ProblemEntity): Promise<ProblemDataVersionEntity> {
    try {
      return await this.problemDataVersionService.current(problem);
    } catch (e) {
      logger.error(`Couldn't take the data version of problem ${problem.id}: ${e}`);
      return null;
    }
  }

  /**
   * Before a rejudge, in its transaction: keeps the submission's result in its history (the most recent
   * `RESULT_HISTORY_KEPT`) and clears it.
   */
  private async retainResult(
    manager: EntityManager,
    submission: SubmissionEntity,
    actingUserId?: number
  ): Promise<void> {
    const submissionDetail = await manager.findOneBy(SubmissionDetailEntity, { submissionId: submission.id });
    if (submission.status !== SubmissionStatus.Pending) {
      await manager.insert(SubmissionResultHistoryEntity, {
        submissionId: submission.id,
        problemDataVersionId: submission.problemDataVersionId ?? null,
        judgeRuntimeId: submission.judgeRuntimeId ?? null,
        status: submission.status,
        score: submission.score,
        timeUsed: submission.timeUsed,
        memoryUsed: submission.memoryUsed,
        totalOccupiedTime: submission.totalOccupiedTime,
        result: submissionDetail?.result ?? null,
        replacedAt: new Date(),
        replacedBy: actingUserId ?? null
      });
      const kept: { id: number }[] = await manager
        .createQueryBuilder(SubmissionResultHistoryEntity, "history")
        .select("history.id", "id")
        .where("history.submissionId = :submissionId", { submissionId: submission.id })
        .orderBy("history.id", "DESC")
        .limit(RESULT_HISTORY_KEPT)
        .getRawMany();
      await manager
        .createQueryBuilder()
        .delete()
        .from(SubmissionResultHistoryEntity)
        .where("submissionId = :submissionId", { submissionId: submission.id })
        .andWhere("id NOT IN (:...kept)", { kept: kept.map(row => row.id) })
        .execute();
    }
    if (submissionDetail && submissionDetail.result != null) {
      submissionDetail.result = null;
      await manager.save(submissionDetail);
    }
  }

  /**
   * Gives the submission a new judge task, saving it together with the task's job.
   */
  private async queueJudgeTask(
    submission: SubmissionEntity,
    isRejudge: boolean,
    transactionalEntityManager: EntityManager
  ): Promise<void> {
    submission.taskId = uuid();
    submission.score = null;
    submission.status = SubmissionStatus.Pending;
    submission.timeUsed = null;
    submission.memoryUsed = null;
    submission.judgeRuntimeId = null;
    await transactionalEntityManager.save(submission);

    const [
      userPendingCount,
      userOccupiedTimeRecently,
      avgEveryUsersOccupiedTimeRecently,
      stdEveryUsersOccupiedTimeRecently
    ] = await (async () => {
      // For performance reasons, dynamic task priority could be disabled to reduce database stress
      if (!this.configService.config.preference.serverSideOnly.dynamicTaskPriority) return [0, 0, 0, 0];

      // If we are rejudging some submission, don't consider the user's influence to judge queue for priority
      if (isRejudge) return [0, 0, 0, 0];

      const selectTotalOccupiedTimeRecently = (qb: QueryBuilder<SubmissionEntity>) =>
        qb.select("SUM(totalOccupiedTime)", "total").andWhere("submitTime >= NOW() - INTERVAL 15 MINUTE");

      // eslint-disable-next-line @typescript-eslint/no-shadow
      const [userPendingCount, userOccupiedTimeRecently, avgAndStdEveryUsersOccupiedTimeRecently] = await Promise.all([
        // userPendingCount (in the transaction, which includes this submission)
        transactionalEntityManager.countBy(SubmissionEntity, {
          status: SubmissionStatus.Pending,
          submitterId: submission.submitterId
        }),
        // userOccupiedTimeRecently
        // `where()` would replace the time window condition, so the user condition must be added first.
        selectTotalOccupiedTimeRecently(
          this.submissionRepository.createQueryBuilder().where({
            submitterId: submission.submitterId
          })
        )
          .getRawOne<{ total: number }>()
          .then(result => result.total),
        // avgAndStdEveryUsersOccupiedTimeRecently
        this.connection
          .createQueryBuilder()
          .select("AVG(total)", "avg")
          .addSelect("STD(total)", "std")
          .from(
            qb =>
              selectTotalOccupiedTimeRecently(qb.select().from(SubmissionEntity, "submission")).groupBy(
                "submission.submitterId"
              ),
            "totalResult"
          )
          .getRawOne<{ avg: number; std: number }>()
      ]);

      return [
        userPendingCount,
        userOccupiedTimeRecently,
        avgAndStdEveryUsersOccupiedTimeRecently.avg,
        avgAndStdEveryUsersOccupiedTimeRecently.std
      ];
    })();

    await this.judgeQueueService.enqueue(
      submission.taskId,
      JudgeTaskType.Submission,
      makeSubmissionPriority(
        submission.id,
        userPendingCount,
        userOccupiedTimeRecently,
        avgEveryUsersOccupiedTimeRecently,
        stdEveryUsersOccupiedTimeRecently,
        isRejudge ? JudgeTaskPriorityType.Medium : JudgeTaskPriorityType.High
      ),
      transactionalEntityManager
    );
  }

  async rejudgeSubmission(submission: SubmissionEntity, actingUser?: UserEntity): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-shadow
    await this.lockSubmission(submission, true, async (submission, problem) => {
      if (!submission) return;

      // A fake may have been applied after the caller's initial permission check.
      if (
        [SubmissionStatus.Fake, SubmissionStatus.Hacked].includes(submission.status) &&
        (!actingUser || !(await this.userHasPermission(actingUser, submission, SubmissionPermissionType.Rejudge)))
      )
        throw new ForbiddenException("Restoring a fake submission requires disqualification permission");

      await this.judgeSubmission(submission, true, problem, actingUser?.id);
    });
  }

  async cancelSubmission(submission: SubmissionEntity): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-shadow
    const canceled = await this.lockSubmission(submission, true, async submission => {
      if (!submission || !submission.taskId) return false;

      this.judgeGateway.cancelTask(submission.taskId);

      const oldSubmission = { ...submission };

      submission.taskId = null;
      submission.score = null;
      submission.status = SubmissionStatus.Canceled;
      submission.timeUsed = null;
      submission.memoryUsed = null;

      const submissionDetail = await this.getSubmissionDetail(submission);
      submissionDetail.result = null;

      let countChanges: number[] = [];
      await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
        await transactionalEntityManager.save(submission);
        await transactionalEntityManager.save(submissionDetail);
        countChanges = await this.statisticsOutboxService.record(transactionalEntityManager, oldSubmission, submission);
      });
      await this.statisticsOutboxService.apply(countChanges);

      await this.onSubmissionUpdated(oldSubmission, submission);

      return true;
    });

    if (!canceled) return;

    await this.submissionProgressService.emitSubmissionEvent(submission.id, SubmissionEventType.Canceled);
  }

  async setSubmissionPublic(submission: SubmissionEntity, isPublic: boolean): Promise<void> {
    submission.isPublic = isPublic;
    await this.submissionRepository.save(submission);
  }

  async fakeSubmission(submission: SubmissionEntity, actingUserId: number): Promise<boolean> {
    // Share the same locks as judge completion/rejudge, and re-read the effective verdict.
    return await this.lockSubmission(submission, true, async lockedSubmission => {
      if (!lockedSubmission) return false;
      if (lockedSubmission.status === SubmissionStatus.Fake) return true;
      const oldSubmission = { ...lockedSubmission };
      if (lockedSubmission.taskId) this.judgeGateway.cancelTask(lockedSubmission.taskId);
      lockedSubmission.taskId = null;
      lockedSubmission.status = SubmissionStatus.Fake;
      lockedSubmission.score = 0;
      // Code, uploaded files, execution resources and original judge result remain intact.
      let countChanges: number[] = [];
      await this.connection.transaction("READ COMMITTED", async manager => {
        await manager.save(lockedSubmission);
        countChanges = await this.statisticsOutboxService.record(manager, oldSubmission, lockedSubmission);
      });
      await this.statisticsOutboxService.apply(countChanges);
      await this.onSubmissionUpdated(oldSubmission, lockedSubmission);
      await this.auditService.log(actingUserId, "submission.fake", AuditLogObjectType.Submission, lockedSubmission.id, {
        previousStatus: oldSubmission.status,
        previousScore: oldSubmission.score,
        previousTaskId: oldSubmission.taskId
      });
      const detail = await this.getSubmissionDetail(lockedSubmission);
      await this.submissionProgressService.emitSubmissionEvent(
        lockedSubmission.id,
        SubmissionEventType.Progress,
        submissionDisplayProgress(lockedSubmission, detail.result)
      );
      return true;
    });
  }

  async setSubmissionsPublic(problemId: number, isPublic: boolean): Promise<void> {
    await this.submissionRepository.update({ problemId, contestId: IsNull() }, { isPublic });
  }

  async markSubmissionHacked(
    submission: SubmissionEntity,
    hackerId: number,
    hackId: number,
    fingerprint: string,
    persistHack?: (manager: EntityManager) => Promise<void>
  ): Promise<boolean> {
    return await this.lockSubmission(submission, true, async locked => {
      if (!locked || locked.taskId || [SubmissionStatus.Fake, SubmissionStatus.Hacked].includes(locked.status))
        return false;
      const detail = await this.getSubmissionDetail(locked);
      const current = createHash("sha256")
        .update(JSON.stringify([locked.id, locked.submitTime, locked.status, locked.score, detail.content]))
        .digest("hex");
      if (current !== fingerprint) return false;
      const old = { ...locked };
      locked.status = SubmissionStatus.Hacked;
      locked.score = 0;
      let countChanges: number[] = [];
      await this.connection.transaction("READ COMMITTED", async manager => {
        await manager.save(locked);
        if (persistHack) await persistHack(manager);
        countChanges = await this.statisticsOutboxService.record(manager, old, locked);
      });
      await this.statisticsOutboxService.apply(countChanges);
      await this.onSubmissionUpdated(old, locked);
      await this.auditService.log(hackerId, "submission.hacked", AuditLogObjectType.Submission, locked.id, {
        hackId,
        previousStatus: old.status,
        previousScore: old.score
      });
      await this.submissionProgressService.emitSubmissionEvent(
        locked.id,
        SubmissionEventType.Progress,
        submissionDisplayProgress(locked, detail.result)
      );
      return true;
    });
  }

  async deleteSubmission(submission: SubmissionEntity): Promise<void> {
    // This function updates related info, lock the problem for Read first, then lock the submission
    let deleteFileActually: () => void = null;
    // eslint-disable-next-line @typescript-eslint/no-shadow
    await this.lockSubmission(submission, true, async submission => {
      if (!submission) return;

      if (submission.taskId) {
        this.judgeGateway.cancelTask(submission.taskId);
        await this.submissionProgressService.emitSubmissionEvent(submission.id, SubmissionEventType.Deleted);
      }

      let countChanges: number[] = [];
      await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
        const submissionDetail = await this.getSubmissionDetail(submission);
        if (submissionDetail.fileUuid)
          deleteFileActually = await this.fileService.deleteFile(submissionDetail.fileUuid, transactionalEntityManager);

        await transactionalEntityManager.remove(submission);
        countChanges = await this.statisticsOutboxService.record(transactionalEntityManager, submission, null);
      });
      await this.statisticsOutboxService.apply(countChanges);

      if (submission.contestId) return;
      await this.submissionStatisticsService.onSubmissionUpdated(submission, null);
    });
    if (deleteFileActually) deleteFileActually();
  }

  /**
   * After a change of a submission is committed: purges the cached statistics it affects. Its transaction recorded
   * how the counts change (`StatisticsOutboxService`).
   */
  private async onSubmissionUpdated(oldSubmission: SubmissionEntity, submission: SubmissionEntity): Promise<void> {
    if (submission.contestId) return;
    await this.submissionStatisticsService.onSubmissionUpdated(oldSubmission, submission);
  }

  /**
   * This function updates related info, the problem must be locked for Read first, then the submission must be locked.
   */
  private async onSubmissionFinished(
    submission: SubmissionEntity,
    problem: ProblemEntity,
    progress: SubmissionFinishedProgress,
    completion?: JudgeTaskCompletion
  ): Promise<boolean> {
    const oldSubmission = { ...submission };

    const submissionDetail = await this.getSubmissionDetail(submission);
    submissionDetail.result = progress;

    submission.taskId = null;
    submission.status = progress.status;
    submission.score = progress.score;
    submission.totalOccupiedTime = progress.totalOccupiedTime;
    submission.judgeRuntimeId = completion?.judgeRuntimeId ?? null;

    const timeAndMemory = this.problemTypeFactoryService
      .type(problem.type)
      .getTimeAndMemoryUsedFromFinishedSubmissionProgress(submissionDetail.result);
    submission.timeUsed = timeAndMemory.timeUsed;
    submission.memoryUsed = timeAndMemory.memoryUsed;

    let countChanges: number[] = [];
    try {
      await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
        // Finish the judge task's job first: if the reporting judge client's lease isn't current, store nothing
        if (completion && !(await completion.confirm(transactionalEntityManager))) throw new ObsoleteResultError();
        await transactionalEntityManager.save(submission);
        await transactionalEntityManager.save(submissionDetail);
        countChanges = await this.statisticsOutboxService.record(transactionalEntityManager, oldSubmission, submission);
      });
    } catch (e) {
      if (!(e instanceof ObsoleteResultError)) throw e;
      Object.assign(submission, oldSubmission);
      logger.warn(`Ignored the result of submission ${submission.id} from an obsolete judge task lease`);
      return false;
    }

    logger.log(`Submission ${submission.id} finished with status ${submission.status}`);
    await this.statisticsOutboxService.apply(countChanges);

    await this.onSubmissionUpdated(oldSubmission, submission);
    return true;
  }

  /**
   * @return `false` means the task is canceled.
   */
  async onTaskProgress(
    taskId: string,
    progress: SubmissionProgress,
    completion?: JudgeTaskCompletion
  ): Promise<boolean> {
    const submission = await this.findSubmissionByTaskId(taskId);
    if (!submission) {
      logger.warn(`Invalid task Id ${taskId} of task progress, maybe there's a too-early rejudge?`);
      return false;
    }

    const finished = progress.progressType === SubmissionProgressType.Finished;

    // Don't lock the problem if not finished since we don't modify the database.
    // eslint-disable-next-line @typescript-eslint/no-shadow
    const accepted = await this.lockSubmission(submission, finished, async (submission, problem?) => {
      if (!submission || submission.taskId !== taskId) {
        logger.warn(`Invalid task Id ${taskId} of task progress, maybe there's a too-early rejudge?`);
        return false;
      }

      // First update database, then report progress
      if (finished && !(await this.onSubmissionFinished(submission, problem, progress, completion))) return false;

      await this.submissionProgressService.emitSubmissionEvent(submission.id, SubmissionEventType.Progress, progress);
      return true;
    });

    if (accepted && finished) this.metricSubmissionJudgeTime.observe(progress.totalOccupiedTime / 1000);

    return accepted;
  }

  /**
   * Returns `null` if the task no longer exists. Other errors are thrown, so the judge queue retries the task.
   */
  async getTaskToBeSentToJudgeByTaskId(taskId: string, priotity: number): Promise<JudgeTask<SubmissionTaskExtraInfo>> {
    try {
      const submission = await this.findSubmissionByTaskId(taskId);
      if (!submission) return null;

      const submissionDetail = await this.getSubmissionDetail(submission);

      const problem = await this.problemService.findProblemById(submission.problemId);
      if (!problem) {
        logger.warn(`Problem ${submission.problemId} of judge task ${taskId} no longer exists`);
        return null;
      }
      // Judged with the data version it's pinned to; submissions from before data versions with the current data
      const dataVersion = await this.problemDataVersionService.findById(submission.problemDataVersionId);
      if (submission.problemDataVersionId && !dataVersion)
        logger.warn(`Data version ${submission.problemDataVersionId} of submission ${submission.id} no longer exists`);
      const problemType = (dataVersion?.problemType as ProblemType) ?? problem.type;
      const baseJudgeInfo = dataVersion
        ? (dataVersion.judgeInfo as ProblemJudgeInfo)
        : (await this.problemService.getProblemPreprocessedJudgeInfo(problem))[0];
      const preprocessedJudgeInfo = submission.contestId
        ? {
            ...baseJudgeInfo,
            ...(submission.contestSubtaskAllOrNothing
              ? {
                  subtasks: (baseJudgeInfo as ProblemJudgeInfoTraditional).subtasks?.map(subtask => ({
                    ...subtask,
                    scoringType: "GroupMin",
                    allOrNothing: true
                  }))
                }
              : {}),
            fileIo: submission.contestInputFilename
              ? { inputFilename: submission.contestInputFilename, outputFilename: submission.contestOutputFilename }
              : null
          }
        : baseJudgeInfo;
      const testData: ProblemDataVersionFile[] = dataVersion
        ? dataVersion.testData
        : await this.problemService.getProblemFiles(problem, ProblemFileType.TestData);

      const problemTypeService = this.problemTypeFactoryService.type(problemType);

      const task = new JudgeTask<SubmissionTaskExtraInfo>(
        submission.taskId,
        JudgeTaskType.Submission,
        JudgeTaskPriorityType.High,
        priotity,
        {
          problemType,
          judgeInfo: preprocessedJudgeInfo,
          samples:
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            preprocessedJudgeInfo && (preprocessedJudgeInfo as ProblemJudgeInfoTraditional).runSamples
              ? [
                  ...(dataVersion
                    ? (dataVersion.samples as ProblemSampleData) ?? []
                    : (await this.problemService.getProblemSamples(problem)).slice(
                        0,
                        this.configService.config.resourceLimit.problemSamplesToRun
                      )),
                  ...((preprocessedJudgeInfo as ProblemJudgeInfoTraditional).hiddenSamples || []).map(sample => ({
                    inputFileUuid: testData.find(file => file.filename === sample.inputFile)?.uuid,
                    outputFileUuid: testData.find(file => file.filename === sample.outputFile)?.uuid,
                    hidden: true as const
                  }))
                ]
              : null,
          testData: Object.fromEntries(testData.map(problemFile => [problemFile.filename, problemFile.uuid])),
          submissionContent: submissionDetail.content,
          file: problemTypeService.shouldUploadAnswerFile()
            ? {
                uuid: submissionDetail.fileUuid,
                url: problemTypeService.shouldUploadAnswerFile()
                  ? await this.fileService.signDownloadLink({
                      uuid: submissionDetail.fileUuid,
                      downloadFilename: null,
                      expiresSeconds: JUDGE_FILE_DOWNLOAD_EXPIRE_TIME,
                      signFor: MinioSignFor.Judge
                    })
                  : null
              }
            : null
        }
      );
      // The content its data version recorded; the queue adds the recorded hashes of the other files
      const pinnedHashes = testData.filter(file => file.sha256).map(file => [file.uuid, file.sha256]);
      if (pinnedHashes.length !== 0) task.fileHashes = Object.fromEntries(pinnedHashes);
      return task;
    } catch (e) {
      logger.error(`Error in getTaskById("${taskId}"): ${e}`);
      throw e;
    }
  }

  /** The data version the submission is (being) judged with, and whether its problem still has that content. */
  async getSubmissionDataVersion(
    submission: SubmissionEntity,
    problem: ProblemEntity
  ): Promise<SubmissionDataVersionDto> {
    const dataVersion = await this.problemDataVersionService.findById(submission.problemDataVersionId);
    if (!dataVersion) return null;
    let current = false;
    try {
      current = await this.problemDataVersionService.isCurrent(problem, dataVersion);
    } catch (e) {
      logger.warn(`Couldn't compare the data version of submission ${submission.id}: ${e}`);
    }
    return { version: dataVersion.version, current };
  }

  /** What the submission's result was judged with, or `null` if it isn't recorded. */
  async getSubmissionJudgeRuntime(submission: SubmissionEntity): Promise<SubmissionJudgeRuntimeDto> {
    if (!submission.judgeRuntimeId || !this.judgeRuntimeService) return null;
    return (
      (await this.judgeRuntimeService.describe([submission.judgeRuntimeId])).get(submission.judgeRuntimeId) ?? null
    );
  }

  /** The results rejudges replaced, the most recent first. */
  async getEarlierResults(submission: SubmissionEntity): Promise<SubmissionEarlierResultDto[]> {
    const history = await this.connection.getRepository(SubmissionResultHistoryEntity).find({
      where: { submissionId: submission.id },
      order: { id: "DESC" }
    });
    const [versions, runtimes] = await Promise.all([
      this.problemDataVersionService.findVersionNumbers(history.map(result => result.problemDataVersionId)),
      this.judgeRuntimeService?.describe(history.map(result => result.judgeRuntimeId)) ?? new Map()
    ]);
    return history.map(result => ({
      status: result.status as SubmissionStatus,
      score: result.score,
      timeUsed: result.timeUsed,
      memoryUsed: result.memoryUsed,
      dataVersion: versions.get(result.problemDataVersionId) ?? null,
      judgeRuntime: runtimes.get(result.judgeRuntimeId) ?? null,
      replacedAt: result.replacedAt
    }));
  }

  async listActiveTasks(): Promise<{ taskId: string; priority: number }[]> {
    const submissions = await this.submissionRepository
      .createQueryBuilder()
      .select(["id", "taskId"])
      .where("taskId IS NOT NULL")
      .getRawMany<{ id: number; taskId: string }>();
    return submissions.map(({ id, taskId }) => ({
      taskId,
      priority: makeSubmissionPriority(id, 0, 0, 0, 0, JudgeTaskPriorityType.Medium)
    }));
  }

  /**
   * The judge queue gave up on the submission's task: show a system error, which can be rejudged.
   */
  async onTaskFailed(taskId: string, message: string): Promise<void> {
    const submission = await this.findSubmissionByTaskId(taskId);
    if (!submission) return;
    // eslint-disable-next-line @typescript-eslint/no-shadow
    await this.lockSubmission(submission, true, async submission => {
      if (!submission || submission.taskId !== taskId) return;
      const oldSubmission = { ...submission };
      const submissionDetail = await this.getSubmissionDetail(submission);
      const result: SubmissionFinishedProgress = {
        progressType: SubmissionProgressType.Finished,
        status: SubmissionStatus.SystemError,
        score: 0,
        totalOccupiedTime: 0,
        systemMessage: message
      };
      submissionDetail.result = result;
      submission.taskId = null;
      submission.status = SubmissionStatus.SystemError;
      submission.score = 0;
      submission.totalOccupiedTime = 0;
      submission.timeUsed = null;
      submission.memoryUsed = null;
      submission.judgeRuntimeId = null;
      let countChanges: number[] = [];
      await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
        await transactionalEntityManager.save(submission);
        await transactionalEntityManager.save(submissionDetail);
        countChanges = await this.statisticsOutboxService.record(transactionalEntityManager, oldSubmission, submission);
      });
      await this.statisticsOutboxService.apply(countChanges);
      logger.error(`Submission ${submission.id} could not be judged: ${message}`);
      await this.onSubmissionUpdated(oldSubmission, submission);
      await this.submissionProgressService.emitSubmissionEvent(submission.id, SubmissionEventType.Progress, result);
    });
  }

  /**
   * Lock a submission and its problem (optionally). Ensure the submission's `taskId` is not changed and its problem exists.
   */
  async lockSubmission<T>(
    submission: SubmissionEntity,
    lockProblem: boolean,
    callback: (submission: SubmissionEntity, problem?: ProblemEntity) => Promise<T>
  ): Promise<T> {
    if (lockProblem) {
      return await this.problemService.lockProblemById(submission.problemId, "Read", async problem => {
        if (!problem) return await callback(null);
        return await this.lockService.lock(
          `Submission_${submission.id}`,
          async () => await callback(await this.findSubmissionById(submission.id), problem)
        );
      });
    }
    return await this.lockService.lock(
      `Submission_${submission.id}`,
      async () => await callback(await this.findSubmissionById(submission.id))
    );
  }

  async getUserProblemAcceptedSubmissionCount(userId: number, problemId: number): Promise<number> {
    return await this.submissionRepository.countBy({
      submitterId: userId,
      problemId,
      status: SubmissionStatus.Accepted,
      contestId: IsNull()
    });
  }

  async getUserLatestSubmissionByProblems(
    user: UserEntity,
    problems: ProblemEntity[],
    acceptedOnly?: boolean
  ): Promise<Map<number, SubmissionEntity>> {
    if (
      problems.length === 0 ||
      !(await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ViewSubmission))
    )
      return new Map();

    const queryBuilder = this.submissionRepository
      .createQueryBuilder()
      .select("MAX(id)", "id")
      .where("submitterId = :submitterId", { submitterId: user.id })
      .andWhere("problemId IN (:...problemIds)", { problemIds: problems.map(problem => problem.id) })
      .andWhere("contestId IS NULL")
      .groupBy("problemId");
    const queryResult: { id: string }[] = await (acceptedOnly
      ? queryBuilder.andWhere("status = :status", { status: SubmissionStatus.Accepted })
      : queryBuilder.andWhere("status != :status", { status: SubmissionStatus.Pending })
    ).getRawMany();
    const submissionIds = queryResult.map(result => Number(result.id));
    const submissions = await this.findSubmissionsByExistingIds(submissionIds);
    return new Map(submissions.map(submission => [submission.problemId, submission]));
  }

  async problemHasAnySubmission(problem: ProblemEntity): Promise<boolean> {
    return (
      (await this.submissionRepository.countBy({
        problemId: problem.id
      })) !== 0
    );
  }

  /**
   * Cancel pending submissions when a problem is deleted.
   */
  async onDeleteProblem(problemId: number): Promise<void> {
    const pendingSubmissions = await this.submissionRepository
      .createQueryBuilder()
      .select()
      .where("problemId = :problemId", { problemId })
      .andWhere("contestId IS NULL")
      .andWhere("taskId IS NOT NULL")
      .getMany();
    await Promise.all(
      pendingSubmissions.map(async submission => {
        this.judgeGateway.cancelTask(submission.taskId);
        await this.submissionProgressService.emitSubmissionEvent(submission.id, SubmissionEventType.Deleted);
      })
    );
  }

  /**
   * Do some cleanups AFTER a problem is deleted.
   */
  async onProblemDeleted(problemId: number): Promise<void> {
    await this.submissionStatisticsService.onProblemDeleted(problemId);
  }
}
