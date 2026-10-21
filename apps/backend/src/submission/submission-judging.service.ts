import { Injectable, Inject, forwardRef, ForbiddenException } from "@nestjs/common";
import { InjectRepository, InjectDataSource } from "@nestjs/typeorm";

import { Repository, DataSource, QueryBuilder, EntityManager } from "typeorm";
import { v4 as uuid } from "uuid";

import { JudgeTaskType, SubmissionStatus } from "@libreoj/judge-protocol";

import {
  SubmissionFinishedProgress,
  SubmissionProgress,
  SubmissionProgressType
} from "./submission-progress.interface";

import { SubmissionContent } from "./submission-content.interface";
import { makeSubmissionPriority } from "./submission-priority";

import { SubmissionProgressService, SubmissionEventType } from "./submission-progress.service";
import { SubmissionStatisticsService } from "./submission-statistics.service";
import { SubmissionAccessService, SubmissionPermissionType } from "./submission-access.service";

import { SubmissionEntity } from "./submission.entity";
import { SubmissionDetailEntity } from "./submission-detail.entity";
import { SubmissionResultHistoryEntity } from "./submission-result-history.entity";
import { StatisticsOutboxService } from "./statistics-outbox.service";

import type { ProblemJudgeInfoTraditional } from "../problem-type/types/traditional/problem-judge-info.interface";

import { logger } from "../logger";
import { ProblemService } from "../problem/problem.service";
import { ProblemFileService } from "../problem/problem-file.service";
import { ProblemLockService } from "../problem/problem-lock.service";
import { UserEntity } from "../user/user.entity";
import { ProblemEntity, ProblemType } from "../problem/problem.entity";
import {
  JudgeQueueService,
  JudgeTaskPriorityType,
  JudgeTask,
  JudgeTaskExtraInfo,
  judgeTaskPriorityTypeOf
} from "../judge/judge-queue.service";
import { JudgeTaskCompletion, JudgeTaskService } from "../judge/judge-task-service.interface";
import { ProblemFileType } from "../problem/problem-file.entity";
import { ProblemDataVersionService } from "../problem/problem-data-version.service";
import { ProblemDataVersionEntity, ProblemDataVersionFile } from "../problem/problem-data-version.entity";
import { ProblemJudgeInfo } from "../problem/problem-judge-info.interface";
import { ProblemSampleData } from "../problem/problem-sample-data.interface";
import { LockService } from "../redis/lock.service";
import { JudgeGateway } from "../judge/judge.gateway";
import { ProblemTypeFactoryService } from "../problem-type/problem-type-factory.service";
import { MinioSignFor, FileService, JUDGE_FILE_DOWNLOAD_EXPIRE_TIME } from "../file/file.service";
import { ConfigService } from "../config/config.service";

import { MetricsService } from "../metrics/metrics.service";

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

/**
 * A submission's judging: its judge task in the durable queue (queued, sent to judges, rejudged, canceled), the
 * progress judges report, and its final result. It also owns the submission lock that orders judging against the
 * other changes to a submission's verdict (fake, hack, deletion).
 */
@Injectable()
export class SubmissionJudgingService implements JudgeTaskService<SubmissionProgress, SubmissionTaskExtraInfo> {
  constructor(
    @InjectDataSource()
    private connection: DataSource,
    @InjectRepository(SubmissionEntity)
    private readonly submissionRepository: Repository<SubmissionEntity>,
    @InjectRepository(SubmissionDetailEntity)
    private readonly submissionDetailRepository: Repository<SubmissionDetailEntity>,
    private readonly problemService: ProblemService,
    private readonly problemFiles: ProblemFileService,
    private readonly problemLocks: ProblemLockService,
    private readonly problemTypeFactoryService: ProblemTypeFactoryService,
    private readonly judgeQueueService: JudgeQueueService,
    private readonly lockService: LockService,
    private readonly submissionProgressService: SubmissionProgressService,
    private readonly submissionStatisticsService: SubmissionStatisticsService,
    private readonly submissionAccessService: SubmissionAccessService,
    private readonly judgeGateway: JudgeGateway,
    private readonly fileService: FileService,
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService,
    @Inject(forwardRef(() => ProblemDataVersionService))
    private readonly problemDataVersionService: ProblemDataVersionService,
    private readonly statisticsOutboxService: StatisticsOutboxService
  ) {
    this.judgeQueueService.registerTaskType(JudgeTaskType.Submission, this);
  }

  private readonly metricSubmissionJudgeTime = this.metricsService.histogram(
    "libreoj_submission_judge_time_seconds",
    this.metricsService.histogram.BUCKETS_TIME_10M_30
  );

  private async findSubmissionById(submissionId: number): Promise<SubmissionEntity> {
    return await this.submissionRepository.findOneBy({ id: submissionId });
  }

  private async findSubmissionByTaskId(taskId: string): Promise<SubmissionEntity> {
    return await this.submissionRepository.findOneBy({ taskId });
  }

  private async getSubmissionDetail(submission: SubmissionEntity): Promise<SubmissionDetailEntity> {
    return await this.submissionDetailRepository.findOneBy({ submissionId: submission.id });
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

    await this.submissionStatisticsService.onSubmissionUpdated(oldSubmission, submission);
  }

  /**
   * The problem's current data version to judge a submission with, or `null` (judged with the current data when its
   * task is sent, as before data versions) if it can't be taken.
   */
  async dataVersionToPin(problem: ProblemEntity): Promise<ProblemDataVersionEntity> {
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
  async queueJudgeTask(
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
        isRejudge
          ? JudgeTaskPriorityType.Medium
          : (await this.isLiveContestSubmission(submission, transactionalEntityManager))
            ? JudgeTaskPriorityType.LiveContest
            : JudgeTaskPriorityType.High
      ),
      transactionalEntityManager
    );
  }

  /** A new submission to a contest that hasn't ended is judged before practice (see JudgeTaskPriorityType). */
  private async isLiveContestSubmission(submission: SubmissionEntity, manager: EntityManager): Promise<boolean> {
    if (!submission.contestId) return false;
    const rows: unknown[] = await manager.query("SELECT 1 FROM contest WHERE id = ? AND endTime > NOW()", [
      submission.contestId
    ]);
    return rows.length > 0;
  }

  async rejudgeSubmission(submission: SubmissionEntity, actingUser?: UserEntity): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-shadow
    await this.lockSubmission(submission, true, async (submission, problem) => {
      if (!submission) return;

      // A fake may have been applied after the caller's initial permission check.
      if (
        [SubmissionStatus.Fake, SubmissionStatus.Hacked].includes(submission.status) &&
        (!actingUser ||
          !(await this.submissionAccessService.userHasPermission(
            actingUser,
            submission,
            SubmissionPermissionType.Rejudge
          )))
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

      await this.submissionStatisticsService.onSubmissionUpdated(oldSubmission, submission);

      return true;
    });

    if (!canceled) return;

    await this.submissionProgressService.emitSubmissionEvent(submission.id, SubmissionEventType.Canceled);
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

    await this.submissionStatisticsService.onSubmissionUpdated(oldSubmission, submission);
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
        : await this.problemFiles.getProblemFiles(problem, ProblemFileType.TestData);

      const problemTypeService = this.problemTypeFactoryService.type(problemType);

      const task = new JudgeTask<SubmissionTaskExtraInfo>(
        submission.taskId,
        JudgeTaskType.Submission,
        judgeTaskPriorityTypeOf(priotity),
        priotity,
        {
          problemType,
          judgeInfo: preprocessedJudgeInfo,
          samples:
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            preprocessedJudgeInfo && (preprocessedJudgeInfo as ProblemJudgeInfoTraditional).runSamples
              ? [
                  ...(dataVersion
                    ? ((dataVersion.samples as ProblemSampleData) ?? [])
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
      await this.submissionStatisticsService.onSubmissionUpdated(oldSubmission, submission);
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
      return await this.problemLocks.lockProblemById(submission.problemId, "Read", async problem => {
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
}
