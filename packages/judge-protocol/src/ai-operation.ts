/*
 * Recoverable AI runs and their replay (review Part III, H07/W03). A completed run reports how it was made: under which
 * AI execution contract, on which runtime, and what it took from earlier attempts of the same operation instead of
 * doing it again (`AiExecutionRecord`), and the exact bytes of every case it made (`AiCorpusCase`). The backend reuses
 * a completed run only under the current contract, and publishes the record with the test data.
 *
 * A replay runs one kept failure again: the same check of the same input, a few times, with the job's programs as
 * they are now. Whether it failed the same way each time says whether the failure reproduces.
 */
import {
  AI_EXECUTION_STATUSES,
  AI_FAILURE_KINDS,
  AI_FAILURE_VERDICTS,
  type AiExecutionMeasure,
  type AiFailureKind,
  type AiFailureVerdict
} from "./ai-observation";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown, maximum = 1e9): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
const isTime = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
const text = (value: unknown, limit: number) => (typeof value === "string" ? value.slice(0, limit) : "");

/** What a runner ran a run with: its program (SHA-256 of its sources), its sandbox image and architecture. */
export interface AiRuntimeIdentity {
  judgeProgram: string;
  sandboxImage: string;
  arch: string;
}

/** How a completed run was made, as its runner reports it (judge protocol version 8). */
export interface AiExecutionRecord {
  // The AI execution contract it was made under (AI_EXECUTION_PROTOCOL_VERSION): only a result of the current one is
  // reused
  contract: number;
  // The physical attempt: new for each time the programs ran, also of the same judge task
  attemptId: string;
  runtime: AiRuntimeIdentity;
  startedAt: string;
  finishedAt: string;
  // Programs taken from the job's earlier builds instead of compiled again (same source, options, headers and
  // runtime), and inputs taken from an interrupted attempt of the same operation instead of generated again
  reuse: { builds: number; inputs: number };
}

export function parseAiExecutionRecord(value: unknown): AiExecutionRecord | null {
  if (!isObject(value) || !isObject(value.runtime) || !isObject(value.reuse)) return null;
  const { runtime, reuse } = value;
  if (
    !isCount(value.contract, 1000) ||
    typeof value.attemptId !== "string" ||
    !UUID.test(value.attemptId) ||
    !SHA256.test(String(runtime.judgeProgram)) ||
    typeof runtime.sandboxImage !== "string" ||
    !/^[0-9a-zA-Z._-]{1,128}$/.test(runtime.sandboxImage) ||
    typeof runtime.arch !== "string" ||
    !/^[0-9a-z_]{1,16}$/.test(runtime.arch) ||
    !isTime(value.startedAt) ||
    !isTime(value.finishedAt) ||
    !isCount(reuse.builds, 1000) ||
    !isCount(reuse.inputs)
  )
    return null;
  return {
    contract: value.contract,
    attemptId: value.attemptId.toLowerCase(),
    runtime: {
      judgeProgram: runtime.judgeProgram as string,
      sandboxImage: runtime.sandboxImage,
      arch: runtime.arch
    },
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    reuse: { builds: reuse.builds, inputs: reuse.inputs }
  };
}

/** A case a run made: its files, and whether it's the generator's case or an adversarial one that replaced it. */
export interface AiCorpusCase {
  // From 1: the files <index>.in and <index>.out
  index: number;
  subtask: number;
  // The case index the generator was run with; not a seed (see AiFailureObservation)
  scenarioIndex: number;
  origin: "generated" | "adversarial";
  input: { sha256: string; size: number };
  output: { sha256: string; size: number };
}

const isFileHash = (value: unknown): value is { sha256: string; size: number } =>
  isObject(value) && SHA256.test(String(value.sha256)) && isCount(value.size, 16 * 1024 * 1024);

/** A run's cases, one for each of its `count` cases in order; null if they aren't that. */
export function parseAiCorpus(value: unknown, count: number): AiCorpusCase[] | null {
  if (!Array.isArray(value) || value.length !== count) return null;
  const cases: AiCorpusCase[] = [];
  for (const [position, item] of value.entries()) {
    if (
      !isObject(item) ||
      item.index !== position + 1 ||
      !isCount(item.subtask, 1000) ||
      !isCount(item.scenarioIndex, 2147483647) ||
      !["generated", "adversarial"].includes(item.origin as string) ||
      !isFileHash(item.input) ||
      !isFileHash(item.output)
    )
      return null;
    cases.push({
      index: item.index,
      subtask: item.subtask,
      scenarioIndex: item.scenarioIndex,
      origin: item.origin as AiCorpusCase["origin"],
      input: { sha256: item.input.sha256, size: item.input.size },
      output: { sha256: item.output.sha256, size: item.output.size }
    });
  }
  return cases;
}

// Replay

export const AI_REPLAY_CHECKS = [
  // Compile the program again
  "compile",
  // Run the input validator on the input, with the subtask and case index it was checked with
  "validate",
  // Run a generator with the subtask and case index it was run with (it draws fresh randomness)
  "generate",
  // Run the program on the input
  "run",
  // Run the program on the input and compare its output, as the run compared it, with the kept output ("expected"),
  // with another program's output, or with itself ("self": the checker must accept it)
  "compare",
  // Run the checker on the kept input, output and compared output
  "checker"
] as const;
export type AiReplayCheck = (typeof AI_REPLAY_CHECKS)[number];

// The programs a replay may run, by the roles failures name them with
export const AI_PROGRAM_ROLE =
  /^(?:make|std|checker|validator|interactor|manager|quality-small-make|quality-oracle|quality-alt-[0-9]{1,2}|quality-challenge-[0-9]{1,2})$/;

export const AI_REPLAY_LIMITS = Object.freeze({
  // Runs of one replay, and programs it compiles
  repeat: 3,
  programs: 4
});

/** What a replay runs, as the backend sends it with operation "replay". */
export interface AiReplayRequest {
  check: AiReplayCheck;
  // The program whose failure is replayed
  role: string;
  // "compare": what its output is compared with
  against?: "expected" | "self" | string;
  // "checker": whether the checker must reject the output (the run's malformed probe) or just give a verdict
  expect?: "reject" | "verdict";
  // "validate" and "generate": the arguments the program was run with
  subtask?: number;
  caseIndex?: number;
  // The kept files, by their names among the request's files
  files: { input?: string; expected?: string; actual?: string };
  repeat: number;
  // The sources of the programs it runs, by role
  programs: Record<string, string>;
}

const REPLAY_FILE = /^replay\.(?:input|expected|actual)$/;

// The output the differential check gives a custom checker, which it must reject: a failure with it as its output is
// replayed as a checker that must reject it
export const AI_MALFORMED_OUTPUT = "\0LLMOJ_INVALID_OUTPUT_!@#\xff\n";

/** Checks a replay request field by field; returns why it isn't valid, or null. */
export function aiReplayRequestError(value: unknown): string | null {
  if (!isObject(value)) return "Invalid replay";
  const { check, role, against, expect, files, programs } = value;
  if (!(AI_REPLAY_CHECKS as readonly unknown[]).includes(check)) return "Invalid replay check";
  if (typeof role !== "string" || !AI_PROGRAM_ROLE.test(role)) return "Invalid replay program";
  if (!isCount(value.repeat, AI_REPLAY_LIMITS.repeat) || (value.repeat as number) < 1) return "Invalid replay count";
  if (!isObject(programs) || !Object.keys(programs).length || Object.keys(programs).length > AI_REPLAY_LIMITS.programs)
    return "Invalid replay programs";
  for (const [name, source] of Object.entries(programs))
    if (!AI_PROGRAM_ROLE.test(name) || typeof source !== "string" || source.length > 512 * 1024)
      return "Invalid replay program source";
  if (
    !isObject(files) ||
    Object.entries(files).some(
      ([name, file]) =>
        !["input", "expected", "actual"].includes(name) || typeof file !== "string" || !REPLAY_FILE.test(file)
    )
  )
    return "Invalid replay files";
  const needs: Record<AiReplayCheck, string[]> = {
    compile: [role],
    validate: ["validator"],
    generate: [role],
    run: [role],
    compare: [role],
    checker: ["checker"]
  };
  if (needs[check as AiReplayCheck].some(name => typeof programs[name] !== "string"))
    return "A replayed program is missing";
  if (check === "compare") {
    if (against !== "expected" && against !== "self" && (typeof against !== "string" || !AI_PROGRAM_ROLE.test(against)))
      return "Invalid replay comparison";
    if (
      against === "expected" ? !files.expected : against !== "self" && typeof programs[against as string] !== "string"
    )
      return "The compared output is missing";
  }
  if (check === "checker" && (!files.actual || !files.expected || !["reject", "verdict"].includes(expect as string)))
    return "Invalid checker replay";
  if (["validate", "run", "compare", "checker"].includes(check as string) && !files.input)
    return "The replayed input is missing";
  if (
    ["validate", "generate"].includes(check as string) &&
    (!isCount(value.subtask, 1000) || !isCount(value.caseIndex, 2147483647))
  )
    return "Invalid replay arguments";
  return null;
}

/** One run of a replay: whether the check failed again, and how. */
export interface AiReplayRun {
  outcome: "failed" | "passed";
  kind?: AiFailureKind;
  verdict?: AiFailureVerdict;
  summary: string;
  execution?: AiExecutionMeasure;
}

export const AI_REPLAY_OUTCOMES = [
  // Every run failed as the kept failure did
  "reproduced",
  // No run failed
  "not_reproduced",
  // Some runs failed and some didn't, or they failed in different ways
  "unstable",
  // Every run failed, all in the same other way
  "different"
] as const;
export type AiReplayOutcome = (typeof AI_REPLAY_OUTCOMES)[number];

/** Whether a replay's runs reproduced a failure of `kind`. */
export function aiReplayOutcome(kind: AiFailureKind, runs: AiReplayRun[]): AiReplayOutcome {
  const failed = runs.filter(run => run.outcome === "failed");
  if (!failed.length) return "not_reproduced";
  if (failed.length < runs.length) return "unstable";
  if (failed.every(run => run.kind === kind)) return "reproduced";
  return failed.every(run => run.kind === failed[0].kind) ? "different" : "unstable";
}

function parseMeasure(value: unknown): AiExecutionMeasure | undefined {
  if (!isObject(value) || !(AI_EXECUTION_STATUSES as readonly unknown[]).includes(value.status)) return undefined;
  const measure: AiExecutionMeasure = { status: value.status as AiExecutionMeasure["status"] };
  if (Number.isSafeInteger(value.exitCode)) measure.exitCode = value.exitCode as number;
  if (value.termination === "exited" || value.termination === "signaled") measure.termination = value.termination;
  for (const key of ["timeMs", "memoryBytes", "timeLimitMs", "memoryLimitBytes"] as const)
    if (typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= 0)
      measure[key] = value[key] as number;
  return measure;
}

/** A replay's runs as a runner reports them, checked field by field; null if they aren't `repeat` valid runs. */
export function parseAiReplayRuns(value: unknown, repeat: number): AiReplayRun[] | null {
  if (!Array.isArray(value) || value.length !== repeat) return null;
  const runs: AiReplayRun[] = [];
  for (const item of value) {
    if (!isObject(item) || !["failed", "passed"].includes(item.outcome as string)) return null;
    if (item.kind !== undefined && !(AI_FAILURE_KINDS as readonly unknown[]).includes(item.kind)) return null;
    if (item.verdict !== undefined && !(AI_FAILURE_VERDICTS as readonly unknown[]).includes(item.verdict)) return null;
    const execution = parseMeasure(item.execution);
    runs.push({
      outcome: item.outcome as AiReplayRun["outcome"],
      ...(item.outcome === "failed" ? { kind: (item.kind as AiFailureKind) || "unclassified" } : {}),
      ...(item.verdict ? { verdict: item.verdict as AiFailureVerdict } : {}),
      summary: text(item.summary, 2000),
      ...(execution ? { execution } : {})
    });
  }
  return runs;
}
