import { once } from "events";
import { join } from "path";
import { performance } from "perf_hooks";
import { setTimeout as delay } from "timers/promises";
import fs from "fs-extra";

import { Injectable, OnModuleDestroy } from "@nestjs/common";

import { Redis } from "ioredis";
import { v4 as uuid } from "uuid";

import {
  HeldLockLease,
  LockLease,
  LockLeaseLostError,
  LockOwner,
  LOCK_REFRESH_INTERVAL,
  LOCK_TTL,
  assertLockLeasesHeld,
  currentLockLeases
} from "./lock-lease";
import { RedisService } from "./redis.service";

// The scripts return a truthy reply only for a successful operation by this owner.
interface RedisWithLock extends Redis {
  callLock(...args: (string | number)[]): Promise<unknown>;
  callReadWriteLock(...args: (string | number)[]): Promise<unknown>;
}

const LOCK_RETRY_DELAY = 1000;
const LOCK_MAX_RETRY = 30;
type LockCommand = (action: "lock" | "refresh" | "check" | "unlock", ...ttl: number[]) => Promise<unknown>;

@Injectable()
export class LockService implements OnModuleDestroy {
  private readonly redis: RedisWithLock;

  private readonly active = new Set<LockLease>();

  private readonly shutdown = new AbortController();

  constructor(redisService: RedisService) {
    // Acquires and renewals must not be replayed after reconnect, and cleanup must have a bounded wait.
    this.redis = redisService.getClient({
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
      commandTimeout: LOCK_REFRESH_INTERVAL
    }) as RedisWithLock;
    this.redis.defineCommand("callLock", {
      numberOfKeys: 1,
      lua: fs.readFileSync(join(__dirname, "scripts", "lock.lua"), "utf8")
    });
    this.redis.defineCommand("callReadWriteLock", {
      numberOfKeys: 3,
      lua: fs.readFileSync(join(__dirname, "scripts", "read-write-lock.lua"), "utf8")
    });
    this.redis.on("close", () => {
      for (const lease of this.active) lease.lose(new Error("Redis lock connection closed"));
    });
  }

  onModuleDestroy(): void {
    if (this.shutdown.signal.aborted) return;
    const reason = new LockLeaseLostError(new Error("Lock service is shutting down"), "shutdown");
    this.shutdown.abort(reason);
    for (const lease of this.active) lease.lose(reason);
    // No blocking QUIT during shutdown. The server expires any remaining token within one TTL.
    this.redis.disconnect();
  }

  private async internalLock<T>(
    name: string,
    owner: LockOwner,
    command: LockCommand,
    callback: (lease: HeldLockLease) => Promise<T>
  ): Promise<T> {
    const parents = currentLockLeases();
    const signal = parents.length
      ? AbortSignal.any([this.shutdown.signal, ...parents.map(lease => lease.signal)])
      : this.shutdown.signal;
    signal.throwIfAborted();
    let sentAt: number;
    try {
      // A new duplicate connection can still be handshaking on its first use.
      if (this.redis.status === "connecting" || this.redis.status === "connect")
        await once(this.redis, "ready", { signal: AbortSignal.any([signal, AbortSignal.timeout(LOCK_TTL)]) });

      /* eslint-disable no-await-in-loop */
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted();
        assertLockLeasesHeld();
        sentAt = performance.now();
        if (await command("lock", LOCK_TTL)) break;
        if (attempt === LOCK_MAX_RETRY)
          throw new Error(`Retries limit exceeded while attempting to lock ${JSON.stringify(name)}`);
        await delay(LOCK_RETRY_DELAY, undefined, { signal });
      }
      /* eslint-enable no-await-in-loop */
    } catch (error) {
      // An aborted wait or an acquisition interrupted by disconnect belongs to the cancellation that stopped it.
      signal.throwIfAborted();
      throw error;
    }
    const lease = new LockLease(
      owner,
      sentAt,
      () => command("refresh", LOCK_TTL),
      () => command("check")
    );
    this.active.add(lease);
    try {
      if (signal.aborted) lease.lose(signal.reason);
      return await lease.run(callback, () =>
        this.shutdown.signal.aborted ? Promise.resolve(true) : command("unlock")
      );
    } finally {
      this.active.delete(lease);
    }
  }

  /** Run a callback while its token owns the named key. */
  async lock<T>(name: string, callback: (lease: HeldLockLease) => Promise<T>): Promise<T> {
    const token = uuid();
    return await this.internalLock(
      name,
      { key: name, token, reader: false },
      (action, ...ttl) => this.redis.callLock(name, action, token, ...ttl),
      callback
    );
  }

  /** Readers can coexist. A waiting writer keeps new readers from entering. */
  async lockReadWrite<T>(
    name: string,
    type: "Read" | "Write",
    callback: (lease: HeldLockLease) => Promise<T>
  ): Promise<T> {
    const prefix = `rwlock-v2:${name}`;
    const keys = [`${prefix}:write-intent`, `${prefix}:write-lock`, `${prefix}:readers`];
    const reader = type === "Read";
    const mode = reader ? "read" : "write";
    const token = uuid();
    return await this.internalLock(
      `${type}(${name})`,
      { key: keys[reader ? 2 : 1], token, reader },
      (action, ...ttl) => this.redis.callReadWriteLock(...keys, `${mode}_${action}`, token, ...ttl),
      callback
    );
  }
}
