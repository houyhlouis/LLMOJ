import { randomUUID } from "crypto";

import {
  Inject as AuditInject,
  Optional as AuditOptional,
  Injectable,
  Inject,
  OnModuleInit,
  OnModuleDestroy
} from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { DataSource, EntityManager, In, Repository } from "typeorm";

import { AiJobEntity } from "./ai.entity";
import { AiError } from "./ai.types";
import { isAllowedPrivateHost } from "./ai-provider";
import { StartAiJobDto } from "./ai.dto";
import { importSourceCandidates } from "./ai-source-search";
import { AiResponseCheckpointEntity } from "./ai-usage.entity";

import { AiUsageService } from "./ai-usage.service";
import { AiAdmissionService } from "./ai-admission.service";
import { AiConfigurationService } from "./ai-configuration.service";

import { withAiRuntime, aiWorkerLockName } from "./ai-runtime";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { AiPolicy, AiPolicyService, DEFAULT_AI_POLICY } from "../settings/ai-policy.service";
import { AiEndpointPolicyService, aiEndpointRefusal } from "../settings/ai-endpoint-policy.service";
import { ProblemService } from "../problem/problem.service";
import { ProblemAccessService, ProblemPermissionType } from "../problem/problem-access.service";
import { ProblemEntity } from "../problem/problem.entity";
import { logger } from "../logger";
import { MetricsService, sharedReading } from "../metrics/metrics.service";

import { AuditService, AuditLogObjectType } from "../audit/audit.service";

/** Runs a job's steps; the workflow service registers itself. */
export interface AiWorkflowRunner {
  execute(job: AiJobEntity): Promise<void>;
}

/**
 * Runs AI jobs: claims queued jobs under the database lock, within each owner's and the site's limits, and gives
 * each run a token. Every step of a run rechecks that the run still holds its job and that the owner still has the
 * permissions the job needs (`assertJob`), and saves its progress under the same token (`checkpoint`). Cancelled jobs
 * stop at once; paused jobs return to the queue; failures are recorded without replacing what a step committed.
 */
@Injectable()
export class AiJobCoordinator implements OnModuleInit, OnModuleDestroy {
  @AuditOptional() @AuditInject(AuditService) private readonly aiAudit?: AuditService;

  @Inject(AiUsageService) private readonly usage: AiUsageService;

  @Inject(AiAdmissionService) private readonly admission: AiAdmissionService;

  @Inject(AiPolicyService) private readonly policies: AiPolicyService;

  @AuditOptional() @Inject(AiEndpointPolicyService) private readonly endpointPolicies?: AiEndpointPolicyService;

  @AuditOptional() @Inject(MetricsService) private readonly metricsService: MetricsService;

  private metricWorkerErrors: { inc(labels: { stage: string }): void };

  private workerErrorLoggedAt = -Infinity;

  private timer: ReturnType<typeof setInterval>;

  private busy = false;

  private stopped = false;

  private activeRuns = new Map<string, AbortController>();

  private workflow: AiWorkflowRunner;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectRepository(AiJobEntity) private readonly jobs: Repository<AiJobEntity>,
    private readonly privileges: UserPrivilegeService,
    private readonly problems: ProblemService,
    private readonly problemAccess: ProblemAccessService,
    private readonly configuration: AiConfigurationService
  ) {}

  registerWorkflow(workflow: AiWorkflowRunner) {
    this.workflow = workflow;
  }

  async onModuleInit() {
    await this.configuration.loadKey();
    this.registerMetrics();
    // Deployment has one backend process; a DB advisory lock also protects future clustered workers.
    this.timer = setInterval(() => {
      this.work().catch(e => this.workerFailed("worker", e));
    }, 2000);
    this.timer.unref();
  }

  onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  /** Looks for queued jobs now, without waiting for the next poll. */
  wake() {
    this.work().catch(e => this.workerFailed("worker", e));
  }

  /**
   * Queues a job for the user. A problem has at most one active job: the user's own job with the same action is
   * returned instead of a new one. A user has at most 100 active jobs.
   */
  async enqueue(user: UserEntity, input: StartAiJobDto): Promise<AiJobEntity> {
    return await this.db.transaction(async manager => {
      await manager.findOne(UserEntity, { where: { id: user.id }, lock: { mode: "pessimistic_write" } });
      const repository = manager.getRepository(AiJobEntity);
      if (input.problemId) {
        await manager.findOne(ProblemEntity, { where: { id: input.problemId }, lock: { mode: "pessimistic_write" } });
        const existing = await repository.findOneBy({ problemId: input.problemId, status: In(["queued", "running"]) });
        if (existing) {
          if (existing.ownerId === user.id && (input.automatic || existing.action === input.action)) return existing;
          throw new AiError("PROBLEM_AI_BUSY");
        }
      }
      if ((await repository.countBy({ ownerId: user.id, status: In(["queued", "running"]) })) >= 100)
        throw new AiError("TOO_MANY_ACTIVE_JOBS");
      return await repository.save({
        id: randomUUID(),
        ownerId: user.id,
        problemId: input.problemId || null,
        action: input.action,
        status: "queued",
        step: "queued",
        progress: 0,
        input: {
          count: input.count || 20,
          markdown: input.markdown,
          image: input.image,
          attachmentToken: input.attachmentToken,
          problemType: input.problemType,
          communicationMode: input.communicationMode
        },
        state: { completed: [], sourceHints: importSourceCandidates(input.markdown || "") },
        error: null
      });
    });
  }

  /** Cancels the user's job if it's queued or running, and stops its run at once. */
  async cancel(user: UserEntity, id: string) {
    const job = await this.jobs.findOneBy({ id, ownerId: user.id });
    if (!job) throw new AiError("NO_SUCH_JOB");
    if (["queued", "running"].includes(job.status)) {
      const cancelled = await this.jobs.update(
        { id, ownerId: user.id, status: In(["queued", "running"]) },
        { status: "cancelled", step: "cancelled" }
      );
      if (cancelled.affected) {
        this.cancelRun(id);
        await this.recordAiAudit(user, "job.cancel", job);
      }
    }
  }

  /** Queues the user's failed job again, with the state it resumes from. */
  async requeue(user: UserEntity, job: AiJobEntity, retryState: () => AiJobEntity["state"]) {
    await this.db.transaction(async manager => {
      await manager.findOne(UserEntity, { where: { id: user.id }, lock: { mode: "pessimistic_write" } });
      const repository = manager.getRepository(AiJobEntity);
      if ((await repository.countBy({ ownerId: user.id, status: In(["queued", "running"]) })) >= 100)
        throw new AiError("TOO_MANY_ACTIVE_JOBS");
      if (job.problemId) {
        await manager.findOne(ProblemEntity, { where: { id: job.problemId }, lock: { mode: "pessimistic_write" } });
        if (await repository.findOneBy({ problemId: job.problemId, status: In(["queued", "running"]) }))
          throw new AiError("PROBLEM_AI_BUSY");
      }
      // Recovery retries keep the same paid response; a deliberate semantic/expired retry must
      // permit a fresh generation rather than replaying an already rejected model result forever.
      if (!job.error?.startsWith("RESPONSE_RECOVERY_INTERRUPTED"))
        await manager.delete(AiResponseCheckpointEntity, { ownerId: user.id, jobId: job.id });
      const updated = await repository.update(
        { id: job.id, ownerId: user.id, status: "failed" },
        { status: "queued", error: null, state: retryState() }
      );
      if (!updated.affected) throw new AiError("JOB_NOT_FAILED");
    });
  }

  /**
   * Saves changes to the job in the caller's transaction, together with what the step publishes there, if this run
   * still holds the job.
   */
  async saveInTransaction(
    manager: EntityManager,
    job: AiJobEntity,
    changes: { state?: AiJobEntity["state"]; problemId?: number }
  ) {
    const saved = await manager.update(
      AiJobEntity,
      { id: job.id, status: "running", ...(job.runToken ? { runToken: job.runToken } : {}) },
      changes
    );
    if (saved.affected === 0) throw new AiError("JOB_LEASE_LOST");
  }

  /** Stops a cancelled job's run at once: its provider requests and programs are aborted. */
  cancelRun(id: string) {
    this.activeRuns?.get(id)?.abort(new AiError("JOB_CANCELLED"));
  }

  async recordAiAudit(
    actor: UserEntity | number,
    action: string,
    job?: AiJobEntity,
    details: Record<string, unknown> = {}
  ) {
    if (!this.aiAudit) return;
    const userId = typeof actor === "number" ? actor : actor.id;
    const safe = { ...details, origin: "AI", ...(job ? { jobId: job.id, action: job.action } : {}) };
    if (job?.problemId) await this.aiAudit.log(userId, `ai.${action}`, AuditLogObjectType.Problem, job.problemId, safe);
    else await this.aiAudit.log(userId, `ai.${action}`, safe);
  }

  async requirePrivilege(user: UserEntity, privilege: UserPrivilegeType, manager?: EntityManager) {
    if (!user || !(await this.privileges.userHasPrivilege(user, privilege, manager)))
      throw new AiError("PERMISSION_DENIED");
  }

  /** Jobs and provider requests, read when the metrics are read. */
  private registerMetrics() {
    if (!this.metricsService) return;
    this.metricWorkerErrors = this.metricsService.counter("libreoj_ai_worker_errors", ["stage"]);
    const jobs = sharedReading(async () => {
      const [row]: Record<string, string | number | null>[] = await this.db.query(
        `SELECT SUM(status = 'queued') AS queued, SUM(status = 'running') AS running,
           TIMESTAMPDIFF(MICROSECOND, MIN(IF(status = 'queued', createdAt, NULL)), NOW(6)) / 1000000 AS oldestQueuedSeconds
         FROM ai_job WHERE status IN ('queued', 'running')`
      );
      return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, Number(value ?? 0)]));
    });
    this.metricsService.gauge("libreoj_ai_jobs", ["state"], async gauge => {
      const reading = await jobs();
      gauge.set({ state: "queued" }, reading.queued);
      gauge.set({ state: "running" }, reading.running);
    });
    this.metricsService.gauge("libreoj_ai_oldest_queued_job_seconds", [], async gauge =>
      gauge.set((await jobs()).oldestQueuedSeconds)
    );
    this.metricsService.gauge("libreoj_ai_provider_requests", ["state"], gauge => {
      const load = this.admission.load();
      gauge.set({ state: "running" }, load.running);
      gauge.set({ state: "waiting" }, load.waiting);
    });
    this.metricsService.gauge("libreoj_ai_paused", [], async gauge => gauge.set((await this.policy()).paused ? 1 : 0));
    // Requests whose usage the provider never reported: they count at their reserved maximum (see AiAdmissionService)
    this.metricsService.gauge("libreoj_ai_unreported_usage_last_day", [], async gauge => {
      const [row]: { count: string | number }[] = await this.db.query(
        "SELECT COUNT(*) AS count FROM ai_reservation WHERE settledAt IS NOT NULL AND createdAt >= NOW() - INTERVAL 1 DAY"
      );
      gauge.set(Number(row?.count ?? 0));
    });
    if (this.endpointPolicies) {
      this.metricsService.gauge("libreoj_ai_approved_endpoints", [], async gauge =>
        gauge.set((await this.endpointPolicies.current()).endpoints.length)
      );
      this.metricsService.gauge("libreoj_ai_approved_endpoints_only", [], async gauge =>
        gauge.set((await this.endpointPolicies.current()).customEndpoints === "approved" ? 1 : 0)
      );
    }
  }

  /**
   * Errors of the job scheduler or an internal error of a job: counted, and logged at most once a minute by their type
   * only (an AI error's message may quote provider output).
   */
  private workerFailed(stage: "worker" | "job", error: unknown, jobId?: string) {
    this.metricWorkerErrors?.inc({ stage });
    if (Date.now() - this.workerErrorLoggedAt < 60 * 1000) return;
    this.workerErrorLoggedAt = Date.now();
    const code =
      (error as { code?: unknown })?.code ?? (error as { driverError?: { code?: unknown } })?.driverError?.code;
    const type = `${error?.constructor?.name ?? typeof error}${typeof code === "string" ? ` ${code}` : ""}`;
    logger.error(
      stage === "job"
        ? `AI job ${jobId} failed with an internal error (${type}); further errors aren't logged for a minute`
        : `The AI job scheduler failed (${type}); further errors aren't logged for a minute`
    );
  }

  /** Isolated harnesses construct the service without the site's AI policy. */
  async policy(): Promise<AiPolicy> {
    return this.policies ? await this.policies.get() : { ...DEFAULT_AI_POLICY };
  }

  withRuntime<T>(
    ownerId: number,
    job: AiJobEntity | undefined,
    work: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    // Legacy isolated unit harnesses construct the service without its injected metering or admission.
    if (!this.usage && !this.admission && !signal) return work();
    const context = this.usage
      ? this.usage.context(
          ownerId,
          job?.id,
          job
            ? async () => {
                await this.assertJob(job);
              }
            : undefined
        )
      : { ownerId, jobId: job?.id, record: async () => undefined };
    return withAiRuntime(
      {
        ...context,
        signal,
        allowPrivateNetwork: async () => await this.isSiteAdministrator(ownerId),
        ...(this.endpointPolicies
          ? {
              checkEndpoint: async (url: URL, privateDestination: boolean) => {
                const refusal = aiEndpointRefusal(await this.endpointPolicies.current(), url, {
                  privateDestination,
                  administrator: false,
                  serverApproved: isAllowedPrivateHost(url)
                });
                if (refusal && !(await this.isSiteAdministrator(ownerId))) throw new AiError(refusal);
              }
            }
          : {}),
        // Every provider request of this owner, from a job or from the configuration page, is admitted here.
        ...(this.admission ? { admit: metadata => this.admission.admit(ownerId, job?.id, metadata, signal) } : {})
      },
      work
    );
  }

  /** Site administrators control the server, so their own AI configuration may use any address. */
  private async isSiteAdministrator(userId: number): Promise<boolean> {
    return (await this.db.getRepository(UserEntity).findOneBy({ id: userId }))?.isAdmin === true;
  }

  async editable(user: UserEntity, id: number) {
    const problem = await this.problems.findProblemById(id);
    if (!problem) throw new AiError("NO_SUCH_PROBLEM");
    if (!(await this.problemAccess.userHasPermission(user, problem, ProblemPermissionType.Modify)))
      throw new AiError("PERMISSION_DENIED");
    return problem;
  }

  async assertJob(job: AiJobEntity, manager?: EntityManager, problem?: ProblemEntity) {
    const current = manager
      ? await manager.findOne(AiJobEntity, { where: { id: job.id }, lock: { mode: "pessimistic_write" } })
      : await this.jobs.findOneBy({ id: job.id });
    if (job.runToken && current?.runToken !== job.runToken) throw new AiError("JOB_LEASE_LOST");
    if (!current || current.status === "cancelled") throw new AiError("JOB_CANCELLED");
    if (manager && current.status !== "running") throw new AiError("JOB_LEASE_LOST");
    const user = manager
      ? await manager.findOne(UserEntity, { where: { id: current.ownerId }, lock: { mode: "pessimistic_read" } })
      : await this.db.getRepository(UserEntity).findOneBy({ id: current.ownerId });
    await this.requirePrivilege(user, UserPrivilegeType.UseAi, manager);
    if (["testdata", "all", "import"].includes(current.action))
      await this.requirePrivilege(user, UserPrivilegeType.GenerateTestdata, manager);
    if (current.problemId) {
      if (manager) {
        problem ||= await manager.findOne(ProblemEntity, {
          where: { id: current.problemId },
          lock: { mode: "pessimistic_read" }
        });
        if (
          !problem ||
          !(await this.problemAccess.userHasPermission(user, problem, ProblemPermissionType.Modify, undefined, manager))
        )
          throw new AiError("PERMISSION_DENIED");
      } else await this.editable(user, current.problemId);
    }
    if (
      ["testdata", "all", "import"].includes(current.action) &&
      !(await this.privileges.permissionDecision(user, UserPrivilegeType.EditProblemData, true, manager))
    )
      throw new AiError("PERMISSION_DENIED");
    return user;
  }

  async assertImportAuthorization(job: AiJobEntity, manager?: EntityManager) {
    const user = await this.assertJob(job, manager);
    await this.requirePrivilege(user, UserPrivilegeType.ImportProblem, manager);
    if (!(await this.problemAccess.userHasCreateProblemPermission(user, manager)))
      throw new AiError("PERMISSION_DENIED");
    return user;
  }

  async checkpoint(job: AiJobEntity, step: string, progress: number) {
    await this.assertJob(job);
    job.step = step;
    job.progress = Math.min(99, progress);
    const saved = await this.jobs.update(
      { id: job.id, ...(job.runToken ? { runToken: job.runToken } : {}) },
      {
        state: job.state,
        step: job.step,
        progress: job.progress,
        problemId: job.problemId
      }
    );
    if (saved.affected === 0) throw new AiError("JOB_LEASE_LOST");
  }

  private async runJob(job: AiJobEntity) {
    const controller = new AbortController();
    // Isolated harnesses may construct a service without invoking its constructor.
    this.activeRuns ||= new Map();
    this.activeRuns.set(job.id, controller);
    let checking = false;
    // Cancellation may be handled by another backend sharing the worker's database lock.
    const cancellationTimer = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      this.jobs
        .findOneBy({ id: job.id })
        .then(current => {
          if (!current || current.status === "cancelled") controller.abort(new AiError("JOB_CANCELLED"));
          else if (current.runToken !== job.runToken) controller.abort(new AiError("JOB_LEASE_LOST"));
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, 500);
    cancellationTimer.unref();
    try {
      await this.recordAiAudit(job.ownerId, "job.start", job);
      await this.withRuntime(job.ownerId, job, () => this.workflow.execute(job), controller.signal);
      await this.assertJob(job);
      const completed = await this.jobs.update(
        { id: job.id, status: "running", runToken: job.runToken },
        {
          status: "completed",
          progress: 100,
          step: "completed",
          state: job.state,
          input: { count: job.input.count },
          error: null
        }
      );
      if (!completed.affected) throw new AiError("JOB_LEASE_LOST");
      await this.recordAiAudit(job.ownerId, "job.complete", job);
    } catch (error) {
      const code = error instanceof AiError ? error.message : "INTERNAL_ERROR";
      const cancelled =
        (error instanceof AiError && error.code === "JOB_CANCELLED") ||
        (await this.jobs.findOneBy({ id: job.id }))?.status === "cancelled";
      // A cancelled job's aborted requests aren't errors
      if (!(error instanceof AiError) && !cancelled) this.workerFailed("job", error, job.id);
      if (!cancelled && error instanceof AiError && error.code === "AI_PAUSED") {
        // The site paused AI: return the job to the queue. Its checkpoints let it resume where it stopped.
        const requeued = await this.jobs.update(
          { id: job.id, status: "running", runToken: job.runToken },
          { status: "queued", runToken: null }
        );
        if (requeued.affected) await this.recordAiAudit(job.ownerId, "job.pause", job);
        return;
      }
      const failed = await this.jobs.update(
        { id: job.id, status: In(["running", "cancelled"]), runToken: job.runToken },
        // Artifact transactions/checkpoints are authoritative. A post-commit exception must not
        // replace their newly committed state with this worker's older in-memory object.
        { status: cancelled ? "cancelled" : "failed", error: cancelled ? null : code }
      );
      if (failed.affected && !cancelled)
        await this.recordAiAudit(job.ownerId, "job.fail", job, {
          errorCode: error instanceof AiError ? error.code : "INTERNAL_ERROR"
        });
    } finally {
      clearInterval(cancellationTimer);
      if (this.activeRuns.get(job.id) === controller) this.activeRuns.delete(job.id);
    }
  }

  private async work() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    const lock = this.db.createQueryRunner();
    const lockName = aiWorkerLockName(this.db.options?.database);
    const running = new Map<string, { ownerId: number; job: AiJobEntity; promise: Promise<void> }>();
    try {
      await lock.connect();
      const result = await lock.query("SELECT GET_LOCK(?, 0) AS acquired", [lockName]);
      if (Number(result[0]?.acquired) !== 1) return;
      // The advisory lock spans all concurrent tasks; only its next holder reclaims abandoned jobs.
      await this.jobs.update({ status: "running" }, { status: "queued", runToken: null });
      while (!this.stopped || running.size) {
        // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
        const { paused } = await this.policy();
        if (paused && !running.size) break;
        if (!this.stopped && !paused && running.size < 8) {
          // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
          const lease = await lock.query("SELECT (IS_USED_LOCK(?) = CONNECTION_ID()) AS owned", [lockName]);
          if (Number(lease[0]?.owned) !== 1) throw new AiError("JOB_LEASE_LOST");
          // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
          const queued = await this.jobs.find({ where: { status: "queued" }, order: { createdAt: "ASC" }, take: 1000 });
          const ownerLimits = new Map<number, number>();
          for (const job of queued) {
            if (running.size >= 8 || this.stopped) break;
            if (!ownerLimits.has(job.ownerId)) {
              try {
                // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
                ownerLimits.set(job.ownerId, (await this.configuration.config(job.ownerId)).maxConcurrentJobs);
              } catch {
                ownerLimits.set(job.ownerId, 1);
              } // A corrupt owner's config must fail its job, not block other users.
            }
            const active = [...running.values()];
            if (active.filter(item => item.ownerId === job.ownerId).length >= ownerLimits.get(job.ownerId)) continue;
            if (job.problemId && active.some(item => item.job.problemId === job.problemId)) continue;
            const runToken = randomUUID();
            // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
            const claimed = await this.jobs.update({ id: job.id, status: "queued" }, { status: "running", runToken });
            if (!claimed.affected) continue;
            job.status = "running";
            job.runToken = runToken;
            // Defer execution one microtask so its slot exists before any completion callback.
            const promise = Promise.resolve()
              .then(() => this.runJob(job))
              .finally(() => running.delete(job.id));
            running.set(job.id, { ownerId: job.ownerId, job, promise });
          }
          if (!queued.length && !running.size) break;
        }
        if (!running.size) break;
        // A newly queued task/configuration is considered without waiting for a long model call.
        // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
        await Promise.race(
          [...running.values()]
            .map(item => item.promise)
            .concat([new Promise<void>(resolve => setTimeout(resolve, 500))])
        );
      }
    } finally {
      // Never relinquish the cluster lock while a sibling task still has side effects in flight.
      await Promise.allSettled([...running.values()].map(item => item.promise));
      try {
        await lock.query("SELECT RELEASE_LOCK(?)", [lockName]);
      } catch {
        /* connection already closed */
      }
      await lock.release();
      this.busy = false;
    }
  }
}
