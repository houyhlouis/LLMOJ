import fs from "fs";

import objectHash from "object-hash";

import {
  JudgeInfoInteraction,
  validateJudgeInfo as validateInteraction,
  hashSampleTestcase as hashInteractionSample,
  hashTestcase as hashInteractionTestcase
} from "../interaction/judgeInfo";
import {
  runTestcase,
  TestcaseStatusInteraction,
  TestcaseResultInteraction,
  SubmissionContentInteraction,
  ExtraParametersInteraction
} from "../interaction";
import { SubmissionTask, SubmissionStatus, ProblemSample } from "..";
import { compile, CompileResultSuccess } from "../../../compile";
import { getFile } from "../../../file";
import { ConfigurationError } from "../../../error";
import { prependOmittableString } from "../../../omittableString";
import { runCommonTask, getExtraSourceFiles } from "../common";
import { safelyJoinPath } from "../../../utils";

export interface JudgeInfoCommunication extends Omit<JudgeInfoInteraction, "interactor"> {
  manager: Omit<JudgeInfoInteraction["interactor"], "interface" | "sharedMemorySize"> & { interface: "run-twice" };
  grader?: { filename: string };
}
export interface TestcaseResultCommunication extends TestcaseResultInteraction {
  runs?: { stage: number; status: TestcaseStatusInteraction; time: number; memory: number }[];
}
type Task = SubmissionTask<
  JudgeInfoCommunication,
  SubmissionContentInteraction,
  TestcaseResultCommunication,
  ExtraParametersInteraction
>;

function asInteraction(info: JudgeInfoCommunication): JudgeInfoInteraction {
  return {
    timeLimit: info.timeLimit,
    memoryLimit: info.memoryLimit,
    runSamples: info.runSamples,
    subtasks: info.subtasks,
    extraSourceFiles: info.extraSourceFiles,
    interactor: { ...info.manager, interface: "stdio" }
  };
}

/* eslint-disable no-throw-literal */
export async function validateJudgeInfo(task: Task): Promise<void> {
  const { judgeInfo, testData } = task.extraInfo;
  if (judgeInfo.manager?.interface !== "run-twice") throw "Communication requires a run-twice manager.";
  if (
    judgeInfo.grader &&
    (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.cpp$/.test(judgeInfo.grader.filename) ||
      judgeInfo.grader.filename === "main.cpp" ||
      !(judgeInfo.grader.filename in testData))
  )
    throw "Communication grader must be an uploaded C++ file other than main.cpp.";
  await validateInteraction({
    ...task,
    extraInfo: { ...task.extraInfo, judgeInfo: asInteraction(judgeInfo) }
  } as unknown as Parameters<typeof validateInteraction>[0]);
}
/* eslint-enable no-throw-literal */
export async function hashSampleTestcase(
  info: JudgeInfoCommunication,
  sample: ProblemSample,
  programs: ExtraParametersInteraction
) {
  return objectHash({
    protocol: "run-twice-v1",
    testcase: await hashInteractionSample(asInteraction(info), sample, programs)
  });
}
export async function hashTestcase(
  info: JudgeInfoCommunication,
  subtaskIndex: number,
  testcaseIndex: number,
  files: Record<string, string>,
  programs: ExtraParametersInteraction
) {
  return objectHash({
    protocol: "run-twice-v1",
    testcase: await hashInteractionTestcase(asInteraction(info), subtaskIndex, testcaseIndex, files, programs)
  });
}

export async function runTask(task: Task) {
  const { judgeInfo, testData, submissionContent } = task.extraInfo;
  task.events.compiling();
  if (judgeInfo.grader && submissionContent.language !== "cpp") {
    task.events.compiled({
      success: false,
      message: "This function-based communication task requires a C++ submission."
    });
    task.events.finished(SubmissionStatus.CompilationError, 0);
    return;
  }
  const managerResult = await compile({
    language: judgeInfo.manager.language,
    code: await fs.promises.readFile(getFile(testData[judgeInfo.manager.filename]), "utf8"),
    compileAndRunOptions: judgeInfo.manager.compileAndRunOptions,
    bundledTestlib: judgeInfo.manager.language === "cpp",
    extraSourceFiles: getExtraSourceFiles(judgeInfo, testData, judgeInfo.manager.language)
  });
  if (!(managerResult instanceof CompileResultSuccess))
    throw new ConfigurationError(
      prependOmittableString("Failed to compile communication manager:\n\n", managerResult.message, true)
    );
  let contestant: CompileResultSuccess;
  try {
    const extraSourceFiles = getExtraSourceFiles(judgeInfo, testData, submissionContent.language);
    if (judgeInfo.grader) extraSourceFiles[judgeInfo.grader.filename] = testData[judgeInfo.grader.filename];
    const compiled = await compile({
      language: submissionContent.language,
      code: submissionContent.code,
      compileAndRunOptions: submissionContent.compileAndRunOptions,
      extraSourceFiles,
      additionalSourceFiles: judgeInfo.grader ? [judgeInfo.grader.filename] : undefined
    });
    if (compiled instanceof CompileResultSuccess) contestant = compiled;
    task.events.compiled({ success: compiled.success, message: compiled.message });
    if (!(compiled instanceof CompileResultSuccess)) {
      task.events.finished(SubmissionStatus.CompilationError, 0);
      return;
    }
    await runCommonTask({
      task,
      extraParameters: [contestant, managerResult] as ExtraParametersInteraction,
      onTestcase: async (
        currentTask,
        currentInfo,
        sampleId,
        sample,
        subtaskIndex,
        testcaseIndex,
        testcase,
        compiledPrograms,
        directory,
        disposer
      ) => {
        const interactionInfo = asInteraction(currentInfo);
        const adaptedTask = { ...currentTask, extraInfo: { ...currentTask.extraInfo, judgeInfo: interactionInfo } };
        const runs: TestcaseResultCommunication["runs"] = [];
        let result: TestcaseResultCommunication;
        for (const stage of [1, 2] as const) {
          result = await runTestcase(
            adaptedTask,
            interactionInfo,
            sampleId,
            sample,
            subtaskIndex,
            testcaseIndex,
            testcase,
            compiledPrograms,
            safelyJoinPath(directory, `run-${stage}`),
            disposer,
            { stage, managerDirectory: safelyJoinPath(directory, "manager-state") }
          );
          runs.push({ stage, status: result.status, time: result.time || 0, memory: result.memory || 0 });
          if (result.status !== TestcaseStatusInteraction.Accepted) {
            if (stage === 1 && result.status === TestcaseStatusInteraction.PartiallyCorrect) {
              result.status = TestcaseStatusInteraction.JudgementFailed;
              result.score = 0;
              result.systemMessage =
                "The first communication run must either accept the transfer or reject it; partial scoring belongs to the final run.";
            }
            break;
          }
        }
        result.runs = runs;
        result.time = runs.reduce((sum, run) => sum + run.time, 0);
        result.memory = Math.max(...runs.map(run => run.memory));
        return result;
      }
    });
  } finally {
    try {
      if (contestant) await contestant.dereference();
    } finally {
      await managerResult.dereference();
    }
  }
}
