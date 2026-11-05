import { randomUUID } from "crypto";

import { Injectable } from "@nestjs/common";

import { aiContractDigest, parseAiReplayRuns } from "@libreoj/judge-protocol";

import { AiJobEntity } from "./ai.entity";
import { AiError } from "./ai.types";
import { AiEvidenceService, AiObservationView, evidenceObject } from "./ai-evidence.service";
import { AiExecutionService, AiReplayTransfer } from "./ai-execution.service";
import { AiJobCoordinator } from "./ai-job-coordinator.service";
import { currentExecution } from "./ai-operation";
import {
  AiReplayPlan,
  AiReplayRecord,
  AiReplayUnsupported,
  jobProgram,
  replayPlan,
  replayRevision,
  replayStatus
} from "./ai-replay";
import { AiWorkflowService } from "./ai-workflow.service";
import { AiObservationEntity } from "./ai-observation.entity";

import { logger } from "../logger";
import { ProblemEntity, ProblemType } from "../problem/problem.entity";
import { RedisService } from "../redis/redis.service";
import { UserEntity } from "../user/user.entity";

// One replay of a job at a time, and of a user's jobs; a replay still running after this is shown as interrupted
const REPLAY_LOCK = 30 * 60 * 1000;
const jobLock = (jobId: string) => `ai-replay:job:${jobId}`;
const userLock = (userId: number) => `ai-replay:user:${userId}`;

/** Whether a failure can be replayed now, and why not. */
export type AiReplayAvailability =
  { available: true } | { available: false; reason: AiReplayUnsupported | "JOB_ACTIVE" | "NO_PROBLEM" };

/**
 * Replays of kept failures (review Part III, H01/W03), for the job's owner: the failure's exact kept bytes, run again
 * with the same check where the job's programs run (the local AI runner or a judge machine), a few times. Each replay
 * is kept with its failure: whether it reproduced, with the programs (and profiles) as they were or as they are now.
 * A replay changes nothing of the job or the problem.
 */
@Injectable()
export class AiReplayService {
  constructor(
    private readonly coordinator: AiJobCoordinator,
    private readonly evidence: AiEvidenceService,
    private readonly execution: AiExecutionService,
    private readonly workflow: AiWorkflowService,
    private readonly redisService: RedisService
  ) {}

  /** Whether a replay of the job runs now (the job isn't retried meanwhile). */
  async running(jobId: string): Promise<boolean> {
    return !!(await this.redisService.cacheGet(jobLock(jobId)));
  }

  private plan(
    job: AiJobEntity,
    problemType: string,
    observation: AiObservationView | AiObservationEntity["observation"]
  ) {
    return replayPlan(observation, {
      customChecker: !!job.state.plan?.needsSpj,
      protocol: problemType === ProblemType.Interaction || problemType === ProblemType.Communication
    });
  }

  /** The failures with their replays as the owner sees them, and whether each can be replayed now. */
  annotate(job: AiJobEntity, problemType: string | null, failures: AiObservationView[]) {
    const now = Date.now();
    return failures.map(failure => {
      let replay: AiReplayAvailability;
      const planned = problemType ? this.plan(job, problemType, failure) : null;
      if (!planned) replay = { available: false, reason: "NO_PROBLEM" };
      else if ("unsupported" in planned) replay = { available: false, reason: planned.unsupported };
      else if (planned.plan.artifacts.length && (failure.evidence === "expired" || +failure.expiresAt <= now))
        replay = { available: false, reason: "EVIDENCE_MISSING" };
      else if (!job.state.plan || planned.plan.programs.some(role => !jobProgram(job.state, role)))
        replay = { available: false, reason: "PROGRAM_MISSING" };
      else if (job.status === "queued" || job.status === "running") replay = { available: false, reason: "JOB_ACTIVE" };
      else replay = { available: true };
      return {
        ...failure,
        // One its backend stopped running (e.g. it restarted) is shown as such
        replays: (failure.replays || []).map(record =>
          record.status === "running" && now - Date.parse(record.startedAt) > REPLAY_LOCK
            ? { ...record, status: "failed" as const, error: "REPLAY_INTERRUPTED" }
            : record
        ),
        replay
      };
    });
  }

  /** Starts a replay of the job's failure `id`; it runs in the background and is kept with the failure. */
  async start(user: UserEntity, job: AiJobEntity, problem: ProblemEntity, id: string): Promise<AiReplayRecord> {
    if (job.status === "queued" || job.status === "running") throw new AiError("AI_JOB_ACTIVE");
    if ((await this.coordinator.policy()).paused) throw new AiError("AI_PAUSED");
    if (!problem) throw new AiError("AI_REPLAY_UNSUPPORTED", "NO_PROBLEM");
    const row = await this.evidence.observation(job, id);
    const planned = this.plan(job, problem.type, row.observation);
    if ("unsupported" in planned) throw new AiError("AI_REPLAY_UNSUPPORTED", planned.unsupported);
    const { plan } = planned;
    if (plan.artifacts.length && (row.evidence === "expired" || row.expiresAt <= new Date()))
      throw new AiError("AI_REPLAY_UNSUPPORTED", "EVIDENCE_MISSING");
    const { request, programs, profiles } = await this.workflow.replayRequest(
      job,
      problem,
      plan,
      row.observation.profile?.executionProfiles
    );
    if (!(await this.redisService.takeTurn(jobLock(job.id), REPLAY_LOCK))) throw new AiError("AI_REPLAY_BUSY");
    if (!(await this.redisService.takeTurn(userLock(user.id), REPLAY_LOCK))) {
      await this.redisService.cacheDelete(jobLock(job.id));
      throw new AiError("AI_REPLAY_BUSY");
    }
    const unlock = async () => {
      await this.redisService.cacheDelete(jobLock(job.id)).catch(() => undefined);
      await this.redisService.cacheDelete(userLock(user.id)).catch(() => undefined);
    };
    let record: AiReplayRecord;
    try {
      record = {
        id: randomUUID(),
        status: "running",
        startedAt: new Date().toISOString(),
        userId: user.id,
        check: plan.check,
        revision: replayRevision(row.observation, programs),
        profiles
      };
      await this.evidence.addReplay(row.id, record);
      await this.coordinator.recordAiAudit(user, "evidence.replay", job, {
        observationId: row.id,
        replayId: record.id,
        check: plan.check
      });
    } catch (error) {
      await unlock();
      throw error;
    }
    this.run(job, row, plan, request, record.id)
      .catch(error => logger.error(`AI replay ${record.id} of job ${job.id} couldn't be recorded: ${error}`))
      .finally(unlock);
    return record;
  }

  private async run(
    job: AiJobEntity,
    row: AiObservationEntity,
    plan: AiReplayPlan,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The versioned runner wire payload
    request: any,
    replayId: string
  ) {
    let changes: Partial<AiReplayRecord>;
    try {
      // The exact bytes kept with the failure, checked against their hashes where they're run
      const transfers: AiReplayTransfer[] = plan.artifacts.map(role => {
        const artifact = row.observation.artifacts.find(item => item.role === role);
        return {
          name: `replay.${role}`,
          object: evidenceObject(row.id, role),
          size: artifact.size,
          sha256: artifact.sha256
        };
      });
      const message = await this.execution.replay(job, request, transfers);
      const execution = currentExecution(message);
      const runs = parseAiReplayRuns(message?.replay?.runs, plan.repeat);
      if (message?.validation?.profiles !== aiContractDigest(request.profiles) || !execution || !runs)
        throw new AiError("INVALID_SANDBOX_RESPONSE");
      changes = {
        status: replayStatus(row.observation.kind, runs),
        runs,
        origin: message.operation?.origin === "judge" ? "judge" : "local",
        runtime: execution.runtime
      };
    } catch (error) {
      logger.error(`AI replay ${replayId} of job ${job.id} failed: ${error}`);
      changes = { status: "failed", error: error instanceof AiError ? error.message.slice(0, 2000) : "INTERNAL_ERROR" };
    }
    await this.evidence.updateReplay(row.id, replayId, { ...changes, finishedAt: new Date().toISOString() });
  }
}
