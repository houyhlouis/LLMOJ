import fs from "fs";

import { HackProgress, HackStatus, SubmissionStatus } from "@libreoj/judge-protocol";
import { SandboxStatus } from "simple-sandbox";

import { Task } from "..";

import { compile, CompileResultSuccess } from "../../compile";
import { ConfigurationError, CanceledError } from "../../error";
import { ensureFiles, getFile } from "../../file";
import { serverSideConfig } from "../../config";
import { getExtraSourceFiles } from "../submission/common";
import { JudgeInfoTraditional, SubmissionContentTraditional } from "../submission/traditional";
import getLanguage from "../../languages";
import { runTaskQueued } from "../../taskQueue";
import {
  CpuAffinityStrategy,
  runSandbox,
  SANDBOX_INSIDE_PATH_BINARY,
  SANDBOX_INSIDE_PATH_WORKING
} from "../../sandbox";
import { safelyJoinPath, MappedPath } from "../../utils";
import * as fsNative from "../../fsNative";
import { checkerMemory } from "../../checkers";
import { runBuiltinChecker } from "../../checkers/builtin";
import { runCustomChecker, validateCustomChecker } from "../../checkers/custom";
import { isOmittableString } from "../../omittableString";

interface HackExtraInfo {
  inputData: string;
  judgeInfo: JudgeInfoTraditional;
  testData: Record<string, string>;
  target: SubmissionContentTraditional;
  reference: SubmissionContentTraditional;
  // Undefined preserves queued legacy jobs; null explicitly selects stdin/stdout for the STD.
  referenceFileIo?: JudgeInfoTraditional["fileIo"];
  validator: SubmissionContentTraditional;
}

interface ProgramResult {
  status: SandboxStatus;
  output: Buffer;
  timeUsed: number;
  memoryUsed: number;
  outputExceeded: boolean;
  missingOutput: boolean;
}

export async function runProgram(
  taskId: string,
  content: SubmissionContentTraditional,
  compiled: CompileResultSuccess,
  inputData: string | Buffer,
  timeLimit: number,
  memoryLimit: number,
  fileIo?: JudgeInfoTraditional["fileIo"],
  parameters: string[] = []
): Promise<ProgramResult> {
  return await runTaskQueued({ memory: memoryLimit }, async directory => {
    const working: MappedPath = { outside: safelyJoinPath(directory, "working"), inside: SANDBOX_INSIDE_PATH_WORKING };
    const temp = safelyJoinPath(directory, "temp");
    await fsNative.ensureDir(working.outside);
    await fsNative.ensureDir(temp);
    const input = safelyJoinPath(working, fileIo?.inputFilename || "hack-input");
    const output = safelyJoinPath(working, fileIo?.outputFilename || "hack-output");
    const stderr = safelyJoinPath(working, "hack-stderr");
    await fs.promises.writeFile(input.outside, inputData);
    const result = await runSandbox(taskId, {
      ...getLanguage(content.language).run({
        binaryDirectoryInside: SANDBOX_INSIDE_PATH_BINARY,
        workingDirectoryInside: working.inside,
        compileAndRunOptions: content.compileAndRunOptions,
        time: timeLimit,
        memory: memoryLimit,
        stdinFile: fileIo ? null : input.inside,
        stdoutFile: fileIo ? null : output.inside,
        stderrFile: stderr.inside,
        parameters,
        compileResultExtraInfo: compiled.extraInfo
      }),
      time: timeLimit,
      memory: memoryLimit * 1024 * 1024,
      workingDirectory: working.inside,
      tempDirectoryOutside: temp,
      extraMounts: [
        { mappedPath: { outside: compiled.binaryDirectory, inside: SANDBOX_INSIDE_PATH_BINARY }, readOnly: true },
        { mappedPath: working, readOnly: false }
      ],
      cpuAffinity: CpuAffinityStrategy.UserProgram
    });
    const outputMeta = await fs.promises.lstat(output.outside).catch(() => null);
    const missingOutput = !outputMeta?.isFile();
    const size = missingOutput ? 0 : (await fs.promises.stat(output.outside)).size;
    const outputExceeded =
      size > serverSideConfig.limit.outputSize ||
      (await fsNative.calcSize(working.outside)) - Buffer.byteLength(inputData) > serverSideConfig.limit.outputSize;
    return {
      status: result.status,
      output: missingOutput || outputExceeded ? Buffer.alloc(0) : await fs.promises.readFile(output.outside),
      timeUsed: result.time / 1e6,
      memoryUsed: result.memory / 1024,
      outputExceeded,
      missingOutput
    };
  });
}

export async function checkedCompile(
  content: SubmissionContentTraditional,
  extraSourceFiles?: Record<string, string>,
  bundledTestlib = false
) {
  const result = await compile({ ...content, extraSourceFiles, bundledTestlib });
  if (!(result instanceof CompileResultSuccess))
    throw new ConfigurationError(
      "A hack program could not compile; check the trusted reference, validator, and target configuration"
    );
  return result;
}

export default async function onHack(task: Task<HackExtraInfo, HackProgress>) {
  const compiled: CompileResultSuccess[] = [];
  let targetExecuted = false;
  let targetResources: Pick<ProgramResult, "timeUsed" | "memoryUsed">;
  const finish = (
    status: HackStatus,
    message: string,
    resources?: Pick<ProgramResult, "timeUsed" | "memoryUsed">,
    targetStatus?: SubmissionStatus,
    targetScore?: number
  ) => {
    const usage = resources || targetResources;
    task.reportProgressRaw({
      status,
      finished: true,
      message,
      targetExecuted,
      ...(usage ? { timeUsed: usage.timeUsed, memoryUsed: usage.memoryUsed } : {}),
      ...(targetStatus ? { targetStatus } : {}),
      ...(targetScore == null ? {} : { targetScore })
    });
  };
  try {
    task.reportProgressRaw({ status: HackStatus.Running, finished: false });
    const { judgeInfo, testData, target, reference, referenceFileIo, validator, inputData } = task.extraInfo;
    if (typeof inputData !== "string" || Buffer.byteLength(inputData) > 1048576 || !validator?.code?.trim())
      throw new ConfigurationError("Missing validator or oversized hack input");
    if (!(judgeInfo?.timeLimit > 0 && judgeInfo?.memoryLimit > 0))
      throw new ConfigurationError("Invalid resource limits");
    const required = [
      ...Object.values(getExtraSourceFiles(judgeInfo, testData, target.language) || {}),
      ...Object.values(getExtraSourceFiles(judgeInfo, testData, reference.language) || {}),
      ...(judgeInfo.checker.type === "custom" ? [testData[judgeInfo.checker.filename]] : [])
    ];
    await ensureFiles([...new Set(required)]);
    const validatorCompiled = await checkedCompile(validator, undefined, validator.language === "cpp");
    compiled.push(validatorCompiled);
    // Validators consume stdin and must terminate normally with exit code zero for valid input.
    const validated = await runProgram(
      task.taskId,
      validator,
      validatorCompiled,
      inputData,
      Math.min(5000, Math.max(1000, judgeInfo.timeLimit)),
      Math.min(512, Math.max(128, judgeInfo.memoryLimit))
    );
    if (validated.status === SandboxStatus.RuntimeError) {
      finish(HackStatus.InvalidInput, "The problem's input validator rejected this input");
      return;
    }
    if (validated.status !== SandboxStatus.OK || validated.outputExceeded)
      throw new ConfigurationError("The input validator exceeded its execution limits");
    const referenceCompiled = await checkedCompile(
      reference,
      getExtraSourceFiles(judgeInfo, testData, reference.language)
    );
    compiled.push(referenceCompiled);
    const referenceResult = await runProgram(
      task.taskId,
      reference,
      referenceCompiled,
      inputData,
      judgeInfo.timeLimit,
      judgeInfo.memoryLimit,
      referenceFileIo === undefined ? judgeInfo.fileIo : referenceFileIo
    );
    if (referenceResult.status !== SandboxStatus.OK || referenceResult.outputExceeded || referenceResult.missingOutput)
      throw new ConfigurationError("The trusted reference did not produce a valid answer within the problem's limits");
    const targetCompiled = await checkedCompile(target, getExtraSourceFiles(judgeInfo, testData, target.language));
    compiled.push(targetCompiled);
    targetExecuted = true;
    const targetResult = await runProgram(
      task.taskId,
      target,
      targetCompiled,
      inputData,
      judgeInfo.timeLimit,
      judgeInfo.memoryLimit,
      judgeInfo.fileIo
    );
    targetResources = targetResult;
    if (targetResult.status === SandboxStatus.Cancelled) throw new CanceledError();
    if (
      ![
        SandboxStatus.OK,
        SandboxStatus.TimeLimitExceeded,
        SandboxStatus.MemoryLimitExceeded,
        SandboxStatus.RuntimeError,
        SandboxStatus.OutputLimitExceeded
      ].includes(targetResult.status)
    )
      throw new Error("The target sandbox did not return a verdict");
    if (targetResult.status !== SandboxStatus.OK || targetResult.outputExceeded || targetResult.missingOutput) {
      let failure: SubmissionStatus;
      if (targetResult.outputExceeded || targetResult.status === SandboxStatus.OutputLimitExceeded)
        failure = SubmissionStatus.OutputLimitExceeded;
      else if (targetResult.status === SandboxStatus.TimeLimitExceeded) failure = SubmissionStatus.TimeLimitExceeded;
      else if (targetResult.status === SandboxStatus.MemoryLimitExceeded)
        failure = SubmissionStatus.MemoryLimitExceeded;
      else if (targetResult.status === SandboxStatus.RuntimeError) failure = SubmissionStatus.RuntimeError;
      else failure = SubmissionStatus.FileError;
      finish(HackStatus.Success, `The target failed on a validated input: ${failure}`, targetResult, failure, 0);
      return;
    }
    let customCompiled: CompileResultSuccess;
    if (judgeInfo.checker.type === "custom") {
      validateCustomChecker(judgeInfo.checker);
      customCompiled = await checkedCompile(
        {
          language: judgeInfo.checker.language,
          code: await fs.promises.readFile(getFile(testData[judgeInfo.checker.filename]), "utf8"),
          compileAndRunOptions: judgeInfo.checker.compileAndRunOptions
        },
        undefined,
        judgeInfo.checker.interface === "testlib"
      );
      compiled.push(customCompiled);
    }
    const verdict = await runTaskQueued({ memory: checkerMemory(judgeInfo) }, async directory => {
      const working: MappedPath = {
        outside: safelyJoinPath(directory, "checker"),
        inside: SANDBOX_INSIDE_PATH_WORKING
      };
      const temp = safelyJoinPath(directory, "temp");
      await fsNative.ensureDir(working.outside);
      await fsNative.ensureDir(temp);
      const input = safelyJoinPath(working, "input");
      const output = safelyJoinPath(working, "output");
      const answer = safelyJoinPath(working, "answer");
      await fs.promises.writeFile(input.outside, inputData);
      await fs.promises.writeFile(output.outside, targetResult.output);
      await fs.promises.writeFile(answer.outside, referenceResult.output);
      return judgeInfo.checker.type === "custom"
        ? await runCustomChecker(
            task.taskId,
            judgeInfo.checker,
            judgeInfo.checker.timeLimit || judgeInfo.timeLimit,
            judgeInfo.checker.memoryLimit || judgeInfo.memoryLimit,
            customCompiled,
            input,
            output,
            answer,
            target.code,
            working,
            temp
          )
        : await runBuiltinChecker(output.outside, answer.outside, judgeInfo.checker);
    });
    if (isOmittableString(verdict) || !Number.isFinite(verdict.score) || verdict.score < 0 || verdict.score > 100)
      throw new ConfigurationError("The checker could not judge the hack input");
    let targetStatus = SubmissionStatus.PartiallyCorrect;
    if (verdict.score === 100) targetStatus = SubmissionStatus.Accepted;
    else if (verdict.score === 0) targetStatus = SubmissionStatus.WrongAnswer;
    finish(
      verdict.score < 100 ? HackStatus.Success : HackStatus.Failed,
      verdict.score < 100
        ? "The target's output was rejected by the problem checker"
        : "The target passed this validated input",
      targetResult,
      targetStatus,
      verdict.score
    );
  } catch (error) {
    let status = HackStatus.SystemError;
    let message = "Hack judging failed; a manager can inspect the judge log and retry";
    if (error instanceof ConfigurationError) {
      status = HackStatus.ConfigurationError;
      message = error.message;
    }
    if (error instanceof CanceledError) {
      status = HackStatus.Canceled;
      message = "Hack task canceled";
    }
    finish(status, message);
  } finally {
    for (const result of compiled) {
      // eslint-disable-next-line no-await-in-loop
      await result.dereference();
    }
  }
}
