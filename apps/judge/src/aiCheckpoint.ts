/*
 * What an AI run keeps for the next attempt (review Part III, H07/W03): a job's compiled programs, by everything their
 * binary depends on, and the inputs an operation's generators made. An attempt that a restart interrupted is then run
 * again with the same builds and the same cases, instead of new cases drawn with fresh randomness; an attempt of
 * another operation of the same job (e.g. a retry with a new checker) reuses the programs that didn't change.
 *
 * Both are in the judge's own data store, not where the backend can write, and are bound to this judge's runtime (its
 * program and sandbox image): after an upgrade nothing is reused. They're deleted a day after their last use, when
 * the local backend cleans the job up, and (the inputs) when their operation completes.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import winston from "winston";
import { aiContractDigest, type AiCompileOptions, type AiRuntimeIdentity } from "@libreoj/judge-protocol";

import config from "./config";
import getRuntimeInfo from "./runtimeIdentity";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[0-9a-f]{64}$/;
const MAX_FILE = 16 * 1024 * 1024;
// Kept inputs are an optimization: none are kept when the disk is this close to full, nor more than this of one
// operation's (the run's own output needs the space; inputs past it are generated again after an interruption)
const DISK_RESERVE = 2 * 1024 * 1024 * 1024;
const OPERATION_INPUTS = 512 * 1024 * 1024;
const GENERATOR = /^(?:make|quality-small-make)$/;

const root = (name: string) => path.join(config.dataStore, name);
export const AI_BUILDS = "ai-builds";
export const AI_CORPUS = "ai-corpus";
export const AI_WORK = "ai-work";

// Jobs whose builds or inputs a run is using: never pruned meanwhile
const held = new Map<string, number>();

/** The runtime a run's builds and inputs are bound to, as the judge announces it. */
export async function runtimeIdentity(): Promise<AiRuntimeIdentity> {
  const info = await getRuntimeInfo();
  return { judgeProgram: info.judgeProgram, sandboxImage: info.sandboxImage, arch: info.arch };
}

async function readKept(filename: string): Promise<Buffer | null> {
  let file: fs.promises.FileHandle;
  try {
    // eslint-disable-next-line no-bitwise
    file = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE) return null;
    return await file.readFile();
  } finally {
    await file.close();
  }
}

// Writes a kept file in one step: a reader sees all of it or none
async function writeKept(directory: string, name: string, data: Buffer, mode: number) {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${name}.${crypto.randomUUID()}`);
  try {
    await fs.promises.writeFile(temporary, data, { mode, flag: "wx" });
    await fs.promises.rename(temporary, path.join(directory, name));
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

async function touch(directory: string) {
  const now = new Date();
  await fs.promises.utimes(directory, now, now).catch(() => undefined);
}

/** What a build depends on: its key is the digest of all of it. */
export interface BuildInputs {
  source: string;
  options: AiCompileOptions;
  // Whether it's compiled with testlib.h (whose content the runtime's judge program digest covers)
  testlib: boolean;
  // The problem's extra source files, if it's compiled with them
  extraSources: Record<string, string> | null;
  // The grader the reference solution of a communication problem is linked with
  grader: string | null;
  runtime: AiRuntimeIdentity;
}

export const buildKey = (inputs: BuildInputs) => aiContractDigest({ version: 1, ...inputs });

/** A job's compiled programs on this judge. */
export class JobBuilds {
  private readonly directory: string;

  // Programs taken from here instead of compiled
  reused = 0;

  constructor(jobId: string) {
    if (!UUID.test(jobId)) throw new Error("Invalid job UUID");
    this.directory = path.join(root(AI_BUILDS), jobId.toLowerCase());
  }

  /** The binary built from exactly these inputs before, or null. */
  async take(key: string): Promise<Buffer | null> {
    if (!KEY.test(key)) return null;
    const binary = await readKept(path.join(this.directory, key));
    if (binary) {
      this.reused++;
      await touch(this.directory);
    }
    return binary;
  }

  async keep(key: string, binary: Buffer) {
    if (!KEY.test(key)) return;
    try {
      await writeKept(this.directory, key, binary, 0o500);
    } catch (error) {
      winston.warn(`Couldn't keep an AI build: ${String(error?.message || error)}`);
    }
  }
}

/**
 * The inputs an operation's generators made on this judge, by generator, subtask and case index: an attempt of the same
 * operation (the same programs, cases and settings, by the backend's operation key) on the same runtime replays them.
 */
export class OperationInputs {
  private readonly directory: string;

  // Inputs taken from here instead of generated
  reused = 0;

  // Bytes kept, once counted
  private kept: number = null;

  constructor(
    jobId: string,
    operationKey: string,
    runtime: AiRuntimeIdentity,
    private readonly limit = OPERATION_INPUTS
  ) {
    if (!UUID.test(jobId) || !KEY.test(operationKey)) throw new Error("Invalid AI operation");
    this.directory = path.join(
      root(AI_CORPUS),
      jobId.toLowerCase(),
      aiContractDigest({ version: 1, operationKey, runtime })
    );
  }

  private name(role: string, subtask: number, caseIndex: number) {
    if (!GENERATOR.test(role) || !Number.isSafeInteger(subtask) || !Number.isSafeInteger(caseIndex) || subtask < 0)
      throw new Error("Invalid generated input");
    return `${role}-${subtask}-${caseIndex}.in`;
  }

  async take(role: string, subtask: number, caseIndex: number): Promise<Buffer | null> {
    const input = await readKept(path.join(this.directory, this.name(role, subtask, caseIndex)));
    if (input) {
      this.reused++;
      // The job's directory is what's pruned
      await touch(path.dirname(this.directory));
    }
    return input;
  }

  async keep(role: string, subtask: number, caseIndex: number, input: Buffer) {
    const name = this.name(role, subtask, caseIndex);
    try {
      const space = await (
        fs.promises as unknown as { statfs: (filename: string) => Promise<{ bavail: number; bsize: number }> }
      ).statfs(config.dataStore);
      if (space.bavail * space.bsize < DISK_RESERVE + input.length) return;
      if (this.kept == null) {
        this.kept = 0;
        const names = await fs.promises.readdir(this.directory).catch((): string[] => []);
        for (const file of names)
          // eslint-disable-next-line no-await-in-loop -- Once per run
          this.kept += (await fs.promises.lstat(path.join(this.directory, file)).catch(() => ({ size: 0 }))).size;
      }
      if (this.kept + input.length > this.limit) return;
      await writeKept(this.directory, name, input, 0o400);
      this.kept += input.length;
      await touch(path.dirname(this.directory));
    } catch (error) {
      winston.warn(`Couldn't keep a generated AI input: ${String(error?.message || error)}`);
    }
  }

  /** Once the operation completed: its result has the cases. */
  async discard() {
    await fs.promises.rm(this.directory, { recursive: true, force: true });
  }
}

/** Keeps a job's builds and inputs from being pruned while `work` runs. */
export async function holdingJob<T>(jobId: string, work: () => Promise<T>): Promise<T> {
  const key = jobId.toLowerCase();
  held.set(key, (held.get(key) || 0) + 1);
  try {
    return await work();
  } finally {
    const count = held.get(key) - 1;
    if (count) held.set(key, count);
    else held.delete(key);
  }
}

/** Deletes what's kept for a job (the local backend cleans it up). */
export async function discardJob(jobId: string) {
  if (!UUID.test(jobId) || held.has(jobId.toLowerCase())) return;
  for (const name of [AI_BUILDS, AI_CORPUS])
    await fs.promises.rm(path.join(root(name), jobId.toLowerCase()), { recursive: true, force: true });
}

/**
 * Deletes kept builds and inputs a day after their last use, and the workspaces of judge tasks a restart left behind
 * (`active`: the tasks running now).
 */
export async function pruneAiCheckpoints(active: { has(key: string): boolean }, now = Date.now()) {
  for (const name of [AI_BUILDS, AI_CORPUS, AI_WORK]) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root(name), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!UUID.test(entry.name) || !entry.isDirectory() || held.has(entry.name) || active.has(entry.name)) continue;
      const directory = path.join(root(name), entry.name);
      // eslint-disable-next-line no-await-in-loop -- One at a time
      const stat = await fs.promises.lstat(directory).catch(() => null);
      if (stat?.isDirectory() && now - stat.mtimeMs > RETENTION_MS)
        // eslint-disable-next-line no-await-in-loop -- One at a time
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
}
