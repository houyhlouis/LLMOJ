/*
 * Replays of kept failures (review Part III, H01/W03): what to run again for a failure, from what it records. A replay
 * consumes the exact bytes kept with the failure (never a regenerated input) and runs the same check with the job's
 * programs as they are now, a few times; whether each run failed the same way says whether the failure reproduces.
 */
import { createHash } from "crypto";

import {
  AI_MALFORMED_OUTPUT,
  AI_PROGRAM_ROLE,
  aiReplayOutcome,
  type AiArtifactRole,
  type AiReplayCheck,
  type AiReplayOutcome,
  type AiReplayRun
} from "@libreoj/judge-protocol";

import type { StoredAiObservation } from "./ai-observation.entity";

/** Why a failure can't be replayed. */
export type AiReplayUnsupported =
  // A tutorial's code that failed its check: it isn't kept with the job
  | "TUTORIAL_CODE"
  // A failure of no single program on one input (e.g. a challenge that survived, the run's budget, the infrastructure)
  | "NOT_REPLAYABLE"
  // The kept bytes it needs aren't there (not kept, only their start was kept, or expired)
  | "EVIDENCE_MISSING"
  // Interactive and communication problems: only compilations and input validation are replayed
  | "PROTOCOL"
  // The job no longer has a program it needs (e.g. a retry replaced it and failed before writing a new one)
  | "PROGRAM_MISSING";

/** What a replay runs, before the job's programs and the kept files are added. */
export interface AiReplayPlan {
  check: AiReplayCheck;
  role: string;
  against?: string;
  expect?: "reject" | "verdict";
  subtask?: number;
  caseIndex?: number;
  // The kept artifacts it sends
  artifacts: AiArtifactRole[];
  // The programs it compiles
  programs: string[];
  repeat: number;
}

const REPEAT = 3;
const GENERATORS = ["make", "quality-small-make"];
const EXECUTION_FAILURES = ["runtime_error", "time_limit", "memory_limit", "output_limit"];
const MALFORMED_SHA256 = createHash("sha256").update(Buffer.from(AI_MALFORMED_OUTPUT)).digest("hex");

// The sample's number in a failure's subject ("sample 2", "protocol sample 1")
const sampleNumber = (subject?: string) => Number(/(?:^|\s)sample (\d+)/.exec(subject || "")?.[1]) || null;

/** What to replay for a failure, or why it can't be. `customChecker`: the job's outputs are compared by its checker. */
export function replayPlan(
  observation: Omit<StoredAiObservation, "attemptId">,
  options: { customChecker: boolean; protocol: boolean }
): { plan: AiReplayPlan } | { unsupported: AiReplayUnsupported } {
  const { kind, role } = observation;
  if (observation.context === "tutorial-reference" || observation.operation === "validate-reference")
    return { unsupported: "TUTORIAL_CODE" };
  if (!role || !AI_PROGRAM_ROLE.test(role)) return { unsupported: "NOT_REPLAYABLE" };
  const kept = (artifact: AiArtifactRole) =>
    observation.artifacts.some(
      item => item.role === artifact && item.stored && item.size === item.originalSize && !item.missing
    );
  const checker = options.customChecker ? ["checker"] : [];
  let plan: AiReplayPlan;
  const validation = (): AiReplayPlan | null => {
    const subtask = observation.subtask ?? 0;
    const caseIndex = subtask ? observation.scenarioIndex : sampleNumber(observation.subject);
    return caseIndex == null
      ? null
      : {
          check: "validate",
          role: "validator",
          subtask,
          caseIndex,
          artifacts: ["input"],
          programs: ["validator"],
          repeat: REPEAT
        };
  };
  if (kind === "compile_error") plan = { check: "compile", role, artifacts: [], programs: [role], repeat: 1 };
  else if (kind === "validator_rejection" || (EXECUTION_FAILURES.includes(kind) && role === "validator")) {
    plan = validation();
    if (!plan) return { unsupported: "NOT_REPLAYABLE" };
  } else if (kind === "solver_disagreement") {
    const against =
      observation.expectedBasis === "official_sample"
        ? "expected"
        : observation.expectedBasis === "candidate_oracle"
          ? role === "quality-oracle"
            ? "self"
            : "quality-oracle"
          : observation.expectedBasis === "reference_output"
            ? role === "std"
              ? "self"
              : "std"
            : null;
    if (!against) return { unsupported: "NOT_REPLAYABLE" };
    plan = {
      check: "compare",
      role,
      against,
      artifacts: against === "expected" ? ["input", "expected"] : ["input"],
      programs: [...new Set([role, ...(["expected", "self"].includes(against) ? [] : [against]), ...checker])],
      repeat: REPEAT
    };
  } else if (EXECUTION_FAILURES.includes(kind) && GENERATORS.includes(role)) {
    if (observation.subtask == null || observation.scenarioIndex == null) return { unsupported: "NOT_REPLAYABLE" };
    plan = {
      check: "generate",
      role,
      subtask: observation.subtask,
      caseIndex: observation.scenarioIndex,
      artifacts: [],
      programs: [role],
      repeat: REPEAT
    };
  } else if (kind === "checker_failure" || (EXECUTION_FAILURES.includes(kind) && role === "checker")) {
    const actual = observation.artifacts.find(item => item.role === "actual");
    plan = {
      check: "checker",
      role: "checker",
      expect: actual?.sha256 === MALFORMED_SHA256 ? "reject" : "verdict",
      artifacts: ["input", "actual", "expected"],
      programs: ["checker"],
      repeat: REPEAT
    };
  } else if (EXECUTION_FAILURES.includes(kind) && !["interactor", "manager"].includes(role))
    plan = { check: "run", role, artifacts: ["input"], programs: [role], repeat: REPEAT };
  else return { unsupported: "NOT_REPLAYABLE" };
  if (options.protocol && !["compile", "validate"].includes(plan.check)) return { unsupported: "PROTOCOL" };
  if (!plan.artifacts.every(kept)) return { unsupported: "EVIDENCE_MISSING" };
  return { plan };
}

/** A program's source as the job has it now, by the role failures name it with; null if it has none. */
export function jobProgram(state: Record<string, unknown>, role: string): string | null {
  const quality = (state.qualityArtifacts || {}) as {
    smallMakeCode?: string;
    oracleCode?: string;
    alternatives?: { code?: string }[];
    challenges?: { code?: string }[];
  };
  const candidate = /^quality-(alt|challenge)-(\d+)$/.exec(role);
  const source = candidate
    ? (candidate[1] === "alt" ? quality.alternatives : quality.challenges)?.[Number(candidate[2])]?.code
    : {
        make: state.makeCode,
        std: state.stdCode,
        checker: state.checkerCode,
        validator: state.validatorCode,
        interactor: state.interactorCode,
        manager: state.managerCode,
        "quality-small-make": quality.smallMakeCode,
        "quality-oracle": quality.oracleCode
      }[role];
  return typeof source === "string" && source.trim() ? source : null;
}

/** Whether the replayed programs are the ones that failed: all of them ("same"), not all ("changed"), or not known. */
export function replayRevision(
  observation: Pick<StoredAiObservation, "sourceHashes">,
  programs: Record<string, string>
): "same" | "changed" | "unknown" {
  if (!observation.sourceHashes) return "unknown";
  return Object.entries(programs).every(
    ([role, source]) => observation.sourceHashes[role] === createHash("sha256").update(source).digest("hex")
  )
    ? "same"
    : "changed";
}

/** A replay as kept with its failure. */
export interface AiReplayRecord {
  id: string;
  status: "running" | "failed" | AiReplayOutcome;
  startedAt: string;
  finishedAt?: string;
  // Who started it
  userId: number;
  check: AiReplayCheck;
  revision: "same" | "changed" | "unknown";
  // Whether the programs ran with the profiles the failure records
  profiles: "same" | "changed" | "unknown";
  runs?: AiReplayRun[];
  // Where it ran, and on what
  origin?: "local" | "judge";
  runtime?: { judgeProgram: string; sandboxImage: string; arch: string };
  // Why it failed itself
  error?: string;
}

export const replayStatus = (kind: StoredAiObservation["kind"], runs: AiReplayRun[]) => aiReplayOutcome(kind, runs);
