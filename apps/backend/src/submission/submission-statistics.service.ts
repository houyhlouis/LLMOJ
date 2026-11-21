import { Injectable, Inject, forwardRef } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";

import { SubmissionStatus } from "@libreoj/judge-protocol";

import { SubmissionEntity } from "./submission.entity";

import { SubmissionService } from "./submission.service";

import { RedisService } from "../redis/redis.service";
import { ProblemEntity } from "../problem/problem.entity";

// Along with submission statistics, this file also provide the submission score statistics

export enum SubmissionStatisticsType {
  Fastest = "Fastest",
  MinMemory = "MinMemory",
  MinAnswerSize = "MinAnswerSize",
  Earliest = "Earliest"
}

interface SubmissionStatisticsField {
  field: keyof SubmissionEntity;
  sort: "ASC" | "DESC";
}

const submissionStatisticsFields: Record<SubmissionStatisticsType, SubmissionStatisticsField> = {
  Fastest: {
    field: "timeUsed",
    sort: "ASC"
  },
  MinMemory: {
    field: "memoryUsed",
    sort: "ASC"
  },
  MinAnswerSize: {
    field: "answerSize",
    sort: "ASC"
  },
  Earliest: {
    field: "submitTime",
    sort: "ASC"
  }
};

type SubmissionStatisticsCache = [submissionId: number, submitterId: number, fieldValue: number];
const STATISTICS_CACHE_SECONDS = 60;
const SCORE_HISTOGRAM = "scores";
const statisticsCacheKey = (problemId: number) => `v2:practice-submission-statistics:${problemId}`;

// Only top 100 users' submissions will be in the statistics
const SUBMISSION_STATISTICS_TOP_COUNT = 100;

@Injectable()
export class SubmissionStatisticsService {
  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @Inject(forwardRef(() => SubmissionService))
    private readonly submissionService: SubmissionService,
    private readonly redisService: RedisService
  ) {}

  async querySubmissionStatisticsAndCount(
    problem: ProblemEntity,
    statisticsType: SubmissionStatisticsType,
    skipCount: number,
    takeCount: number
  ): Promise<[submissions: SubmissionEntity[], count: number]> {
    const { field, sort } = submissionStatisticsFields[statisticsType];

    const key = statisticsCacheKey(problem.id);
    const load = async (): Promise<SubmissionStatisticsCache[]> => {
      const aggregateFunction = sort === "ASC" ? "MIN" : "MAX";
      const queryResult: { submissionId: number; submitterId: number; fieldValue: unknown }[] = await this.connection
        .createQueryBuilder()
        .select("submission.id", "submissionId")
        .addSelect("submission.submitterId", "submitterId")
        .addSelect("statistics.fieldValue", "fieldValue")
        .from(
          queryBuilder =>
            queryBuilder
              .select("submitterId")
              .addSelect(`${aggregateFunction}(${field})`, "fieldValue")
              .from(SubmissionEntity, "submission")
              .andWhere("status = :status", { status: SubmissionStatus.Accepted })
              .andWhere("problemId = :problemId", { problemId: problem.id })
              .andWhere("contestId IS NULL")
              .groupBy("submitterId")
              .orderBy("fieldValue", sort)
              .limit(SUBMISSION_STATISTICS_TOP_COUNT),
          "statistics"
        )
        .innerJoin(
          SubmissionEntity,
          "submission",
          `submission.submitterId = statistics.submitterId AND submission.${field} = statistics.fieldValue AND submission.problemId = :problemId AND submission.status = :status AND submission.contestId IS NULL`,
          {
            problemId: problem.id,
            status: SubmissionStatus.Accepted
          }
        )
        .groupBy("submission.submitterId")
        .orderBy("fieldValue", sort)
        .getRawMany();
      return queryResult.map(result => [result.submissionId, result.submitterId, Number(result.fieldValue)]);
    };

    const cache = this.redisService.generationCache;
    let tuples = await cache.read(key, statisticsType, STATISTICS_CACHE_SECONDS, load);

    const query = async () => {
      const ids = tuples.filter((_, i) => i >= skipCount && i < skipCount + takeCount).map(([id]) => id);
      return await this.submissionService.findSubmissionsByExistingIds(ids);
    };

    let submissions = await query();
    if (submissions.some(submission => !submission)) {
      tuples = await cache.read(key, statisticsType, STATISTICS_CACHE_SECONDS, load, true);
      submissions = await query();
    }

    return [submissions.filter(submission => submission), tuples.length];
  }

  /**
   * Return how many submissions with each score (0 ~ 100) are there.
   */
  async querySubmissionScoreStatistics(problem: ProblemEntity): Promise<number[]> {
    return await this.redisService.generationCache.read(
      statisticsCacheKey(problem.id),
      SCORE_HISTOGRAM,
      STATISTICS_CACHE_SECONDS,
      () => this.countSubmissionsByScore(problem.id)
    );
  }

  private async countSubmissionsByScore(problemId: number): Promise<number[]> {
    const queryResult: { score: string; count: string }[] = await this.connection
      .createQueryBuilder()
      .select("submission.score", "score")
      .addSelect("COUNT(*)", "count")
      .from(SubmissionEntity, "submission")
      .where("submission.problemId = :problemId", { problemId })
      .andWhere("submission.contestId IS NULL")
      .andWhere("submission.score IS NOT NULL")
      .andWhere("submission.status NOT IN (:...invalidStatuses)", {
        invalidStatuses: [SubmissionStatus.Fake, SubmissionStatus.Hacked]
      })
      .groupBy("submission.score")
      .getRawMany();
    const result = new Array(101).fill(0);
    for (const item of queryResult) result[item.score] = Number(item.count);

    return result;
  }

  /**
   * This function is called after a submission's updated, to determine which caches of statistics should be purged.
   *
   * A newly-added submission won't call this function.
   */
  async onSubmissionUpdated(oldSubmission: SubmissionEntity, submission?: SubmissionEntity): Promise<void> {
    // Contest submissions don't count in a problem's statistics
    if (oldSubmission.contestId) return;

    const fields: string[] = [];
    if (
      !submission ||
      oldSubmission.score !== submission.score ||
      [SubmissionStatus.Fake, SubmissionStatus.Hacked].includes(oldSubmission.status) !==
        [SubmissionStatus.Fake, SubmissionStatus.Hacked].includes(submission.status)
    )
      fields.push(SCORE_HISTOGRAM);

    // An empty cache can have a ranking query in flight. Fence it even if no current tuple names this submission.
    if (oldSubmission.status === SubmissionStatus.Accepted || submission?.status === SubmissionStatus.Accepted)
      fields.push(...Object.values(SubmissionStatisticsType));

    if (fields.length)
      await this.redisService.generationCache.invalidate(
        statisticsCacheKey(oldSubmission.problemId),
        fields,
        STATISTICS_CACHE_SECONDS
      );
  }

  async onProblemDeleted(problemId: number): Promise<void> {
    await this.redisService.generationCache.invalidate(
      statisticsCacheKey(problemId),
      [SCORE_HISTOGRAM, ...Object.values(SubmissionStatisticsType)],
      STATISTICS_CACHE_SECONDS
    );
  }
}
