/*
 * Narrow, bounded repairs (review Part III, H02/W04): what a job does about a failed run of its programs. A typed
 * failure is routed to running the same programs again (the infrastructure failed, not a program), to replacing the
 * one AI-written program the evidence says is at fault, or to stopping for the job's owner: when nothing trusted says
 * which program is wrong, or the program is the problem's own. A repair replaces one program and nothing else; the
 * plan, the cases, the limits, the checks and the problem's own helpers stay as they are, so a run after a repair is
 * held to the same gates. Repairs are counted for the job's whole life: restarts and retries don't reset the count.
 */
import { createHash } from "crypto";

import {
  AI_EVIDENCE_LIMITS,
  AI_PROGRAM_ROLE,
  aiContractDigest,
  type AiFailureObservation
} from "@libreoj/judge-protocol";

import { AiError } from "./ai.types";
import { jobProgram } from "./ai-replay";
import type { StoredAiArtifact, StoredAiObservation } from "./ai-observation.entity";

export const AI_REPAIR_LIMITS = Object.freeze({
  // Repairs a job makes by itself; and all its repairs, with those its owner asks for
  automatic: 3,
  total: 8,
  // Runs of the same programs again after the infrastructure failed, until the owner retries the job
  infrastructure: 2
});

/** Why a job stopped for its owner instead of repairing a program by itself. */
export const AI_REPAIR_REVIEW_REASONS = [
  // Two programs disagree and nothing trusted says which one is wrong
  "ATTRIBUTION",
  // The problem's own checker, interactor or manager failed: its owner changes it
  "PROBLEM_HELPER",
  // The reference solution is a tutorial's code: replacing it is the owner's decision
  "TUTORIAL_REFERENCE",
  // An adversarial input was found, but no case could be replaced with it
  "CAPACITY",
  // The run used its whole execution budget
  "BUDGET",
  // Nothing in the failure says which of the job's programs to repair (e.g. it isn't typed)
  "UNCLASSIFIED",
  // The job used the repairs it may make
  "REPAIR_LIMIT",
  // A repair didn't change the failure
  "UNCHANGED",
  // The proposed program is the failed one, unchanged
  "IDENTICAL",
  // The proposed program isn't a valid program of its kind
  "INVALID",
  // The program changed since it failed: the failure is about another program
  "STALE",
  // The infrastructure failed again after the job ran its programs again
  "INFRASTRUCTURE",
  // The failure couldn't be kept, so a repair couldn't be tested against it
  "EVIDENCE"
] as const;
export type AiRepairReviewReason = (typeof AI_REPAIR_REVIEW_REASONS)[number];

export type AiRepairDecision =
  // The same programs, the same request again
  | { action: "retry" }
  // Replace one program. `confirm`: replay the failure first; one that doesn't reproduce isn't a program's fault
  | { action: "repair"; role: string; confirm?: boolean }
  // Stop for the owner, who may have one of `roles` repaired
  | { action: "review"; reason: AiRepairReviewReason; roles: string[] }
  // Not the programs' failure (the job was canceled)
  | { action: "stop" };

/** A failure as routed: the typed observation's fields that say what failed. */
export type AiRoutedFailure = Pick<
  AiFailureObservation,
  "kind" | "phase" | "role" | "candidate" | "subject" | "subtask" | "scenarioIndex" | "expectedBasis" | "search"
> & { execution?: Pick<NonNullable<AiFailureObservation["execution"]>, "termination" | "status"> };

export interface AiRepairContext {
  // Whether the job wrote the program (and may replace it): not the problem's own helper, nor a tutorial's code
  aiWritten(role: string): boolean;
  // SHA-256 of the program as the job has it now
  programHash?(role: string): string | null;
  // The reference solution is a tutorial's code
  tutorialReference: boolean;
  // Outputs are compared by a custom checker (a disagreement may be the checker's)
  customChecker: boolean;
}

/** One replaced program, as kept with the job. */
export interface AiRepairRevision {
  // 1, 2, …: the job's repairs in order
  round: number;
  role: string;
  by: "automatic" | "owner";
  // The failure it repaired: its observation, and what it was
  observationId: string;
  signature: string;
  failure: { kind: string; phase: string; subject?: string };
  // SHA-256 of the program before and after (the proposal, if it was rejected)
  from: string;
  to: string;
  at: string;
  // Why the proposal wasn't used: the same program, or not a valid one. The program stayed as it was.
  rejected?: "IDENTICAL" | "INVALID";
  // The repaired program against the kept failure, before the whole run: it passed, it failed the same way, it
  // passed some runs only, or it couldn't be tested (no kept evidence, or the failure isn't of this program)
  test?: "passed" | "failed" | "unstable" | "untested";
  // How the next run of all the programs ended: it passed, or the kind of its failure
  result?: string;
}

/** A job's repairs, kept in its state. */
export interface AiRepairState {
  version: 1;
  // Repairs the job made by itself; runs again after infrastructure failures since the owner last retried
  automatic: number;
  infrastructure: number;
  revisions: AiRepairRevision[];
  // Why the job stopped for its owner, and the programs the owner may have repaired
  review?: {
    reason: AiRepairReviewReason;
    roles: string[];
    observationId?: string;
    kind: string;
    phase?: string;
    role?: string;
    subject?: string;
    at: string;
  };
  // A repair the owner asked for, made when the job runs again
  pending?: { role: string; observationId: string };
}

export const sha256Of = (source: string) => createHash("sha256").update(source).digest("hex");

/** The job's repair state, created if it has none. */
export function repairState(state: Record<string, unknown>): AiRepairState {
  const current = state.repair as AiRepairState;
  if (current?.version === 1 && Array.isArray(current.revisions)) return current;
  // A job from before repairs were counted here counts the generator repair it made
  const created: AiRepairState = {
    version: 1,
    automatic: state.makeCompileRepairAttempts ? 1 : 0,
    infrastructure: 0,
    revisions: []
  };
  state.repair = created;
  return created;
}

// The sample's number in a failure's subject ("sample 2", "protocol sample 1")
const sampleNumber = (subject?: string) => Number(/(?:^|\s)sample (\d+)/.exec(subject || "")?.[1]) || null;

/**
 * What identifies a failure across runs, without its bytes: a generator that makes another illegal input for the same
 * scenario fails the same way.
 */
export function failureSignature(failure: AiRoutedFailure): string {
  return aiContractDigest({
    kind: failure.kind,
    role: failure.role || null,
    candidate: failure.candidate || null,
    phase: failure.phase || null,
    subtask: failure.subtask ?? null,
    scenarioIndex: failure.scenarioIndex ?? null,
    sample: sampleNumber(failure.subject)
  });
}

// Failures the backend observes itself, without a runner's typed failure
const OBSERVED: Record<string, AiFailureObservation["kind"]> = {
  SANDBOX_UNAVAILABLE: "infrastructure_error",
  SANDBOX_DISCONNECTED: "infrastructure_error",
  INVALID_SANDBOX_RESPONSE: "infrastructure_error",
  INVALID_SANDBOX_FILE: "infrastructure_error",
  SANDBOX_TIMEOUT: "budget_exhausted",
  SANDBOX_GENERATION_FAILED: "unclassified"
};

/** The failure a run's error is, to be routed; null for an error that isn't a run's failure (e.g. a cancellation). */
export function routedFailure(error: unknown): AiRoutedFailure | null {
  if (!(error instanceof AiError)) return null;
  if (error.failure) return error.failure;
  return OBSERVED[error.code] ? { kind: OBSERVED[error.code], phase: "" } : null;
}

const GENERATORS = ["make", "quality-small-make"];
// A program that should be correct: one too slow or too large on a case is replayed before it's rewritten
const SOLUTIONS = /^(?:std|quality-oracle|quality-alt-\d+)$/;
const SAMPLE_PHASES = ["validate-samples", "validate-sample-inputs", "validate-protocol-samples"];

/** Which generator made the input a failure is about. */
function generatorOf(failure: AiRoutedFailure): string | null {
  if (SAMPLE_PHASES.includes(failure.phase) || (failure.subtask ?? 0) === 0) return null;
  return failure.phase === "quality-differential" ? "quality-small-make" : "make";
}

/** What to do about a failed run (see the module comment); limits and repeated failures are the caller's. */
export function routeAiFailure(failure: AiRoutedFailure, context: AiRepairContext): AiRepairDecision {
  const { kind } = failure;
  const role = failure.role && AI_PROGRAM_ROLE.test(failure.role) ? failure.role : null;
  // The program the evidence blames, if the job may replace it; why not otherwise
  const repair = (target: string, confirm = false): AiRepairDecision => {
    if (context.aiWritten(target)) return { action: "repair", role: target, ...(confirm ? { confirm } : {}) };
    return {
      action: "review",
      reason: target === "std" && context.tutorialReference ? "TUTORIAL_REFERENCE" : "PROBLEM_HELPER",
      roles: target === "std" ? ["std"] : []
    };
  };
  // Programs that disagree: the owner says which one is wrong
  const attribution = (...roles: string[]): AiRepairDecision => ({
    action: "review",
    reason: "ATTRIBUTION",
    roles: [...new Set([...roles, ...(context.customChecker ? ["checker"] : [])])].filter(
      candidate => candidate === "std" || context.aiWritten(candidate)
    )
  });
  switch (kind) {
    case "canceled":
      return { action: "stop" };
    case "infrastructure_error":
      return { action: "retry" };
    case "budget_exhausted":
      return { action: "review", reason: "BUDGET", roles: [] };
    case "insufficient_case_capacity":
      return { action: "review", reason: "CAPACITY", roles: [] };
    case "compile_error":
      if (!role) break;
      // A compiler that was killed or crashed left no diagnostic to repair from
      if (failure.execution && failure.execution.termination !== "exited") return { action: "retry" };
      return repair(role);
    case "validator_rejection": {
      const generator = generatorOf(failure);
      // An official sample is legal: the validator is wrong. A generated input is the generator's: the validator
      // is never loosened to accept it.
      return generator ? repair(generator) : repair("validator");
    }
    case "solver_disagreement":
      if (!role) break;
      if (failure.expectedBasis === "official_sample")
        // A sample's output is trusted, unless a checker judged it: then the checker may be the one that's wrong
        return context.customChecker ? attribution(role) : repair(role);
      if (failure.expectedBasis === "candidate_oracle")
        return attribution(role, ...(role === "quality-oracle" ? [] : ["quality-oracle"]));
      if (failure.expectedBasis === "reference_output") return attribution(role, ...(role === "std" ? [] : ["std"]));
      break;
    case "runtime_error":
    case "time_limit":
    case "memory_limit":
    case "output_limit":
      if (!role) break;
      if (GENERATORS.includes(role) || role === "validator") return repair(role);
      if (SOLUTIONS.test(role)) return repair(role, kind === "time_limit" || kind === "memory_limit");
      return repair(role);
    case "checker_failure":
      return repair("checker");
    case "invalid_challenge":
      if (!role) break;
      return repair(role);
    case "challenge_survived":
      // The generator gets the target's construction (and its small counterexample, if one was kept)
      return failure.search?.stoppedBy === "capacity"
        ? { action: "review", reason: "CAPACITY", roles: [] }
        : repair("make");
    default:
      break;
  }
  return { action: "review", reason: "UNCLASSIFIED", roles: [] };
}

/**
 * The decision with the job's limits and history: a repair the job may no longer make by itself, or one that would
 * repeat a repair that didn't change the failure, stops for the owner.
 */
export function decideAiRepair(
  failure: AiRoutedFailure,
  context: AiRepairContext,
  state: AiRepairState
): AiRepairDecision {
  const decision = routeAiFailure(failure, context);
  if (decision.action === "retry" && state.infrastructure >= AI_REPAIR_LIMITS.infrastructure)
    return { action: "review", reason: "INFRASTRUCTURE", roles: [] };
  if (decision.action !== "repair") return decision;
  // The owner may also decide that the other program involved is the wrong one
  const roles = [
    ...new Set([
      decision.role,
      ...(failure.kind === "validator_rejection" ? ["validator"] : []),
      ...(failure.kind === "challenge_survived" && failure.role ? [failure.role] : [])
    ])
  ].filter(role => context.aiWritten(role));
  // The latest repair was of this program for this failure, and the program is what it left: it didn't help
  const last = state.revisions[state.revisions.length - 1];
  if (
    last &&
    last.signature === failureSignature(failure) &&
    last.role === decision.role &&
    (!context.programHash || context.programHash(decision.role) === (last.rejected ? last.from : last.to))
  )
    return { action: "review", reason: "UNCHANGED", roles };
  if (state.revisions.length >= AI_REPAIR_LIMITS.total) return { action: "review", reason: "REPAIR_LIMIT", roles: [] };
  if (state.automatic >= AI_REPAIR_LIMITS.automatic) return { action: "review", reason: "REPAIR_LIMIT", roles };
  return decision;
}

/**
 * Whether the job wrote a program and may replace it: it has the program, it isn't one of the problem's own helpers
 * (`problemHelpers`), and the reference solution isn't a tutorial's code unless `tutorial` allows it.
 */
export function aiWrittenProgram(
  state: Record<string, unknown>,
  role: string,
  options: { tutorial?: boolean } = {}
): boolean {
  if (!AI_PROGRAM_ROLE.test(role) || !jobProgram(state, role)) return false;
  if (((state.problemHelpers as string[]) || []).includes(role)) return false;
  if (role === "std" && (state.referenceSource as { kind?: string })?.kind === "tutorial") return !!options.tutorial;
  return true;
}

/** Replaces a program of the job's state; the others stay as they are. */
export function setJobProgram(state: Record<string, unknown>, role: string, source: string) {
  const candidate = /^quality-(alt|challenge)-(\d+)$/.exec(role);
  const quality = state.qualityArtifacts as {
    smallMakeCode?: string;
    oracleCode?: string;
    alternatives?: { code: string }[];
    challenges?: { code: string }[];
  };
  if (candidate) {
    const list = candidate[1] === "alt" ? quality.alternatives : quality.challenges;
    list[Number(candidate[2])] = { ...list[Number(candidate[2])], code: source };
  } else if (role === "quality-small-make") quality.smallMakeCode = source;
  else if (role === "quality-oracle") quality.oracleCode = source;
  else {
    const field = { make: "makeCode", std: "stdCode", checker: "checkerCode", validator: "validatorCode" }[role];
    state[field || `${role}Code`] = source;
  }
}

/**
 * The programs of a runner request, as the job's state has them now: a repaired program replaces its old source and
 * nothing else of the request changes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The versioned runner wire payload
export function syncRequestPrograms(request: any, state: Record<string, unknown>) {
  for (const [field, role] of [
    ["makeCode", "make"],
    ["stdCode", "std"],
    ["validatorCode", "validator"],
    ["checkerCode", "checker"],
    ["interactorCode", "interactor"],
    ["managerCode", "manager"]
  ])
    if (typeof request[field] === "string") request[field] = jobProgram(state, role);
  if (request.quality) {
    request.quality.smallMakeCode = jobProgram(state, "quality-small-make");
    request.quality.oracleCode = jobProgram(state, "quality-oracle");
    for (const [index, item] of request.quality.alternatives.entries())
      request.quality.alternatives[index] = { ...item, code: jobProgram(state, `quality-alt-${index}`) };
    for (const [index, item] of request.quality.challenges.entries())
      request.quality.challenges[index] = { ...item, code: jobProgram(state, `quality-challenge-${index}`) };
  }
}

/** Every program a runner request runs, by role, with its SHA-256: what a qualification is bound to. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The versioned runner wire payload
export function requestSources(request: any): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const [field, role] of [
    ["makeCode", "make"],
    ["stdCode", "std"],
    ["validatorCode", "validator"],
    ["checkerCode", "checker"],
    ["interactorCode", "interactor"],
    ["managerCode", "manager"],
    ["graderCode", "grader"]
  ])
    if (typeof request[field] === "string") sources[role] = sha256Of(request[field]);
  if (request.quality) {
    sources["quality-small-make"] = sha256Of(request.quality.smallMakeCode);
    sources["quality-oracle"] = sha256Of(request.quality.oracleCode);
    request.quality.alternatives.forEach((item: { code: string }, index: number) => {
      sources[`quality-alt-${index}`] = sha256Of(item.code);
    });
    request.quality.challenges.forEach((item: { code: string }, index: number) => {
      sources[`quality-challenge-${index}`] = sha256Of(item.code);
    });
  }
  return sources;
}

/**
 * What published test data was qualified with: every program of the run that made it, by SHA-256, and the repairs that
 * made them what they are. A qualification is of exactly these programs (review Part III, W04).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The versioned runner wire payload
export function generationRevision(request: any, state: Record<string, unknown>) {
  const sources = requestSources(request);
  return {
    digest: aiContractDigest(sources),
    sources,
    repairs: repairState(state).revisions.map(revision => ({
      round: revision.round,
      role: revision.role,
      by: revision.by,
      failure: revision.failure.kind,
      from: revision.from,
      to: revision.to,
      ...(revision.rejected ? { rejected: revision.rejected } : {}),
      ...(revision.test ? { test: revision.test } : {}),
      ...(revision.result ? { result: revision.result } : {})
    }))
  };
}

/** What each program is, and what a repair of it must keep. */
const CONTRACTS: Record<string, string> = {
  make: 'make.cpp, the test input generator. argv[1] is the subtask id and argv[2] a positive case index (also on stdin as "subtask caseIndex"); the case index selects a coverage scenario and is not a seed. It writes exactly ONE legal complete input to stdout and nothing else, obeying that subtask\'s bounds and every global constraint, within 5 seconds and 512 MiB; it exits nonzero rather than weaken a constraint. Random choices use std::random_device rd; const auto seed = rd(); std::mt19937_64 rnd(seed); with fresh entropy, never a fixed seed, time() or a fallback.',
  "quality-small-make":
    "small-make.cpp, the small-case input generator of the differential test. Same arguments as make.cpp; it writes ONE legal small input to stdout that the exact oracle solves within 5 seconds, obeying that subtask and every global constraint, never below the required minimum sizes. Random choices use std::random_device as make.cpp does.",
  std: "std.cpp, the reference solution: correct and efficient within the problem's time and memory limits, reading stdin and writing stdout (no files, no freopen).",
  validator:
    "validator.cpp, the input validator. It reads ONE input from stdin; argv[1] is the subtask id (0 means the whole problem's constraints, used for statement samples) and argv[2] the case index. It exits 0 only for a legal input, and nonzero with a short reason on stderr otherwise. It checks every constraint of the statement and of the subtask exactly: it never invents a constraint and never weakens one.",
  checker:
    'checker.cpp, the output checker: #include "testlib.h", registerTestlibCmd(argc, argv); argv[1] is the input, argv[2] the contestant\'s output, argv[3] the answer. It accepts every valid output and rejects invalid, malformed, missing or excess output, with quitf(_ok/_wa/_pe/_fail) only: no partial scores.',
  interactor:
    'interactor.cpp, the interactor: argv[1] is the hidden input file. It talks to the contestant over stdin/stdout, flushing every message, enforces the protocol and its limits, writes "ok" to stderr and exits 0 on success, "wrong answer: reason" and exits 1 on a wrong answer, "FAIL: reason" and exits 3 on an invalid hidden input.',
  manager:
    'manager.cpp, the communication manager: argv[1] is the hidden input file. It runs the protocol with the contestant\'s processes over stdin/stdout, enforces the protocol and its limits, writes "ok" to stderr and exits 0 on success, "wrong answer: reason" and exits 1 on a wrong answer, "FAIL: reason" and exits 3 on an invalid hidden input.',
  "quality-oracle":
    "oracle.cpp, a simple exact solver for small inputs (exhaustive or mathematically direct), independent of the efficient solutions, reading stdin and writing stdout.",
  alternative:
    "an independently derived correct and efficient solution, structurally different from the reference solution, reading stdin and writing stdout within the problem's limits.",
  challenge:
    "a deliberately imperfect attempted solution for the quality gate: it implements the target below exactly, a realistic wrong or slow solution that passes the official samples and some small legal cases. Keep its defect: never make it correct, and never add sleeps, crashes, constant answers or hardcoded samples."
};

export function repairContract(role: string): string {
  if (/^quality-alt-\d+$/.test(role)) return CONTRACTS.alternative;
  if (/^quality-challenge-\d+$/.test(role)) return CONTRACTS.challenge;
  return CONTRACTS[role];
}

/** A program's file name as an author knows it. */
export function programFile(role: string): string {
  const candidate = /^quality-(alt|challenge)-(\d+)$/.exec(role);
  if (candidate) return `${candidate[1] === "alt" ? "alternative" : "challenge"}-${Number(candidate[2]) + 1}.cpp`;
  return `${role.replace(/^quality-/, "")}.cpp`;
}

/**
 * Whether an artifact's bytes may go to the model: not when they're (from) one of the problem's own sample files,
 * which the problem's author uploaded and the job never sends to a provider. Statement samples and what the job's own
 * programs made may.
 */
export function modelVisible(observation: Pick<StoredAiObservation, "phase">, artifact: StoredAiArtifact): boolean {
  if (artifact.classification === "public") return true;
  return !(artifact.classification === "author-private" && SAMPLE_PHASES.includes(observation.phase));
}

/**
 * What the model is told about a failure: what failed, how, and previews of the bytes it may see, as data. The bytes of
 * the problem's own sample files are left out, and so are the excerpts of their difference.
 */
export function failureContext(
  observation: Omit<StoredAiObservation, "attemptId">,
  diagnostics: string | null
): Record<string, unknown> {
  const visible = observation.artifacts.filter(artifact => modelVisible(observation, artifact));
  const hidden = visible.length < observation.artifacts.length;
  const { execution, difference } = observation;
  return {
    kind: observation.kind,
    phase: observation.phase,
    ...(observation.role ? { program: programFile(observation.role) } : {}),
    ...(observation.subject ? { subject: observation.subject } : {}),
    ...(observation.subtask != null ? { subtask: observation.subtask } : {}),
    ...(observation.scenarioIndex != null ? { caseIndex: observation.scenarioIndex } : {}),
    ...(observation.verdict ? { verdict: observation.verdict } : {}),
    ...(observation.expectedBasis ? { comparedWith: observation.expectedBasis } : {}),
    ...(execution ? { execution } : {}),
    ...(difference
      ? {
          difference: hidden ? { unit: difference.unit, index: difference.index } : difference
        }
      : {}),
    // A summary can quote the file (e.g. a validator's reason)
    ...(hidden ? {} : { summary: observation.summary }),
    ...(observation.search ? { search: observation.search } : {}),
    ...(diagnostics && !hidden ? { diagnostics } : {}),
    artifacts: visible.map(artifact => ({
      role: artifact.role,
      size: artifact.originalSize,
      ...(artifact.preview
        ? { preview: artifact.preview, truncated: artifact.originalSize > AI_EVIDENCE_LIMITS.previewBytes }
        : {})
    })),
    ...(hidden ? { withheld: "The input is one of the problem's own sample files, which isn't shared." } : {})
  };
}
