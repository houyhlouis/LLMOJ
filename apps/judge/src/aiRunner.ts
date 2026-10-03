/* eslint-disable no-bitwise */
import fs from "fs";
import path from "path";
import net from "net";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { Transform } from "stream";

import winston from "winston";

import Queue from "promise-queue";

import { SandboxStatus } from "simple-sandbox";

import { runBuiltinChecker } from "./checkers/builtin";
import { Checker, parseTestlibMessage } from "./checkers";
import { isOmittableString } from "./omittableString";
import {
  runTestcase as runInteractionTestcase,
  TestcaseStatusInteraction,
  ExtraParametersInteraction
} from "./task/submission/interaction";
import { Disposer } from "./posixUtils";
import { CompileResultSuccess } from "./compile";

import config from "./config";
import getLanguage from "./languages";
import { runTaskQueued } from "./taskQueue";
import { ensureDirectoryEmpty } from "./utils";
import {
  runSandbox,
  CpuAffinityStrategy,
  SANDBOX_INSIDE_PATH_SOURCE as SOURCE,
  SANDBOX_INSIDE_PATH_BINARY as BINARY,
  SANDBOX_INSIDE_PATH_WORKING as WORKING
} from "./sandbox";

export interface Request {
  operation?: "generate" | "cleanup" | "validate-reference";
  problemType?: "Traditional" | "Interaction" | "Communication";
  interactorCode?: string;
  managerCode?: string;
  graderCode?: string;
  extraSourceFiles?: Record<string, string>;
  protocolSamples?: { input: string }[];
  stdFileIo?: { inputFilename: string; outputFilename: string };
  checker?: Exclude<Checker, { type: "custom" }>;
  jobId: string;
  makeCode?: string;
  stdCode: string;
  checkerCode?: string;
  validatorCode?: string;
  cases: { subtask: number; seed: number }[];
  samples?: { input: string; output: string }[];
  sampleFiles?: { inputFile: string; outputFile: string }[];
  timeLimitMs?: number;
  stdTimeLimitMs?: number;
  stdMemoryLimitMiB?: number;
  memoryLimitMiB?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_SAMPLE_FILE = 256 * 1024 * 1024;
const SAMPLE_DIRECTORY = process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR || "/opt/LibreOJ/data/ai-sample-inputs";
const MAX_TOTAL = 8 * 1024 * 1024 * 1024;
const DISK_RESERVE = 2 * 1024 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST = 16 * 1024 * 1024;
const active = new Set<string>();
// Admit eight backend jobs; three pipelines share the same seven execution slots as submissions.
const generationQueue = new Queue(3);

type Emit = (event: Record<string, unknown>) => void;

function referenceError(message: string, candidateFailure: boolean): Error {
  return Object.assign(new Error(message), { candidateFailure });
}

export function validate(request: Request) {
  if (!request || typeof request.jobId !== "string" || !UUID.test(request.jobId)) throw new Error("Invalid job UUID");
  if (request.operation === "cleanup") return;
  if (request.operation && !["generate", "validate-reference"].includes(request.operation))
    throw new Error("Invalid operation");
  if (request.problemType && !["Traditional", "Interaction", "Communication"].includes(request.problemType))
    throw new Error("Invalid problem type");
  const protocol = request.problemType === "Interaction" || request.problemType === "Communication";
  const validating = request.operation === "validate-reference";
  if (request.problemType === "Interaction" && !request.interactorCode)
    throw new Error("Interactor source is required");
  if (request.problemType === "Communication" && !request.managerCode)
    throw new Error("Communication manager source is required");
  if (request.graderCode && request.problemType !== "Communication") throw new Error("A grader requires Communication");
  const validName = (name: string) => typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name);
  if (
    request.extraSourceFiles != null &&
    (typeof request.extraSourceFiles !== "object" ||
      Array.isArray(request.extraSourceFiles) ||
      Object.keys(request.extraSourceFiles).length > 32)
  )
    throw new Error("Invalid extra source files");
  for (const name of Object.keys(request.extraSourceFiles || {}))
    if (
      !validName(name) ||
      [
        "main.cpp",
        "testlib.h",
        "__grader.cpp",
        "make.cpp",
        "std.cpp",
        "checker.cpp",
        "validator.cpp",
        "manager.cpp",
        "interactor.cpp",
        "grader.cpp",
        "result.json"
      ].includes(name)
    )
      throw new Error("Invalid extra source filename");
  if (
    request.stdFileIo != null &&
    (protocol ||
      !validName(request.stdFileIo.inputFilename) ||
      !validName(request.stdFileIo.outputFilename) ||
      request.stdFileIo.inputFilename === request.stdFileIo.outputFilename ||
      [request.stdFileIo.inputFilename, request.stdFileIo.outputFilename].some(name =>
        ["stdin", "stdout", "stderr"].includes(name)
      ))
  )
    throw new Error("Invalid reference file IO");
  if (
    request.checker &&
    (!["tokens", "lines", "binary", "integers", "floats"].includes(request.checker.type) ||
      ((request.checker.type === "tokens" || request.checker.type === "lines") &&
        typeof request.checker.caseSensitive !== "boolean") ||
      (request.checker.type === "floats" &&
        (!Number.isSafeInteger(request.checker.precision) || request.checker.precision <= 0)))
  )
    throw new Error("Invalid reference checker");
  if (
    request.protocolSamples != null &&
    (!Array.isArray(request.protocolSamples) || request.protocolSamples.length > 100)
  )
    throw new Error("Too many protocol samples");
  for (const sample of request.protocolSamples || [])
    if (!sample || typeof sample.input !== "string" || Buffer.byteLength(sample.input) > MAX_FILE)
      throw new Error("Invalid protocol sample");
  if (
    validating &&
    !(protocol ? request.protocolSamples?.length : request.samples?.length || request.sampleFiles?.length)
  )
    throw new Error("NO_REFERENCE_SAMPLES");
  for (const code of [
    ...(validating ? [] : [request.makeCode]),
    request.stdCode,
    ...Object.values(request.extraSourceFiles || {}),
    ...(request.interactorCode == null ? [] : [request.interactorCode]),
    ...(request.managerCode == null ? [] : [request.managerCode]),
    ...(request.graderCode == null ? [] : [request.graderCode]),
    ...(request.checkerCode == null ? [] : [request.checkerCode]),
    ...(request.validatorCode == null ? [] : [request.validatorCode])
  ]) {
    if (typeof code !== "string" || !code.trim() || Buffer.byteLength(code) > 256 * 1024)
      throw new Error("Invalid source code size");
  }
  if (
    !Array.isArray(request.cases) ||
    (validating ? request.cases.length !== 0 : request.cases.length < 5 || request.cases.length > 1000)
  )
    throw new Error("Expected 5–1000 test cases");
  for (const testcase of request.cases) {
    if (
      !testcase ||
      !Number.isSafeInteger(testcase.subtask) ||
      testcase.subtask < 1 ||
      testcase.subtask > 1000 ||
      !Number.isSafeInteger(testcase.seed) ||
      testcase.seed < 0 ||
      testcase.seed > 2147483647
    )
      throw new Error("Invalid subtask or seed");
  }
  if (request.samples != null && (!Array.isArray(request.samples) || request.samples.length > 100))
    throw new Error("Too many samples");
  for (const sample of request.samples || []) {
    if (
      !sample ||
      typeof sample.input !== "string" ||
      typeof sample.output !== "string" ||
      Buffer.byteLength(sample.input) > MAX_FILE ||
      Buffer.byteLength(sample.output) > MAX_FILE
    )
      throw new Error("Invalid sample");
  }
  if (request.sampleFiles != null && (!Array.isArray(request.sampleFiles) || request.sampleFiles.length > 1000))
    throw new Error("Too many sample files");
  for (const sample of request.sampleFiles || []) {
    if (
      !sample ||
      ![sample.inputFile, sample.outputFile].every(
        name =>
          typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) && name !== "." && name !== ".."
      )
    )
      throw new Error("Invalid sample filename");
  }
  request.timeLimitMs ??= 5000;
  request.memoryLimitMiB ??= 512;
  if (!Number.isInteger(request.timeLimitMs) || request.timeLimitMs < 100 || request.timeLimitMs > 10000)
    throw new Error("Invalid execution time limit");
  if (!Number.isInteger(request.memoryLimitMiB) || request.memoryLimitMiB < 16 || request.memoryLimitMiB > 512)
    throw new Error("Invalid execution memory limit");
  request.stdTimeLimitMs ??= request.timeLimitMs;
  request.stdMemoryLimitMiB ??= request.memoryLimitMiB;
  if (!Number.isSafeInteger(request.stdTimeLimitMs) || request.stdTimeLimitMs < 1 || request.stdTimeLimitMs > 60000)
    throw new Error("Invalid reference execution time limit");
  if (
    !Number.isSafeInteger(request.stdMemoryLimitMiB) ||
    request.stdMemoryLimitMiB < 1 ||
    request.stdMemoryLimitMiB > 4096
  )
    throw new Error("Invalid reference execution memory limit");
}

async function readRegular(filename: string, limit = MAX_FILE): Promise<Buffer> {
  const file = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Output is not a regular file or exceeds size limit");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function compileSource(source: string, name: string, binaryDirectory: string, request: Request) {
  await runTaskQueued(async taskDirectory => {
    const sourceDirectory = path.join(taskDirectory, "source");
    const buildDirectory = path.join(taskDirectory, "build");
    const temp = path.join(taskDirectory, "temp");
    await Promise.all([sourceDirectory, buildDirectory, temp].map(ensureDirectoryEmpty));
    await fs.promises.writeFile(path.join(sourceDirectory, "main.cpp"), source);
    await fs.promises.copyFile(
      path.resolve(__dirname, "../vendor/testlib/testlib.h"),
      path.join(sourceDirectory, "testlib.h")
    );
    for (const [filename, content] of Object.entries(request.extraSourceFiles || {}))
      await fs.promises.writeFile(path.join(sourceDirectory, filename), content);
    if (name === "std" && request.graderCode)
      await fs.promises.writeFile(path.join(sourceDirectory, "__grader.cpp"), request.graderCode);
    const cpp = getLanguage("cpp");
    const compilation = cpp.compile({
      sourceDirectoryInside: SOURCE,
      sourcePathInside: `${SOURCE}/main.cpp`,
      additionalSourcePathsInside: name === "std" && request.graderCode ? [`${SOURCE}/__grader.cpp`] : undefined,
      binaryDirectoryInside: BINARY,
      compileAndRunOptions: { compiler: "g++", std: "c++17", O: "2", m: "64" }
    });
    const steps =
      name === "std" && request.graderCode
        ? [
            {
              label: "grader",
              candidate: false,
              parameters: ["-std=c++17", "-O2", "-c", `${SOURCE}/__grader.cpp`, "-o", `${BINARY}/grader.o`]
            },
            {
              label: "std",
              candidate: true,
              parameters: ["-std=c++17", "-O2", "-c", `${SOURCE}/main.cpp`, "-o", `${BINARY}/std.o`]
            },
            {
              label: "std link",
              candidate: true,
              parameters: [`${BINARY}/grader.o`, `${BINARY}/std.o`, "-o", `${BINARY}/a.out`]
            }
          ]
        : [{ label: name, candidate: name === "std", parameters: compilation.parameters }];
    for (const step of steps) {
      const result = await runSandbox(null, {
        ...compilation,
        parameters: step.parameters,
        tempDirectoryOutside: temp,
        extraMounts: [
          { mappedPath: { outside: sourceDirectory, inside: SOURCE }, readOnly: true },
          { mappedPath: { outside: buildDirectory, inside: BINARY }, readOnly: false }
        ],
        cpuAffinity: CpuAffinityStrategy.Compiler
      });
      if (result.status !== SandboxStatus.OK || result.code !== 0) {
        const message = await readRegular(path.join(buildDirectory, "message.txt"), MAX_FILE).catch(() =>
          Buffer.from("Compiler output unavailable")
        );
        const diagnostics = `status=${SandboxStatus[result.status]}, exit=${result.code}, termination=${
          result.termination || "unknown"
        }, timeMs=${(result.time / 1e6).toFixed(3)}, memoryBytes=${result.memory}`;
        const output = message.toString("utf8").trim().slice(0, 12000);
        throw referenceError(
          `${step.label} compilation failed (${diagnostics}): ${output || "No compiler output"}`,
          step.candidate && result.termination === "exited"
        );
      }
    }
    const binary = await readRegular(path.join(buildDirectory, "a.out"));
    await fs.promises.writeFile(path.join(binaryDirectory, name), binary, { mode: 0o555 });
  });
}

async function execute(
  binaryDirectory: string,
  name: string,
  request: Request,
  input: Buffer | { path: string },
  // eslint-disable-next-line default-param-last
  parameters: string[] = [],
  // eslint-disable-next-line default-param-last
  files: Record<string, Buffer | { path: string }> = {},
  outputPath?: string
): Promise<Buffer> {
  return await runTaskQueued(async taskDirectory => {
    const working = path.join(taskDirectory, "working");
    const temp = path.join(taskDirectory, "temp");
    await Promise.all([ensureDirectoryEmpty(working), ensureDirectoryEmpty(temp)]);
    const references = await fs.promises.mkdtemp(path.join(path.dirname(binaryDirectory), "references-"));
    try {
      for (const [filename, content] of Object.entries({ stdin: input, ...files })) {
        if (Buffer.isBuffer(content)) await fs.promises.writeFile(path.join(working, filename), content);
        else {
          await fs.promises.link(content.path, path.join(references, filename));
        }
      }
      const fileIo = name === "std" ? request.stdFileIo : null;
      if (fileIo) {
        if (Buffer.isBuffer(input)) await fs.promises.writeFile(path.join(working, fileIo.inputFilename), input);
        else await fs.promises.copyFile(input.path, path.join(working, fileIo.inputFilename));
      }
      const standardInput = Buffer.isBuffer(input) ? `${WORKING}/stdin` : `${SOURCE}/stdin`;
      const result = await runSandbox(null, {
        executable: `${BINARY}/${name}`,
        parameters: parameters.map(parameter => {
          const filename = parameter.startsWith(`${WORKING}/`) ? parameter.slice(WORKING.length + 1) : null;
          return filename && files[filename] && !Buffer.isBuffer(files[filename]) ? `${SOURCE}/${filename}` : parameter;
        }),
        process: 1,
        time: name === "std" ? request.stdTimeLimitMs : request.timeLimitMs,
        memory: (name === "std" ? request.stdMemoryLimitMiB : request.memoryLimitMiB) * 1024 * 1024,
        stackSize: (name === "std" ? request.stdMemoryLimitMiB : request.memoryLimitMiB) * 1024 * 1024,
        stdin: fileIo ? "/dev/null" : standardInput,
        stdout: `${WORKING}/stdout`,
        stderr: `${WORKING}/stderr`,
        workingDirectory: WORKING,
        tempDirectoryOutside: temp,
        extraMounts: [
          { mappedPath: { outside: binaryDirectory, inside: BINARY }, readOnly: true },
          { mappedPath: { outside: working, inside: WORKING }, readOnly: false },
          { mappedPath: { outside: references, inside: SOURCE }, readOnly: true }
        ],
        cpuAffinity: CpuAffinityStrategy.UserProgram
      });
      if (name === "checker") {
        const stderr = (await readRegular(path.join(working, "stderr")).catch(() => Buffer.alloc(0))).toString("utf8");
        const completed =
          result.status === SandboxStatus.OK ||
          (result.status === SandboxStatus.RuntimeError && result.termination === "exited");
        const verdict = completed ? parseTestlibMessage(stderr) : null;
        const valid =
          verdict &&
          !isOmittableString(verdict) &&
          verdict.score != null &&
          !(result.code !== 0 && stderr.startsWith("ok"));
        if (!valid || verdict.score !== 100)
          throw referenceError(
            `checker: ${SandboxStatus[result.status]} (exit ${result.code}) ${stderr.slice(0, 2000)}`,
            !!valid && verdict.score < 100
          );
        return Buffer.alloc(0);
      }
      if (result.status !== SandboxStatus.OK || result.code !== 0) {
        const message = await readRegular(path.join(working, "stderr")).catch(() => Buffer.from(""));
        throw referenceError(
          `${name}: ${SandboxStatus[result.status]} (exit ${result.code}) ${message.toString("utf8").slice(0, 2000)}`,
          name === "std" && result.status !== SandboxStatus.Unknown
        );
      }
      try {
        if (outputPath) {
          const output = await fs.promises.open(
            path.join(working, fileIo?.outputFilename || "stdout"),
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
          );
          try {
            const stat = await output.stat();
            if (!stat.isFile() || stat.size > MAX_SAMPLE_FILE) throw new Error("Sample output exceeds 256 MiB");
            await pipeline(
              output.createReadStream({ autoClose: false }),
              fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 })
            );
          } finally {
            await output.close();
          }
          return Buffer.alloc(0);
        }
        return await readRegular(path.join(working, fileIo?.outputFilename || "stdout"));
      } catch (error) {
        if (name === "std" && fileIo && error.code === "ENOENT")
          throw referenceError("Reference solution did not create its configured output file", true);
        throw error;
      }
    } finally {
      await fs.promises.rm(references, { recursive: true, force: true });
    }
  });
}

async function executeProtocol(binaryDirectory: string, request: Request, input: Buffer) {
  return await runTaskQueued(async directory => {
    const disposer = new Disposer();
    const communication = request.problemType === "Communication";
    const program = communication ? "manager" : "interactor";
    const options = { compiler: "g++", std: "c++17", O: "2", m: "64" };
    const judgeInfo = {
      timeLimit: request.stdTimeLimitMs,
      memoryLimit: request.stdMemoryLimitMiB,
      subtasks: [],
      interactor: {
        interface: "stdio" as const,
        filename: `${program}.cpp`,
        language: "cpp",
        compileAndRunOptions: options,
        timeLimit: request.timeLimitMs,
        memoryLimit: request.memoryLimitMiB
      }
    };
    const task = {
      taskId: null,
      extraInfo: {
        judgeInfo,
        testData: {},
        submissionContent: { language: "cpp", compileAndRunOptions: options, code: request.stdCode }
      }
    };
    const compiled: ExtraParametersInteraction = [
      new CompileResultSuccess("", "", path.join(binaryDirectory, "std-isolated"), 0, ""),
      new CompileResultSuccess("", "", path.join(binaryDirectory, `${program}-isolated`), 0, "")
    ];
    try {
      for (const stage of (communication ? [1, 2] : [1]) as (1 | 2)[]) {
        const result = await runInteractionTestcase(
          task,
          judgeInfo,
          0,
          { inputData: input.toString("utf8"), outputData: "" },
          null,
          null,
          null,
          compiled,
          path.join(directory, `run-${stage}`),
          disposer,
          communication ? { stage, managerDirectory: path.join(directory, "manager-state") } : undefined
        );
        if (result.status !== TestcaseStatusInteraction.Accepted || result.score !== 100)
          throw referenceError(
            `Reference protocol failed at run ${stage}: ${result.status} ${JSON.stringify(
              result.interactorMessage || result.systemMessage || ""
            ).slice(0, 2000)}`,
            result.status !== TestcaseStatusInteraction.JudgementFailed && result.failureOrigin !== "interactor"
          );
      }
    } finally {
      disposer.dispose();
    }
  });
}

async function generate(request: Request, emit: Emit, checkCanceled: () => void) {
  // Snapshot backend-owned inputs through O_NOFOLLOW into root-owned storage before using them.
  // The descriptor-based source path pins the UUID directory even if its owner renames it.
  let snapshot: string;
  const sampleHashes: string[] = [];
  let totalSampleBytes = 0;
  try {
    if (request.sampleFiles?.length) {
      snapshot = await fs.promises.mkdtemp(path.join(config.aiGeneratedDirectory, ".samples-"));
      const source = await fs.promises.open(
        path.join(SAMPLE_DIRECTORY, request.jobId),
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      );
      try {
        const names = new Set(request.sampleFiles.flatMap(sample => [sample.inputFile, sample.outputFile]));
        for (const name of names) {
          checkCanceled();
          const input = await fs.promises.open(
            `/proc/self/fd/${source.fd}/${name}`,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
          );
          try {
            const stat = await input.stat();
            if (!stat.isFile() || stat.size > MAX_SAMPLE_FILE || stat.size < 0)
              throw new Error("Invalid sample file or sample exceeds 256 MiB");
            totalSampleBytes += stat.size;
            if (totalSampleBytes > MAX_TOTAL) throw new Error("Samples exceed 8 GiB");
            const space = await (
              fs.promises as unknown as { statfs: (filename: string) => Promise<{ bavail: number; bsize: number }> }
            ).statfs(config.aiGeneratedDirectory);
            if (space.bavail * space.bsize < DISK_RESERVE + stat.size)
              throw new Error("Insufficient space for sample validation");
            const hash = crypto.createHash("sha256");
            let received = 0;
            await pipeline(
              input.createReadStream({ autoClose: false }),
              new Transform({
                transform(chunk: Buffer, encoding, callback) {
                  received += chunk.length;
                  if (received > stat.size) return callback(new Error("Sample changed while reading"));
                  hash.update(chunk);
                  return callback(null, chunk);
                }
              }),
              fs.createWriteStream(path.join(snapshot, name), { flags: "wx", mode: 0o600 })
            );
            if (received !== stat.size) throw new Error("Sample changed while reading");
            sampleHashes.push(`${name}:${hash.digest("hex")}`);
          } finally {
            await input.close();
          }
        }
      } finally {
        await source.close();
      }
    }
    return await generateWithSamples(request, emit, checkCanceled, snapshot, sampleHashes);
  } finally {
    if (snapshot) await fs.promises.rm(snapshot, { recursive: true, force: true });
  }
}

async function generateWithSamples(
  request: Request,
  emit: Emit,
  checkCanceled: () => void,
  snapshot: string,
  sampleHashes: string[]
) {
  checkCanceled();
  const validating = request.operation === "validate-reference";
  const protocol = request.problemType === "Interaction" || request.problemType === "Communication";
  const directory = validating
    ? await fs.promises.mkdtemp(path.join(config.aiGeneratedDirectory, ".reference-"))
    : path.join(config.aiGeneratedDirectory, request.jobId);
  // Version the validation contract as well as hashing all supplied source bytes.
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ version: 4, request, sampleHashes }))
    .digest("hex");
  const resultPath = path.join(directory, "result.json");
  // Only root can create output directories; no backend-controlled pathname or symlink is followed.
  try {
    const previous = validating ? null : JSON.parse((await readRegular(resultPath)).toString("utf8"));
    if (previous?.requestHash === hash) {
      emit(previous);
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.promises.rm(directory, { recursive: true, force: true });
  await fs.promises.mkdir(directory, { mode: 0o750 });
  await fs.promises.chown(directory, 0, config.aiRunnerGid);
  const binaryDirectory = path.join(directory, "bin");
  await fs.promises.mkdir(binaryDirectory, { mode: 0o755 });
  let totalBytes = 0;
  const files: string[] = [];
  async function publish(filename: string, contents: Buffer | string) {
    if (validating) return;
    totalBytes += Buffer.byteLength(contents);
    if (Buffer.byteLength(contents) > MAX_FILE || totalBytes > MAX_TOTAL)
      throw new Error("Generated data exceeds the 16 MiB/file or 8 GiB/job limit");
    const space = await (
      fs.promises as unknown as { statfs: (filename: string) => Promise<{ bavail: number; bsize: number }> }
    ).statfs(config.aiGeneratedDirectory);
    if (space.bavail * space.bsize < DISK_RESERVE + Buffer.byteLength(contents))
      throw new Error("Insufficient disk space: generation reserves 2 GiB for the server");
    const target = path.join(directory, filename);
    await fs.promises.writeFile(target, contents, { mode: 0o640 });
    await fs.promises.chown(target, 0, config.aiRunnerGid);
    files.push(filename);
  }
  try {
    for (const [name, source] of [
      ...(validating ? [] : [["make", request.makeCode]]),
      ["std", request.stdCode],
      ...(request.interactorCode ? [["interactor", request.interactorCode]] : []),
      ...(request.managerCode ? [["manager", request.managerCode]] : []),
      ...(request.checkerCode ? [["checker", request.checkerCode]] : []),
      ...(request.validatorCode ? [["validator", request.validatorCode]] : [])
    ]) {
      emit({ type: "progress", phase: `compile-${name}`, completed: 0, total: request.cases.length });
      checkCanceled();
      await compileSource(source, name, binaryDirectory, request);
      checkCanceled();
      await publish(`${name}.cpp`, source);
    }
    if (request.graderCode) await publish("grader.cpp", request.graderCode);
    for (const [filename, source] of Object.entries(request.extraSourceFiles || {})) await publish(filename, source);
    if (protocol) {
      for (const name of ["std", request.problemType === "Communication" ? "manager" : "interactor"]) {
        const isolated = path.join(binaryDirectory, `${name}-isolated`);
        await fs.promises.mkdir(isolated);
        await fs.promises.copyFile(path.join(binaryDirectory, name), path.join(isolated, "a.out"));
        await fs.promises.chmod(path.join(isolated, "a.out"), 0o555);
      }
    }
    // Keep validation in the same isolated execution queue as generation and judging.
    // The source has no access to host files or a network; stderr is bounded and sanitized.
    const validateInput = async (
      input: Buffer | { path: string },
      subtask: number,
      caseIndex: number,
      label: string
    ) => {
      try {
        await execute(binaryDirectory, "validator", request, input, [String(subtask), String(caseIndex)]);
      } catch (error) {
        const reason = String(error.message || error)
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f]/g, " ")
          .slice(0, 2000);
        throw new Error(`Input validator rejected ${label}: ${reason}`);
      }
    };
    let samplesPassed = 0;
    let sampleInputsPassed = 0;
    let inputsPassed = 0;
    let protocolSamplesPassed = 0;
    let protocolCasesPassed = 0;
    const compareSample = async (
      input: Buffer | { path: string },
      actual: Buffer | { path: string },
      expected: Buffer | { path: string },
      number: number
    ) => {
      if (request.checkerCode) {
        await execute(
          binaryDirectory,
          "checker",
          request,
          Buffer.alloc(0),
          [`${WORKING}/input`, `${WORKING}/actual`, `${WORKING}/expected`],
          { input, actual, expected }
        );
      } else {
        const comparison = await fs.promises.mkdtemp(path.join(directory, "comparison-"));
        try {
          const paths: string[] = [];
          for (const [i, value] of [actual, expected].entries()) {
            if (Buffer.isBuffer(value)) {
              const filename = path.join(comparison, String(i));
              await fs.promises.writeFile(filename, value);
              paths.push(filename);
            } else paths.push(value.path);
          }
          const result = await runBuiltinChecker(
            paths[0],
            paths[1],
            request.checker || { type: "lines", caseSensitive: true }
          );
          if (!result || typeof result !== "object" || !("score" in result) || result.score !== 100)
            throw referenceError(`Reference solution failed sample ${number}`, true);
        } finally {
          await fs.promises.rm(comparison, { recursive: true, force: true });
        }
      }
    };
    const sampleCount = (request.samples?.length || 0) + (request.sampleFiles?.length || 0);
    for (const [sampleIndex, sample] of (protocol ? [] : request.samples || []).entries()) {
      checkCanceled();
      const input = Buffer.from(sample.input);
      const expected = Buffer.from(sample.output);
      if (request.validatorCode) {
        await validateInput(input, 0, sampleIndex + 1, `sample ${sampleIndex + 1} (subtask 0)`);
        checkCanceled();
        sampleInputsPassed++;
        emit({
          type: "progress",
          phase: "validate-sample-inputs",
          completed: sampleInputsPassed,
          total: sampleCount
        });
      }
      const actual = await execute(binaryDirectory, "std", request, input);
      checkCanceled();
      await compareSample(input, actual, expected, samplesPassed + 1);
      samplesPassed++;
      emit({ type: "progress", phase: "validate-samples", completed: samplesPassed, total: sampleCount });
    }
    for (const sample of protocol ? [] : request.sampleFiles || []) {
      checkCanceled();
      const sampleNumber = samplesPassed + 1;
      const input = { path: path.join(snapshot, sample.inputFile) };
      const expected = { path: path.join(snapshot, sample.outputFile) };
      if (request.validatorCode) {
        await validateInput(input, 0, sampleNumber, `sample ${sampleNumber} (subtask 0)`);
        checkCanceled();
        sampleInputsPassed++;
        emit({ type: "progress", phase: "validate-sample-inputs", completed: sampleInputsPassed, total: sampleCount });
      }
      const actual = { path: path.join(snapshot, `.actual-${sampleNumber}`) };
      await execute(binaryDirectory, "std", request, input, [], {}, actual.path);
      checkCanceled();
      await compareSample(input, actual, expected, sampleNumber);
      await fs.promises.unlink(actual.path);
      samplesPassed++;
      emit({ type: "progress", phase: "validate-samples", completed: samplesPassed, total: sampleCount });
    }
    for (const sample of protocol ? request.protocolSamples || [] : []) {
      checkCanceled();
      const input = Buffer.from(sample.input);
      if (request.validatorCode) {
        await validateInput(input, 0, protocolSamplesPassed + 1, "protocol sample");
        sampleInputsPassed++;
      }
      await executeProtocol(binaryDirectory, request, input);
      protocolSamplesPassed++;
      emit({
        type: "progress",
        phase: "validate-protocol-samples",
        completed: protocolSamplesPassed,
        total: request.protocolSamples.length
      });
    }
    for (let index = 0; index < request.cases.length; index++) {
      checkCanceled();
      const { subtask, seed } = request.cases[index];
      const input = await execute(binaryDirectory, "make", request, Buffer.from(`${subtask} ${seed}\n`), [
        String(subtask),
        String(seed)
      ]);
      checkCanceled();
      if (request.validatorCode) {
        await validateInput(input, subtask, seed, `case ${index + 1} (subtask ${subtask}, case index ${seed})`);
        checkCanceled();
        inputsPassed++;
        emit({ type: "progress", phase: "validate-inputs", completed: inputsPassed, total: request.cases.length });
      }
      const answer = protocol ? Buffer.alloc(0) : await execute(binaryDirectory, "std", request, input);
      if (protocol) {
        await executeProtocol(binaryDirectory, request, input);
        protocolCasesPassed++;
      }
      checkCanceled();
      if (!protocol && request.checkerCode)
        await execute(
          binaryDirectory,
          "checker",
          request,
          Buffer.alloc(0),
          [`${WORKING}/input`, `${WORKING}/actual`, `${WORKING}/expected`],
          { input, actual: answer, expected: answer }
        );
      await publish(`${index + 1}.in`, input);
      await publish(`${index + 1}.out`, answer);
      emit({ type: "progress", phase: "generate", completed: index + 1, total: request.cases.length });
    }
    const result = {
      type: "complete",
      directory,
      files,
      validation: { samplesPassed, inputsPassed, sampleInputsPassed, protocolCasesPassed, protocolSamplesPassed },
      requestHash: hash
    };
    checkCanceled();
    await fs.promises.rm(binaryDirectory, { recursive: true, force: true });
    if (validating) {
      await fs.promises.rm(directory, { recursive: true, force: true });
      emit({ type: "complete", files: [], validation: result.validation });
      return;
    }
    await fs.promises.writeFile(resultPath, JSON.stringify(result), { mode: 0o640 });
    await fs.promises.chown(resultPath, 0, config.aiRunnerGid);
    emit(result);
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function pruneAbandonedOutputs() {
  for (const entry of await fs.promises.readdir(config.aiGeneratedDirectory, { withFileTypes: true })) {
    if (
      (!UUID.test(entry.name) && !/^\.(?:samples|reference)-[A-Za-z0-9]+$/.test(entry.name)) ||
      !entry.isDirectory() ||
      active.has(entry.name)
    )
      continue;
    const directory = path.join(config.aiGeneratedDirectory, entry.name);
    const stat = await fs.promises.lstat(directory).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (
      stat &&
      !active.has(entry.name) &&
      stat.uid === 0 &&
      !stat.isSymbolicLink() &&
      Date.now() - stat.mtimeMs > RETENTION_MS
    )
      await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

export async function startAiRunner() {
  if (!config.aiRunnerSocket || !config.aiGeneratedDirectory) return;
  if (!Number.isInteger(config.aiRunnerGid) || config.aiRunnerGid <= 0) throw new Error("AI runner group is required");
  await fs.promises.mkdir(config.aiGeneratedDirectory, { recursive: true, mode: 0o750 });
  const outputStat = await fs.promises.lstat(config.aiGeneratedDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink())
    throw new Error("AI output root must be a real directory");
  await fs.promises.chown(config.aiGeneratedDirectory, 0, config.aiRunnerGid);
  await fs.promises.chmod(config.aiGeneratedDirectory, 0o750);
  try {
    const old = await fs.promises.lstat(config.aiRunnerSocket);
    if (!old.isSocket()) throw new Error("AI socket path is not a socket");
    await fs.promises.unlink(config.aiRunnerSocket);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const server = net.createServer(socket => {
    let buffer = "";
    let received = false;
    socket.setEncoding("utf8");
    socket.setTimeout(30000, () => {
      if (!received) socket.destroy();
    });
    socket.on("error", () => {
      /* The destroyed socket cancels the active pipeline. */
    });
    const emit: Emit = event => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(event)}\n`);
    };
    socket.on("data", chunk => {
      if (received) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST) {
        emit({ type: "error", message: "Request exceeds the 16 MiB limit" });
        socket.end();
        received = true;
        return;
      }
      if (!buffer.includes("\n")) return;
      received = true;
      socket.setTimeout(0);
      (async () => {
        let request: Request;
        try {
          request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          validate(request);
          if (active.has(request.jobId)) throw new Error("Job already running");
          if (request.operation === "cleanup") {
            await fs.promises.rm(path.join(config.aiGeneratedDirectory, request.jobId), {
              recursive: true,
              force: true
            });
            emit({ type: "complete", cleaned: true });
          } else {
            if (active.size >= 8) throw new Error("AI generation queue is full");
            active.add(request.jobId);
            emit({ type: "progress", phase: "queued", completed: 0, total: request.cases.length });
            try {
              await generationQueue.add(() =>
                generate(request, emit, () => {
                  if (socket.destroyed) throw new Error("Generation canceled");
                })
              );
            } finally {
              active.delete(request.jobId);
            }
          }
        } catch (error) {
          emit({
            type: "error",
            message: error.message || String(error),
            candidateFailure: request?.operation === "validate-reference" && error.candidateFailure === true
          });
        } finally {
          socket.end();
        }
      })().catch(error => winston.error(`AI socket completion failed: ${String(error)}`));
    });
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.aiRunnerSocket, () => resolve());
  });
  await fs.promises.chown(config.aiRunnerSocket, 0, config.aiRunnerGid);
  await fs.promises.chmod(config.aiRunnerSocket, 0o660);
  await pruneAbandonedOutputs();
  const cleanupTimer = setInterval(() => {
    pruneAbandonedOutputs().catch(() => winston.warn("Could not clean an abandoned AI output directory"));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();
  winston.info("Local AI generator ready; execution shares judge slots");
}
