import { randomUUID, createHash } from "crypto";

import { aiContractDigest } from "@libreoj/judge-protocol";

import { AiError } from "./ai.types";
import { type AiPlanIssue, type AiPlanProposal } from "./ai-testdata-quality";
import { qualityPlanSchema } from "./ai-plan-definition";

export const AI_PLAN_SCHEMA_VERSION = 2;
export { qualityPlanSchema } from "./ai-plan-definition";
export function qualityPlanInstructions(subtasks: { id: number }[]) {
  return `Use this JSON Schema exactly: ${JSON.stringify(qualityPlanSchema(subtasks))}. The backend assigns opaque target ids and the version. Include at least one wrong target; correct methods must be distinct. A structurally independent implementation of the same algorithm is allowed when it is the only feasible algorithm: document the relationship and independent invariants in correctAlgorithms. Preserve all legal bounds and target obligations. Never claim to have seen private fixtures.`;
}
export function preparePlanProposal(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = JSON.parse(JSON.stringify(value));
  normalized.version = 1;
  if (Array.isArray(normalized.targets))
    for (const target of normalized.targets)
      if (target && typeof target === "object" && !Array.isArray(target))
        target.id = `t_${randomUUID().replace(/-/g, "")}`;
  return normalized;
}
export interface AiPlanRepair {
  schemaVersion: number;
  spent: number;
  limit: 1;
  status: "pending" | "repairing" | "accepted" | "exhausted" | "review";
  proposalHash?: string;
  rejectedFields: number;
  acceptedRevision?: string;
  generationId?: string;
  repairGenerationId?: string;
  structuredOutput: "json_schema" | "prompt_fallback";
}
export function repairablePlanIssues(issues: AiPlanIssue[]): boolean {
  return (
    issues.length > 0 &&
    issues.every(
      i =>
        i.repairClass !== "content" &&
        !["minItems", "maxItems", "wrongTarget"].includes(i.rule) &&
        i.path !== "" &&
        !["targets", "correctAlgorithms"].includes(i.path)
    )
  );
}
export function fieldRepairPrompt(proposal: AiPlanProposal) {
  return `Repair only the listed invalid fields of this proposal, preserving all accepted fields and the mathematical method. Return JSON {"hash":"${proposal.hash}","replacements":[{"path":"one listed path","value":"replacement value"}]}. Exactly one replacement per listed path. Never remove targets, alter bounds, weaken obligations, or change other fields. Do not solve the problem again. Issues: ${JSON.stringify(proposal.issues)}. Proposal: ${JSON.stringify(proposal.candidate)}`;
}
export function applyPlanFieldRepair(proposal: AiPlanProposal, patch: unknown): unknown {
  const p = patch as { hash?: string; replacements?: { path: string; value: unknown }[] };
  const allowed = new Set(proposal.issues.map(i => i.path));
  if (
    !repairablePlanIssues(proposal.issues) ||
    !proposal.candidate ||
    p?.hash !== proposal.hash ||
    createHash("sha256").update(JSON.stringify(proposal.candidate)).digest("hex").slice(0, 32) !== proposal.hash ||
    !Array.isArray(p.replacements) ||
    p.replacements.length !== allowed.size ||
    new Set(p.replacements.map(r => r?.path)).size !== allowed.size ||
    p.replacements.some(r => !r || !allowed.has(r.path) || r.value === undefined)
  )
    throw new AiError("INVALID_AI_PLAN_FIELD_REPAIR");
  const result = JSON.parse(JSON.stringify(proposal.candidate));
  for (const r of p.replacements) {
    if (
      !/^(?:correctAlgorithms\[\d+\]|oracleMethod|smallInputStrategy|targets\[\d+\]\.(?:kind|algorithm|reason|construction|subtasks(?:\[\d+\])?))$/.test(
        r.path
      )
    )
      throw new AiError("INVALID_AI_PLAN_FIELD_REPAIR");
    const keys = r.path.replace(/\[(\d+)\]/g, ".$1").split(".");
    let target = result;
    for (const key of keys.slice(0, -1)) {
      if (!target || typeof target !== "object" || !Object.prototype.hasOwnProperty.call(target, key))
        throw new AiError("INVALID_AI_PLAN_FIELD_REPAIR");
      target = target[key];
    }
    // A reference list may be corrected, never emptied or shortened to erase an obligation.
    const previous = target[keys[keys.length - 1]];
    if (Array.isArray(previous) && (!Array.isArray(r.value) || r.value.length < previous.length))
      throw new AiError("INVALID_AI_PLAN_FIELD_REPAIR");
    target[keys[keys.length - 1]] = r.value;
  }
  return result;
}
export const acceptedPlanRevision = (value: unknown) =>
  aiContractDigest({ schemaVersion: AI_PLAN_SCHEMA_VERSION, value });
