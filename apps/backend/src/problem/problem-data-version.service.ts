import { createHash } from "crypto";

import { Injectable, Inject, forwardRef } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { In, Repository } from "typeorm";

import { ProblemDataVersionEntity, ProblemDataVersionFile } from "./problem-data-version.entity";
import { ProblemFileType } from "./problem-file.entity";
import { ProblemEntity } from "./problem.entity";
import { ProblemService } from "./problem.service";
import { ProblemFileService } from "./problem-file.service";

import { ConfigService } from "../config/config.service";
import { FileService } from "../file/file.service";

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
  const testData = content.testData.map(({ filename, uuid }) => ({ filename, uuid }));
  return createHash("sha256")
    .update(canonicalJson([content.problemType, content.judgeInfo, testData, content.samples]))
    .digest("hex");
}

const isDuplicateEntry = (error: unknown) =>
  (error as { code?: string })?.code === "ER_DUP_ENTRY" ||
  (error as { driverError?: { code?: string } })?.driverError?.code === "ER_DUP_ENTRY";

@Injectable()
export class ProblemDataVersionService {
  constructor(
    @InjectRepository(ProblemDataVersionEntity)
    private readonly problemDataVersionRepository: Repository<ProblemDataVersionEntity>,
    @Inject(forwardRef(() => ProblemService))
    private readonly problemService: ProblemService,
    @Inject(forwardRef(() => ProblemFileService))
    private readonly problemFiles: ProblemFileService,
    private readonly fileService: FileService,
    private readonly configService: ConfigService
  ) {}

  /** What the problem is judged with now. */
  async currentContent(problem: ProblemEntity): Promise<ProblemDataVersionContent> {
    const [judgeInfo] = await this.problemService.getProblemPreprocessedJudgeInfo(problem);
    const files = await this.problemFiles.getProblemFiles(problem, ProblemFileType.TestData);
    const hashes = await this.fileService.getContentHashes(files.map(file => file.uuid));
    const testData: ProblemDataVersionFile[] = files
      .map(({ filename, uuid }) => (hashes[uuid] ? { filename, uuid, sha256: hashes[uuid] } : { filename, uuid }))
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

  async findByNumber(problemId: number, version: number): Promise<ProblemDataVersionEntity> {
    return await this.problemDataVersionRepository.findOneBy({ problemId, version });
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
}
