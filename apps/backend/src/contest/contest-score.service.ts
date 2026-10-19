import { Inject, Injectable, Optional } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, In } from "typeorm";

import { ContestEntity } from "./contest.entity";
import { scoreContest } from "./contest-scoring";

import { SubmissionEntity } from "../submission/submission.entity";
import { SubmissionDetailEntity } from "../submission/submission-detail.entity";
import { ContestScoreRevisionService } from "../submission/contest-score-revision.service";

export type ContestScores = ReturnType<typeof scoreContest>;

// Cached scores are recomputed after this long even if no change was noticed
const SCORE_CACHE_TIME = 60 * 1000;
// Contests whose scores each backend process keeps
const SCORE_CACHE_CONTESTS = 50;

/**
 * Everyone's scores in a contest, computed from the contest's submissions by its rule's scoring (contest-scoring.ts)
 * and kept while none of them changes. Who may see them is ContestAccessService's and contest-policy.ts's to decide.
 */
@Injectable()
export class ContestScoreService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Optional() @Inject(ContestScoreRevisionService) private readonly scoreRevisions: ContestScoreRevisionService;

  // Scores computed from all of a contest's submissions, kept while none of them changes (see `contestScores`)
  private scoreCache: Map<number, { key: string; at: number; scores: Promise<ContestScores> }>;

  /**
   * The scores of everyone in the contest (shared: never modify them). They are computed from all of the contest's
   * submissions, then reused while the contest, its problems and every one of its submissions stay the same: each
   * transaction that changes a submission moves the contest's revision on. A revision that couldn't move on (Redis
   * failed after a commit) holds for at most SCORE_CACHE_TIME; without Redis, scores are computed every time.
   */
  async contestScores(contest: ContestEntity, problems: { id: number; weight: number }[]): Promise<ContestScores> {
    const compute = async () => {
      const submissions = await this.db
        .getRepository(SubmissionEntity)
        .createQueryBuilder("s")
        .select(["s.id", "s.submitterId", "s.contestProblemId", "s.submitTime", "s.status", "s.score"])
        .where("s.contestId = :id AND s.submitTime >= :start AND s.submitTime < :end", {
          id: contest.id,
          start: contest.startTime,
          end: contest.endTime
        })
        .getMany();
      return await this.score(contest, problems, submissions);
    };
    let revision: string;
    try {
      revision = await this.scoreRevisions?.revision(contest.id);
    } catch {
      /* computed without the cache */
    }
    if (revision == null) return await compute();
    const key = JSON.stringify([
      revision,
      contest.rule,
      +contest.startTime,
      +contest.endTime,
      problems.map(problem => [problem.id, problem.weight])
    ]);
    if (!this.scoreCache) this.scoreCache = new Map();
    const cached = this.scoreCache.get(contest.id);
    if (cached?.key === key && Date.now() - cached.at < SCORE_CACHE_TIME) return await cached.scores;
    // Requests arriving while the scores are computed wait for the same computation
    const scores = compute();
    this.scoreCache.delete(contest.id);
    this.scoreCache.set(contest.id, { key, at: Date.now(), scores });
    if (this.scoreCache.size > SCORE_CACHE_CONTESTS) this.scoreCache.delete(this.scoreCache.keys().next().value);
    try {
      return await scores;
    } catch (e) {
      if (this.scoreCache.get(contest.id)?.scores === scores) this.scoreCache.delete(contest.id);
      throw e;
    }
  }

  private async score(
    contest: ContestEntity,
    problems: { id: number; weight: number }[],
    submissions: Pick<SubmissionEntity, "id" | "submitterId" | "contestProblemId" | "submitTime" | "status" | "score">[]
  ) {
    const detailRows =
      contest.rule === "strictioi" && submissions.length
        ? await this.db.getRepository(SubmissionDetailEntity).findBy({ submissionId: In(submissions.map(s => s.id)) })
        : [];
    const details = new Map(detailRows.map(detail => [detail.submissionId, detail.result]));
    return scoreContest(
      contest.rule,
      contest.startTime,
      problems,
      submissions.map(s => ({ ...s, subtasks: details.get(s.id)?.subtasks }))
    );
  }
}
