/*
 * Keeps a failed AI run's evidence before the runner cleans up (review Part III, H01/W01): each observation's input,
 * outputs and diagnostics, as the exact bytes the programs read and wrote, within fixed limits, in the run's evidence
 * directory. The local runner's backend reads them from there; a judge machine uploads them before it reports the
 * failure. Programs never name what's kept: the runner chooses the data and the file names.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import {
  AI_EVIDENCE_LIMITS,
  AiArtifactRef,
  AiArtifactRole,
  AiExecutionMeasure,
  AiExecutionProfile,
  AiFailureKind,
  AiFailureObservation,
  AiOutputComparison,
  AiRunFailure,
  aiEvidenceFileName,
  firstDifference,
  textPreview
} from "@libreoj/judge-protocol";

import { detailsOf, EvidenceData, FailureDetails } from "./aiFailure";

const ROLES: AiArtifactRole[] = ["input", "actual", "expected", "diagnostics"];
export const FAILURE_FILE = "failure.json";

const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest("hex");

// Failures of the runner itself, not of a program: by what it says
function kindOfMessage(message: string): { kind: AiFailureKind; role?: string } {
  if (message.startsWith("Generation canceled")) return { kind: "canceled" };
  if (message.includes("execution budget")) return { kind: "budget_exhausted" };
  if (/exceeds the 16 MiB\/file or 8 GiB\/job limit|^Replacement data exceeds/.test(message))
    return { kind: "output_limit", role: "make" };
  return { kind: "infrastructure_error" };
}

async function readStart(data: EvidenceData, limit: number): Promise<{ bytes: Buffer; originalSize: number }> {
  if (Buffer.isBuffer(data)) return { bytes: data.subarray(0, limit), originalSize: data.length };
  // eslint-disable-next-line no-bitwise
  const file = await fs.promises.open(data.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Evidence isn't a regular file");
    const bytes = Buffer.alloc(Math.min(limit, stat.size));
    let read = 0;
    while (read < bytes.length) {
      // eslint-disable-next-line no-await-in-loop -- Sequential reads of one file
      const { bytesRead } = await file.read(bytes, read, bytes.length - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return { bytes: bytes.subarray(0, read), originalSize: stat.size };
  } finally {
    await file.close();
  }
}

/**
 * Reads into memory the evidence a failure has in files under `directory`, before the caller removes it (e.g. the
 * output of a program that ran on a sample in a temporary directory).
 */
export async function pinEvidence(error: unknown, directory: string) {
  const pin = async (details: FailureDetails) => {
    for (const role of ROLES) {
      const value = details?.data?.[role];
      if (value && !Buffer.isBuffer(value) && path.resolve(value.path).startsWith(`${path.resolve(directory)}/`))
        // eslint-disable-next-line no-await-in-loop -- At most four
        details.data[role] = await readStart(value, AI_EVIDENCE_LIMITS.artifactBytes)
          .then(({ bytes }) => bytes)
          .catch(() => undefined);
    }
  };
  const details = detailsOf(error);
  if (!details) return;
  await pin(details);
  for (const related of details.related || []) await pin(related);
}

export interface EvidenceOptions {
  // Where the run's evidence is written. It's emptied first; nothing else is written there.
  directory: string;
  // Lets the backend read what's written (the local runner)
  share: (filename: string) => Promise<void>;
  attemptId: string;
  operation: AiRunFailure["operation"];
  sourceHashes: Record<string, string>;
  profile: AiExecutionProfile;
  // The builtin comparison, to show where outputs first differ; null with a custom checker
  comparison: AiOutputComparison | null;
  // The latest run of each program, by role
  measures?: Map<string, AiExecutionMeasure>;
}

function summaryOf(details: FailureDetails) {
  const who = details.candidate ? `Challenge ${details.candidate}` : details.role || "A program";
  return `${who} failed ${details.subject || "a small case"}${
    details.verdict ? ` (${details.verdict})` : ""
  }: kept as evidence; small differential cases aren't exported, so this rejects nothing`;
}

/**
 * Keeps the observations of a failure (the one that ended the run, then related ones) and their bytes in the evidence
 * directory, with failure.json describing them, and returns them. Never throws: evidence that can't be kept is
 * reported as such, without artifacts.
 */
export async function keepFailure(error: unknown, phase: string, options: EvidenceOptions): Promise<AiRunFailure> {
  const details = detailsOf(error) || {};
  const message = String((error as Error)?.message || error).slice(0, AI_EVIDENCE_LIMITS.summary);
  const main: FailureDetails = {
    ...(details.kind ? {} : kindOfMessage(message)),
    ...details,
    phase: details.phase || phase || "queued"
  };
  // A canceled run's data isn't kept: it didn't fail
  const keep = main.kind !== "canceled";
  const items = [main, ...(keep ? details.related || [] : [])].slice(0, AI_EVIDENCE_LIMITS.observations);
  let budget = AI_EVIDENCE_LIMITS.runBytes;
  let ready = false;
  let wroteAny = false;
  const prepare = async () => {
    if (ready) return;
    await fs.promises.rm(options.directory, { recursive: true, force: true });
    const parent = path.dirname(options.directory);
    await fs.promises.mkdir(parent, { recursive: true, mode: 0o750 });
    await options.share(parent);
    await fs.promises.mkdir(options.directory, { mode: 0o750 });
    await options.share(options.directory);
    ready = true;
  };
  const observations: AiFailureObservation[] = [];
  for (const [index, item] of items.entries()) {
    const artifacts: AiArtifactRef[] = [];
    const kept: Partial<Record<AiArtifactRole, Buffer>> = {};
    let evidenceError: string;
    for (const role of keep ? ROLES : []) {
      const value = item.data?.[role];
      if (!value) continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- One artifact at a time, within the run's budget
        const { bytes, originalSize } = await readStart(value, Math.min(AI_EVIDENCE_LIMITS.artifactBytes, budget));
        // eslint-disable-next-line no-await-in-loop -- Once
        await prepare();
        const name = aiEvidenceFileName(index, role);
        const filename = path.join(options.directory, name);
        // eslint-disable-next-line no-await-in-loop -- One artifact at a time
        await fs.promises.writeFile(filename, bytes, { flag: "wx", mode: 0o640 });
        // eslint-disable-next-line no-await-in-loop -- One artifact at a time
        await options.share(filename);
        wroteAny = true;
        budget -= bytes.length;
        kept[role] = bytes;
        const preview = textPreview(bytes, undefined, undefined, role === "diagnostics");
        artifacts.push({
          name,
          role,
          classification: role === "diagnostics" ? "author-private" : item.classification || "author-private",
          size: bytes.length,
          sha256: sha256(bytes),
          originalSize,
          preview: preview.text,
          binary: preview.binary
        });
        if (bytes.length < originalSize) evidenceError = "Only the start of an artifact was kept: the evidence limit";
      } catch (e) {
        evidenceError = `An artifact couldn't be kept (${String(e?.code || e?.message || e).slice(0, 100)})`;
      }
    }
    const difference =
      item.kind === "solver_disagreement" && kept.actual && kept.expected && options.comparison
        ? firstDifference(kept.actual, kept.expected, options.comparison)
        : null;
    // A wrong output's run succeeded: its measurements are those of the program's latest run
    const execution =
      item.execution ||
      (index === 0 && item.kind === "solver_disagreement" && item.role ? options.measures?.get(item.role) : undefined);
    observations.push({
      kind: item.kind || "infrastructure_error",
      fatal: index === 0,
      ...(item.relation ? { relation: item.relation } : {}),
      phase: (item.phase || main.phase).slice(0, 64),
      ...(item.role ? { role: item.role } : {}),
      ...(item.candidate ? { candidate: item.candidate } : {}),
      ...(item.subject ? { subject: item.subject.slice(0, AI_EVIDENCE_LIMITS.label) } : {}),
      ...(item.subtask ? { subtask: item.subtask } : {}),
      ...(item.scenarioIndex != null ? { scenarioIndex: item.scenarioIndex } : {}),
      ...(item.verdict ? { verdict: item.verdict } : {}),
      ...(item.expectedBasis ? { expectedBasis: item.expectedBasis } : {}),
      ...(execution ? { execution } : {}),
      ...(difference ? { difference } : {}),
      ...(item.search ? { search: item.search } : {}),
      summary: index === 0 ? message : summaryOf(item),
      artifacts,
      ...(evidenceError ? { evidenceError } : {})
    });
  }
  const failure: AiRunFailure = {
    schemaVersion: 2,
    attemptId: options.attemptId,
    operation: options.operation,
    sourceHashes: options.sourceHashes,
    profile: options.profile,
    observations
  };
  if (wroteAny)
    try {
      // Lets the backend find the evidence even if it missed the failure (e.g. it restarted)
      const filename = path.join(options.directory, FAILURE_FILE);
      await fs.promises.writeFile(filename, JSON.stringify(failure), { flag: "wx", mode: 0o640 });
      await options.share(filename);
    } catch {
      /* The failure is still reported with its evidence */
    }
  return failure;
}

/** SHA-256 of each source a request runs, by role. */
export function sourceHashesOf(sources: [string, string][], extraFiles: Record<string, string>) {
  const hashes: Record<string, string> = {};
  for (const [role, source] of sources) if (typeof source === "string") hashes[role] = sha256(source);
  for (const [name, source] of Object.entries(extraFiles || {})) hashes[`file:${name}`] = sha256(source);
  return hashes;
}

/** The profile a request's programs are built and run with. */
export function profileOf(
  limits: Omit<AiExecutionProfile, "hash" | "architecture" | "compiler" | "checker">,
  compiler: string,
  checker: string
): AiExecutionProfile {
  const profile = { architecture: process.arch, compiler, ...limits, checker };
  return { hash: sha256(JSON.stringify(profile)), ...profile };
}
