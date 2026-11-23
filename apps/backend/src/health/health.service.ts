import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";

import { recordBackendBinding } from "./deployment-history";
import { deploymentBuildIdentity } from "./deployment-identity";

import { JudgeRuntimeEntity } from "../judge/judge-runtime.entity";
import { SettingsEntity } from "../settings/settings.entity";

import { FileService } from "../file/file.service";
import { RedisService } from "../redis/redis.service";

export type HealthCheckName = "database" | "redis" | "storage";

export interface Readiness {
  status: "ready" | "unavailable";
  checks: Record<HealthCheckName, "ok" | "failed">;
}

export interface TimedReadiness {
  status: Readiness["status"];
  database: TimedHealthCheck;
  redis: TimedHealthCheck;
  storage: TimedHealthCheck;
}

interface TimedHealthCheck {
  status: "ok" | "failed";
  durationMs: number;
}

// Each dependency must answer within this time
const CHECK_TIMEOUT = 2000;
// Probes within this time share one check, so that frequent probes can't multiply into dependency queries
const READINESS_CACHE_TIME = 1000;
// A failing dependency is logged at most this often
const FAILURE_LOG_INTERVAL = 60 * 1000;

const logger = new Logger("Health");

export async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`No answer within ${milliseconds} ms`)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether this backend process can serve requests: the database, Redis and object storage answer. */
@Injectable()
export class HealthService implements OnModuleInit {
  checkTimeout = CHECK_TIMEOUT;

  private readiness: { at: number; result: Promise<TimedReadiness> } = null;

  private readonly failureLoggedAt = new Map<HealthCheckName, number>();

  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    private readonly redisService: RedisService,
    private readonly fileService: FileService
  ) {}

  private readonly checks: Record<HealthCheckName, () => Promise<unknown>> = {
    database: () => this.connection.query("SELECT 1"),
    redis: () => this.redisService.ping(),
    storage: async () => {
      if (!(await this.fileService.storageAvailable())) throw new Error("The bucket doesn't exist");
    }
  };

  async onModuleInit() {
    await recordBackendBinding(this.connection, deploymentBuildIdentity.backend);
  }

  async identity() {
    const schema = await this.connection.getRepository(SettingsEntity).findOneBy({ key: "deployment.schema" });
    const recorded = await this.connection
      .getRepository(JudgeRuntimeEntity)
      .find({ order: { firstSeenAt: "DESC" }, take: 20 });
    const { backend, frontend, qualityPolicyVersion, receiptVersion, executionProtocolVersion } =
      deploymentBuildIdentity;
    return {
      backend: { sha256: backend.sha256, status: backend.status, basis: backend.basis, capturedAt: backend.capturedAt },
      frontend: { sha256: frontend.sha256, status: frontend.status, basis: frontend.basis },
      qualityPolicyVersion,
      receiptVersion,
      executionProtocolVersion,
      schema: schema?.value || { version: null, status: "unrecorded" },
      recordedJudgeBuilds: recorded.map(row => ({
        id: row.id,
        sha256: row.judgeProgram,
        firstSeenAt: row.firstSeenAt
      })),
      judgeBuildStatus: "recorded_history; live capabilities are in the admin deploymentIdentity API"
    };
  }

  async ready(): Promise<Readiness> {
    const { status, database, redis, storage } = await this.timedReadiness();
    return { status, checks: { database: database.status, redis: redis.status, storage: storage.status } };
  }

  async timedReadiness(): Promise<TimedReadiness> {
    if (!this.readiness || Date.now() - this.readiness.at >= READINESS_CACHE_TIME)
      this.readiness = { at: Date.now(), result: this.check() };
    return await this.readiness.result;
  }

  private async check(): Promise<TimedReadiness> {
    const names = Object.keys(this.checks) as HealthCheckName[];
    const states = await Promise.all(
      names.map(async name => {
        const start = performance.now();
        try {
          await withTimeout(this.checks[name](), this.checkTimeout);
          return { status: "ok" as const, durationMs: Math.round(performance.now() - start) };
        } catch (e) {
          if (Date.now() - (this.failureLoggedAt.get(name) ?? -Infinity) >= FAILURE_LOG_INTERVAL) {
            this.failureLoggedAt.set(name, Date.now());
            logger.warn(`Readiness check ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          return { status: "failed" as const, durationMs: Math.round(performance.now() - start) };
        }
      })
    );
    const checks = Object.fromEntries(names.map((name, i) => [name, states[i]])) as Record<
      HealthCheckName,
      TimedHealthCheck
    >;
    return { status: states.every(check => check.status === "ok") ? "ready" : "unavailable", ...checks };
  }
}
