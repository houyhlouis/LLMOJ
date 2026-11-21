import { Inject, Injectable, Optional } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, In } from "typeorm";

import { ContestEntity } from "./contest.entity";
import { ContestProblemEntity } from "./contest-problem.entity";
import { scoreContest, ScoringSubmission } from "./contest-scoring";
import { ContestVirtualParticipationEntity } from "./contest-virtual-participation.entity";
import { virtualSubmissionJoin } from "./contest-virtual-timeline";

import { SubmissionEntity } from "../submission/submission.entity";
import { SubmissionDetailEntity } from "../submission/submission-detail.entity";
import { ContestScoreRevisionService } from "../submission/contest-score-revision.service";

export type ContestScores = ReturnType<typeof scoreContest>;
type VirtualScores = (ContestScores[number] & { virtual?: true; virtualStartTime?: Date })[];
type ScoreProblems = { id: number; weight: number }[];
type ScoreCache<T> = Map<number, { key: string; at: number; scores: Promise<T> }>;

interface ContestTimeline {
  submissions: ScoringSubmission[];
  virtualStarts: Map<number, Date>;
  snapshots: Map<string, VirtualScores>;
}

// Cached scores are recomputed after this long even if no change was noticed.
const SCORE_CACHE_TIME = 60 * 1000;
const SCORE_CACHE_CONTESTS = 50;
// Each cached virtual timeline also retains a few scored prefixes, shared by everyone at the same point in the run.
const VIRTUAL_CACHE_CONTESTS = 8;
const VIRTUAL_CACHE_SNAPSHOTS = 8;

const scoreColumns = [
  "s.id",
  "s.submitterId",
  "s.contestProblemId",
  "s.submitTime",
  "s.status",
  "s.score",
  "s.problemDataVersionId"
];

const officialWindow = "s.submitTime >= :start AND s.submitTime < :end";

/** Everyone's scores in a contest, computed by its rule. ContestAccessService decides who may see them. */
@Injectable()
export class ContestScoreService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  @Optional() @Inject(ContestScoreRevisionService) private readonly scoreRevisions: ContestScoreRevisionService;

  private scoreCache: ScoreCache<ContestScores>;
  private virtualCache: ScoreCache<ContestTimeline>;

  /** The official scoreboard, always restricted to the official window. */
  async contestScores(contest: ContestEntity, problems: ScoreProblems): Promise<ContestScores> {
    this.scoreCache ??= new Map();
    return await this.cached(this.scoreCache, contest, problems, false, async () => {
      const submissions = await this.db
        .getRepository(SubmissionEntity)
        .createQueryBuilder("s")
        .select(scoreColumns)
        .where(`s.contestId = :id AND ${officialWindow}`, {
          id: contest.id,
          start: contest.startTime,
          end: contest.endTime
        })
        .getMany();
      return scoreContest(contest.rule, contest.startTime, problems, await this.withSubtasks(contest, submissions));
    });
  }

  /** Empty runs and submissions whose contest problem was removed have no scored row. */
  async hasVirtualParticipants(contest: ContestEntity): Promise<boolean> {
    return !!(await this.db
      .getRepository(SubmissionEntity)
      .createQueryBuilder("s")
      .select("1")
      .innerJoin(ContestVirtualParticipationEntity, "virtualRun", virtualSubmissionJoin)
      .innerJoin(ContestProblemEntity, "p", "p.id = s.contestProblemId AND p.contestId = s.contestId")
      .where("s.contestId = :contestId", { contestId: contest.id })
      .limit(1)
      .getRawOne());
  }

  /**
   * Score the official and virtual submissions through the viewer's exact elapsed time. Without a cutoff this is the
   * merged final scoreboard. Exports during a run request only the official submissions visible by that time.
   */
  async virtualScores(
    contest: ContestEntity,
    problems: ScoreProblems,
    elapsedMs = Infinity,
    includeVirtual = true
  ): Promise<VirtualScores> {
    this.virtualCache ??= new Map();
    const timeline = await this.cached(this.virtualCache, contest, problems, true, () => this.loadTimeline(contest));

    // A prefix changes only when another submission is reached. Users with different start times can share it,
    // including at an exact submission timestamp, without a rounded clock showing a future verdict.
    const cutoff = +contest.startTime + elapsedMs;
    let low = 0;
    let high = timeline.submissions.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (+timeline.submissions[middle].submitTime <= cutoff) low = middle + 1;
      else high = middle;
    }
    const key = `${includeVirtual}:${low}`;
    const cached = timeline.snapshots.get(key);
    if (cached) return cached;
    const prefix = timeline.submissions.slice(0, low);
    const submissions = includeVirtual ? prefix : prefix.filter(s => !timeline.virtualStarts.has(s.submitterId));
    const scores = scoreContest(contest.rule, contest.startTime, problems, submissions).map(row => {
      const start = timeline.virtualStarts.get(row.userId);
      return start ? { ...row, virtual: true as const, virtualStartTime: start } : row;
    });
    timeline.snapshots.set(key, scores);
    if (timeline.snapshots.size > VIRTUAL_CACHE_SNAPSHOTS)
      timeline.snapshots.delete(timeline.snapshots.keys().next().value);
    return scores;
  }

  private async loadTimeline(contest: ContestEntity): Promise<ContestTimeline> {
    const rows = (await this.db
      .getRepository(SubmissionEntity)
      .createQueryBuilder("s")
      .leftJoinAndMapOne("s.virtualRun", ContestVirtualParticipationEntity, "virtualRun", virtualSubmissionJoin)
      .select([...scoreColumns, "virtualRun.id", "virtualRun.startTime"])
      .where(`s.contestId = :id AND ((${officialWindow}) OR virtualRun.id IS NOT NULL)`, {
        id: contest.id,
        start: contest.startTime,
        end: contest.endTime
      })
      .getMany()) as (SubmissionEntity & { virtualRun?: Pick<ContestVirtualParticipationEntity, "startTime"> })[];
    const virtualStarts = new Map<number, Date>();
    const shifted = rows.map(row => {
      if (!row.virtualRun) return row;
      const start = row.virtualRun.startTime;
      virtualStarts.set(row.submitterId, start);
      return { ...row, submitTime: new Date(+contest.startTime + (+row.submitTime - +start)) };
    });
    const submissions = await this.withSubtasks(contest, shifted);
    submissions.sort((a, b) => +a.submitTime - +b.submitTime || a.id - b.id);
    return { submissions, virtualStarts, snapshots: new Map() };
  }

  private async withSubtasks(contest: ContestEntity, submissions: ScoringSubmission[]): Promise<ScoringSubmission[]> {
    if (contest.rule !== "strictioi" || !submissions.length) return submissions;
    const rows = await this.db.getRepository(SubmissionDetailEntity).find({
      select: { submissionId: true, result: true },
      where: { submissionId: In(submissions.map(s => s.id)) }
    });
    // Cache only the scoring fields; judge output and testcase details are not part of a virtual timeline.
    const subtasks = new Map(
      rows.map(row => [row.submissionId, row.result?.subtasks?.map(({ score, fullScore }) => ({ score, fullScore }))])
    );
    return submissions.map(s => ({ ...s, subtasks: subtasks.get(s.id) }));
  }

  private async cached<T>(
    cache: ScoreCache<T>,
    contest: ContestEntity,
    problems: ScoreProblems,
    virtual: boolean,
    compute: () => Promise<T>
  ): Promise<T> {
    let revisions: string[];
    try {
      if (this.scoreRevisions) {
        const officialRevision = this.scoreRevisions.revision(contest.id);
        revisions = virtual
          ? await Promise.all([officialRevision, this.scoreRevisions.revision(contest.id, true)])
          : [await officialRevision];
      }
    } catch {
      /* compute without the cache */
    }
    if (!revisions || revisions.some(revision => revision == null)) return await compute();
    const key = JSON.stringify([
      virtual ? revisions : revisions[0],
      contest.rule,
      +contest.startTime,
      +contest.endTime,
      problems.map(problem => [problem.id, problem.weight])
    ]);
    const cached = cache.get(contest.id);
    if (cached?.key === key && Date.now() - cached.at < SCORE_CACHE_TIME) return await cached.scores;
    const scores = compute();
    cache.delete(contest.id);
    cache.set(contest.id, { key, at: Date.now(), scores });
    if (cache.size > (virtual ? VIRTUAL_CACHE_CONTESTS : SCORE_CACHE_CONTESTS)) cache.delete(cache.keys().next().value);
    try {
      return await scores;
    } catch (e) {
      if (cache.get(contest.id)?.scores === scores) cache.delete(contest.id);
      throw e;
    }
  }
}
