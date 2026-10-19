import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, In } from "typeorm";

import { ContestEntity } from "./contest.entity";
import { ContestProblemEntity } from "./contest-problem.entity";
import { ContestSummaryEntity } from "./contest-summary.entity";
import { ContestAccessService } from "./contest-access.service";
import { ContestScoreService } from "./contest-score.service";
import { ContestProblemService } from "./contest-problem.service";
import { contestEnded, contestOwnResult, contestStarted, contestStatisticsVisible } from "./contest-policy";
import { text } from "./contest-input";
import { isContestRule, normalizeContestRuleOptions } from "./contest-rules";

import { normalizeContestLanguages } from "./contest-languages";

import type { ContestRequestData } from "./contest-request.dto";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeType } from "../user/user-privilege.service";
import { SubmissionService } from "../submission/submission.service";
import { teamResourceAccess } from "../team/team-access";
import { SubmissionEntity } from "../submission/submission.entity";
import { FileService } from "../file/file.service";

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
    const { contest, manager } = await this.access.get(user, id);
    const now = Date.now();
    const started = contestStarted(contest, now);
    const ended = contestEnded(contest, now);
    const problems = started || manager ? await this.contestProblems.problemList(contest.id) : [];
    // Running NOI contests conceal verdicts even when aggregate statistics are enabled.
    const showStatistics = problems.length && contestStatisticsVisible(contest, manager, now);
    const scores = problems.length ? await this.scores.contestScores(contest, problems) : [];
    const own = (await this.access.canSeeOwnResults(user)) ? scores.find(row => row.userId === user.id) : null;
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
    return {
      contest,
      problems,
      manager,
      started,
      ended,
      serverTime: new Date(),
      problemStats,
      ownResults,
      canRank: (await this.access.scoreboard(user, contest, manager, now)) === "allowed",
      canSubmit: await this.access.canSubmit(user, contest, manager, now)
    };
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
    if (id && data.rule !== contest.rule && (await this.db.getRepository(SubmissionEntity).countBy({ contestId: id })))
      throw new BadRequestException("Cannot change rule after submissions");
    const start = new Date(data.startTime);
    const end = new Date(data.endTime);
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
    await this.db.getRepository(ContestEntity).save(contest);
    return { id: contest.id };
  }

  async ranklist(user: UserEntity, id: number) {
    const { contest, manager } = await this.access.get(user, id, true);
    const scoreboard = await this.access.scoreboard(user, contest, manager);
    if (scoreboard === "denied") throw new ForbiddenException();
    if (scoreboard === "hidden") throw new ForbiddenException("Ranklist is hidden during this contest");
    const problems = await this.contestProblems.problemList(id);
    const rows = await this.scores.contestScores(contest, problems);
    const users = rows.length
      ? await this.db.getRepository(UserEntity).findBy({ id: In(rows.map(r => r.userId)) })
      : [];
    return {
      problems,
      rows: rows.map(row => ({
        ...row,
        username: users.find(u => u.id === row.userId)?.username ?? String(row.userId)
      }))
    };
  }

  async export(user: UserEntity, id: number) {
    await this.access.requirePrivilege(user, UserPrivilegeType.ExportContest);
    const result = await this.ranklist(user, id);
    const cell = (value: unknown) =>
      `"${String(value ?? "")
        .replace(/"/g, '""')
        .replace(/^[=+@-]/, "'$&")}"`;
    const rows = [
      ["Rank", "User", "Score", "Time (seconds)", ...result.problems.map(p => p.title)],
      ...result.rows.map(r => [
        r.rank,
        r.username,
        r.score,
        r.penalty,
        ...result.problems.map(p => {
          const x = r.problems[p.id];
          return x ? x.score ?? (x.accepted ? "AC" : `-${x.wrong}`) : "";
        })
      ])
    ];
    return { csv: rows.map(row => row.map(cell).join(",")).join("\r\n") };
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

  async summaries(user: UserEntity, page = 1) {
    await this.access.requirePrivilege(user, UserPrivilegeType.ManageSummaries);
    const [rows, total] = await this.db
      .getRepository(ContestSummaryEntity)
      .findAndCount({ where: { userId: user.id }, order: { updatedAt: "DESC" }, skip: (page - 1) * 30, take: 30 });
    return {
      total,
      summaries: await Promise.all(rows.map(async row => ({ ...row, title: (await row.contest).title })))
    };
  }

  async delete(user: UserEntity, id: number) {
    if ((await teamResourceAccess(this.db, user, "contest", id)) !== null)
      throw new BadRequestException("Archive team contests from the team page");
    if (!(await this.access.get(user, id)).manager) throw new ForbiddenException();
    for (const s of await this.db.getRepository(SubmissionEntity).findBy({ contestId: id })) {
      // eslint-disable-next-line no-await-in-loop -- Finish each deletion before processing the next submission.
      await this.submissions.deleteSubmission(s);
    }
    const problems = await this.db.getRepository(ContestProblemEntity).findBy({ contestId: id });
    let remove: () => void;
    await this.db.transaction(async manager => {
      remove = await this.files.deleteFile(
        problems.flatMap(p => p.attachments.map(a => a.uuid)),
        manager
      );
      await manager.delete(ContestEntity, { id });
    });
    remove();
    return {};
  }
}
