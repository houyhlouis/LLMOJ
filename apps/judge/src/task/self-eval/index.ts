import fs from "fs";
import { createHash } from "crypto";

import { SelfEvalCase, SelfEvalProgress, SubmissionStatus } from "@libreoj/judge-protocol";
import { SandboxStatus } from "simple-sandbox";
import winston from "winston";

import { Task } from "..";
import { checkedCompile, runProgram } from "../hack";
import { CompileResultSuccess } from "../../compile";
import { ensureFiles, getFile } from "../../file";
import { ConfigurationError, CanceledError } from "../../error";
import { JudgeInfoTraditional, SubmissionContentTraditional } from "../submission/traditional";
import { getExtraSourceFiles } from "../submission/common";
import { runTaskQueued } from "../../taskQueue";
import { safelyJoinPath, MappedPath } from "../../utils";
import { SANDBOX_INSIDE_PATH_WORKING } from "../../sandbox";
import * as fsNative from "../../fsNative";
import { runBuiltinChecker } from "../../checkers/builtin";
import { runCustomChecker, validateCustomChecker } from "../../checkers/custom";
import { isOmittableString } from "../../omittableString";

interface Recipe {
  generatorFile: string;
  standardFile: string;
  validatorFile?: string;
  generatorSha256: string;
  standardSha256: string;
  validatorSha256?: string;
  subtaskIds: number[];
  standardFileIo?: JudgeInfoTraditional["fileIo"];
}
interface ExtraInfo {
  judgeInfo: JudgeInfoTraditional & { selfEval?: Recipe };
  testData: Record<string, string>;
  scope: string;
  cases?: SelfEvalCase[];
  content?: SubmissionContentTraditional;
}
const options = { compiler: "g++", std: "c++17", O: "2", m: "64" };

export async function onSelfEvalPrepare(task: Task<ExtraInfo, SelfEvalProgress>) {
  const compiled: CompileResultSuccess[] = [];
  let stage = "validate-profile";
  try {
    task.reportProgressRaw({ status: "Running", finished: false });
    const { judgeInfo, testData, scope } = task.extraInfo;
    const recipe = judgeInfo.selfEval;
    if (!recipe || recipe.subtaskIds.length < 1 || recipe.subtaskIds.length > 20)
      throw new ConfigurationError("A valid formal-data recipe is required");
    stage = "download-profile";
    await ensureFiles(
      [recipe.generatorFile, recipe.standardFile, recipe.validatorFile].filter(Boolean).map(name => testData[name])
    );
    const programs: CompileResultSuccess[] = [];
    for (const key of ["generator", "standard", "validator"] as const) {
      if (key === "validator" && !recipe.validatorFile) continue;
      stage = `verify-${key}-hash`;
      const bytes = await fs.promises.readFile(getFile(testData[recipe[`${key}File`]]));
      if (bytes.length > 1048576 || createHash("sha256").update(bytes).digest("hex") !== recipe[`${key}Sha256`])
        throw new ConfigurationError("The formal-data program hash does not match its immutable profile");
      // eslint-disable-next-line no-await-in-loop
      stage = `compile-${key}`;
      const result = await checkedCompile(
        { language: "cpp", code: bytes.toString("utf8"), compileAndRunOptions: options },
        undefined,
        true
      );
      programs.push(result);
      compiled.push(result);
    }
    const cases: SelfEvalCase[] = [];
    for (const subtask of recipe.subtaskIds) {
      stage = "run-generator";
      const seed =
        1 + (parseInt(createHash("sha256").update(`${scope}:${subtask}`).digest("hex").slice(0, 8), 16) % 1000000000);
      const content = { language: "cpp", code: "", compileAndRunOptions: options };
      // Exactly the formal generator interface: stdin and argv both receive subtask/seed.
      // eslint-disable-next-line no-await-in-loop
      const generated = await runProgram(
        task.taskId,
        content,
        programs[0],
        `${subtask} ${seed}\n`,
        Math.max(1000, judgeInfo.timeLimit),
        Math.max(128, judgeInfo.memoryLimit),
        undefined,
        [String(subtask), String(seed)]
      );
      if (
        generated.status !== SandboxStatus.OK ||
        generated.outputExceeded ||
        generated.missingOutput ||
        generated.output.length > 4 * 1048576
      )
        throw new ConfigurationError("The formal generator did not produce a bounded input");
      // eslint-disable-next-line no-await-in-loop
      stage = "run-validator";
      const validation =
        programs[2] &&
        (await runProgram(
          task.taskId,
          content,
          programs[2],
          generated.output,
          Math.max(1000, judgeInfo.timeLimit),
          Math.max(128, judgeInfo.memoryLimit),
          undefined,
          [String(subtask), String(seed)]
        ));
      if (validation && (validation.status !== SandboxStatus.OK || validation.outputExceeded))
        throw new ConfigurationError("The formal validator rejected a generated prediction case");
      // eslint-disable-next-line no-await-in-loop
      stage = "run-standard";
      const standard = await runProgram(
        task.taskId,
        content,
        programs[1],
        generated.output,
        judgeInfo.timeLimit,
        judgeInfo.memoryLimit,
        recipe.standardFileIo
      );
      if (
        standard.status !== SandboxStatus.OK ||
        standard.outputExceeded ||
        standard.missingOutput ||
        standard.output.length > 4 * 1048576
      )
        throw new ConfigurationError("The formal standard failed on a generated prediction case");
      cases.push({ subtask, input: generated.output.toString("base64"), output: standard.output.toString("base64") });
      if (Buffer.byteLength(JSON.stringify(cases)) > 16 * 1024 * 1024)
        throw new ConfigurationError("The prediction set exceeds its total size limit");
    }
    task.reportProgressRaw({ status: "Ready", finished: true, cases });
  } catch (error) {
    winston.error(
      `Self-evaluation preparation ${task.taskId} failed at ${stage}: ${
        error instanceof ConfigurationError ? error.message : "Unexpected judge error"
      }`
    );
    task.reportProgressRaw({
      status: error instanceof CanceledError ? "Canceled" : "ConfigurationError",
      finished: true,
      message: "Prediction preparation failed; inspect the trusted formal-data programs"
    });
  } finally {
    for (const result of compiled) {
      /* eslint-disable-next-line no-await-in-loop */ await result.dereference();
    }
  }
}

export async function onSelfEval(task: Task<ExtraInfo, SelfEvalProgress>) {
  const compiled: CompileResultSuccess[] = [];
  try {
    task.reportProgressRaw({ status: "Running", finished: false });
    const { judgeInfo, testData, content, cases } = task.extraInfo;
    if (
      !content ||
      !Array.isArray(cases) ||
      !cases.length ||
      cases.length > 20 ||
      Buffer.byteLength(JSON.stringify(cases)) > 16 * 1024 * 1024
    )
      throw new ConfigurationError("Missing fixed prediction set");
    await ensureFiles([
      ...new Set([
        ...Object.values(getExtraSourceFiles(judgeInfo, testData, content.language) || {}),
        ...(judgeInfo.checker.type === "custom" ? [testData[judgeInfo.checker.filename]] : [])
      ])
    ]);
    let target: CompileResultSuccess;
    try {
      target = await checkedCompile(content, getExtraSourceFiles(judgeInfo, testData, content.language));
    } catch (error) {
      if (error instanceof ConfigurationError) {
        task.reportProgressRaw({ status: SubmissionStatus.CompilationError, finished: true, score: 0 });
        return;
      }
      throw error;
    }
    compiled.push(target);
    let checker: CompileResultSuccess;
    if (judgeInfo.checker.type === "custom") {
      validateCustomChecker(judgeInfo.checker);
      checker = await checkedCompile(
        {
          language: judgeInfo.checker.language,
          code: await fs.promises.readFile(getFile(testData[judgeInfo.checker.filename]), "utf8"),
          compileAndRunOptions: judgeInfo.checker.compileAndRunOptions
        },
        undefined,
        judgeInfo.checker.interface === "testlib"
      );
      compiled.push(checker);
    }
    let total = 0;
    let maxTime = 0;
    let maxMemory = 0;
    let failedStatus: string;
    const subtasks: { score: number; fullScore: number }[] = [];
    const specified = judgeInfo.subtasks
      .filter(subtask => subtask.points != null)
      .reduce((sum, subtask) => sum + subtask.points, 0);
    const unspecified = judgeInfo.subtasks.filter(subtask => subtask.points == null).length;
    const weights = cases.map(
      testcase => judgeInfo.subtasks[testcase.subtask - 1]?.points ?? (100 - specified) / (unspecified || 1)
    );
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
    for (const testcase of cases) {
      const input = Buffer.from(testcase.input, "base64");
      const answer = Buffer.from(testcase.output, "base64");
      if (input.length > 4 * 1048576 || answer.length > 4 * 1048576)
        throw new ConfigurationError("Oversized prediction case");
      const subtask = judgeInfo.subtasks[testcase.subtask - 1];
      const time = subtask?.timeLimit || judgeInfo.timeLimit;
      const memory = subtask?.memoryLimit || judgeInfo.memoryLimit;
      // eslint-disable-next-line no-await-in-loop
      const actual = await runProgram(task.taskId, content, target, input, time, memory, judgeInfo.fileIo);
      maxTime = Math.max(maxTime, actual.timeUsed);
      maxMemory = Math.max(maxMemory, actual.memoryUsed);
      let score = 0;
      if (actual.status === SandboxStatus.OK && !actual.outputExceeded && !actual.missingOutput) {
        // eslint-disable-next-line no-await-in-loop
        const checked = await runTaskQueued(async directory => {
          const working: MappedPath = {
            outside: safelyJoinPath(directory, "checker"),
            inside: SANDBOX_INSIDE_PATH_WORKING
          };
          const temp = safelyJoinPath(directory, "temp");
          await fsNative.ensureDir(working.outside);
          await fsNative.ensureDir(temp);
          const inf = safelyJoinPath(working, "input");
          const outf = safelyJoinPath(working, "output");
          const ansf = safelyJoinPath(working, "answer");
          await fs.promises.writeFile(inf.outside, input);
          await fs.promises.writeFile(outf.outside, actual.output);
          await fs.promises.writeFile(ansf.outside, answer);
          return judgeInfo.checker.type === "custom"
            ? await runCustomChecker(
                task.taskId,
                judgeInfo.checker,
                judgeInfo.checker.timeLimit || time,
                judgeInfo.checker.memoryLimit || memory,
                checker,
                inf,
                outf,
                ansf,
                content.code,
                working,
                temp
              )
            : await runBuiltinChecker(outf.outside, ansf.outside, judgeInfo.checker);
        });
        if (isOmittableString(checked) || !Number.isFinite(checked.score))
          throw new ConfigurationError("Prediction checker failed");
        score = checked.score;
        if (score < 100) failedStatus ||= SubmissionStatus.WrongAnswer;
      } else {
        let status = SubmissionStatus.RuntimeError;
        if (actual.status === SandboxStatus.TimeLimitExceeded) status = SubmissionStatus.TimeLimitExceeded;
        if (actual.status === SandboxStatus.MemoryLimitExceeded) status = SubmissionStatus.MemoryLimitExceeded;
        if (actual.missingOutput) status = SubmissionStatus.FileError;
        if (actual.outputExceeded) status = SubmissionStatus.OutputLimitExceeded;
        failedStatus ||= status;
      }
      if ((subtask as { allOrNothing?: boolean })?.allOrNothing && score < 100) score = 0;
      const fullScore = weightTotal > 0 ? (100 * weights[subtasks.length]) / weightTotal : 100 / cases.length;
      total += (score * fullScore) / 100;
      subtasks.push({ score: (score * fullScore) / 100, fullScore });
    }
    let status = failedStatus || SubmissionStatus.WrongAnswer;
    if (total > 0) status = SubmissionStatus.PartiallyCorrect;
    if (Math.round(total) === 100) status = SubmissionStatus.Accepted;
    task.reportProgressRaw({
      status,
      finished: true,
      score: total,
      timeUsed: maxTime,
      memoryUsed: maxMemory,
      subtasks
    });
  } catch (error) {
    let status = SubmissionStatus.SystemError;
    if (error instanceof ConfigurationError) status = SubmissionStatus.ConfigurationError;
    if (error instanceof CanceledError) status = SubmissionStatus.Canceled;
    task.reportProgressRaw({
      status,
      finished: true,
      score: 0
    });
  } finally {
    for (const result of compiled) {
      /* eslint-disable-next-line no-await-in-loop */ await result.dereference();
    }
  }
}
