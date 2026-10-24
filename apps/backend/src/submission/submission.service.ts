import { createHash } from "crypto";

import { Injectable, Inject, forwardRef, Optional } from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";

import { Repository, DataSource, IsNull, EntityManager } from "typeorm";
import { ValidationError } from "class-validator";
import moment from "moment-timezone";

import { SubmissionStatus } from "@libreoj/judge-protocol";

import { SubmissionContent } from "./submission-content.interface";
import { submissionDisplayProgress } from "./submission-display-progress";

import { SubmissionProgressService, SubmissionEventType } from "./submission-progress.service";

import { SubmissionStatisticsService } from "./submission-statistics.service";
import { SubmissionJudgingService } from "./submission-judging.service";

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

import { logger } from "../logger";
import { UserEntity } from "../user/user.entity";
import { ProblemEntity } from "../problem/problem.entity";
import { JudgeQueueService } from "../judge/judge-queue.service";
import { ProblemDataVersionService } from "../problem/problem-data-version.service";
import { TestDataRetentionService } from "../problem/test-data-retention.service";
import { JudgeGateway } from "../judge/judge.gateway";
import { JudgeRuntimeService } from "../judge/judge-runtime.service";
import { ProblemTypeFactoryService } from "../problem-type/problem-type-factory.service";
import { AuditLogObjectType, AuditService } from "../audit/audit.service";
import { FileService } from "../file/file.service";
import { ConfigService } from "../config/config.service";
import { FileEntity } from "../file/file.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";

import { teamResourceVisibilitySql } from "../team/team-access";

import { FileUploadInfoDto, SignedFileUploadRequestDto } from "../file/dto";

/**
 * Submissions: taking them (admission), reading and listing them, and the changes people make to them (publicness,
 * fake, hack, deletion). Who may do what is `SubmissionAccessService`; judging and results are
 * `SubmissionJudgingService`.
 */
@Injectable()
export class SubmissionService {
  @Optional() @Inject(JudgeRuntimeService) private readonly judgeRuntimeService: JudgeRuntimeService;

  constructor(
    @InjectDataSource()
    private connection: DataSource,
    @InjectRepository(SubmissionEntity)
    private readonly submissionRepository: Repository<SubmissionEntity>,
    @InjectRepository(SubmissionDetailEntity)
    private readonly submissionDetailRepository: Repository<SubmissionDetailEntity>,
    private readonly problemTypeFactoryService: ProblemTypeFactoryService,
    private readonly judgeQueueService: JudgeQueueService,
    private readonly submissionJudgingService: SubmissionJudgingService,
    private readonly submissionProgressService: SubmissionProgressService,
    private readonly submissionStatisticsService: SubmissionStatisticsService,
    private readonly judgeGateway: JudgeGateway,
    private readonly auditService: AuditService,
    private readonly fileService: FileService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => UserPrivilegeService))
    private readonly userPrivilegeService: UserPrivilegeService,
    @Inject(forwardRef(() => ProblemDataVersionService))
    private readonly problemDataVersionService: ProblemDataVersionService,
    private readonly statisticsOutboxService: StatisticsOutboxService,
    @Inject(forwardRef(() => TestDataRetentionService))
    private readonly testDataRetentionService: TestDataRetentionService
  ) {
    this.auditService.registerObjectTypeQueryHandler(AuditLogObjectType.Submission, async submissionId => {
      const submission = await this.findSubmissionById(submissionId);
      return !submission ? null : await this.getSubmissionBasicMeta(submission);
    });
  }

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
        "FILE_UUID_EXISTS" | "FILE_NOT_UPLOADED" | "FILE_TOO_LARGE" | SignedFileUploadRequestDto,
      submission: SubmissionEntity
    ]
  > {
    const problemTypeService = this.problemTypeFactoryService.type(problem.type);
    const dataVersion = await this.submissionJudgingService.dataVersionToPin(problem);
    let countChanges: number[] = [];

    const [fileUploadErrorOrRequest, submission] = await this.connection.transaction<
      [
        fileUploadErrorOrRequest:
          "FILE_UUID_EXISTS" | "FILE_NOT_UPLOADED" | "FILE_TOO_LARGE" | SignedFileUploadRequestDto,
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
      // The sealed copy of the answer, not the upload
      submissionDetail.fileUuid = file?.uuid;
      submissionDetail.result = null;
      await transactionalEntityManager.save(submissionDetail);

      // The submission and its judge task are committed together, so a new submission is never left unjudged.
      await this.submissionJudgingService.queueJudgeTask(submission, false, transactionalEntityManager);
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

  async setSubmissionPublic(submission: SubmissionEntity, isPublic: boolean): Promise<void> {
    submission.isPublic = isPublic;
    await this.submissionRepository.save(submission);
  }

  async fakeSubmission(submission: SubmissionEntity, actingUserId: number): Promise<boolean> {
    // Share the same locks as judge completion/rejudge, and re-read the effective verdict.
    return await this.submissionJudgingService.lockSubmission(submission, true, async lockedSubmission => {
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
      await this.submissionStatisticsService.onSubmissionUpdated(oldSubmission, lockedSubmission);
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
    return await this.submissionJudgingService.lockSubmission(submission, true, async locked => {
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
      await this.submissionStatisticsService.onSubmissionUpdated(old, locked);
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
    await this.submissionJudgingService.lockSubmission(submission, true, async submission => {
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
      await this.submissionStatisticsService.onSubmissionUpdated(submission, null);
    });
    if (deleteFileActually) deleteFileActually();
  }

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
    const testData = (await this.testDataRetentionService.describeAvailability([dataVersion.id])).get(dataVersion.id);
    return { version: dataVersion.version, current, testData };
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
    const versionIds = history.map(result => result.problemDataVersionId);
    const [versions, testData, runtimes] = await Promise.all([
      this.problemDataVersionService.findVersionNumbers(versionIds),
      this.testDataRetentionService.describeAvailability(versionIds),
      this.judgeRuntimeService?.describe(history.map(result => result.judgeRuntimeId)) ?? new Map()
    ]);
    return history.map(result => ({
      status: result.status as SubmissionStatus,
      score: result.score,
      timeUsed: result.timeUsed,
      memoryUsed: result.memoryUsed,
      dataVersion: versions.get(result.problemDataVersionId) ?? null,
      testData: testData.get(result.problemDataVersionId),
      judgeRuntime: runtimes.get(result.judgeRuntimeId) ?? null,
      replacedAt: result.replacedAt
    }));
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
    const queryResult: { id: string }[] = await (
      acceptedOnly
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
