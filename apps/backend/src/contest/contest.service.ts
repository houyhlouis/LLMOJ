import { promises as fs } from "fs";

import os from "os";

import path from "path";

import { createHash } from "crypto";

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, In } from "typeorm";

import { ContestEntity } from "./contest.entity";
import { ContestProblemEntity } from "./contest-problem.entity";
import { ContestSummaryEntity } from "./contest-summary.entity";
import { scoreContest } from "./contest-scoring";
import { contestSubmissionFeedback } from "./contest-feedback";

import { normalizeContestLanguages, isContestLanguageAllowed } from "./contest-languages";

import type { ContestRequestData } from "./contest-request.dto";

import type { SubmissionContentTraditional } from "../problem-type/types/traditional/submission-content.interface";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { ProblemService, ProblemPermissionType } from "../problem/problem.service";
import { ProblemEntity, ProblemType } from "../problem/problem.entity";
import { ProblemFileType } from "../problem/problem-file.entity";
import { SubmissionService } from "../submission/submission.service";
import { SubmissionEntity } from "../submission/submission.entity";
import { FileService, MinioSignFor } from "../file/file.service";
import { FileEntity } from "../file/file.entity";
import { Locale } from "../common/locale.type";

import type { ProblemJudgeInfoTraditional } from "../problem-type/types/traditional/problem-judge-info.interface";
import type { ProblemJudgeInfoCommunication } from "../problem-type/types/communication/problem-judge-info.interface";

function text(value: unknown, limit: number, required = false): string {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim()))
    throw new BadRequestException("Invalid text");
  return value;
}
function filename(value: unknown): string {
  const name = text(value ?? "", 120);
  if (name && (!/^[\p{L}\p{N}_. -]+$/u.test(name) || name === "." || name === ".."))
    throw new BadRequestException("Invalid filename");
  return name;
}

@Injectable()
export class ContestService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly privileges: UserPrivilegeService,
    private readonly problems: ProblemService,
    private readonly submissions: SubmissionService,
    private readonly files: FileService
  ) {}

  async manager(user: UserEntity, contest: ContestEntity) {
    return (
      !!user &&
      (user.isAdmin ||
        (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ManageContest)) ||
        ((await this.privileges.userHasPrivilege(user, UserPrivilegeType.EditContest)) &&
          (contest.ownerId === user.id || contest.adminIds.includes(user.id))))
    );
  }

  async get(user: UserEntity, id: number, problemAccess = false) {
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException();
    const contest = await this.db.getRepository(ContestEntity).findOneBy({ id });
    if (!contest) throw new NotFoundException();
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContest))) throw new ForbiddenException();
    const manager = await this.manager(user, contest);
    if (
      !manager &&
      (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContest)) ||
        (!contest.isPublic && !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewHiddenContest))))
    )
      throw new ForbiddenException();
    if (problemAccess && !manager && Date.now() < +contest.startTime)
      throw new ForbiddenException({ error: "CONTEST_NOT_STARTED", message: "Contest has not started" });
    return { contest, manager };
  }

  private async login(user: UserEntity, privilege: UserPrivilegeType) {
    if (!user) throw new ForbiddenException({ error: "LOGIN_REQUIRED", message: "Login required" });
    if (!(await this.privileges.userHasPrivilege(user, privilege))) throw new ForbiddenException();
  }

  async list(user: UserEntity, page = 1) {
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContest))) throw new ForbiddenException();
    const repository = this.db.getRepository(ContestEntity);
    const query = repository.createQueryBuilder("c");
    const manage = !!user && (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ManageContest));
    if (!manage) {
      if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContest)))
        throw new ForbiddenException();
      query.where("c.isPublic = true");
      if (user && (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewHiddenContest)))
        query.orWhere("1 = 1");
      // Ownership or appointment grants private access only while editing is permitted.
      else if (user && (await this.privileges.userHasPrivilege(user, UserPrivilegeType.EditContest)))
        query.orWhere("c.ownerId = :userId OR JSON_CONTAINS(c.adminIds, :jsonId)", {
          userId: user.id,
          jsonId: String(user.id)
        });
    }
    const [contests, total] = await query
      .orderBy("c.startTime", "DESC")
      .skip((page - 1) * 30)
      .take(30)
      .getManyAndCount();
    return {
      contests,
      total,
      canCreate: !!user && (await this.privileges.userHasPrivilege(user, UserPrivilegeType.CreateContest))
    };
  }

  async detail(user: UserEntity, id: number) {
    const { contest, manager } = await this.get(user, id);
    const started = Date.now() >= +contest.startTime;
    const ended = Date.now() >= +contest.endTime;
    const problems = started || manager ? await this.problemList(contest.id) : [];
    // Running NOI contests conceal verdicts even when aggregate statistics are enabled.
    const showStatistics = problems.length && (manager || ended || (contest.rule !== "noi" && !contest.hideStatistics));
    const submissions = problems.length
      ? await this.db
          .getRepository(SubmissionEntity)
          .createQueryBuilder("s")
          .where("s.contestId = :id AND s.submitTime >= :start AND s.submitTime < :end", {
            id,
            start: contest.startTime,
            end: contest.endTime
          })
          .getMany()
      : [];
    const scores = scoreContest(contest.rule, contest.startTime, problems, submissions);
    const own =
      user && (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSubmission))
        ? scores.find(row => row.userId === user.id)
        : null;
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
        if (contest.rule === "noi" && !manager && !ended)
          return [
            p.id,
            {
              submissionId: entry.submissionId,
              status: entry.status === "CompilationError" || entry.status === "Pending" ? entry.status : "Compiled"
            }
          ];
        return [p.id, entry];
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
      canRank:
        (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContestScoreboard)) &&
        (manager ||
          ended ||
          contest.rule === "acm" ||
          (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewHiddenContestScoreboard))),
      canSubmit:
        !!user &&
        (manager || (started && !ended)) &&
        (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ParticipateContest))
    };
  }

  async save(user: UserEntity, id: number, data: ContestRequestData) {
    let contest: ContestEntity;
    if (id) {
      const access = await this.get(user, id);
      if (!access.manager) throw new ForbiddenException();
      contest = access.contest;
    } else {
      await this.login(user, UserPrivilegeType.CreateContest);
      contest = this.db.getRepository(ContestEntity).create({ ownerId: user.id, createdAt: new Date() });
    }
    if (!["noi", "ioi", "acm"].includes(data.rule)) throw new BadRequestException("Invalid rule");
    if (id && data.rule !== contest.rule && (await this.db.getRepository(SubmissionEntity).countBy({ contestId: id })))
      throw new BadRequestException("Cannot change rule after submissions");
    const start = new Date(data.startTime);
    const end = new Date(data.endTime);
    if (!Number.isFinite(+start) || !Number.isFinite(+end) || +start >= +end)
      throw new BadRequestException("Invalid time range");
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
      startTime: start,
      endTime: end,
      isPublic: data.isPublic === true,
      hideStatistics: data.hideStatistics === true,
      adminIds: [...new Set(data.adminIds)],
      languages
    });
    await this.db.getRepository(ContestEntity).save(contest);
    return { id: contest.id };
  }

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
    const { manager } = await this.get(user, id);
    if (!manager) throw new ForbiddenException();
    const problemId = Number(data.problemId);
    const problem = await this.problems.findProblemById(problemId);
    if (!problem || !(await this.problems.userHasPermission(user, problem, ProblemPermissionType.Modify)))
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
    if (!(await this.get(user, id)).manager) throw new ForbiddenException();
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

  private async canReadPublicHeaders(user: UserEntity, manager: boolean): Promise<boolean> {
    return (
      !!user &&
      (await this.privileges.userHasPrivilege(user, UserPrivilegeType.DownloadProblemAttachments)) &&
      (manager || (await this.privileges.userHasPrivilege(user, UserPrivilegeType.ParticipateContest)))
    );
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
      this.problems.listProblemFiles(problem, ProblemFileType.AdditionalFile, true),
      this.problems.listProblemFiles(problem, ProblemFileType.TestData, true)
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
    const { contest, manager } = await this.get(user, id, true);
    const row = await this.db.getRepository(ContestProblemEntity).findOneBy({ id: problemId, contestId: id });
    if (!row) throw new NotFoundException();
    const problem = await row.problem;
    const selected = problem.locales.includes(locale as Locale) ? (locale as Locale) : problem.locales[0];
    const [judgeInfo, submittable] = await this.problems.getProblemJudgeInfo(problem);
    const attachments = row.attachments || [];
    const derived = (await this.canReadPublicHeaders(user, manager))
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
      submittable: submittable && (manager || (Date.now() >= +contest.startTime && Date.now() < +contest.endTime))
    };
  }

  async attachment(user: UserEntity, id: number, problemId: number, data: ContestRequestData) {
    if (!(await this.get(user, id)).manager) throw new ForbiddenException();
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
    const { manager } = await this.get(user, id, true);
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.DownloadProblemAttachments)))
      throw new ForbiddenException();
    const row = await this.db.getRepository(ContestProblemEntity).findOneBy({ id: problemId, contestId: id });
    if (!row) throw new NotFoundException();
    let file = row.attachments.find(a => a.filename === name);
    if (!file) {
      if (!(await this.canReadPublicHeaders(user, manager))) throw new ForbiddenException();
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
    if (!(await this.get(user, id)).manager) throw new ForbiddenException();
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

  async submit(user: UserEntity, id: number, problemId: number, data: ContestRequestData, prepare = false) {
    await this.login(user, UserPrivilegeType.ParticipateContest);
    const { contest, manager } = await this.get(user, id, true);
    if (!manager && Date.now() >= +contest.endTime) throw new ForbiddenException("Contest has ended");
    const row = await this.db.getRepository(ContestProblemEntity).findOneBy({ id: problemId, contestId: id });
    if (!row) throw new NotFoundException();
    return await this.problems.lockProblemById(row.problemId, "Read", async problem => {
      if (!manager && (Date.now() < +contest.startTime || Date.now() >= +contest.endTime))
        throw new ForbiddenException("Contest is not running");
      if (!problem || !(await this.problems.getProblemJudgeInfo(problem))[1])
        throw new BadRequestException("Problem cannot be submitted");
      const payload = data.content as Partial<SubmissionContentTraditional> & {
        userProgram?: SubmissionContentTraditional;
      };
      const codeContent = payload?.language ? payload : payload?.userProgram;
      if (
        codeContent?.language &&
        !isContestLanguageAllowed(
          contest.languages,
          codeContent.language,
          codeContent.compileAndRunOptions as Record<string, unknown>
        )
      )
        throw new ForbiddenException("Language is not allowed in this contest");
      const errors = await this.submissions.validateSubmissionContent(problem, data.content);
      if (errors.length) throw new BadRequestException(errors);
      if (prepare) {
        if (!Number.isInteger(data.fileSize) || data.fileSize < 0) throw new BadRequestException();
        const result = await this.submissions.prepareSubmissionFileUpload(problem, data.fileSize);
        return typeof result === "string" ? { error: result } : { signedUploadRequest: result };
      }
      const [error, submission] = await this.submissions.createSubmission(
        user,
        problem,
        data.content,
        data.uploadInfo,
        {
          contestId: id,
          contestProblemId: row.id,
          contestInputFilename: row.inputFilename,
          contestOutputFilename: row.outputFilename,
          contestSubtaskAllOrNothing: row.subtaskAllOrNothing
        }
      );
      if (error) return typeof error === "string" ? { error } : { signedUploadRequest: error };
      return { submissionId: submission.id };
    });
  }

  async submissionList(user: UserEntity, id: number, page = 1, data: ContestRequestData = {}) {
    const { contest, manager } = await this.get(user, id, true);
    const ended = Date.now() >= +contest.endTime;
    const query = this.db.getRepository(SubmissionEntity).createQueryBuilder("s").where("s.contestId = :id", { id });
    if (!manager && !ended && contest.rule !== "acm")
      query.andWhere("s.submitterId = :userId", { userId: user?.id ?? -1 });
    if (data.userId && Number.isSafeInteger(data.userId))
      query.andWhere("s.submitterId = :filterUser", { filterUser: data.userId });
    if (data.problemId && Number.isSafeInteger(data.problemId))
      query.andWhere("s.contestProblemId = :filterProblem", { filterProblem: data.problemId });
    const [rows, total] = await query
      .orderBy("s.id", "DESC")
      .skip((page - 1) * 50)
      .take(50)
      .getManyAndCount();
    return {
      total,
      submissions: await Promise.all(
        rows.map(async s => {
          const submitter = await s.submitter;
          return { ...this.safeSubmission(s, contest, manager), username: submitter.username };
        })
      )
    };
  }

  private safeSubmission(s: SubmissionEntity, contest: ContestEntity, manager: boolean) {
    return contestSubmissionFeedback(s, contest.rule, Date.now() >= +contest.endTime, manager);
  }

  async submissionDetail(user: UserEntity, id: number, submissionId: number) {
    const { contest, manager } = await this.get(user, id, true);
    const s = await this.db.getRepository(SubmissionEntity).findOneBy({ id: submissionId, contestId: id });
    if (!s) throw new NotFoundException();
    const ended = Date.now() >= +contest.endTime;
    if (!manager && !ended && contest.rule !== "acm" && s.submitterId !== user?.id) throw new ForbiddenException();
    const detail = await this.submissions.getSubmissionDetail(s);
    // Full judge results contain filenames and checker output, which are never public contest metadata.
    const canCode = manager || user?.id === s.submitterId;
    const canResults = manager || ended || (contest.rule === "ioi" && canCode);
    const { result } = detail;
    const subtasks = canResults
      ? result?.subtasks?.map(st => ({
          score: st.score,
          fullScore: st.fullScore,
          testcases: st.testcases?.map(ref => {
            const tc = result.testcaseResult?.[ref.testcaseHash];
            return { status: tc?.status, score: tc?.score, timeUsed: tc?.time, memoryUsed: tc?.memory };
          })
        }))
      : undefined;
    return {
      submission: this.safeSubmission(s, contest, manager),
      content: canCode ? detail.content : null,
      compile: canCode && (manager || s.status === "CompilationError") ? result?.compile : undefined,
      subtasks
    };
  }

  async ranklist(user: UserEntity, id: number) {
    const { contest, manager } = await this.get(user, id, true);
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewContestScoreboard)))
      throw new ForbiddenException();
    if (
      !manager &&
      Date.now() < +contest.endTime &&
      contest.rule !== "acm" &&
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewHiddenContestScoreboard))
    )
      throw new ForbiddenException("Ranklist is hidden during this contest");
    const problems = await this.problemList(id);
    const submissions = await this.db
      .getRepository(SubmissionEntity)
      .createQueryBuilder("s")
      .where("s.contestId = :id", { id })
      .andWhere("s.submitTime >= :start AND s.submitTime < :end", { start: contest.startTime, end: contest.endTime })
      .getMany();
    const rows = scoreContest(contest.rule, contest.startTime, problems, submissions);
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
    await this.login(user, UserPrivilegeType.ExportContest);
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

  async rejudge(user: UserEntity, id: number, submissionId?: number) {
    if (
      !(await this.get(user, id)).manager ||
      !(await this.privileges.permissionDecision(user, UserPrivilegeType.RejudgeSubmission, true))
    )
      throw new ForbiddenException();
    const rows = await this.db
      .getRepository(SubmissionEntity)
      .findBy(submissionId ? { contestId: id, id: submissionId } : { contestId: id });
    // eslint-disable-next-line no-await-in-loop -- Keep transaction operations and permission checks in their existing order.
    for (const s of rows) await this.submissions.rejudgeSubmission(s);
    return { count: rows.length };
  }

  async summary(user: UserEntity, id: number, data?: ContestRequestData) {
    await this.login(user, UserPrivilegeType.ManageSummaries);
    await this.get(user, id, true);
    const repo = this.db.getRepository(ContestSummaryEntity);
    let row = await repo.findOneBy({ contestId: id, userId: user.id });
    if (data) {
      const ids = (await this.problemList(id)).map(p => p.id);
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
    await this.login(user, UserPrivilegeType.ManageSummaries);
    const [rows, total] = await this.db
      .getRepository(ContestSummaryEntity)
      .findAndCount({ where: { userId: user.id }, order: { updatedAt: "DESC" }, skip: (page - 1) * 30, take: 30 });
    return {
      total,
      summaries: await Promise.all(rows.map(async row => ({ ...row, title: (await row.contest).title })))
    };
  }

  async delete(user: UserEntity, id: number) {
    if (!(await this.get(user, id)).manager) throw new ForbiddenException();
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
