import crypto from "crypto";

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";
import { Redis } from "ioredis";

import { JudgeClientCapabilities, JudgeClientSystemInfo } from "@libreoj/judge-protocol";

import { JudgeClientEntity } from "./judge-client.entity";
import { JudgeClientInfoDto } from "./dto/judge-client-info.dto";
import { JudgeJobEntity, JudgeJobState } from "./judge-job.entity";
import { C_ARCHITECTURES, judgeClientArchitectures } from "./judge-architecture";

import { workerProvenance } from "../health/deployment-identity";
import { RedisService } from "../redis/redis.service";
import { writeWithLockLeases } from "../redis/lease-redis-command";

const JUDGE_CLIENT_KEY_BYTE_LENGTH = 30;

function generateKey(): string {
  return crypto.randomBytes(JUDGE_CLIENT_KEY_BYTE_LENGTH).toString("base64");
}

const REDIS_KEY_JUDGE_CLIENT_SESSION_ID = "judge-client-session-id:%d";
const REDIS_KEY_JUDGE_CLIENT_SYSTEM_INFO = "judge-client-system-info:%s";
const lastSeenKey = (id: number) => `judge-client-last-seen:${id}`;
const revokedKey = (id: number) => `judge-client-session-revoked:${id}`;
const REDIS_KEY_JUDGE_CLIENT_CAPABILITIES = "judge-client-capabilities:%d";

// The judge clients' architectures are read again after this long
const FLEET_ARCHITECTURES_CACHE = 10 * 1000;

// Tells every backend process that a judge client changed: its key was reset or it was deleted (`revoked`: its
// connections are closed), or it was drained or resumed.
export const REDIS_CHANNEL_JUDGE_CLIENT_CHANGED = "judge-client-changed";

export interface JudgeClientChange {
  id: number;
  revoked: boolean;
}

@Injectable()
export class JudgeClientService {
  private readonly redis: Redis;

  private fleetArchitectures: { value: Promise<string[]>; until: number } = null;

  constructor(
    @InjectRepository(JudgeClientEntity)
    private readonly judgeClientRepository: Repository<JudgeClientEntity>,
    @InjectRepository(JudgeJobEntity)
    private readonly judgeJobRepository: Repository<JudgeJobEntity>,
    private readonly redisService: RedisService
  ) {
    this.redis = this.redisService.getClient();
  }

  async findJudgeClientById(id: number): Promise<JudgeClientEntity> {
    return await this.judgeClientRepository.findOneBy({ id });
  }

  async findJudgeClientByKey(key: string): Promise<JudgeClientEntity> {
    return await this.judgeClientRepository.findOneBy({ key });
  }

  async listJudgeClients(): Promise<JudgeClientEntity[]> {
    return await this.judgeClientRepository.find();
  }

  async getJudgeClientInfo(
    judgeClient: JudgeClientEntity,
    showSensitive = false,
    showKey = showSensitive
  ): Promise<JudgeClientInfoDto> {
    const capabilities = (await this.getJudgeClientCapabilities(judgeClient)) ?? undefined;
    return {
      id: judgeClient.id,
      name: judgeClient.name,
      key: showSensitive && showKey ? judgeClient.key : null,
      allowedHosts: !showSensitive ? null : judgeClient.allowedHosts,
      online: await this.isJudgeClientOnline(judgeClient),
      systemInfo: await this.getJudgeClientSystemInfo(judgeClient),
      draining: judgeClient.draining,
      runningTasks: await this.judgeJobRepository.countBy({
        judgeClientId: judgeClient.id,
        state: JudgeJobState.Leased
      }),
      capabilities,
      provenance: showSensitive ? workerProvenance(capabilities?.runtime?.judgeProgram) : undefined
    };
  }

  async addJudgeClient(name: string, allowedHosts: string[]): Promise<JudgeClientEntity> {
    const judgeClient = new JudgeClientEntity();
    judgeClient.name = name;
    judgeClient.key = generateKey();
    judgeClient.allowedHosts = allowedHosts;
    await this.judgeClientRepository.save(judgeClient);

    return judgeClient;
  }

  // The old key stops working at once: connections using it are closed, and their tasks are queued again.
  async resetJudgeClientKey(judgeClient: JudgeClientEntity): Promise<void> {
    judgeClient.key = generateKey();
    await this.judgeClientRepository.save(judgeClient);
    const replies = await this.redis
      .multi()
      .del(REDIS_KEY_JUDGE_CLIENT_SESSION_ID.format(judgeClient.id))
      .set(revokedKey(judgeClient.id), "1")
      .exec();
    if (replies[0][0]) throw replies[0][0]; // Preserve failure reporting if invalidating the old session failed.
    await this.publishChange({ id: judgeClient.id, revoked: true });
  }

  async deleteJudgeClient(judgeClient: JudgeClientEntity): Promise<void> {
    await this.judgeClientRepository.delete({
      id: judgeClient.id
    });
    await this.redis.del(
      REDIS_KEY_JUDGE_CLIENT_SESSION_ID.format(judgeClient.id),
      lastSeenKey(judgeClient.id),
      revokedKey(judgeClient.id)
    );
    await this.publishChange({ id: judgeClient.id, revoked: true });
  }

  async setJudgeClientDraining(judgeClient: JudgeClientEntity, draining: boolean): Promise<void> {
    await this.judgeClientRepository.update({ id: judgeClient.id }, { draining });
    judgeClient.draining = draining;
    await this.publishChange({ id: judgeClient.id, revoked: false });
  }

  private async publishChange(change: JudgeClientChange): Promise<void> {
    await this.redis.publish(REDIS_CHANNEL_JUDGE_CLIENT_CHANGED, JSON.stringify(change));
  }

  async setJudgeClientOnlineSessionId(judgeClient: JudgeClientEntity, sessionId: string): Promise<void> {
    await writeWithLockLeases(
      this.redis,
      "mset",
      REDIS_KEY_JUDGE_CLIENT_SESSION_ID.format(judgeClient.id),
      sessionId,
      revokedKey(judgeClient.id),
      "0",
      lastSeenKey(judgeClient.id),
      String(Date.now())
    );
  }

  async disconnectJudgeClient(judgeClient: JudgeClientEntity): Promise<void> {
    await writeWithLockLeases(this.redis, "del", REDIS_KEY_JUDGE_CLIENT_SESSION_ID.format(judgeClient.id));
  }

  /** Clean up a disconnected socket even if its lock was lost after it registered its session. */
  async forgetDisconnectedSession(judgeClient: JudgeClientEntity, sessionId: string): Promise<void> {
    await this.redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end',
      1,
      REDIS_KEY_JUDGE_CLIENT_SESSION_ID.format(judgeClient.id),
      sessionId
    );
  }

  async checkJudgeClientSession(judgeClient: JudgeClientEntity, sessionId: string): Promise<boolean> {
    return sessionId === (await this.redis.get(REDIS_KEY_JUDGE_CLIENT_SESSION_ID.format(judgeClient.id)));
  }

  async updateJudgeClientSystemInfo(judgeClient: JudgeClientEntity, systemInfo: JudgeClientSystemInfo): Promise<void> {
    await this.redis.set(REDIS_KEY_JUDGE_CLIENT_SYSTEM_INFO.format(judgeClient.id), JSON.stringify(systemInfo));
  }

  async updateJudgeClientCapabilities(
    judgeClient: JudgeClientEntity,
    capabilities: JudgeClientCapabilities
  ): Promise<void> {
    await writeWithLockLeases(
      this.redis,
      "set",
      REDIS_KEY_JUDGE_CLIENT_CAPABILITIES.format(judgeClient.id),
      JSON.stringify(capabilities)
    );
  }

  async getJudgeClientCapabilities(judgeClient: JudgeClientEntity): Promise<JudgeClientCapabilities> {
    try {
      return JSON.parse(await this.redis.get(REDIS_KEY_JUDGE_CLIENT_CAPABILITIES.format(judgeClient.id)));
    } catch {
      return null;
    }
  }

  /**
   * The architectures the site's judge clients build C and C++ programs for (see judge-architecture.ts), by what each
   * announced when it last connected, online or not. All of them while none has announced anything, as before any
   * judge client ran on arm64.
   */
  async getFleetArchitectures(): Promise<string[]> {
    if (!this.fleetArchitectures || this.fleetArchitectures.until < Date.now()) {
      const value = (async () => {
        const announced = (
          await Promise.all((await this.listJudgeClients()).map(client => this.getJudgeClientCapabilities(client)))
        ).filter(capabilities => capabilities && typeof capabilities === "object");
        if (announced.length === 0) return [...C_ARCHITECTURES];
        const built = new Set(announced.flatMap(judgeClientArchitectures));
        return C_ARCHITECTURES.filter(architecture => built.has(architecture));
      })();
      this.fleetArchitectures = { value, until: Date.now() + FLEET_ARCHITECTURES_CACHE };
      value.catch(() => {
        if (this.fleetArchitectures?.value === value) this.fleetArchitectures = null;
      });
    }
    return await this.fleetArchitectures.value;
  }

  private samplingPresence = false;

  /** Last observed open connection, refreshed by the same timer that renews its task leases. */
  async noteConnected(ids: number[]): Promise<void> {
    if (!ids.length || this.samplingPresence) return;
    this.samplingPresence = true;
    try {
      const now = String(Date.now());
      const pipeline = this.redis.pipeline();
      // A stale socket snapshot must not recreate a deleted machine's key.
      for (const id of ids) pipeline.set(lastSeenKey(id), now, "XX");
      await pipeline.exec();
    } finally {
      this.samplingPresence = false;
    }
  }

  /** Read one bounded batch, without accessing machine keys, allowed hosts, names or raw system info. */
  async diagnosticStates(ids: number[]) {
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.exists(REDIS_KEY_JUDGE_CLIENT_SESSION_ID.format(id));
      pipeline.get(REDIS_KEY_JUDGE_CLIENT_CAPABILITIES.format(id));
      pipeline.get(lastSeenKey(id));
      pipeline.get(revokedKey(id));
    }
    const values = await pipeline.exec();
    const at = (i: number) => (values[i][0] ? null : values[i][1]);
    return ids.map((id, i) => {
      let caps: JudgeClientCapabilities = null;
      try {
        caps = JSON.parse(at(i * 4 + 1) as string);
      } catch {
        // No valid announcement available.
      }
      const online = at(i * 4);
      const revoked = at(i * 4 + 3);
      return {
        id,
        online: online == null ? null : !!online,
        capabilities: caps,
        seenAt: Number(at(i * 4 + 2)) || null,
        revoked: revoked == null ? null : revoked === "1"
      };
    });
  }

  async getJudgeClientSystemInfo(judgeClient: JudgeClientEntity): Promise<JudgeClientSystemInfo> {
    const str = await this.redis.get(REDIS_KEY_JUDGE_CLIENT_SYSTEM_INFO.format(judgeClient.id));
    try {
      return JSON.parse(str);
    } catch (e) {
      return null;
    }
  }

  async isJudgeClientOnline(judgeClient: JudgeClientEntity): Promise<boolean> {
    return !!(await this.redis.get(REDIS_KEY_JUDGE_CLIENT_SESSION_ID.format(judgeClient.id)));
  }
}
