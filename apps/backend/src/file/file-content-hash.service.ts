import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { FileService } from "./file.service";

import { logger } from "../logger";
import { RedisService } from "../redis/redis.service";

const RUN_INTERVAL = 60 * 1000;
// What one run reads from storage at most (always at least one file)
const RUN_MAXIMUM_FILES = 200;
const RUN_MAXIMUM_BYTES = 1024 * 1024 * 1024;
// After all files have been looked at, the ones that couldn't be read are tried again this much later
const PASS_INTERVAL = 6 * 60 * 60 * 1000;
const REDIS_KEY_TURN = "file-content-hash:turn";

/**
 * Records the content hashes of stored files that don't have one: files from before content hashes, and files added
 * another way. Judges check a file against its hash once it's recorded.
 */
@Injectable()
export class FileContentHashService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval>;

  private running = false;

  private afterId = 0;

  private nextPassAt = 0;

  private recordedInPass = 0;

  private skippedInPass = 0;

  constructor(private readonly fileService: FileService, private readonly redisService: RedisService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.turn().catch(e => logger.error(`Failed to record the content hashes of stored files: ${e}`));
    }, RUN_INTERVAL);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  // One backend process reads at a time; if Redis is unavailable, each does (recording a hash is idempotent).
  private async turn(): Promise<void> {
    if (this.running || Date.now() < this.nextPassAt) return;
    let turn = true;
    try {
      turn = await this.redisService.takeTurn(REDIS_KEY_TURN, RUN_INTERVAL - 1000);
    } catch {
      /* read anyway */
    }
    if (!turn) return;
    this.running = true;
    try {
      await this.run();
    } finally {
      this.running = false;
    }
  }

  /** Continues where the last run stopped. */
  async run(): Promise<void> {
    const { lastId, recorded, skipped } = await this.fileService.recordMissingContentHashes(
      this.afterId,
      RUN_MAXIMUM_FILES,
      RUN_MAXIMUM_BYTES
    );
    this.recordedInPass += recorded;
    this.skippedInPass += skipped;
    if (lastId !== null) {
      this.afterId = lastId;
      return;
    }
    if (this.recordedInPass || this.skippedInPass)
      logger.log(
        `Recorded the content hashes of ${this.recordedInPass} stored files${
          this.skippedInPass ? `; ${this.skippedInPass} files were missing or had another size` : ""
        }`
      );
    this.afterId = 0;
    this.recordedInPass = 0;
    this.skippedInPass = 0;
    this.nextPassAt = Date.now() + PASS_INTERVAL;
  }
}
