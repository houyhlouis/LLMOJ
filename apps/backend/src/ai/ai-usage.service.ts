import { randomUUID } from "crypto";

import { Inject, Injectable } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { DataSource, Repository } from "typeorm";

import { AiResponseCheckpointEntity, AiUsageEntity } from "./ai-usage.entity";
import { AiRuntimeContext, AiUsageRecord } from "./ai-runtime";
import { AiError } from "./ai.types";
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
  requests: number;
  searches: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
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

  context(ownerId: number, jobId?: string, checkActive?: () => Promise<void>): AiRuntimeContext {
    return {
      ownerId,
      jobId,
      checkActive,
      record: (record, reservationId) => this.record(ownerId, jobId, record, reservationId),
      ...(jobId
        ? {
            loadResponse: async requestHash => {
              const saved = await this.responses.findOneBy({ ownerId, jobId, requestHash });
              return saved ? { responseId: saved.responseId, createdAt: saved.createdAt.getTime() } : null;
            },
            saveResponse: async (requestHash, value) => {
              await this.responses.upsert(
                { ownerId, jobId, requestHash, responseId: value.responseId, createdAt: new Date(value.createdAt) },
                ["ownerId", "jobId", "requestHash"]
              );
            }
          }
        : {})
    };
  }

  private async record(ownerId: number, jobId: string | undefined, record: AiUsageRecord, reservationId?: string) {
    const { responseId, ...metadata } = record;
    delete metadata.pendingResponseId;
    const responseHash = responseId ? aiResponseHash(jobId, record.host, responseId) : null;
    await this.db.transaction(async manager => {
      // Serializing one owner's metering also prevents counting a recovered response's tokens twice.
      await manager.findOne(UserEntity, { where: { id: ownerId }, lock: { mode: "pessimistic_write" } });
      const repository = manager.getRepository(AiUsageEntity);
      // Whether the provider reported what this request used, so that its budget reservation can be released.
      let confirmed =
        metadata.usageReported &&
        (metadata.target === "search" || (metadata.inputTokens != null && metadata.outputTokens != null));
      if (
        responseHash &&
        metadata.usageReported &&
        (await repository.findOneBy({ ownerId, responseHash, usageReported: true }))
      ) {
        confirmed = true;
        metadata.inputTokens = null;
        metadata.outputTokens = null;
        metadata.cachedTokens = null;
        metadata.reasoningTokens = null;
        metadata.searchCredits = null;
        // A repeated retrieval has known zero additional reported token usage, not unknown billing.
        metadata.usageReported = true;
      }
      await repository.insert({ id: randomUUID(), ownerId, jobId: jobId || null, ...metadata, responseHash });
      await this.admission?.settle(manager, ownerId, jobId, record, reservationId, confirmed, responseHash);
    });
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
        `SELECT jobId, SUM(target = 'llm' AND operation = 'generate') AS generations, SUM(target = 'llm') AS requests,
          SUM(target = 'search') AS searches, SUM(success = 0) AS failed,
          SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens,
          SUM(cachedTokens) AS cachedTokens, SUM(reasoningTokens) AS reasoningTokens
         FROM ai_usage WHERE ${where} GROUP BY jobId`,
        range
      ),
      // A generation's usage is resolved when any of its requests (the generation, or the poll completing it)
      // reported it; requests recorded before generations had IDs count one by one
      this.db.query(
        `SELECT jobId, SUM(generated AND NOT reported) AS unreported FROM (
           SELECT jobId, MAX(operation = 'generate') AS generated, MAX(usageReported) AS reported
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
        requests: Number(row.requests || 0),
        searches: Number(row.searches || 0),
        failed: Number(row.failed || 0),
        inputTokens: Number(row.inputTokens || 0),
        outputTokens: Number(row.outputTokens || 0),
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
