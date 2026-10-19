import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { loadAiEncryptionKey, encryptAiConfiguration, decryptAiConfiguration } from "./ai-crypto";

import { AiConfigurationEntity } from "./ai.entity";
import { AiConfiguration, defaultConfiguration } from "./ai.types";

import { signAiAttachment, readAiAttachment } from "./ai-attachment";

import { UserEntity } from "../user/user.entity";

/**
 * Each user's AI provider configuration, stored encrypted with the site's AI key, and the attachment tokens signed
 * with the same key.
 */
@Injectable()
export class AiConfigurationService implements OnModuleInit {
  private key: Buffer;

  private keyLoading: Promise<Buffer>;

  constructor(
    @InjectRepository(AiConfigurationEntity) private readonly configurations: Repository<AiConfigurationEntity>
  ) {}

  async onModuleInit() {
    await this.loadKey();
  }

  /** The site's AI key, loaded once. Everything that reads configurations waits for it. */
  async loadKey(): Promise<Buffer> {
    if (this.key) return this.key;
    this.keyLoading ||= (async () => {
      const directory = process.env.HYHOJ_AI_STATE_DIR || "/opt/LLMOJ/data/ai";
      return await loadAiEncryptionKey(directory, (await this.configurations.count()) > 0);
    })();
    this.key = await this.keyLoading;
    return this.key;
  }

  private encrypt(value: AiConfiguration) {
    return encryptAiConfiguration(this.key, value);
  }

  private decrypt(value: string): AiConfiguration {
    return decryptAiConfiguration(this.key, value);
  }

  async config(userId: number): Promise<AiConfiguration> {
    const stored = await this.configurations.findOneBy({ userId });
    const config = stored ? this.decrypt(stored.encrypted) : JSON.parse(JSON.stringify(defaultConfiguration));
    config.maxConcurrentJobs =
      Number.isInteger(config.maxConcurrentJobs) && config.maxConcurrentJobs >= 1 && config.maxConcurrentJobs <= 8
        ? config.maxConcurrentJobs
        : 3;
    config.llm.responsesRecovery ||= "auto";
    return config;
  }

  /** Stores the user's configuration, encrypted. */
  async save(userId: number, config: AiConfiguration) {
    await this.configurations.save({ userId, encrypted: this.encrypt(config) });
  }

  /** A token for an attachment the user uploads, valid for a day. */
  signAttachment(value: Parameters<typeof signAiAttachment>[1]) {
    const attachmentToken = signAiAttachment(this.key, value);
    readAiAttachment(this.key, attachmentToken, value.ownerId);
    return attachmentToken;
  }

  validateAttachmentToken(user: UserEntity, token: string, admittedAt?: Date) {
    return readAiAttachment(this.key, token, user.id, admittedAt ? new Date(admittedAt).getTime() : Date.now());
  }
}
