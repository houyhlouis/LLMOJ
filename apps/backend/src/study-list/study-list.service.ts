import { Injectable, Inject, forwardRef } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";

import { StudyListEntity, StudyListItem } from "./study-list.entity";

import { UserEntity } from "../user/user.entity";
import { ProblemService, ProblemPermissionType } from "../problem/problem.service";
import { SubmissionService } from "../submission/submission.service";
import { Locale } from "../common/locale.type";
import { prefetchTeamResources } from "../team/team-access";

export interface StudyListChanges {
  title: string;
  description: string;
  items: StudyListItem[];
  starred: boolean;
  archived: boolean;
}

/**
 * Each user's own study lists. Only their owner reads or changes one; a list keeps its notes on problems that were
 * deleted or made private since, and is saved only on top of the version its editor loaded.
 */
@Injectable()
export class StudyListService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly problems: ProblemService,
    @Inject(forwardRef(() => SubmissionService))
    private readonly submissions: SubmissionService
  ) {}

  /** The user's lists, starred first, then the most recently changed. */
  async listOwned(user: UserEntity): Promise<StudyListEntity[]> {
    return await this.db
      .getRepository(StudyListEntity)
      .find({ where: { ownerId: user.id }, order: { starred: "DESC", updatedAt: "DESC" } });
  }

  async findOwned(user: UserEntity, id: number): Promise<StudyListEntity> {
    return await this.db.getRepository(StudyListEntity).findOneBy({ id, ownerId: user.id });
  }

  /**
   * Each item with what the owner may see of its problem now: its titles and the owner's accepted submission, or
   * `unavailable` for a problem they can no longer view.
   */
  async describeItems(user: UserEntity, list: StudyListEntity) {
    // A list has up to 1,000 problems: read them, which of them belong to teams and their titles together. Each one's
    // access is still checked on its own, with privileges read once per request.
    const problems = await this.problems.findProblemsByExistingIds(list.items.map(item => item.problemId));
    await prefetchTeamResources(
      this.db,
      "problem",
      problems.filter(problem => problem).map(problem => problem.id)
    );
    const visible: boolean[] = [];
    for (const problem of problems) {
      // eslint-disable-next-line no-await-in-loop -- Checked in order; most need no query
      visible.push(!!problem && (await this.problems.userHasPermission(user, problem, ProblemPermissionType.View)));
    }
    const shown = problems.filter((problem, index) => visible[index]);
    // As in the problem set: the user's latest accepted submission outside contests, if they may view submissions
    const accepted = await this.submissions.getUserLatestSubmissionByProblems(user, shown, true);
    const locales = [Locale.zh_CN, Locale.en_US];
    const titles = await Promise.all(
      locales.map(locale =>
        this.problems.getProblemLocalizedTitles(
          shown,
          shown.map(problem => (problem.locales.includes(locale) ? locale : problem.locales[0]))
        )
      )
    );
    const shownIndex = new Map(shown.map((problem, index) => [problem.id, index]));
    return await Promise.all(
      list.items.map(async (item, index) => {
        const problem = problems[index];
        if (!visible[index]) return { ...item, unavailable: true };
        const submission = accepted.get(problem.id);
        return {
          ...item,
          meta: await this.problems.getProblemMeta(problem),
          titles: Object.fromEntries(locales.map((locale, i) => [locale, titles[i][shownIndex.get(problem.id)]])),
          accepted: !!submission,
          submission: submission ? { id: submission.id, status: submission.status } : null
        };
      })
    );
  }

  /**
   * Creates a list, or changes one (`id`) if it's still at `version`. Problems already on the list keep their notes
   * whatever happened to them; newly added ones must be problems the owner may view.
   */
  async save(
    user: UserEntity,
    id: number | undefined,
    version: number | undefined,
    changes: StudyListChanges
  ): Promise<{ id: number } | { error: "INVALID" | "NOT_FOUND" | "CHANGED" | "PROBLEM_UNAVAILABLE" }> {
    const title = changes.title.trim();
    if (!title || new Set(changes.items.map(item => item.problemId)).size !== changes.items.length)
      return { error: "INVALID" };
    const repo = this.db.getRepository(StudyListEntity);
    let list = id ? await repo.findOneBy({ id, ownerId: user.id }) : repo.create({ ownerId: user.id });
    if (!list) return { error: "NOT_FOUND" };
    if (id && version !== list.version) return { error: "CHANGED" };
    const existingIds = new Set((list.items ?? []).map(item => item.problemId));
    for (const item of changes.items) {
      // Existing notes are the user's own data even if a problem was deleted or made private.
      // Only newly added references need fresh problem-view authorization.
      if (existingIds.has(item.problemId)) continue;
      // eslint-disable-next-line no-await-in-loop -- Resolve access and parent checks before processing the next list.
      const problem = await this.problems.findProblemById(item.problemId);
      // eslint-disable-next-line no-await-in-loop -- Resolve access and parent checks before processing the next list.
      if (!problem || !(await this.problems.userHasPermission(user, problem, ProblemPermissionType.View)))
        return { error: "PROBLEM_UNAVAILABLE" };
    }
    const values = {
      title,
      description: changes.description,
      items: changes.items,
      starred: changes.starred,
      archived: changes.archived
    };
    if (id) {
      // Only on top of the version the editor loaded
      const result = await repo.update({ id: list.id, ownerId: user.id, version }, values);
      if (!result.affected) return { error: "CHANGED" };
    } else {
      list = await repo.save(Object.assign(list, values));
    }
    return { id: list.id };
  }

  /** @returns `false` if the user has no such list. */
  async remove(user: UserEntity, id: number): Promise<boolean> {
    const result = await this.db.getRepository(StudyListEntity).delete({ id, ownerId: user.id });
    return !!result.affected;
  }
}
