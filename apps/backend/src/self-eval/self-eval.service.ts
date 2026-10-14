import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";
import { v4 as uuid } from "uuid";
import { JudgeTaskType, SelfEvalProgress, SubmissionStatus } from "@libreoj/judge-protocol";

import { SelfEvalEntity, SelfEvalQuotaEntity, SelfEvalSetEntity } from "./self-eval.entity";
import { SelfEvalRequestDto } from "./self-eval-request.dto";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { ProblemService, ProblemPermissionType } from "../problem/problem.service";
import { ProblemType } from "../problem/problem.entity";
import { ProblemFileType } from "../problem/problem-file.entity";
import { ProblemJudgeInfoTraditional } from "../problem-type/types/traditional/problem-judge-info.interface";
import { SubmissionService } from "../submission/submission.service";
import { ContestService } from "../contest/contest.service";
import { ContestProblemEntity } from "../contest/contest-problem.entity";
import { ContestEntity } from "../contest/contest.entity";
import { isContestLanguageAllowed } from "../contest/contest-languages";
import { FileService } from "../file/file.service";
import { CodeLanguage } from "../code-language/code-language.type";
import { CodeLanguageService } from "../code-language/code-language.service";
import { JudgeQueueService, JudgeTask, JudgeTaskPriorityType } from "../judge/judge-queue.service";
import { JudgeTaskService } from "../judge/judge-task-service.interface";
import { LockService } from "../redis/lock.service";

const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
interface SelfEvalSnapshot {
  judgeInfo: ProblemJudgeInfoTraditional;
  testData: Record<string, string>;
  scope: string;
}

@Injectable()
export class SelfEvalService implements JudgeTaskService<SelfEvalProgress, Record<string, unknown>> {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly privileges: UserPrivilegeService,
    private readonly problems: ProblemService,
    private readonly submissions: SubmissionService,
    private readonly contests: ContestService,
    private readonly files: FileService,
    private readonly queue: JudgeQueueService,
    private readonly locks: LockService
  ) {
    queue.registerTaskType(JudgeTaskType.SelfEval, this);
    queue.registerTaskType(JudgeTaskType.SelfEvalPrepare, this);
  }

  private async context(
    user: UserEntity,
    request: Pick<SelfEvalRequestDto, "problemId" | "contestId">,
    creating = false
  ) {
    if (!Number.isSafeInteger(request.problemId) || request.problemId < 1)
      throw new BadRequestException("A valid problem ID is required");
    if (!user || !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSite)))
      throw new ForbiddenException();
    if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewProblem))) throw new ForbiddenException();
    const problem = await this.problems.findProblemById(request.problemId);
    if (!problem || problem.type !== ProblemType.Traditional)
      throw new BadRequestException("Self evaluation requires a traditional problem");
    if (!Number.isSafeInteger(request.contestId) || request.contestId < 1)
      throw new BadRequestException("Self evaluation is available only in enabled NOI contests");
    const access = await this.contests.get(user, request.contestId, true);
    const options = access.contest.ruleOptions || {};
    if (access.contest.rule !== "noi" || options.selfEvalEnabled !== true)
      throw new BadRequestException("Self evaluation is available only in enabled NOI contests");
    const contestProblem = await this.db
      .getRepository(ContestProblemEntity)
      .findOneBy({ contestId: request.contestId, problemId: problem.id });
    if (!contestProblem) throw new ForbiddenException();
    const { languages } = access.contest;
    const { manager } = access;
    const enabled = true;
    const limit = Number(options.selfEvalMaxAttempts) || 30;
    const active = Date.now() >= +access.contest.startTime && Date.now() < +access.contest.endTime;
    const canPrepare = Date.now() < +access.contest.startTime;
    if (!manager && !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ParticipateContest)))
      throw new ForbiddenException();
    if (creating && (!enabled || !active))
      throw new BadRequestException("Self evaluation is disabled or outside the contest period");
    if (
      creating &&
      (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.CreateSelfEval)) ||
        !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.SubmitProblem)))
    )
      throw new ForbiddenException();
    const [raw] = await this.problems.getProblemPreprocessedJudgeInfo(problem);
    const judgeInfo = {
      ...(raw as ProblemJudgeInfoTraditional),
      ...(contestProblem
        ? {
            fileIo: contestProblem.inputFilename
              ? { inputFilename: contestProblem.inputFilename, outputFilename: contestProblem.outputFilename }
              : null,
            ...(contestProblem.subtaskAllOrNothing
              ? {
                  subtasks: (raw as ProblemJudgeInfoTraditional).subtasks.map(subtask => ({
                    ...subtask,
                    scoringType: "GroupMin",
                    allOrNothing: true
                  }))
                }
              : {})
          }
        : {})
    } as ProblemJudgeInfoTraditional;
    const scope = `contest:${request.contestId}:problem:${problem.id}`;
    const quotaScope = `contest:${request.contestId}`;
    const testData = Object.fromEntries(
      (await this.problems.getProblemFiles(problem, ProblemFileType.TestData)).map(file => [file.filename, file.uuid])
    );
    return {
      problem,
      manager,
      enabled,
      active,
      canPrepare,
      limit,
      scope,
      quotaScope,
      judgeInfo,
      testData,
      recipeHash: hash(judgeInfo.selfEval),
      configHash: hash(judgeInfo),
      languages
    };
  }

  async info(user: UserEntity, request: SelfEvalRequestDto) {
    const ctx = await this.context(user, request);
    const set = await this.db.getRepository(SelfEvalSetEntity).findOneBy({ scope: ctx.scope });
    const quota = await this.db
      .getRepository(SelfEvalQuotaEntity)
      .findOneBy({ scope: ctx.quotaScope, userId: user.id });
    const canManage =
      ctx.manager &&
      ctx.canPrepare &&
      (await this.problems.userHasPermission(user, ctx.problem, ProblemPermissionType.Modify)) &&
      (await this.privileges.userHasPrivilege(user, UserPrivilegeType.EditProblemData));
    const reason = !ctx.enabled
      ? "Self evaluation is disabled for this contest"
      : !ctx.active
      ? "Self evaluation is outside the contest period"
      : !ctx.judgeInfo.selfEval
      ? "A manager must configure the formal make.cpp and std.cpp programs before the contest"
      : set && (set.recipeHash !== ctx.recipeHash || set.configHash !== ctx.configHash)
      ? "The prepared set no longer matches this problem configuration; a manager must prepare it again before the contest"
      : undefined;
    return {
      enabled: ctx.enabled && ctx.active && !reason,
      reason,
      limit: ctx.limit,
      used: quota?.used || 0,
      remaining: Math.max(0, ctx.limit - (quota?.used || 0)),
      setStatus: set?.status || "Missing",
      languages: ctx.languages,
      canManage,
      ...(canManage
        ? {
            profile: ctx.judgeInfo.selfEval,
            programs: await this.profilePrograms(ctx),
            subtaskIds: ctx.judgeInfo.subtasks.map((_, i) => i + 1)
          }
        : {})
    };
  }

  private async profilePrograms(ctx: Awaited<ReturnType<SelfEvalService["context"]>>) {
    const profile = ctx.judgeInfo.selfEval;
    if (!profile) return {};
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "llmoj-self-eval-sources-"));
    try {
      const sources = await Promise.all(
        [profile.generatorFile, profile.standardFile].map(async (name, index) => {
          if (!ctx.testData[name]) return "";
          const destination = path.join(directory, String(index));
          await this.files.downloadFileToPath(ctx.testData[name], destination, 1048576);
          return await fs.promises.readFile(destination, "utf8");
        })
      );
      return { generatorCode: sources[0], standardCode: sources[1] };
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }

  async configureProfile(user: UserEntity, request: SelfEvalRequestDto) {
    const ctx = await this.context(user, request);
    if (
      !ctx.manager ||
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.EditProblemData)) ||
      !(await this.problems.userHasPermission(user, ctx.problem, ProblemPermissionType.Modify))
    )
      throw new ForbiddenException();
    if (!ctx.canPrepare) throw new BadRequestException("Configure self evaluation before the contest starts");
    if (request.attestSameGenerator !== true)
      throw new BadRequestException("Confirm that these exact programs produced the current formal data");
    const programs = [request.generatorCode, request.standardCode];
    if (programs.some(source => typeof source !== "string" || !source.trim() || Buffer.byteLength(source) > 1048576))
      throw new BadRequestException("Provide make.cpp and std.cpp source code (maximum 1 MiB each)");
    if (
      !request.subtaskIds?.length ||
      request.subtaskIds.length > 20 ||
      new Set(request.subtaskIds).size !== request.subtaskIds.length ||
      request.subtaskIds.some(id => !Number.isSafeInteger(id) || id < 1 || id > ctx.judgeInfo.subtasks.length)
    )
      throw new BadRequestException("Select valid subtask IDs (maximum twenty)");
    const hashes = programs.map(source => createHash("sha256").update(source).digest("hex"));
    const names = hashes.map((digest, index) => `self-eval-${digest}-${index === 0 ? "make" : "std"}.cpp`);
    await this.locks.lock(`SelfEvalProfile_${ctx.problem.id}`, async () => {
      const fresh = await this.context(user, request);
      if (
        !fresh.manager ||
        !fresh.canPrepare ||
        !(await this.problems.userHasPermission(user, fresh.problem, ProblemPermissionType.Modify)) ||
        !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.EditProblemData))
      )
        throw new ForbiddenException();
      for (let index = 0; index < programs.length; index++) {
        if (fresh.testData[names[index]]) continue;
        const fileId = uuid();
        // eslint-disable-next-line no-await-in-loop -- Publish both immutable source files before activating the profile.
        await this.files.uploadFile(fileId, Buffer.from(programs[index]));
        // addProblemFile acquires the problem read lock itself; do not call it under a write lock.
        // eslint-disable-next-line no-await-in-loop -- Each source must be registered before the recipe references it.
        const error = await this.problems.addProblemFile(
          fresh.problem,
          ProblemFileType.TestData,
          { uuid: fileId, size: Buffer.byteLength(programs[index]) },
          names[index],
          false,
          user
        );
        if (error) {
          // eslint-disable-next-line no-await-in-loop -- Remove the failed upload before rejecting the binding.
          await this.files.deleteUnfinishedUploadedFile(fileId);
          throw new BadRequestException("Could not save the self-evaluation source file");
        }
      }
      await this.problems.lockProblemById(ctx.problem.id, "Write", async problem => {
        const latest = await this.context(user, request);
        if (
          !latest.manager ||
          !latest.canPrepare ||
          !(await this.problems.userHasPermission(user, problem, ProblemPermissionType.Modify)) ||
          !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.EditProblemData))
        )
          throw new ForbiddenException();
        const [raw, submittable] = await this.problems.getProblemJudgeInfo(problem);
        const current = raw as ProblemJudgeInfoTraditional;
        const previous = current.selfEval;
        current.selfEval = {
          generatorFile: names[0],
          standardFile: names[1],
          generatorSha256: hashes[0],
          standardSha256: hashes[1],
          subtaskIds: request.subtaskIds,
          ...(previous?.validatorFile && previous.validatorSha256
            ? {
                validatorFile: previous.validatorFile,
                validatorSha256: previous.validatorSha256
              }
            : {}),
          ...(request.standardFileIo ? { standardFileIo: request.standardFileIo } : {})
        };
        const errors = await this.problems.updateProblemJudgeInfo(
          problem,
          current,
          submittable,
          false,
          async (manager, currentProblem) => {
            if (
              !currentProblem ||
              !(await this.problems.userHasPermission(
                user,
                currentProblem,
                ProblemPermissionType.Modify,
                undefined,
                manager
              )) ||
              !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.EditProblemData, manager))
            )
              throw new ForbiddenException();
          }
        );
        if (errors?.length) throw new BadRequestException(errors);
      });
    });
    return { ok: true };
  }

  private async prepareContext(
    ctx: Awaited<ReturnType<SelfEvalService["context"]>>,
    user: UserEntity,
    explicit: boolean
  ) {
    if (!ctx.judgeInfo.selfEval) throw new BadRequestException("No formal-data generator profile is configured");
    if (ctx.judgeInfo.selfEval.subtaskIds.length > 20)
      throw new BadRequestException("Self evaluation supports at most twenty subtasks");
    return await this.locks.lock(`SelfEvalSet_${ctx.scope}`, async () => {
      const repository = this.db.getRepository(SelfEvalSetEntity);
      const previous = await repository.findOneBy({ scope: ctx.scope });
      if (
        previous &&
        previous.recipeHash === ctx.recipeHash &&
        previous.configHash === ctx.configHash &&
        ["Pending", "Ready"].includes(previous.status)
      )
        return { ok: true };
      if (previous && !explicit)
        throw new BadRequestException("A manager must prepare the updated fixed prediction set");
      if (previous && (await this.db.getRepository(SelfEvalEntity).countBy({ scope: ctx.scope })))
        throw new BadRequestException("A used prediction set cannot be replaced");
      const set = repository.create({
        scope: ctx.scope,
        problemId: ctx.problem.id,
        contestId: ctx.scope.startsWith("contest:") ? Number(ctx.scope.split(":")[1]) : null,
        recipeHash: ctx.recipeHash,
        configHash: ctx.configHash,
        status: "Pending",
        cases: null,
        message: null,
        taskId: uuid(),
        createdAt: new Date(),
        snapshot: { judgeInfo: ctx.judgeInfo, testData: ctx.testData, scope: ctx.scope }
      });
      await repository.save(set);
      await this.queue.pushTask(set.taskId, JudgeTaskType.SelfEvalPrepare, JudgeTaskPriorityType.Medium);
      return { ok: true };
    });
  }

  async prepare(user: UserEntity, request: SelfEvalRequestDto) {
    const ctx = await this.context(user, request);
    if (
      !ctx.manager ||
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.EditProblemData)) ||
      !(await this.problems.userHasPermission(user, ctx.problem, ProblemPermissionType.Modify))
    )
      throw new ForbiddenException();
    if (!ctx.canPrepare) throw new BadRequestException("Prepare the fixed prediction set before the contest starts");
    return await this.prepareContext(ctx, user, true);
  }

  async create(user: UserEntity, request: SelfEvalRequestDto) {
    const ctx = await this.context(user, request, true);
    let { content } = request;
    if (request.submissionId) {
      const submission = await this.submissions.findSubmissionById(request.submissionId);
      if (
        !submission ||
        submission.submitterId !== user.id ||
        submission.problemId !== request.problemId ||
        (submission.contestId || null) !== (request.contestId || null)
      )
        throw new ForbiddenException();
      if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSubmission)))
        throw new ForbiddenException();
      content = (await this.submissions.getSubmissionDetail(submission)).content as typeof content;
    }
    if (
      !content ||
      !Object.values(CodeLanguage).includes(content.language as CodeLanguage) ||
      typeof content.code !== "string" ||
      Buffer.byteLength(content.code) > 1048576 ||
      !content.compileAndRunOptions ||
      typeof content.compileAndRunOptions !== "object" ||
      Array.isArray(content.compileAndRunOptions) ||
      new CodeLanguageService().validateCompileAndRunOptions(
        content.language as CodeLanguage,
        content.compileAndRunOptions
      ).length
    )
      throw new BadRequestException("Invalid submission code or compiler options");
    if (
      request.contestId &&
      !isContestLanguageAllowed(
        ctx.languages,
        content.language,
        content.compileAndRunOptions as Record<string, unknown>
      )
    )
      throw new ForbiddenException("Language is not allowed in this contest");
    const set = await this.db.getRepository(SelfEvalSetEntity).findOneBy({ scope: ctx.scope });
    if (!set || set.status !== "Ready") {
      throw new BadRequestException("The fixed prediction set is being prepared; retry when it is ready");
    }
    if (set.recipeHash !== ctx.recipeHash || set.configHash !== ctx.configHash)
      throw new BadRequestException("The fixed prediction set does not match the current problem configuration");
    return await this.locks.lock(`SelfEvalCreate_${user.id}`, async () => {
      const freshContext = await this.context(user, request, true);
      if (freshContext.configHash !== ctx.configHash)
        throw new BadRequestException("Problem configuration changed; refresh before evaluating");
      if (
        !isContestLanguageAllowed(
          freshContext.languages,
          content.language,
          content.compileAndRunOptions as Record<string, unknown>
        )
      )
        throw new ForbiddenException("Language is not allowed in this contest");
      const active = await this.db
        .getRepository(SelfEvalEntity)
        .createQueryBuilder("e")
        .where("e.submitterId = :id AND e.taskId IS NOT NULL", { id: user.id })
        .getCount();
      if (active >= 3) throw new BadRequestException("At most three self evaluations may be pending");
      const record = await this.db.transaction("SERIALIZABLE", async manager => {
        await manager
          .createQueryBuilder()
          .insert()
          .into(SelfEvalQuotaEntity)
          .values({ scope: ctx.quotaScope, userId: user.id, used: 0 })
          .orIgnore()
          .execute();
        const quota = await manager.findOne(SelfEvalQuotaEntity, {
          where: { scope: ctx.quotaScope, userId: user.id },
          lock: { mode: "pessimistic_write" }
        });
        if (quota.used >= freshContext.limit) throw new BadRequestException("Self evaluation attempt limit reached");
        quota.used++;
        await manager.save(quota);
        return await manager.save(SelfEvalEntity, {
          scope: ctx.scope,
          problemId: ctx.problem.id,
          contestId: request.contestId || null,
          submitterId: user.id,
          status: "Pending",
          taskId: uuid(),
          content,
          snapshot: { judgeInfo: ctx.judgeInfo, testData: ctx.testData, scope: ctx.scope },
          createTime: new Date()
        });
      });
      try {
        await this.queue.pushTask(record.taskId, JudgeTaskType.SelfEval, JudgeTaskPriorityType.Low + record.id / 1e9);
      } catch (error) {
        await this.db
          .getRepository(SelfEvalEntity)
          .update(record.id, { taskId: null, status: "SystemError", finishTime: new Date() });
        throw error;
      }
      return { id: record.id };
    });
  }

  private publicRecord(record: SelfEvalEntity) {
    return {
      id: record.id,
      problemId: record.problemId,
      contestId: record.contestId,
      status: record.status,
      score: record.score,
      timeUsed: record.timeUsed,
      memoryUsed: record.memoryUsed,
      feedback: record.feedback,
      createTime: record.createTime,
      finishTime: record.finishTime
    };
  }

  async get(user: UserEntity, id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw new BadRequestException("A valid evaluation ID is required");
    const record = await this.db.getRepository(SelfEvalEntity).findOneBy({ id });
    if (!record) throw new NotFoundException();
    const ctx = await this.context(user, record);
    if (record.submitterId !== user.id && !ctx.manager) throw new ForbiddenException();
    return this.publicRecord(record);
  }

  async list(user: UserEntity, request: SelfEvalRequestDto) {
    if (
      !user ||
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewSite)) ||
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.ViewProblem)) ||
      !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.CreateSelfEval))
    )
      throw new ForbiddenException();
    for (const key of ["problemId", "contestId"] as const)
      if (request[key] != null && (!Number.isSafeInteger(request[key]) || request[key] < 1))
        throw new BadRequestException("A valid filter ID is required");
    if (!request.contestId) throw new BadRequestException("Self evaluation is available only in enabled NOI contests");
    const { contest } = await this.contests.get(user, request.contestId);
    if (contest.rule !== "noi" || contest.ruleOptions?.selfEvalEnabled !== true)
      throw new BadRequestException("Self evaluation is available only in enabled NOI contests");
    const page = request.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new BadRequestException("Invalid page");
    const query = this.db
      .getRepository(SelfEvalEntity)
      .createQueryBuilder("e")
      .where("e.submitterId = :id", { id: user.id });
    if (request.problemId) query.andWhere("e.problemId = :problem", { problem: request.problemId });
    if (request.contestId) {
      query.andWhere("e.contestId = :contest", { contest: request.contestId });
    }
    query.andWhere("e.contestId IS NOT NULL");
    // Check each distinct resource context before counting or paginating. This
    // reads only identifiers; code, recipe snapshots and hidden test data remain
    // in storage until the authorized page is selected.
    const contexts = await query
      .clone()
      .select(["e.scope AS scope", "e.problemId AS problemId", "e.contestId AS contestId"])
      .distinct(true)
      .getRawMany<Pick<SelfEvalEntity, "scope" | "problemId" | "contestId">>();
    const visibleScopes = new Set<string>();
    for (const record of contexts) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Each distinct context can have a different membership/contest ACL.
        const ctx = await this.context(user, record);
        if (record.scope === ctx.scope) visibleScopes.add(record.scope);
      } catch {
        /* Revoked access hides both records and their contribution to total. */
      }
    }
    if (!visibleScopes.size) return { records: [], total: 0, pageSize: 30 };
    query.andWhere("e.scope IN (:...visibleScopes)", { visibleScopes: [...visibleScopes] });
    const [records, total] = await query
      .orderBy("e.id", "DESC")
      .skip((page - 1) * 30)
      .take(30)
      .getManyAndCount();
    return { records: records.map(record => this.publicRecord(record)), total, pageSize: 30 };
  }

  async getTaskToBeSentToJudgeByTaskId(taskId: string, priority: number) {
    const set = await this.db.getRepository(SelfEvalSetEntity).findOneBy({ taskId });
    if (set) {
      const contest = set.contestId && (await this.db.getRepository(ContestEntity).findOneBy({ id: set.contestId }));
      if (
        !contest ||
        contest.rule !== "noi" ||
        contest.ruleOptions?.selfEvalEnabled !== true ||
        Date.now() >= +contest.startTime
      ) {
        await this.db.getRepository(SelfEvalSetEntity).update(set.scope, {
          status: "ConfigurationError",
          taskId: null,
          cases: null,
          message: "Self Eval is not enabled for this NOI contest or preparation started too late"
        });
        return null;
      }
      return new JudgeTask(
        taskId,
        JudgeTaskType.SelfEvalPrepare,
        JudgeTaskPriorityType.Medium,
        priority,
        set.snapshot as Record<string, unknown>
      );
    }
    const record = await this.db.getRepository(SelfEvalEntity).findOneBy({ taskId });
    if (!record) return null;
    const user = await this.db.getRepository(UserEntity).findOneBy({ id: record.submitterId });
    try {
      await this.context(user, record, false);
      if (!(await this.privileges.userHasPrivilege(user, UserPrivilegeType.CreateSelfEval)))
        throw new ForbiddenException();
    } catch {
      await this.db
        .getRepository(SelfEvalEntity)
        .update(record.id, { taskId: null, status: "Canceled", finishTime: new Date() });
      return null;
    }
    const prepared = await this.db.getRepository(SelfEvalSetEntity).findOneBy({ scope: record.scope });
    if (!prepared || prepared.status !== "Ready") return null;
    return new JudgeTask(taskId, JudgeTaskType.SelfEval, JudgeTaskPriorityType.Low, priority, {
      ...(record.snapshot as SelfEvalSnapshot),
      cases: prepared.cases,
      content: record.content
    });
  }

  async onTaskProgress(taskId: string, progress: SelfEvalProgress) {
    if (!progress || typeof progress.finished !== "boolean") return false;
    const set = await this.db.getRepository(SelfEvalSetEntity).findOneBy({ taskId });
    if (set)
      return await this.locks.lock(`SelfEvalSet_${set.scope}`, async () => {
        const current = await this.db.getRepository(SelfEvalSetEntity).findOneBy({ scope: set.scope });
        if (!current || current.taskId !== taskId) return false;
        if (!progress.finished) return true;
        const profile = (current.snapshot as SelfEvalSnapshot).judgeInfo.selfEval;
        const { cases } = progress;
        const valid =
          progress.status === "Ready" &&
          Array.isArray(cases) &&
          Buffer.byteLength(JSON.stringify(cases)) <= 16 * 1024 * 1024 &&
          cases.length === profile.subtaskIds.length &&
          cases.every(
            (value, i) =>
              value.subtask === profile.subtaskIds[i] &&
              typeof value.input === "string" &&
              typeof value.output === "string" &&
              Buffer.from(value.input, "base64").length <= 4 * 1048576 &&
              Buffer.from(value.output, "base64").length <= 4 * 1048576
          );
        current.status = valid ? "Ready" : "ConfigurationError";
        current.taskId = null;
        current.cases = valid ? cases : null;
        current.message = valid
          ? null
          : "Prediction set preparation failed; a manager must inspect the configured programs";
        await this.db.getRepository(SelfEvalSetEntity).save(current);
        return true;
      });
    const record = await this.db.getRepository(SelfEvalEntity).findOneBy({ taskId });
    if (!record) return false;
    return await this.locks.lock(`SelfEval_${record.id}`, async () => {
      const current = await this.db.getRepository(SelfEvalEntity).findOneBy({ id: record.id });
      if (!current || current.taskId !== taskId) return false;
      if (!progress.finished) {
        await this.db.getRepository(SelfEvalEntity).update(current.id, { status: "Running" });
        return true;
      }
      if (!Object.values(SubmissionStatus).includes(progress.status as SubmissionStatus)) return false;
      const user = await this.db.getRepository(UserEntity).findOneBy({ id: current.submitterId });
      try {
        await this.context(user, current);
        if (
          !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.CreateSelfEval)) ||
          !(await this.privileges.userHasPrivilege(user, UserPrivilegeType.SubmitProblem))
        )
          throw new ForbiddenException();
      } catch {
        await this.db
          .getRepository(SelfEvalEntity)
          .update(current.id, { taskId: null, status: "Canceled", finishTime: new Date() });
        return false;
      }
      current.status = progress.status;
      current.taskId = null;
      current.finishTime = new Date();
      current.score = Number.isFinite(progress.score) ? Math.max(0, Math.min(100, Math.round(progress.score))) : 0;
      current.timeUsed = Number.isFinite(progress.timeUsed)
        ? Math.max(0, Math.min(2147483647, Math.ceil(progress.timeUsed)))
        : null;
      current.memoryUsed = Number.isFinite(progress.memoryUsed)
        ? Math.max(0, Math.min(2147483647, Math.ceil(progress.memoryUsed)))
        : null;
      current.feedback = {
        subtasks: (progress.subtasks || []).slice(0, 20).map(value => ({
          score: Math.max(0, Math.min(100, Number(value.score) || 0)),
          fullScore: Math.max(0, Math.min(100, Number(value.fullScore) || 0))
        }))
      };
      await this.db.getRepository(SelfEvalEntity).save(current);
      return true;
    });
  }
}
