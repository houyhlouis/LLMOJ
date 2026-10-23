import { randomUUID, createHash } from "crypto";

import { promises as fs } from "fs";

import path from "path";

import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager } from "typeorm";

import { AiJobEntity } from "./ai.entity";
import { AiError } from "./ai.types";
import { declaredAiPublicHeaderNames } from "./ai-protocol";

import { AiJobCoordinator } from "./ai-job-coordinator.service";

import type { ProblemJudgeInfoCommunication } from "../problem-type/types/communication/problem-judge-info.interface";
import type { ProblemJudgeInfoInteraction } from "../problem-type/types/interaction/problem-judge-info.interface";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "../user/user-privilege.service";
import { ProblemService } from "../problem/problem.service";
import { ProblemAccessService, ProblemPermissionType } from "../problem/problem-access.service";
import { ProblemFileService } from "../problem/problem-file.service";
import { ProblemTagService } from "../problem/problem-tag.service";
import { ProblemEntity } from "../problem/problem.entity";
import { FileService } from "../file/file.service";
import { ProblemFileType } from "../problem/problem-file.entity";
import { ProblemJudgeInfoTraditional } from "../problem-type/types/traditional/problem-judge-info.interface";

import { ArchiveError } from "../archive/safe-zip";
import { ProblemJudgeInfoEntity } from "../problem/problem-judge-info.entity";

export type AiProblemSnapshot = Awaited<ReturnType<AiArtifactPublisher["snapshot"]>>;

/**
 * Publishes what AI jobs make to a problem: statements, tags, test data, judge info and public headers. A job works
 * from a snapshot of the problem; each publication checks, in the same transaction and under the same locks, that
 * the problem still matches the snapshot and that the job and its owner's permissions are still current.
 */
@Injectable()
export class AiArtifactPublisher {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly privileges: UserPrivilegeService,
    private readonly problems: ProblemService,
    private readonly problemAccess: ProblemAccessService,
    private readonly problemFiles: ProblemFileService,
    private readonly problemTags: ProblemTagService,
    private readonly files: FileService,
    private readonly coordinator: AiJobCoordinator
  ) {}

  async snapshot(problem: ProblemEntity, manager?: EntityManager) {
    const [judgeInfo, submittable] = await this.problems.getProblemJudgeInfo(problem, manager);
    return {
      id: problem.id,
      type: problem.type,
      ownerId: problem.ownerId,
      isPublic: problem.isPublic,
      difficulty: problem.difficulty,
      originalProblem: problem.originalProblem,
      originalProblemTitle: problem.originalProblemTitle,
      statements: await this.problems.getProblemAllLocalizedContents(problem, manager),
      samples: await this.problems.getProblemSamples(problem, manager),
      judgeInfo: judgeInfo as Partial<ProblemJudgeInfoTraditional> & {
        interactor?: ProblemJudgeInfoInteraction["interactor"];
        manager?: ProblemJudgeInfoCommunication["manager"];
        grader?: ProblemJudgeInfoCommunication["grader"];
      },
      submittable,
      tagIds: await this.problemTags.getProblemTagIdsByProblem(problem, manager)
    };
  }

  problemSnapshotFingerprint(snapshot: AiProblemSnapshot): string {
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  }

  async assertSnapshot(job: AiJobEntity, snapshot: AiProblemSnapshot) {
    const user = await this.coordinator.assertJob(job);
    const current = await this.snapshot(await this.coordinator.editable(user, job.problemId));
    if (this.problemSnapshotFingerprint(current) !== this.problemSnapshotFingerprint(snapshot))
      throw new AiError("PROBLEM_CHANGED_DURING_AI");
    return user;
  }

  async authorizeProblemCommit(
    job: AiJobEntity,
    snapshot: AiProblemSnapshot,
    manager: EntityManager,
    problem: ProblemEntity
  ) {
    // Current, locking permission reads share the save transaction with the job
    // and problem locks. An earlier external check cannot authorize this commit.
    if (!problem) throw new AiError("PROBLEM_CHANGED_DURING_AI");
    const user = await this.coordinator.assertJob(job, manager, problem);
    const current = await this.snapshot(problem, manager);
    if (this.problemSnapshotFingerprint(current) !== this.problemSnapshotFingerprint(snapshot))
      throw new AiError("PROBLEM_CHANGED_DURING_AI");
    return user;
  }

  async authorizeTestdataCommit(
    job: AiJobEntity,
    snapshot: AiProblemSnapshot,
    manager: EntityManager,
    problem: ProblemEntity
  ) {
    await this.authorizeProblemCommit(job, snapshot, manager, problem);
  }

  async lockProblemCommit(job: AiJobEntity, snapshot: AiProblemSnapshot, manager: EntityManager) {
    // Keep the lock order shared with statement and testdata publication.
    const problem = await manager.findOne(ProblemEntity, {
      where: { id: job.problemId },
      lock: { mode: "pessimistic_write" }
    });
    await manager.findOne(ProblemJudgeInfoEntity, {
      where: { problemId: job.problemId },
      lock: { mode: "pessimistic_write" }
    });
    const user = await this.authorizeProblemCommit(job, snapshot, manager, problem);
    return { problem, user };
  }

  async commitProblem<T>(
    job: AiJobEntity,
    snapshot: AiProblemSnapshot,
    write: (manager: EntityManager, problem: ProblemEntity, user: UserEntity) => Promise<T>
  ) {
    // SERIALIZABLE catalog reads can deadlock when two independent jobs insert
    // new tags. Retry only the rolled-back database work, rechecking the job,
    // current permissions and snapshot each time; the paid model call is outside.
    for (let attempt = 0; ; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
        return await this.db.transaction("SERIALIZABLE", async manager => {
          const { problem, user } = await this.lockProblemCommit(job, snapshot, manager);
          return await write(manager, problem, user);
        });
      } catch (error) {
        const cause = error?.driverError || error;
        const retryable =
          cause?.code === "ER_LOCK_DEADLOCK" ||
          cause?.errno === 1213 ||
          cause?.code === "ER_LOCK_WAIT_TIMEOUT" ||
          cause?.errno === 1205 ||
          cause?.sqlState === "40001";
        if (!retryable || attempt >= 4) throw error;
        // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1) + Math.floor(Math.random() * 25)));
      }
    }
  }

  async publishProtocolHeaders(job: AiJobEntity, problem: ProblemEntity, snapshot: AiProblemSnapshot): Promise<void> {
    const sources = job.state.protocolExtraSourceFiles || {};
    if (!Object.keys(sources).length) return;
    const authorize = async () => {
      const current = await this.assertSnapshot(job, snapshot);
      if (!(await this.problemAccess.userHasPermission(current, problem, ProblemPermissionType.Modify)))
        throw new AiError("PERMISSION_DENIED");
    };
    await authorize();
    const existing = await this.problemFiles.getProblemFiles(problem, ProblemFileType.AdditionalFile);
    const declared = new Set([
      ...(job.state.protocolPublicHeaderNames || []),
      ...declaredAiPublicHeaderNames(snapshot.statements),
      ...existing.map(file => file.filename)
    ]);
    const selected = Object.entries<string>(sources).filter(
      ([name]) => declared.has(name) && /\.(?:h|hpp)$/.test(name)
    );
    if (!selected.length) return;
    if (
      selected.length > 16 ||
      selected.some(
        ([name, source]) =>
          !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:h|hpp)$/.test(name) ||
          name.includes("..") ||
          typeof source !== "string" ||
          Buffer.byteLength(source) > 256 * 1024
      )
    )
      throw new AiError("INVALID_AI_PROTOCOL");
    const root = process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR || "/opt/LLMOJ/data/ai-sample-inputs";
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await fs.mkdtemp(path.join(root, ".public-headers-"));
    try {
      const pending: Array<{ filename: string; path: string; size: number }> = [];
      for (const [filename, source] of selected) {
        const old = existing.find(file => file.filename.toLowerCase() === filename.toLowerCase());
        if (old) {
          // Never silently replace a public API. Case-only clashes are also ambiguous to downloaders.
          if (old.filename !== filename) throw new AiError("FILE_ALREADY_EXISTS");
          const target = path.join(directory, randomUUID());
          // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
          await this.files.downloadFileToPath(old.uuid, target, 256 * 1024);
          // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
          if (!(await fs.readFile(target)).equals(Buffer.from(source))) throw new AiError("FILE_ALREADY_EXISTS");
          continue;
        }
        const target = path.join(directory, filename);
        // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
        await fs.writeFile(target, source, { mode: 0o600 });
        pending.push({ filename, path: target, size: Buffer.byteLength(source) });
      }
      await authorize();
      if (pending.length)
        await this.problemFiles.addProblemFilesFromDisk(problem, ProblemFileType.AdditionalFile, pending, {
          authorize,
          authorizeCommit: async (manager, currentProblem) => {
            await this.authorizeProblemCommit(job, snapshot, manager, currentProblem);
          },
          replaceExisting: false,
          noLimit: async manager =>
            await this.privileges.userHasPrivilege(
              await this.coordinator.assertJob(job, manager),
              UserPrivilegeType.ManageProblem,
              manager
            )
        });
    } catch (error) {
      if (error instanceof ArchiveError) throw new AiError(error.code);
      throw error;
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async putFile(problem: ProblemEntity, filename: string, data: string | Buffer, size: number) {
    const upload = await this.files.storeUpload(data);
    if (upload.size !== size) {
      await this.files.discardUploads([upload.uuid]);
      throw new AiError("UPLOAD_GENERATED_FILE_FAILED", "the file changed while it was stored");
    }
    const result = await this.problemFiles.addProblemFile(problem, ProblemFileType.TestData, upload, filename, true);
    if (result) {
      await this.files.discardUploads([upload.uuid]);
      throw new AiError(
        "UPLOAD_GENERATED_FILE_FAILED",
        typeof result === "string" ? result : "unexpected upload response"
      );
    }
  }
}
