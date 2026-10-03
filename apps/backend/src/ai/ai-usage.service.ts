import { createHash, randomUUID } from "crypto";

import { Injectable } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { DataSource, Repository } from "typeorm";

import { AiResponseCheckpointEntity, AiUsageEntity } from "./ai-usage.entity";
import { AiRuntimeContext, AiUsageRecord } from "./ai-runtime";
import { AiError } from "./ai.types";

import { UserEntity } from "../user/user.entity";

const aggregate = `COUNT(*) AS requests, SUM(success = 1) AS succeeded, SUM(success = 0) AS failed,
SUM(elapsedMs) AS elapsedMs, SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens,
SUM(cachedTokens) AS cachedTokens, SUM(reasoningTokens) AS reasoningTokens, SUM(searchCredits) AS searchCredits,
SUM(target = 'llm' AND operation = 'generate' AND usageReported = 0) AS unknownTokenRequests`;
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
  "unknownTokenRequests"
];
function normalize(row: Record<string, unknown>) {
  const result = { ...row };
  for (const field of numeric)
    if (field in row)
      result[field] =
        row[field] == null
          ? numeric.slice(0, 4).includes(field) || field === "unknownTokenRequests"
            ? 0
            : null
          : Number(row[field]);
  return result;
}
@Injectable()
export class AiUsageService {
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
      record: record => this.record(ownerId, jobId, record),
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

  private async record(ownerId: number, jobId: string | undefined, record: AiUsageRecord) {
    const { responseId, ...metadata } = record;
    const responseHash = responseId
      ? createHash("sha256")
          .update(`${jobId || "connection"}\n${record.host}\n${responseId}`)
          .digest("hex")
      : null;
    await this.db.transaction(async manager => {
      // Serializing one owner's metering also prevents counting a recovered response's tokens twice.
      await manager.findOne(UserEntity, { where: { id: ownerId }, lock: { mode: "pessimistic_write" } });
      const repository = manager.getRepository(AiUsageEntity);
      if (
        responseHash &&
        metadata.usageReported &&
        (await repository.findOneBy({ ownerId, responseHash, usageReported: true }))
      ) {
        metadata.inputTokens = null;
        metadata.outputTokens = null;
        metadata.cachedTokens = null;
        metadata.reasoningTokens = null;
        metadata.searchCredits = null;
        // A repeated retrieval has known zero additional reported token usage, not unknown billing.
        metadata.usageReported = true;
      }
      await repository.insert({ id: randomUUID(), ownerId, jobId: jobId || null, ...metadata, responseHash });
    });
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
