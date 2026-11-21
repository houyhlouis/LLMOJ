import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, In } from "typeorm";

import { ContestEntity } from "./contest.entity";
import { ContestProblemEntity } from "./contest-problem.entity";
import { ContestSummaryEntity } from "./contest-summary.entity";
import { ContestVirtualParticipationEntity } from "./contest-virtual-participation.entity";
import { runTimes } from "./contest-virtual";
import { ContestAccessService } from "./contest-access.service";
import { ContestScoreService } from "./contest-score.service";
import { ContestProblemService } from "./contest-problem.service";
import { contestEnded, contestOwnResult, contestStarted, contestStatisticsVisible } from "./contest-policy";
import { text } from "./contest-input";
import { isContestRule, normalizeContestRuleOptions } from "./contest-rules";

import { normalizeContestLanguages } from "./contest-languages";

import type { ContestRequestData } from "./contest-request.dto";

import { csvDocument } from "../common/csv";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeType } from "../user/user-privilege.service";
import { SubmissionService } from "../submission/submission.service";
import { teamResourceAccess } from "../team/team-access";
import { SubmissionEntity } from "../submission/submission.entity";
import { FileService } from "../file/file.service";
import { getCurrentRequest } from "../auth/auth.middleware";
import { AuditLogEntity } from "../audit/audit-log.entity";

/**
 * Contests themselves: the contest list and page, creating, changing and deleting contests, scoreboards and their
 * export, and participants' contest summaries. Who may do what is ContestAccessService's to decide; a contest's
 * problems, submissions and scores have services of their own.
 */
@Injectable()
export class ContestService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly access: ContestAccessService,
    private readonly scores: ContestScoreService,
    private readonly contestProblems: ContestProblemService,
    private readonly submissions: SubmissionService,
    private readonly files: FileService
  ) {}

  async list(user: UserEntity, page = 1) {
    const query = await this.access.listingQuery(user);
    const [contests, total] = await query
      .orderBy("c.startTime", "DESC")
      .skip((page - 1) * 30)
      .take(30)
      .getManyAndCount();
    return {
      contests,
      total,
      canCreate: await this.access.canCreate(user)
    };
  }

  async detail(user: UserEntity, id: number) {
    const { contest, manager, now, virtualRun, participation } = await this.access.get(user, id);
    const started = contestStarted(contest, now);
    const ended = contestEnded(contest, now);
    const problems = started || manager ? await this.contestProblems.problemList(contest.id) : [];
    // Running NOI contests conceal verdicts even when aggregate statistics are enabled.
    const showStatistics = problems.length && contestStatisticsVisible(contest, manager, now);
    const scores = !problems.length
      ? []
      : virtualRun
        ? await this.scores.virtualScores(contest, problems, now - +contest.startTime)
        : await this.scores.contestScores(contest, problems);
    let own: (typeof scores)[number];
    if (user && (await this.access.canSeeOwnResults(user))) {
      // A finished virtual participant sees their own result; the ended contest's aggregate stays official.
      const ownScores =
        participation && !virtualRun && problems.length ? await this.scores.virtualScores(contest, problems) : scores;
      own = ownScores.find(row => row.userId === user.id);
    }
    const problemStats = Object.fromEntries(
      problems.map(problem => {
        const entries = scores.map(row => row.problems[problem.id]).filter(Boolean);
        return [
          problem.id,
          showStatistics
            ? {
                attempted: entries.length,
                accepted: entries.filter(x => x.accepted || x.status === "Accepted").length,
                partially: entries.filter(x => x.score > 0).length
              }
            : null
        ];
      })
    );
    const ownResults = Object.fromEntries(
      problems.map(p => {
        const entry = own?.problems[p.id];
        if (!entry) return [p.id, null];
        return [p.id, contestOwnResult(entry, contest, manager, now)];
      })
    );
    const canRank = (await this.access.scoreboard(user, contest, manager, now, virtualRun)) === "allowed";
    const reason = await this.access.virtualStartReason(user, contest, manager, participation);
    return {
      contest,
      problems,
      manager,
      started,
      ended,
      serverTime: new Date(),
      problemStats,
      ownResults,
      canRank,
      canSubmit: await this.access.canSubmit(user, contest, manager, now),
      virtualParticipation: { canStart: reason === null, reason, run: participation ? runTimes(participation) : null },
      hasVirtualParticipants: !!(ended && canRank && (await this.scores.hasVirtualParticipants(contest)))
    };
  }

  async startVirtual(user: UserEntity, id: number) {
    return await this.db.transaction("READ COMMITTED", async transaction => {
      const contest = await this.access.requireVirtualStart(user, id, transaction);
      // Submission and contest DATETIMEs have second precision. Persist and return the identical window.
      const startTime = new Date(Math.floor(Date.now() / 1000) * 1000);
      const endTime = new Date(+startTime + (+contest.endTime - +contest.startTime));
      await transaction.insert(ContestVirtualParticipationEntity, {
        contestId: id,
        userId: user.id,
        startTime,
        endTime,
        createdAt: startTime
      });
      await transaction.save(AuditLogEntity, {
        userId: user.id,
        action: "contest.start_virtual",
        time: startTime,
        ip: getCurrentRequest()?.ip || "127.0.0.1",
        details: { contestId: id }
      });
      return { run: { startTime, endTime } };
    });
  }

  async save(user: UserEntity, id: number, data: ContestRequestData) {
    let contest: ContestEntity;
    if (id) {
      const access = await this.access.get(user, id);
      if (!access.manager) throw new ForbiddenException();
      contest = access.contest;
    } else {
      await this.access.requirePrivilege(user, UserPrivilegeType.CreateContest);
      contest = this.db.getRepository(ContestEntity).create({ ownerId: user.id, createdAt: new Date() });
    }
    if (!isContestRule(data.rule)) throw new BadRequestException("Invalid rule");
    const start = new Date(data.startTime);
    const end = new Date(data.endTime);
    // Validate, compare and persist the same whole seconds as the contest's DATETIME columns.
    start.setUTCMilliseconds(0);
    end.setUTCMilliseconds(0);
    if (!Number.isFinite(+start) || !Number.isFinite(+end) || +start >= +end)
      throw new BadRequestException("Invalid time range");
    let ruleOptions: ContestEntity["ruleOptions"];
    try {
      ruleOptions = normalizeContestRuleOptions(data.ruleOptions ?? contest.ruleOptions, start, end, data.rule);
    } catch (error) {
      throw new BadRequestException(error.message);
    }
    const languages = normalizeContestLanguages(data.languages);
    if (
      !Array.isArray(data.adminIds) ||
      data.adminIds.length > 100 ||
      data.adminIds.some(x => !Number.isSafeInteger(x) || x < 1)
    )
      throw new BadRequestException("Invalid administrators");
    if (
      new Set(data.adminIds).size &&
      (await this.db.getRepository(UserEntity).countBy({ id: In(data.adminIds) })) !== new Set(data.adminIds).size
    )
      throw new BadRequestException("Unknown administrator");
    Object.assign(contest, {
      title: text(data.title, 160, true),
      subtitle: text(data.subtitle ?? "", 20000),
      description: text(data.description ?? "", 200000),
      rule: data.rule,
      ruleOptions,
      startTime: start,
      endTime: end,
      isPublic:
        id && (await teamResourceAccess(this.db, user, "contest", contest.id)) !== null
          ? contest.isPublic
          : data.isPublic === true,
      hideStatistics: data.hideStatistics === true,
      adminIds: [...new Set(data.adminIds)],
      languages
    });
    if (id) {
      await this.db.transaction("READ COMMITTED", async transaction => {
        // Start and submission admission hold a shared lock until their records commit.
        const stored = await transaction.findOne(ContestEntity, { where: { id }, lock: { mode: "pessimistic_write" } });
        if (!stored) throw new NotFoundException();
        if (
          data.rule !== stored.rule &&
          (await transaction.getRepository(SubmissionEntity).existsBy({ contestId: id }))
        )
          throw new BadRequestException("Cannot change rule after submissions");
        if (
          (+stored.startTime !== +start || +stored.endTime !== +end) &&
          (await transaction.getRepository(ContestVirtualParticipationEntity).existsBy({ contestId: id }))
        )
          throw new BadRequestException({
            error: "VIRTUAL_RUNS_EXIST",
            message: "Virtual runs have started for this contest, so its start and end can't change."
          });
        await transaction.save(contest);
      });
    } else await this.db.getRepository(ContestEntity).save(contest);
    return { id: contest.id };
  }

  async ranklist(user: UserEntity, id: number, includeVirtual = false) {
    return await this.readRanklist(user, id, includeVirtual ? "virtual" : "default");
  }

  private async readRanklist(user: UserEntity, id: number, mode: "default" | "virtual" | "export") {
    const { contest, manager, now, virtualRun } = await this.access.get(user, id, true);
    const scoreboard = await this.access.scoreboard(user, contest, manager, now, virtualRun);
    if (scoreboard === "denied") throw new ForbiddenException();
    if (scoreboard === "hidden") throw new ForbiddenException("Ranklist is hidden during this contest");
    const problems = await this.contestProblems.problemList(id);
    const rows =
      virtualRun || (mode === "virtual" && contestEnded(contest, now))
        ? await this.scores.virtualScores(
            contest,
            problems,
            virtualRun ? now - +contest.startTime : undefined,
            mode !== "export"
          )
        : await this.scores.contestScores(contest, problems);
    const users = new Map(
      (rows.length ? await this.db.getRepository(UserEntity).findBy({ id: In(rows.map(r => r.userId)) }) : []).map(
        u => [u.id, u.username]
      )
    );
    return {
      problems,
      rows: rows.map(row => ({ ...row, username: users.get(row.userId) ?? String(row.userId) }))
    };
  }

  async export(user: UserEntity, id: number) {
    await this.access.requirePrivilege(user, UserPrivilegeType.ExportContest);
    const result = await this.readRanklist(user, id, "export");
    return {
      csv: csvDocument([
        ["Rank", "User", "Score", "Time (seconds)", ...result.problems.map(p => p.title)],
        ...result.rows.map(r => [
          r.rank,
          r.username,
          r.score,
          r.penalty,
          ...result.problems.map(p => {
            const x = r.problems[p.id];
            return x ? (x.score ?? (x.accepted ? "AC" : `-${x.wrong}`)) : "";
          })
        ])
      ])
    };
  }

  async summary(user: UserEntity, id: number, data?: ContestRequestData) {
    await this.access.requirePrivilege(user, UserPrivilegeType.ManageSummaries);
    await this.access.get(user, id, true);
    const repo = this.db.getRepository(ContestSummaryEntity);
    let row = await repo.findOneBy({ contestId: id, userId: user.id });
    if (data) {
      const ids = (await this.contestProblems.problemList(id)).map(p => p.id);
      if (
        !Array.isArray(data.problems) ||
        data.problems.length > ids.length ||
        new Set(data.problems.map(p => p.contestProblemId)).size !== data.problems.length
      )
        throw new BadRequestException();
      const parts = data.problems.map(p => {
        if (!ids.includes(p.contestProblemId) || !Number.isFinite(p.minutes) || p.minutes < 0 || p.minutes > 10000000)
          throw new BadRequestException();
        return { contestProblemId: p.contestProblemId, content: text(p.content, 200000), minutes: p.minutes };
      });
      row = row ?? repo.create({ contestId: id, userId: user.id });
      Object.assign(row, { content: text(data.content, 1000000), problems: parts, updatedAt: new Date() });
      await repo.save(row);
    }
    return { summary: row ?? { content: "", problems: [] } };
  }

  /**
   * The user's own summaries. Their notes are always theirs; the contest's title only while they may open the
   * contest: one they lost access to (left its team, say) is unavailable, under whatever title it has now.
   */
  async summaries(user: UserEntity, page = 1) {
    await this.access.requirePrivilege(user, UserPrivilegeType.ManageSummaries);
    const [rows, total] = await this.db
      .getRepository(ContestSummaryEntity)
      .findAndCount({ where: { userId: user.id }, order: { updatedAt: "DESC" }, skip: (page - 1) * 30, take: 30 });
    return {
      total,
      summaries: await Promise.all(
        rows.map(async row => {
          // The summary's own fields: its loaded contest must not go along
          const { id, contestId, userId, content, problems, updatedAt } = row;
          const own = { id, contestId, userId, content, problems, updatedAt };
          const contest = await row.contest;
          return (await this.access.canView(user, contest))
            ? { ...own, title: contest.title }
            : { ...own, title: null, unavailable: true };
        })
      )
    };
  }

  async delete(user: UserEntity, id: number) {
    if ((await teamResourceAccess(this.db, user, "contest", id)) !== null)
      throw new BadRequestException("Archive team contests from the team page");
    if (!(await this.access.get(user, id)).manager) throw new ForbiddenException();
    for (;;) {
      // Submission admission holds a shared contest lock through commit. Finalize only when the exclusive
      // lock sees no submissions. Release it before taking the problem/submission locks needed for cleanup.
      // eslint-disable-next-line no-await-in-loop -- Each committed batch determines the next step.
      const batch = await this.db.transaction("READ COMMITTED", async transaction => {
        const contest = await transaction.findOne(ContestEntity, {
          where: { id },
          lock: { mode: "pessimistic_write" }
        });
        if (!contest) return { remove: null };
        const submissions = await transaction.find(SubmissionEntity, {
          where: { contestId: id },
          order: { id: "ASC" },
          take: 100
        });
        if (submissions.length) return { submissions };
        const problems = await transaction
          .getRepository(ContestProblemEntity)
          .createQueryBuilder("p")
          .where("p.contestId = :id", { id })
          .setLock("pessimistic_write")
          .getMany();
        const remove = await this.files.deleteFile(
          problems.flatMap(p => p.attachments.map(a => a.uuid)),
          transaction
        );
        await transaction.delete(ContestEntity, { id });
        return { remove };
      });
      if (!batch.submissions) {
        batch.remove?.();
        return {};
      }
      for (const submission of batch.submissions) {
        // eslint-disable-next-line no-await-in-loop -- Cancel and clean each submission with its existing locks.
        await this.submissions.deleteSubmission(submission);
      }
    }
  }
}
