import { createHash } from "crypto";

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

/**
 * Why a proposed testing plan was rejected, field by field (review Part IV, IV-01/W01): the path of the field, the rule
 * it broke, what the rule expects and what the plan had (a length or a count, a type, or a short value; never the
 * field's text). `repairClass` says what fixing it takes: `format` (a type, an enum, an identifier, the version),
 * `restatement` (the same content shorter, or once), `reference` (a subtask reference), `content` (something the plan
 * must add or reconsider). The rules are the ones the plan always had; this release only reports them.
 */
export interface AiPlanIssue {
  path: string;
  rule:
    | "required"
    | "type"
    | "const"
    | "enum"
    | "nonEmpty"
    | "maxLength"
    | "pattern"
    | "minItems"
    | "maxItems"
    | "unique"
    | "reserved"
    | "reference"
    | "wrongTarget";
  expected?: string | number;
  actual?: string | number;
  repairClass: "format" | "restatement" | "reference" | "content";
}

const PLAN_LIMITS = Object.freeze({
  text: 4000,
  reason: 2000,
  id: 48,
  algorithms: [2, 4],
  targets: [1, 4],
  // Issues kept and reported for one proposal
  issues: 40,
  // A rejected proposal's text kept with the job, privately (its owner's job), when it's at most this large
  candidateBytes: 64 * 1024
});

function short(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function typeName(value: unknown) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

/**
 * Checks a proposed plan: the normalized plan when every rule holds, else every issue found (at most 40). A plan is
 * accepted exactly when it was before: the same rules, now all reported instead of the first one failing silently.
 */
export function validateAiQualityPlan(
  value: unknown,
  subtasks: { id: number }[]
): { plan: AiQualityPlan | null; issues: AiPlanIssue[] } {
  const issues: AiPlanIssue[] = [];
  const issue = (item: AiPlanIssue) => {
    if (issues.length < PLAN_LIMITS.issues) issues.push(item);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issue({ path: "", rule: "type", expected: "object", actual: typeName(value), repairClass: "format" });
    return { plan: null, issues };
  }
  const plan = value as Record<string, unknown>;
  // A nonempty string at most `limit` characters long (its length as written, spaces included)
  const text = (path: string, field: unknown, limit: number) => {
    if (field === undefined) issue({ path, rule: "required", expected: "string", repairClass: "content" });
    else if (typeof field !== "string")
      issue({ path, rule: "type", expected: "string", actual: typeName(field), repairClass: "format" });
    else if (!field.trim()) issue({ path, rule: "nonEmpty", repairClass: "content" });
    else if (field.length > limit)
      issue({ path, rule: "maxLength", expected: limit, actual: field.length, repairClass: "restatement" });
    else return true;
    return false;
  };
  const list = (path: string, field: unknown, [min, max]: number[]) => {
    if (!Array.isArray(field)) {
      issue({
        path,
        rule: field === undefined ? "required" : "type",
        expected: "array",
        ...(field === undefined ? {} : { actual: typeName(field) }),
        repairClass: field === undefined ? "content" : "format"
      });
      return false;
    }
    if (field.length < min)
      issue({ path, rule: "minItems", expected: min, actual: field.length, repairClass: "content" });
    else if (field.length > max)
      issue({ path, rule: "maxItems", expected: max, actual: field.length, repairClass: "restatement" });
    return true;
  };

  if (plan.version !== 1)
    issue({
      path: "version",
      rule: plan.version === undefined ? "required" : "const",
      expected: 1,
      ...(plan.version === undefined ? {} : { actual: short(plan.version) }),
      repairClass: "format"
    });
  if (list("correctAlgorithms", plan.correctAlgorithms, PLAN_LIMITS.algorithms)) {
    const methods = plan.correctAlgorithms as unknown[];
    const valid = methods.map((method, index) => text(`correctAlgorithms[${index}]`, method, PLAN_LIMITS.text));
    if (
      valid.every(Boolean) &&
      new Set(methods.map(method => (method as string).trim().toLowerCase())).size !== methods.length
    )
      issue({ path: "correctAlgorithms", rule: "unique", repairClass: "content" });
  }
  text("oracleMethod", plan.oracleMethod, PLAN_LIMITS.text);
  text("smallInputStrategy", plan.smallInputStrategy, PLAN_LIMITS.text);

  const legalIds = new Set(subtasks.map(subtask => subtask.id));
  if (list("targets", plan.targets, PLAN_LIMITS.targets)) {
    const targets = plan.targets as unknown[];
    if (
      targets.length >= PLAN_LIMITS.targets[0] &&
      !targets.some(target => (target as AiQualityTarget)?.kind === "wrong")
    )
      issue({ path: "targets", rule: "wrongTarget", expected: 'a target of kind "wrong"', repairClass: "content" });
    const seen = new Set<string>();
    targets.forEach((item, index) => {
      const path = `targets[${index}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        issue({ path, rule: "type", expected: "object", actual: typeName(item), repairClass: "format" });
        return;
      }
      const target = item as Record<string, unknown>;
      if (text(`${path}.id`, target.id, PLAN_LIMITS.id)) {
        const id = target.id as string;
        if (!/^[a-z][a-z0-9_-]*$/.test(id))
          issue({
            path: `${path}.id`,
            rule: "pattern",
            expected: "^[a-z][a-z0-9_-]*$",
            actual: short(id),
            repairClass: "format"
          });
        else if (id === "independent")
          issue({ path: `${path}.id`, rule: "reserved", actual: id, repairClass: "format" });
        else if (seen.has(id)) issue({ path: `${path}.id`, rule: "unique", actual: id, repairClass: "format" });
        seen.add(id);
      }
      if (!["wrong", "slow"].includes(target.kind as string))
        issue({
          path: `${path}.kind`,
          rule: target.kind === undefined ? "required" : "enum",
          expected: "wrong|slow",
          ...(target.kind === undefined ? {} : { actual: short(target.kind) }),
          repairClass: "format"
        });
      text(`${path}.algorithm`, target.algorithm, PLAN_LIMITS.text);
      text(`${path}.reason`, target.reason, PLAN_LIMITS.reason);
      text(`${path}.construction`, target.construction, PLAN_LIMITS.text);
      const references = target.subtasks;
      if (!Array.isArray(references) || !references.length)
        issue({
          path: `${path}.subtasks`,
          rule: references === undefined ? "required" : Array.isArray(references) ? "minItems" : "type",
          expected: Array.isArray(references) ? 1 : "array",
          ...(references === undefined || Array.isArray(references) ? {} : { actual: typeName(references) }),
          repairClass: "reference"
        });
      else {
        if (new Set(references).size !== references.length)
          issue({ path: `${path}.subtasks`, rule: "unique", repairClass: "restatement" });
        references.forEach((reference, position) => {
          const at = `${path}.subtasks[${position}]`;
          if (!Number.isSafeInteger(reference))
            issue({
              path: at,
              rule: "type",
              expected: "integer",
              actual: typeof reference === "number" ? short(reference) : typeName(reference),
              repairClass: "format"
            });
          else if (!legalIds.has(reference as number))
            issue({
              path: at,
              rule: "reference",
              expected: [...legalIds].join("|"),
              actual: reference as number,
              repairClass: "reference"
            });
        });
      }
    });
  }
  if (issues.length) return { plan: null, issues };
  const valid = value as AiQualityPlan;
  return {
    plan: {
      version: 1,
      correctAlgorithms: valid.correctAlgorithms.map(method => method.trim()),
      oracleMethod: valid.oracleMethod.trim(),
      smallInputStrategy: valid.smallInputStrategy.trim(),
      targets: valid.targets.map(target => ({
        id: target.id,
        kind: target.kind,
        algorithm: target.algorithm.trim(),
        reason: target.reason.trim(),
        subtasks: [...target.subtasks],
        construction: target.construction.trim()
      }))
    },
    issues
  };
}

/** The issues in one line, for the job's error: paths, rules and sizes only */
export function describeAiPlanIssues(issues: AiPlanIssue[], limit = 6) {
  const parts = issues.slice(0, limit).map(item => {
    const expected = item.expected === undefined ? "" : ` ${item.expected}`;
    const actual = item.actual === undefined ? "" : `, got ${item.actual}`;
    return `${item.path || "(plan)"} ${item.rule}${expected}${actual}`;
  });
  if (issues.length > limit) parts.push(`and ${issues.length - limit} more`);
  return `${issues.length} invalid field${issues.length === 1 ? "" : "s"}: ${parts.join("; ")}`;
}

/** A plan that broke its rules (INVALID_AI_QUALITY_PLAN), with every issue */
export class AiPlanError extends AiError {
  constructor(public readonly issues: AiPlanIssue[]) {
    super("INVALID_AI_QUALITY_PLAN", describeAiPlanIssues(issues));
  }
}

/** The plan describes legal counterexamples, never arbitrary algorithm-name bans. */
export function normalizeAiQualityPlan(value: unknown, subtasks: { id: number }[]): AiQualityPlan {
  const { plan, issues } = validateAiQualityPlan(value, subtasks);
  if (!plan) throw new AiPlanError(issues);
  return plan;
}

/**
 * A rejected proposal as the job keeps it (review Part IV, W01): its issues, a digest of what was proposed, and the
 * proposal itself when it's small enough (kept with the job, which only its owner reads), so the next work package can
 * repair it instead of asking for a new analysis. `rejected` counts the job's rejected proposals.
 */
export interface AiPlanProposal {
  hash: string;
  issues: AiPlanIssue[];
  candidate?: unknown;
  rejected: number;
  at: string;
}

export function aiPlanProposal(candidate: unknown, issues: AiPlanIssue[], rejected: number): AiPlanProposal {
  const text = JSON.stringify(candidate ?? null);
  return {
    hash: createHash("sha256").update(text).digest("hex").slice(0, 32),
    issues: issues.slice(0, PLAN_LIMITS.issues),
    ...(Buffer.byteLength(text) <= PLAN_LIMITS.candidateBytes ? { candidate } : {}),
    rejected,
    at: new Date().toISOString()
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

const count = (value: unknown, max: number, min = 0) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/**
 * The selection a runner reports with its receipt (review Part III, W05), when it reports one (judges before it
 * don't): distinct differential inputs, each challenge's tested and rejecting cases, the replacements and the search,
 * and the tested outcome matrix, consistent with each other and with the witnesses.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The runner's untrusted JSON receipt
function assertAiCoverage(result: any, request: AiQualityRequest, cases: { subtask: number }[]): void {
  const fail = () => {
    throw new AiError("TESTDATA_QUALITY_GATE_FAILED", "Invalid test selection report");
  };
  const challenges = new Map(request.challenges.map(challenge => [challenge.id, challenge]));
  const targetIds = (value: unknown, subtask?: number) =>
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every(id => challenges.has(id) && (subtask == null || challenges.get(id).subtasks.includes(subtask)));
  if (result.fuzzDistinct !== undefined && !count(result.fuzzDistinct, result.fuzzPassed, 1)) fail();
  for (const item of result.challengeResults) {
    if (item.tested === undefined && item.kills === undefined) continue;
    if (!count(item.tested, cases.length, 1) || !count(item.kills, item.tested, 1)) fail();
  }
  if (result.matrix !== undefined) {
    if (!Array.isArray(result.matrix) || result.matrix.length > cases.length) fail();
    const rows = new Map<number, { killed: string[]; passed: string[] }>();
    for (const row of result.matrix) {
      if (!row || !count(row.case, cases.length, 1) || rows.has(row.case)) fail();
      const { subtask } = cases[row.case - 1];
      if (!targetIds(row.killed, subtask) || !targetIds(row.passed, subtask)) fail();
      if (row.killed.some((id: string) => row.passed.includes(id))) fail();
      rows.set(row.case, row);
    }
    // Each witness is a case whose row says it rejected the challenge
    for (const item of result.challengeResults) if (!rows.get(item.killedBy)?.killed.includes(item.id)) fail();
  }
  if (result.replacements !== undefined) {
    if (!Array.isArray(result.replacements) || result.replacements.length > cases.length * 2) fail();
    for (const item of result.replacements) {
      if (
        !item ||
        !count(item.case, cases.length, 1) ||
        !["search", "small_counterexample"].includes(item.source) ||
        !targetIds(item.kills, cases[item.case - 1].subtask) ||
        !item.kills.length ||
        !targetIds(item.moved) ||
        item.moved.some((id: string) => !item.kills.includes(id))
      )
        fail();
    }
  }
  if (result.search !== undefined) {
    const { search } = result;
    if (
      !search ||
      search.attempts !== result.extraAttemptsUsed ||
      search.budget !== request.extraAttempts ||
      !count(search.found, 1000000) ||
      !count(search.unplaced, search.found) ||
      !count(search.promoted, request.challenges.length) ||
      (Array.isArray(result.replacements) &&
        result.replacements.filter((item: { source: string }) => item.source === "small_counterexample").length !==
          search.promoted)
    )
      fail();
  }
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
  assertAiCoverage(result, request, cases);
}
