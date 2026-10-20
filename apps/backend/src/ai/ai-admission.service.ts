import { createHash, randomUUID } from "crypto";

import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager, LessThan } from "typeorm";

import { AiReservationEntity } from "./ai-reservation.entity";
import { AiAdmission, AiRequestMetadata, AiUsageRecord, aiCancellationError, isBillableRequest } from "./ai-runtime";
import { AiError } from "./ai.types";

import { AiPolicy, AiPolicyService } from "../settings/ai-policy.service";
import { UserEntity } from "../user/user.entity";

export const AI_BUDGET_WINDOW_MS = 24 * 3600 * 1000;
const RESERVATION_RETENTION_MS = 48 * 3600 * 1000;
const BILLABLE_USAGE_SQL =
  "((target = 'llm' AND operation = 'generate') OR (target = 'search' AND operation IN ('search', 'tools/call')))";
/** The provider answered with an error status, or the request never left the server: nothing was billed. */
const UNBILLED_ERRORS = new Set(["PROVIDER_HTTP_ERROR", "PRIVATE_ENDPOINT_BLOCKED"]);

export interface AiBudgetUsage {
  /** Reported tokens in the window plus tokens held for unconfirmed requests. */
  tokens: number;
  /** Billable requests in the window, including those still running. */
  requests: number;
  /** Tokens held for requests that are running or whose usage the provider didn't report. */
  heldTokens: number;
}

export function aiResponseHash(jobId: string | undefined, host: string, responseId: string): string {
  return createHash("sha256")
    .update(`${jobId || "connection"}\n${host}\n${responseId}`)
    .digest("hex");
}

/**
 * The single admission point for AI provider requests (see meterProviderRequest): the site-wide pause, the number
 * of simultaneous requests, each job's request limit, and each account's 24-hour budget. A billable request holds a
 * conservative reservation until the provider reports its real usage.
 */
@Injectable()
export class AiAdmissionService {
  private running = 0;

  private waiting = new Set<() => void>();

  /** Billable requests of each job running in this process, not yet in ai_usage. */
  private jobRequests = new Map<string, number>();

  private lastCleanup = 0;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly policies: AiPolicyService
  ) {}

  /** Provider requests running and waiting for a slot in this process. */
  load(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.size };
  }

  async admit(
    ownerId: number,
    jobId: string | undefined,
    metadata: AiRequestMetadata,
    signal?: AbortSignal
  ): Promise<AiAdmission> {
    let policy = await this.policies.get();
    // Jobs wait for a free slot; a request someone is waiting for in the browser is refused instead.
    for (;;) {
      if (signal?.aborted) throw aiCancellationError(signal);
      if (policy.paused) throw new AiError("AI_PAUSED");
      if (this.running < policy.concurrentRequests) break;
      if (!jobId) throw new AiError("AI_BUSY");
      // eslint-disable-next-line no-await-in-loop -- Waiting for a slot; each pass re-reads the policy.
      await this.wait(signal);
      // eslint-disable-next-line no-await-in-loop -- See above.
      policy = await this.policies.get();
    }
    this.running++;
    const billable = isBillableRequest(metadata);
    let counted = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.running--;
      if (counted) {
        const remaining = (this.jobRequests.get(jobId) || 1) - 1;
        if (remaining > 0) this.jobRequests.set(jobId, remaining);
        else this.jobRequests.delete(jobId);
      }
      const waiting = [...this.waiting];
      this.waiting.clear();
      for (const wake of waiting) wake();
    };
    try {
      if (billable && jobId) {
        if (policy.jobRequests) {
          const used = (await this.jobRequestCount(ownerId, jobId)) + (this.jobRequests.get(jobId) || 0);
          if (used >= policy.jobRequests) throw new AiError("AI_JOB_REQUEST_LIMIT");
        }
        this.jobRequests.set(jobId, (this.jobRequests.get(jobId) || 0) + 1);
        counted = true;
      }
      const reservationId = billable
        ? await this.reserve(ownerId, jobId, metadata.reserveTokens || 0, policy)
        : undefined;
      this.cleanup();
      return { reservationId, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private wait(signal?: AbortSignal) {
    return new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> = null;
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.waiting.delete(done);
        resolve();
      };
      // Re-check now and then: the policy may have changed, or a slot freed in a request that failed early.
      timer = setTimeout(done, 1000);
      signal?.addEventListener("abort", done, { once: true });
      this.waiting.add(done);
    });
  }

  private async jobRequestCount(ownerId: number, jobId: string): Promise<number> {
    const [row] = await this.db.query(
      `SELECT COUNT(*) AS count FROM ai_usage WHERE ownerId = ? AND jobId = ? AND ${BILLABLE_USAGE_SQL}`,
      [ownerId, jobId]
    );
    return Number(row?.count) || 0;
  }

  private async reserve(ownerId: number, jobId: string | undefined, tokens: number, policy: AiPolicy) {
    if (!policy.userDailyTokens && !policy.userDailyRequests) return undefined;
    if (policy.userDailyTokens && tokens > policy.userDailyTokens) throw new AiError("AI_REQUEST_EXCEEDS_BUDGET");
    return await this.db.transaction(async manager => {
      // Usage recording takes the same lock, so simultaneous requests can't all pass the check.
      await manager.findOne(UserEntity, { where: { id: ownerId }, lock: { mode: "pessimistic_write" } });
      const used = await this.usage(ownerId, manager);
      if (
        (policy.userDailyRequests && used.requests + 1 > policy.userDailyRequests) ||
        (policy.userDailyTokens && used.tokens + tokens > policy.userDailyTokens)
      )
        throw new AiError("AI_BUDGET_EXCEEDED");
      const id = randomUUID();
      await manager.insert(AiReservationEntity, { id, ownerId, jobId: jobId || null, tokens, responseHash: null });
      return id;
    });
  }

  async usage(ownerId: number, manager: EntityManager = this.db.manager): Promise<AiBudgetUsage> {
    const since = new Date(Date.now() - AI_BUDGET_WINDOW_MS);
    const [reported] = await manager.query(
      `SELECT COALESCE(SUM(${BILLABLE_USAGE_SQL}), 0) AS requests,
        COALESCE(SUM(COALESCE(inputTokens, 0) + COALESCE(outputTokens, 0)), 0) AS tokens
        FROM ai_usage WHERE ownerId = ? AND createdAt >= ?`,
      [ownerId, since]
    );
    const [held] = await manager.query(
      `SELECT COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(settledAt IS NULL), 0) AS requests
        FROM ai_reservation WHERE ownerId = ? AND createdAt >= ?`,
      [ownerId, since]
    );
    return {
      tokens: Number(reported.tokens) + Number(held.tokens),
      requests: Number(reported.requests) + Number(held.requests),
      heldTokens: Number(held.tokens)
    };
  }

  /**
   * Called with the usage record, inside its transaction. A reservation is released when the provider reports the
   * request's usage, or nothing was billed; otherwise it keeps counting, at its reserved maximum, for 24 hours.
   */
  async settle(
    manager: EntityManager,
    ownerId: number,
    jobId: string | undefined,
    record: AiUsageRecord,
    reservationId: string | undefined,
    confirmed: boolean,
    responseHash: string | null
  ) {
    const reservations = manager.getRepository(AiReservationEntity);
    // A background response's usage arrives with the poll that completes it.
    if (responseHash && confirmed) await reservations.delete({ ownerId, responseHash });
    if (!reservationId) return;
    if (confirmed || record.target === "search" || UNBILLED_ERRORS.has(record.errorCode))
      await reservations.delete({ id: reservationId, ownerId });
    else
      await reservations.update(
        { id: reservationId, ownerId },
        {
          settledAt: new Date(),
          ...(record.pendingResponseId
            ? { responseHash: aiResponseHash(jobId, record.host, record.pendingResponseId) }
            : {})
        }
      );
  }

  private cleanup() {
    if (Date.now() - this.lastCleanup < 3600 * 1000) return;
    this.lastCleanup = Date.now();
    this.db
      .getRepository(AiReservationEntity)
      .delete({ createdAt: LessThan(new Date(Date.now() - RESERVATION_RETENTION_MS)) })
      .catch(() => undefined);
  }
}
