import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { Brackets, DataSource, EntityManager, MoreThan } from "typeorm";
import { v4 as uuid } from "uuid";
import { HackProgress, HackStatus, JudgeTaskType, SubmissionStatus } from "@libreoj/judge-protocol";

import { HackEntity, HackProblemEntity } from "./hack.entity";
import { HackRequestDto } from "./hack-request.dto";
import { validatorOptions } from "./validator-options";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { ProblemPermissionType, ProblemService } from "../problem/problem.service";
import { ProblemType } from "../problem/problem.entity";
import { ProblemFileType } from "../problem/problem-file.entity";
import { SubmissionService, SubmissionPermissionType } from "../submission/submission.service";
import { SubmissionEntity } from "../submission/submission.entity";
import { ContestService } from "../contest/contest.service";
import { ContestEntity } from "../contest/contest.entity";
import { JudgeQueueService, JudgeTask, JudgeTaskPriorityType } from "../judge/judge-queue.service";
import { JudgeTaskCompletion, JudgeTaskService } from "../judge/judge-task-service.interface";
import { LockService } from "../redis/lock.service";
import { teamResourceVisibilitySql } from "../team/team-access";
import { CodeLanguage } from "../code-language/code-language.type";
import { CodeLanguageService } from "../code-language/code-language.service";
import { FileService } from "../file/file.service";
import { SubmissionContentTraditional } from "../problem-type/types/traditional/submission-content.interface";
import { ProblemJudgeInfoTraditional } from "../problem-type/types/traditional/problem-judge-info.interface";

export function hackTargetFingerprint(submission: SubmissionEntity, content: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([submission.id, submission.submitTime, submission.status, submission.score, content]))
    .digest("hex");
}

interface HackSnapshot {
  judgeInfo: unknown;
  testData: Record<string, string>;
  target: unknown;
  reference: unknown;
  referenceFileIo?: ProblemJudgeInfoTraditional["fileIo"];
  validator: { language: string; code: string; compileAndRunOptions: unknown };
  targetResult?: HackTargetResult;
}

export interface HackTargetResult {
  executed: boolean;
  status?: SubmissionStatus;
  score?: number;
  timeUsed?: number;
  memoryUsed?: number;
}

/** Never return or retain program output, STD data, or private checker diagnostics. */
export function safeHackTargetResult(value: unknown): HackTargetResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.executed !== "boolean") return undefined;
  const result: HackTargetResult = { executed: source.executed };
  const statuses = [
    SubmissionStatus.Accepted,
    SubmissionStatus.WrongAnswer,
    SubmissionStatus.PartiallyCorrect,
    SubmissionStatus.FileError,
    SubmissionStatus.RuntimeError,
    SubmissionStatus.TimeLimitExceeded,
    SubmissionStatus.MemoryLimitExceeded,
    SubmissionStatus.OutputLimitExceeded
  ];
  if (source.executed && statuses.includes(source.status as SubmissionStatus)) {
    result.status = source.status as SubmissionStatus;
    if (typeof source.score === "number" && Number.isFinite(source.score) && source.score >= 0 && source.score <= 100)
      result.score = source.score;
  }
  if (source.executed) {
    for (const key of ["timeUsed", "memoryUsed"] as const) {
      const resource = source[key];
      if (typeof resource === "number" && Number.isFinite(resource) && resource >= 0)
        result[key] = Math.min(2147483647, Math.ceil(resource));
    }
  }
  return result;
}

// The judge task's lease ended before its result was stored: the result is discarded.
class ObsoleteResultError extends Error {}

@Injectable()
export class HackService implements JudgeTaskService<HackProgress, HackSnapshot & { inputData: string }> {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly privileges: UserPrivilegeService,
    private readonly problems: ProblemService,
    private readonly submissions: SubmissionService,
    private readonly contests: ContestService,
    private readonly queue: JudgeQueueService,
    private readonly locks: LockService,
    private readonly files: FileService,
    private readonly languages: CodeLanguageService
  ) {
    queue.registerTaskType(JudgeTaskType.Hack, this);
  }

  private async require(user: UserEntity, permission: UserPrivilegeType) {
    if (
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSite)) ||
      !(await this.privileges.userHasPrivilege(user, permission))
    )
      throw new ForbiddenException();
  }

  private id(value: number) {
    if (!Number.isSafeInteger(value) || value < 1) throw new BadRequestException("A valid ID is required");
  }

  private async canConfigure(user: UserEntity, problemId: number) {
    if (!user || !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSite))) return false;
    const problem = await this.problems.findProblemById(problemId);
    if (!problem || !(await this.problems.userHasPermission(user, problem, ProblemPermissionType.View))) return false;
    return await this.privileges.permissionDecision(
      user,
      UserPrivilegeType.ManageHack,
      await this.problems.userHasPermission(user, problem, ProblemPermissionType.Modify)
    );
  }

  async eligibility(user: UserEntity, submissionId: number) {
    this.id(submissionId);
    await this.require(user, UserPrivilegeType.ViewHack);
    await this.require(user, UserPrivilegeType.ViewSubmission);
    const submission = await this.submissions.findSubmissionById(submissionId);
    if (!submission) throw new NotFoundException();
    if (!(await this.submissions.userHasTeamResourceAccess(user, submission))) throw new ForbiddenException();
    let contestAccess: Awaited<ReturnType<ContestService["get"]>>;
    if (submission.contestId) {
      contestAccess = await this.contests.get(user, submission.contestId, true);
      await this.contests.submissionDetail(user, submission.contestId, submission.id);
    } else if (!(await this.submissions.userHasPermission(user, submission, SubmissionPermissionType.View)))
      throw new ForbiddenException();
    const canManageConfig = await this.canConfigure(user, submission.problemId);
    const answer = (reason?: string) => ({
      canHack: !reason,
      reason,
      problemId: submission.problemId,
      canManageConfig
    });
    if (!user || !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.CreateHack)))
      return answer("Hack permission is required");
    if (submission.contestId) {
      const { contest } = contestAccess;
      const access = await this.contests.hackAccess(user, contest);
      if (!access.allowed) return answer(access.reason || "The contest hack window is closed");
    }
    const problem = await this.problems.findProblemById(submission.problemId);
    if (!problem || problem.type !== ProblemType.Traditional)
      return answer("Only traditional code submissions support hacks");
    if (submission.taskId || submission.status === SubmissionStatus.Pending)
      return answer("Wait until the target has finished judging");
    if ([SubmissionStatus.Fake, SubmissionStatus.Hacked, SubmissionStatus.Canceled].includes(submission.status))
      return answer("The target has already been invalidated or canceled");
    if (
      [
        SubmissionStatus.CompilationError,
        SubmissionStatus.ConfigurationError,
        SubmissionStatus.SystemError,
        SubmissionStatus.JudgementFailed
      ].includes(submission.status)
    )
      return answer("This target has no runnable, reliably judged program; fix its compilation or judging error first");
    const config = await this.db.getRepository(HackProblemEntity).findOneBy({ problemId: submission.problemId });
    if (!config?.validatorCode?.trim())
      return answer("A problem manager must configure a trusted reference and input validator first");
    if (!config.standardContent) {
      const reference = await this.submissions.findSubmissionById(config.referenceSubmissionId);
      if (
        !reference ||
        reference.problemId !== submission.problemId ||
        reference.status !== SubmissionStatus.Accepted ||
        reference.taskId
      )
        return answer("The configured reference is no longer an accepted submission");
    }
    if (config.referenceSubmissionId === submission.id) return answer("The trusted reference cannot be hacked");
    return answer();
  }

  private async standardContent(config: HackProblemEntity): Promise<SubmissionContentTraditional> {
    if (config.standardContent) return config.standardContent as SubmissionContentTraditional;
    const reference = await this.submissions.findSubmissionById(config.referenceSubmissionId);
    if (
      !reference ||
      reference.status !== SubmissionStatus.Accepted ||
      reference.taskId ||
      reference.problemId !== config.problemId
    )
      throw new BadRequestException("The configured reference is no longer an accepted submission");
    return (await this.submissions.getSubmissionDetail(reference)).content as SubmissionContentTraditional;
  }

  private validateReferenceFileIo(value: unknown): ProblemJudgeInfoTraditional["fileIo"] | null {
    if (value == null) return null;
    const io = value as { inputFilename?: unknown; outputFilename?: unknown };
    const validName = (name: unknown) =>
      typeof name === "string" &&
      Buffer.byteLength(name, "utf8") <= 255 &&
      /^[\p{L}\p{N}_. -]+$/u.test(name) &&
      name !== "." &&
      !name.startsWith("..") &&
      name !== "hack-stderr";
    if (
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !validName(io.inputFilename) ||
      !validName(io.outputFilename) ||
      io.inputFilename === io.outputFilename
    )
      throw new BadRequestException("STD file I/O requires two distinct safe filenames");
    return { inputFilename: io.inputFilename as string, outputFilename: io.outputFilename as string };
  }

  private async submissionReferenceFileIo(
    submission: SubmissionEntity
  ): Promise<ProblemJudgeInfoTraditional["fileIo"] | null> {
    if (submission.contestId)
      return this.validateReferenceFileIo(
        submission.contestInputFilename
          ? { inputFilename: submission.contestInputFilename, outputFilename: submission.contestOutputFilename }
          : null
      );
    const problem = await this.problems.findProblemById(submission.problemId);
    const [raw] = await this.problems.getProblemJudgeInfo(problem);
    return this.validateReferenceFileIo((raw as ProblemJudgeInfoTraditional).fileIo);
  }

  private async referenceFileIo(config: HackProblemEntity): Promise<ProblemJudgeInfoTraditional["fileIo"] | null> {
    const content = config.standardContent as { fileIo?: unknown };
    if (content && Object.prototype.hasOwnProperty.call(content, "fileIo"))
      return this.validateReferenceFileIo(content.fileIo);
    if (config.referenceSubmissionId) {
      const source = await this.submissions.findSubmissionById(config.referenceSubmissionId);
      if (source) return await this.submissionReferenceFileIo(source);
    }
    // Older stored STD copies used formal problem I/O. Preserve that choice until the manager saves a new profile.
    const problem = await this.problems.findProblemById(config.problemId);
    const [raw] = await this.problems.getProblemJudgeInfo(problem);
    return this.validateReferenceFileIo((raw as ProblemJudgeInfoTraditional).fileIo);
  }

  private async formalValidator(problemId: number) {
    const problem = await this.problems.findProblemById(problemId);
    const [raw] = await this.problems.getProblemJudgeInfo(problem);
    const profile = (raw as ProblemJudgeInfoTraditional).selfEval;
    const testData = await this.problems.getProblemFiles(problem, ProblemFileType.TestData);
    const source = testData.find(file => file.filename === (profile?.validatorFile || "validator.cpp"));
    if (!source) return null;
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "llmoj-hack-validator-"));
    try {
      const destination = path.join(directory, "validator.cpp");
      await this.files.downloadFileToPath(source.uuid, destination, 1048576);
      const buffer = await fs.promises.readFile(destination);
      if (profile?.validatorSha256 && createHash("sha256").update(buffer).digest("hex") !== profile.validatorSha256)
        throw new BadRequestException("The formal input validator changed; update its data profile first");
      return { code: buffer.toString("utf8"), language: CodeLanguage.Cpp };
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }

  async config(user: UserEntity, problemId: number) {
    this.id(problemId);
    if (!(await this.canConfigure(user, problemId))) throw new ForbiddenException();
    const value = await this.db.getRepository(HackProblemEntity).findOneBy({ problemId });
    const standard = value ? await this.standardContent(value).catch(() => null) : null;
    const validator = !value?.validatorCode ? await this.formalValidator(problemId) : null;
    return {
      referenceSubmissionId: value?.referenceSubmissionId || undefined,
      standardCode: standard?.code || "",
      standardLanguage: standard?.language || "cpp",
      standardCompileAndRunOptions: standard?.compileAndRunOptions || validatorOptions.cpp,
      standardFileIo: value ? await this.referenceFileIo(value) : null,
      validatorLanguage: value?.validatorLanguage || validator?.language || "cpp",
      validatorCode: value?.validatorCode || validator?.code || "",
      canManage: true
    };
  }

  async saveConfig(user: UserEntity, request: HackRequestDto) {
    this.id(request.problemId);
    if (!(await this.canConfigure(user, request.problemId))) throw new ForbiddenException();
    const problem = await this.problems.findProblemById(request.problemId);
    if (problem.type !== ProblemType.Traditional)
      throw new BadRequestException("Only traditional code problems support hacks");
    if (!request.standardCode?.trim() || Buffer.byteLength(request.standardCode) > 1048576)
      throw new BadRequestException("A trusted standard program is required (maximum 1 MiB)");
    if (!Object.values(CodeLanguage).includes(request.standardLanguage as CodeLanguage))
      throw new BadRequestException("Unknown standard program language");
    const fileIo = this.validateReferenceFileIo(request.standardFileIo);
    const options = request.standardCompileAndRunOptions || validatorOptions[request.standardLanguage as CodeLanguage];
    if (this.languages.validateCompileAndRunOptions(request.standardLanguage as CodeLanguage, options).length)
      throw new BadRequestException("Invalid standard program compilation options");
    const formal = request.validatorCode?.trim() ? null : await this.formalValidator(request.problemId);
    const validatorCode = request.validatorCode?.trim() ? request.validatorCode : formal?.code;
    const validatorLanguage = request.validatorCode?.trim() ? request.validatorLanguage : formal?.language;
    if (!validatorCode?.trim() || Buffer.byteLength(validatorCode) > 1048576)
      throw new BadRequestException("A sandboxed input validator is required (maximum 1 MiB)");
    if (!Object.values(CodeLanguage).includes(validatorLanguage as CodeLanguage))
      throw new BadRequestException("Unknown validator language");
    await this.db.getRepository(HackProblemEntity).save({
      problemId: request.problemId,
      referenceSubmissionId: 0,
      standardContent: {
        language: request.standardLanguage,
        code: request.standardCode,
        compileAndRunOptions: options,
        fileIo
      },
      validatorLanguage,
      validatorCode,
      configuredById: user.id,
      updateTime: new Date()
    });
    return { ok: true };
  }

  async useSubmissionReference(user: UserEntity, submissionId: number) {
    this.id(submissionId);
    await this.require(user, UserPrivilegeType.ViewSubmission);
    const submission = await this.submissions.findSubmissionById(submissionId);
    if (!submission) throw new NotFoundException();
    if (
      !(await this.canConfigure(user, submission.problemId)) ||
      !(await this.submissions.userHasPermission(user, submission, SubmissionPermissionType.View))
    )
      throw new ForbiddenException();
    if (submission.status !== SubmissionStatus.Accepted || submission.taskId)
      throw new BadRequestException("Only a finished accepted submission can be used as the trusted standard program");
    const content = (await this.submissions.getSubmissionDetail(submission)).content as SubmissionContentTraditional;
    const problem = await this.problems.findProblemById(submission.problemId);
    if (
      problem.type !== ProblemType.Traditional ||
      !content?.code ||
      !Object.values(CodeLanguage).includes(content.language)
    )
      throw new BadRequestException("Only traditional code submissions can be used as the trusted standard program");
    const existing = await this.db.getRepository(HackProblemEntity).findOneBy({ problemId: submission.problemId });
    const validator = existing?.validatorCode ? null : await this.formalValidator(submission.problemId);
    await this.db.getRepository(HackProblemEntity).save({
      problemId: submission.problemId,
      referenceSubmissionId: submission.id,
      standardContent: {
        language: content.language,
        code: content.code,
        compileAndRunOptions: content.compileAndRunOptions,
        fileIo: await this.submissionReferenceFileIo(submission)
      },
      validatorLanguage: existing?.validatorLanguage || validator?.language || "cpp",
      validatorCode: existing?.validatorCode || validator?.code || "",
      configuredById: user.id,
      updateTime: new Date()
    });
    return {
      ok: true,
      problemId: submission.problemId,
      validatorRequired: !existing?.validatorCode && !validator?.code
    };
  }

  async create(user: UserEntity, request: HackRequestDto) {
    const access = await this.eligibility(user, request.submissionId);
    if (!access.canHack) throw new BadRequestException(access.reason);
    if (typeof request.inputData !== "string" || Buffer.byteLength(request.inputData) > 1048576)
      throw new BadRequestException("Hack input must be at most 1 MiB");
    // Serialize quotas per user. Waiting and running tasks together are capped at three.
    return await this.locks.lock(`HackCreate_${user.id}`, async () => {
      const repository = this.db.getRepository(HackEntity);
      const recent = await repository.countBy({
        hackerId: user.id,
        createTime: MoreThan(new Date(Date.now() - 3600000))
      });
      const pending = await repository
        .createQueryBuilder("h")
        .where("h.hackerId = :id AND h.taskId IS NOT NULL", { id: user.id })
        .getCount();
      if (recent >= 30 || pending >= 3)
        throw new BadRequestException("Hack quota exceeded (three active tasks, thirty per hour)");
      const target = await this.submissions.findSubmissionById(request.submissionId);
      return await this.submissions.lockSubmission(target, true, async locked => {
        const fresh = await this.eligibility(user, request.submissionId);
        if (!locked || !fresh.canHack) throw new BadRequestException(fresh.reason || "Target unavailable");
        const config = await this.db.getRepository(HackProblemEntity).findOneBy({ problemId: locked.problemId });
        const targetDetail = await this.submissions.getSubmissionDetail(locked);
        const reference = await this.standardContent(config);
        const problem = await this.problems.findProblemById(locked.problemId);
        const [base] = await this.problems.getProblemPreprocessedJudgeInfo(problem);
        const judgeInfo = {
          ...base,
          ...(locked.contestId
            ? {
                fileIo: locked.contestInputFilename
                  ? { inputFilename: locked.contestInputFilename, outputFilename: locked.contestOutputFilename }
                  : null
              }
            : {})
        };
        const testData = Object.fromEntries(
          (await this.problems.getProblemFiles(problem, ProblemFileType.TestData)).map(file => [
            file.filename,
            file.uuid
          ])
        );
        const hack = await repository.save(
          repository.create({
            submissionId: locked.id,
            problemId: locked.problemId,
            contestId: locked.contestId,
            contestProblemId: locked.contestProblemId,
            submitterId: locked.submitterId,
            hackerId: user.id,
            inputData: request.inputData,
            taskId: uuid(),
            status: HackStatus.Pending,
            createTime: new Date(),
            targetFingerprint: hackTargetFingerprint(locked, targetDetail.content),
            snapshot: {
              judgeInfo,
              testData,
              target: targetDetail.content,
              reference,
              referenceFileIo: await this.referenceFileIo(config),
              validator: {
                language: config.validatorLanguage,
                code: config.validatorCode,
                compileAndRunOptions: validatorOptions[config.validatorLanguage as CodeLanguage]
              }
            }
          })
        );
        try {
          await this.queue.enqueue(hack.taskId, JudgeTaskType.Hack, JudgeTaskPriorityType.Low + hack.id / 1e9);
        } catch (error) {
          await repository.update(hack.id, {
            taskId: null,
            status: HackStatus.SystemError,
            message: "Could not enqueue hack; a manager can retry"
          });
          throw error;
        }
        return { id: hack.id };
      });
    });
  }

  private async canView(user: UserEntity, hack: HackEntity) {
    if (
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSite)) ||
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewHack)) ||
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSubmission))
    )
      return false;
    const target = await this.submissions.findSubmissionById(hack.submissionId);
    if (!target) return !!user?.isAdmin;
    if (!(await this.submissions.userHasTeamResourceAccess(user, target))) return false;
    if (target.contestId) {
      try {
        const { contest, manager } = await this.contests.get(user, target.contestId, true);
        if (!manager && Date.now() < +contest.endTime && contest.rule !== "acm" && target.submitterId !== user?.id)
          return false;
        return true;
      } catch {
        return false;
      }
    }
    return await this.submissions.userHasPermission(user, target, SubmissionPermissionType.View);
  }

  private async meta(hack: HackEntity) {
    const ids = [...new Set([hack.submitterId, hack.hackerId])];
    const users = await this.db.getRepository(UserEntity).findByIds(ids);
    const user = (id: number) => ({ id, username: users.find(value => value.id === id)?.username || "Deleted user" });
    return {
      id: hack.id,
      status: hack.status,
      submissionId: hack.submissionId,
      problemId: hack.problemId,
      contestId: hack.contestId,
      contestProblemId: hack.contestProblemId,
      submitter: user(hack.submitterId),
      hacker: user(hack.hackerId),
      timeUsed: hack.timeUsed,
      memoryUsed: hack.memoryUsed,
      createTime: hack.createTime,
      finishTime: hack.finishTime
    };
  }

  async list(user: UserEntity, request: HackRequestDto) {
    await this.require(user, UserPrivilegeType.ViewHack);
    await this.require(user, UserPrivilegeType.ViewSubmission);
    const query = this.db
      .getRepository(HackEntity)
      .createQueryBuilder("h")
      .where(
        new Brackets(q =>
          q
            .where(`h.contestId IS NULL AND ${teamResourceVisibilitySql("problem", "h.problemId", user)}`)
            .orWhere(`h.contestId IS NOT NULL AND ${teamResourceVisibilitySql("contest", "h.contestId", user)}`)
        )
      );
    for (const key of ["contestId", "problemId", "submissionId", "hackerId"] as const) {
      if (request[key]) query.andWhere(`h.${key} = :${key}`, { [key]: Number(request[key]) });
    }
    if (request.mine === true || request.mine === "true") {
      if (!user) throw new ForbiddenException();
      query.andWhere("h.hackerId = :mine", { mine: user.id });
    }
    if (request.hacker?.trim()) {
      query.innerJoin(UserEntity, "hacker", "hacker.id = h.hackerId AND hacker.username = :hacker", {
        hacker: request.hacker.trim()
      });
    }
    if (request.status) {
      if (!Object.values(HackStatus).includes(request.status as HackStatus))
        throw new BadRequestException("Unknown hack status");
      query.andWhere("h.status = :status", { status: request.status });
    }
    const page = Number(request.page) || 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new BadRequestException("Invalid page");
    // Authorize distinct targets before pagination and counting, without loading inputs/snapshots.
    const targets = await query
      .clone()
      .select("h.submissionId", "submissionId")
      .distinct(true)
      .getRawMany<{ submissionId: number }>();
    const allowed: number[] = [];
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop
      if (await this.canView(user, { submissionId: Number(target.submissionId) } as HackEntity))
        allowed.push(Number(target.submissionId));
    }
    if (!allowed.length) return { hacks: [], total: 0, pageSize: 30 };
    query.andWhere("h.submissionId IN (:...allowedTargets)", { allowedTargets: allowed });
    const [records, total] = await query
      .orderBy("h.id", "DESC")
      .skip((page - 1) * 30)
      .take(30)
      .getManyAndCount();
    return { hacks: await Promise.all(records.map(hack => this.meta(hack))), total, pageSize: 30 };
  }

  async get(user: UserEntity, id: number) {
    this.id(id);
    const hack = await this.db.getRepository(HackEntity).findOneBy({ id });
    if (!hack) throw new NotFoundException();
    if (!(await this.canView(user, hack))) throw new ForbiddenException();
    const canManage = await this.canConfigure(user, hack.problemId);
    // Input/message remain private during a blind contest, including the opposing submitter.
    const contest = hack.contestId
      ? await this.db.getRepository(ContestEntity).findOneBy({ id: hack.contestId })
      : null;
    const conceal =
      contest &&
      Date.now() < +contest.endTime &&
      ["noi", "strictioi"].includes(contest.rule) &&
      !canManage &&
      user?.id !== hack.hackerId;
    const snapshot = hack.snapshot as HackSnapshot;
    const judgeInfo = snapshot?.judgeInfo as { timeLimit?: unknown; memoryLimit?: unknown };
    const positiveLimit = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
    return {
      ...(await this.meta(hack)),
      inputData: conceal ? undefined : hack.inputData,
      message: conceal ? undefined : hack.message,
      testcaseResult: conceal ? undefined : safeHackTargetResult(snapshot?.targetResult),
      testcaseInfo: conceal
        ? undefined
        : {
            timeLimit: positiveLimit(judgeInfo?.timeLimit),
            memoryLimit: positiveLimit(judgeInfo?.memoryLimit)
          },
      canManage
    };
  }

  async rejudge(user: UserEntity, id: number) {
    this.id(id);
    const hack = await this.db.getRepository(HackEntity).findOneBy({ id });
    if (!hack) throw new NotFoundException();
    if (!(await this.canConfigure(user, hack.problemId))) throw new ForbiddenException();
    return await this.locks.lock(`Hack_${id}`, async () => {
      const fresh = await this.db.getRepository(HackEntity).findOneBy({ id });
      if (fresh.taskId || fresh.status === HackStatus.Success)
        throw new BadRequestException("A running or successful hack cannot be retried");
      fresh.taskId = uuid();
      fresh.status = HackStatus.Pending;
      fresh.message = null;
      fresh.finishTime = null;
      fresh.timeUsed = null;
      fresh.memoryUsed = null;
      const snapshot = { ...(fresh.snapshot as HackSnapshot) };
      delete snapshot.targetResult;
      fresh.snapshot = snapshot;
      await this.db.getRepository(HackEntity).save(fresh);
      await this.queue.enqueue(fresh.taskId, JudgeTaskType.Hack, JudgeTaskPriorityType.Low + fresh.id / 1e9);
      return { ok: true };
    });
  }

  async getTaskToBeSentToJudgeByTaskId(taskId: string, priority: number) {
    const hack = await this.db.getRepository(HackEntity).findOneBy({ taskId });
    if (!hack) return null;
    if (!(await this.taskAuthorised(hack))) {
      await this.db.getRepository(HackEntity).update(hack.id, {
        taskId: null,
        status: HackStatus.Canceled,
        message: "Hack access or the trusted judging configuration changed",
        finishTime: new Date()
      });
      return null;
    }
    return new JudgeTask(taskId, JudgeTaskType.Hack, JudgeTaskPriorityType.Low, priority, {
      ...(hack.snapshot as HackSnapshot),
      inputData: hack.inputData
    });
  }

  private async taskAuthorised(hack: HackEntity) {
    const user = await this.db.getRepository(UserEntity).findOneBy({ id: hack.hackerId });
    if (!user) return false;
    for (const privilege of [
      UserPrivilegeType.ViewSite,
      UserPrivilegeType.ViewHack,
      UserPrivilegeType.CreateHack,
      UserPrivilegeType.ViewSubmission
    ]) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await this.privileges.userHasPrivilege(user, privilege))) return false;
    }
    const target = await this.submissions.findSubmissionById(hack.submissionId);
    if (!target || !(await this.submissions.userHasTeamResourceAccess(user, target))) return false;
    try {
      if (target.contestId) await this.contests.submissionDetail(user, target.contestId, target.id);
      else if (!(await this.submissions.userHasPermission(user, target, SubmissionPermissionType.View))) return false;
    } catch {
      return false;
    }
    const config = await this.db.getRepository(HackProblemEntity).findOneBy({ problemId: hack.problemId });
    const snapshot = hack.snapshot as HackSnapshot;
    if (
      !config ||
      config.validatorCode !== snapshot.validator.code ||
      config.validatorLanguage !== snapshot.validator.language
    )
      return false;
    try {
      return (
        JSON.stringify(await this.standardContent(config)) === JSON.stringify(snapshot.reference) &&
        (snapshot.referenceFileIo === undefined ||
          JSON.stringify(await this.referenceFileIo(config)) === JSON.stringify(snapshot.referenceFileIo))
      );
    } catch {
      return false;
    }
  }

  async listActiveTasks() {
    const hacks = await this.db
      .getRepository(HackEntity)
      .createQueryBuilder("h")
      .select(["h.id", "h.taskId"])
      .where("h.taskId IS NOT NULL")
      .getMany();
    return hacks.map(hack => ({ taskId: hack.taskId, priority: JudgeTaskPriorityType.Low + hack.id / 1e9 }));
  }

  async onTaskFailed(taskId: string, message: string) {
    const hack = await this.db.getRepository(HackEntity).findOneBy({ taskId });
    if (!hack) return;
    await this.locks.lock(`Hack_${hack.id}`, async () => {
      await this.db
        .getRepository(HackEntity)
        .update(
          { id: hack.id, taskId },
          { taskId: null, status: HackStatus.SystemError, message: message.slice(0, 4096), finishTime: new Date() }
        );
    });
  }

  async onTaskProgress(taskId: string, progress: HackProgress, completion?: JudgeTaskCompletion) {
    if (!progress || typeof progress.finished !== "boolean" || !Object.values(HackStatus).includes(progress.status))
      return false;
    const hack = await this.db.getRepository(HackEntity).findOneBy({ taskId });
    if (!hack) return false;
    return await this.locks.lock(`Hack_${hack.id}`, async () => {
      const fresh = await this.db.getRepository(HackEntity).findOneBy({ id: hack.id });
      if (!fresh || fresh.taskId !== taskId) return false;
      if (!progress.finished) {
        if (progress.status !== HackStatus.Running) return false;
        await this.db.getRepository(HackEntity).update(fresh.id, { status: HackStatus.Running });
        return true;
      }
      if ([HackStatus.Pending, HackStatus.Running].includes(progress.status)) return false;
      if (!(await this.taskAuthorised(fresh))) {
        await this.db.getRepository(HackEntity).update(fresh.id, {
          taskId: null,
          status: HackStatus.Canceled,
          message: "Hack access or the trusted judging configuration changed",
          finishTime: new Date()
        });
        return false;
      }
      fresh.status = progress.status;
      fresh.taskId = null;
      fresh.finishTime = new Date();
      fresh.message = typeof progress.message === "string" ? progress.message.slice(0, 4096) : null;
      fresh.timeUsed =
        Number.isFinite(progress.timeUsed) && progress.timeUsed >= 0
          ? Math.min(2147483647, Math.ceil(progress.timeUsed))
          : null;
      fresh.memoryUsed =
        Number.isFinite(progress.memoryUsed) && progress.memoryUsed >= 0
          ? Math.min(2147483647, Math.ceil(progress.memoryUsed))
          : null;
      fresh.snapshot = {
        ...(fresh.snapshot as HackSnapshot),
        targetResult: safeHackTargetResult({
          executed: progress.targetExecuted,
          status: progress.targetStatus,
          score: progress.targetScore,
          timeUsed: fresh.timeUsed,
          memoryUsed: fresh.memoryUsed
        })
      };
      // The judge task's job is finished in the transaction that stores the result, unless its lease is obsolete
      const saveResult = async (manager: EntityManager) => {
        if (completion && !(await completion.confirm(manager))) throw new ObsoleteResultError();
        await manager.save(fresh);
      };
      try {
        if (progress.status === HackStatus.Success) {
          const target = await this.submissions.findSubmissionById(fresh.submissionId);
          const applied =
            target &&
            (await this.submissions.markSubmissionHacked(
              target,
              fresh.hackerId,
              fresh.id,
              fresh.targetFingerprint,
              saveResult
            ));
          if (applied) return true;
          fresh.status = HackStatus.Canceled;
          fresh.message = "Target changed or was invalidated while the hack was running";
        }
        await this.db.transaction("READ COMMITTED", saveResult);
      } catch (e) {
        if (!(e instanceof ObsoleteResultError)) throw e;
        return false;
      }
      return true;
    });
  }
}
