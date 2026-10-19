import { Injectable } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { DataSource, Repository, EntityManager, In } from "typeorm";

import { ProblemTagMapEntity } from "./problem-tag-map.entity";
import { ProblemTagEntity } from "./problem-tag.entity";
import { ProblemEntity } from "./problem.entity";

import { LocalizedProblemTagDto } from "./dto";

import { LocalizedContentService } from "../localized-content/localized-content.service";
import { LocalizedContentEntity, LocalizedContentType } from "../localized-content/localized-content.entity";
import { Locale } from "../common/locale.type";
import { AuditLogObjectType, AuditService } from "../audit/audit.service";

/** Problem tags: the tags themselves with their names in each language, and which tags each problem has. */
@Injectable()
export class ProblemTagService {
  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @InjectRepository(ProblemTagEntity)
    private readonly problemTagRepository: Repository<ProblemTagEntity>,
    @InjectRepository(ProblemTagMapEntity)
    private readonly problemTagMapRepository: Repository<ProblemTagMapEntity>,
    private readonly localizedContentService: LocalizedContentService,
    private readonly auditService: AuditService
  ) {
    this.auditService.registerObjectTypeQueryHandler(AuditLogObjectType.ProblemTag, async (problemTagId, locale) => {
      const problemTag = await this.findProblemTagById(problemTagId);
      return !problemTag ? null : await this.getProblemTagLocalized(problemTag, locale);
    });
  }

  async findProblemTagById(id: number): Promise<ProblemTagEntity> {
    return await this.problemTagRepository.findOneBy({ id });
  }

  async findProblemTagsByExistingIds(problemTagIds: number[]): Promise<ProblemTagEntity[]> {
    if (problemTagIds.length === 0) return [];
    const uniqueIds = Array.from(new Set(problemTagIds));
    const records = await this.problemTagRepository.findByIds(uniqueIds);
    const map = Object.fromEntries(records.map(record => [record.id, record]));
    return problemTagIds.map(problemId => map[problemId]);
  }

  async getAllProblemTags(manager?: EntityManager): Promise<ProblemTagEntity[]> {
    return manager ? await manager.find(ProblemTagEntity) : await this.problemTagRepository.find();
  }

  async createProblemTag(
    localizedNames: [Locale, string][],
    color: string,
    manager?: EntityManager
  ): Promise<ProblemTagEntity> {
    const create = async (transactionalEntityManager: EntityManager) => {
      const problemTag = new ProblemTagEntity();
      problemTag.color = color;
      problemTag.locales = localizedNames.map(([locale]) => locale);
      await transactionalEntityManager.save(problemTag);

      for (const [locale, name] of localizedNames) {
        // eslint-disable-next-line no-await-in-loop
        await this.localizedContentService.createOrUpdate(
          problemTag.id,
          LocalizedContentType.ProblemTagName,
          locale,
          name,
          transactionalEntityManager
        );
      }

      return problemTag;
    };
    return manager ? await create(manager) : await this.connection.transaction("READ COMMITTED", create);
  }

  async updateProblemTag(
    problemTag: ProblemTagEntity,
    localizedNames: [Locale, string][],
    color: string,
    manager?: EntityManager
  ): Promise<void> {
    const update = async (transactionalEntityManager: EntityManager) => {
      problemTag.color = color;
      problemTag.locales = localizedNames.map(([locale]) => locale);
      await transactionalEntityManager.save(problemTag);

      await this.localizedContentService.delete(
        problemTag.id,
        LocalizedContentType.ProblemTagName,
        null,
        transactionalEntityManager
      );
      for (const [locale, name] of localizedNames) {
        // eslint-disable-next-line no-await-in-loop
        await this.localizedContentService.createOrUpdate(
          problemTag.id,
          LocalizedContentType.ProblemTagName,
          locale,
          name,
          transactionalEntityManager
        );
      }
    };
    if (manager) await update(manager);
    else await this.connection.transaction("READ COMMITTED", update);
  }

  async deleteProblemTag(problemTag: ProblemTagEntity): Promise<void> {
    await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
      await transactionalEntityManager.delete(ProblemTagEntity, {
        id: problemTag.id
      });

      await this.localizedContentService.delete(
        problemTag.id,
        LocalizedContentType.ProblemTagName,
        null,
        transactionalEntityManager
      );
    });
  }

  async getProblemTagLocalizedName(problemTag: ProblemTagEntity, locale: Locale): Promise<string> {
    return await this.localizedContentService.get(problemTag.id, LocalizedContentType.ProblemTagName, locale);
  }

  /**
   * Get the tag dto with localized name of requested locale, if not available, the name of default locale is used.
   */
  async getProblemTagLocalized(problemTag: ProblemTagEntity, locale: Locale): Promise<LocalizedProblemTagDto> {
    const nameLocale = problemTag.locales.includes(locale) ? locale : problemTag.locales[0];
    const name = await this.getProblemTagLocalizedName(problemTag, nameLocale);
    return {
      id: problemTag.id,
      color: problemTag.color,
      name,
      nameLocale
    };
  }

  async getProblemTagAllLocalizedNames(
    problemTag: ProblemTagEntity,
    manager?: EntityManager
  ): Promise<Partial<Record<Locale, string>>> {
    if (manager) {
      const rows = await manager.findBy(LocalizedContentEntity, {
        objectId: problemTag.id,
        type: LocalizedContentType.ProblemTagName
      });
      return Object.fromEntries(rows.map(row => [row.locale, row.data]));
    }
    return await this.localizedContentService.getOfAllLocales(problemTag.id, LocalizedContentType.ProblemTagName);
  }

  async invalidateProblemTagCaches(problemTags: ProblemTagEntity[]): Promise<void> {
    await Promise.all(
      problemTags.flatMap(tag =>
        tag.locales.map(locale =>
          this.localizedContentService.invalidateCache(tag.id, LocalizedContentType.ProblemTagName, locale)
        )
      )
    );
  }

  async setProblemTags(
    problem: ProblemEntity,
    problemTags: ProblemTagEntity[],
    transactionalEntityManager: EntityManager
  ): Promise<void> {
    await transactionalEntityManager.delete(ProblemTagMapEntity, {
      problemId: problem.id
    });
    if (problemTags.length === 0) return;
    await transactionalEntityManager
      .createQueryBuilder()
      .insert()
      .into(ProblemTagMapEntity)
      .values(problemTags.map(problemTag => ({ problemId: problem.id, problemTagId: problemTag.id })))
      .execute();
  }

  async getProblemTagIdsByProblem(problem: ProblemEntity, manager?: EntityManager): Promise<number[]> {
    const problemTagMaps = manager
      ? await manager.findBy(ProblemTagMapEntity, { problemId: problem.id })
      : await this.problemTagMapRepository.findBy({ problemId: problem.id });

    return problemTagMaps.map(problemTagMap => problemTagMap.problemTagId);
  }

  async getProblemTagsByProblem(problem: ProblemEntity): Promise<ProblemTagEntity[]> {
    return await this.findProblemTagsByExistingIds(await this.getProblemTagIdsByProblem(problem));
  }

  /** `getProblemTagsByProblem` of each problem, in two queries. */
  async getProblemTagsByProblems(problems: ProblemEntity[]): Promise<Map<number, ProblemTagEntity[]>> {
    const result = new Map(problems.map(problem => [problem.id, [] as ProblemTagEntity[]]));
    if (!problems.length) return result;
    const maps = await this.problemTagMapRepository.findBy({ problemId: In(problems.map(problem => problem.id)) });
    const tags = await this.findProblemTagsByExistingIds([...new Set(maps.map(map => map.problemTagId))]);
    const tagById = new Map(tags.filter(tag => tag).map(tag => [tag.id, tag]));
    for (const map of maps)
      if (tagById.has(map.problemTagId)) result.get(map.problemId).push(tagById.get(map.problemTagId));
    return result;
  }

  /** `getProblemTagLocalized` of each tag, with the names read together. */
  async getProblemTagsLocalized(problemTags: ProblemTagEntity[], locale: Locale): Promise<LocalizedProblemTagDto[]> {
    const nameLocales = problemTags.map(tag => (tag.locales.includes(locale) ? locale : tag.locales[0]));
    const names = await this.localizedContentService.getMany(
      problemTags.map((tag, index) => ({
        objectId: tag.id,
        type: LocalizedContentType.ProblemTagName,
        locale: nameLocales[index]
      }))
    );
    return problemTags.map((tag, index) => ({
      id: tag.id,
      color: tag.color,
      name: names[index],
      nameLocale: nameLocales[index]
    }));
  }
}
