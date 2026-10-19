import { Injectable, forwardRef, Inject, BadRequestException } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { DataSource, Repository, EntityManager, Brackets } from "typeorm";

import { normalizeProblemSource, problemSourceLabel } from "./problem-source";

import { ProblemJudgeInfo } from "./problem-judge-info.interface";
import { ProblemSampleData } from "./problem-sample-data.interface";
import { ProblemContentSection } from "./problem-content.interface";
import { ProblemTagMapEntity } from "./problem-tag-map.entity";
import { ProblemTagEntity } from "./problem-tag.entity";
import { ProblemFileType, ProblemFileEntity } from "./problem-file.entity";
import { ProblemSampleEntity } from "./problem-sample.entity";
import { ProblemJudgeInfoEntity } from "./problem-judge-info.entity";
import { ProblemEntity, ProblemType } from "./problem.entity";
import { ProblemAccessService, ProblemPermissionLevel } from "./problem-access.service";
import { ProblemFileService } from "./problem-file.service";
import { ProblemTagService } from "./problem-tag.service";
import { ProblemLockService } from "./problem-lock.service";
import { preprocessedJudgeInfoCacheKey } from "./problem-judge-info-cache";

import {
  ProblemStatementDto,
  UpdateProblemStatementRequestDto,
  ProblemLocalizedContentDto,
  ProblemMetaDto
} from "./dto";

import { UserEntity } from "../user/user.entity";
import { GroupEntity } from "../group/group.entity";
import { LocalizedContentService } from "../localized-content/localized-content.service";
import { LocalizedContentEntity, LocalizedContentType } from "../localized-content/localized-content.entity";
import { Locale } from "../common/locale.type";
import { PermissionService, PermissionObjectType } from "../permission/permission.service";
import { UserService } from "../user/user.service";
import { GroupService } from "../group/group.service";
import { FileService } from "../file/file.service";
import { RedisService } from "../redis/redis.service";
import { SubmissionService } from "../submission/submission.service";
import { AuditLogObjectType, AuditService } from "../audit/audit.service";
import { ProblemTypeFactoryService } from "../problem-type/problem-type-factory.service";
import { escapeLike } from "../database/database.utils";
import { teamResourceVisibilitySql } from "../team/team-access";

function assertProblemHasTitle(contents: { title?: string }[]): void {
  if (!contents.some(content => typeof content.title === "string" && content.title.trim()))
    throw new BadRequestException("A problem title is required in at least one language.");
}

/**
 * The problem catalog: finding and listing problems, creating them, their statements, samples and judge info, who
 * has explicit permissions on them, their publicness, and deleting them or changing their type. Permission rules,
 * files, tags and the problem lock have services of their own.
 */
@Injectable()
export class ProblemService {
  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @InjectRepository(ProblemEntity)
    private readonly problemRepository: Repository<ProblemEntity>,
    @InjectRepository(ProblemJudgeInfoEntity)
    private readonly problemJudgeInfoRepository: Repository<ProblemJudgeInfoEntity>,
    @InjectRepository(ProblemSampleEntity)
    private readonly problemSampleRepository: Repository<ProblemSampleEntity>,
    private readonly problemTypeFactoryService: ProblemTypeFactoryService,
    private readonly localizedContentService: LocalizedContentService,
    @Inject(forwardRef(() => UserService))
    private readonly userService: UserService,
    private readonly groupService: GroupService,
    private readonly permissionService: PermissionService,
    private readonly fileService: FileService,
    @Inject(forwardRef(() => SubmissionService))
    private readonly submissionService: SubmissionService,
    private readonly redisService: RedisService,
    private readonly auditService: AuditService,
    private readonly problemAccess: ProblemAccessService,
    private readonly problemFiles: ProblemFileService,
    private readonly problemTags: ProblemTagService,
    private readonly problemLocks: ProblemLockService
  ) {
    this.auditService.registerObjectTypeQueryHandler(AuditLogObjectType.Problem, async (problemId, locale) => {
      const problem = await this.findProblemById(problemId);
      return !problem
        ? null
        : await Promise.all([
            this.getProblemMeta(problem),
            this.getProblemLocalizedTitle(problem, problem.locales.includes(locale) ? locale : problem.locales[0])
          ]);
    });
  }

  async findProblemById(id: number): Promise<ProblemEntity> {
    return await this.problemRepository.findOneBy({ id });
  }

  async findProblemsByExistingIds(problemIds: number[]): Promise<ProblemEntity[]> {
    if (problemIds.length === 0) return [];
    const uniqueIds = Array.from(new Set(problemIds));
    const records = await this.problemRepository.findByIds(uniqueIds);
    const map = Object.fromEntries(records.map(record => [record.id, record]));
    return problemIds.map(problemId => map[problemId]);
  }

  async findProblemByDisplayId(displayId: number): Promise<ProblemEntity> {
    return await this.problemRepository.findOneBy({
      displayId
    });
  }

  async getProblemMeta(problem: ProblemEntity, includeStatistics?: boolean): Promise<ProblemMetaDto> {
    const meta: ProblemMetaDto = {
      id: problem.id,
      displayId: problem.displayId,
      type: problem.type,
      publicTime: problem.publicTime,
      isPublic: problem.isPublic,
      ownerId: problem.ownerId,
      locales: problem.locales,
      difficulty: problem.difficulty,
      originalProblem: normalizeProblemSource(problem.originalProblem),
      originalProblemTitle: problem.originalProblemTitle || "",
      originalProblemLabel: problem.originalProblemTitle
        ? problemSourceLabel(problem.originalProblem, problem.originalProblemTitle)
        : undefined
    };

    if (includeStatistics) {
      meta.acceptedSubmissionCount = problem.acceptedSubmissionCount;
      meta.submissionCount = problem.submissionCount;
    }

    return meta;
  }

  /**
   * Query problem set with pagination.
   *
   * If the user has manage problem privilege, show all problems.
   * If the user has no manage problem privilege, show only public and the user owned problems.
   *
   * Sort: problems with display ID first (by displayId asc), then without display ID (by id asc).
   */
  async queryProblemsAndCount(
    currentUser: UserEntity,
    hasPrivilege: boolean,
    keyword: string,
    tagIds: number[],
    ownerId: number,
    nonpublic: boolean,
    skipCount: number,
    takeCount: number,
    difficultyMin?: number,
    difficultyMax?: number
  ): Promise<[problems: ProblemEntity[], count: number]> {
    const queryBuilder = this.problemRepository.createQueryBuilder("problem").select("problem.id", "id");
    queryBuilder.andWhere(teamResourceVisibilitySql("problem", "problem.id", currentUser));
    if (difficultyMin != null) queryBuilder.andWhere("problem.difficulty >= :difficultyMin", { difficultyMin });
    if (difficultyMax != null) queryBuilder.andWhere("problem.difficulty <= :difficultyMax", { difficultyMax });
    let groupByAdded = false;

    if (tagIds && tagIds.length > 0) {
      queryBuilder
        .innerJoin(ProblemTagMapEntity, "map", "problem.id = map.problemId")
        .andWhere("map.problemTagId IN (:...tagIds)", { tagIds })
        .groupBy("problem.id");
      groupByAdded = true;
      if (tagIds.length > 1) queryBuilder.having("COUNT(DISTINCT map.problemTagId) = :count", { count: tagIds.length });
    }

    if (keyword) {
      queryBuilder
        .innerJoin(
          LocalizedContentEntity,
          "localizedContent",
          "localizedContent.type = :type AND problem.id = localizedContent.objectId",
          { type: LocalizedContentType.ProblemTitle }
        )
        .andWhere("localizedContent.data LIKE :like", { like: `%${escapeLike(keyword)}%` });

      if (!groupByAdded) queryBuilder.groupBy("problem.id");
    }

    if (!hasPrivilege && !(currentUser && ownerId === currentUser.id)) {
      if (currentUser)
        queryBuilder.andWhere(
          new Brackets(brackets =>
            brackets.where("problem.isPublic = 1").orWhere("problem.ownerId = :ownerId", { ownerId: currentUser.id })
          )
        );
      else queryBuilder.andWhere("problem.isPublic = 1");
    } else if (nonpublic) {
      queryBuilder.andWhere("problem.isPublic = 0");
    }
    if (ownerId) {
      queryBuilder.andWhere("problem.ownerId = :ownerId", { ownerId });
    }

    // QueryBuilder.getManyAndCount() has bug with GROUP BY
    const count = Number(
      (
        await this.connection
          .createQueryBuilder()
          .select("COUNT(*)", "count")
          .from(`(${queryBuilder.getQuery()})`, "temp")
          .setParameters(queryBuilder.expressionMap.parameters)
          .getRawOne()
      ).count
    );

    queryBuilder
      .orderBy("problem.displayId IS NOT NULL", "DESC")
      .addOrderBy("problem.displayId", "ASC")
      .addOrderBy("problem.id", "ASC");
    const result = await queryBuilder.limit(takeCount).offset(skipCount).getRawMany();
    return [await this.findProblemsByExistingIds(result.map(row => row.id)), count];
  }

  async getLatestUpdatedProblems(takeCount: number): Promise<ProblemEntity[]> {
    return await this.problemRepository.find({
      where: {
        isPublic: true
      },
      order: {
        publicTime: "DESC"
      },
      take: takeCount
    });
  }

  async createProblem(
    owner: UserEntity,
    type: ProblemType,
    statement: ProblemStatementDto,
    tags: ProblemTagEntity[],
    onCreated?: (problem: ProblemEntity, manager: EntityManager) => Promise<void>,
    authorizeCommit?: (manager: EntityManager) => Promise<void>
  ): Promise<ProblemEntity> {
    assertProblemHasTitle(statement.localizedContents);
    let problem: ProblemEntity;
    await this.connection.transaction(
      authorizeCommit ? "SERIALIZABLE" : "READ COMMITTED",
      async transactionalEntityManager => {
        // The caller's authorization runs before any row is created. Serializable
        // locking reads also protect absent permission overrides until commit.
        await authorizeCommit?.(transactionalEntityManager);
        problem = new ProblemEntity();
        problem.displayId = null;
        problem.type = type;
        problem.isPublic = false;
        problem.ownerId = owner.id;
        problem.locales = statement.localizedContents.map(localizedContent => localizedContent.locale);
        problem.difficulty = statement.difficulty ?? null;
        problem.originalProblem = normalizeProblemSource(statement.originalProblem);
        problem.originalProblemTitle = "";
        problem.submissionCount = 0;
        problem.acceptedSubmissionCount = 0;
        await transactionalEntityManager.save(problem);

        const problemJudgeInfo = new ProblemJudgeInfoEntity();
        problemJudgeInfo.problemId = problem.id;
        problemJudgeInfo.judgeInfo = this.problemTypeFactoryService.type(type).getDefaultJudgeInfo();
        await transactionalEntityManager.save(problemJudgeInfo);

        const problemSample = new ProblemSampleEntity();
        problemSample.problemId = problem.id;
        problemSample.data = statement.samples;
        await transactionalEntityManager.save(problemSample);

        for (const localizedContent of statement.localizedContents) {
          // eslint-disable-next-line no-await-in-loop
          await this.localizedContentService.createOrUpdate(
            problem.id,
            LocalizedContentType.ProblemTitle,
            localizedContent.locale,
            localizedContent.title,
            transactionalEntityManager
          );
          // eslint-disable-next-line no-await-in-loop
          await this.localizedContentService.createOrUpdate(
            problem.id,
            LocalizedContentType.ProblemContent,
            localizedContent.locale,
            JSON.stringify(localizedContent.contentSections),
            transactionalEntityManager
          );
        }
        /* eslint-enable no-await-in-loop */

        await this.problemTags.setProblemTags(problem, tags, transactionalEntityManager);
        await onCreated?.(problem, transactionalEntityManager);
      }
    );

    return problem;
  }

  async updateProblemStatement(
    problem: ProblemEntity,
    request: UpdateProblemStatementRequestDto,
    tags: ProblemTagEntity[],
    authorizeCommit?: (manager: EntityManager, currentProblem: ProblemEntity) => Promise<void>
  ): Promise<boolean> {
    let previousLocales = problem.locales;
    if (request.localizedContents.every(content => content.title != null))
      assertProblemHasTitle(request.localizedContents);
    await this.connection.transaction(
      authorizeCommit ? "SERIALIZABLE" : "READ COMMITTED",
      async transactionalEntityManager => {
        // Read current metadata under the row lock: omitted fields and the source
        // title must come from the database rather than the controller's old entity.
        const currentProblem = await transactionalEntityManager.findOne(ProblemEntity, {
          where: { id: problem.id },
          lock: { mode: "pessimistic_write" }
        });
        if (!currentProblem) throw new BadRequestException("No such problem.");
        previousLocales = currentProblem.locales;
        if (authorizeCommit) {
          await transactionalEntityManager.findOne(ProblemJudgeInfoEntity, {
            where: { problemId: problem.id },
            lock: { mode: "pessimistic_write" }
          });
          await authorizeCommit(transactionalEntityManager, currentProblem);
        }
        // Omitted optional fields retain their previous value; explicit empty arrays
        // and strings clear content without requiring a complete statement.
        const previousContents = request.localizedContents.some(
          content => content.title == null || content.contentSections == null
        )
          ? await this.getProblemAllLocalizedContents(currentProblem, transactionalEntityManager)
          : [];
        request = {
          ...request,
          localizedContents: request.localizedContents.map(content => {
            const previous = previousContents.find(item => item.locale === content.locale);
            return {
              ...content,
              title: content.title ?? previous?.title ?? "",
              contentSections: content.contentSections ?? previous?.contentSections ?? []
            };
          })
        };
        assertProblemHasTitle(request.localizedContents);
        const problemSample = await transactionalEntityManager.findOneBy(ProblemSampleEntity, {
          problemId: problem.id
        });
        if (request.samples != null) problemSample.data = request.samples;
        await transactionalEntityManager.save(problemSample);

        const newLocales = request.localizedContents.map(localizedContent => localizedContent.locale);

        const deletingLocales = currentProblem.locales.filter(locale => !newLocales.includes(locale));
        for (const deletingLocale of deletingLocales) {
          // eslint-disable-next-line no-await-in-loop
          await this.localizedContentService.delete(
            problem.id,
            LocalizedContentType.ProblemTitle,
            deletingLocale,
            transactionalEntityManager
          );
          // eslint-disable-next-line no-await-in-loop
          await this.localizedContentService.delete(
            problem.id,
            LocalizedContentType.ProblemContent,
            deletingLocale,
            transactionalEntityManager
          );
        }

        const changes: Partial<ProblemEntity> = { locales: newLocales };
        if (request.difficulty !== undefined) changes.difficulty = request.difficulty;
        if (request.originalProblem !== undefined) {
          const source = normalizeProblemSource(request.originalProblem);
          if (source !== normalizeProblemSource(currentProblem.originalProblem)) changes.originalProblemTitle = "";
          changes.originalProblem = source;
        }

        for (const localizedContent of request.localizedContents) {
          // eslint-disable-next-line no-await-in-loop
          await this.localizedContentService.createOrUpdate(
            problem.id,
            LocalizedContentType.ProblemTitle,
            localizedContent.locale,
            localizedContent.title,
            transactionalEntityManager
          );
          // eslint-disable-next-line no-await-in-loop
          await this.localizedContentService.createOrUpdate(
            problem.id,
            LocalizedContentType.ProblemContent,
            localizedContent.locale,
            JSON.stringify(localizedContent.contentSections),
            transactionalEntityManager
          );
        }

        await this.problemTags.setProblemTags(currentProblem, tags, transactionalEntityManager);

        await transactionalEntityManager.update(ProblemEntity, problem.id, changes);
        Object.assign(problem, changes);
      }
    );

    if (authorizeCommit) {
      // A reader may repopulate old cached text while the transaction is open.
      // Evict after commit, including locales removed by this statement update.
      await Promise.all(
        [...new Set([...previousLocales, ...problem.locales])].flatMap(locale => [
          this.localizedContentService.invalidateCache(problem.id, LocalizedContentType.ProblemTitle, locale),
          this.localizedContentService.invalidateCache(problem.id, LocalizedContentType.ProblemContent, locale)
        ])
      );
    }
    return true;
  }

  async updateProblemJudgeInfo(
    problem: ProblemEntity,
    judgeInfo: ProblemJudgeInfo,
    submittable: boolean,
    ignoreLimitsOnValidation: boolean,
    authorizeCommit?: (manager: EntityManager, currentProblem: ProblemEntity) => Promise<void>
  ): Promise<string[]> {
    const testData = await this.problemFiles.getProblemFiles(problem, ProblemFileType.TestData);
    try {
      this.problemTypeFactoryService
        .type(problem.type)
        .validateAndFilterJudgeInfo(judgeInfo, testData, ignoreLimitsOnValidation);
    } catch (e) {
      if (Array.isArray(e)) return e;
      throw e;
    }

    if (authorizeCommit) {
      // Keep the authorization, complete problem snapshot and actual save in one
      // transaction. SERIALIZABLE also protects missing localized content/tag rows
      // from appearing between the snapshot check and commit.
      await this.connection.transaction("SERIALIZABLE", async manager => {
        const currentProblem = await manager.findOne(ProblemEntity, {
          where: { id: problem.id },
          lock: { mode: "pessimistic_write" }
        });
        const problemJudgeInfo = await manager.findOne(ProblemJudgeInfoEntity, {
          where: { problemId: problem.id },
          lock: { mode: "pessimistic_write" }
        });
        await authorizeCommit(manager, currentProblem);
        problemJudgeInfo.judgeInfo = judgeInfo;
        problemJudgeInfo.submittable = submittable;
        await manager.save(problemJudgeInfo);
      });
    } else {
      const problemJudgeInfo = await this.problemJudgeInfoRepository.findOneBy({ problemId: problem.id });
      problemJudgeInfo.judgeInfo = judgeInfo;
      problemJudgeInfo.submittable = submittable;
      await this.problemJudgeInfoRepository.save(problemJudgeInfo);
    }

    await this.redisService.cacheDelete(preprocessedJudgeInfoCacheKey(problem.id));

    return null;
  }

  async getProblemLocalizedTitle(problem: ProblemEntity, locale: Locale): Promise<string> {
    return await this.localizedContentService.get(problem.id, LocalizedContentType.ProblemTitle, locale);
  }

  /** `getProblemLocalizedTitle` of each problem in its locale, read together. */
  async getProblemLocalizedTitles(problems: ProblemEntity[], locales: Locale[]): Promise<string[]> {
    return await this.localizedContentService.getMany(
      problems.map((problem, index) => ({
        objectId: problem.id,
        type: LocalizedContentType.ProblemTitle,
        locale: locales[index]
      }))
    );
  }

  async getProblemLocalizedContent(problem: ProblemEntity, locale: Locale): Promise<ProblemContentSection[]> {
    const data = await this.localizedContentService.get(problem.id, LocalizedContentType.ProblemContent, locale);
    if (data != null) return JSON.parse(data);
    return null;
  }

  async getProblemAllLocalizedContents(
    problem: ProblemEntity,
    manager?: EntityManager
  ): Promise<ProblemLocalizedContentDto[]> {
    const get = async (type: LocalizedContentType) => {
      if (!manager) return await this.localizedContentService.getOfAllLocales(problem.id, type);
      const rows = await manager.findBy(LocalizedContentEntity, { objectId: problem.id, type });
      return Object.fromEntries(rows.map(row => [row.locale, row.data]));
    };
    const [titles, contents] = await Promise.all([
      get(LocalizedContentType.ProblemTitle),
      get(LocalizedContentType.ProblemContent)
    ]);
    return Object.keys(titles).map((locale: Locale) => ({
      locale,
      title: titles[locale],
      contentSections: JSON.parse(contents[locale])
    }));
  }

  async getProblemSamples(problem: ProblemEntity, manager?: EntityManager): Promise<ProblemSampleData> {
    const problemSample = manager
      ? await manager.findOneBy(ProblemSampleEntity, { problemId: problem.id })
      : await this.problemSampleRepository.findOneBy({ problemId: problem.id });
    return problemSample.data;
  }

  async getProblemJudgeInfo(
    problem: ProblemEntity,
    manager?: EntityManager
  ): Promise<[judgeInfo: ProblemJudgeInfo, submittable: boolean]> {
    const problemJudgeInfo = manager
      ? await manager.findOneBy(ProblemJudgeInfoEntity, { problemId: problem.id })
      : await this.problemJudgeInfoRepository.findOneBy({ problemId: problem.id });
    return [problemJudgeInfo.judgeInfo, problemJudgeInfo.submittable];
  }

  /**
   * Judge info needs to be preprocessed before sending to clients or judge clients.
   * Currently preprocessing is detecting testcases from testdata files.
   *
   * The cache gets cleared when the testdata files or judge info changed.
   */
  async getProblemPreprocessedJudgeInfo(
    problem: ProblemEntity
  ): Promise<[judgeInfo: ProblemJudgeInfo, submittable: boolean]> {
    const key = preprocessedJudgeInfoCacheKey(problem.id);
    const cachedResult: [judgeInfo: ProblemJudgeInfo, submittable: boolean] = JSON.parse(
      await this.redisService.cacheGet(key)
    );
    if (cachedResult) return cachedResult;

    const [judgeInfo, submittable] = await this.getProblemJudgeInfo(problem);
    const preprocessed = this.problemTypeFactoryService
      .type(problem.type)
      .preprocessJudgeInfo(judgeInfo, await this.problemFiles.getProblemFiles(problem, ProblemFileType.TestData));
    await this.redisService.cacheSet(key, JSON.stringify([preprocessed, submittable]));

    return [preprocessed, submittable];
  }

  /**
   * @param problem Should be locked by `ProblemService.lockProblemById(id, "Read")`.
   */
  async setProblemPermissions(
    problem: ProblemEntity,
    userPermissions: [user: UserEntity, permission: ProblemPermissionLevel][],
    groupPermissions: [group: GroupEntity, permission: ProblemPermissionLevel][]
  ): Promise<void> {
    await this.problemLocks.lockProblemById(
      problem.id,
      "Read",
      // eslint-disable-next-line @typescript-eslint/no-shadow
      async problem =>
        await this.permissionService.replaceUsersAndGroupsPermissionForObject(
          problem.id,
          PermissionObjectType.Problem,
          userPermissions,
          groupPermissions
        )
    );
  }

  async getProblemPermissionsWithId(
    problem: ProblemEntity
  ): Promise<
    [[userId: number, permission: ProblemPermissionLevel][], [groupId: number, permission: ProblemPermissionLevel][]]
  > {
    return await this.permissionService.getUserAndGroupPermissionListOfObject<ProblemPermissionLevel>(
      problem.id,
      PermissionObjectType.Problem
    );
  }

  async getProblemPermissions(
    problem: ProblemEntity
  ): Promise<
    [
      [user: UserEntity, permission: ProblemPermissionLevel][],
      [group: GroupEntity, permission: ProblemPermissionLevel][]
    ]
  > {
    const [userPermissionList, groupPermissionList] = await this.getProblemPermissionsWithId(problem);
    return [
      await Promise.all(
        userPermissionList.map(
          async ([userId, permission]): Promise<[user: UserEntity, permission: ProblemPermissionLevel]> => [
            await this.userService.findUserById(userId),
            permission
          ]
        )
      ),
      await Promise.all(
        groupPermissionList.map(
          async ([groupId, permission]): Promise<[group: GroupEntity, problem: ProblemPermissionLevel]> => [
            await this.groupService.findGroupById(groupId),
            permission
          ]
        )
      )
    ];
  }

  async setProblemDisplayId(problem: ProblemEntity, displayId: number): Promise<boolean> {
    if (!displayId) displayId = null;
    try {
      await this.problemRepository.update(problem.id, { displayId });
      problem.displayId = displayId;
      return true;
    } catch (e) {
      if (e?.driverError?.code === "ER_DUP_ENTRY" || e?.driverError?.errno === 1062) return false;

      throw e;
    }
  }

  async setProblemPublic(problem: ProblemEntity, isPublic: boolean): Promise<void> {
    const changes = { isPublic, ...(isPublic ? { publicTime: new Date() } : {}) };
    await this.problemRepository.update(problem.id, changes);
    Object.assign(problem, changes);
    await this.submissionService.setSubmissionsPublic(problem.id, isPublic);
  }

  /**
   * @param problem Must be locked by `ProblemService.lockProblemById(id, "Write")`.
   */
  async deleteProblem(problem: ProblemEntity): Promise<void> {
    let deleteFilesActually: () => void = null;
    await this.connection.transaction("REPEATABLE READ", async transactionalEntityManager => {
      // update user submission count and accepted problem count
      await this.userService.onDeleteProblem(problem.id, transactionalEntityManager);

      // delete files
      const problemFiles = await transactionalEntityManager.findBy(ProblemFileEntity, {
        problemId: problem.id
      });
      deleteFilesActually = await this.fileService.deleteFile(
        problemFiles.map(problemFile => problemFile.uuid),
        transactionalEntityManager
      );
      await transactionalEntityManager.remove(problemFiles);

      // delete permissions
      await this.permissionService.replaceUsersAndGroupsPermissionForObject(
        problem.id,
        PermissionObjectType.Problem,
        [],
        [],
        transactionalEntityManager
      );

      // cancel submissions
      await this.submissionService.onDeleteProblem(problem.id);

      // delete everything
      await transactionalEntityManager.remove(problem);
    });
    if (deleteFilesActually) deleteFilesActually();
    await this.submissionService.onProblemDeleted(problem.id);
  }

  /**
   * @param problem Must be locked by `ProblemService.lockProblemById(id, "Write")`.
   */
  async changeProblemType(problem: ProblemEntity, type: ProblemType, actingUser?: UserEntity): Promise<boolean> {
    if (await this.submissionService.problemHasAnySubmission(problem)) return false;
    await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
      await this.problemAccess.authorizeProblemMutation(transactionalEntityManager, problem, actingUser);
      problem.type = type;
      await transactionalEntityManager.update(ProblemEntity, problem.id, { type });
      await transactionalEntityManager.update(
        ProblemJudgeInfoEntity,
        {
          problemId: problem.id
        },
        {
          judgeInfo: this.problemTypeFactoryService.type(type).getDefaultJudgeInfo()
        }
      );
    });
    return true;
  }
}
