import { Inject, Injectable, OnModuleInit, OnModuleDestroy, Optional } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager, IsNull, LessThan } from "typeorm";

import { SubmissionStatus } from "@libreoj/judge-protocol";

import { StatisticsOutboxEntity, StatisticsOutboxKind } from "./statistics-outbox.entity";
import { SubmissionEntity } from "./submission.entity";

import { logger } from "../logger";
import { ProblemEntity } from "../problem/problem.entity";
import { UserEntity } from "../user/user.entity";
import { RedisService } from "../redis/redis.service";
import { MetricsService, sharedReading } from "../metrics/metrics.service";

// Records left by a process that stopped before applying them are applied by the others after this long
const REPLAY_INTERVAL = 60 * 1000;
const REPLAY_AGE = 30 * 1000;
const REPLAY_BATCH = 500;
const REDIS_KEY_REPLAY_TURN = "statistics-outbox:replay-turn";

export type CountedSubmission = Pick<SubmissionEntity, "problemId" | "submitterId" | "contestId" | "status">;

/**
 * Keeps the counts derived from non-contest submissions (problems' submissions and accepted submissions, users'
 * submissions and accepted problems) exact: the transaction that creates, changes or deletes a submission records
 * the change, and each record is applied once, in the transaction that deletes it. Applying locks one problem or
 * user row and nothing else, so it can't deadlock with submissions, which lock those rows for their foreign keys.
 */
@Injectable()
export class StatisticsOutboxService implements OnModuleInit, OnModuleDestroy {
  private replayTimer: ReturnType<typeof setInterval>;

  @Optional() @Inject(MetricsService) private readonly metricsService: MetricsService;

  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    private readonly redisService: RedisService
  ) {}

  onModuleInit(): void {
    this.registerMetrics();
    this.replayTimer = setInterval(() => {
      this.replayTurn().catch(e => logger.error(`Failed to apply recorded count changes: ${e}`));
    }, REPLAY_INTERVAL);
    this.replayTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.replayTimer);
  }

  /** Changes not applied yet, and how old the oldest is: counts lag behind submissions by this much. */
  private registerMetrics(): void {
    if (!this.metricsService) return;
    const pending = sharedReading(async () => {
      const [row]: { pending: string | number; oldestSeconds: string | number | null }[] = await this.connection.query(
        `SELECT COUNT(*) AS pending, TIMESTAMPDIFF(MICROSECOND, MIN(createdAt), NOW(3)) / 1000000 AS oldestSeconds
         FROM statistics_outbox`
      );
      return { pending: Number(row?.pending ?? 0), oldestSeconds: Number(row?.oldestSeconds ?? 0) };
    });
    this.metricsService.gauge("libreoj_statistics_outbox_pending", [], async gauge =>
      gauge.set((await pending()).pending)
    );
    this.metricsService.gauge("libreoj_statistics_outbox_oldest_seconds", [], async gauge =>
      gauge.set((await pending()).oldestSeconds)
    );
  }

  /**
   * Call in the transaction that writes the submission, after writing it.
   *
   * @param before `null` for a new submission
   * @param after `null` for a deleted submission
   * @return The records to `apply` after the transaction commits
   */
  async record(manager: EntityManager, before: CountedSubmission, after: CountedSubmission): Promise<number[]> {
    const { problemId, submitterId, contestId } = after ?? before;
    if (contestId != null) return [];
    const submissions = Number(!!after) - Number(!!before);
    const accepted =
      Number(after?.status === SubmissionStatus.Accepted) - Number(before?.status === SubmissionStatus.Accepted);
    if (!submissions && !accepted) return [];
    const ids: number[] = [];
    for (const [kind, targetId] of [
      [StatisticsOutboxKind.Problem, problemId],
      [StatisticsOutboxKind.User, submitterId]
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- One row each, so that the IDs never depend on auto-increment steps.
      const result = await manager.insert(StatisticsOutboxEntity, {
        kind,
        targetId,
        submissions,
        accepted,
        createdAt: new Date()
      });
      ids.push(result.identifiers[0].id);
    }
    return ids;
  }

  /** Applies records once each. A failure is logged and the record applied again later. */
  async apply(ids: number[]): Promise<void> {
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Each record in its own short transaction.
        await this.applyOne(id);
      } catch (e) {
        logger.warn(`Failed to apply recorded count change ${id}, retrying later: ${e}`);
      }
    }
  }

  private async applyOne(id: number): Promise<void> {
    await this.connection.transaction("READ COMMITTED", async manager => {
      const record = await manager.findOne(StatisticsOutboxEntity, {
        where: { id },
        lock: { mode: "pessimistic_write" }
      });
      // Already applied by another process
      if (!record) return;
      const { kind, targetId, submissions, accepted } = record;
      if (kind === StatisticsOutboxKind.Problem) {
        if (submissions) await manager.increment(ProblemEntity, { id: targetId }, "submissionCount", submissions);
        if (accepted) await manager.increment(ProblemEntity, { id: targetId }, "acceptedSubmissionCount", accepted);
      } else {
        // Lock the user first: accepted problems are counted from the submissions committed when it's locked, and
        // a change committed later has a record of its own that counts them again.
        const user = await manager.findOne(UserEntity, {
          where: { id: targetId },
          select: ["id"],
          lock: { mode: "pessimistic_write" }
        });
        if (user && submissions) await manager.increment(UserEntity, { id: targetId }, "submissionCount", submissions);
        if (user && accepted) {
          const { count } = await manager
            .createQueryBuilder(SubmissionEntity, "submission")
            .select("COUNT(DISTINCT submission.problemId)", "count")
            .where({ submitterId: targetId, status: SubmissionStatus.Accepted, contestId: IsNull() })
            .getRawOne<{ count: string }>();
          await manager.update(UserEntity, { id: targetId }, { acceptedProblemCount: Number(count) });
        }
      }
      await manager.delete(StatisticsOutboxEntity, { id });
    });
  }

  // One backend process replays at a time; if Redis is unavailable, all do (applying is exactly-once anyway).
  private async replayTurn(): Promise<void> {
    let turn = true;
    try {
      turn = await this.redisService.takeTurn(REDIS_KEY_REPLAY_TURN, REPLAY_INTERVAL - 1000);
    } catch {
      /* replay anyway */
    }
    if (turn) await this.replay();
  }

  /**
   * Applies records that weren't applied after their transaction, e.g. because the process stopped.
   *
   * @return How many records were found.
   */
  async replay(olderThanMs = REPLAY_AGE): Promise<number> {
    const records = await this.connection.getRepository(StatisticsOutboxEntity).find({
      where: { createdAt: LessThan(new Date(Date.now() - olderThanMs)) },
      select: ["id"],
      order: { id: "ASC" },
      take: REPLAY_BATCH
    });
    await this.apply(records.map(record => record.id));
    return records.length;
  }
}
