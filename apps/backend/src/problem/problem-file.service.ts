import fs from "fs";

import { Injectable } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { v4 as archiveUuid } from "uuid";

import { DataSource, Repository, EntityManager, In, FindOptionsWhere } from "typeorm";

import { ProblemFileType, ProblemFileEntity } from "./problem-file.entity";
import { ProblemJudgeInfoEntity } from "./problem-judge-info.entity";
import { ProblemEntity, ProblemType } from "./problem.entity";
import { deferTestDataDeletion } from "./deferred-file-deletion";
import { ProblemAccessService } from "./problem-access.service";
import { ProblemLockService } from "./problem-lock.service";
import { preprocessedJudgeInfoCacheKey } from "./problem-judge-info-cache";

import { ProblemFileDto } from "./dto";

import type { ProblemJudgeInfoTraditional } from "../problem-type/types/traditional/problem-judge-info.interface";

import { isValidFilename } from "../common/validators";
import { ArchiveError, ArchivePair, ExtractedArchiveFile, ZIP_LIMITS } from "../archive/safe-zip";

import { UserEntity } from "../user/user.entity";
import { FileService } from "../file/file.service";
import { ConfigService } from "../config/config.service";
import { RedisService } from "../redis/redis.service";
import { LockService } from "../redis/lock.service";
import { ProblemTypeFactoryService } from "../problem-type/problem-type-factory.service";
import { FileEntity } from "../file/file.entity";
import { FileUploadInfoDto, SignedFileUploadRequestDto } from "../file/dto";

/**
 * A problem's files: its test data and additional files, added, renamed and removed within the site's limits.
 * Replaced test data stays stored while submissions pinned to an earlier data version may need it.
 */
@Injectable()
export class ProblemFileService {
  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @InjectRepository(ProblemFileEntity)
    private readonly problemFileRepository: Repository<ProblemFileEntity>,
    private readonly problemTypeFactoryService: ProblemTypeFactoryService,
    private readonly fileService: FileService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
    private readonly lockService: LockService,
    private readonly problemAccess: ProblemAccessService,
    private readonly problemLocks: ProblemLockService
  ) {}

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
    const prepared: { filename: string; size: number; uuid: string; sha256?: string }[] = [];
    let committed = false;
    try {
      await options.authorize();
      for (const file of files) {
        const uuid = archiveUuid();
        const entry: (typeof prepared)[number] = { filename: file.filename, size: file.size, uuid };
        prepared.push(entry);
        // eslint-disable-next-line no-await-in-loop, no-bitwise -- Keep file handles, imports, and transaction operations ordered. Combine filesystem flags without weakening NOFOLLOW protections.
        const input = await fs.promises.open(file.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
          const stat = await input.stat();
          if (!stat.isFile() || stat.size !== file.size) throw new ArchiveError("ZIP_INTEGRITY_ERROR");
          // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
          entry.sha256 = await this.fileService.uploadFile(uuid, input.createReadStream({ autoClose: false }), 1);
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
              // Test data may still be needed by submissions pinned to an earlier data version
              if (type === ProblemFileType.TestData) {
                // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
                await deferTestDataDeletion([old.uuid], manager);
              } else {
                // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
                removeObjects.push(await this.fileService.deleteFile(old.uuid, manager));
              }
            }
            for (const file of prepared) {
              // eslint-disable-next-line no-await-in-loop -- Keep file handles, imports, and transaction operations ordered.
              await manager.save(FileEntity, {
                uuid: file.uuid,
                size: file.size,
                uploadTime: new Date(),
                sha256: file.sha256
              });
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
          await this.redisService.cacheDelete(preprocessedJudgeInfoCacheKey(problem.id));
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
    return await this.problemLocks.lockProblemById(
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
    noLimit: boolean,
    actingUser?: UserEntity
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
        await this.problemAccess.authorizeProblemMutation(transactionalEntityManager, problem, actingUser);
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
        // Test data may still be needed by submissions pinned to an earlier data version
        if (oldProblemFile && type === ProblemFileType.TestData)
          await deferTestDataDeletion([oldProblemFile.uuid], transactionalEntityManager);
        else if (oldProblemFile)
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
        await this.redisService.cacheDelete(preprocessedJudgeInfoCacheKey(problem.id));

      return ret;
    });
  }

  async removeProblemFiles(
    problem: ProblemEntity,
    type: ProblemFileType,
    filenames: string[],
    actingUser?: UserEntity
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-shadow
    return await this.lockManageProblemFile(problem.id, type, async problem => {
      if (!problem) return;

      let deleteFilesActually: () => void = null;
      await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
        await this.problemAccess.authorizeProblemMutation(transactionalEntityManager, problem, actingUser);
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

        // Test data may still be needed by submissions pinned to an earlier data version
        if (type === ProblemFileType.TestData)
          await deferTestDataDeletion(
            problemFiles.map(problemFile => problemFile.uuid),
            transactionalEntityManager
          );
        else
          deleteFilesActually = await this.fileService.deleteFile(
            problemFiles.map(problemFile => problemFile.uuid),
            transactionalEntityManager
          );
      });

      if (deleteFilesActually) deleteFilesActually();
      if (type === ProblemFileType.TestData)
        await this.redisService.cacheDelete(preprocessedJudgeInfoCacheKey(problem.id));
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
        const hashes = await this.fileService.getContentHashes(problemFiles.map(problemFile => problemFile.uuid));
        return problemFiles.map((problemFile, i) => ({
          ...problemFile,
          size: fileSizes[i],
          ...(hashes[problemFile.uuid] ? { sha256: hashes[problemFile.uuid] } : {})
        }));
      }

      return problemFiles;
    });
  }

  async renameProblemFile(
    problem: ProblemEntity,
    type: ProblemFileType,
    filename: string,
    newFilename: string,
    actingUser?: UserEntity
  ): Promise<boolean | "FILE_ALREADY_EXISTS"> {
    // eslint-disable-next-line @typescript-eslint/no-shadow
    return await this.lockManageProblemFile(problem.id, type, async problem => {
      if (!problem) return false;

      const renamed = await this.connection.transaction("READ COMMITTED", async manager => {
        await this.problemAccess.authorizeProblemMutation(manager, problem, actingUser);
        const repository = manager.getRepository(ProblemFileEntity);
        const findOptions: FindOptionsWhere<ProblemFileEntity> = {
          problemId: problem.id,
          type,
          filename
        };
        const problemFile = await repository.findOneBy(findOptions);

        if (!problemFile) return false;

        if (problemFile.filename === newFilename) return true;
        const target = await repository.findOneBy({ ...findOptions, filename: newFilename });
        // The database collation may consider a case-only rename the same row.
        if (target && target.filename !== problemFile.filename) return "FILE_ALREADY_EXISTS";

        try {
          // Updating the primary key preserves the object and never replaces a file.
          const result = await repository.update(findOptions, { filename: newFilename });
          if (!result.affected) return false;
        } catch (e) {
          // Also handle writers outside this lock without exposing a SQL exception.
          if (e?.driverError?.code === "ER_DUP_ENTRY" || e?.driverError?.errno === 1062) return "FILE_ALREADY_EXISTS";
          throw e;
        }

        return true;
      });
      if (renamed === true && type === ProblemFileType.TestData)
        await this.redisService.cacheDelete(preprocessedJudgeInfoCacheKey(problem.id));
      return renamed;
    });
  }
}
