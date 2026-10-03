import fs from "fs";

import { Injectable, forwardRef, Inject, BadRequestException } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { v4 as archiveUuid } from "uuid";

import { DataSource, Repository, EntityManager, Brackets, In, FindOptionsWhere } from "typeorm";

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

import {
  ProblemStatementDto,
  UpdateProblemStatementRequestDto,
  ProblemLocalizedContentDto,
  ProblemFileDto,
  ProblemMetaDto,
  LocalizedProblemTagDto
} from "./dto";

import type { ProblemJudgeInfoTraditional } from "../problem-type/types/traditional/problem-judge-info.interface";

import { isValidFilename } from "../common/validators";
import { ArchiveError, ArchivePair, ExtractedArchiveFile, ZIP_LIMITS } from "../archive/safe-zip";

import { UserEntity } from "../user/user.entity";
import { GroupEntity } from "../group/group.entity";
import { LocalizedContentService } from "../localized-content/localized-content.service";
import { LocalizedContentEntity, LocalizedContentType } from "../localized-content/localized-content.entity";
import { Locale } from "../common/locale.type";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { PermissionService, PermissionObjectType } from "../permission/permission.service";
import { UserService } from "../user/user.service";
import { GroupService } from "../group/group.service";
import { FileService } from "../file/file.service";
import { ConfigService } from "../config/config.service";
import { RedisService } from "../redis/redis.service";
import { LockService } from "../redis/lock.service";
import { SubmissionService } from "../submission/submission.service";
import { AuditLogObjectType, AuditService } from "../audit/audit.service";
import { ProblemTypeFactoryService } from "../problem-type/problem-type-factory.service";
import { FileEntity } from "../file/file.entity";
import { escapeLike } from "../database/database.utils";
import { FileUploadInfoDto, SignedFileUploadRequestDto } from "../file/dto";

function assertProblemHasTitle(contents: { title?: string }[]): void {
  if (!contents.some(content => typeof content.title === "string" && content.title.trim()))
    throw new BadRequestException("A problem title is required in at least one language.");
}

export enum ProblemPermissionType {
  View = "View",
  Modify = "Modify",
  ManagePermission = "ManagePermission",
  ManagePublicness = "ManagePublicness",
  Delete = "Delete"
}

export enum ProblemPermissionLevel {
  Read = 1,
  Write = 2
}

/**
 * See `ProblemService.getPreprocessedJudgeInfo()`
 */
const REDIS_KEY_PROBLEM_PREPROCESSED_JUDGE_INFO = "problem-preprocessed-judge-info-and-submittable:%d";

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
    @InjectRepository(ProblemFileEntity)
    private readonly problemFileRepository: Repository<ProblemFileEntity>,
    @InjectRepository(ProblemTagEntity)
    private readonly problemTagRepository: Repository<ProblemTagEntity>,
    @InjectRepository(ProblemTagMapEntity)
    private readonly problemTagMapRepository: Repository<ProblemTagMapEntity>,
    private readonly problemTypeFactoryService: ProblemTypeFactoryService,
    private readonly localizedContentService: LocalizedContentService,
    @Inject(forwardRef(() => UserPrivilegeService))
    private readonly userPrivilegeService: UserPrivilegeService,
    @Inject(forwardRef(() => UserService))
    private readonly userService: UserService,
    private readonly groupService: GroupService,
    private readonly permissionService: PermissionService,
    private readonly fileService: FileService,
    @Inject(forwardRef(() => SubmissionService))
    private readonly submissionService: SubmissionService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly lockService: LockService,
    private readonly auditService: AuditService
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

    this.auditService.registerObjectTypeQueryHandler(AuditLogObjectType.ProblemTag, async (problemTagId, locale) => {
      const problemTag = await this.findProblemTagById(problemTagId);
      return !problemTag ? null : await this.getProblemTagLocalized(problemTag, locale);
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

  async userHasPermission(
    user: UserEntity,
    problem: ProblemEntity,
    type: ProblemPermissionType,
    hasPrivilege?: boolean,
    manager?: EntityManager
  ): Promise<boolean> {
    if (!problem) return false;
    if (!(await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ViewProblem, manager))) return false;
    if (
      type !== ProblemPermissionType.View &&
      !(await this.userHasPermission(user, problem, ProblemPermissionType.View, hasPrivilege, manager))
    )
      return false;
    const own = user?.id === problem.ownerId;
    const legacy = await this.userHasPermissionOriginal(user, problem, type, hasPrivilege, manager);
    const permission = {
      [ProblemPermissionType.View]:
        !problem.isPublic && !own ? UserPrivilegeType.ViewHiddenProblem : UserPrivilegeType.ViewProblem,
      [ProblemPermissionType.Modify]: own ? UserPrivilegeType.EditOwnProblem : UserPrivilegeType.EditAnyProblem,
      [ProblemPermissionType.Delete]: own ? UserPrivilegeType.DeleteOwnProblem : UserPrivilegeType.DeleteAnyProblem,
      [ProblemPermissionType.ManagePermission]: UserPrivilegeType.ManageProblemPermissions,
      [ProblemPermissionType.ManagePublicness]: UserPrivilegeType.ManageProblemVisibility
    }[type];
    return permission ? await this.userPrivilegeService.permissionDecision(user, permission, legacy, manager) : legacy;
  }

  private async userHasPermissionOriginal(
    user: UserEntity,
    problem: ProblemEntity,
    type: ProblemPermissionType,
    hasPrivilege?: boolean,
    manager?: EntityManager
  ): Promise<boolean> {
    switch (type) {
      // Everyone can view a public problem
      // Owner, admins and those who has read permission can view a non-public problem
      case ProblemPermissionType.View:
        if (problem.isPublic) return true;
        if (user && user.id === problem.ownerId) return true;
        if (
          hasPrivilege ??
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager))
        )
          return true;
        else
          return await this.permissionService.userOrItsGroupsHavePermission(
            user,
            problem.id,
            PermissionObjectType.Problem,
            ProblemPermissionLevel.Read,
            manager
          );

      // Owner, admins and those who has write permission can modify a problem
      case ProblemPermissionType.Modify:
        if (
          user &&
          user.id === problem.ownerId &&
          (!problem.isPublic || this.configService.config.preference.security.allowNonPrivilegedUserEditPublicProblem)
        )
          return true;
        if (
          hasPrivilege ??
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager))
        )
          return true;
        else
          return (
            (await this.permissionService.userOrItsGroupsHavePermission(
              user,
              problem.id,
              PermissionObjectType.Problem,
              ProblemPermissionLevel.Write,
              manager
            )) &&
            (!problem.isPublic || this.configService.config.preference.security.allowNonPrivilegedUserEditPublicProblem)
          );

      // Admins can manage a problem's permission
      // Controlled by the application preference, the owner may have the permission
      case ProblemPermissionType.ManagePermission:
        if (
          user &&
          user.id === problem.ownerId &&
          this.configService.config.preference.security.allowOwnerManageProblemPermission &&
          (!problem.isPublic || this.configService.config.preference.security.allowNonPrivilegedUserEditPublicProblem)
        )
          return true;
        else if (
          hasPrivilege ??
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager))
        )
          return true;
        else return false;

      // Admins can manage a problem's publicness (set display id / make public or non-public)
      case ProblemPermissionType.ManagePublicness:
        if (
          hasPrivilege ??
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager))
        )
          return true;
        else return false;

      // Admins can delete a problem
      // Controlled by the application preference, the owner may have the permission
      case ProblemPermissionType.Delete:
        if (
          user &&
          user.id === problem.ownerId &&
          this.configService.config.preference.security.allowOwnerDeleteProblem &&
          (!problem.isPublic || this.configService.config.preference.security.allowNonPrivilegedUserEditPublicProblem)
        )
          return true;
        else if (
          hasPrivilege ??
          (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager))
        )
          return true;
        else return false;

      default:
        return false;
    }
  }

  async getUserPermissions(user: UserEntity, problem: ProblemEntity): Promise<ProblemPermissionType[]> {
    const result: ProblemPermissionType[] = [];
    for (const permission of Object.values(ProblemPermissionType)) {
      // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
      if (await this.userHasPermission(user, problem, permission)) result.push(permission);
    }
    return result;
  }

  async userHasCreateProblemPermission(user: UserEntity, manager?: EntityManager): Promise<boolean> {
    if (!user) return false;
    const fallback =
      this.configService.config.preference.security.allowEveryoneCreateProblem ||
      (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem, manager));
    return await this.userPrivilegeService.permissionDecision(user, UserPrivilegeType.CreateProblem, fallback, manager);
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

        await this.setProblemTags(problem, tags, transactionalEntityManager);
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

        await this.setProblemTags(currentProblem, tags, transactionalEntityManager);

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
    const testData = await this.getProblemFiles(problem, ProblemFileType.TestData);
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

    await this.redisService.cacheDelete(REDIS_KEY_PROBLEM_PREPROCESSED_JUDGE_INFO.format(problem.id));

    return null;
  }

  async getProblemLocalizedTitle(problem: ProblemEntity, locale: Locale): Promise<string> {
    return await this.localizedContentService.get(problem.id, LocalizedContentType.ProblemTitle, locale);
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
    const key = REDIS_KEY_PROBLEM_PREPROCESSED_JUDGE_INFO.format(problem.id);
    const cachedResult: [judgeInfo: ProblemJudgeInfo, submittable: boolean] = JSON.parse(
      await this.redisService.cacheGet(key)
    );
    if (cachedResult) return cachedResult;

    const [judgeInfo, submittable] = await this.getProblemJudgeInfo(problem);
    const preprocessed = this.problemTypeFactoryService
      .type(problem.type)
      .preprocessJudgeInfo(judgeInfo, await this.getProblemFiles(problem, ProblemFileType.TestData));
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
    await this.lockProblemById(
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

  // Upload immutable objects first, then register the whole batch in one transaction.
  // No existing object is removed until registration commits successfully.
  async addProblemFilesFromDisk(
    problem: ProblemEntity,
    type: ProblemFileType,
    files: { filename: string; path: string; size: number }[],
    options: {
      authorize: () => Promise<void>;
      replaceExisting?: boolean;
      noLimit?: boolean | ((manager?: EntityManager) => Promise<boolean>);
      hiddenSamples?: ArchivePair[];
      onRegistered?: (manager: EntityManager) => Promise<void>;
      authorizeCommit?: (manager: EntityManager, currentProblem: ProblemEntity) => Promise<void>;
    }
  ): Promise<ProblemFileDto[]> {
    if (!files.length || files.length > ZIP_LIMITS.files) throw new ArchiveError("ZIP_FILE_COUNT_LIMIT");
    const names = new Set<string>();
    for (const file of files) {
      if (
        !isValidFilename(file.filename) ||
        file.filename.length > 256 ||
        // eslint-disable-next-line no-control-regex -- Explicitly reject or remove control bytes from untrusted names and text.
        /[\\\x00-\x1f\x7f]/.test(file.filename) ||
        names.has(file.filename.toLowerCase())
      )
        throw new ArchiveError("ZIP_FILENAME_CONFLICT");
      names.add(file.filename.toLowerCase());
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > ZIP_LIMITS.fileBytes)
        throw new ArchiveError("ZIP_FILE_SIZE_LIMIT");
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > ZIP_LIMITS.totalBytes)
      throw new ArchiveError("ZIP_TOTAL_SIZE_LIMIT");
    const prepared: { filename: string; size: number; uuid: string }[] = [];
    let committed = false;
    try {
      await options.authorize();
      for (const file of files) {
        const uuid = archiveUuid();
        prepared.push({ filename: file.filename, size: file.size, uuid });
        // eslint-disable-next-line no-await-in-loop, no-bitwise -- Keep file handles, imports, and transaction operations ordered. Combine filesystem flags without weakening NOFOLLOW protections.
        const input = await fs.promises.open(file.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
          const stat = await input.stat();
          if (!stat.isFile() || stat.size !== file.size) throw new ArchiveError("ZIP_INTEGRITY_ERROR");
          // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
          await this.fileService.uploadFile(uuid, input.createReadStream({ autoClose: false }), 1);
        } finally {
          // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
          await input.close();
        }
      }
      const removeObjects: (() => void)[] = [];
      await this.lockManageProblemFile(problem.id, type, async current => {
        if (!current) throw new ArchiveError("NO_SUCH_PROBLEM");
        await options.authorize();
        await this.connection.transaction(
          options.authorizeCommit ? "SERIALIZABLE" : "READ COMMITTED",
          async manager => {
            if (options.authorizeCommit) {
              const currentProblem = await manager.findOne(ProblemEntity, {
                where: { id: problem.id },
                lock: { mode: "pessimistic_write" }
              });
              await manager.findOne(ProblemJudgeInfoEntity, {
                where: { problemId: problem.id },
                lock: { mode: "pessimistic_write" }
              });
              await options.authorizeCommit(manager, currentProblem);
              problem = currentProblem;
            }
            const previous = await manager.findBy(ProblemFileEntity, { problemId: problem.id, type });
            const replaced = previous.filter(file => names.has(file.filename.toLowerCase()));
            if (replaced.length && !options.replaceExisting) throw new ArchiveError("FILE_ALREADY_EXISTS");
            const retained = previous.filter(file => !names.has(file.filename.toLowerCase()));
            const sizes = await this.fileService.getFileSizes(
              retained.map(file => file.uuid),
              manager
            );
            const unlimited =
              typeof options.noLimit === "function" ? await options.noLimit(manager) : !!options.noLimit;
            const resource = this.configService.config.resourceLimit;
            const [maximumFiles, maximumBytes] =
              type === ProblemFileType.TestData
                ? [resource.problemTestdataFiles, resource.problemTestdataSize]
                : [resource.problemAdditionalFileFiles, resource.problemAdditionalFileSize];
            if (!unlimited && retained.length + prepared.length > maximumFiles)
              throw new ArchiveError("TOO_MANY_FILES");
            if (
              !unlimited &&
              sizes.reduce((a, b) => a + b, 0) + prepared.reduce((a, b) => a + b.size, 0) > maximumBytes
            )
              throw new ArchiveError("TOTAL_SIZE_TOO_LARGE");
            for (const old of replaced) {
              // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
              await manager.delete(ProblemFileEntity, { problemId: problem.id, type, filename: old.filename });
              // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
              removeObjects.push(await this.fileService.deleteFile(old.uuid, manager));
            }
            for (const file of prepared) {
              // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
              await manager.save(FileEntity, { uuid: file.uuid, size: file.size, uploadTime: new Date() });
              // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
              await manager.save(ProblemFileEntity, {
                problemId: problem.id,
                type,
                filename: file.filename,
                uuid: file.uuid
              });
            }
            if (options.hiddenSamples) {
              if (problem.type !== ProblemType.Traditional || type !== ProblemFileType.TestData)
                throw new ArchiveError("INVALID_HIDDEN_SAMPLES");
              const info = await manager.findOne(ProblemJudgeInfoEntity, {
                where: { problemId: problem.id },
                lock: { mode: "pessimistic_write" }
              });
              const judgeInfo = { ...(info.judgeInfo as ProblemJudgeInfoTraditional) };
              judgeInfo.hiddenSamples = [...(judgeInfo.hiddenSamples || []), ...options.hiddenSamples];
              this.problemTypeFactoryService
                .type(problem.type)
                .validateAndFilterJudgeInfo(
                  judgeInfo,
                  await manager.findBy(ProblemFileEntity, { problemId: problem.id, type }),
                  unlimited
                );
              info.judgeInfo = judgeInfo;
              await manager.save(info);
            }
            if (options.onRegistered) await options.onRegistered(manager);
          }
        );
        committed = true;
        for (const remove of removeObjects) remove();
        if (type === ProblemFileType.TestData)
          await this.redisService.cacheDelete(REDIS_KEY_PROBLEM_PREPROCESSED_JUDGE_INFO.format(problem.id));
      });
      return prepared.map(file => ({ uuid: file.uuid, filename: file.filename, size: file.size }));
    } finally {
      if (!committed) for (const file of prepared) this.fileService.deleteUnfinishedUploadedFile(file.uuid);
    }
  }

  async installHiddenSamples(
    problem: ProblemEntity,
    files: ExtractedArchiveFile[],
    pairs: ArchivePair[],
    options: {
      authorize: () => Promise<void>;
      noLimit?: boolean | ((manager?: EntityManager) => Promise<boolean>);
      onRegistered?: (manager: EntityManager) => Promise<void>;
      authorizeCommit?: (manager: EntityManager, currentProblem: ProblemEntity) => Promise<void>;
    }
  ): Promise<ArchivePair[]> {
    if (!pairs.length) return [];
    if (pairs.length > 1000) throw new ArchiveError("INVALID_HIDDEN_SAMPLES");
    const used = new Set(pairs.flatMap(pair => [pair.inputFile, pair.outputFile]));
    const prefix = `sample-managed-${archiveUuid()}-`;
    const mapped = new Map(
      [...used].map((name, index) => [name, `${prefix}${index + 1}${/\.in$/i.test(name) ? ".in" : ".out"}`])
    );
    const selected = files.filter(file => used.has(file.filename));
    if (selected.length !== used.size) throw new ArchiveError("INVALID_HIDDEN_SAMPLES");
    const hiddenSamples = pairs.map(pair => ({
      inputFile: mapped.get(pair.inputFile),
      outputFile: mapped.get(pair.outputFile)
    }));
    await this.addProblemFilesFromDisk(
      problem,
      ProblemFileType.TestData,
      selected.map(file => ({ ...file, filename: mapped.get(file.filename) })),
      { ...options, hiddenSamples }
    );
    return hiddenSamples;
  }

  private async checkAddProblemFileLimit(
    problem: ProblemEntity,
    type: ProblemFileType,
    size: number,
    filename: string,
    transactionalEntityManager: EntityManager
  ): Promise<"TOO_MANY_FILES" | "TOTAL_SIZE_TOO_LARGE"> {
    const currentFiles = await transactionalEntityManager.findBy(ProblemFileEntity, { problemId: problem.id, type });
    const fileSizes = await this.fileService.getFileSizes(
      currentFiles.map(file => file.uuid),
      transactionalEntityManager
    );

    let oldFileCount = 0;
    let oldFileSizeSum = 0;
    for (const i of currentFiles.keys()) {
      const file = currentFiles[i];
      if (file.filename === filename) continue;

      oldFileCount++;
      oldFileSizeSum += fileSizes[i];
    }

    // Get the corresponding limits from config
    const [filesLimit, sizeLimit] = {
      [ProblemFileType.TestData]: [
        this.configService.config.resourceLimit.problemTestdataFiles,
        this.configService.config.resourceLimit.problemTestdataSize
      ],
      [ProblemFileType.AdditionalFile]: [
        this.configService.config.resourceLimit.problemAdditionalFileFiles,
        this.configService.config.resourceLimit.problemAdditionalFileSize
      ]
    }[type];

    if (oldFileCount + 1 > filesLimit) return "TOO_MANY_FILES";
    if (oldFileSizeSum + size > sizeLimit) return "TOTAL_SIZE_TOO_LARGE";

    return null;
  }

  // Manage problem file actions should be locked to make sure the limit check works.
  private async lockManageProblemFile<T>(
    problemId: number,
    type: ProblemFileType,
    callback: (problem: ProblemEntity) => Promise<T>
  ): Promise<T> {
    return await this.lockProblemById(
      problemId,
      "Read",
      async problem =>
        await this.lockService.lock(`ManageProblemFile_${type}_${problem.id}`, async () => await callback(problem))
    );
  }

  /**
   * @error "NO_SUCH_PROBLEM"
   *
   * If the user have not uploaded the file, the uuid should be null.
   * It will return [UUID, upload request info] if success and error message if limit exceeded.
   * @error "TOO_MANY_FILES" | "TOTAL_SIZE_TOO_LARGE"
   *
   * If the user have uploaded the file, the uuid should be the uploaded file UUID.
   * It will return null if success and error message if failed.
   * @error "FILE_UUID_EXISTS" | "FILE_NOT_UPLOADED"
   */
  async addProblemFile(
    problem: ProblemEntity,
    type: ProblemFileType,
    uploadInfo: FileUploadInfoDto,
    filename: string,
    noLimit: boolean
  ): Promise<
    | SignedFileUploadRequestDto
    | "NO_SUCH_PROBLEM"
    | "TOO_MANY_FILES"
    | "TOTAL_SIZE_TOO_LARGE"
    | "FILE_UUID_EXISTS"
    | "FILE_NOT_UPLOADED"
  > {
    // eslint-disable-next-line @typescript-eslint/no-shadow
    return await this.lockManageProblemFile(problem.id, type, async problem => {
      if (!problem) return "NO_SUCH_PROBLEM";

      let deleteOldFileActually: () => void = null;
      const ret = await this.connection.transaction("REPEATABLE READ", async transactionalEntityManager => {
        const result = await this.fileService.processUploadRequest(
          uploadInfo,
          async size =>
            noLimit
              ? null
              : await this.checkAddProblemFileLimit(problem, type, size, filename, transactionalEntityManager),
          transactionalEntityManager
        );

        // SignedFileUploadRequestDto object or error
        if (!(result instanceof FileEntity)) return result;

        const oldProblemFile = await transactionalEntityManager.findOneBy(ProblemFileEntity, {
          problemId: problem.id,
          type,
          filename
        });
        if (oldProblemFile)
          deleteOldFileActually = await this.fileService.deleteFile(oldProblemFile.uuid, transactionalEntityManager);

        const problemFile = new ProblemFileEntity();
        problemFile.problemId = problem.id;
        problemFile.type = type;
        problemFile.filename = filename;
        problemFile.uuid = uploadInfo.uuid;

        await transactionalEntityManager.save(ProblemFileEntity, problemFile);

        return null;
      });

      if (deleteOldFileActually) deleteOldFileActually();
      if (type === ProblemFileType.TestData)
        await this.redisService.cacheDelete(REDIS_KEY_PROBLEM_PREPROCESSED_JUDGE_INFO.format(problem.id));

      return ret;
    });
  }

  async removeProblemFiles(problem: ProblemEntity, type: ProblemFileType, filenames: string[]): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-shadow
    return await this.lockManageProblemFile(problem.id, type, async problem => {
      if (!problem) return;

      let deleteFilesActually: () => void = null;
      await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
        const problemFiles = await transactionalEntityManager.findBy(ProblemFileEntity, {
          problemId: problem.id,
          type,
          filename: In(filenames)
        });

        await transactionalEntityManager.delete(ProblemFileEntity, {
          problemId: problem.id,
          type,
          filename: In(filenames)
        });

        deleteFilesActually = await this.fileService.deleteFile(
          problemFiles.map(problemFile => problemFile.uuid),
          transactionalEntityManager
        );
      });

      if (deleteFilesActually) deleteFilesActually();
      if (type === ProblemFileType.TestData)
        await this.redisService.cacheDelete(REDIS_KEY_PROBLEM_PREPROCESSED_JUDGE_INFO.format(problem.id));
    });
  }

  async getProblemFiles(
    problem: ProblemEntity,
    type: ProblemFileType,
    transcationalEntityManager?: EntityManager
  ): Promise<ProblemFileEntity[]> {
    const problemFiles = transcationalEntityManager
      ? await transcationalEntityManager.findBy(ProblemFileEntity, {
          problemId: problem.id,
          type
        })
      : await this.problemFileRepository.findBy({
          problemId: problem.id,
          type
        });

    return problemFiles;
  }

  async listProblemFiles(problem: ProblemEntity, type: ProblemFileType, withSize = false): Promise<ProblemFileDto[]> {
    return await this.connection.transaction("REPEATABLE READ", async transcationalEntityManager => {
      const problemFiles = await this.getProblemFiles(problem, type, transcationalEntityManager);

      if (withSize) {
        const fileSizes = await this.fileService.getFileSizes(
          problemFiles.map(problemFile => problemFile.uuid),
          transcationalEntityManager
        );
        return problemFiles.map((problemFile, i) => ({
          ...problemFile,
          size: fileSizes[i]
        }));
      }

      return problemFiles;
    });
  }

  async renameProblemFile(
    problem: ProblemEntity,
    type: ProblemFileType,
    filename: string,
    newFilename: string
  ): Promise<boolean | "FILE_ALREADY_EXISTS"> {
    // eslint-disable-next-line @typescript-eslint/no-shadow
    return await this.lockManageProblemFile(problem.id, type, async problem => {
      if (!problem) return false;

      const findOptions: FindOptionsWhere<ProblemFileEntity> = {
        problemId: problem.id,
        type,
        filename
      };
      const problemFile = await this.problemFileRepository.findOneBy(findOptions);

      if (!problemFile) return false;

      if (problemFile.filename === newFilename) return true;
      const target = await this.problemFileRepository.findOneBy({ ...findOptions, filename: newFilename });
      // The database collation may consider a case-only rename the same row.
      if (target && target.filename !== problemFile.filename) return "FILE_ALREADY_EXISTS";

      try {
        // Updating the primary key preserves the object and never replaces a file.
        const result = await this.problemFileRepository.update(findOptions, { filename: newFilename });
        if (!result.affected) return false;
      } catch (e) {
        // Also handle writers outside this lock without exposing a SQL exception.
        if (e?.driverError?.code === "ER_DUP_ENTRY" || e?.driverError?.errno === 1062) return "FILE_ALREADY_EXISTS";
        throw e;
      }

      if (type === ProblemFileType.TestData)
        await this.redisService.cacheDelete(REDIS_KEY_PROBLEM_PREPROCESSED_JUDGE_INFO.format(problem.id));

      return true;
    });
  }

  async updateProblemStatistics(
    problemId: number,
    incSubmissionCount: number,
    incAcceptedSubmissionCount: number
  ): Promise<void> {
    if (incSubmissionCount !== 0) {
      await this.problemRepository.increment({ id: problemId }, "submissionCount", incSubmissionCount);
    }

    if (incAcceptedSubmissionCount !== 0) {
      await this.problemRepository.increment({ id: problemId }, "acceptedSubmissionCount", incAcceptedSubmissionCount);
    }
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

  /**
   * Lock a problem by ID with Read/Write Lock.
   * @param type `"Read"` to ensure the problem exists while holding the lock, `"Write"` is for deleting the problem.
   */
  async lockProblemById<T>(
    id: number,
    type: "Read" | "Write",
    callback: (problem: ProblemEntity) => Promise<T>
  ): Promise<T> {
    return await this.lockService.lockReadWrite(
      `AcquireProblem_${id}`,
      type,
      async () => await callback(await this.findProblemById(id))
    );
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
  async changeProblemType(problem: ProblemEntity, type: ProblemType): Promise<boolean> {
    if (await this.submissionService.problemHasAnySubmission(problem)) return false;
    problem.type = type;
    await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
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
