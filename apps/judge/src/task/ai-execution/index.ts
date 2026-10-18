import fs from "fs";
import path from "path";

import winston from "winston";
import { AiExecutionProgress } from "@libreoj/judge-protocol";

import { Task } from "..";

import config from "../../config";
import rpc from "../../rpc";
import { CanceledError } from "../../error";
import { ensureFiles, getFile, hashFileAtPath } from "../../file";
import { Request, runGeneration, validate } from "../../aiRunner";
import { safelyJoinPath, uploadWithForm } from "../../utils";

export interface AiExecutionExtraInfo {
  // As the local AI runner gets it
  request: Request;
  // The stored files the request's sample files are, by name
  sampleFiles?: { name: string; uuid: string }[];
}

// What a generation writes, as the AI runner names its files: the test data (1.in, 1.out, …) and the sources it
// checked (make.cpp, std.cpp, …). Not its own result.json.
const isGeneratedFile = (name: unknown) =>
  typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) && name !== "result.json";
const UPLOAD_CONCURRENCY = 2;

/**
 * Runs an AI job's programs like the local AI runner does, in this judge's sandbox and execution slots, and uploads
 * the files they generated to where the server says. The server then checks and publishes them.
 */
export default async function onAiExecution(task: Task<AiExecutionExtraInfo, AiExecutionProgress>) {
  const work = safelyJoinPath(config.dataStore, "ai-work", task.taskId);
  const samples = path.join(work, "samples");
  const output = path.join(work, "output");
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
      { sampleDirectory: samples, outputRoot: output },
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
    task.reportProgressRaw({
      finished: true,
      status: "Failed",
      message,
      candidateFailure: task.extraInfo?.request?.operation === "validate-reference" && error?.candidateFailure === true
    });
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}
