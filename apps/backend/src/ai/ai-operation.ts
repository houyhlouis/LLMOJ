/*
 * Logical AI operations (review Part III, H07/W03). An AI job's run of its programs is a logical operation: its key is
 * derived from the job and from everything the run depends on (every program, case, sample file and execution profile,
 * under the current AI execution contract). A restart, a lost connection or a retry doesn't make a new operation:
 * the job attaches to the operation's unfinished run, or collects its completed result again, and only a run of the
 * same key is ever attached to or collected. Each physical attempt of it still has its own ID.
 */
import {
  AI_EXECUTION_PROTOCOL_VERSION,
  aiContractDigest,
  parseAiCorpus,
  parseAiExecutionRecord,
  type AiCorpusCase,
  type AiExecutionRecord,
  type AiRuntimeIdentity
} from "@libreoj/judge-protocol";

export const AI_OPERATION_VERSION = 1;
// A completed run that its job didn't acknowledge (the job failed, or its backend restarted) is kept this long, for the
// job to collect again
export const AI_RESULT_RETENTION = 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The versioned runner wire payload
type RunnerRequest = any;

/** The key of the logical operation `request` is, for job `jobId`. */
export function aiOperationKey(jobId: string, request: RunnerRequest): string {
  return aiContractDigest({
    version: AI_OPERATION_VERSION,
    contract: AI_EXECUTION_PROTOCOL_VERSION,
    jobId,
    // Without the key itself, which a keyed request carries
    request: { ...request, operation: request.operation || "generate", operationKey: undefined }
  });
}

/** How a completed run was made, if it was made under the current contract; null otherwise (it isn't reused). */
export function currentExecution(result: unknown): AiExecutionRecord | null {
  const record = parseAiExecutionRecord((result as Record<string, unknown>)?.execution);
  return record?.contract === AI_EXECUTION_PROTOCOL_VERSION ? record : null;
}

/** Where a job's result came from, as it's published with the test data. */
export interface AiExecutionProvenance {
  operation: string;
  // The local AI runner, or a judge machine (its judge task, and the runtime the backend recorded for it)
  origin: "local" | "judge";
  task?: string;
  judgeRuntimeId?: number;
  // Made for this request; made by an attempt from before a restart that the job waited for again; or completed
  // before the job asked for it, and collected again
  result: "new" | "resumed" | "collected-again";
  attempt: string;
  runtime: AiRuntimeIdentity;
  startedAt: string;
  finishedAt: string;
  reuse: AiExecutionRecord["reuse"];
}

export function executionProvenance(
  record: AiExecutionRecord,
  operation: {
    key: string;
    origin: "local" | "judge";
    result: AiExecutionProvenance["result"];
    task?: string;
    judgeRuntimeId?: number;
  }
): AiExecutionProvenance {
  return {
    operation: operation.key,
    origin: operation.origin,
    ...(operation.task ? { task: operation.task } : {}),
    ...(Number.isSafeInteger(operation.judgeRuntimeId) ? { judgeRuntimeId: operation.judgeRuntimeId } : {}),
    result: operation.result,
    attempt: record.attemptId,
    runtime: record.runtime,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    reuse: record.reuse
  };
}

/**
 * A run's cases as it reported them, checked against the files it made (`files`: SHA-256 and size by name). Null if
 * they aren't exactly those files.
 */
export function verifiedCorpus(
  value: unknown,
  count: number,
  files: Map<string, { sha256: string; size: number }>
): AiCorpusCase[] | null {
  const corpus = parseAiCorpus(value, count);
  if (!corpus) return null;
  const same = (file: { sha256: string; size: number }, name: string) =>
    files.get(name)?.sha256 === file.sha256 && files.get(name)?.size === file.size;
  return corpus.every(item => same(item.input, `${item.index}.in`) && same(item.output, `${item.index}.out`))
    ? corpus
    : null;
}

export const corpusDigest = (corpus: AiCorpusCase[]) => aiContractDigest(corpus);
