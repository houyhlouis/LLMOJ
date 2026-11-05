import fs from "fs";
import path from "path";

import winston from "winston";
import type { AiExecutionProgress, AiRunFailure } from "@libreoj/judge-protocol";

import { Task } from "..";

import config from "../../config";
import rpc from "../../rpc";
import { CanceledError } from "../../error";
import { ensureFiles, getFile, hashFileAtPath } from "../../file";
import { Request, runGeneration, validate } from "../../aiRunner";
import { download, safelyJoinPath, uploadWithForm } from "../../utils";

export interface AiExecutionExtraInfo {
  // As the local AI runner gets it
  request: Request;
  // The stored files the request's sample files are, by name
  sampleFiles?: { name: string; uuid: string }[];
  // A replay's kept files (judge protocol version 8): where to download each, signed for this task, and its content
  transfers?: { name: string; url: string; size: number; sha256: string }[];
}

// What a generation writes, as the AI runner names its files: the test data (1.in, 1.out, …) and the sources it
// checked (make.cpp, std.cpp, …). Not its own result.json.
const isGeneratedFile = (name: unknown) =>
  typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) && name !== "result.json";
const UPLOAD_CONCURRENCY = 2;
const MAX_TRANSFER = 16 * 1024 * 1024;

/**
 * Uploads a failed run's evidence (see aiEvidence.ts) to where the server says, before the failure is reported and
 * the workspace removed. The failure is reported without its evidence when that can't be done.
 */
async function uploadEvidence(
  task: Task<AiExecutionExtraInfo, AiExecutionProgress>,
  failure: AiRunFailure,
  directory: string
) {
  const artifacts = failure.observations.flatMap(observation => observation.artifacts);
  if (!artifacts.length) return failure;
  try {
    rpc.ensureNotCanceled(task.taskId);
    const targets = await rpc.requestUploads({
      taskId: task.taskId,
      files: artifacts.map(({ name, size }) => ({ name, size })),
      evidence: true
    });
    if (
      !Array.isArray(targets) ||
      targets.length !== artifacts.length ||
      targets.some((target, i) => target?.name !== artifacts[i].name)
    )
      throw new Error("The server refused to take the evidence");
    for (const target of targets) {
      rpc.ensureNotCanceled(task.taskId);
      // eslint-disable-next-line no-await-in-loop -- One at a time; at most 64 MiB together
      const data = await fs.promises.readFile(path.join(directory, target.name), {
        // eslint-disable-next-line no-bitwise
        flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
      });
      // eslint-disable-next-line no-await-in-loop -- One at a time
      await uploadWithForm(target, data, `evidence ${target.name}`);
    }
    return failure;
  } catch (error) {
    if (error instanceof CanceledError) throw error;
    const reason = `The evidence couldn't be uploaded (${String(error?.message || error).slice(0, 100)})`;
    winston.warn(`AI execution task ${task.taskId}: ${reason}`);
    return {
      ...failure,
      observations: failure.observations.map(observation => ({
        ...observation,
        artifacts: [],
        ...(observation.artifacts.length ? { evidenceError: reason } : {})
      }))
    };
  }
}

/**
 * Runs an AI job's programs like the local AI runner does, in this judge's sandbox and execution slots, and uploads
 * the files they generated to where the server says. The server then checks and publishes them.
 */
export default async function onAiExecution(task: Task<AiExecutionExtraInfo, AiExecutionProgress>) {
  const work = safelyJoinPath(config.dataStore, "ai-work", task.taskId);
  const samples = path.join(work, "samples");
  const output = path.join(work, "output");
  const evidence = path.join(work, "evidence");
  try {
    const { request, sampleFiles = [] } = task.extraInfo;
    validate(request);
    if (request.operation === "cleanup") throw new Error("Unsupported AI runner operation");
    await fs.promises.rm(work, { recursive: true, force: true });
    await fs.promises.mkdir(samples, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(output, { mode: 0o700 });

    // The sample files, from the stored files they are (checked against their content hashes)
    const stored = new Map(sampleFiles.map(file => [file.name, file.uuid]));
    const names = [...new Set((request.sampleFiles || []).flatMap(sample => [sample.inputFile, sample.outputFile]))];
    if (names.some(name => !stored.has(name))) throw new Error("A sample file of the request wasn't sent");
    await ensureFiles(
      names.map(name => stored.get(name)),
      task.fileHashes
    );
    for (const name of names) {
      rpc.ensureNotCanceled(task.taskId);
      // eslint-disable-next-line no-await-in-loop -- One at a time
      await fs.promises.copyFile(getFile(stored.get(name)), path.join(samples, name));
    }

    // A replay's kept files, each checked against its size and SHA-256
    const transfers = task.extraInfo.transfers || [];
    const kept = request.operation === "replay" ? Object.values(request.replay.files) : [];
    if (kept.length !== transfers.length || kept.some(name => !transfers.some(transfer => transfer?.name === name)))
      throw new Error("The replay's kept files weren't sent");
    for (const transfer of transfers) {
      if (
        !kept.includes(transfer.name) ||
        !Number.isSafeInteger(transfer.size) ||
        transfer.size < 0 ||
        transfer.size > MAX_TRANSFER ||
        typeof transfer.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(transfer.sha256) ||
        typeof transfer.url !== "string"
      )
        throw new Error("Invalid kept file");
      rpc.ensureNotCanceled(task.taskId);
      const target = path.join(samples, transfer.name);
      // eslint-disable-next-line no-await-in-loop -- One at a time
      await download(transfer.url, target, `kept file ${transfer.name}`);
      // eslint-disable-next-line no-await-in-loop -- One at a time
      const stat = await fs.promises.lstat(target);
      // eslint-disable-next-line no-await-in-loop -- One at a time
      if (!stat.isFile() || stat.size !== transfer.size || (await hashFileAtPath(target)) !== transfer.sha256)
        throw new Error(`The kept file ${transfer.name} isn't what the server recorded`);
    }

    let complete: Record<string, unknown> = null;
    await runGeneration(
      request,
      event => {
        if (event.type === "complete") complete = event;
        else if (event.type === "progress")
          task.reportProgressRaw({
            finished: false,
            phase: String(event.phase),
            completed: Number(event.completed) || 0,
            total: Number(event.total) || 0
          });
      },
      () => rpc.isCanceled(task.taskId),
      { sampleDirectory: samples, outputRoot: output, evidenceDirectory: evidence, attemptId: task.taskId },
      task.taskId
    );
    if (!complete) throw new Error("The AI runner finished without a result");
    // The result as the local runner sends it, without its local directory and file names
    const result: Record<string, unknown> = { ...complete };
    const directory = String(result.directory);
    const generated = Array.isArray(result.files) ? (result.files as unknown[]) : [];
    delete result.type;
    delete result.directory;
    delete result.files;

    const files: AiExecutionProgress["files"] = [];
    for (const name of generated) {
      if (!isGeneratedFile(name)) throw new Error("Unexpected generated file");
      const filename = path.join(directory, name as string);
      // eslint-disable-next-line no-await-in-loop -- One at a time
      const stat = await fs.promises.lstat(filename);
      if (!stat.isFile()) throw new Error("Unexpected generated file");
      // eslint-disable-next-line no-await-in-loop -- One at a time
      files.push({ name: name as string, size: stat.size, sha256: await hashFileAtPath(filename) });
    }
    if (files.length) {
      rpc.ensureNotCanceled(task.taskId);
      const targets = await rpc.requestUploads({
        taskId: task.taskId,
        files: files.map(({ name, size }) => ({ name, size }))
      });
      if (
        !Array.isArray(targets) ||
        targets.length !== files.length ||
        targets.some((t, i) => t?.name !== files[i].name)
      )
        throw new Error("The server refused to take the generated files");
      const pending = [...targets];
      await Promise.all(
        Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
          for (let target = pending.shift(); target; target = pending.shift()) {
            rpc.ensureNotCanceled(task.taskId);
            // eslint-disable-next-line no-await-in-loop -- Bounded by UPLOAD_CONCURRENCY
            const data = await fs.promises.readFile(path.join(directory, target.name));
            // eslint-disable-next-line no-await-in-loop -- Bounded by UPLOAD_CONCURRENCY
            await uploadWithForm(target, data, `generated file ${target.name}`);
          }
        })
      );
    }
    rpc.ensureNotCanceled(task.taskId);
    task.reportProgressRaw({ finished: true, status: "Complete", result, files });
  } catch (error) {
    if (error instanceof CanceledError || rpc.isCanceled(task.taskId)) throw new CanceledError();
    const message = String(error?.message || error).slice(0, 2000);
    winston.error(`AI execution task ${task.taskId} failed: ${message}`);
    const failure: AiRunFailure = error?.failure ? await uploadEvidence(task, error.failure, evidence) : null;
    task.reportProgressRaw({
      finished: true,
      status: "Failed",
      message,
      candidateFailure: task.extraInfo?.request?.operation === "validate-reference" && error?.candidateFailure === true,
      ...(failure ? { failure } : {})
    });
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}
