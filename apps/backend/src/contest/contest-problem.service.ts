import { promises as fs } from "fs";

import os from "os";

import path from "path";

import { createHash } from "crypto";

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";

import { ContestProblemEntity } from "./contest-problem.entity";
import { ContestAccessService } from "./contest-access.service";
import { filename, text } from "./contest-input";
import { contestSubmissionsOpen } from "./contest-policy";

import type { ContestRequestData } from "./contest-request.dto";

import { UserEntity } from "../user/user.entity";
import { ProblemService } from "../problem/problem.service";
import { ProblemAccessService, ProblemPermissionType } from "../problem/problem-access.service";
import { ProblemFileService } from "../problem/problem-file.service";
import { ProblemEntity, ProblemType } from "../problem/problem.entity";
import { ProblemFileType } from "../problem/problem-file.entity";
import { SubmissionEntity } from "../submission/submission.entity";
import { FileService, MinioSignFor } from "../file/file.service";
import { FileEntity } from "../file/file.entity";
import { Locale } from "../common/locale.type";

import type { ProblemJudgeInfoTraditional } from "../problem-type/types/traditional/problem-judge-info.interface";
import type { ProblemJudgeInfoCommunication } from "../problem-type/types/communication/problem-judge-info.interface";

/**
 * A contest's problems: which problems it has and their settings in the contest (title, weight, subtask scoring,
 * input and output files), what participants see of them, and their attachments, including the public headers of
 * communication problems.
 */
@Injectable()
export class ContestProblemService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly access: ContestAccessService,
    private readonly problems: ProblemService,
    private readonly problemAccess: ProblemAccessService,
    private readonly problemFiles: ProblemFileService,
    private readonly files: FileService
  ) {}

  private problemMeta(p: ContestProblemEntity) {
    return {
      id: p.id,
      contestId: p.contestId,
      problemId: p.problemId,
      position: p.position,
      title: p.title,
      weight: p.weight,
      subtaskAllOrNothing: p.subtaskAllOrNothing,
      inputFilename: p.inputFilename,
      outputFilename: p.outputFilename,
      attachments: p.attachments
    };
  }

  async problemList(contestId: number) {
    const rows = await this.db
      .getRepository(ContestProblemEntity)
      .find({ where: { contestId }, order: { position: "ASC", id: "ASC" } });
    return await Promise.all(
      rows.map(async p => ({
        ...this.problemMeta(p),
        title: p.title || (await this.problems.getProblemLocalizedTitle(await p.problem, (await p.problem).locales[0]))
      }))
    );
  }

  async saveProblem(user: UserEntity, id: number, data: ContestRequestData) {
    const { manager } = await this.access.get(user, id);
    if (!manager) throw new ForbiddenException();
    const problemId = Number(data.problemId);
    const problem = await this.problems.findProblemById(problemId);
    if (!problem || !(await this.problemAccess.userHasPermission(user, problem, ProblemPermissionType.Modify)))
      throw new ForbiddenException("Problem modification permission required");
    const repository = this.db.getRepository(ContestProblemEntity);
    const row =
      (await repository.findOneBy({ contestId: id, problemId })) ??
      repository.create({ contestId: id, problemId, attachments: [] });
    if (
      !Number.isInteger(data.position) ||
      data.position < 1 ||
      data.position > 1000 ||
      !Number.isFinite(data.weight) ||
      data.weight <= 0 ||
      data.weight > 1000
    )
      throw new BadRequestException();
    if (data.subtaskAllOrNothing !== undefined && typeof data.subtaskAllOrNothing !== "boolean")
      throw new BadRequestException("Invalid subtask scoring mode");
    const inputFilename = filename(data.inputFilename);
    const outputFilename = filename(data.outputFilename);
    if (!!inputFilename !== !!outputFilename || (inputFilename && inputFilename === outputFilename))
      throw new BadRequestException("Specify both input and output filenames");
    Object.assign(row, {
      position: data.position,
      weight: data.weight,
      subtaskAllOrNothing: data.subtaskAllOrNothing ?? row.subtaskAllOrNothing ?? false,
      title: text(data.title ?? "", 160),
      inputFilename,
      outputFilename
    });
    if (row.id)
      await repository.update(
        { id: row.id },
        {
          position: row.position,
          weight: row.weight,
          subtaskAllOrNothing: row.subtaskAllOrNothing,
          title: row.title,
          inputFilename: row.inputFilename,
          outputFilename: row.outputFilename
        }
      );
    else await repository.save(row);
    return { id: row.id };
  }

  async removeProblem(user: UserEntity, id: number, problemId: number) {
    if (!(await this.access.get(user, id)).manager) throw new ForbiddenException();
    const row = await this.db.getRepository(ContestProblemEntity).findOneBy({ id: problemId, contestId: id });
    if (!row) throw new NotFoundException();
    if (await this.db.getRepository(SubmissionEntity).countBy({ contestProblemId: row.id }))
      throw new BadRequestException("Problem already has contest submissions");
    let remove: () => void;
    await this.db.transaction(async manager => {
      remove = await this.files.deleteFile(
        row.attachments.map(a => a.uuid),
        manager
      );
      await manager.remove(row);
    });
    remove();
    return {};
  }

  // Only an explicitly public attachment matching an active grader header may cross
  // from a private source problem into a contest. Never sign the TestData object.
  private async publicHeaderAttachments(
    problem: ProblemEntity,
    judgeInfo: Partial<ProblemJudgeInfoCommunication>,
    explicit: { filename: string; uuid: string; size: number }[],
    onlyName?: string
  ): Promise<{ filename: string; uuid: string; size: number; derived: true }[]> {
    if (problem.type !== ProblemType.Communication || !judgeInfo?.grader) return [];
    const aliases = Object.entries<unknown>(judgeInfo.extraSourceFiles?.cpp || {})
      .filter(
        ([name, target]) =>
          name.length <= 256 &&
          /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:h|hpp)$/.test(name) &&
          !name.includes("..") &&
          typeof target === "string" &&
          (!onlyName || name === onlyName) &&
          !explicit.some(file => file.filename === name)
      )
      .slice(0, 16);
    if (!aliases.length) return [];
    const [publicFiles, hiddenFiles] = await Promise.all([
      this.problemFiles.listProblemFiles(problem, ProblemFileType.AdditionalFile, true),
      this.problemFiles.listProblemFiles(problem, ProblemFileType.TestData, true)
    ]);
    const maximumBytes = 256 * 1024;
    const pairs = aliases.flatMap(([name, target]) => {
      const publicFile = publicFiles.find(file => file.filename === name);
      const hiddenFile = hiddenFiles.find(file => file.filename === target);
      return publicFile &&
        hiddenFile &&
        Number.isSafeInteger(publicFile.size) &&
        publicFile.size >= 0 &&
        publicFile.size <= maximumBytes &&
        publicFile.size === hiddenFile.size
        ? [{ publicFile, hiddenFile }]
        : [];
    });
    if (!pairs.length) return [];
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "libreoj-contest-headers-"));
    const result: { filename: string; uuid: string; size: number; derived: true }[] = [];
    try {
      for (let index = 0; index < pairs.length; index++) {
        const { publicFile, hiddenFile } = pairs[index];
        const publicPath = path.join(directory, `${index}-public`);
        const hiddenPath = path.join(directory, `${index}-judge`);
        try {
          // eslint-disable-next-line no-await-in-loop -- Keep transaction operations and permission checks in their existing order.
          const sizes = await Promise.allSettled([
            this.files.downloadFileToPath(publicFile.uuid, publicPath, maximumBytes),
            this.files.downloadFileToPath(hiddenFile.uuid, hiddenPath, maximumBytes)
          ]);
          if (sizes.some(size => size.status !== "fulfilled" || size.value !== publicFile.size)) continue;
          // eslint-disable-next-line no-await-in-loop -- Keep transaction operations and permission checks in their existing order.
          const [publicBytes, hiddenBytes] = await Promise.all([fs.readFile(publicPath), fs.readFile(hiddenPath)]);
          if (
            createHash("sha256").update(publicBytes).digest("hex") !==
            createHash("sha256").update(hiddenBytes).digest("hex")
          )
            continue;
          result.push({ filename: publicFile.filename, uuid: publicFile.uuid, size: publicFile.size, derived: true });
        } catch {
          // A missing/replaced/oversized object is not an authorized public header.
        }
      }
      return result;
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async problem(user: UserEntity, id: number, problemId: number, locale: string) {
    const { contest, manager } = await this.access.get(user, id, true);
    const row = await this.db.getRepository(ContestProblemEntity).findOneBy({ id: problemId, contestId: id });
    if (!row) throw new NotFoundException();
    const problem = await row.problem;
    const selected = problem.locales.includes(locale as Locale) ? (locale as Locale) : problem.locales[0];
    const [judgeInfo, submittable] = await this.problems.getProblemJudgeInfo(problem);
    const attachments = row.attachments || [];
    const derived = (await this.access.canReadPublicHeaders(user, manager))
      ? await this.publicHeaderAttachments(problem, judgeInfo, attachments)
      : [];
    return {
      contest,
      manager,
      problem: { ...this.problemMeta(row), attachments: [...attachments, ...derived] },
      type: problem.type,
      // Public submission capability only; helper names and judge data stay private.
      hasGrader:
        problem.type === ProblemType.Communication &&
        !!(judgeInfo as Partial<ProblemJudgeInfoCommunication> & Partial<ProblemJudgeInfoTraditional>)?.grader,
      locales: problem.locales,
      locale: selected,
      title: row.title || (await this.problems.getProblemLocalizedTitle(problem, selected)),
      content: await this.problems.getProblemLocalizedContent(problem, selected),
      samples: await this.problems.getProblemSamples(problem),
      limits: {
        timeLimit: (judgeInfo as Partial<ProblemJudgeInfoCommunication> & Partial<ProblemJudgeInfoTraditional>)
          ?.timeLimit,
        memoryLimit: (judgeInfo as Partial<ProblemJudgeInfoCommunication> & Partial<ProblemJudgeInfoTraditional>)
          ?.memoryLimit
      },
      submittable: submittable && contestSubmissionsOpen(contest, manager)
    };
  }

  async attachment(user: UserEntity, id: number, problemId: number, data: ContestRequestData) {
    if (!(await this.access.get(user, id)).manager) throw new ForbiddenException();
    const repo = this.db.getRepository(ContestProblemEntity);
    const row = await repo.findOneBy({ id: problemId, contestId: id });
    if (!row) throw new NotFoundException();
    const name = filename(data.filename);
    if (!name || !data.uploadInfo || !Number.isInteger(data.uploadInfo.size) || data.uploadInfo.size < 0)
      throw new BadRequestException();
    return await this.db.transaction(async manager => {
      const locked = await manager.findOne(ContestProblemEntity, {
        where: { id: problemId, contestId: id },
        lock: { mode: "pessimistic_write" }
      });
      if (!locked) throw new NotFoundException();
      if (locked.attachments.some(a => a.filename === name) || locked.attachments.length >= 50)
        throw new BadRequestException("Duplicate attachment or too many attachments");
      const result = await this.files.processUploadRequest(
        data.uploadInfo,
        size => (size > 50 * 1024 * 1024 ? "FILE_TOO_LARGE" : null),
        manager
      );
      if (typeof result === "string") return { error: result };
      if (!(result instanceof FileEntity)) return { signedUploadRequest: result };
      locked.attachments.push({ filename: name, uuid: result.uuid, size: result.size });
      await manager.save(locked);
      return {};
    });
  }

  async download(user: UserEntity, id: number, problemId: number, name: string) {
    const { manager } = await this.access.get(user, id, true);
    if (!(await this.access.canDownloadAttachments(user))) throw new ForbiddenException();
    const row = await this.db.getRepository(ContestProblemEntity).findOneBy({ id: problemId, contestId: id });
    if (!row) throw new NotFoundException();
    let file = row.attachments.find(a => a.filename === name);
    if (!file) {
      if (!(await this.access.canReadPublicHeaders(user, manager))) throw new ForbiddenException();
      const problem = await row.problem;
      const [judgeInfo] = await this.problems.getProblemJudgeInfo(problem);
      [file] = await this.publicHeaderAttachments(problem, judgeInfo, row.attachments, name);
    }
    if (!file) throw new NotFoundException();
    return {
      url: await this.files.signDownloadLink({
        uuid: file.uuid,
        downloadFilename: file.filename,
        signFor: MinioSignFor.UserDownload
      })
    };
  }

  async removeAttachment(user: UserEntity, id: number, problemId: number, name: string) {
    if (!(await this.access.get(user, id)).manager) throw new ForbiddenException();
    let remove: () => void;
    await this.db.transaction(async manager => {
      const row = await manager.findOne(ContestProblemEntity, {
        where: { id: problemId, contestId: id },
        lock: { mode: "pessimistic_write" }
      });
      const file = row?.attachments.find(a => a.filename === name);
      if (!file) throw new NotFoundException();
      row.attachments = row.attachments.filter(a => a.uuid !== file.uuid);
      await manager.save(row);
      remove = await this.files.deleteFile(file.uuid, manager);
    });
    remove();
    return {};
  }
}
