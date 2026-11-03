/*
 * What an AI run's failure knows about itself (review Part III, H01). Each place a failure passes through adds what it
 * knows: the sandbox run its program, verdict and measurements, a comparison the data compared, the quality checks
 * the role of the program checked and the case. The runner then keeps it, with its evidence, before it cleans up
 * (see aiEvidence.ts). Pure: the quality checks' tests load it without the judge.
 */
import type {
  AiArtifactClassification,
  AiArtifactRole,
  AiExecutionMeasure,
  AiExpectedBasis,
  AiFailureKind,
  AiFailureVerdict
} from "@libreoj/judge-protocol";

// In memory, or a file that exists until the failure is kept
export type EvidenceData = Buffer | { path: string };

export interface FailureDetails {
  kind?: AiFailureKind;
  phase?: string;
  role?: string;
  candidate?: string;
  subject?: string;
  subtask?: number;
  scenarioIndex?: number;
  verdict?: AiFailureVerdict;
  expectedBasis?: AiExpectedBasis;
  execution?: AiExecutionMeasure;
  search?: { attempts: number; budget: number; stoppedBy: "budget" | "capacity" };
  relation?: "small_counterexample";
  // Of the input and the outputs (diagnostics are always the author's)
  classification?: AiArtifactClassification;
  data?: Partial<Record<AiArtifactRole, EvidenceData>>;
  // Observations that didn't end the run but explain it, e.g. small counterexamples of challenges that survived
  related?: FailureDetails[];
}

const DETAILS = "aiFailureDetails";

// `base` with the fields `over` sets
function merge(base: FailureDetails, over: FailureDetails): FailureDetails {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) if (value !== undefined) merged[key] = value;
  if (base.data || over.data) merged.data = { ...base.data, ...over.data };
  return merged as FailureDetails;
}

export function detailsOf(error: unknown): FailureDetails | undefined {
  return error && typeof error === "object" ? (error as Record<string, FailureDetails>)[DETAILS] : undefined;
}

/**
 * Adds what's known here to a failure, without replacing what a place closer to it already said: the sandbox knows
 * better than its caller which program failed.
 */
export function describe<T>(error: T, details: FailureDetails): T {
  if (!error || typeof error !== "object") return error;
  (error as Record<string, FailureDetails>)[DETAILS] = merge(details, detailsOf(error) || {});
  return error;
}

/** A new failure that replaces `cause` (e.g. "this challenge isn't valid"), with its evidence and `details` on top. */
export function reclassify<T extends Error>(error: T, cause: unknown, details: FailureDetails): T {
  (error as unknown as Record<string, FailureDetails>)[DETAILS] = merge(detailsOf(cause) || {}, details);
  return error;
}

/** Runs `work`, adding `details` to its failure. */
export async function within<T>(details: FailureDetails, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw describe(error, details);
  }
}
