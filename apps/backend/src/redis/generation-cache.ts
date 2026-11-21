import { randomUUID } from "crypto";

import type Redis from "ioredis";

// Each object is a hash. Its fixed lifetime bounds every field, including the generation itself.
// A fresh epoch distinguishes a recreated hash from one a slow SQL reader saw before expiry or eviction.
const READ = `
  if redis.call("hsetnx", KEYS[1], "epoch", ARGV[1]) == 1 then
    redis.call("hset", KEYS[1], "generation", 0)
    redis.call("expire", KEYS[1], ARGV[2])
  end
  return redis.call("hmget", KEYS[1], "epoch", "generation", ARGV[3])
`;
const FILL = `
  local current = redis.call("hmget", KEYS[1], "epoch", "generation")
  if current[1] == ARGV[1] and current[2] == ARGV[2] then
    return redis.call("hset", KEYS[1], ARGV[3], ARGV[4])
  end
`;
const INVALIDATE = `
  if redis.call("exists", KEYS[1]) == 1 then
    redis.call("hincrby", KEYS[1], "generation", 1)
    return redis.call("hdel", KEYS[1], unpack(ARGV))
  end
`;

export class GenerationCache {
  private readonly missed = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly client: Redis) {
    client.on("ready", () => {
      for (const key of this.missed.keys()) this.discardMissed(key).catch(() => undefined);
    });
  }

  /** Read one variant of an object, or compute it against the generation observed before the SQL read. */
  async read<T>(
    key: string,
    field: string,
    ttlSeconds: number,
    compute: () => Promise<T>,
    refresh = false
  ): Promise<T> {
    if (this.client.status !== "ready") return await compute();
    let snapshot: [string, string, string | null];
    try {
      if (this.missed.has(key)) await this.discardMissed(key);
      if (!this.missed.has(key))
        snapshot = (await this.client.eval(READ, 1, key, randomUUID(), ttlSeconds, field)) as typeof snapshot;
    } catch {
      // Redis couldn't establish a generation for this read.
    }
    if (!snapshot) return await compute();
    if (!refresh && snapshot[2] !== null) {
      try {
        return JSON.parse(snapshot[2]);
      } catch {
        // Replace an unreadable cache entry from SQL under the same generation check.
      }
    }

    const result = await compute();
    if (this.client.status === "ready" && !this.missed.has(key)) {
      await this.client
        .eval(FILL, 1, key, snapshot[0], snapshot[1], field, JSON.stringify(result))
        .catch(() => undefined);
    }
    return result;
  }

  /** Advance the generation even when these variants haven't finished their first fill. Call after commit. */
  async invalidate(key: string, fields: string[], ttlSeconds: number): Promise<void> {
    if (this.client.status === "ready") {
      try {
        await this.client.eval(INVALIDATE, 1, key, ...fields);
        return;
      } catch {
        // Retry after reconnect, or on the next read if the connection stayed open.
      }
    }
    clearTimeout(this.missed.get(key));
    this.missed.set(key, setTimeout(() => this.missed.delete(key), ttlSeconds * 1000).unref());
  }

  private async discardMissed(key: string): Promise<void> {
    const pending = this.missed.get(key);
    await this.client.del(key);
    if (this.missed.get(key) === pending) {
      clearTimeout(pending);
      this.missed.delete(key);
    }
  }
}
