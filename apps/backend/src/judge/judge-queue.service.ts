import { createHash } from "crypto";
import { EventEmitter } from "events";

import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager } from "typeorm";
import { Redis } from "ioredis";

import {
  JudgeTaskMeta,
  JudgeTaskPayload,
  JudgeTaskType,
  JudgeUploadTarget,
  SubmissionProgressType
} from "@libreoj/judge-protocol";

import { JudgeTaskCompletion, JudgeTaskService } from "./judge-task-service.interface";
import { JudgeTaskProgress } from "./judge-task-progress.interface";
import { JudgeJobAttemptEntity, JudgeJobAttemptOutcome, JudgeJobEntity, JudgeJobState } from "./judge-job.entity";

import { logger } from "../logger";
import { RedisService } from "../redis/redis.service";
import { MetricsService, sharedReading } from "../metrics/metrics.service";
import { FileService } from "../file/file.service";

// Smaller means higher priority
// With the same priority value, the smaller ID means higher priority
// A job's priority is its class minus a fraction below 1 (see makeSubmissionPriority), so the class is its rounding.
export enum JudgeTaskPriorityType {
  // Submissions to a contest that hasn't ended
  LiveContest = 0,
  // Other new submissions
  High = 1,
  // Rejudges and preparing self-evaluation
  Medium = 2,
  // Hacks and self-evaluation
  Low = 3,
  // AI runs
  Lowest = 4
}

/** The class of a job's priority. */
export function judgeTaskPriorityTypeOf(priority: number): JudgeTaskPriorityType {
  return Math.min(
    JudgeTaskPriorityType.Lowest,
    Math.max(JudgeTaskPriorityType.LiveContest, Math.round(Number(priority) || 0))
  );
}

// How the classes are named in metrics
const JUDGE_CLASS_NAMES: Record<JudgeTaskPriorityType, string> = {
  [JudgeTaskPriorityType.LiveContest]: "live_contest",
  [JudgeTaskPriorityType.High]: "practice",
  [JudgeTaskPriorityType.Medium]: "rejudge",
  [JudgeTaskPriorityType.Low]: "hack_and_self_evaluation",
  [JudgeTaskPriorityType.Lowest]: "ai"
};

// Jobs of the live contest class have a priority below this
const LIVE_CONTEST_PRIORITY_LIMIT = JudgeTaskPriorityType.LiveContest + 0.5;

/** What a judge thread may be given (see JudgeGateway.onConsumeTask). */
export interface JudgeClaimOptions {
  // Only submissions to running contests: the thread is kept for them
  liveContestOnly?: boolean;
  // Every AGED_TURN-th task goes to the job waiting longest, once it has waited this long (0: never)
  agingSeconds?: number;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface JudgeTaskExtraInfo {}

// Extra info is also send to judge client while ONLY meta is used to identity the task
export class JudgeTask<ExtraInfo extends JudgeTaskExtraInfo> implements JudgeTaskPayload<ExtraInfo> {
  // The recorded SHA-256 of the files it uses, by UUID (see `JudgeTaskPayload`)
  fileHashes?: Record<string, string>;

  constructor(
    public taskId: string, // Passed by the task creator, to indentify the task
    public type: JudgeTaskType,
    public priorityType: JudgeTaskPriorityType,
    public priority: number,
    public extraInfo: ExtraInfo
  ) {}

  getMeta(): JudgeTaskMeta {
    return {
      taskId: this.taskId,
      type: this.type
    };
  }
}

/** The judge client connection a job is leased to. */
export interface JudgeJobOwner {
  connectionId: string;
  judgeClientId: number;
  // The runtime it announced, if recorded
  judgeRuntimeId?: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The file UUIDs referenced anywhere in a task's payload
function collectUuids(value: unknown, result: Set<string>): void {
  if (typeof value === "string") {
    if (UUID_PATTERN.test(value)) result.add(value);
  } else if (Array.isArray(value)) value.forEach(item => collectUuids(item, result));
  else if (value && typeof value === "object") Object.values(value).forEach(item => collectUuids(item, result));
}

/** A task leased to a judge client connection. */
export interface LeasedJudgeTask {
  task: JudgeTask<JudgeTaskExtraInfo>;
  fence: number;
}

export interface JudgeJobSummary {
  taskId: string;
  type: string;
  state: JudgeJobState;
  createdAt: Date;
  judgeClientId: number;
  fence: number;
  unfinishedLeases: number;
  preparationFailures: number;
  lastError: string;
  finishedAt: Date;
}

export interface JudgeQueueStatus {
  queued: number;
  leased: number;
  failedRecently: number;
  oldestQueuedAt: Date;
  jobs: JudgeJobSummary[];
}

// A lease is renewed while its judge client stays connected to the backend process that granted it. If that process
// stops, the lease expires and the job is queued again.
const LEASE_SECONDS = 90;
export const LEASE_RENEW_INTERVAL = 30 * 1000;

// Expired leases are reclaimed this often. Every RECOVERY_EVERY_RECONCILES runs, active tasks without a job are
// recovered and old finished jobs are deleted.
const RECONCILE_INTERVAL = 15 * 1000;
const RECOVERY_EVERY_RECONCILES = 4;
const FINISHED_JOB_RETENTION_DAYS = 30;

// Waiting consumers are woken up by notifications, and look for jobs this often in case one is missed.
const POLL_INTERVAL = 5 * 1000;
const CLAIM_CANDIDATES = 8;
const MAX_CLAIM_ROUNDS = 10;

// One task in this many goes to a job that has waited longer than the aging time, so no class waits forever while
// new submissions still get most of the judging
const AGED_TURN = 5;

// Whether a contest is running is read this often
const LIVE_CONTEST_CACHE = 10 * 1000;

// A task whose preparation fails (e.g. the database is briefly unavailable) is retried with a growing delay, up to
// MAX_PREPARATION_FAILURES times (about 15 minutes).
const MAX_PREPARATION_FAILURES = 10;
const MAX_PREPARATION_RETRY_DELAY = 300;

// A task whose judging keeps being interrupted (e.g. it crashes judge clients) is given up on.
const MAX_UNFINISHED_LEASES = 5;

const REDIS_CHANNEL_JOBS_AVAILABLE = "judge-jobs-available";
const REDIS_KEY_RECONCILE_TURN = "judge-queue-reconcile";
// Before the durable queue, the queue itself was this Redis sorted set
const REDIS_KEY_LEGACY_JUDGE_QUEUE = "judge-queue";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The progress that ends a task: its result. */
export function isFinalProgress(progress: unknown): boolean {
  const value = progress as { progressType?: unknown; finished?: unknown };
  return !!value && (value.progressType === SubmissionProgressType.Finished || value.finished === true);
}

interface JudgeJobRow {
  taskId: string;
  type: string;
  priority: number;
  fence: number;
  createdAt: Date;
}

type ReleaseOutcome =
  JudgeJobAttemptOutcome.Disconnected | JudgeJobAttemptOutcome.Expired | JudgeJobAttemptOutcome.Abandoned;

/**
 * The judge queue, stored in the database (table `judge_job`). A job is added in the same transaction as its task's
 * resource, leased to one judge client connection at a time with an increasing fence, and finished in the same
 * transaction as its result. The jobs of judge clients that disconnect, and of backend processes that stop, are
 * queued again: a task is judged at least once, and its result is accepted once.
 */
@Injectable()
export class JudgeQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly redis: Redis;

  private readonly redisForSubscribe: Redis;

  private readonly taskServices: Map<JudgeTaskType, JudgeTaskService<JudgeTaskProgress, JudgeTaskExtraInfo>> =
    new Map();

  private readonly jobsAvailable = new EventEmitter();

  private reconcileTimer: ReturnType<typeof setInterval>;

  private reconcileRuns = 0;

  // Active task IDs without a queued or leased job in the previous recovery scan: recovered if still so.
  private tasksMissingJobs = new Set<string>();

  // Tasks this process gave out since the last one that went to an aged job
  private claimsSinceAged = 0;

  private liveContest: { running: Promise<boolean>; until: number } = null;

  @Optional() @Inject(FileService) private readonly fileService: FileService;

  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    private readonly redisService: RedisService,
    private readonly metricsService: MetricsService
  ) {
    this.redis = this.redisService.getClient();
    this.redisForSubscribe = this.redisService.getClient();
    this.jobsAvailable.setMaxListeners(0);
  }

  private readonly metricJudgeTaskQueueTime = this.metricsService.histogram(
    "libreoj_judge_task_queue_time_seconds",
    this.metricsService.histogram.BUCKETS_TIME_10M_30,
    ["type", "priority_type"]
  );

  // Read when the metrics are read, by one query for all of them
  private readonly queueReading = sharedReading(async () => {
    const [row]: Record<string, string | number | null>[] = await this.connection.query(
      `SELECT SUM(state = ?) AS queued, SUM(state = ?) AS leased, SUM(state = ? AND leaseUntil < NOW(3)) AS expiredLeases,
         TIMESTAMPDIFF(MICROSECOND, MIN(IF(state = ?, createdAt, NULL)), NOW(3)) / 1000000 AS oldestQueuedSeconds,
         SUM(state = ? AND finishedAt >= NOW(3) - INTERVAL 1 DAY) AS failedLastDay
       FROM judge_job WHERE state IN (?, ?, ?)`,
      [
        JudgeJobState.Queued,
        JudgeJobState.Leased,
        JudgeJobState.Leased,
        JudgeJobState.Queued,
        JudgeJobState.Failed,
        JudgeJobState.Queued,
        JudgeJobState.Leased,
        JudgeJobState.Failed
      ]
    );
    return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, Number(value ?? 0)]));
  });

  private readonly metricJudgeJobs = this.metricsService.gauge("libreoj_judge_jobs", ["state"], async gauge => {
    const reading = await this.queueReading();
    gauge.set({ state: JudgeJobState.Queued }, reading.queued);
    gauge.set({ state: JudgeJobState.Leased }, reading.leased);
  });

  // How long the oldest waiting job has waited (0 when none waits)
  private readonly metricOldestQueuedJob = this.metricsService.gauge(
    "libreoj_judge_oldest_queued_job_seconds",
    [],
    async gauge => gauge.set((await this.queueReading()).oldestQueuedSeconds)
  );

  // Leases that ran out but weren't recovered yet; recovery runs every 15 seconds, so this should stay near 0
  private readonly metricExpiredLeases = this.metricsService.gauge("libreoj_judge_expired_leases", [], async gauge =>
    gauge.set((await this.queueReading()).expiredLeases)
  );

  private readonly metricFailedJobs = this.metricsService.gauge("libreoj_judge_failed_jobs_last_day", [], async gauge =>
    gauge.set((await this.queueReading()).failedLastDay)
  );

  // Waiting jobs by class (see JudgeTaskPriorityType); a class with none reads 0
  private readonly metricQueuedByClass = this.metricsService.gauge(
    "libreoj_judge_queued_jobs_by_class",
    ["class"],
    async gauge => {
      const rows: { class: string | number; jobs: string | number }[] = await this.connection.query(
        `SELECT LEAST(?, GREATEST(?, ROUND(priority))) AS class, COUNT(*) AS jobs FROM judge_job
         WHERE state = ? GROUP BY 1`,
        [JudgeTaskPriorityType.Lowest, JudgeTaskPriorityType.LiveContest, JudgeJobState.Queued]
      );
      const counts = new Map(rows.map(row => [Number(row.class), Number(row.jobs)]));
      for (const [type, name] of Object.entries(JUDGE_CLASS_NAMES))
        gauge.set({ class: name }, counts.get(Number(type)) ?? 0);
    }
  );

  async onModuleInit(): Promise<void> {
    this.redisForSubscribe.on("message", () => this.jobsAvailable.emit("available"));
    await this.redisForSubscribe.subscribe(REDIS_CHANNEL_JOBS_AVAILABLE);
    await this.migrateLegacyQueue();
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch(e => logger.error(`Failed to reconcile the judge queue: ${e}`));
    }, RECONCILE_INTERVAL);
    this.reconcileTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.reconcileTimer);
    this.redisForSubscribe.disconnect();
    this.redis.disconnect();
  }

  registerTaskType<TaskProgress>(
    taskType: JudgeTaskType,
    service: JudgeTaskService<TaskProgress, JudgeTaskExtraInfo>
  ): void {
    this.taskServices.set(taskType, service);
  }

  /**
   * Adds the job of a new task; adding an existing job does nothing. Pass the transaction that saves the task's
   * resource so that both are committed together, then call `notifyJobsAvailable` once it has committed.
   */
  async enqueue(taskId: string, type: JudgeTaskType, priority: number, manager?: EntityManager): Promise<void> {
    logger.verbose(`New judge task: { taskId: ${taskId}, type: ${type}, priority: ${priority} }`);
    await (manager ?? this.connection.manager)
      .createQueryBuilder()
      .insert()
      .into(JudgeJobEntity)
      .values({
        taskId,
        type,
        priority,
        state: JudgeJobState.Queued,
        createdAt: () => "NOW(3)",
        availableAt: () => "NOW(3)",
        fence: 0,
        unfinishedLeases: 0,
        preparationFailures: 0
      })
      .orIgnore()
      .execute();
    if (!manager) this.notifyJobsAvailable();
  }

  /** Wakes up consumers waiting for jobs, in every backend process. */
  notifyJobsAvailable(): void {
    this.jobsAvailable.emit("available");
    this.redis
      .publish(REDIS_CHANNEL_JOBS_AVAILABLE, "1")
      .catch(e => logger.warn(`Failed to notify other backend processes of judge jobs: ${e}`));
  }

  /** Resolves when jobs may be available: on a notification, or after the polling interval. */
  async waitForJobs(): Promise<void> {
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> = null;
      const done = () => {
        clearTimeout(timer);
        this.jobsAvailable.off("available", done);
        resolve();
      };
      timer = setTimeout(done, POLL_INTERVAL * (0.75 + Math.random() / 2));
      this.jobsAvailable.once("available", done);
    });
  }

  /** Whether a contest is running now, as of at most a few seconds ago. */
  async liveContestRunning(): Promise<boolean> {
    if (!this.liveContest || this.liveContest.until <= Date.now()) {
      const running = this.connection
        .query("SELECT 1 FROM contest WHERE startTime <= NOW() AND endTime > NOW() LIMIT 1")
        .then((rows: unknown[]) => rows.length > 0);
      this.liveContest = { running, until: Date.now() + LIVE_CONTEST_CACHE };
      running.catch(() => {
        if (this.liveContest?.running === running) this.liveContest = null;
      });
    }
    return await this.liveContest.running;
  }

  /**
   * Leases the next available job of one of `taskTypes` to a judge client connection and prepares its task.
   * Returns `null` if there's no job to judge now.
   */
  async claim(
    owner: JudgeJobOwner,
    taskTypes: JudgeTaskType[] = Object.values(JudgeTaskType),
    options: JudgeClaimOptions = {}
  ): Promise<LeasedJudgeTask> {
    if (taskTypes.length === 0) return null;
    /* eslint-disable no-await-in-loop */
    for (let round = 0; round < MAX_CLAIM_ROUNDS; round++) {
      let candidates: JudgeJobRow[] = await this.connection.query(
        `SELECT taskId, type, priority, fence, createdAt FROM judge_job
         WHERE state = ? AND availableAt <= NOW(3) AND type IN (?)${options.liveContestOnly ? " AND priority < ?" : ""}
         ORDER BY priority, createdAt LIMIT ${CLAIM_CANDIDATES}`,
        [JudgeJobState.Queued, taskTypes, ...(options.liveContestOnly ? [LIVE_CONTEST_PRIORITY_LIMIT] : [])]
      );
      // An aged turn, unless a running contest's submission waits
      let agedIds = new Set<string>();
      if (
        options.agingSeconds > 0 &&
        !options.liveContestOnly &&
        this.claimsSinceAged >= AGED_TURN - 1 &&
        candidates.length > 0 &&
        Number(candidates[0].priority) >= LIVE_CONTEST_PRIORITY_LIMIT
      ) {
        const aged: JudgeJobRow[] = await this.connection.query(
          `SELECT taskId, type, priority, fence, createdAt FROM judge_job
           WHERE state = ? AND availableAt <= NOW(3) AND type IN (?) AND createdAt <= NOW(3) - INTERVAL ? SECOND
           ORDER BY createdAt LIMIT ${CLAIM_CANDIDATES}`,
          [JudgeJobState.Queued, taskTypes, options.agingSeconds]
        );
        agedIds = new Set(aged.map(job => job.taskId));
        // Nothing waited that long: look again after the next AGED_TURN tasks
        if (aged.length === 0) this.claimsSinceAged = 0;
        candidates = [...aged, ...candidates.filter(job => !agedIds.has(job.taskId))];
      }
      let contended = false;
      for (const job of candidates) {
        const fence = Number(job.fence) + 1;
        if (await this.lease(job, fence, owner)) {
          const task = await this.prepare(job, fence, owner);
          if (task) {
            this.claimsSinceAged = agedIds.has(job.taskId) ? 0 : this.claimsSinceAged + 1;
            return { task, fence };
          }
        } else contended = true;
      }
      // Every candidate was tried; if other consumers took some, there may be more jobs behind them
      if (!contended) return null;
    }
    /* eslint-enable no-await-in-loop */
    return null;
  }

  // Compare and swap: another consumer may have leased the job since it was read
  private async lease(job: JudgeJobRow, fence: number, owner: JudgeJobOwner): Promise<boolean> {
    return await this.connection.transaction("READ COMMITTED", async manager => {
      const { affected } = await manager
        .createQueryBuilder()
        .update(JudgeJobEntity)
        .set({
          state: JudgeJobState.Leased,
          fence,
          leaseOwner: owner.connectionId,
          judgeClientId: owner.judgeClientId,
          leaseUntil: () => `NOW(3) + INTERVAL ${LEASE_SECONDS} SECOND`
        })
        .where("taskId = :taskId AND state = :queued AND fence = :previousFence", {
          taskId: job.taskId,
          queued: JudgeJobState.Queued,
          previousFence: fence - 1
        })
        .execute();
      if (affected !== 1) return false;
      await manager
        .createQueryBuilder()
        .insert()
        .into(JudgeJobAttemptEntity)
        .values({
          taskId: job.taskId,
          fence,
          judgeClientId: owner.judgeClientId,
          judgeRuntimeId: owner.judgeRuntimeId ?? null,
          leaseOwner: owner.connectionId,
          startedAt: () => "NOW(3)"
        })
        .execute();
      return true;
    });
  }

  private async prepare(job: JudgeJobRow, fence: number, owner: JudgeJobOwner): Promise<JudgeTask<JudgeTaskExtraInfo>> {
    const taskInfo = `{ taskId: ${job.taskId}, type: ${job.type} }`;
    let task: JudgeTask<JudgeTaskExtraInfo>;
    try {
      const taskService = this.taskServices.get(job.type as JudgeTaskType);
      if (!taskService) throw new Error(`Unknown judge task type ${job.type}`);
      task = await taskService.getTaskToBeSentToJudgeByTaskId(job.taskId, Number(job.priority));
      if (task) await this.attachFileHashes(task);
    } catch (e) {
      await this.retryPreparation(job, fence, owner, e);
      return null;
    }

    if (!task) {
      logger.verbose(`Leased judge task ${taskInfo}, but it is no longer active, maybe canceled?`);
      await this.endLease(this.connection.manager, job.taskId, fence, owner.connectionId, JudgeJobState.Canceled);
      return null;
    }

    this.metricJudgeTaskQueueTime.observe(
      { type: task.type, priority_type: task.priorityType },
      Math.max(0, Date.now() - new Date(job.createdAt).getTime()) / 1000
    );
    logger.verbose(
      `Leased judge task ${taskInfo} with fence ${fence}, priority ${task.priority} (${
        JudgeTaskPriorityType[task.priorityType]
      })`
    );
    return task;
  }

  // The judge checks each file the task uses against its recorded content hash. Hashes the task's service gives (e.g.
  // those of its data version) are kept.
  private async attachFileHashes(task: JudgeTask<JudgeTaskExtraInfo>): Promise<void> {
    if (!this.fileService) return;
    const uuids = new Set<string>();
    collectUuids(task.extraInfo, uuids);
    if (uuids.size === 0) return;
    const fileHashes = { ...(await this.fileService.getContentHashes([...uuids])), ...task.fileHashes };
    if (Object.keys(fileHashes).length !== 0) task.fileHashes = fileHashes;
  }

  private async retryPreparation(job: JudgeJobRow, fence: number, owner: JudgeJobOwner, error: unknown) {
    const taskInfo = `{ taskId: ${job.taskId}, type: ${job.type} }`;
    const message = `Failed to prepare the task: ${error}`.slice(0, 255);
    const [row]: { preparationFailures: number }[] = await this.connection.query(
      "SELECT preparationFailures FROM judge_job WHERE taskId = ?",
      [job.taskId]
    );
    const failures = Number(row?.preparationFailures ?? 0) + 1;
    if (failures >= MAX_PREPARATION_FAILURES) {
      logger.error(`Failed to prepare judge task ${taskInfo} ${failures} times, giving up: ${error}`);
      await this.fail(job.taskId, message, {
        fence,
        connectionId: owner.connectionId,
        outcome: JudgeJobAttemptOutcome.NotPrepared
      });
      return;
    }
    const delay = Math.min(MAX_PREPARATION_RETRY_DELAY, 2 ** (failures - 1));
    logger.error(`Failed to prepare judge task ${taskInfo} (attempt ${failures}), retrying in ${delay}s: ${error}`);
    await this.endLease(
      this.connection.manager,
      job.taskId,
      fence,
      owner.connectionId,
      JudgeJobState.Queued,
      JudgeJobAttemptOutcome.NotPrepared,
      {
        preparationFailures: failures,
        lastError: message,
        availableAt: () => `NOW(3) + INTERVAL ${delay} SECOND`
      }
    );
  }

  /**
   * Ends the lease of a job, if `fence` and `connectionId` are still current, and changes its state.
   * @return Whether the lease was current.
   */
  private async endLease(
    manager: EntityManager,
    taskId: string,
    fence: number,
    connectionId: string,
    state: JudgeJobState,
    outcome: JudgeJobAttemptOutcome = state as unknown as JudgeJobAttemptOutcome,
    changes: Record<string, unknown> = {}
  ): Promise<boolean> {
    const terminal = state !== JudgeJobState.Queued;
    const { affected } = await manager
      .createQueryBuilder()
      .update(JudgeJobEntity)
      .set({
        state,
        leaseOwner: null,
        leaseUntil: null,
        ...(terminal ? { finishedAt: () => "NOW(3)" } : {}),
        ...changes
      })
      .where("taskId = :taskId AND fence = :fence AND state = :leased AND leaseOwner = :connectionId", {
        taskId,
        fence,
        leased: JudgeJobState.Leased,
        connectionId
      })
      .execute();
    if (affected !== 1) return false;
    await this.endAttempt(manager, taskId, fence, outcome);
    return true;
  }

  private async endAttempt(manager: EntityManager, taskId: string, fence: number, outcome: JudgeJobAttemptOutcome) {
    await manager
      .createQueryBuilder()
      .update(JudgeJobAttemptEntity)
      .set({ endedAt: () => "NOW(3)", outcome })
      .where("taskId = :taskId AND fence = :fence AND endedAt IS NULL", { taskId, fence })
      .execute();
  }

  /**
   * Queues a leased job again after its lease ended without a result. Does nothing if the lease isn't current any
   * more, e.g. because the job has finished.
   */
  async release(taskId: string, fence: number, connectionId: string, outcome: ReleaseOutcome): Promise<void> {
    const [job]: { unfinishedLeases: number }[] = await this.connection.query(
      "SELECT unfinishedLeases FROM judge_job WHERE taskId = ? AND fence = ? AND state = ? AND leaseOwner = ?",
      [taskId, fence, JudgeJobState.Leased, connectionId]
    );
    if (!job) return;
    const unfinishedLeases = Number(job.unfinishedLeases) + 1;
    if (unfinishedLeases >= MAX_UNFINISHED_LEASES) {
      logger.error(`Judging task ${taskId} was interrupted ${unfinishedLeases} times, giving up`);
      await this.fail(taskId, `Judging was interrupted ${unfinishedLeases} times`, { fence, connectionId, outcome });
      return;
    }
    const released = await this.endLease(
      this.connection.manager,
      taskId,
      fence,
      connectionId,
      JudgeJobState.Queued,
      outcome,
      { unfinishedLeases, availableAt: () => "NOW(3)" }
    );
    if (released) {
      logger.log(`Judge task ${taskId} is queued again (${outcome})`);
      this.notifyJobsAvailable();
    }
  }

  /** Gives up on a job, and lets its task's service show the failure. */
  private async fail(
    taskId: string,
    message: string,
    lease: { fence: number; connectionId: string; outcome: JudgeJobAttemptOutcome }
  ): Promise<void> {
    const failed = await this.connection.transaction(
      "READ COMMITTED",
      async manager =>
        await this.endLease(manager, taskId, lease.fence, lease.connectionId, JudgeJobState.Failed, lease.outcome, {
          lastError: message
        })
    );
    if (failed) await this.notifyTaskFailed(taskId, message);
  }

  private async notifyTaskFailed(taskId: string, message: string): Promise<void> {
    const [job]: { type: JudgeTaskType }[] = await this.connection.query(
      "SELECT type FROM judge_job WHERE taskId = ?",
      [taskId]
    );
    const taskService = job && this.taskServices.get(job.type);
    if (!taskService) return;
    try {
      await taskService.onTaskFailed(taskId, message);
    } catch (e) {
      // Retried by the next recovery scan
      logger.error(`Failed to mark judge task ${taskId} as failed: ${e}`);
    }
  }

  /**
   * Processes a task's progress from the connection holding its lease. Progress before the result is best-effort.
   * The result is stored together with finishing the job; the same result sent again is acknowledged again.
   *
   * @return `false` means the task is canceled, or this connection's lease is not current.
   */
  async onTaskProgress(
    taskMeta: JudgeTaskMeta,
    lease: { fence: number; connectionId: string; judgeRuntimeId?: number },
    progress: JudgeTaskProgress
  ): Promise<boolean> {
    const { taskId, type } = taskMeta;
    const taskService = this.taskServices.get(type);
    if (!taskService) return false;
    if (!isFinalProgress(progress)) return await taskService.onTaskProgress(taskId, progress);

    const resultHash = sha256(JSON.stringify(progress));
    const [job]: Pick<JudgeJobEntity, "state" | "fence" | "leaseOwner" | "resultHash">[] = await this.connection.query(
      "SELECT state, fence, leaseOwner, resultHash FROM judge_job WHERE taskId = ?",
      [taskId]
    );
    if (job?.state === JudgeJobState.Finished && Number(job.fence) === lease.fence) {
      // Sent again, e.g. because its acknowledgement was lost
      if (job.resultHash === resultHash) return true;
      logger.warn(`Rejected a different result for the finished judge task ${taskId}`);
      return false;
    }
    if (
      job?.state !== JudgeJobState.Leased ||
      Number(job.fence) !== lease.fence ||
      job.leaseOwner !== lease.connectionId
    ) {
      logger.warn(`Rejected the result of judge task ${taskId} from an obsolete lease (fence ${lease.fence})`);
      return false;
    }

    let confirmed = false;
    const completion: JudgeTaskCompletion = {
      judgeRuntimeId: lease.judgeRuntimeId ?? null,
      confirm: async manager => {
        confirmed = await this.endLease(
          manager,
          taskId,
          lease.fence,
          lease.connectionId,
          JudgeJobState.Finished,
          JudgeJobAttemptOutcome.Finished,
          { resultHash }
        );
        return confirmed;
      }
    };
    const accepted = await taskService.onTaskProgress(taskId, progress, completion);
    if (!accepted) {
      // The task is no longer active (e.g. canceled), or its result was invalid
      if (!confirmed)
        await this.endLease(this.connection.manager, taskId, lease.fence, lease.connectionId, JudgeJobState.Canceled);
      return false;
    }
    // Fallback for a task service that doesn't confirm in its own transaction
    if (!confirmed)
      await this.connection.transaction("READ COMMITTED", async manager => await completion.confirm(manager));
    return true;
  }

  /** Upload forms for the files a task generated, from the task's service; none if it doesn't take files. */
  async signTaskUploads(
    taskMeta: JudgeTaskMeta,
    files: { name: string; size: number }[]
  ): Promise<JudgeUploadTarget[]> {
    const taskService = this.taskServices.get(taskMeta.type);
    if (!taskService?.signUploads) return [];
    return await taskService.signUploads(taskMeta.taskId, files);
  }

  /** Cancels a task's job, e.g. when its submission is rejudged or deleted. */
  async cancel(taskId: string): Promise<void> {
    await this.connection.transaction("READ COMMITTED", async manager => {
      const [job]: { fence: number }[] = await manager.query(
        "SELECT fence FROM judge_job WHERE taskId = ? AND state IN (?, ?) FOR UPDATE",
        [taskId, JudgeJobState.Queued, JudgeJobState.Leased]
      );
      if (!job) return;
      await manager
        .createQueryBuilder()
        .update(JudgeJobEntity)
        .set({ state: JudgeJobState.Canceled, leaseOwner: null, leaseUntil: null, finishedAt: () => "NOW(3)" })
        .where("taskId = :taskId", { taskId })
        .execute();
      await this.endAttempt(manager, taskId, Number(job.fence), JudgeJobAttemptOutcome.Canceled);
    });
  }

  /**
   * Extends the leases of tasks sent to judge client connections of this backend process. A lease granted for a task
   * that never reached its judge client isn't listed, so it expires.
   */
  async renewLeases(leases: { taskId: string; connectionId: string }[]): Promise<void> {
    if (leases.length === 0) return;
    await this.connection
      .createQueryBuilder()
      .update(JudgeJobEntity)
      .set({ leaseUntil: () => `NOW(3) + INTERVAL ${LEASE_SECONDS} SECOND` })
      .where("state = :leased AND taskId IN (:...taskIds) AND leaseOwner IN (:...connectionIds)", {
        leased: JudgeJobState.Leased,
        taskIds: leases.map(lease => lease.taskId),
        connectionIds: [...new Set(leases.map(lease => lease.connectionId))]
      })
      .execute();
  }

  // One backend process reconciles at a time; if Redis is unavailable, all do (every step is idempotent).
  private async isReconcileTurn(): Promise<boolean> {
    try {
      return (
        (await this.redis.set(REDIS_KEY_RECONCILE_TURN, String(process.pid), "PX", RECONCILE_INTERVAL - 1000, "NX")) ===
        "OK"
      );
    } catch {
      return true;
    }
  }

  /**
   * Queues jobs whose lease expired again. Periodically also recovers active tasks without a job (e.g. queued by an
   * older release) and deletes old finished jobs.
   *
   * @param force Run every step now, in this process.
   */
  async reconcile(force = false): Promise<void> {
    if (!force && !(await this.isReconcileTurn())) return;

    const expired: { taskId: string; fence: number; leaseOwner: string }[] = await this.connection.query(
      "SELECT taskId, fence, leaseOwner FROM judge_job WHERE state = ? AND leaseUntil < NOW(3) LIMIT 1000",
      [JudgeJobState.Leased]
    );
    /* eslint-disable no-await-in-loop */
    for (const job of expired) {
      logger.warn(`The lease of judge task ${job.taskId} (fence ${job.fence}) expired`);
      await this.release(job.taskId, Number(job.fence), job.leaseOwner, JudgeJobAttemptOutcome.Expired);
    }
    /* eslint-enable no-await-in-loop */

    if (force || this.reconcileRuns++ % RECOVERY_EVERY_RECONCILES === 0) {
      await this.recoverActiveTasks(force);
      await this.deleteOldJobs();
    }
  }

  /**
   * @param immediately Recover a task missing its job now, rather than once it's found missing twice in a row (a
   * resource may be saved just before its job).
   */
  async recoverActiveTasks(immediately = false): Promise<void> {
    const stillMissing = new Set<string>();
    /* eslint-disable no-await-in-loop */
    for (const [type, taskService] of this.taskServices) {
      const active = await taskService.listActiveTasks();
      for (let i = 0; i < active.length; i += 500) {
        const chunk = active.slice(i, i + 500);
        const jobs: { taskId: string; state: JudgeJobState; lastError: string }[] = await this.connection.query(
          "SELECT taskId, state, lastError FROM judge_job WHERE taskId IN (?)",
          [chunk.map(task => task.taskId)]
        );
        const jobByTaskId = new Map(jobs.map(job => [job.taskId, job]));
        for (const { taskId, priority } of chunk) {
          const job = jobByTaskId.get(taskId);
          if (job?.state === JudgeJobState.Queued || job?.state === JudgeJobState.Leased) continue;
          if (!immediately && !this.tasksMissingJobs.has(taskId)) {
            stillMissing.add(taskId);
            continue;
          }
          if (!job) {
            logger.warn(`Judge task ${taskId} (${type}) is active but not queued, queueing it`);
            await this.enqueue(taskId, type, priority);
          } else {
            // The queue is done with a task its resource still waits for: give the resource a terminal state
            logger.warn(`Judge task ${taskId} (${type}) is still active although its job is ${job.state}`);
            try {
              await taskService.onTaskFailed(
                taskId,
                job.state === JudgeJobState.Failed && job.lastError ? job.lastError : "The task was not judged"
              );
            } catch (e) {
              logger.error(`Failed to mark judge task ${taskId} as failed: ${e}`);
            }
          }
        }
      }
    }
    /* eslint-enable no-await-in-loop */
    this.tasksMissingJobs = stillMissing;
  }

  private async deleteOldJobs(): Promise<void> {
    await this.connection.query(
      `DELETE FROM judge_job WHERE state IN (?, ?, ?)
       AND finishedAt < NOW(3) - INTERVAL ${FINISHED_JOB_RETENTION_DAYS} DAY LIMIT 1000`,
      [JudgeJobState.Finished, JudgeJobState.Canceled, JudgeJobState.Failed]
    );
    await this.connection.query(
      `DELETE FROM judge_job_attempt WHERE startedAt < NOW(3) - INTERVAL ${FINISHED_JOB_RETENTION_DAYS} DAY LIMIT 1000`
    );
  }

  /** Moves the tasks of the old Redis queue (a backend upgraded while tasks were queued) to the durable queue. */
  private async migrateLegacyQueue(): Promise<void> {
    try {
      const entries = await this.redis.zrange(REDIS_KEY_LEGACY_JUDGE_QUEUE, 0, -1, "WITHSCORES");
      /* eslint-disable no-await-in-loop */
      for (let i = 0; i < entries.length; i += 2) {
        try {
          const { taskId, type } = JSON.parse(entries[i]) as JudgeTaskMeta;
          if (typeof taskId === "string" && this.taskServices.has(type))
            await this.enqueue(taskId, type, Number(entries[i + 1]));
        } catch (e) {
          logger.warn(`Dropped an invalid entry of the old judge queue: ${e}`);
        }
      }
      /* eslint-enable no-await-in-loop */
      if (entries.length) {
        await this.redis.del(REDIS_KEY_LEGACY_JUDGE_QUEUE);
        logger.log(`Moved ${entries.length / 2} tasks from the old judge queue`);
      }
    } catch (e) {
      // Their tasks are still recovered from their resources
      logger.error(`Failed to move the old judge queue: ${e}`);
    }
  }

  /** For site administrators: the jobs waiting or being judged, and recent failures. */
  async getStatus(): Promise<JudgeQueueStatus> {
    const [counts]: { queued: number; leased: number; failedRecently: number; oldestQueuedAt: Date }[] =
      await this.connection.query(
        `SELECT SUM(state = ?) AS queued, SUM(state = ?) AS leased,
           SUM(state = ? AND finishedAt >= NOW(3) - INTERVAL 7 DAY) AS failedRecently,
           MIN(IF(state = ?, createdAt, NULL)) AS oldestQueuedAt
         FROM judge_job WHERE state IN (?, ?, ?)`,
        [
          JudgeJobState.Queued,
          JudgeJobState.Leased,
          JudgeJobState.Failed,
          JudgeJobState.Queued,
          JudgeJobState.Queued,
          JudgeJobState.Leased,
          JudgeJobState.Failed
        ]
      );
    const jobs: JudgeJobSummary[] = await this.connection.query(
      `SELECT taskId, type, state, createdAt, judgeClientId, fence, unfinishedLeases, preparationFailures, lastError,
         finishedAt
       FROM judge_job
       WHERE state IN (?, ?) OR (state = ? AND finishedAt >= NOW(3) - INTERVAL 7 DAY)
       ORDER BY state = ? DESC, createdAt LIMIT 100`,
      [JudgeJobState.Queued, JudgeJobState.Leased, JudgeJobState.Failed, JudgeJobState.Leased]
    );
    return {
      queued: Number(counts?.queued ?? 0),
      leased: Number(counts?.leased ?? 0),
      failedRecently: Number(counts?.failedRecently ?? 0),
      oldestQueuedAt: counts?.oldestQueuedAt ?? null,
      jobs: jobs.map(job => ({
        ...job,
        judgeClientId: job.judgeClientId ?? null,
        fence: Number(job.fence),
        unfinishedLeases: Number(job.unfinishedLeases),
        preparationFailures: Number(job.preparationFailures)
      }))
    };
  }
}
