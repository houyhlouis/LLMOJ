import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager, In, IsNull, Not } from "typeorm";

import { DeferredFileDeletionEntity } from "./deferred-file-deletion.entity";
import { ProblemDataVersionEntity } from "./problem-data-version.entity";
import { ProblemDataVersionKeepEntity } from "./problem-data-version-keep.entity";
import { ProblemFileEntity } from "./problem-file.entity";
import { ProblemEntity } from "./problem.entity";
import type { TestDataAvailabilityDto } from "./dto/test-data-availability.dto";

import { logger } from "../logger";
import { FileEntity } from "../file/file.entity";
import { FileService } from "../file/file.service";
import { RedisService } from "../redis/redis.service";
import { SubmissionEntity } from "../submission/submission.entity";
import { SubmissionResultHistoryEntity } from "../submission/submission-result-history.entity";
import { ContestEntity } from "../contest/contest.entity";
import { HackEntity } from "../hack/hack.entity";
import { SelfEvalEntity, SelfEvalSetEntity } from "../self-eval/self-eval.entity";
import { UserEntity } from "../user/user.entity";
import { TestDataRetentionPolicyService } from "../settings/test-data-retention-policy.service";

// A removed test data file is kept at least this long, so that a submission whose data version was taken just before
// the removal, but not committed yet, finds its files
const DEFERRED_DELETION_GRACE = 15 * 60 * 1000;
export const SWEEP_INTERVAL = 10 * 60 * 1000;
const SWEEP_BATCH = 1000;
// The report looks at no more removed files than this
const REPORT_LIMIT = 10000;
const REDIS_KEY_SWEEP_TURN = "problem-data-version:sweep-turn";
const DAY = 24 * 60 * 60 * 1000;

/** Why a removed test data file stays. */
export enum TestDataRetentionReasonKind {
  // Removed less than 15 minutes ago: a submission whose data version was taken just before may not be saved yet
  Grace = "Grace",
  // A waiting submission's data version uses it
  WaitingSubmission = "WaitingSubmission",
  // A waiting hack or self-evaluation was given it
  WaitingHack = "WaitingHack",
  WaitingSelfEval = "WaitingSelfEval",
  // Submissions to a contest that hasn't ended, or ended less than the policy's days ago, were judged with it
  Contest = "Contest",
  // Results were judged with it, and it was removed less than the policy's days ago
  Result = "Result",
  // A rejudge, less than the policy's days ago, kept an earlier result judged with it
  EarlierResult = "EarlierResult",
  // A problem manager chose to keep a data version that uses it
  Kept = "Kept"
}

export interface TestDataRetentionReason {
  kind: TestDataRetentionReasonKind;
  // When it ends; absent for as long as its cause lasts
  until?: Date;
  // The number of the data version it comes from
  version?: number;
  contestId?: number;
  keptBy?: number;
}

/** What the next cleanup does with a removed file: deletes it, keeps it, or releases it (a problem uses it again). */
export type TestDataCleanupAction = "Delete" | "Keep" | "Release";

export interface RemovedTestDataFile {
  uuid: string;
  removedAt: Date;
  // null once the file is gone
  size: number;
  // From a data version that uses it; null if none does
  problemId: number;
  filename: string;
  versions: number[];
  action: TestDataCleanupAction;
  // While kept: when its last reason ends; absent while one lasts as long as its cause
  keptUntil?: Date;
  reasons: TestDataRetentionReason[];
}

/** Whether a data version's test data is all there: in use by its problem, retained after removal, or deleted. */
export enum TestDataState {
  InUse = "InUse",
  Retained = "Retained",
  Deleted = "Deleted"
}

export interface TestDataAvailability {
  state: TestDataState;
  // Retained: when the first of its removed files may be deleted; absent while every one has an open-ended reason
  retainedUntil?: Date;
  // Retained: the next cleanup deletes some of its files
  deletionDue?: boolean;
  reasons?: TestDataRetentionReasonKind[];
  // Who chose to keep it, and when
  keptBy?: number;
  keptAt?: Date;
}

/** A removed file as administrators see it. */
export type RemovedTestDataFileDescription = Omit<RemovedTestDataFile, "uuid" | "reasons"> & {
  problemDisplayId: number;
  reasons: (Omit<TestDataRetentionReason, "keptBy"> & { contestTitle?: string; keptBy?: string })[];
};

export interface TestDataRetentionTotals {
  files: number;
  bytes: number;
}

export interface TestDataRetentionReport {
  removed: TestDataRetentionTotals;
  kept: TestDataRetentionTotals;
  deletedAtNextCleanup: TestDataRetentionTotals;
  byReason: (TestDataRetentionTotals & { kind: TestDataRetentionReasonKind })[];
  // The removed files looked at, at most REPORT_LIMIT, the oldest first
  files: RemovedTestDataFile[];
  // All removed files, also those not looked at
  total: number;
}

/**
 * Test data removed from its problem isn't deleted at once (`deferTestDataDeletion`): a data version keeps naming its
 * files, and results judged with it can only be judged again with the same data while they exist. A removed file
 * stays while something needs it, and is deleted by a cleanup every ten minutes otherwise:
 * - always: for waiting submissions pinned to a data version that uses it, waiting hacks and self-evaluations given
 *   it, and data versions a problem manager chose to keep;
 * - by the site's retention policy: for contests until some days after they end, and for judged results some days
 *   after it was removed (or after a rejudge replaced a result judged with it).
 * A data version whose files are all there is available to judge again; one missing a file is metadata only: its
 * results stay readable, but can't be reproduced.
 */
@Injectable()
export class TestDataRetentionService implements OnModuleInit, OnModuleDestroy {
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    private readonly fileService: FileService,
    private readonly redisService: RedisService,
    private readonly policyService: TestDataRetentionPolicyService
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      this.sweepTurn().catch(e => logger.error(`Failed to delete removed test data files: ${e}`));
    }, SWEEP_INTERVAL);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  // One backend process deletes at a time; if Redis is unavailable, all do (deleting is idempotent).
  private async sweepTurn(): Promise<void> {
    let turn = true;
    try {
      turn = await this.redisService.takeTurn(REDIS_KEY_SWEEP_TURN, SWEEP_INTERVAL - 1000);
    } catch {
      /* delete anyway */
    }
    if (turn) await this.sweepDeferredFiles();
  }

  /** The test data files that waiting hacks and self-evaluations were given, which they read when they run. */
  private async waitingTaskFiles(manager: EntityManager): Promise<Map<string, Set<TestDataRetentionReasonKind>>> {
    const files = new Map<string, Set<TestDataRetentionReasonKind>>();
    const add = (snapshot: unknown, kind: TestDataRetentionReasonKind) => {
      const testData = (snapshot as { testData?: unknown })?.testData;
      if (!testData || typeof testData !== "object") return;
      for (const uuid of Object.values(testData))
        if (typeof uuid === "string") files.set(uuid, (files.get(uuid) ?? new Set()).add(kind));
    };
    const waiting = { taskId: Not(IsNull()) };
    if (manager.connection.hasMetadata(HackEntity))
      for (const hack of await manager.find(HackEntity, { where: waiting, select: ["id", "snapshot"] }))
        add(hack.snapshot, TestDataRetentionReasonKind.WaitingHack);
    if (manager.connection.hasMetadata(SelfEvalEntity)) {
      for (const run of await manager.find(SelfEvalEntity, { where: waiting, select: ["id", "snapshot"] }))
        add(run.snapshot, TestDataRetentionReasonKind.WaitingSelfEval);
      for (const set of await manager.find(SelfEvalSetEntity, { where: waiting, select: ["scope", "snapshot"] }))
        add(set.snapshot, TestDataRetentionReasonKind.WaitingSelfEval);
    }
    return files;
  }

  /**
   * What the next cleanup does with each of these removed files, and why. Reads only.
   *
   * @param now Milliseconds since the epoch.
   */
  async evaluate(
    rows: Pick<DeferredFileDeletionEntity, "uuid" | "requestedAt">[],
    now: number,
    manager: EntityManager = this.connection.manager
  ): Promise<RemovedTestDataFile[]> {
    if (rows.length === 0) return [];
    const uuids = rows.map(row => row.uuid);
    const policy = await this.policyService.get(manager);
    const sizes = new Map(
      (await manager.find(FileEntity, { where: { uuid: In(uuids) }, select: ["uuid", "size"] })).map(file => [
        file.uuid,
        Number(file.size)
      ])
    );
    const reused = new Set(
      (await manager.find(ProblemFileEntity, { where: { uuid: In(uuids) }, select: ["uuid"] })).map(file => file.uuid)
    );
    // The data versions that use each file
    const uses: { id: number; problemId: number; version: number; uuid: string; filename: string }[] = (
      await manager.query(
        "SELECT v.id, v.problemId, v.version, t.uuid, t.filename FROM problem_data_version v, " +
          "JSON_TABLE(v.testData, '$[*]' COLUMNS (uuid char(36) PATH '$.uuid', filename varchar(256) PATH '$.filename')) t " +
          "WHERE t.uuid IN (?)",
        [uuids]
      )
    ).map((use: Record<string, unknown>) => ({
      id: Number(use.id),
      problemId: Number(use.problemId),
      version: Number(use.version),
      uuid: String(use.uuid),
      filename: String(use.filename)
    }));
    const versionIds = [...new Set(uses.map(use => use.id))];

    const judged = new Set<number>();
    const waiting = new Set<number>();
    const contests = new Map<number, { contestId: number; endTime: Date }[]>();
    const earlier = new Map<number, Date>();
    const kept = new Map<number, ProblemDataVersionKeepEntity>();
    if (versionIds.length > 0) {
      for (const row of await manager
        .createQueryBuilder(SubmissionEntity, "submission")
        .select("submission.problemDataVersionId", "id")
        .addSelect("MAX(submission.taskId IS NOT NULL)", "waiting")
        .where("submission.problemDataVersionId IN (:...versionIds)", { versionIds })
        .groupBy("submission.problemDataVersionId")
        .getRawMany()) {
        judged.add(Number(row.id));
        if (Number(row.waiting)) waiting.add(Number(row.id));
      }
      for (const row of await manager
        .createQueryBuilder(SubmissionEntity, "submission")
        .innerJoin(ContestEntity, "contest", "contest.id = submission.contestId")
        .select("submission.problemDataVersionId", "id")
        .addSelect("contest.id", "contestId")
        .addSelect("contest.endTime", "endTime")
        .where("submission.problemDataVersionId IN (:...versionIds)", { versionIds })
        .groupBy("submission.problemDataVersionId")
        .addGroupBy("contest.id")
        .addGroupBy("contest.endTime")
        .getRawMany()) {
        const list = contests.get(Number(row.id)) ?? [];
        list.push({ contestId: Number(row.contestId), endTime: new Date(row.endTime) });
        contests.set(Number(row.id), list);
      }
      for (const row of await manager
        .createQueryBuilder(SubmissionResultHistoryEntity, "history")
        .select("history.problemDataVersionId", "id")
        .addSelect("MAX(history.replacedAt)", "replacedAt")
        .where("history.problemDataVersionId IN (:...versionIds)", { versionIds })
        .groupBy("history.problemDataVersionId")
        .getRawMany())
        earlier.set(Number(row.id), new Date(row.replacedAt));
      for (const keep of await manager.find(ProblemDataVersionKeepEntity, {
        where: { problemDataVersionId: In(versionIds) }
      }))
        kept.set(keep.problemDataVersionId, keep);
    }
    const waitingTasks = await this.waitingTaskFiles(manager);

    return rows.map(row => {
      const removedAt = new Date(row.requestedAt).getTime();
      const fileUses = uses.filter(use => use.uuid === row.uuid);
      const decision: RemovedTestDataFile = {
        uuid: row.uuid,
        removedAt: new Date(removedAt),
        size: sizes.get(row.uuid) ?? null,
        problemId: fileUses[0]?.problemId ?? null,
        filename: fileUses[0]?.filename ?? null,
        versions: [...new Set(fileUses.map(use => use.version))].sort((a, b) => a - b),
        action: "Delete",
        reasons: []
      };
      if (reused.has(row.uuid)) return { ...decision, action: "Release" };
      // Already gone: only its record is left
      if (!sizes.has(row.uuid)) return decision;

      const reasons: TestDataRetentionReason[] = [];
      const keepUntil = (until: number, reason: Omit<TestDataRetentionReason, "until">) => {
        if (until > now) reasons.push({ ...reason, until: new Date(until) });
      };
      keepUntil(removedAt + DEFERRED_DELETION_GRACE, { kind: TestDataRetentionReasonKind.Grace });
      for (const use of fileUses) {
        const { version } = use;
        if (waiting.has(use.id)) reasons.push({ kind: TestDataRetentionReasonKind.WaitingSubmission, version });
        for (const { contestId, endTime } of contests.get(use.id) ?? [])
          keepUntil(endTime.getTime() + policy.contestDays * DAY, {
            kind: TestDataRetentionReasonKind.Contest,
            version,
            contestId
          });
        if (judged.has(use.id))
          keepUntil(removedAt + policy.resultDays * DAY, { kind: TestDataRetentionReasonKind.Result, version });
        if (earlier.has(use.id))
          keepUntil(Math.max(removedAt, earlier.get(use.id).getTime()) + policy.resultDays * DAY, {
            kind: TestDataRetentionReasonKind.EarlierResult,
            version
          });
        if (kept.has(use.id))
          reasons.push({ kind: TestDataRetentionReasonKind.Kept, version, keptBy: kept.get(use.id).keptBy });
      }
      for (const kind of waitingTasks.get(row.uuid) ?? []) reasons.push({ kind });
      if (reasons.length === 0) return decision;
      const openEnded = reasons.some(reason => !reason.until);
      return {
        ...decision,
        action: "Keep",
        reasons,
        ...(openEnded ? {} : { keptUntil: new Date(Math.max(...reasons.map(reason => reason.until.getTime()))) })
      };
    });
  }

  /**
   * Deletes the removed test data files nothing keeps any more, at most `SWEEP_BATCH`.
   *
   * @return How many files were deleted.
   */
  async sweepDeferredFiles(now = Date.now()): Promise<number> {
    const due = new Date(now - DEFERRED_DELETION_GRACE);
    let deleted = 0;
    let after: DeferredFileDeletionEntity = null;
    // Files the policy keeps stay due: each page looks past the previous one
    for (;;) {
      const query = this.connection
        .getRepository(DeferredFileDeletionEntity)
        .createQueryBuilder("deferred")
        .where("deferred.requestedAt < :due", { due })
        .orderBy("deferred.requestedAt", "ASC")
        .addOrderBy("deferred.uuid", "ASC")
        .take(SWEEP_BATCH);
      if (after)
        query.andWhere("(deferred.requestedAt > :at OR (deferred.requestedAt = :at AND deferred.uuid > :uuid))", {
          at: after.requestedAt,
          uuid: after.uuid
        });
      // eslint-disable-next-line no-await-in-loop -- Page by page.
      const page = await query.getMany();
      if (page.length === 0) break;
      // eslint-disable-next-line no-await-in-loop
      const settled = (await this.evaluate(page, now)).filter(file => file.action !== "Keep").map(file => file.uuid);
      // eslint-disable-next-line no-await-in-loop
      if (settled.length > 0) deleted += await this.settle(settled, now);
      if (page.length < SWEEP_BATCH || deleted >= SWEEP_BATCH) break;
      after = page[page.length - 1];
    }
    return deleted;
  }

  /**
   * Deletes, or releases, removed files after deciding again in the transaction with their records locked: a data
   * version kept since the first look (`keep` locks the same records) keeps its files.
   */
  private async settle(uuids: string[], now: number): Promise<number> {
    let removeObjects: () => void = null;
    let deleted = 0;
    await this.connection.transaction("READ COMMITTED", async manager => {
      const rows = await manager
        .createQueryBuilder(DeferredFileDeletionEntity, "deferred")
        .setLock("pessimistic_write")
        .where({ uuid: In(uuids) })
        .getMany();
      const settled = (await this.evaluate(rows, now, manager)).filter(file => file.action !== "Keep");
      if (settled.length === 0) return;
      await manager.delete(DeferredFileDeletionEntity, { uuid: In(settled.map(file => file.uuid)) });
      const deleting = settled.filter(file => file.action === "Delete").map(file => file.uuid);
      removeObjects = await this.fileService.deleteFile(deleting, manager);
      deleted = deleting.length;
    });
    removeObjects?.();
    return deleted;
  }

  /** Every removed file and what the next cleanup does with it, for administrators: a dry run. Reads only. */
  async report(now = Date.now()): Promise<TestDataRetentionReport> {
    const repository = this.connection.getRepository(DeferredFileDeletionEntity);
    const total = await repository.count();
    const rows = await repository.find({ order: { requestedAt: "ASC", uuid: "ASC" }, take: REPORT_LIMIT });
    const files: RemovedTestDataFile[] = [];
    for (let i = 0; i < rows.length; i += SWEEP_BATCH)
      // eslint-disable-next-line no-await-in-loop -- Page by page.
      files.push(...(await this.evaluate(rows.slice(i, i + SWEEP_BATCH), now)));
    const totals = (list: RemovedTestDataFile[]) => ({
      files: list.length,
      bytes: list.reduce((sum, file) => sum + (file.size ?? 0), 0)
    });
    const present = files.filter(file => file.size != null && file.action !== "Release");
    const kept = present.filter(file => file.action === "Keep");
    return {
      removed: totals(present),
      kept: totals(kept),
      deletedAtNextCleanup: totals(present.filter(file => file.action === "Delete")),
      byReason: Object.values(TestDataRetentionReasonKind)
        .map(kind => ({ kind, ...totals(kept.filter(file => file.reasons.some(reason => reason.kind === kind))) }))
        .filter(reason => reason.files > 0),
      files,
      total
    };
  }

  /**
   * Whether each data version's test data is all still there, and how long it stays. A version missing a file is
   * metadata only, whatever its results say.
   */
  async availability(versionIds: number[], now = Date.now()): Promise<Map<number, TestDataAvailability>> {
    const ids = [...new Set(versionIds.filter(id => id))];
    if (ids.length === 0) return new Map();
    const versions = await this.connection
      .getRepository(ProblemDataVersionEntity)
      .find({ where: { id: In(ids) }, select: ["id", "testData"] });
    const uuids = [...new Set(versions.flatMap(version => version.testData.map(file => file.uuid)))];
    const existing = new Set(
      uuids.length > 0
        ? (await this.connection.getRepository(FileEntity).find({ where: { uuid: In(uuids) }, select: ["uuid"] })).map(
            file => file.uuid
          )
        : []
    );
    const removed =
      uuids.length > 0
        ? await this.connection.getRepository(DeferredFileDeletionEntity).findBy({ uuid: In(uuids) })
        : [];
    const decisions = new Map((await this.evaluate(removed, now)).map(file => [file.uuid, file]));
    const kept = new Map(
      (await this.connection.getRepository(ProblemDataVersionKeepEntity).findBy({ problemDataVersionId: In(ids) })).map(
        keep => [keep.problemDataVersionId, keep]
      )
    );
    return new Map(
      versions.map((version): [number, TestDataAvailability] => {
        const keep = kept.get(version.id);
        const keptBy = keep ? { keptBy: keep.keptBy, keptAt: keep.keptAt } : {};
        if (version.testData.some(file => !existing.has(file.uuid)))
          return [version.id, { state: TestDataState.Deleted, ...keptBy }];
        const retained = version.testData
          .map(file => decisions.get(file.uuid))
          .filter(file => file && file.action !== "Release");
        if (retained.length === 0) return [version.id, { state: TestDataState.InUse, ...keptBy }];
        const ends = retained.filter(file => file.keptUntil).map(file => file.keptUntil.getTime());
        return [
          version.id,
          {
            state: TestDataState.Retained,
            ...(ends.length > 0 ? { retainedUntil: new Date(Math.min(...ends)) } : {}),
            ...(retained.some(file => file.action === "Delete") ? { deletionDue: true } : {}),
            reasons: [...new Set(retained.flatMap(file => file.reasons.map(reason => reason.kind)))],
            ...keptBy
          }
        ];
      })
    );
  }

  private async usernames(ids: number[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter(id => id))];
    if (unique.length === 0) return new Map();
    const users = await this.connection
      .getRepository(UserEntity)
      .find({ where: { id: In(unique) }, select: ["id", "username"] });
    return new Map(users.map(user => [user.id, user.username]));
  }

  /** `availability` for people: who kept a version by username. */
  async describeAvailability(versionIds: number[], now = Date.now()): Promise<Map<number, TestDataAvailabilityDto>> {
    const availability = await this.availability(versionIds, now);
    const usernames = await this.usernames([...availability.values()].map(value => value.keptBy));
    return new Map(
      [...availability].map(([id, { keptBy, ...value }]): [number, TestDataAvailabilityDto] => [
        id,
        { ...value, ...(value.keptAt ? { keptBy: usernames.get(keptBy) ?? null } : {}) }
      ])
    );
  }

  /** `report` for administrators: the files to show, with the names of their problems, contests and keepers. */
  async describeReport(
    limit: number,
    now = Date.now()
  ): Promise<
    Omit<TestDataRetentionReport, "files"> & {
      files: RemovedTestDataFileDescription[];
    }
  > {
    const report = await this.report(now);
    const order: Record<TestDataCleanupAction, number> = { Delete: 0, Keep: 1, Release: 2 };
    const files = report.files
      .filter(file => file.size != null || file.action === "Release")
      .sort((a, b) => order[a.action] - order[b.action] || (b.size ?? 0) - (a.size ?? 0))
      .slice(0, limit);
    const reasons = files.flatMap(file => file.reasons);
    const problemIds = [...new Set(files.map(file => file.problemId).filter(id => id))];
    const contestIds = [...new Set(reasons.map(reason => reason.contestId).filter(id => id))];
    const problems: ProblemEntity[] =
      problemIds.length > 0
        ? await this.connection
            .getRepository(ProblemEntity)
            .find({ where: { id: In(problemIds) }, select: ["id", "displayId"] })
        : [];
    const contests: ContestEntity[] =
      contestIds.length > 0
        ? await this.connection
            .getRepository(ContestEntity)
            .find({ where: { id: In(contestIds) }, select: ["id", "title"] })
        : [];
    const usernames = await this.usernames(reasons.map(reason => reason.keptBy));
    const displayIds = new Map<number, number>(problems.map(problem => [problem.id, problem.displayId]));
    const titles = new Map<number, string>(contests.map(contest => [contest.id, contest.title]));
    return {
      ...report,
      files: files.map(file => ({
        removedAt: file.removedAt,
        size: file.size,
        problemId: file.problemId,
        problemDisplayId: displayIds.get(file.problemId) ?? null,
        filename: file.filename,
        versions: file.versions,
        action: file.action,
        ...(file.keptUntil ? { keptUntil: file.keptUntil } : {}),
        reasons: file.reasons.map(({ keptBy, ...reason }) => ({
          ...reason,
          ...(reason.contestId ? { contestTitle: titles.get(reason.contestId) ?? null } : {}),
          ...(reason.kind === TestDataRetentionReasonKind.Kept ? { keptBy: usernames.get(keptBy) ?? null } : {})
        }))
      }))
    };
  }

  /**
   * Keeps a data version's test data until it's released, whatever the policy.
   *
   * @return `false` if some of it is already deleted.
   */
  async keep(version: ProblemDataVersionEntity, user: UserEntity): Promise<boolean> {
    return await this.connection.transaction("READ COMMITTED", async manager => {
      const uuids = [...new Set(version.testData.map(file => file.uuid))];
      if (uuids.length > 0) {
        // A cleanup deleting them right now finishes first, and they're then found gone; a later one sees this keep
        await manager
          .createQueryBuilder(DeferredFileDeletionEntity, "deferred")
          .setLock("pessimistic_write")
          .where({ uuid: In(uuids) })
          .getMany();
        if ((await manager.countBy(FileEntity, { uuid: In(uuids) })) !== uuids.length) return false;
      }
      await manager
        .createQueryBuilder()
        .insert()
        .into(ProblemDataVersionKeepEntity)
        .values({ problemDataVersionId: version.id, keptBy: user.id, keptAt: new Date() })
        .orIgnore()
        .execute();
      return true;
    });
  }

  /** Lets the retention policy decide about a data version's test data again. */
  async release(version: ProblemDataVersionEntity): Promise<void> {
    await this.connection.getRepository(ProblemDataVersionKeepEntity).delete({ problemDataVersionId: version.id });
  }
}
