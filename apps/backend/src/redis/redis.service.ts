import { Injectable, OnModuleInit } from "@nestjs/common";

import Redis from "ioredis";

import { ConfigService } from "../config/config.service";

const REDIS_CACHE_EXPIRE_TIME = 60 * 60 * 24 * 30; // 7 days

@Injectable()
export class RedisService implements OnModuleInit {
  private readonly client: Redis;

  private readonly untilReady: Promise<void>;

  constructor(private readonly configService: ConfigService) {
    this.client = new Redis(this.configService.config.services.redis, {
      enableReadyCheck: true
    });

    // TODO: Handle errors after connected?
    this.untilReady = new Promise((resolve, reject) => {
      this.client.once("ready", resolve);
      this.client.once("error", reject);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.untilReady;
    } catch (e) {
      throw new Error(`Could not connect to Redis service: ${e}`);
    }
  }

  async cacheSet(key: string, value: string): Promise<void> {
    await this.client.setex(key, REDIS_CACHE_EXPIRE_TIME, value);
  }

  async cacheGet(key: string): Promise<string> {
    return await this.client.get(key);
  }

  async cacheDelete(key: string): Promise<void> {
    await this.client.del(key);
  }

  /** Rejects if Redis doesn't answer (a disconnected client queues the command until it reconnects). */
  async ping(): Promise<void> {
    await this.client.ping();
  }

  /**
   * Whether this process takes the turn of a job that one backend process runs at a time: `true` for the first caller
   * in each period of `milliseconds`. Uses the shared connection; rejects if Redis is unavailable.
   */
  async takeTurn(key: string, milliseconds: number): Promise<boolean> {
    return (await this.client.set(key, String(process.pid), "PX", milliseconds, "NX")) === "OK";
  }

  /**
   * Get a Redis client object to execute Redis commands directly.
   *
   * Each call opens a new connection: call it once (in a constructor) and keep the client, or `quit()` it when done.
   * Please use `cacheGet` and `cacheSet` for caching since they handle the expire time automatically.
   */
  getClient(): Redis {
    return this.client.duplicate();
  }
}
