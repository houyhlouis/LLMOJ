import { Injectable } from "@nestjs/common";

import { ValidationError } from "class-validator";

import { ProblemJudgeInfoCommunication } from "./problem-judge-info.interface";

import { ProblemTypeInteractionService } from "../interaction/problem-type.service";
import { ProblemJudgeInfoInteraction } from "../interaction/problem-judge-info.interface";
import { SubmissionContentInteraction } from "../interaction/submission-content.interface";
import { SubmissionTestcaseResultInteraction } from "../interaction/submission-testcase-result.interface";
import { ProblemFileEntity } from "../../../problem/problem-file.entity";
import { SubmissionProgress } from "../../../submission/submission-progress.interface";
import { ProblemTypeServiceInterface } from "../../problem-type-service.interface";
import { restrictProperties } from "../../common/restrict-properties";

@Injectable()
export class ProblemTypeCommunicationService
  implements
    ProblemTypeServiceInterface<
      ProblemJudgeInfoCommunication,
      SubmissionContentInteraction,
      SubmissionTestcaseResultInteraction
    >
{
  constructor(private readonly interaction: ProblemTypeInteractionService) {}

  getDefaultJudgeInfo(): ProblemJudgeInfoCommunication {
    const base = this.interaction.getDefaultJudgeInfo();
    return {
      timeLimit: base.timeLimit,
      memoryLimit: base.memoryLimit,
      runSamples: false,
      subtasks: null,
      manager: null
    };
  }

  shouldUploadAnswerFile(): boolean {
    return false;
  }

  enableStatistics(): boolean {
    return true;
  }

  private asInteraction(info: ProblemJudgeInfoCommunication): ProblemJudgeInfoInteraction {
    return {
      timeLimit: info.timeLimit,
      memoryLimit: info.memoryLimit,
      runSamples: info.runSamples,
      subtasks: info.subtasks,
      extraSourceFiles: info.extraSourceFiles,
      interactor: info.manager ? { ...info.manager, interface: "stdio" } : null
    };
  }

  preprocessJudgeInfo(info: ProblemJudgeInfoCommunication, files: ProblemFileEntity[]): ProblemJudgeInfoCommunication {
    const normalized = this.interaction.preprocessJudgeInfo(this.asInteraction(info), files);
    return {
      ...info,
      subtasks: normalized.subtasks.map(subtask => ({
        ...subtask,
        testcases: subtask.testcases.map(({ inputFile, timeLimit, memoryLimit, points }) => ({
          inputFile,
          timeLimit,
          memoryLimit,
          points
        }))
      }))
    };
  }

  /* eslint-disable no-throw-literal */
  validateAndFilterJudgeInfo(
    info: ProblemJudgeInfoCommunication,
    files: ProblemFileEntity[],
    ignoreLimits: boolean
  ): void {
    if (!info.manager || info.manager.interface !== "run-twice") throw ["INVALID_COMMUNICATION_MANAGER"];
    restrictProperties(info.manager, [
      "interface",
      "language",
      "compileAndRunOptions",
      "filename",
      "timeLimit",
      "memoryLimit"
    ]);
    if (info.grader != null) {
      if (
        !info.grader ||
        typeof info.grader.filename !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.cpp$/.test(info.grader.filename) ||
        info.grader.filename === "main.cpp"
      )
        throw ["INVALID_COMMUNICATION_GRADER"];
      if (!files.some(file => file.filename === info.grader.filename))
        throw ["NO_SUCH_GRADER_FILE", info.grader.filename];
      restrictProperties(info.grader, ["filename"]);
    }
    const normalized = this.asInteraction(info);
    this.interaction.validateAndFilterJudgeInfo(normalized, files, ignoreLimits);
    info.subtasks = normalized.subtasks;
    restrictProperties(info, [
      "timeLimit",
      "memoryLimit",
      "runSamples",
      "subtasks",
      "manager",
      "grader",
      "extraSourceFiles"
    ]);
  }

  /* eslint-enable no-throw-literal */
  validateSubmissionContent(content: SubmissionContentInteraction): Promise<ValidationError[]> {
    return this.interaction.validateSubmissionContent(content);
  }

  getCodeLanguageAndAnswerSizeFromSubmissionContentAndFile(content: SubmissionContentInteraction) {
    return this.interaction.getCodeLanguageAndAnswerSizeFromSubmissionContentAndFile(content);
  }

  getTimeAndMemoryUsedFromFinishedSubmissionProgress(
    progress: SubmissionProgress<SubmissionTestcaseResultInteraction>
  ) {
    return this.interaction.getTimeAndMemoryUsedFromFinishedSubmissionProgress(progress);
  }
}
