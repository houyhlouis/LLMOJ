import crypto from "crypto";

import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";
import { Redis } from "ioredis";

import { JudgeClientCapabilities, JudgeClientSystemInfo } from "@libreoj/judge-protocol";

import { JudgeClientEntity } from "./judge-client.entity";
import { JudgeClientInfoDto } from "./dto/judge-client-info.dto";
import { JudgeJobEntity, JudgeJobState } from "./judge-job.entity";

import { RedisService } from "../redis/redis.service";

const JUDGE_CLIENT_KEY_BYTE_LENGTH = 30;

function generateKey(): string {
  return crypto.randomBytes(JUDGE_CLIENT_KEY_BYTE_LENGTH).toString("base64");
}

const REDIS_KEY_JUDGE_CLIENT_SESSION_ID = "judge-client-session-id:%d";
const REDIS_KEY_JUDGE_CLIENT_SYSTEM_INFO = "judge-client-system-info:%s";
const REDIS_KEY_JUDGE_CLIENT_CAPABILITIES = "judge-client-capabilities:%d";

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
      capabilities: (await this.getJudgeClientCapabilities(judgeClient)) ?? undefined
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
    await this.disconnectJudgeClient(judgeClient);
    await this.publishChange({ id: judgeClient.id, revoked: true });
  }

  async deleteJudgeClient(judgeClient: JudgeClientEntity): Promise<void> {
    await this.judgeClientRepository.delete({
      id: judgeClient.id
    });
    await this.disconnectJudgeClient(judgeClient);
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
    await this.redis.set(REDIS_KEY_JUDGE_CLIENT_SESSION_ID.format(judgeClient.id), sessionId);
  }

  async disconnectJudgeClient(judgeClient: JudgeClientEntity): Promise<void> {
    await this.redis.del(REDIS_KEY_JUDGE_CLIENT_SESSION_ID.format(judgeClient.id));
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
    await this.redis.set(REDIS_KEY_JUDGE_CLIENT_CAPABILITIES.format(judgeClient.id), JSON.stringify(capabilities));
  }

  async getJudgeClientCapabilities(judgeClient: JudgeClientEntity): Promise<JudgeClientCapabilities> {
    try {
      return JSON.parse(await this.redis.get(REDIS_KEY_JUDGE_CLIENT_CAPABILITIES.format(judgeClient.id)));
    } catch {
      return null;
    }
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
