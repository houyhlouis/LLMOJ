import { randomUUID } from "crypto";

import { Inject, Injectable } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { DataSource, Repository, In, Not } from "typeorm";

import { AiResponseCheckpointEntity, AiUsageEntity } from "./ai-usage.entity";
import { AiRuntimeContext, AiUsageRecord, withAiRuntime } from "./ai-runtime";
import { AiError, LlmConfiguration } from "./ai.types";
import { AiJobEntity } from "./ai.entity";
import { providerBindingHash } from "./ai-responses";
import { cancelProviderResponse } from "./ai-provider";
import { AiAdmissionService, aiResponseHash } from "./ai-admission.service";

import { UserEntity } from "../user/user.entity";

const aggregate = `COUNT(*) AS requests, SUM(success = 1) AS succeeded, SUM(success = 0) AS failed,
SUM(elapsedMs) AS elapsedMs, SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens,
SUM(cachedTokens) AS cachedTokens, SUM(reasoningTokens) AS reasoningTokens, SUM(searchCredits) AS searchCredits,
SUM(target = 'llm' AND operation = 'generate' AND usageReported = 0) AS unknownTokenRequests,
SUM(target = 'llm' AND operation = 'generate') AS generations`;
const numeric = [
  "requests",
  "succeeded",
  "failed",
  "elapsedMs",
  "inputTokens",
  "outputTokens",
  "cachedTokens",
  "reasoningTokens",
  "searchCredits",
  "unknownTokenRequests",
  "generations"
];
function normalize(row: Record<string, unknown>) {
  const result = { ...row };
  for (const field of numeric)
    if (field in row)
      result[field] =
        row[field] == null
          ? numeric.slice(0, 4).includes(field) || field === "unknownTokenRequests" || field === "generations"
            ? 0
            : null
          : Number(row[field]);
  return result;
}
/**
 * A job's provider requests (review Part IV, IV-08): `generations` are the model generations it started, `requests`
 * every model request sent (polls recovering a background response included: transport, not new work), searches,
 * failed ones, reported tokens, and `unreported` generations whose usage no response of theirs reported.
 */
export interface AiJobUsage {
  generations: number;
  polls?: number;
  legacyUnlinkedRequests?: number;
  requests: number;
  searches: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  inputTokensReported?: boolean;
  outputTokensReported?: boolean;
  searchCredits?: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  unreported: number;
  // Generations and requests by what each was for when it was sent; requests recorded before (no purpose) aren't here
  purposes?: Record<string, { generations: number; requests: number }>;
}

@Injectable()
export class AiUsageService {
  @Inject(AiAdmissionService) private readonly admission?: AiAdmissionService;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectRepository(AiUsageEntity) private readonly usage: Repository<AiUsageEntity>,
    @InjectRepository(AiResponseCheckpointEntity) private readonly responses: Repository<AiResponseCheckpointEntity>
  ) {}

  context(ownerId: number, jobId?: string, checkActive?: () => Promise<void>, runToken?: string): AiRuntimeContext {
    // Configuration-page generations also journal before dispatch. Their namespace cannot collide with a job UUID,
    // and a new explicit connection test gets a fresh scope rather than reusing an earlier test's answer.
    const scopeId = jobId || `cfg:${randomUUID().replace(/-/g, "")}`;
    const where = (requestHash: string) => ({ ownerId, jobId: scopeId, requestHash });
    return {
      ownerId,
      jobId,
      checkActive,
      purpose: () => (jobId ? undefined : "configuration"),
      record: (record, reservationId) => this.record(ownerId, jobId, record, reservationId),
      loadResponse: async requestHash => {
        const saved = await this.responses.findOneBy(where(requestHash));
        return saved
          ? {
              responseId: saved.responseId,
              createdAt: saved.createdAt.getTime(),
              generationId: saved.generationId,
              stageId: saved.stageId,
              purpose: saved.purpose,
              requestAttempts: saved.requestAttempts,
              bindingHash: saved.bindingHash,
              lifecycle: saved.lifecycle,
              terminalStatus: saved.terminalStatus
            }
          : null;
      },
      nextResponseAttempt: requestHash => this.nextAttempt(ownerId, scopeId, requestHash, runToken, !jobId),
      claimResponse: async (requestHash, value) =>
        await this.db.transaction(async manager => {
          if (jobId) {
            const job = await manager.findOne(AiJobEntity, {
              where: { id: jobId, ownerId },
              select: ["id", "runToken", "status"],
              lock: { mode: "pessimistic_write" }
            });
            if (!job || (runToken && (job.runToken !== runToken || job.status !== "running")))
              throw new AiError("JOB_LEASE_LOST");
          } else if (
            !(await manager.findOne(UserEntity, { where: { id: ownerId }, lock: { mode: "pessimistic_write" } }))
          )
            throw new AiError("PERMISSION_DENIED");
          const repository = manager.getRepository(AiResponseCheckpointEntity);
          const existing = await repository.findOneBy(where(requestHash));
          if (existing) return { checkpoint: { ...existing, createdAt: existing.createdAt.getTime() }, created: false };
          await repository.insert({ ...where(requestHash), ...value, createdAt: new Date(value.createdAt) });
          if (jobId) await manager.increment(AiJobEntity, { id: jobId, ownerId }, "revision", 1);
          return { checkpoint: value, created: true };
        }),
      saveResponse: async (requestHash, value) => {
        await this.db.transaction(async manager => {
          if (runToken) {
            const job = await manager.findOne(AiJobEntity, {
              where: { id: jobId },
              select: ["id", "runToken", "status"],
              lock: { mode: "pessimistic_write" }
            });
            if (job?.runToken !== runToken || !["running", "cancelled"].includes(job.status))
              throw new AiError("JOB_LEASE_LOST");
          }
          const checkpoint = { ...value };
          // Only the atomic database counter may advance attempts; stale poll/cancel snapshots cannot overwrite it.
          delete checkpoint.requestAttempts;
          await manager
            .getRepository(AiResponseCheckpointEntity)
            .upsert({ ...where(requestHash), ...checkpoint, createdAt: new Date(value.createdAt) }, [
              "ownerId",
              "jobId",
              "requestHash"
            ]);
        });
      }
    };
  }

  private async nextAttempt(
    ownerId: number,
    jobId: string,
    requestHash: string,
    runToken?: string,
    standalone = false
  ): Promise<number> {
    return await this.db.transaction(async manager => {
      if (!standalone) {
        const job = await manager.findOne(AiJobEntity, {
          where: { id: jobId, ownerId },
          select: ["id", "runToken", "status"],
          lock: { mode: "pessimistic_write" }
        });
        if (!job || (runToken && job.runToken !== runToken)) throw new AiError("JOB_LEASE_LOST");
        if (runToken && job.status !== "running")
          throw new AiError(job.status === "cancelled" ? "JOB_CANCELLED" : "JOB_LEASE_LOST");
      }
      const row = await manager.findOne(AiResponseCheckpointEntity, {
        where: { ownerId, jobId, requestHash },
        lock: { mode: "pessimistic_write" }
      });
      if (!row) throw new AiError("PROVIDER_ACKNOWLEDGEMENT_UNKNOWN");
      const attempt = row.requestAttempts + 1;
      await manager
        .getRepository(AiResponseCheckpointEntity)
        .update({ ownerId, jobId, requestHash }, { requestAttempts: attempt });
      if (!standalone) await manager.increment(AiJobEntity, { id: jobId, ownerId }, "revision", 1);
      return attempt;
    });
  }

  /** Cleanup has its own context: a local cancellation must not abort the remote cancellation request. */
  async cancelResponses(
    ownerId: number,
    jobId: string,
    config: LlmConfiguration,
    network: Pick<AiRuntimeContext, "allowPrivateNetwork" | "checkEndpoint"> = {}
  ) {
    const checkpoints = await this.responses.find({ where: { ownerId, jobId } });
    for (const saved of checkpoints) {
      if (
        ["confirmed", "not_needed"].includes(saved.cancellation) ||
        (saved.cancellation === "unsupported" &&
          (!saved.responseId || saved.cancellationError !== "PROVIDER_HANDLE_UNAVAILABLE"))
      )
        continue;
      let cancellation: AiResponseCheckpointEntity["cancellation"] = "requested";
      let cancellationError: string = null;
      let { terminalStatus } = saved;
      let { lifecycle } = saved;
      if (["terminal", "prepared"].includes(saved.lifecycle)) cancellation = "not_needed";
      else if (!saved.responseId) {
        cancellation = "unsupported";
        cancellationError = "PROVIDER_HANDLE_UNAVAILABLE";
      } else if (!saved.bindingHash) {
        cancellation = "unsupported";
        cancellationError = "PROVIDER_BINDING_UNAVAILABLE";
      } else if (saved.bindingHash !== providerBindingHash(config)) {
        cancellation = "failed";
        cancellationError = "PROVIDER_CREDENTIALS_CHANGED";
      }
      // eslint-disable-next-line no-await-in-loop -- Persist each cancellation intent before sending it.
      await this.responses.update(
        { ownerId, jobId, requestHash: saved.requestHash, cancellation: Not(In(["confirmed", "not_needed"])) },
        { cancellation, cancellationError, lifecycle, terminalStatus }
      );
      // eslint-disable-next-line no-await-in-loop -- Cancellation state changes invalidate conditional detail responses.
      await this.db.getRepository(AiJobEntity).increment({ id: jobId, ownerId }, "revision", 1);
      if (cancellation !== "requested") continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- Polls and cancellation share a durable attempt counter.
        const requestAttempt = await this.nextAttempt(ownerId, jobId, saved.requestHash);
        // eslint-disable-next-line no-await-in-loop -- Each provider cancellation is bounded and metered.
        const result = await withAiRuntime({ ...this.context(ownerId, jobId), ...network }, () =>
          cancelProviderResponse(config, saved.responseId, {
            target: "llm",
            provider: config.type,
            host: new URL(config.baseUrl).hostname,
            model: config.model,
            operation: "responses.cancel",
            accountBinding: saved.bindingHash,
            stageId: saved.stageId,
            generationId: saved.generationId,
            purpose: saved.purpose,
            requestAttempt
          })
        );
        if (["cancelled", "completed", "failed", "incomplete"].includes(result.status)) {
          terminalStatus = result.status;
          lifecycle = "terminal";
        }
        cancellation =
          result.status === "cancelled"
            ? "confirmed"
            : ["completed", "failed", "incomplete"].includes(result.status)
              ? "not_needed"
              : "requested";
      } catch (error) {
        cancellation =
          error instanceof AiError && error.code === "PROVIDER_CANCEL_UNSUPPORTED" ? "unsupported" : "failed";
        cancellationError = error instanceof AiError ? error.code : "PROVIDER_NETWORK_ERROR";
      }
      // eslint-disable-next-line no-await-in-loop -- Save the independently observed provider outcome.
      await this.responses.update(
        { ownerId, jobId, requestHash: saved.requestHash, cancellation: Not(In(["confirmed", "not_needed"])) },
        { cancellation, cancellationError, lifecycle, terminalStatus }
      );
      // eslint-disable-next-line no-await-in-loop -- Cancellation state changes invalidate conditional detail responses.
      await this.db.getRepository(AiJobEntity).increment({ id: jobId, ownerId }, "revision", 1);
    }
  }

  /** A configuration/decryption failure is still a failed cancellation attempt, never implicit confirmation. */
  async markCancellationFailure(ownerId: number, jobId: string, errorCode: string) {
    const pending = { ownerId, jobId, cancellation: Not(In(["confirmed", "not_needed"])) };
    await this.responses.update(
      { ...pending, lifecycle: In(["prepared", "terminal"]) },
      { cancellation: "not_needed", cancellationError: null }
    );
    await this.responses.update(
      { ...pending, lifecycle: In(["legacy", "dispatching", "pending"]) },
      { cancellation: "failed", cancellationError: errorCode.slice(0, 80) }
    );
    await this.db.getRepository(AiJobEntity).increment({ id: jobId, ownerId }, "revision", 1);
  }

  async generations(ownerId: number, jobId: string) {
    return await this.responses.find({ where: { ownerId, jobId }, order: { createdAt: "ASC" }, take: 1001 });
  }

  async recentFailures(ownerId: number, jobId: string) {
    const rows = await this.usage.find({
      where: { ownerId, jobId, success: false },
      order: { createdAt: "DESC" },
      take: 10
    });
    return rows.map(row => ({
      id: row.id,
      purpose: row.purpose,
      stageId: row.stageId,
      generationId: row.generationId,
      operation: row.operation,
      target: row.target,
      provider: row.provider,
      host: row.host,
      model: row.model || null,
      errorCode: row.errorCode,
      diagnostics: row.diagnostics || null,
      createdAt: row.createdAt
    }));
  }

  /** Durable identities prove logical generations; old unbound transport rows are labelled separately. */
  async stageTotals(ownerId: number, jobId: string) {
    const rows: Array<{ stageId: string; requests: string; responsePolls: string; failedRequests: string }> =
      await this.db.query(
        `SELECT stageId, COUNT(*) AS requests, SUM(operation = 'responses.poll') AS responsePolls,
          SUM(success = 0) AS failedRequests FROM ai_usage
          WHERE ownerId = ? AND jobId = ? AND stageId IS NOT NULL GROUP BY stageId`,
        [ownerId, jobId]
      );
    return new Map(
      rows.map(row => [
        row.stageId,
        {
          requests: Number(row.requests),
          responsePolls: Number(row.responsePolls),
          failedRequests: Number(row.failedRequests)
        }
      ])
    );
  }

  async generationCounts(ownerId: number, jobId: string) {
    const [row] = await this.db.query(
      `SELECT
      (SELECT COUNT(DISTINCT generationId) FROM ai_response_checkpoint WHERE ownerId = ? AND jobId = ?) AS logicalGenerations,
      (SELECT COUNT(*) FROM ai_usage u WHERE u.ownerId = ? AND u.jobId = ? AND u.target = 'llm' AND u.operation = 'generate'
        AND NOT EXISTS (SELECT 1 FROM ai_response_checkpoint g WHERE g.ownerId = u.ownerId AND g.jobId = u.jobId AND g.generationId = u.generationId)) AS legacyGenerationRequests`,
      [ownerId, jobId, ownerId, jobId]
    );
    return {
      logicalGenerations: Number(row.logicalGenerations),
      legacyGenerationRequests: Number(row.legacyGenerationRequests)
    };
  }

  private async record(ownerId: number, jobId: string | undefined, record: AiUsageRecord, reservationId?: string) {
    const { responseId, pendingResponseId, completedResponse, accountBinding, ...metadata } = record;
    const handle = responseId || pendingResponseId;
    const stableGeneration = record.requestAttempt != null ? record.generationId : undefined;
    const responseHash = handle ? aiResponseHash(jobId, record.host, handle, accountBinding, stableGeneration) : null;
    await this.db.transaction(async manager => {
      // Serializing one owner's metering also prevents counting a recovered response's tokens twice.
      await manager.findOne(UserEntity, { where: { id: ownerId }, lock: { mode: "pessimistic_write" } });
      const repository = manager.getRepository(AiUsageEntity);
      // Whether the provider reported what this request used, so that its budget reservation can be released.
      const confirmed =
        completedResponse !== false &&
        !pendingResponseId &&
        metadata.usageReported &&
        (metadata.target === "search" || (metadata.inputTokens != null && metadata.outputTokens != null));
      if (responseHash && metadata.usageReported) {
        const previous = await repository.find({ where: { ownerId, responseHash, usageReported: true } });
        // Older backends assigned a new generation ID on recovery. A known response handle establishes its original identity.
        const original = previous.find(row => row.generationId);
        if (original && metadata.operation !== "generate" && metadata.generationId !== original.generationId) {
          metadata.generationId = original.generationId;
          metadata.purpose = original.purpose;
          metadata.stageId = original.stageId;
          metadata.requestAttempt = null;
        }
        for (const field of [
          "inputTokens",
          "outputTokens",
          "cachedTokens",
          "reasoningTokens",
          "searchCredits"
        ] as const) {
          const reported = previous.filter(row => row[field] != null);
          if (metadata[field] != null && reported.length) {
            const prior = reported.reduce((sum, row) => sum + Number(row[field]), 0);
            metadata[field] = Math.max(0, metadata[field] - prior) || null;
          }
        }
      }
      await repository.insert({ id: randomUUID(), ownerId, jobId: jobId || null, ...metadata, responseHash });
      await this.admission?.settle(
        manager,
        ownerId,
        jobId,
        { ...record, ...metadata },
        reservationId,
        confirmed,
        responseHash
      );
    });
    // Keep the metering owner lock out of the job/permission lock order used by publication.
    if (jobId) await this.db.getRepository(AiJobEntity).increment({ id: jobId, ownerId }, "revision", 1);
    Object.assign(record, metadata);
  }

  /** What each of the owner's jobs used, as the requests were recorded (review Part III, §8.4). */
  // `since`: when the oldest of the jobs was created (no request of a job is older), so that the query reads only the
  // owner's recent requests, by the (ownerId, createdAt) index
  async jobTotals(ownerId: number, jobIds: string[], since?: Date): Promise<Map<string, AiJobUsage>> {
    const totals = new Map<string, AiJobUsage>();
    if (!jobIds.length) return totals;
    // A minute earlier, for clock rounding
    const range = since ? [ownerId, new Date(since.getTime() - 60000), jobIds] : [ownerId, jobIds];
    const where = `ownerId = ?${since ? " AND createdAt >= ?" : ""} AND jobId IN (?)`;
    const [rows, unresolved, purposes]: Record<string, unknown>[][] = await Promise.all([
      this.db.query(
        `SELECT jobId, SUM(target = 'llm' AND operation = 'generate') AS generations,
          SUM(target = 'llm' AND operation = 'responses.poll') AS polls,
          SUM(target = 'llm' AND generationId IS NULL) AS legacyUnlinkedRequests,
          SUM(target = 'llm') AS requests,
          SUM(target = 'search') AS searches, SUM(success = 0) AS failed,
          SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens,
          COUNT(inputTokens) AS inputTokensReported, COUNT(outputTokens) AS outputTokensReported, SUM(searchCredits) AS searchCredits,
          SUM(cachedTokens) AS cachedTokens, SUM(reasoningTokens) AS reasoningTokens
         FROM ai_usage WHERE ${where} GROUP BY jobId`,
        range
      ),
      // A generation's usage is resolved when any of its requests (the generation, or the poll completing it)
      // reported it; requests recorded before generations had IDs count one by one
      this.db.query(
        `SELECT jobId, SUM(generated AND NOT reported) AS unreported FROM (
           SELECT jobId, MAX(operation = 'generate' OR generationId IS NOT NULL) AS generated, (MAX(inputTokens IS NOT NULL) AND MAX(outputTokens IS NOT NULL)) AS reported
           FROM ai_usage WHERE ${where} AND target = 'llm'
           GROUP BY jobId, COALESCE(generationId, id)
         ) AS generation GROUP BY jobId`,
        range
      ),
      this.db.query(
        `SELECT jobId, purpose, SUM(operation = 'generate') AS generations, COUNT(*) AS requests
         FROM ai_usage WHERE ${where} AND target = 'llm' AND purpose IS NOT NULL GROUP BY jobId, purpose`,
        range
      )
    ]);
    const byPurpose = new Map<string, Record<string, { generations: number; requests: number }>>();
    for (const row of purposes) {
      const job = String(row.jobId);
      byPurpose.set(job, {
        ...(byPurpose.get(job) || {}),
        [String(row.purpose)]: { generations: Number(row.generations || 0), requests: Number(row.requests || 0) }
      });
    }
    const unreported = new Map(unresolved.map(row => [String(row.jobId), Number(row.unreported || 0)]));
    const optional = (value: unknown) => (value == null ? null : Number(value));
    for (const row of rows)
      totals.set(String(row.jobId), {
        generations: Number(row.generations || 0),
        polls: Number(row.polls || 0),
        legacyUnlinkedRequests: Number(row.legacyUnlinkedRequests || 0),
        requests: Number(row.requests || 0),
        searches: Number(row.searches || 0),
        failed: Number(row.failed || 0),
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
        inputTokensReported: Number(row.inputTokensReported || 0) > 0,
        outputTokensReported: Number(row.outputTokensReported || 0) > 0,
        searchCredits: optional(row.searchCredits),
        cachedTokens: optional(row.cachedTokens),
        reasoningTokens: optional(row.reasoningTokens),
        unreported: unreported.get(String(row.jobId)) ?? 0,
        ...(byPurpose.has(String(row.jobId)) ? { purposes: byPurpose.get(String(row.jobId)) } : {})
      });
    return totals;
  }

  async report(ownerId: number, days = 30) {
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new AiError("INVALID_USAGE_PERIOD");
    const since = new Date(Date.now() - days * 86400000);
    const where = "FROM ai_usage WHERE ownerId=? AND createdAt >= ?";
    const args = [ownerId, since];
    const [totals, providers, daily, recent] = await Promise.all([
      this.db.query(`SELECT ${aggregate} ${where}`, args),
      this.db.query(
        `SELECT target,provider,host,model,${aggregate} ${where} GROUP BY target,provider,host,model ORDER BY requests DESC`,
        args
      ),
      this.db.query(
        `SELECT DATE_FORMAT(createdAt,'%Y-%m-%d') AS date,${aggregate} ${where} GROUP BY date ORDER BY date ASC`,
        args
      ),
      this.usage.find({ where: { ownerId }, order: { createdAt: "DESC" }, take: 50 })
    ]);
    return {
      periodDays: days,
      totals: normalize(totals[0]),
      byProvider: providers.map(normalize),
      daily: daily.map(normalize),
      recent: recent
        .filter(record => record.createdAt >= since)
        .map(record => {
          const safe = { ...record };
          delete safe.ownerId;
          delete safe.responseHash;
          return { ...normalize(safe), success: !!record.success };
        })
    };
  }
}
