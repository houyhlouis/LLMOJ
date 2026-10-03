import fs from "fs";
import path from "path";

import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";

import { ProblemService, ProblemPermissionType } from "./problem.service";

import { ProblemFileType } from "./problem-file.entity";

import { ImportTestDataZipRequestDto, ImportTestDataZipResponseDto } from "./dto/import-test-data-zip.dto";

import { ArchiveError, extractSafeZip, ZIP_LIMITS } from "../archive/safe-zip";
import { FileEntity } from "../file/file.entity";
import { FileService } from "../file/file.service";
import { RedisService } from "../redis/redis.service";
import { LockService } from "../redis/lock.service";
import { UserService } from "../user/user.service";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { UserEntity } from "../user/user.entity";
import { AuditService, AuditLogObjectType } from "../audit/audit.service";

@Injectable()
export class ProblemArchiveService {
  constructor(
    @InjectDataSource() private readonly connection: DataSource,
    private readonly problemService: ProblemService,
    private readonly fileService: FileService,
    private readonly redisService: RedisService,
    private readonly lockService: LockService,
    private readonly userService: UserService,
    private readonly userPrivilegeService: UserPrivilegeService,
    private readonly auditService: AuditService
  ) {}

  async importTestDataZip(
    user: UserEntity,
    request: ImportTestDataZipRequestDto
  ): Promise<ImportTestDataZipResponseDto> {
    try {
      if (!user) throw new ArchiveError("PERMISSION_DENIED");
      if (!/\.zip$/i.test(request.filename)) throw new ArchiveError("INVALID_ZIP_FILENAME");
      if (
        !Number.isSafeInteger(request.uploadInfo?.size) ||
        request.uploadInfo.size < 22 ||
        request.uploadInfo.size > ZIP_LIMITS.archiveBytes
      )
        throw new ArchiveError("ZIP_SIZE_LIMIT");
      let noLimit = false;
      const authorize = async () => {
        const freshUser = await this.userService.findUserById(user.id);
        const problem = await this.problemService.findProblemById(request.problemId);
        if (!problem) throw new ArchiveError("NO_SUCH_PROBLEM");
        noLimit = await this.userPrivilegeService.userHasPrivilege(freshUser, UserPrivilegeType.ManageProblem);
        if (
          !freshUser ||
          !(await this.problemService.userHasPermission(freshUser, problem, ProblemPermissionType.Modify, noLimit)) ||
          !(await this.userPrivilegeService.permissionDecision(freshUser, UserPrivilegeType.EditProblemData, true))
        )
          throw new ArchiveError("PERMISSION_DENIED");
        return problem;
      };
      const problem = await authorize();
      const lease = {
        ownerId: user.id,
        problemId: problem.id,
        filename: request.filename,
        size: request.uploadInfo.size,
        replaceExisting: !!request.replaceExisting
      };
      if (!request.uploadInfo.uuid) {
        const signed = await this.fileService.prepareUploadRequest(request.uploadInfo.size, () => null);
        if (typeof signed === "string") throw new ArchiveError(signed);
        const redis = this.redisService.getClient();
        try {
          await redis.setex(`problem-zip:${signed.uuid}`, 600, JSON.stringify(lease));
        } finally {
          await redis.quit();
        }
        return { signedUploadRequest: signed };
      }
      return await this.lockService.lock("problem-zip-extraction", async () => {
        const leaseKey = `problem-zip:${request.uploadInfo.uuid}`;
        const actualLease = await this.redisService.cacheGet(leaseKey);
        if (!actualLease || actualLease !== JSON.stringify(lease)) throw new ArchiveError("FILE_NOT_UPLOADED");
        let archiveClaimed = false;
        let workspace: string;
        try {
          const claimed = await this.connection.transaction(manager =>
            this.fileService.processUploadRequest(request.uploadInfo, () => null, manager)
          );
          if (!(claimed instanceof FileEntity))
            throw new ArchiveError(typeof claimed === "string" ? claimed : "INVALID_ZIP");
          archiveClaimed = true;
          const base = process.env.HYHOJ_ARCHIVE_WORK_DIRECTORY || "/opt/LibreOJ/data/backend-archives";
          await fs.promises.mkdir(base, { recursive: true, mode: 0o700 });
          workspace = await fs.promises.mkdtemp(path.join(base, "zip-"));
          const zip = path.join(workspace, "archive.zip");
          if (
            (await this.fileService.downloadFileToPath(claimed.uuid, zip, ZIP_LIMITS.archiveBytes)) !==
            request.uploadInfo.size
          )
            throw new ArchiveError("ZIP_INTEGRITY_ERROR");
          const extracted = await extractSafeZip(zip, path.join(workspace, "files"));
          const importedFiles = await this.problemService.addProblemFilesFromDisk(
            problem,
            ProblemFileType.TestData,
            extracted.files,
            {
              authorize: async () => {
                await authorize();
              },
              noLimit: async () => {
                await authorize();
                return noLimit;
              },
              replaceExisting: !!request.replaceExisting
            }
          );
          await this.auditService.log("problem.upload_file", AuditLogObjectType.Problem, problem.id, {
            type: ProblemFileType.TestData,
            filename: request.filename,
            archive: true,
            fileCount: importedFiles.length,
            size: importedFiles.reduce((sum, file) => sum + file.size, 0)
          });
          return {
            importedFiles,
            detectedTestcases: extracted.pairs,
            nameMap: extracted.files.map(({ archivePath, filename }) => ({ archivePath, filename })),
            skippedFiles: extracted.skippedFiles
          };
        } finally {
          if (workspace) await fs.promises.rm(workspace, { recursive: true, force: true });
          if (archiveClaimed) {
            const remove = await this.connection.transaction(manager =>
              this.fileService.deleteFile(request.uploadInfo.uuid, manager)
            );
            await remove();
            await this.redisService.cacheDelete(leaseKey);
          }
        }
      });
    } catch (error) {
      return { error: error instanceof ArchiveError ? error.code : "INVALID_ZIP" };
    }
  }
}
