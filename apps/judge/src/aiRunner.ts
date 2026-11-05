/* eslint-disable no-bitwise */
import fs from "fs";
import path from "path";
import net from "net";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { Transform } from "stream";

import winston from "winston";

import Queue from "promise-queue";

import { SandboxResult, SandboxStatus } from "simple-sandbox";
import {
  AI_EXECUTION_PROTOCOL_VERSION,
  aiContractDigest,
  aiReplayRequestError,
  parseAiExecutionProfiles,
  type AiCorpusCase,
  type AiExecutionMeasure,
  type AiExecutionProfiles,
  type AiExecutionRecord,
  type AiFailureKind,
  type AiOutputComparison,
  type AiReplayRequest,
  type AiReplayRun
} from "@libreoj/judge-protocol";

import { runBuiltinChecker } from "./checkers/builtin";
import { Checker, parseTestlibMessage } from "./checkers";
import { isOmittableString, omittableStringToString } from "./omittableString";
import {
  runTestcase as runInteractionTestcase,
  TestcaseStatusInteraction,
  ExtraParametersInteraction
} from "./task/submission/interaction";
import { Disposer } from "./posixUtils";
import { CompileResultSuccess } from "./compile";
import { AiQuality, QualityRequest, QualityVerdict, qualitySources, validateQuality } from "./aiQuality";
import { describe, detailsOf, reclassify, within } from "./aiFailure";
import { keepFailure, pinEvidence, profileOf, sourceHashesOf } from "./aiEvidence";
import { legacyProfiles, programDirectory, programSandbox, PROGRAM_FILE, roleProfile } from "./aiProfile";
import {
  buildKey,
  discardJob,
  holdingJob,
  JobBuilds,
  OperationInputs,
  pruneAiCheckpoints,
  runtimeIdentity
} from "./aiCheckpoint";
import { cArchitectureUnavailable } from "./architecture";

import config from "./config";
import getLanguage from "./languages";
import { runTaskQueued } from "./taskQueue";
import { COMPILE_RESERVATION } from "./executionScheduler";
import { ensureDirectoryEmpty } from "./utils";
import { launcher } from "./launcherClient";
import { AI_RUNNER_DESCRIPTOR_VARIABLE } from "./launcher/protocol";
import { setCloseOnExec } from "./launcher/native";
import {
  runSandbox,
  CpuAffinityStrategy,
  SANDBOX_INSIDE_PATH_SOURCE as SOURCE,
  SANDBOX_INSIDE_PATH_BINARY as BINARY,
  SANDBOX_INSIDE_PATH_WORKING as WORKING
} from "./sandbox";

export interface Request {
  operation?: "generate" | "cleanup" | "validate-reference" | "replay";
  // The backend's key of the logical operation (judge protocol version 8): an attempt of the same one replays the
  // inputs an interrupted attempt generated (see aiCheckpoint.ts)
  operationKey?: string;
  // Operation "replay": the kept failure to run again
  replay?: AiReplayRequest;
  problemType?: "Traditional" | "Interaction" | "Communication";
  interactorCode?: string;
  managerCode?: string;
  quality?: QualityRequest;
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
  // How each role's programs are compiled and run (judge protocol version 7); see aiProfile.ts without them
  profiles?: AiExecutionProfiles;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION_KEY = /^[0-9a-f]{64}$/;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_SAMPLE_FILE = 256 * 1024 * 1024;
const SAMPLE_DIRECTORY = process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR || "/opt/LLMOJ/data/ai-sample-inputs";
const MAX_TOTAL = 8 * 1024 * 1024 * 1024;
const DISK_RESERVE = 2 * 1024 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST = 16 * 1024 * 1024;
// The admitted runs, by key, and whether each one's requester is gone (canceled, or its connection closed)
const active = new Map<string, () => boolean>();
// A new request of a run whose requester is gone (its backend restarted) waits this long for it to stop
const STOPPING_WAIT_MS = 60 * 1000;
// Admit eight backend jobs; three pipelines share the same seven execution slots as submissions.
const generationQueue = new Queue(3);
// Each running request's latest run of each program, for the evidence of a failure
const runMeasures = new WeakMap<Request, Map<string, AiExecutionMeasure>>();
// Diagnostics (compiler output, stderr) kept as evidence, up to this size
const MAX_DIAGNOSTICS = 1024 * 1024;

export type Emit = (event: Record<string, unknown>) => void;

/** Where a generation reads its sample files and writes its output. */
export interface GenerationLayout {
  // The directory of the request's sample files
  sampleDirectory: string;
  // Opens a sample file when the judge can't read the directory itself (the backend's, for the local runner)
  openSample?: (name: string) => Promise<number>;
  // Each job's output directory is made in it
  outputRoot: string;
  // The group allowed to read the output (the local backend); none for a queued task, whose output is uploaded
  outputGroup?: number;
  // Where a failed run's evidence is kept (see aiEvidence.ts), and the run's ID in it (a new one if not given)
  evidenceDirectory: string;
  attemptId?: string;
}

// The local runner's layout: shared with the backend on this server
function localLayout(jobId: string): GenerationLayout {
  return {
    sampleDirectory: path.join(SAMPLE_DIRECTORY, jobId),
    // The backend's directory is its own; the sandbox launcher opens the files (and nothing else) for the judge
    openSample: name => launcher().openSample(jobId, name),
    outputRoot: config.aiGeneratedDirectory,
    outputGroup: config.aiRunnerGid,
    // The backend reads it from the job's directory before it asks for the job's cleanup
    evidenceDirectory: path.join(config.aiGeneratedDirectory, jobId, "failure")
  };
}

async function shareWithBackend(filename: string, layout: GenerationLayout) {
  // The output root is set-group-ID, so new files already have the backend's group
  if (layout.outputGroup == null) return;
  const stat = await fs.promises.lstat(filename);
  if (stat.gid !== layout.outputGroup) await fs.promises.chown(filename, stat.uid, layout.outputGroup);
}

/** A sample file: opened by path, or a descriptor the launcher opened. */
async function openSampleFile(layout: GenerationLayout, source: fs.promises.FileHandle, name: string) {
  if (!layout.openSample) {
    const file = await fs.promises.open(
      `/proc/self/fd/${source.fd}/${name}`,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    return {
      stat: () => file.stat(),
      createReadStream: () => file.createReadStream({ autoClose: false }),
      close: () => file.close()
    };
  }
  const fd = await layout.openSample(name);
  return {
    stat: () =>
      new Promise<fs.Stats>((resolve, reject) => {
        fs.fstat(fd, (error, stat) => (error ? reject(error) : resolve(stat)));
      }),
    createReadStream: () => fs.createReadStream("", { fd, autoClose: false }),
    close: () =>
      new Promise<void>(resolve => {
        fs.close(fd, () => resolve());
      })
  };
}

function referenceError(message: string, candidateFailure: boolean, qualityVerdict?: QualityVerdict): Error {
  return Object.assign(new Error(message), { candidateFailure, qualityVerdict });
}

function measureOf(result: SandboxResult, timeLimitMs?: number, memoryLimitMiB?: number): AiExecutionMeasure {
  return {
    status: (SandboxStatus[result.status] || "Unknown") as AiExecutionMeasure["status"],
    exitCode: result.code,
    ...(result.termination ? { termination: result.termination } : {}),
    timeMs: Math.round(result.time / 1e3) / 1e3,
    memoryBytes: result.memory,
    ...(timeLimitMs ? { timeLimitMs } : {}),
    ...(memoryLimitMiB ? { memoryLimitBytes: memoryLimitMiB * 1024 * 1024 } : {})
  };
}

function kindOfStatus(status: SandboxStatus): AiFailureKind {
  return (
    (
      {
        [SandboxStatus.TimeLimitExceeded]: "time_limit",
        [SandboxStatus.MemoryLimitExceeded]: "memory_limit",
        [SandboxStatus.RuntimeError]: "runtime_error",
        [SandboxStatus.OutputLimitExceeded]: "output_limit",
        [SandboxStatus.Cancelled]: "canceled"
      } as Partial<Record<SandboxStatus, AiFailureKind>>
    )[status] || "infrastructure_error"
  );
}

// The start of a file a program wrote (stderr), as evidence
async function readDiagnostics(filename: string): Promise<Buffer> {
  const file = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => null);
  if (!file) return Buffer.alloc(0);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return Buffer.alloc(0);
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_DIAGNOSTICS));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

// A replay: the check, the programs it runs and their profiles (it's sent no cases or samples)
function validateReplay(request: Request, protocol: boolean) {
  const error = aiReplayRequestError(request.replay);
  if (error) throw new Error(error);
  const { replay } = request;
  if (protocol && !["compile", "validate"].includes(replay.check))
    throw new Error("Only compilation and input validation are replayed for interactive and communication problems");
  for (const code of [
    ...Object.values(replay.programs),
    ...Object.values(request.extraSourceFiles || {}),
    ...(request.graderCode == null ? [] : [request.graderCode])
  ])
    if (typeof code !== "string" || !code.trim() || Buffer.byteLength(code) > 256 * 1024)
      throw new Error("Invalid source code size");
  const profiles = parseAiExecutionProfiles(request.profiles);
  if (!profiles) throw new Error("A replay requires execution profiles");
  const { std, generator } = profiles.roles;
  if (
    std?.fileIo?.inputFilename !== request.stdFileIo?.inputFilename ||
    std?.fileIo?.outputFilename !== request.stdFileIo?.outputFilename
  )
    throw new Error("The reference solution's profile and file IO differ");
  request.profiles = profiles;
  [request.stdTimeLimitMs, request.stdMemoryLimitMiB] = std ? [std.timeLimitMs, std.memoryLimitMiB] : [5000, 512];
  [request.timeLimitMs, request.memoryLimitMiB] = generator
    ? [generator.timeLimitMs, generator.memoryLimitMiB]
    : [5000, 512];
  for (const name of Object.keys(replay.programs)) roleProfile(profiles, name);
  request.cases = [];
}

export function validate(request: Request) {
  if (!request || typeof request.jobId !== "string" || !UUID.test(request.jobId)) throw new Error("Invalid job UUID");
  if (request.operation === "cleanup") return;
  if (request.operation && !["generate", "validate-reference", "replay"].includes(request.operation))
    throw new Error("Invalid operation");
  if (
    request.operationKey != null &&
    (typeof request.operationKey !== "string" || !OPERATION_KEY.test(request.operationKey))
  )
    throw new Error("Invalid operation key");
  if (request.problemType && !["Traditional", "Interaction", "Communication"].includes(request.problemType))
    throw new Error("Invalid problem type");
  const protocol = request.problemType === "Interaction" || request.problemType === "Communication";
  const validating = request.operation === "validate-reference";
  const replaying = request.operation === "replay";
  if (request.problemType === "Interaction" && !request.interactorCode && !replaying)
    throw new Error("Interactor source is required");
  if (request.problemType === "Communication" && !request.managerCode && !replaying)
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
  if (replaying) {
    validateReplay(request, protocol);
    return;
  }
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
  if (!validating && !protocol) {
    if (!request.validatorCode) throw new Error("Traditional generation requires an input validator");
    validateQuality(request.quality, request.cases, request.stdCode);
  } else if (request.quality != null)
    throw new Error("Quality verification is only supported for Traditional generation");
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
  if (request.profiles != null) {
    const profiles = parseAiExecutionProfiles(request.profiles);
    if (!profiles) throw new Error("Invalid execution profiles");
    const { std, generator } = profiles.roles;
    if (
      std?.fileIo?.inputFilename !== request.stdFileIo?.inputFilename ||
      std?.fileIo?.outputFilename !== request.stdFileIo?.outputFilename
    )
      throw new Error("The reference solution's profile and file IO differ");
    // The limits a run's budget is computed from, as the profiles give them
    if (std) [request.stdTimeLimitMs, request.stdMemoryLimitMiB] = [std.timeLimitMs, std.memoryLimitMiB];
    if (generator) [request.timeLimitMs, request.memoryLimitMiB] = [generator.timeLimitMs, generator.memoryLimitMiB];
    request.profiles = profiles;
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
  request.profiles ??= legacyProfiles(request);
  for (const [name, code] of [
    ["make", validating ? null : request.makeCode],
    ["std", request.stdCode],
    ["interactor", request.interactorCode],
    ["manager", request.managerCode],
    ["checker", request.checkerCode],
    ["validator", request.validatorCode],
    ...(request.quality ? qualitySources(request.quality) : [])
  ])
    if (code != null) roleProfile(request.profiles, name);
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

// Installs a program's binary in its own directory
async function installProgram(binaryDirectory: string, name: string, binary: Buffer) {
  const directory = programDirectory(binaryDirectory, name);
  await fs.promises.mkdir(directory, { mode: 0o755 });
  await fs.promises.writeFile(path.join(directory, PROGRAM_FILE), binary, { mode: 0o555 });
}

/**
 * Compiles a program with its role's profile (options, and testlib.h and the extra source files only if it gets them),
 * into a binary directory of its own. With `builds`, the job's earlier build of exactly the same is taken instead, and
 * a new one is kept.
 */
async function compileSource(
  source: string,
  name: string,
  binaryDirectory: string,
  request: Request,
  builds?: JobBuilds
) {
  const profile = roleProfile(request.profiles, name);
  const options = profile.compileAndRunOptions;
  const unavailable = cArchitectureUnavailable(options.m);
  if (unavailable)
    throw describe(new Error(`${name} can't be compiled here: ${unavailable.trim()}`), {
      kind: "infrastructure_error",
      role: name
    });
  const key = builds
    ? buildKey({
        source,
        options,
        testlib: profile.testlib,
        extraSources: profile.extraSources ? request.extraSourceFiles || {} : null,
        grader: name === "std" ? request.graderCode || null : null,
        runtime: await runtimeIdentity()
      })
    : null;
  const kept = key ? await builds.take(key) : null;
  if (kept) {
    await installProgram(binaryDirectory, name, kept);
    return;
  }
  await runTaskQueued({ memory: COMPILE_RESERVATION, ai: true }, async taskDirectory => {
    const sourceDirectory = path.join(taskDirectory, "source");
    const buildDirectory = path.join(taskDirectory, "build");
    const temp = path.join(taskDirectory, "temp");
    await Promise.all([sourceDirectory, buildDirectory, temp].map(ensureDirectoryEmpty));
    await fs.promises.writeFile(path.join(sourceDirectory, "main.cpp"), source);
    if (profile.testlib)
      await fs.promises.copyFile(
        path.resolve(__dirname, "../vendor/testlib/testlib.h"),
        path.join(sourceDirectory, "testlib.h")
      );
    if (profile.extraSources)
      for (const [filename, content] of Object.entries(request.extraSourceFiles || {}))
        await fs.promises.writeFile(path.join(sourceDirectory, filename), content);
    if (name === "std" && request.graderCode)
      await fs.promises.writeFile(path.join(sourceDirectory, "__grader.cpp"), request.graderCode);
    const cpp = getLanguage("cpp");
    const compilation = cpp.compile({
      sourceDirectoryInside: SOURCE,
      sourcePathInside: `${SOURCE}/main.cpp`,
      binaryDirectoryInside: BINARY,
      compileAndRunOptions: options
    });
    // The same flags as one compilation, for the reference solution and the grader compiled apart (which of them
    // failed is the evidence) and linked together
    const flags = compilation.parameters.filter(
      (parameter, i, all) =>
        parameter != null && parameter !== "-o" && all[i - 1] !== "-o" && parameter !== `${SOURCE}/main.cpp`
    );
    const steps =
      name === "std" && request.graderCode
        ? [
            {
              label: "grader",
              candidate: false,
              parameters: [...flags, "-c", `${SOURCE}/__grader.cpp`, "-o", `${BINARY}/grader.o`]
            },
            {
              label: "std",
              candidate: true,
              parameters: [...flags, "-c", `${SOURCE}/main.cpp`, "-o", `${BINARY}/std.o`]
            },
            {
              label: "std link",
              candidate: true,
              parameters: [...flags, `${BINARY}/grader.o`, `${BINARY}/std.o`, "-o", `${BINARY}/${PROGRAM_FILE}`]
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
        // Without the colours the compiler gives its messages for the submission page; the evidence keeps them
        const output = message
          .toString("utf8")
          // eslint-disable-next-line no-control-regex
          .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
          .trim()
          .slice(0, 12000);
        throw describe(
          referenceError(
            `${step.label} compilation failed (${diagnostics}): ${output || "No compiler output"}`,
            step.candidate && result.termination === "exited"
          ),
          {
            kind: result.status === SandboxStatus.Unknown ? "infrastructure_error" : "compile_error",
            role: step.label === "grader" ? "grader" : name,
            execution: measureOf(result),
            data: { diagnostics: message.subarray(0, MAX_DIAGNOSTICS) }
          }
        );
      }
    }
    const binary = await readRegular(path.join(buildDirectory, PROGRAM_FILE));
    await installProgram(binaryDirectory, name, binary);
    if (key) await builds.keep(key, binary);
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
  const profile = roleProfile(request.profiles, name);
  return await runTaskQueued({ memory: profile.memoryLimitMiB, ai: true }, async taskDirectory => {
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
      const { timeLimitMs: timeLimit, memoryLimitMiB: memoryLimit, fileIo } = profile;
      if (fileIo) {
        if (Buffer.isBuffer(input)) await fs.promises.writeFile(path.join(working, fileIo.inputFilename), input);
        else await fs.promises.copyFile(input.path, path.join(working, fileIo.inputFilename));
      }
      const standardInput = Buffer.isBuffer(input) ? `${WORKING}/stdin` : `${SOURCE}/stdin`;
      // Its own binary only: no program sees another's (review Part III, H05)
      const sandbox = programSandbox(
        profile,
        { outside: programDirectory(binaryDirectory, name), inside: BINARY },
        { outside: working, inside: WORKING },
        { outside: references, inside: SOURCE }
      );
      const result = await runSandbox(null, {
        ...sandbox,
        parameters: parameters.map(parameter => {
          const filename = parameter.startsWith(`${WORKING}/`) ? parameter.slice(WORKING.length + 1) : null;
          return filename && files[filename] && !Buffer.isBuffer(files[filename]) ? `${SOURCE}/${filename}` : parameter;
        }),
        process: 1,
        stdin: fileIo ? "/dev/null" : standardInput,
        stdout: `${WORKING}/stdout`,
        stderr: `${WORKING}/stderr`,
        workingDirectory: WORKING,
        tempDirectoryOutside: temp,
        cpuAffinity: sandbox.cpuAffinity as CpuAffinityStrategy
      });
      const measure = measureOf(result, timeLimit, memoryLimit);
      runMeasures.get(request)?.set(name, measure);
      if (name === "checker") {
        const stderrBytes = await readDiagnostics(path.join(working, "stderr"));
        const stderr = stderrBytes.toString("utf8");
        const completed =
          result.status === SandboxStatus.OK ||
          (result.status === SandboxStatus.RuntimeError && result.termination === "exited");
        const verdict = completed ? parseTestlibMessage(stderr) : null;
        const valid =
          verdict &&
          !isOmittableString(verdict) &&
          verdict.score != null &&
          !(result.code !== 0 && stderr.startsWith("ok"));
        if (!valid || verdict.score !== 100) {
          const data = { input: files.input, actual: files.actual, expected: files.expected, diagnostics: stderrBytes };
          throw describe(
            referenceError(
              `checker: ${SandboxStatus[result.status]} (exit ${result.code}) ${stderr.slice(0, 2000)}`,
              !!valid && verdict.score < 100,
              valid && verdict.score < 100 ? "WA" : undefined
            ),
            // A rejection is the checked program's; the checker failed only if it gave no valid verdict
            valid
              ? { kind: "solver_disagreement", verdict: "WA", data }
              : { kind: "checker_failure", role: "checker", execution: measure, data }
          );
        }
        return Buffer.alloc(0);
      }
      if (result.status !== SandboxStatus.OK || result.code !== 0) {
        const message = await readDiagnostics(path.join(working, "stderr"));
        const verdicts = new Map<number, QualityVerdict>([
          [SandboxStatus.TimeLimitExceeded, "TLE"],
          [SandboxStatus.MemoryLimitExceeded, "MLE"],
          [SandboxStatus.RuntimeError, "RE"],
          [SandboxStatus.OutputLimitExceeded, "RE"]
        ]);
        throw describe(
          referenceError(
            `${name}: ${SandboxStatus[result.status]} (exit ${result.code}) ${message.toString("utf8").slice(0, 2000)}`,
            name === "std" && result.status !== SandboxStatus.Unknown,
            verdicts.get(result.status)
          ),
          {
            kind: result.status === SandboxStatus.OK ? "runtime_error" : kindOfStatus(result.status),
            role: name,
            ...(verdicts.has(result.status) || result.status === SandboxStatus.OK
              ? {
                  verdict:
                    result.status === SandboxStatus.OutputLimitExceeded ? "OLE" : verdicts.get(result.status) || "RE"
                }
              : {}),
            execution: measure,
            data: { input, diagnostics: message }
          }
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
          throw describe(referenceError("Reference solution did not create its configured output file", true), {
            kind: "runtime_error",
            role: "std",
            execution: measure,
            data: { input }
          });
        if (/exceeds (?:size limit|256 MiB)/.test(error.message))
          throw describe(error, {
            kind: "output_limit",
            role: name,
            verdict: "OLE",
            execution: measure,
            data: { input }
          });
        throw error;
      }
    } finally {
      await fs.promises.rm(references, { recursive: true, force: true });
    }
  });
}

async function executeProtocol(binaryDirectory: string, request: Request, input: Buffer) {
  const communication = request.problemType === "Communication";
  const program = communication ? "manager" : "interactor";
  const solution = roleProfile(request.profiles, "std");
  const helper = roleProfile(request.profiles, program);
  // The program and its interactor or manager run together
  const reservation = { memory: helper.memoryLimitMiB + solution.memoryLimitMiB, ai: true };
  return await runTaskQueued(reservation, async directory => {
    const disposer = new Disposer();
    // As the published judging settings give them (the judge takes the larger time limit of the two for the helper)
    const judgeInfo = {
      timeLimit: solution.timeLimitMs,
      memoryLimit: solution.memoryLimitMiB,
      subtasks: [],
      interactor: {
        interface: "stdio" as const,
        filename: `${program}.cpp`,
        language: "cpp",
        compileAndRunOptions: helper.compileAndRunOptions,
        timeLimit: helper.timeLimitMs,
        memoryLimit: helper.memoryLimitMiB,
        ...(helper.sharedMemorySize ? { sharedMemorySize: helper.sharedMemorySize } : {})
      }
    };
    const task = {
      taskId: null,
      extraInfo: {
        judgeInfo,
        testData: {},
        submissionContent: {
          language: "cpp",
          compileAndRunOptions: solution.compileAndRunOptions,
          code: request.stdCode
        }
      }
    };
    // Each in its own binary directory, as everywhere
    const compiled: ExtraParametersInteraction = [
      new CompileResultSuccess("", "", programDirectory(binaryDirectory, "std"), 0, ""),
      new CompileResultSuccess("", "", programDirectory(binaryDirectory, program), 0, "")
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
        if (result.status !== TestcaseStatusInteraction.Accepted || result.score !== 100) {
          const programFailed =
            result.status === TestcaseStatusInteraction.JudgementFailed || result.failureOrigin === "interactor";
          const kinds: Partial<Record<TestcaseStatusInteraction, AiFailureKind>> = {
            [TestcaseStatusInteraction.WrongAnswer]: "solver_disagreement",
            [TestcaseStatusInteraction.PartiallyCorrect]: "solver_disagreement",
            [TestcaseStatusInteraction.RuntimeError]: "runtime_error",
            [TestcaseStatusInteraction.TimeLimitExceeded]: "time_limit",
            [TestcaseStatusInteraction.MemoryLimitExceeded]: "memory_limit",
            [TestcaseStatusInteraction.OutputLimitExceeded]: "output_limit",
            [TestcaseStatusInteraction.JudgementFailed]: "checker_failure"
          };
          const message = JSON.stringify(result.interactorMessage || result.systemMessage || "").slice(0, 2000);
          throw describe(
            referenceError(
              `Reference protocol failed at run ${stage}: ${result.status} ${message}`,
              result.status !== TestcaseStatusInteraction.JudgementFailed && result.failureOrigin !== "interactor"
            ),
            {
              kind: kinds[result.status] || "infrastructure_error",
              role: programFailed ? program : "std",
              subject: `protocol run ${stage}`,
              data: { input, diagnostics: Buffer.from(message) }
            }
          );
        }
      }
    } finally {
      disposer.dispose();
    }
  });
}

/**
 * Compiles and runs a request's programs in the sandbox, and (for "generate") writes the test data to its output
 * directory. Emits progress, then the result as a "complete" event; throws on failure.
 */
export async function generate(
  request: Request,
  reportEvent: Emit,
  checkCanceled: () => void,
  layout: GenerationLayout = localLayout(request.jobId)
) {
  // Snapshot backend-owned inputs through O_NOFOLLOW into the judge's own storage before using them.
  // The descriptor-based source path pins the UUID directory even if its owner renames it.
  let snapshot: string;
  const sampleHashes: string[] = [];
  let totalSampleBytes = 0;
  let phase = "queued";
  const emit: Emit = event => {
    if (event.type === "progress") phase = String(event.phase);
    reportEvent(event);
  };
  const measures = new Map<string, AiExecutionMeasure>();
  runMeasures.set(request, measures);
  // The files it reads: the sample files, or a replay's kept files
  const sampleNames =
    request.operation === "replay"
      ? Object.values(request.replay.files)
      : (request.sampleFiles || []).flatMap(sample => [sample.inputFile, sample.outputFile]);
  try {
    if (sampleNames.length) {
      snapshot = await fs.promises.mkdtemp(path.join(layout.outputRoot, ".samples-"));
      const source = layout.openSample
        ? null
        : await fs.promises.open(
            layout.sampleDirectory,
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
          );
      try {
        const names = new Set(sampleNames);
        for (const name of names) {
          checkCanceled();
          const input = await openSampleFile(layout, source, name);
          try {
            const stat = await input.stat();
            if (!stat.isFile() || stat.size > MAX_SAMPLE_FILE || stat.size < 0)
              throw new Error("Invalid sample file or sample exceeds 256 MiB");
            totalSampleBytes += stat.size;
            if (totalSampleBytes > MAX_TOTAL) throw new Error("Samples exceed 8 GiB");
            const space = await (
              fs.promises as unknown as { statfs: (filename: string) => Promise<{ bavail: number; bsize: number }> }
            ).statfs(layout.outputRoot);
            if (space.bavail * space.bsize < DISK_RESERVE + stat.size)
              throw new Error("Insufficient space for sample validation");
            const hash = crypto.createHash("sha256");
            let received = 0;
            await pipeline(
              input.createReadStream(),
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
        await source?.close();
      }
    }
    if (request.operation === "replay") return await replayFailure(request, emit, checkCanceled, snapshot, layout);
    return await generateWithSamples(request, emit, checkCanceled, snapshot, sampleHashes, layout);
  } catch (error) {
    // Before the sample snapshot is removed: a failure's evidence may be in it. A replay's failures are its result.
    if (error && typeof error === "object" && request.operation !== "replay")
      error.failure = await keepRunFailure(request, error, phase, layout, measures);
    throw error;
  } finally {
    runMeasures.delete(request);
    if (snapshot) await fs.promises.rm(snapshot, { recursive: true, force: true });
  }
}

// The reference solution's compiler and options, as the failure's profile names them
function compilerOf(profiles: AiExecutionProfiles | null) {
  const options = profiles?.roles.std?.compileAndRunOptions;
  return options ? `${options.compiler} -std=${options.std} -O${options.O} -m${options.m}` : "g++ -std=c++17 -O2";
}

// Keeps a failed run's evidence in the layout's evidence directory (see aiEvidence.ts)
async function keepRunFailure(
  request: Request,
  error: unknown,
  phase: string,
  layout: GenerationLayout,
  measures?: Map<string, AiExecutionMeasure>
) {
  const comparison = (request.checker || { type: "lines", caseSensitive: true }) as AiOutputComparison;
  // The profiles, once the request was checked (a request refused before then has none it ran with)
  const profiles = parseAiExecutionProfiles(request.profiles);
  const checker = request.checkerCode
    ? "custom"
    : [
        comparison.type,
        ...("caseSensitive" in comparison && !comparison.caseSensitive ? ["case-insensitive"] : []),
        ...(comparison.type === "floats" ? [`precision ${comparison.precision}`] : [])
      ].join(", ");
  return await keepFailure(error, phase, {
    directory: layout.evidenceDirectory,
    share: filename => shareWithBackend(filename, layout),
    attemptId: layout.attemptId || crypto.randomUUID(),
    operation: request.operation === "validate-reference" ? "validate-reference" : "generate",
    sourceHashes: sourceHashesOf(
      [
        ["make", request.makeCode],
        ["std", request.stdCode],
        ["checker", request.checkerCode],
        ["validator", request.validatorCode],
        ["interactor", request.interactorCode],
        ["manager", request.managerCode],
        ["grader", request.graderCode],
        ...(request.quality ? qualitySources(request.quality) : [])
      ],
      request.extraSourceFiles
    ),
    profile: profileOf(
      {
        auxiliary: { timeLimitMs: request.timeLimitMs, memoryLimitMiB: request.memoryLimitMiB },
        solution: { timeLimitMs: request.stdTimeLimitMs, memoryLimitMiB: request.stdMemoryLimitMiB },
        oracle: profiles?.roles.oracle
          ? { timeLimitMs: profiles.roles.oracle.timeLimitMs, memoryLimitMiB: profiles.roles.oracle.memoryLimitMiB }
          : { timeLimitMs: 5000, memoryLimitMiB: 512 },
        ...(profiles ? { executionProfiles: aiContractDigest(profiles) } : {})
      },
      compilerOf(profiles),
      checker
    ),
    comparison: request.checkerCode ? null : comparison,
    measures
  });
}

/**
 * Compares a program's output with what it's compared with, as a run compares them: with the request's custom checker
 * if it has one, or else its builtin comparison. Temporary files go in `directory`.
 */
async function compareOutputs(
  directory: string,
  binaryDirectory: string,
  request: Request,
  input: Buffer | { path: string },
  actual: Buffer | { path: string },
  expected: Buffer | { path: string },
  label: number | string
) {
  if (request.checkerCode) {
    try {
      await execute(
        binaryDirectory,
        "checker",
        request,
        Buffer.alloc(0),
        [`${WORKING}/input`, `${WORKING}/actual`, `${WORKING}/expected`],
        { input, actual, expected }
      );
    } catch (error) {
      error.message = `${typeof label === "number" ? `sample ${label}` : label}: ${error.message}`;
      throw describe(error, { subject: typeof label === "number" ? `sample ${label}` : label });
    }
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
      const subject = typeof label === "number" ? `sample ${label}` : label;
      if (!result || typeof result !== "object" || !("score" in result) || result.score == null)
        throw describe(new Error(`Builtin checker failed while checking ${label}`), {
          kind: "infrastructure_error",
          subject,
          data: { input, actual, expected }
        });
      if (result.score !== 100)
        throw describe(referenceError(`Output mismatch: ${label}`, true, "WA"), {
          kind: "solver_disagreement",
          verdict: "WA",
          subject,
          data: {
            input,
            actual,
            expected,
            ...(result.checkerMessage
              ? { diagnostics: Buffer.from(omittableStringToString(result.checkerMessage)) }
              : {})
          }
        });
    } finally {
      await fs.promises.rm(comparison, { recursive: true, force: true });
    }
  }
}

async function generateWithSamples(
  request: Request,
  emit: Emit,
  checkCanceled: () => void,
  snapshot: string,
  sampleHashes: string[],
  layout: GenerationLayout
) {
  checkCanceled();
  const validating = request.operation === "validate-reference";
  const protocol = request.problemType === "Interaction" || request.problemType === "Communication";
  const directory = validating
    ? await fs.promises.mkdtemp(path.join(layout.outputRoot, ".reference-"))
    : path.join(layout.outputRoot, request.jobId);
  // Version the validation contract as well as hashing all supplied source bytes. Version 6 results record how they
  // were made (see AiExecutionRecord): a result from before isn't reused.
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ version: 6, request, sampleHashes }))
    .digest("hex");
  const resultPath = path.join(directory, "result.json");
  // Only root can create output directories; no backend-controlled pathname or symlink is followed.
  try {
    // The result of this very request, kept until the backend cleans the job up: it was made once, and is collected
    // again (e.g. after the backend restarted before it published the test data)
    const previous = validating ? null : JSON.parse((await readRegular(resultPath)).toString("utf8"));
    if (previous?.requestHash === hash) {
      emit({ ...previous, reused: true });
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const startedAt = new Date().toISOString();
  const runtime = await runtimeIdentity();
  // The job's builds, and the inputs an interrupted attempt of this operation generated (see aiCheckpoint.ts)
  const builds = new JobBuilds(request.jobId);
  const inputs =
    request.operationKey && !validating ? new OperationInputs(request.jobId, request.operationKey, runtime) : null;
  // The cases' files, as they are when the run completes
  const corpus: AiCorpusCase[] = [];
  const fileHash = (data: Buffer) => ({
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    size: data.length
  });
  await fs.promises.rm(directory, { recursive: true, force: true });
  await fs.promises.mkdir(directory, { mode: 0o750 });
  await shareWithBackend(directory, layout);
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
    ).statfs(layout.outputRoot);
    if (space.bavail * space.bsize < DISK_RESERVE + Buffer.byteLength(contents))
      throw new Error("Insufficient disk space: generation reserves 2 GiB for the server");
    const target = path.join(directory, filename);
    await fs.promises.writeFile(target, contents, { mode: 0o640 });
    await shareWithBackend(target, layout);
    files.push(filename);
  }
  async function replaceCase(index: number, input: Buffer, answer: Buffer) {
    const inputPath = path.join(directory, `${index + 1}.in`);
    const outputPath = path.join(directory, `${index + 1}.out`);
    const old = await Promise.all([inputPath, outputPath].map(filename => fs.promises.stat(filename)));
    const replacementBytes = input.length + answer.length;
    const replacedBytes = old[0].size + old[1].size;
    if (
      input.length > MAX_FILE ||
      answer.length > MAX_FILE ||
      totalBytes - replacedBytes + replacementBytes > MAX_TOTAL
    )
      throw new Error("Replacement data exceeds generation size limits");
    const space = await (
      fs.promises as unknown as { statfs: (filename: string) => Promise<{ bavail: number; bsize: number }> }
    ).statfs(layout.outputRoot);
    if (space.bavail * space.bsize < DISK_RESERVE + replacementBytes)
      throw new Error("Insufficient disk space for adversarial case replacement");
    // Nothing is exported before result.json is committed; an interrupted replacement aborts the whole job.
    await fs.promises.writeFile(inputPath, input, { mode: 0o640 });
    await fs.promises.writeFile(outputPath, answer, { mode: 0o640 });
    totalBytes += replacementBytes - replacedBytes;
  }
  // A generator's input for a case: the one an interrupted attempt of this operation generated, or a new one
  async function generated(name: string, subtask: number, caseIndex: number) {
    const kept = await inputs?.take(name, subtask, caseIndex);
    if (kept) return kept;
    const input = await execute(binaryDirectory, name, request, Buffer.from(`${subtask} ${caseIndex}\n`), [
      String(subtask),
      String(caseIndex)
    ]);
    await inputs?.keep(name, subtask, caseIndex, input);
    return input;
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
      await compileSource(source, name, binaryDirectory, request, builds);
      checkCanceled();
      await publish(`${name}.cpp`, source);
    }
    // Auxiliary and challenge sources are private; only official problem artifacts are published.
    for (const [name, source] of request.quality ? qualitySources(request.quality) : []) {
      checkCanceled();
      emit({ type: "progress", phase: `compile-${name}`, completed: 0, total: request.cases.length });
      await compileSource(source, name, binaryDirectory, request, builds);
      checkCanceled();
    }
    if (request.graderCode) await publish("grader.cpp", request.graderCode);
    for (const [filename, source] of Object.entries(request.extraSourceFiles || {})) await publish(filename, source);
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
        const kind = detailsOf(error)?.kind;
        throw reclassify(new Error(`Input validator rejected ${label}: ${reason}`), error, {
          // A validator that couldn't run rejected nothing
          kind: kind === "infrastructure_error" || kind === "canceled" ? kind : "validator_rejection",
          role: "validator",
          subject: label,
          // Subtask 0 is a sample, by its number
          ...(subtask > 0 ? { subtask, scenarioIndex: caseIndex } : {}),
          data: { input }
        });
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
      label: number | string
    ) => await compareOutputs(directory, binaryDirectory, request, input, actual, expected, label);
    const quality = request.quality
      ? new AiQuality(request.quality, {
          execute: async (name, input, parameters) => {
            checkCanceled();
            // The small-case generator's inputs are kept and replayed like the generator's
            const output =
              name === "quality-small-make" && parameters?.length === 2
                ? await generated(name, Number(parameters[0]), Number(parameters[1]))
                : await execute(binaryDirectory, name, request, input, parameters);
            checkCanceled();
            return output;
          },
          validate: validateInput,
          compare: compareSample,
          verifySample: async (name, input, expected, label) => {
            checkCanceled();
            const temporary = await fs.promises.mkdtemp(path.join(directory, "quality-sample-"));
            try {
              const actual = { path: path.join(temporary, "output") };
              // Uploaded sample outputs retain the existing streamed 256 MiB limit.
              await execute(binaryDirectory, name, request, input, [], {}, actual.path);
              checkCanceled();
              await compareSample(input, actual, expected, label);
              checkCanceled();
            } catch (error) {
              // The output is removed with the directory
              await pinEvidence(error, temporary);
              throw error;
            } finally {
              await fs.promises.rm(temporary, { recursive: true, force: true });
            }
          },
          checkCanceled,
          progress: (phase, completed, total) => emit({ type: "progress", phase, completed, total }),
          customChecker: !!request.checkerCode
        })
      : null;
    const sampleCount = (request.samples?.length || 0) + (request.sampleFiles?.length || 0);
    for (const [sampleIndex, sample] of (protocol ? [] : request.samples || []).entries()) {
      checkCanceled();
      const input = Buffer.from(sample.input);
      const expected = Buffer.from(sample.output);
      await within(
        {
          phase: "validate-samples",
          subject: `sample ${samplesPassed + 1}`,
          classification: "public",
          role: "std",
          expectedBasis: "official_sample",
          data: { input, expected }
        },
        // eslint-disable-next-line no-loop-func -- Awaited before the loop goes on
        async () => {
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
          if (quality) await quality.checkSample(input, expected, samplesPassed + 1);
        }
      );
      samplesPassed++;
      emit({ type: "progress", phase: "validate-samples", completed: samplesPassed, total: sampleCount });
    }
    for (const sample of protocol ? [] : request.sampleFiles || []) {
      checkCanceled();
      const sampleNumber = samplesPassed + 1;
      const input = { path: path.join(snapshot, sample.inputFile) };
      const expected = { path: path.join(snapshot, sample.outputFile) };
      const actual = { path: path.join(snapshot, `.actual-${sampleNumber}`) };
      // The sample files stay in the snapshot until the failure is kept
      await within(
        {
          phase: "validate-samples",
          subject: `sample ${sampleNumber}`,
          classification: "author-private",
          role: "std",
          expectedBasis: "official_sample",
          data: { input, expected }
        },
        // eslint-disable-next-line no-loop-func -- Awaited before the loop goes on
        async () => {
          if (request.validatorCode) {
            await validateInput(input, 0, sampleNumber, `sample ${sampleNumber} (subtask 0)`);
            checkCanceled();
            sampleInputsPassed++;
            emit({
              type: "progress",
              phase: "validate-sample-inputs",
              completed: sampleInputsPassed,
              total: sampleCount
            });
          }
          await execute(binaryDirectory, "std", request, input, [], {}, actual.path);
          checkCanceled();
          await compareSample(input, actual, expected, sampleNumber);
          if (quality) await quality.checkSample(input, expected, sampleNumber);
        }
      );
      await fs.promises.unlink(actual.path);
      samplesPassed++;
      emit({ type: "progress", phase: "validate-samples", completed: samplesPassed, total: sampleCount });
    }
    for (const sample of protocol ? request.protocolSamples || [] : []) {
      checkCanceled();
      const input = Buffer.from(sample.input);
      await within(
        {
          phase: "validate-protocol-samples",
          subject: `protocol sample ${protocolSamplesPassed + 1}`,
          classification: "public",
          data: { input }
        },
        // eslint-disable-next-line no-loop-func -- Awaited before the loop goes on
        async () => {
          if (request.validatorCode) {
            await validateInput(input, 0, protocolSamplesPassed + 1, "protocol sample");
            sampleInputsPassed++;
          }
          await executeProtocol(binaryDirectory, request, input);
        }
      );
      protocolSamplesPassed++;
      emit({
        type: "progress",
        phase: "validate-protocol-samples",
        completed: protocolSamplesPassed,
        total: request.protocolSamples.length
      });
    }
    if (quality) await quality.runDifferential();
    const finalCases = request.cases.map(testcase => ({ ...testcase }));
    for (let index = 0; index < request.cases.length; index++) {
      checkCanceled();
      const { subtask, seed } = request.cases[index];
      const subject = `case ${index + 1} (subtask ${subtask}, case index ${seed})`;
      const details = {
        phase: "generate",
        subject,
        subtask,
        scenarioIndex: seed,
        classification: "hidden-test" as const
      };
      const input = await within(details, async () => await generated("make", subtask, seed));
      checkCanceled();
      // eslint-disable-next-line no-loop-func -- Awaited before the loop goes on
      const answer = await within({ ...details, data: { input } }, async () => {
        if (request.validatorCode) {
          await validateInput(input, subtask, seed, subject);
          checkCanceled();
          inputsPassed++;
          emit({ type: "progress", phase: "validate-inputs", completed: inputsPassed, total: request.cases.length });
        }
        const output = protocol ? Buffer.alloc(0) : await execute(binaryDirectory, "std", request, input);
        if (protocol) {
          await executeProtocol(binaryDirectory, request, input);
          protocolCasesPassed++;
        }
        checkCanceled();
        if (quality) await quality.checkCorrect(input, output, subtask, `case ${index + 1}`);
        if (!quality && !protocol && request.checkerCode)
          await within({ role: "std", expectedBasis: "reference_output" }, async () => {
            await execute(
              binaryDirectory,
              "checker",
              request,
              Buffer.alloc(0),
              [`${WORKING}/input`, `${WORKING}/actual`, `${WORKING}/expected`],
              { input, actual: output, expected: output }
            );
          });
        return output;
      });
      const kills = quality
        ? await within({ ...details, data: { input, expected: answer } }, () =>
            quality.findKills(input, answer, subtask)
          )
        : [];
      checkCanceled();
      await publish(`${index + 1}.in`, input);
      await publish(`${index + 1}.out`, answer);
      corpus[index] = {
        index: index + 1,
        subtask,
        scenarioIndex: seed,
        origin: "generated",
        input: fileHash(input),
        output: fileHash(answer)
      };
      if (quality) quality.recordCase(index, kills);
      emit({ type: "progress", phase: "generate", completed: index + 1, total: request.cases.length });
    }
    if (quality) {
      let next = quality.nextSearchCase(finalCases);
      while (next) {
        checkCanceled();
        const { subtask, seed } = next;
        const details = {
          phase: "quality-search",
          subject: `adversarial search (subtask ${subtask}, case index ${seed})`,
          subtask,
          scenarioIndex: seed,
          classification: "hidden-test" as const
        };
        const input = await within(details, async () => await generated("make", subtask, seed));
        // eslint-disable-next-line no-loop-func -- Awaited before the loop goes on
        await within({ ...details, data: { input } }, async () => {
          await validateInput(input, subtask, seed, `adversarial search (subtask ${subtask}, seed ${seed})`);
          const answer = await execute(binaryDirectory, "std", request, input);
          await quality.checkCorrect(input, answer, subtask, `adversarial search seed ${seed}`);
          const kills = await quality.findKills(input, answer, subtask);
          if (kills.length) {
            const index = quality.replacementIndex(finalCases, subtask);
            if (index < 0)
              throw describe(new Error("No unprotected case available for an adversarial replacement"), {
                kind: "insufficient_case_capacity",
                data: { input, expected: answer }
              });
            checkCanceled();
            await replaceCase(index, input, answer);
            finalCases[index] = next;
            corpus[index] = {
              index: index + 1,
              subtask,
              scenarioIndex: seed,
              origin: "adversarial",
              input: fileHash(input),
              output: fileHash(answer)
            };
            quality.recordReplacement(index, kills);
          }
        });
        next = quality.nextSearchCase(finalCases);
      }
    }
    const qualityResult = quality?.result();
    const execution: AiExecutionRecord = {
      contract: AI_EXECUTION_PROTOCOL_VERSION,
      // This physical attempt: a judge task run again after a restart is another attempt of the same task
      attemptId: crypto.randomUUID(),
      runtime,
      startedAt,
      finishedAt: new Date().toISOString(),
      reuse: { builds: builds.reused, inputs: inputs?.reused || 0 }
    };
    const result = {
      type: "complete",
      directory,
      files,
      ...(quality ? { finalCases } : {}),
      // The exact bytes of every case, and how the run was made
      corpus,
      execution,
      validation: {
        samplesPassed,
        inputsPassed,
        sampleInputsPassed,
        protocolCasesPassed,
        protocolSamplesPassed,
        // What the programs ran with, for the backend to compare with what it sent
        profiles: aiContractDigest(request.profiles),
        ...(qualityResult ? { quality: qualityResult } : {})
      },
      requestHash: hash
    };
    checkCanceled();
    await fs.promises.rm(binaryDirectory, { recursive: true, force: true });
    if (validating) {
      await fs.promises.rm(directory, { recursive: true, force: true });
      emit({ type: "complete", files: [], validation: result.validation, execution });
      return;
    }
    await fs.promises.writeFile(resultPath, JSON.stringify(result), { mode: 0o640 });
    await shareWithBackend(resultPath, layout);
    // The result has the cases now
    await inputs?.discard();
    emit(result);
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Runs a kept failure's check again (operation "replay", review Part III, W03): compiles the programs it needs (from
 * the job's builds, except a compilation that is itself replayed), then runs the check `repeat` times and records
 * whether each run failed, and how. Only a failure of the replay itself (the sandbox, storage, cancellation, its
 * budget) fails it.
 */
async function replayFailure(
  request: Request,
  emit: Emit,
  checkCanceled: () => void,
  snapshot: string,
  layout: GenerationLayout
) {
  const { replay } = request;
  const startedAt = new Date().toISOString();
  const runtime = await runtimeIdentity();
  const builds = new JobBuilds(request.jobId);
  // Compared and validated with the checker and validator it sends
  const run: Request = { ...request, checkerCode: replay.programs.checker, validatorCode: replay.programs.validator };
  const file = (name?: string) => (name ? { path: path.join(snapshot, name) } : undefined);
  const [input, expected, actual] = [file(replay.files.input), file(replay.files.expected), file(replay.files.actual)];
  const directory = await fs.promises.mkdtemp(path.join(layout.outputRoot, ".replay-"));
  const binaryDirectory = path.join(directory, "bin");
  const compare = (output: Buffer | { path: string }, against: Buffer | { path: string }) =>
    compareOutputs(directory, binaryDirectory, run, input, output, against, "replay");
  const once = async (attempt: number) => {
    switch (replay.check) {
      case "compile": {
        // Compiled anew each time, never taken from the builds
        const fresh = path.join(directory, `bin-${attempt}`);
        await fs.promises.mkdir(fresh, { mode: 0o755 });
        await compileSource(replay.programs[replay.role], replay.role, fresh, run);
        return;
      }
      case "validate":
        try {
          await execute(binaryDirectory, "validator", run, input, [String(replay.subtask), String(replay.caseIndex)]);
        } catch (error) {
          const kind = detailsOf(error)?.kind;
          throw reclassify(
            new Error(`Input validator rejected the input: ${String(error?.message || error).slice(0, 2000)}`),
            error,
            {
              kind: kind === "infrastructure_error" || kind === "canceled" ? kind : "validator_rejection",
              role: "validator"
            }
          );
        }
        return;
      case "generate":
        await execute(binaryDirectory, replay.role, run, Buffer.from(`${replay.subtask} ${replay.caseIndex}\n`), [
          String(replay.subtask),
          String(replay.caseIndex)
        ]);
        return;
      case "run":
        await execute(binaryDirectory, replay.role, run, input);
        return;
      case "compare": {
        const output = await execute(binaryDirectory, replay.role, run, input);
        let reference: Buffer | { path: string } = output;
        if (replay.against === "expected") reference = expected;
        else if (replay.against !== "self") reference = await execute(binaryDirectory, replay.against, run, input);
        await compare(output, reference);
        return;
      }
      case "checker":
        try {
          await compare(actual, expected);
        } catch (error) {
          // A rejection is a valid verdict, and what the checker must give the malformed output
          const details = detailsOf(error);
          if (details?.kind === "solver_disagreement" && details.verdict === "WA") return;
          throw error;
        }
        if (replay.expect === "reject")
          throw describe(new Error("The checker accepted the malformed output"), {
            kind: "checker_failure",
            role: "checker"
          });
        return;
      default:
        throw new Error("Invalid replay check");
    }
  };
  try {
    await fs.promises.mkdir(binaryDirectory, { mode: 0o755 });
    if (replay.check !== "compile")
      for (const [name, source] of Object.entries(replay.programs)) {
        checkCanceled();
        emit({ type: "progress", phase: `compile-${name}`, completed: 0, total: replay.repeat });
        await compileSource(source, name, binaryDirectory, run, builds);
      }
    const runs: AiReplayRun[] = [];
    for (let attempt = 0; attempt < replay.repeat; attempt++) {
      checkCanceled();
      try {
        await once(attempt);
        runs.push({ outcome: "passed", summary: "" });
      } catch (error) {
        // Canceled, or out of its budget: the replay stops
        checkCanceled();
        const details = detailsOf(error);
        if (!details?.kind || details.kind === "infrastructure_error" || details.kind === "canceled") throw error;
        runs.push({
          outcome: "failed",
          kind: details.kind,
          ...(details.verdict ? { verdict: details.verdict } : {}),
          summary: String(error?.message || error).slice(0, 2000),
          ...(details.execution ? { execution: details.execution } : {})
        });
      }
      emit({ type: "progress", phase: "replay", completed: attempt + 1, total: replay.repeat });
    }
    const execution: AiExecutionRecord = {
      contract: AI_EXECUTION_PROTOCOL_VERSION,
      // This physical attempt: a judge task run again after a restart is another attempt of the same task
      attemptId: crypto.randomUUID(),
      runtime,
      startedAt,
      finishedAt: new Date().toISOString(),
      reuse: { builds: builds.reused, inputs: 0 }
    };
    emit({
      type: "complete",
      files: [],
      replay: { runs },
      validation: { profiles: aiContractDigest(request.profiles) },
      execution
    });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

/**
 * Runs a generation within the runner's limits: at most 8 are admitted at once, 3 run while the others wait, and each
 * has an execution budget from its number of program runs. `key` names it among the admitted ones (the job ID for the
 * local runner, the task ID for a queued task).
 */
export async function runGeneration(
  request: Request,
  emit: Emit,
  isCanceled: () => boolean,
  layout?: GenerationLayout,
  key = request.jobId
) {
  for (const since = Date.now(); active.get(key)?.() && Date.now() - since < STOPPING_WAIT_MS;)
    // eslint-disable-next-line no-await-in-loop -- Polled until it has stopped
    await new Promise(resolve => {
      setTimeout(resolve, 200);
    });
  if (active.has(key) || active.size >= 8) {
    const error = new Error(active.has(key) ? "Job already running" : "AI generation queue is full");
    throw Object.assign(error, {
      failure: await keepRunFailure(request, error, "queued", layout || localLayout(request.jobId))
    });
  }
  active.set(key, isCanceled);
  try {
    const baseExecutions =
      request.cases.length +
      (request.samples?.length || 0) +
      (request.sampleFiles?.length || 0) +
      (request.protocolSamples?.length || 0);
    const qualityExecutions = request.quality
      ? (request.quality.fuzzCases.length + request.cases.length + request.quality.extraAttempts) *
        (3 + request.quality.alternatives.length + request.quality.challenges.length)
      : 0;
    // A replay's runs: its program, the one it's compared with, and the checker
    const replayExecutions = request.replay ? request.replay.repeat * 3 : 0;
    const executionBudgetMs = Math.min(
      4 * 60 * 60 * 1000,
      180000 +
        (baseExecutions + qualityExecutions + replayExecutions) *
          Math.max(20000, request.stdTimeLimitMs * (request.problemType === "Communication" ? 2 : 1) + 15000)
    );
    const deadline = Date.now() + executionBudgetMs;
    emit({ type: "progress", phase: "queued", completed: 0, total: request.cases.length });
    await generationQueue.add(() =>
      // The job's builds and inputs stay while it runs
      holdingJob(request.jobId, () =>
        generate(
          request,
          emit,
          () => {
            if (isCanceled()) throw new Error("Generation canceled");
            if (Date.now() > deadline)
              throw new Error(
                `Generation exceeded its ${Math.ceil(executionBudgetMs / 60000)}-minute execution budget`
              );
          },
          layout
        )
      )
    );
  } finally {
    active.delete(key);
  }
}

async function pruneAbandonedOutputs() {
  for (const entry of await fs.promises.readdir(config.aiGeneratedDirectory, { withFileTypes: true })) {
    if (
      (!UUID.test(entry.name) && !/^\.(?:samples|reference|replay)-[A-Za-z0-9]+$/.test(entry.name)) ||
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
      stat.uid === process.getuid() &&
      !stat.isSymbolicLink() &&
      Date.now() - stat.mtimeMs > RETENTION_MS
    )
      await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

// Deletes old builds, inputs and workspaces of AI runs, also on a judge without the local runner
function pruneCheckpoints() {
  pruneAiCheckpoints(active).catch(error =>
    winston.warn(`Could not clean up what AI runs kept: ${String(error?.message || error)}`)
  );
}

export async function startAiRunner() {
  pruneCheckpoints();
  setInterval(pruneCheckpoints, 60 * 60 * 1000).unref();
  if (!config.aiRunnerSocket || !config.aiGeneratedDirectory) return;
  if (!Number.isInteger(config.aiRunnerGid) || config.aiRunnerGid <= 0) throw new Error("AI runner group is required");
  // The sandbox launcher prepared the output root (the judge's, in the backend's group) and listens on the socket
  const outputStat = await fs.promises.lstat(config.aiGeneratedDirectory);
  if (!outputStat.isDirectory() || outputStat.uid !== process.getuid())
    throw new Error("AI output root must be a real directory of the judge's");
  const listener = Number(process.env[AI_RUNNER_DESCRIPTOR_VARIABLE]);
  if (!Number.isInteger(listener) || listener < 3) throw new Error("The sandbox launcher didn't pass the AI socket");
  setCloseOnExec(listener, true);
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
          if (request.operation === "cleanup" && active.has(request.jobId)) throw new Error("Job already running");
          if (request.operation === "cleanup") {
            await fs.promises.rm(path.join(config.aiGeneratedDirectory, request.jobId), {
              recursive: true,
              force: true
            });
            // And the job's builds and inputs
            await discardJob(request.jobId);
            emit({ type: "complete", cleaned: true });
          } else await runGeneration(request, emit, () => socket.destroyed);
        } catch (error) {
          emit({
            type: "error",
            message: error.message || String(error),
            candidateFailure: request?.operation === "validate-reference" && error.candidateFailure === true,
            // What failed, with its evidence in the job's failure directory
            ...(error.failure ? { failure: error.failure } : {})
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
    server.listen({ fd: listener }, () => resolve());
  });
  await pruneAbandonedOutputs();
  const cleanupTimer = setInterval(
    () => {
      pruneAbandonedOutputs().catch(() => winston.warn("Could not clean an abandoned AI output directory"));
    },
    60 * 60 * 1000
  );
  cleanupTimer.unref();
  winston.info("Local AI generator ready; execution shares judge slots");
}
