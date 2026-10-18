import { createHash } from "crypto";

import { Injectable, Inject, forwardRef, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { DataSource, In, LessThan, Repository } from "typeorm";

import { ProblemDataVersionEntity, ProblemDataVersionFile } from "./problem-data-version.entity";
import { DeferredFileDeletionEntity } from "./deferred-file-deletion.entity";
import { ProblemFileEntity, ProblemFileType } from "./problem-file.entity";
import { ProblemEntity } from "./problem.entity";
import { ProblemService } from "./problem.service";

import { logger } from "../logger";
import { ConfigService } from "../config/config.service";
import { FileService } from "../file/file.service";
import { RedisService } from "../redis/redis.service";
import { SubmissionEntity } from "../submission/submission.entity";

// A removed test data file is kept at least this long, so that a submission whose data version was taken just before
// the removal, but not committed yet, finds its files
const DEFERRED_DELETION_GRACE = 15 * 60 * 1000;
const SWEEP_INTERVAL = 10 * 60 * 1000;
const SWEEP_BATCH = 1000;
const REDIS_KEY_SWEEP_TURN = "problem-data-version:sweep-turn";

export type ProblemDataVersionContent = Pick<
  ProblemDataVersionEntity,
  "problemType" | "judgeInfo" | "testData" | "samples"
>;

/** JSON with object keys sorted, so that equal content always has the same digest. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

export function dataVersionDigest(content: ProblemDataVersionContent): string {
  return createHash("sha256")
    .update(canonicalJson([content.problemType, content.judgeInfo, content.testData, content.samples]))
    .digest("hex");
}

const isDuplicateEntry = (error: unknown) =>
  (error as { code?: string })?.code === "ER_DUP_ENTRY" ||
  (error as { driverError?: { code?: string } })?.driverError?.code === "ER_DUP_ENTRY";

@Injectable()
export class ProblemDataVersionService implements OnModuleInit, OnModuleDestroy {
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @InjectRepository(ProblemDataVersionEntity)
    private readonly problemDataVersionRepository: Repository<ProblemDataVersionEntity>,
    @Inject(forwardRef(() => ProblemService))
    private readonly problemService: ProblemService,
    private readonly fileService: FileService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService
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

  /** What the problem is judged with now. */
  async currentContent(problem: ProblemEntity): Promise<ProblemDataVersionContent> {
    const [judgeInfo] = await this.problemService.getProblemPreprocessedJudgeInfo(problem);
    const testData: ProblemDataVersionFile[] = (
      await this.problemService.getProblemFiles(problem, ProblemFileType.TestData)
    )
      .map(({ filename, uuid }) => ({ filename, uuid }))
      .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    const runSamples = !!(judgeInfo as { runSamples?: boolean })?.runSamples;
    const samples = runSamples
      ? ((await this.problemService.getProblemSamples(problem)) || []).slice(
          0,
          this.configService.config.resourceLimit.problemSamplesToRun
        )
      : null;
    return { problemType: problem.type, judgeInfo, testData, samples };
  }

  /** The version with the problem's current content, created if the content is new. */
  async current(problem: ProblemEntity): Promise<ProblemDataVersionEntity> {
    const content = await this.currentContent(problem);
    const digest = dataVersionDigest(content);
    for (let attempt = 1; ; attempt++) {
      // eslint-disable-next-line no-await-in-loop -- Retried after a concurrent insert.
      const existing = await this.problemDataVersionRepository.findOneBy({ problemId: problem.id, digest });
      if (existing) return existing;
      // eslint-disable-next-line no-await-in-loop -- Retried after a concurrent insert.
      const latest: { version: string } = await this.problemDataVersionRepository
        .createQueryBuilder()
        .select("MAX(version)", "version")
        .where({ problemId: problem.id })
        .getRawOne();
      const version = this.problemDataVersionRepository.create({
        problemId: problem.id,
        version: Number(latest?.version || 0) + 1,
        digest,
        ...content,
        createdAt: new Date()
      });
      try {
        // eslint-disable-next-line no-await-in-loop -- Retried after a concurrent insert.
        await this.problemDataVersionRepository.insert(version);
        return version;
      } catch (e) {
        // Another submission created a version at the same time
        if (attempt >= 5 || !isDuplicateEntry(e)) throw e;
      }
    }
  }

  async findById(id: number): Promise<ProblemDataVersionEntity> {
    return id ? await this.problemDataVersionRepository.findOneBy({ id }) : null;
  }

  async findVersionNumbers(ids: number[]): Promise<Map<number, number>> {
    const unique = [...new Set(ids.filter(id => id))];
    if (unique.length === 0) return new Map();
    const versions = await this.problemDataVersionRepository.find({
      where: { id: In(unique) },
      select: ["id", "version"]
    });
    return new Map(versions.map(({ id, version }) => [id, version]));
  }

  /** Whether the version still has the problem's current content (also after edits nobody submitted since). */
  async isCurrent(problem: ProblemEntity, version: ProblemDataVersionEntity): Promise<boolean> {
    return dataVersionDigest(await this.currentContent(problem)) === version.digest;
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

  /** The test data files of the data versions that waiting submissions are pinned to. */
  private async pinnedFiles(): Promise<Set<string>> {
    const rows: { id: number }[] = await this.connection
      .getRepository(SubmissionEntity)
      .createQueryBuilder("submission")
      .select("DISTINCT submission.problemDataVersionId", "id")
      .where("submission.taskId IS NOT NULL AND submission.problemDataVersionId IS NOT NULL")
      .getRawMany();
    if (rows.length === 0) return new Set();
    const versions = await this.problemDataVersionRepository.find({
      where: { id: In(rows.map(row => Number(row.id))) },
      select: ["id", "testData"]
    });
    return new Set(versions.flatMap(version => version.testData.map(file => file.uuid)));
  }

  /**
   * Deletes removed test data files that no waiting submission needs any more.
   *
   * @return How many files were deleted.
   */
  async sweepDeferredFiles(now = Date.now()): Promise<number> {
    const due = await this.connection.getRepository(DeferredFileDeletionEntity).find({
      where: { requestedAt: LessThan(new Date(now - DEFERRED_DELETION_GRACE)) },
      order: { requestedAt: "ASC" },
      take: SWEEP_BATCH
    });
    if (due.length === 0) return 0;

    const pinned = await this.pinnedFiles();
    const candidates = due.map(file => file.uuid).filter(uuid => !pinned.has(uuid));
    if (candidates.length === 0) return 0;
    // Never delete a file a problem uses again
    const reused = new Set(
      (await this.connection.getRepository(ProblemFileEntity).findBy({ uuid: In(candidates) })).map(file => file.uuid)
    );

    let removeObjects: () => void = null;
    await this.connection.transaction("READ COMMITTED", async manager => {
      await manager.delete(DeferredFileDeletionEntity, { uuid: In(candidates) });
      removeObjects = await this.fileService.deleteFile(
        candidates.filter(uuid => !reused.has(uuid)),
        manager
      );
    });
    removeObjects();
    return candidates.length - reused.size;
  }
}
