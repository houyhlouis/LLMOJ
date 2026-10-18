import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";

import { FileService } from "../file/file.service";
import { RedisService } from "../redis/redis.service";

export type HealthCheckName = "database" | "redis" | "storage";

export interface Readiness {
  status: "ready" | "unavailable";
  checks: Record<HealthCheckName, "ok" | "failed">;
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
export class HealthService {
  checkTimeout = CHECK_TIMEOUT;

  private readiness: { at: number; result: Promise<Readiness> } = null;

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

  async ready(): Promise<Readiness> {
    if (!this.readiness || Date.now() - this.readiness.at >= READINESS_CACHE_TIME)
      this.readiness = { at: Date.now(), result: this.check() };
    return await this.readiness.result;
  }

  private async check(): Promise<Readiness> {
    const names = Object.keys(this.checks) as HealthCheckName[];
    const states = await Promise.all(
      names.map(async name => {
        try {
          await withTimeout(this.checks[name](), this.checkTimeout);
          return "ok" as const;
        } catch (e) {
          if (Date.now() - (this.failureLoggedAt.get(name) ?? -Infinity) >= FAILURE_LOG_INTERVAL) {
            this.failureLoggedAt.set(name, Date.now());
            logger.warn(`Readiness check ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          return "failed" as const;
        }
      })
    );
    return {
      status: states.every(state => state === "ok") ? "ready" : "unavailable",
      checks: Object.fromEntries(names.map((name, index) => [name, states[index]])) as Readiness["checks"]
    };
  }
}
