import { createHash, randomUUID } from "crypto";
import { constants, createReadStream, promises as fs, statSync } from "fs";
import { createConnection } from "net";
import os from "os";
import path from "path";

import { forwardRef, Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, In, IsNull, LessThan, Not } from "typeorm";

import {
  AI_EVIDENCE_FILE,
  AI_EVIDENCE_LIMITS,
  AI_EXECUTION_PROTOCOL_VERSION,
  AiExecutionProgress,
  AiFailureKind,
  AiRunFailure,
  JudgeTaskType,
  JudgeUploadTarget,
  parseAiRunFailure
} from "@libreoj/judge-protocol";

import { AiExecutionEntity, AiExecutionState } from "./ai-execution.entity";
import { AiJobEntity } from "./ai.entity";
import { AiError } from "./ai.types";
import { aiCancellationError, currentAiRuntime } from "./ai-runtime";
import { AiEvidenceService, EvidenceSource, RecordOptions } from "./ai-evidence.service";
import { AI_RESULT_RETENTION, aiOperationKey, AiExecutionProvenance, currentExecution } from "./ai-operation";

import { logger } from "../logger";
import {
  FileService,
  JUDGE_FILE_DOWNLOAD_EXPIRE_TIME,
  MinioSignFor,
  TEMPORARY_OBJECT_PREFIX
} from "../file/file.service";
import { JudgeQueueService, JudgeTask, JudgeTaskPriorityType } from "../judge/judge-queue.service";
import { JudgeTaskCompletion, JudgeTaskService } from "../judge/judge-task-service.interface";
import { JudgeGateway } from "../judge/judge.gateway";
import { RedisService } from "../redis/redis.service";

/** Where an AI job's programs run: the local AI runner of this server's judge, or any judge machine. */
export type AiExecutionMode = "local" | "judges";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The versioned runner wire payload is checked by the AI service's consumers.
type RunnerRequest = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- As above
type RunnerMessage = any;

interface AiExecutionExtraInfo {
  request: RunnerRequest;
  sampleFiles: { name: string; uuid: string }[];
  // A replay's kept files: links signed when the task is sent
  transfers?: { name: string; url: string; size: number; sha256: string }[];
}

/** A kept file a replay sends: the stored object, and its content. */
export interface AiReplayTransfer {
  name: string;
  object: string;
  size: number;
  sha256: string;
}

// How a job's result was come by: the operation, and where the result came from (see AiExecutionProvenance)
type RunnerOperation = Pick<AiExecutionProvenance, "origin" | "result" | "task" | "judgeRuntimeId"> & { key: string };

const localSocket = () => process.env.HYHOJ_AI_RUNNER_SOCKET || "/opt/LLMOJ/data/judge/ai-runner.sock";
const OBJECT_PREFIX = `${TEMPORARY_OBJECT_PREFIX}ai-execution/`;
const MAX_REQUEST = 16 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024 * 1024;
const MAX_FILES = 20000;
// What a generation writes, as the AI runner names its files: the test data (1.in, 1.out, …) and the sources it
// checked (make.cpp, std.cpp, …)
const isGeneratedFile = (name: unknown) =>
  typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) && name !== "result.json";
const SHA256 = /^[0-9a-f]{64}$/;
const POLL_INTERVAL = 1000;
const JOB_CHECK_INTERVAL = 2000;
// A run no judge machine has taken by then fails: none may be online that runs AI programs
const QUEUE_WAIT_LIMIT = 15 * 60 * 1000;
const SWEEP_INTERVAL = 10 * 60 * 1000;
// Failed and canceled runs and their objects are deleted this much later; their AI job has collected them by then.
// A completed run stays until its job acknowledges it, or for AI_RESULT_RETENTION.
const FINISHED_RETENTION = 60 * 60 * 1000;
// Longer than any run's execution budget (4 hours) and wait
const ACTIVE_LIMIT = 5 * 60 * 60 * 1000;
const REDIS_KEY_SWEEP_TURN = "ai-execution:sweep-turn";
const ACTIVE_STATES = [AiExecutionState.Queued, AiExecutionState.Running];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const requestObject = (taskId: string) => `${OBJECT_PREFIX}${taskId}/request.json`;
// A replay's kept files, as objects and their content (the judge gets links to them when it takes the task)
const transfersObject = (taskId: string) => `${OBJECT_PREFIX}${taskId}/transfers.json`;
// Runs of a job's own steps; a replay runs beside them
const WORKFLOW_OPERATIONS = ["generate", "validate-reference"];
const REPLAY_DIRECTORY = () => process.env.HYHOJ_AI_SAMPLE_INPUTS_DIR || "/opt/LLMOJ/data/ai-sample-inputs";
const fileObject = (taskId: string, name: string) => `${OBJECT_PREFIX}${taskId}/files/${name}`;
// A failed run's evidence, uploaded by the judge before it reports the failure
const evidenceUploadObject = (taskId: string, name: string) => `${OBJECT_PREFIX}${taskId}/evidence/${name}`;
const EVIDENCE_UPLOAD = "evidence/";
// Failures of the transport and time limits the backend observes itself, as typed failures
const OBSERVED_FAILURES: Record<string, AiFailureKind> = {
  SANDBOX_TIMEOUT: "budget_exhausted",
  SANDBOX_UNAVAILABLE: "infrastructure_error",
  SANDBOX_DISCONNECTED: "infrastructure_error",
  INVALID_SANDBOX_RESPONSE: "infrastructure_error",
  INVALID_SANDBOX_FILE: "infrastructure_error",
  TESTDATA_TOO_LARGE: "output_limit"
};
const MAX_FAILURE_FILE = 1024 * 1024;

/** How long a run may take: from its number of program runs, as the AI runner computes its own budget. */
export function aiExecutionBudget(request: RunnerRequest): number {
  return Math.min(
    4 * 60 * 60 * 1000,
    180000 +
      (request.cases.length +
        (request.samples?.length || 0) +
        (request.sampleFiles?.length || 0) +
        (request.protocolSamples?.length || 0) +
        (request.quality
          ? (request.quality.fuzzCases.length + request.cases.length + request.quality.extraAttempts) *
            (3 + request.quality.alternatives.length + request.quality.challenges.length)
          : 0) +
        // A replay's runs: its program, the one it's compared with, and the checker
        (request.replay ? request.replay.repeat * 3 : 0)) *
        Math.max(20000, (request.stdTimeLimitMs || 5000) * (request.problemType === "Communication" ? 2 : 1) + 15000)
  );
}

async function hashLocalFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Runs the programs of AI jobs (generators, reference solutions, validators, checkers) to make or check test data.
 * With a local AI runner (the `all` role), through its socket as before. Otherwise, as AiExecution tasks in the judge
 * queue, which any judge machine of protocol version 4 takes: the request and the generated files go through
 * storage, and the AI job gets the same result as from the local runner. LLMOJ_AI_EXECUTION=local|judges chooses
 * explicitly.
 */
@Injectable()
export class AiExecutionService
  implements JudgeTaskService<AiExecutionProgress, AiExecutionExtraInfo>, OnModuleInit, OnModuleDestroy
{
  // Each job keeps the mode its run started with, until it's cleaned up
  private readonly modes = new Map<string, AiExecutionMode>();

  // Failures whose runner reported them with evidence (recorded or not): not recorded again as unclassified
  private reportedFailures: WeakSet<object>;

  private get reported() {
    // Tests build this service without its constructor
    this.reportedFailures ||= new WeakSet();
    return this.reportedFailures;
  }

  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    private readonly fileService: FileService,
    private readonly judgeQueueService: JudgeQueueService,
    @Inject(forwardRef(() => JudgeGateway))
    private readonly judgeGateway: JudgeGateway,
    private readonly redisService: RedisService,
    @Optional()
    private readonly evidence?: AiEvidenceService
  ) {
    this.judgeQueueService.registerTaskType(JudgeTaskType.AiExecution, this);
  }

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      this.sweepTurn().catch(e => logger.error(`Failed to clean up AI runs on judge machines: ${e}`));
    }, SWEEP_INTERVAL);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweepTimer);
  }

  private get repository() {
    return this.connection.getRepository(AiExecutionEntity);
  }

  /** Where the job's programs run; the same for the whole job until `cleanup`. */
  mode(jobId: string): AiExecutionMode {
    let mode = this.modes.get(jobId);
    if (!mode) {
      const forced = process.env.LLMOJ_AI_EXECUTION;
      if (forced === "local" || forced === "judges") mode = forced;
      else {
        try {
          mode = statSync(localSocket()).isSocket() ? "local" : "judges";
        } catch {
          mode = "judges";
        }
      }
      this.modes.set(jobId, mode);
    }
    return mode;
  }

  /** The directory a generation's files are in on this server. */
  outputDirectory(jobId: string): string {
    return this.mode(jobId) === "local"
      ? path.join(process.env.HYHOJ_AI_GENERATED_DIR || "/opt/LLMOJ/data/ai-generated", jobId)
      : path.join(os.tmpdir(), "ai-execution", jobId);
  }

  /**
   * Runs a request as the local AI runner takes it. Sample files carry the stored files they are (`inputUuid`,
   * `outputUuid`). Resolves with the runner's "complete" message, and `operation`: the logical operation it is (see
   * ai-operation.ts) and where its result came from. A result of the same operation is collected again rather than
   * made again, until the job acknowledges it.
   */
  async run(
    job: AiJobEntity,
    request: RunnerRequest,
    progress: (value: RunnerMessage) => Promise<void>,
    checkJob: () => Promise<unknown>
  ): Promise<RunnerMessage> {
    let phase = "queued";
    const report = async (value: RunnerMessage) => {
      if (value?.phase) phase = String(value.phase);
      await progress(value);
    };
    // Its key covers the stored files the sample files are; the runner gets their names
    const key = aiOperationKey(job.id, request);
    const keyed = { ...request, operationKey: key };
    try {
      if (this.mode(job.id) === "local") {
        await this.harvestLocal(job);
        const { reused, ...message } = await this.runLocal(
          job,
          {
            ...keyed,
            ...(request.sampleFiles
              ? {
                  sampleFiles: request.sampleFiles.map(({ inputFile, outputFile }) => ({ inputFile, outputFile }))
                }
              : {})
          },
          report,
          checkJob
        );
        const operation: RunnerOperation = { key, origin: "local", result: reused ? "collected-again" : "new" };
        return { ...message, operation };
      }
      return await this.runQueued(job, keyed, report, checkJob);
    } catch (error) {
      await this.observe(job, request, error, phase);
      throw error;
    }
  }

  // Failed runs' observations (review Part III, W01)

  // How a failure of this run is recorded: a tutorial's solution that fails its check doesn't end the job
  private recordOptions(job: AiJobEntity, operation: string, candidateFailure: boolean): RecordOptions {
    return {
      runToken: job.runToken,
      ...(operation === "validate-reference" && candidateFailure ? { context: "tutorial-reference" as const } : {})
    };
  }

  // Records a run's failure with its evidence; returns its observation, or nothing if it couldn't be recorded
  private async recordFailure(
    job: AiJobEntity,
    failure: AiRunFailure,
    source: EvidenceSource,
    options: RecordOptions
  ): Promise<string> {
    if (!this.evidence) return undefined;
    try {
      return await this.evidence.record(job, failure, source, options);
    } catch (e) {
      logger.error(`Failed to record the failure of an AI run of job ${job.id}: ${e}`);
      return undefined;
    }
  }

  // Records a failure without evidence of the runner's (the backend's own observation), unless one is recorded
  private async observe(job: AiJobEntity, request: RunnerRequest, error: unknown, phase: string) {
    if (!this.evidence || !(error instanceof AiError) || error.observationId || this.reported.has(error)) return;
    const kind =
      error.code === "SANDBOX_GENERATION_FAILED" ? "unclassified" : (OBSERVED_FAILURES[error.code] as AiFailureKind);
    if (!kind) return;
    const operation = request.operation === "validate-reference" ? "validate-reference" : "generate";
    try {
      error.observationId = await this.evidence.recordObserved(
        job,
        randomUUID(),
        {
          kind,
          phase,
          summary: error.message,
          ...(kind === "unclassified"
            ? {
                evidenceError:
                  this.mode(job.id) === "local"
                    ? "The AI runner kept no evidence"
                    : "The judge machine kept no evidence: update it (judge protocol version 6)"
              }
            : {})
        },
        operation,
        this.recordOptions(job, operation, error.candidateFailure === true)
      );
    } catch (e) {
      logger.error(`Failed to record the failure of an AI run of job ${job.id}: ${e}`);
    }
  }

  // The local runner's evidence, in the job's directory until its cleanup
  private localEvidence(jobId: string): EvidenceSource {
    const directory = path.join(this.outputDirectory(jobId), "failure");
    return {
      origin: "local",
      fetch: async name => (AI_EVIDENCE_FILE.test(name) ? { path: path.join(directory, name) } : null)
    };
  }

  // A judge machine's evidence, uploaded with its run; copied here to be checked and stored
  private judgeEvidence(taskId: string): EvidenceSource {
    return {
      origin: "judge",
      fetch: async (name, size) => {
        if (!AI_EVIDENCE_FILE.test(name)) return null;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-evidence-"));
        const done = () => fs.rm(directory, { recursive: true, force: true });
        try {
          await this.fileService.downloadFileToPath(
            evidenceUploadObject(taskId, name),
            path.join(directory, name),
            size
          );
        } catch {
          await done();
          return null;
        }
        return { path: path.join(directory, name), done };
      }
    };
  }

  // A failure the local runner kept but wasn't recorded (e.g. the backend restarted): recorded before the next run
  private async harvestLocal(job: AiJobEntity) {
    if (!this.evidence) return;
    let file: fs.FileHandle;
    try {
      file = await fs.open(
        path.join(this.outputDirectory(job.id), "failure", "failure.json"),
        // eslint-disable-next-line no-bitwise
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
    } catch {
      return;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FAILURE_FILE) return;
      const failure = parseAiRunFailure(JSON.parse(await file.readFile("utf8")));
      if (failure)
        await this.evidence.record(job, failure, this.localEvidence(job.id), {
          ...(failure.operation === "validate-reference" ? { context: "tutorial-reference" as const } : {})
        });
    } catch (e) {
      logger.error(`Failed to record an earlier failure of an AI run of job ${job.id}: ${e}`);
    } finally {
      await file.close();
    }
  }

  /**
   * Failed runs of a judge machine whose failure wasn't recorded (e.g. the backend restarted): recorded, then removed.
   * Returns those that couldn't be recorded.
   */
  private async harvestFailed(where: { jobId?: string; taskId?: string }): Promise<string[]> {
    const unrecorded: string[] = [];
    if (!this.evidence) return unrecorded;
    const failed = await this.repository.find({ where: { ...where, state: AiExecutionState.Failed } });
    for (const execution of failed) {
      const failure = parseAiRunFailure(execution.result?.failure);
      // eslint-disable-next-line no-await-in-loop -- Few
      const job = failure ? await this.connection.getRepository(AiJobEntity).findOneBy({ id: execution.jobId }) : null;
      if (job) {
        try {
          // eslint-disable-next-line no-await-in-loop -- One at a time
          await this.evidence.record(job, failure, this.judgeEvidence(execution.taskId), {
            ...(failure.operation === "validate-reference" && execution.result?.candidateFailure
              ? { context: "tutorial-reference" as const }
              : {})
          });
        } catch (e) {
          logger.error(`Failed to record the failure of AI run ${execution.taskId}: ${e}`);
          unrecorded.push(execution.taskId);
          continue;
        }
      }
      // eslint-disable-next-line no-await-in-loop -- One at a time
      await this.removeExecution(execution.taskId);
    }
    return unrecorded;
  }

  /**
   * The job published its result, and its checkpoint says so: everything its runs left is deleted (the local runner's
   * output, builds and inputs; or the runs on judge machines, their objects and the downloaded files).
   */
  async acknowledge(jobId: string): Promise<void> {
    await this.finish(jobId, true);
  }

  /** The job was canceled: as when it acknowledges its result, nothing of its runs is kept. */
  async discard(jobId: string): Promise<void> {
    await this.finish(jobId, true);
  }

  /**
   * The job stopped without publishing (it failed, or its run ended): its unfinished runs stop, and a completed one
   * stays for a retry of the same operation to collect, for AI_RESULT_RETENTION.
   */
  async release(jobId: string): Promise<void> {
    await this.finish(jobId, false);
  }

  /** As `discard` (before review Part III, W03, a job's runs left nothing to collect again). */
  async cleanup(jobId: string): Promise<void> {
    await this.discard(jobId);
  }

  private async finish(jobId: string, removeResults: boolean) {
    const mode = this.mode(jobId);
    this.modes.delete(jobId);
    if (mode === "local") {
      // The local runner keeps a completed result (and the job's builds and inputs) until it's asked to clean up
      if (removeResults) await this.cleanupLocal(jobId);
      return;
    }
    await this.cancelJobExecutions(jobId);
    if (removeResults)
      for (const execution of await this.workflowRuns(jobId))
        // eslint-disable-next-line no-await-in-loop -- Few
        await this.retire(execution);
    await fs.rm(path.join(os.tmpdir(), "ai-execution", jobId), { recursive: true, force: true });
  }

  // The runs of a job's steps (not its replays), latest first
  private async workflowRuns(jobId: string): Promise<AiExecutionEntity[]> {
    const rows = await this.repository.find({ where: { jobId }, order: { createdAt: "DESC" } });
    return rows.filter(row => WORKFLOW_OPERATIONS.includes(row.operation || "generate"));
  }

  // A run the job no longer collects: stopped if unfinished, its failure recorded if it can be, and removed
  private async retire(execution: AiExecutionEntity) {
    if (ACTIVE_STATES.includes(execution.state)) await this.cancelExecution(execution.taskId);
    else if (execution.state === AiExecutionState.Failed) await this.harvestFailed({ taskId: execution.taskId });
    else await this.removeExecution(execution.taskId);
  }

  // The local AI runner

  private cleanupLocal(jobId: string): Promise<void> {
    return new Promise(resolve => {
      const socket = createConnection(localSocket());
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 10000);
      socket.on("connect", () => socket.write(`${JSON.stringify({ operation: "cleanup", jobId })}\n`));
      socket.on("data", () => socket.end());
      socket.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private runLocal(
    job: AiJobEntity,
    request: RunnerRequest,
    progress: (value: RunnerMessage) => Promise<void>,
    checkJob: () => Promise<unknown>
  ): Promise<RunnerMessage> {
    const signal = currentAiRuntime()?.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(aiCancellationError(signal));
        return;
      }
      const serialized = `${JSON.stringify(request)}\n`;
      if (Buffer.byteLength(serialized) > MAX_REQUEST) {
        reject(new AiError("SAMPLES_TOO_LARGE"));
        return;
      }
      const socket = createConnection(localSocket());
      let buffer = "";
      let settled = false;
      let chain = Promise.resolve();
      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(error);
        }
      };
      const timer = setTimeout(() => fail(new AiError("SANDBOX_TIMEOUT")), aiExecutionBudget(request));
      const cancelTimer = setInterval(() => {
        checkJob().catch(fail);
      }, JOB_CHECK_INTERVAL);
      const abort = () => fail(aiCancellationError(signal));
      signal?.addEventListener("abort", abort, { once: true });
      socket.on("connect", () => socket.write(serialized));
      socket.on("data", chunk => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 1024 * 1024) {
          fail(new AiError("INVALID_SANDBOX_RESPONSE"));
          return;
        }
        while (buffer.includes("\n")) {
          const at = buffer.indexOf("\n");
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          chain = chain
            // eslint-disable-next-line no-loop-func -- This callback runs in an awaited serial chain; shared state is intentional.
            .then(async () => {
              let message: RunnerMessage;
              try {
                message = JSON.parse(line);
              } catch {
                throw new AiError("INVALID_SANDBOX_RESPONSE");
              }
              if (message.type === "progress") await progress(message);
              else if (message.type === "error") {
                const error = new AiError("SANDBOX_GENERATION_FAILED", String(message.message || "").slice(0, 2000));
                error.candidateFailure = message.candidateFailure === true;
                // Kept before the job's output directory, where the evidence is, is cleaned up
                const failure = parseAiRunFailure(message.failure);
                if (failure) {
                  this.reported.add(error);
                  [error.failure] = failure.observations;
                }
                if (failure)
                  error.observationId = await this.recordFailure(
                    job,
                    failure,
                    this.localEvidence(job.id),
                    this.recordOptions(job, request.operation, error.candidateFailure)
                  );
                throw error;
              } else if (message.type === "complete") {
                settled = true;
                socket.end();
                resolve(message);
              }
            })
            .catch(fail);
        }
      });
      socket.on("error", () => fail(new AiError("SANDBOX_UNAVAILABLE")));
      socket.on("close", () => {
        clearTimeout(timer);
        clearInterval(cancelTimer);
        signal?.removeEventListener("abort", abort);
        chain.then(() => {
          if (!settled) fail(new AiError("SANDBOX_DISCONNECTED"));
        });
      });
    });
  }

  // Judge machines

  private async runQueued(
    job: AiJobEntity,
    request: RunnerRequest,
    progress: (value: RunnerMessage) => Promise<void>,
    checkJob: () => Promise<unknown>
  ): Promise<RunnerMessage> {
    const signal = currentAiRuntime()?.signal;
    if (signal?.aborted) throw aiCancellationError(signal);
    const sampleFiles: AiExecutionEntity["sampleFiles"] = [];
    for (const sample of request.sampleFiles || []) {
      if (!sample.inputUuid || !sample.outputUuid) throw new AiError("HIDDEN_SAMPLE_FILE_MISSING");
      sampleFiles.push(
        { name: sample.inputFile, uuid: sample.inputUuid },
        { name: sample.outputFile, uuid: sample.outputUuid }
      );
    }
    const runnerRequest = {
      ...request,
      ...(request.sampleFiles
        ? { sampleFiles: request.sampleFiles.map(({ inputFile, outputFile }) => ({ inputFile, outputFile })) }
        : {})
    };
    const serialized = Buffer.from(JSON.stringify(runnerRequest));
    if (serialized.length > MAX_REQUEST) throw new AiError("SAMPLES_TOO_LARGE");

    // The job's runs from before (e.g. before the backend restarted). A run of another operation is never attached
    // to or collected: it's stopped, or recorded and removed.
    const key: string = request.operationKey;
    const runs = await this.workflowRuns(job.id);
    for (const execution of runs.filter(row => row.operationKey !== key))
      // eslint-disable-next-line no-await-in-loop -- Few
      await this.retire(execution);
    const same = runs.filter(row => row.operationKey === key);
    // A completed run of this operation, made under the current contract: collected again
    for (const execution of same.filter(row => row.state === AiExecutionState.Complete)) {
      if (currentExecution(execution.result?.result))
        // eslint-disable-next-line no-await-in-loop -- Once
        return await this.collect(job, request, execution, "collected-again");
      // eslint-disable-next-line no-await-in-loop -- At most a few
      await this.removeExecution(execution.taskId);
    }
    // An unfinished one: waited for again (the judge queue runs it again if its judge machine restarted meanwhile)
    let taskId = same.find(row => ACTIVE_STATES.includes(row.state))?.taskId;
    let result: RunnerOperation["result"] = "resumed";
    if (taskId) logger.log(`AI job ${job.id} waits again for its run on a judge machine (task ${taskId})`);
    else {
      // A failure of this operation that the job never took (its backend restarted after the run failed) is the
      // operation's outcome, taken once. One it took is recorded already (or now), and a new attempt runs.
      const failed = same.find(row => row.state === AiExecutionState.Failed && !row.collectedAt);
      if (failed) await this.takeFailure(job, request, failed);
      for (const execution of same.filter(row => row.state === AiExecutionState.Failed))
        // eslint-disable-next-line no-await-in-loop -- Few
        await this.harvestFailed({ taskId: execution.taskId });
      taskId = await this.dispatch(job.id, key, request.operation || "generate", serialized, sampleFiles);
      result = "new";
    }
    for (const execution of same.filter(row => ACTIVE_STATES.includes(row.state) && row.taskId !== taskId))
      // eslint-disable-next-line no-await-in-loop -- Few
      await this.cancelExecution(execution.taskId);
    return await this.waitFor(taskId, request, signal, checkJob, progress, async execution => {
      if (execution.state === AiExecutionState.Complete) return await this.collect(job, request, execution, result);
      return await this.takeFailure(job, request, execution);
    });
  }

  // Queues a new attempt of an operation; returns its task ID
  private async dispatch(
    jobId: string,
    operationKey: string,
    operation: string,
    serialized: Buffer,
    sampleFiles: AiExecutionEntity["sampleFiles"],
    transfers?: AiReplayTransfer[]
  ): Promise<string> {
    const taskId = randomUUID();
    await this.fileService.putTemporaryObject(requestObject(taskId), serialized);
    if (transfers)
      await this.fileService.putTemporaryObject(transfersObject(taskId), Buffer.from(JSON.stringify(transfers)));
    await this.connection.transaction("READ COMMITTED", async manager => {
      await manager.insert(AiExecutionEntity, {
        taskId,
        jobId,
        state: AiExecutionState.Queued,
        sampleFiles,
        progress: null,
        result: null,
        uploads: null,
        createdAt: new Date(),
        finishedAt: null,
        operationKey,
        operation,
        collectedAt: null
      });
      await this.judgeQueueService.enqueue(taskId, JudgeTaskType.AiExecution, JudgeTaskPriorityType.Lowest, manager);
    });
    this.judgeQueueService.notifyJobsAvailable();
    logger.log(`AI job ${jobId} runs its programs on a judge machine (task ${taskId}, ${operation})`);
    return taskId;
  }

  // Waits for a run to finish, reporting its progress; `finished` takes its result or failure
  private async waitFor(
    taskId: string,
    request: RunnerRequest,
    signal: AbortSignal,
    checkJob: () => Promise<unknown>,
    progress: (value: RunnerMessage) => Promise<void>,
    finished: (execution: AiExecutionEntity) => Promise<RunnerMessage>
  ): Promise<RunnerMessage> {
    const started = Date.now();
    const deadline = started + QUEUE_WAIT_LIMIT + aiExecutionBudget(request);
    let checked = Date.now();
    let reported = "";
    try {
      for (;;) {
        if (signal?.aborted) throw aiCancellationError(signal);
        if (Date.now() - checked >= JOB_CHECK_INTERVAL) {
          // eslint-disable-next-line no-await-in-loop -- Polled in turn
          await checkJob();
          checked = Date.now();
        }
        // eslint-disable-next-line no-await-in-loop -- Polled in turn
        const execution = await this.repository.findOneBy({ taskId });
        if (!execution) throw new AiError("SANDBOX_DISCONNECTED");
        if (execution.progress && JSON.stringify(execution.progress) !== reported) {
          reported = JSON.stringify(execution.progress);
          // eslint-disable-next-line no-await-in-loop -- Reported in order
          await progress({ type: "progress", ...execution.progress });
        }
        if (execution.state === AiExecutionState.Complete || execution.state === AiExecutionState.Failed)
          // eslint-disable-next-line no-await-in-loop -- Once
          return await finished(execution);
        if (execution.state === AiExecutionState.Canceled) throw new AiError("SANDBOX_DISCONNECTED");
        if (execution.state === AiExecutionState.Queued && Date.now() - started > QUEUE_WAIT_LIMIT)
          throw new AiError(
            "SANDBOX_UNAVAILABLE",
            `No judge machine took the AI run within 15 minutes; one of protocol version ${AI_EXECUTION_PROTOCOL_VERSION} must be online`
          );
        if (Date.now() > deadline) throw new AiError("SANDBOX_TIMEOUT");
        // eslint-disable-next-line no-await-in-loop -- Polled in turn
        await sleep(POLL_INTERVAL);
      }
    } catch (error) {
      // A job that lost its lease (another backend runs it now) attaches to the run again; otherwise nobody waits for
      // it any more. A no-op once it has finished.
      if (!(error instanceof AiError && error.code === "JOB_LEASE_LOST"))
        await this.cancelExecution(taskId).catch(e => logger.error(`Failed to cancel AI run ${taskId}: ${e}`));
      throw error;
    }
  }

  // Takes a failed run's outcome: its failure is recorded with its evidence and the run removed, or else the run is
  // marked taken (it's never taken again; the sweep records what it can and removes it)
  private async takeFailure(job: AiJobEntity, request: RunnerRequest, execution: AiExecutionEntity): Promise<never> {
    const error = new AiError("SANDBOX_GENERATION_FAILED", String(execution.result?.message || "").slice(0, 2000));
    error.candidateFailure = execution.result?.candidateFailure === true;
    const failure = parseAiRunFailure(execution.result?.failure);
    if (failure) {
      this.reported.add(error);
      [error.failure] = failure.observations;
      error.observationId = await this.recordFailure(
        job,
        failure,
        this.judgeEvidence(execution.taskId),
        this.recordOptions(job, request.operation, error.candidateFailure)
      );
    }
    if (error.observationId) await this.removeExecution(execution.taskId);
    else await this.repository.update({ taskId: execution.taskId }, { collectedAt: new Date() });
    throw error;
  }

  // Downloads the files the judge generated and checks them against what it reported. The run stays until the job
  // acknowledges it: a job that stops before (a restart, a failed publication) collects it again.
  private async collect(
    job: AiJobEntity,
    request: RunnerRequest,
    execution: AiExecutionEntity,
    result: RunnerOperation["result"]
  ): Promise<RunnerMessage> {
    const files = execution.result.files || [];
    const allowed = new Map((execution.uploads || []).map(file => [file.name, file.size]));
    const names = new Set<string>();
    let total = 0;
    for (const file of files) {
      if (
        !file ||
        !isGeneratedFile(file.name) ||
        names.has(file.name) ||
        allowed.get(file.name) !== file.size ||
        !SHA256.test(file.sha256)
      )
        throw new AiError("INVALID_SANDBOX_RESPONSE");
      names.add(file.name);
      total += file.size;
    }
    if (total > MAX_TOTAL) throw new AiError("TESTDATA_TOO_LARGE");
    const directory = this.outputDirectory(job.id);
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const target = path.join(directory, file.name);
      // eslint-disable-next-line no-await-in-loop -- One at a time
      await this.fileService.downloadFileToPath(fileObject(execution.taskId, file.name), target, file.size);
      // eslint-disable-next-line no-await-in-loop -- One at a time
      if ((await fs.stat(target)).size !== file.size || (await hashLocalFile(target)) !== file.sha256)
        throw new AiError("INVALID_SANDBOX_FILE");
    }
    if (!execution.collectedAt)
      await this.repository.update({ taskId: execution.taskId, collectedAt: IsNull() }, { collectedAt: new Date() });
    const operation: RunnerOperation = {
      key: execution.operationKey,
      origin: "judge",
      result,
      task: execution.taskId,
      ...(Number.isSafeInteger(execution.result.judgeRuntimeId)
        ? { judgeRuntimeId: execution.result.judgeRuntimeId }
        : {})
    };
    return {
      ...execution.result.result,
      type: "complete",
      ...(request.operation === "validate-reference" ? {} : { directory }),
      files: files.map(file => file.name),
      operation
    };
  }

  private async cancelJobExecutions(jobId: string): Promise<void> {
    for (const { taskId, state } of await this.workflowRuns(jobId))
      // eslint-disable-next-line no-await-in-loop -- Few
      if (ACTIVE_STATES.includes(state)) await this.cancelExecution(taskId);
  }

  /**
   * Runs a replay of a kept failure (operation "replay") where the job's programs run: the kept files go to the local
   * runner as sample files, or to a judge machine as links it downloads. Resolves with the runner's "complete"
   * message, and `operation` (where it ran). A replay runs beside the job's own runs and never replaces them.
   */
  async replay(job: AiJobEntity, request: RunnerRequest, transfers: AiReplayTransfer[]): Promise<RunnerMessage> {
    const key = aiOperationKey(job.id, {
      ...request,
      transfers: transfers.map(({ name, sha256 }) => ({ name, sha256 }))
    });
    const keyed = { ...request, operationKey: key, cases: [] };
    if (this.mode(job.id) === "local") {
      const directory = path.join(REPLAY_DIRECTORY(), job.id);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        for (const transfer of transfers) {
          const target = path.join(directory, transfer.name);
          // eslint-disable-next-line no-await-in-loop -- At most three
          await fs.rm(target, { force: true });
          // eslint-disable-next-line no-await-in-loop -- At most three
          await this.fileService.downloadFileToPath(transfer.object, target, transfer.size);
          // eslint-disable-next-line no-await-in-loop -- At most three
          if ((await hashLocalFile(target)) !== transfer.sha256) throw new AiError("EVIDENCE_UNAVAILABLE");
        }
        const message = await this.runLocal(
          job,
          keyed,
          async () => undefined,
          async () => undefined
        );
        const operation: RunnerOperation = { key, origin: "local", result: "new" };
        return { ...message, operation };
      } finally {
        for (const transfer of transfers)
          // eslint-disable-next-line no-await-in-loop -- At most three
          await fs.rm(path.join(directory, transfer.name), { force: true });
      }
    }
    const serialized = Buffer.from(JSON.stringify(keyed));
    if (serialized.length > MAX_REQUEST) throw new AiError("SAMPLES_TOO_LARGE");
    const taskId = await this.dispatch(job.id, key, "replay", serialized, [], transfers);
    try {
      return await this.waitFor(
        taskId,
        keyed,
        undefined,
        async () => undefined,
        async () => undefined,
        async execution => {
          if (execution.state === AiExecutionState.Failed)
            throw new AiError("SANDBOX_GENERATION_FAILED", String(execution.result?.message || "").slice(0, 2000));
          const operation: RunnerOperation = {
            key,
            origin: "judge",
            result: "new",
            task: taskId,
            ...(Number.isSafeInteger(execution.result.judgeRuntimeId)
              ? { judgeRuntimeId: execution.result.judgeRuntimeId }
              : {})
          };
          return { ...execution.result.result, type: "complete", operation };
        }
      );
    } finally {
      await this.removeExecution(taskId).catch(e => logger.error(`Failed to remove AI replay ${taskId}: ${e}`));
    }
  }

  // Stops an unfinished run, also on the judge machine running it
  private async cancelExecution(taskId: string): Promise<void> {
    const { affected } = await this.repository.update(
      { taskId, state: In(ACTIVE_STATES) },
      { state: AiExecutionState.Canceled, finishedAt: new Date() }
    );
    if (affected) this.judgeGateway.cancelTask(taskId);
  }

  private async removeExecution(taskId: string): Promise<void> {
    await this.repository.delete({ taskId });
    const objects = await this.fileService.listTemporaryObjects(`${OBJECT_PREFIX}${taskId}/`);
    if (objects.length) await this.fileService.removeTemporaryObjects(objects.map(object => object.name));
  }

  // The judge queue

  async getTaskToBeSentToJudgeByTaskId(taskId: string, priority: number): Promise<JudgeTask<AiExecutionExtraInfo>> {
    const execution = await this.repository.findOneBy({ taskId, state: In(ACTIVE_STATES) });
    if (!execution) return null;
    const request = JSON.parse((await this.fileService.readObject(requestObject(taskId), MAX_REQUEST)).toString());
    // A replay's kept files: links for this judge, signed now
    const transfers: AiExecutionExtraInfo["transfers"] = [];
    if (execution.operation === "replay")
      for (const transfer of JSON.parse(
        (await this.fileService.readObject(transfersObject(taskId), 64 * 1024)).toString()
      ) as AiReplayTransfer[])
        transfers.push({
          name: transfer.name,
          size: transfer.size,
          sha256: transfer.sha256,
          // eslint-disable-next-line no-await-in-loop -- At most three
          url: await this.fileService.signDownloadLink({
            uuid: transfer.object,
            downloadFilename: null,
            expiresSeconds: JUDGE_FILE_DOWNLOAD_EXPIRE_TIME,
            signFor: MinioSignFor.Judge
          })
        });
    await this.repository.update({ taskId, state: AiExecutionState.Queued }, { state: AiExecutionState.Running });
    return new JudgeTask<AiExecutionExtraInfo>(
      taskId,
      JudgeTaskType.AiExecution,
      JudgeTaskPriorityType.Lowest,
      priority,
      {
        request,
        sampleFiles: execution.sampleFiles,
        ...(transfers.length ? { transfers } : {})
      }
    );
  }

  async onTaskProgress(
    taskId: string,
    progress: AiExecutionProgress,
    completion?: JudgeTaskCompletion
  ): Promise<boolean> {
    if (!progress || typeof progress !== "object") return false;
    if (!progress.finished) {
      const { affected } = await this.repository.update(
        { taskId, state: In(ACTIVE_STATES) },
        {
          state: AiExecutionState.Running,
          progress: {
            phase: String(progress.phase || "").slice(0, 64),
            completed: Number(progress.completed) || 0,
            total: Number(progress.total) || 0
          }
        }
      );
      return affected === 1;
    }
    const valid =
      (progress.status === "Complete" &&
        progress.result &&
        typeof progress.result === "object" &&
        Array.isArray(progress.files) &&
        progress.files.length <= MAX_FILES) ||
      progress.status === "Failed";
    const result: AiExecutionProgress = valid
      ? {
          finished: true,
          status: progress.status,
          ...(progress.status === "Complete"
            ? { result: progress.result, files: progress.files }
            : {
                message: String(progress.message || "").slice(0, 2000),
                candidateFailure: progress.candidateFailure === true,
                ...(parseAiRunFailure(progress.failure) ? { failure: parseAiRunFailure(progress.failure) } : {})
              })
        }
      : { finished: true, status: "Failed", message: "The judge machine sent an invalid result" };
    return await this.connection.transaction("READ COMMITTED", async manager => {
      if (completion && !(await completion.confirm(manager))) return false;
      const { affected } = await manager.update(
        AiExecutionEntity,
        { taskId, state: In(ACTIVE_STATES) },
        {
          state: result.status === "Complete" ? AiExecutionState.Complete : AiExecutionState.Failed,
          // With the runtime the backend recorded for the judge machine
          result: {
            ...result,
            ...(Number.isSafeInteger(completion?.judgeRuntimeId) ? { judgeRuntimeId: completion.judgeRuntimeId } : {})
          },
          finishedAt: new Date()
        }
      );
      return affected === 1;
    });
  }

  async listActiveTasks(): Promise<{ taskId: string; priority: number }[]> {
    const active = await this.repository.find({ select: ["taskId"], where: { state: In(ACTIVE_STATES) } });
    return active.map(({ taskId }) => ({ taskId, priority: JudgeTaskPriorityType.Lowest }));
  }

  async onTaskFailed(taskId: string, message: string): Promise<void> {
    await this.repository.update(
      { taskId, state: In(ACTIVE_STATES) },
      { state: AiExecutionState.Failed, result: { finished: true, status: "Failed", message }, finishedAt: new Date() }
    );
  }

  /**
   * Upload forms for the files a run generated, each for exactly its size; or for a failed run's evidence, named and
   * bounded as AiRunFailure allows, before the run reports its failure.
   */
  async signUploads(
    taskId: string,
    files: { name: string; size: number }[],
    evidence = false
  ): Promise<JudgeUploadTarget[]> {
    const execution = await this.repository.findOneBy({ taskId, state: AiExecutionState.Running });
    if (evidence) return execution ? await this.signEvidenceUploads(execution, files) : [];
    if (!execution || !Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return [];
    const names = new Set<string>();
    let total = 0;
    for (const file of files) {
      if (
        !file ||
        !isGeneratedFile(file.name) ||
        names.has(file.name) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > MAX_FILE
      )
        return [];
      names.add(file.name);
      total += file.size;
    }
    if (total > MAX_TOTAL) return [];
    const uploads = [
      ...(execution.uploads || []).filter(upload => upload.name.startsWith(EVIDENCE_UPLOAD)),
      ...files.map(({ name, size }) => ({ name, size }))
    ];
    await this.repository.update({ taskId, state: AiExecutionState.Running }, { uploads });
    return await Promise.all(
      uploads.map(async ({ name, size }) => {
        const signed = await this.fileService.signJudgeUpload(fileObject(taskId, name), size);
        return {
          name,
          url: signed.url,
          extraFormData: signed.extraFormData as Record<string, string>,
          fileFieldName: signed.fileFieldName
        };
      })
    );
  }

  private async signEvidenceUploads(
    execution: AiExecutionEntity,
    files: { name: string; size: number }[]
  ): Promise<JudgeUploadTarget[]> {
    if (!Array.isArray(files) || !files.length || files.length > AI_EVIDENCE_LIMITS.observations * 4) return [];
    const names = new Set<string>();
    let total = 0;
    for (const file of files) {
      if (
        !file ||
        typeof file.name !== "string" ||
        !AI_EVIDENCE_FILE.test(file.name) ||
        names.has(file.name) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > AI_EVIDENCE_LIMITS.artifactBytes
      )
        return [];
      names.add(file.name);
      total += file.size;
    }
    if (total > AI_EVIDENCE_LIMITS.runBytes) return [];
    const uploads = [
      ...(execution.uploads || []).filter(upload => !upload.name.startsWith(EVIDENCE_UPLOAD)),
      ...files.map(({ name, size }) => ({ name: `${EVIDENCE_UPLOAD}${name}`, size }))
    ];
    await this.repository.update({ taskId: execution.taskId, state: AiExecutionState.Running }, { uploads });
    return await Promise.all(
      files.map(async ({ name, size }) => {
        const signed = await this.fileService.signJudgeUpload(evidenceUploadObject(execution.taskId, name), size);
        return {
          name,
          url: signed.url,
          extraFormData: signed.extraFormData as Record<string, string>,
          fileFieldName: signed.fileFieldName
        };
      })
    );
  }

  // Cleanup

  private async sweepTurn(): Promise<void> {
    let turn = true;
    try {
      turn = await this.redisService.takeTurn(REDIS_KEY_SWEEP_TURN, SWEEP_INTERVAL - 1000);
    } catch {
      /* clean up anyway */
    }
    if (turn) await this.sweep();
  }

  /** Stops runs that nobody waits for any more, and deletes old finished runs and the objects nothing refers to. */
  async sweep(now = Date.now()): Promise<void> {
    const stale = await this.repository.find({
      select: ["taskId"],
      where: { state: In(ACTIVE_STATES), createdAt: LessThan(new Date(now - ACTIVE_LIMIT)) }
    });
    // eslint-disable-next-line no-await-in-loop -- Few
    for (const { taskId } of stale) await this.cancelExecution(taskId);
    // A failed run nobody recorded (its job no longer waited) keeps its evidence: recorded first. One that can't be
    // recorded now is tried again, until it's as old as an active run may be.
    const failed = await this.repository.find({
      select: ["taskId"],
      where: { state: AiExecutionState.Failed, finishedAt: LessThan(new Date(now - FINISHED_RETENTION)) }
    });
    const retried: string[] = [];
    for (const { taskId } of failed)
      retried.push(
        // eslint-disable-next-line no-await-in-loop -- Few
        ...(await this.harvestFailed({ taskId }).catch(e => {
          logger.error(`Failed to record AI run ${taskId}: ${e}`);
          return [taskId];
        }))
      );
    // A completed run stays for its job to collect again (it's deleted when the job acknowledges it), for a while
    await this.repository.delete({
      state: In([AiExecutionState.Failed, AiExecutionState.Canceled]),
      finishedAt: LessThan(new Date(now - FINISHED_RETENTION)),
      ...(retried.length ? { taskId: Not(In(retried)) } : {})
    });
    await this.repository.delete({
      state: AiExecutionState.Complete,
      finishedAt: LessThan(new Date(now - AI_RESULT_RETENTION))
    });
    if (retried.length)
      await this.repository.delete({
        taskId: In(retried),
        finishedAt: LessThan(new Date(now - FINISHED_RETENTION - ACTIVE_LIMIT))
      });
    await this.evidence?.sweep(now);
    // Objects of runs that are gone. A run stores its request just before its row, so only old ones are deleted.
    const taskIdOf = (name: string) => name.slice(OBJECT_PREFIX.length).split("/")[0];
    const objects = (await this.fileService.listTemporaryObjects(OBJECT_PREFIX)).filter(
      object => +object.lastModified < now - FINISHED_RETENTION
    );
    const taskIds = [...new Set(objects.map(object => taskIdOf(object.name)))];
    const kept = new Set(
      taskIds.length
        ? (await this.repository.find({ select: ["taskId"], where: { taskId: In(taskIds) } })).map(row => row.taskId)
        : []
    );
    const unused = objects.filter(object => !kept.has(taskIdOf(object.name))).map(object => object.name);
    if (unused.length) await this.fileService.removeTemporaryObjects(unused);
  }
}
