import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import {
  DataSource,
  EntityManager,
  EntitySubscriberInterface,
  TransactionCommitEvent,
  TransactionRollbackEvent
} from "typeorm";

import { logger } from "../logger";
import { RedisService } from "../redis/redis.service";

// A contest without changes for this long starts its revisions again; cached scores never live this long
const REVISION_KEEP_SECONDS = 30 * 24 * 60 * 60;
const CHANGED_CONTESTS = "changedContestScoreKeys";

const revisionKey = (contestId: number, virtual: boolean) =>
  virtual ? `contest-virtual-score-revision:${contestId}` : `contest-score-revision:${contestId}`;

/**
 * A revision of each contest's submissions, for caching what's computed from all of them (scores). The transaction
 * that creates, changes or deletes a contest's submission notes the contest (see `StatisticsOutboxService.record`),
 * and its revision moves on once the transaction commits.
 */
@Injectable()
export class ContestScoreRevisionService implements EntitySubscriberInterface, OnModuleInit {
  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    private readonly redisService: RedisService
  ) {}

  onModuleInit(): void {
    this.connection.subscribers.push(this);
  }

  /** Call in the transaction that writes a submission of the contest. */
  noteChange(manager: EntityManager, contestId: number, virtual = false): void {
    const key = revisionKey(contestId, virtual);
    const { queryRunner } = manager;
    if (!queryRunner?.isTransactionActive) {
      this.advance([key]);
      return;
    }
    if (!queryRunner.data[CHANGED_CONTESTS]) queryRunner.data[CHANGED_CONTESTS] = new Set<string>();
    queryRunner.data[CHANGED_CONTESTS].add(key);
  }

  afterTransactionCommit(event: TransactionCommitEvent): void {
    // A savepoint was released, not the transaction committed
    if (event.queryRunner.isTransactionActive) return;
    const changed: Set<string> = event.queryRunner.data?.[CHANGED_CONTESTS];
    if (!changed) return;
    delete event.queryRunner.data[CHANGED_CONTESTS];
    this.advance([...changed]);
  }

  afterTransactionRollback(event: TransactionRollbackEvent): void {
    if (!event.queryRunner.isTransactionActive) delete event.queryRunner.data?.[CHANGED_CONTESTS];
  }

  /** The contest's current revision; rejects without Redis. */
  async revision(contestId: number, virtual = false): Promise<string> {
    return (await this.redisService.cacheGet(revisionKey(contestId, virtual))) ?? "0";
  }

  // Never delays or fails the commit it follows: a revision that couldn't move on is caught up by the cache's time limit
  private advance(keys: string[]): void {
    Promise.all(keys.map(key => this.redisService.increment(key, REVISION_KEEP_SECONDS))).catch(e =>
      logger.warn(`Failed to update contest score revisions: ${e}`)
    );
  }
}
