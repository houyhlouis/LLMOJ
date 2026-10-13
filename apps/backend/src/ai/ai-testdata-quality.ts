import { AiError } from "./ai.types";

export interface AiQualityTarget {
  id: string;
  kind: "wrong" | "slow";
  algorithm: string;
  reason: string;
  subtasks: number[];
  construction: string;
}
export interface AiQualityPlan {
  version: 1;
  correctAlgorithms: string[];
  oracleMethod: string;
  smallInputStrategy: string;
  targets: AiQualityTarget[];
}
export interface AiQualityRequest {
  version: 1;
  fuzzCases: { subtask: number; seed: number }[];
  smallMakeCode: string;
  oracleCode: string;
  alternatives: { id: string; code: string }[];
  challenges: { id: string; code: string; kind: "wrong" | "slow"; subtasks: number[]; reason: string }[];
  extraAttempts: number;
}

function text(value: unknown, limit = 4000): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= limit;
}

/** The plan describes legal counterexamples, never arbitrary algorithm-name bans. */
export function normalizeAiQualityPlan(value: unknown, subtasks: { id: number }[]): AiQualityPlan {
  const fail = () => {
    throw new AiError("INVALID_AI_QUALITY_PLAN");
  };
  if (!value || typeof value !== "object") return fail();
  const plan = value as AiQualityPlan;
  const legalIds = new Set(subtasks.map(subtask => subtask.id));
  if (
    plan.version !== 1 ||
    !Array.isArray(plan.correctAlgorithms) ||
    plan.correctAlgorithms.length < 2 ||
    plan.correctAlgorithms.length > 4 ||
    plan.correctAlgorithms.some(method => !text(method)) ||
    new Set(plan.correctAlgorithms.map(method => method.trim().toLowerCase())).size !== plan.correctAlgorithms.length ||
    !text(plan.oracleMethod) ||
    !text(plan.smallInputStrategy) ||
    !Array.isArray(plan.targets) ||
    plan.targets.length < 1 ||
    plan.targets.length > 4 ||
    !plan.targets.some(target => target?.kind === "wrong")
  )
    return fail();
  const seen = new Set<string>(["independent"]);
  for (const target of plan.targets) {
    if (
      !target ||
      !text(target.id, 48) ||
      !/^[a-z][a-z0-9_-]*$/.test(target.id) ||
      seen.has(target.id) ||
      !["wrong", "slow"].includes(target.kind) ||
      !text(target.algorithm) ||
      !text(target.reason, 2000) ||
      !text(target.construction) ||
      !Array.isArray(target.subtasks) ||
      !target.subtasks.length ||
      new Set(target.subtasks).size !== target.subtasks.length ||
      target.subtasks.some(id => !Number.isSafeInteger(id) || !legalIds.has(id))
    )
      return fail();
    seen.add(target.id);
  }
  return {
    version: 1,
    correctAlgorithms: plan.correctAlgorithms.map(method => method.trim()),
    oracleMethod: plan.oracleMethod.trim(),
    smallInputStrategy: plan.smallInputStrategy.trim(),
    targets: plan.targets.map(target => ({
      id: target.id,
      kind: target.kind,
      algorithm: target.algorithm.trim(),
      reason: target.reason.trim(),
      subtasks: [...target.subtasks],
      construction: target.construction.trim()
    }))
  };
}

/** Exercise every declared subtask, even when there are more subtasks than the default fuzz budget. */
export function allocateAiFuzzCases(subtasks: { id: number }[], requested = 64) {
  if (
    !Number.isSafeInteger(requested) ||
    requested < 64 ||
    requested > 1000 ||
    !subtasks.length ||
    subtasks.length > 1000 ||
    new Set(subtasks.map(item => item.id)).size !== subtasks.length ||
    subtasks.some(item => !Number.isSafeInteger(item.id) || item.id < 1 || item.id > 1000)
  )
    throw new AiError("INVALID_AI_QUALITY_PLAN");
  const count = Math.max(requested, subtasks.length);
  return Array.from({ length: count }, (_, index) => ({
    subtask: subtasks[index % subtasks.length].id,
    seed: Math.floor(index / subtasks.length) + 1
  }));
}

/** Reject old/partial runner receipts before uploading or activating any generated data. */
export function assertAiQualityResult(value: unknown, request: AiQualityRequest, cases: { subtask: number }[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Validate the runner's untrusted JSON receipt here.
  const result = value as any;
  if (
    !result ||
    result.version !== 1 ||
    result.fuzzPassed !== request.fuzzCases.length ||
    result.alternativeCount !== request.alternatives.length ||
    result.alternativesPassed !== request.alternatives.length * cases.length ||
    result.challengeCount !== request.challenges.length ||
    result.challengesKilled !== request.challenges.length ||
    !Number.isSafeInteger(result.extraAttemptsUsed) ||
    result.extraAttemptsUsed < 0 ||
    result.extraAttemptsUsed > request.extraAttempts ||
    !Array.isArray(result.challengeResults) ||
    result.challengeResults.length !== request.challenges.length
  )
    throw new AiError("TESTDATA_QUALITY_GATE_FAILED", "Missing or incomplete differential/adversarial validation");
  const ids = new Set<string>();
  for (const item of result.challengeResults) {
    const target = request.challenges.find(challenge => challenge.id === item?.id);
    if (
      !target ||
      ids.has(item.id) ||
      item.kind !== target.kind ||
      !Number.isSafeInteger(item.killedBy) ||
      item.killedBy < 1 ||
      item.killedBy > cases.length ||
      !target.subtasks.includes(cases[item.killedBy - 1].subtask) ||
      !(target.kind === "slow" ? ["TLE", "MLE"] : ["WA", "RE", "TLE", "MLE"]).includes(item.verdict)
    )
      throw new AiError("TESTDATA_QUALITY_GATE_FAILED", "Invalid adversarial witness");
    ids.add(item.id);
  }
}
