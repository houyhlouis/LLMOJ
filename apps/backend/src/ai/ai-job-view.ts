import { randomUUID } from "crypto";

import type { AiJobEntity } from "./ai.entity";
import type { AiBlockingReason, AiStageAttempt as WorkflowStage } from "./ai-workflow-state";

import { deploymentBuildIdentity } from "../health/deployment-identity";

/** Extensible wire codes: clients must display unknown codes using the supplied message. */
export type AiAttentionCode =
  | "needs_configuration"
  | "plan_repair"
  | "plan_feasibility"
  | "interface_mismatch"
  | "provenance_policy"
  | "baseline_challenge"
  | "alternative_timeout"
  | "source_unverified"
  | "scoring_review"
  | "provider_request_failed"
  | "provider_recovery"
  | "provider_accounting_unknown"
  | "qualification_failed"
  | "permission_changed"
  | "job_failed";
export interface AiAttention {
  code: AiAttentionCode;
  message: string;
  retryable: boolean;
}
export type AiStageKind =
  | "queued"
  | "import"
  | "source"
  | "metadata"
  | "planning"
  | "programs"
  | "qualification"
  | "repair"
  | "publication"
  | "completed"
  | "cancelled"
  | "other";
export interface AiStageAttempt {
  id: string;
  attempt: number;
  stage: AiStageKind;
  step: string;
  startedAt: string;
  endedAt?: string;
  deployment?: {
    backendBuild: string | null;
    qualityPolicyVersion: number;
    receiptVersion: number;
    executionProtocolVersion: number;
  };
  outcome?: "advanced" | "completed" | "failed" | "cancelled" | "interrupted";
  scope?: "step" | "dispatch";
  parentId?: string;
  workflowAttempt?: number;
  generationId?: string;
  status?: WorkflowStage["status"];
  model?: string;
  policy?: string;
  promptBytes?: number;
  outputBytes?: number;
  durationMs?: number;
  requests?: number;
  responsePolls?: number;
  failedRequests?: number;
  reuses?: string[];
  invalidates?: string[];
  resumptions?: WorkflowStage["resumptions"];
}
export interface AiJobProjection {
  version: 1;
  attention?: AiAttention;
  requested: number;
  planned: number | null;
  generated: number | null;
  qualified: number | null;
  activated: number | null;
  rejectedPlans: number;
  provenance: "verified" | "unverified" | "not_attempted";
}
export function stageKind(step: string): AiStageKind {
  if (step?.endsWith(".queued")) return "queued";
  if (["queued", "completed", "cancelled", "import", "source"].includes(step)) return step as AiStageKind;
  if (/plan/.test(step)) return "planning";
  if (/repair|replay/.test(step)) return "repair";
  if (/upload|publish/.test(step)) return "publication";
  if (/sandbox|validat|qualif|compile|differential|challenge|generate/.test(step)) return "qualification";
  if (/^testdata/.test(step)) return "programs";
  if (/^(tutorial|difficulty|translate|tags|metadata)/.test(step)) return "metadata";
  if (/^source/.test(step)) return "source";
  if (/^import/.test(step)) return "import";
  return "other";
}
export function attention(job: Pick<AiJobEntity, "status" | "error" | "projection">): AiAttention | null {
  if (job.projection?.attention) return job.projection.attention;
  if (job.status !== "failed") return null;
  const code = (job.error || "").split(":")[0];
  const reasons: Record<string, [AiAttentionCode, string, boolean]> = {
    PROVIDER_HTTP_ERROR: [
      "provider_request_failed",
      "The provider rejected a request; inspect its safe error details.",
      false
    ],
    PROVIDER_NETWORK_ERROR: [
      "provider_request_failed",
      "The provider connection failed; inspect recovery and accounting status.",
      false
    ],
    PROVIDER_TIMEOUT: [
      "provider_request_failed",
      "The provider request timed out; inspect recovery and accounting status.",
      false
    ],
    AI_SCORING_REVIEW_REQUIRED: ["scoring_review", "Review the proposed scoring or case allocation change.", false],
    AI_ALLOCATION_REVIEW_REQUIRED: [
      "scoring_review",
      "Review the partial-credit effect of the case allocation.",
      false
    ],
    INVALID_AI_QUALITY_PLAN: ["plan_repair", "The quality plan has fields requiring repair.", true],
    PROVIDER_RESULT_UNRECOVERABLE: [
      "provider_recovery",
      "The synchronous response finished but its result is unavailable; an explicit retry starts fresh work.",
      true
    ],
    RESPONSE_RECOVERY_INTERRUPTED: ["provider_recovery", "Resume polling the existing provider response.", true],
    PROVIDER_ACKNOWLEDGEMENT_UNKNOWN: [
      "provider_accounting_unknown",
      "The provider acknowledgement was lost; usage and remote outcome are unknown.",
      false
    ],
    PERMISSION_DENIED: ["permission_changed", "Current permissions do not authorize this job.", false],
    AI_CAPABILITY_UNSUPPORTED: [
      "needs_configuration",
      "The task requires a capability unavailable on this deployment.",
      false
    ],
    LLM_NOT_CONFIGURED: ["needs_configuration", "Configure the model provider before retrying.", false],
    SEARCH_NOT_CONFIGURED: ["source_unverified", "Source discovery is not configured.", false],
    SANDBOX_GENERATION_FAILED: [
      "qualification_failed",
      "A generated program failed qualification; inspect its evidence.",
      true
    ]
  };
  const [kind, message, retryable] = reasons[code] || [
    "job_failed",
    "This job stopped; inspect its details before retrying.",
    true
  ];
  return { code: kind, message, retryable };
}
/** Typed workflow decisions outrank deductions from an earlier failure observation. */
export function workflowAttention(reason?: AiBlockingReason): AiAttention | null {
  if (!reason) return null;
  const values: Record<AiBlockingReason["kind"], AiAttention> = {
    needs_configuration: {
      code: "needs_configuration",
      message: "The task requires unavailable runner or scoring capabilities.",
      retryable: false
    },
    plan_schema: {
      code: "plan_repair",
      message: "The quality plan has fields requiring repair or a reviewed new method.",
      retryable: true
    },
    plan_feasibility: {
      code: "plan_feasibility",
      message: "Review the feasibility of the quality plan before generating a new method.",
      retryable: true
    },
    interface_mismatch: {
      code: "interface_mismatch",
      message: "The proposed program does not implement the pinned public interface.",
      retryable: true
    },
    candidate_baseline: {
      code: "baseline_challenge",
      message: "The challenge is already rejected by the baseline corpus; review a new natural defect.",
      retryable: true
    },
    qualification_failed: {
      code: "qualification_failed",
      message: "A generated program failed qualification; inspect its role and evidence.",
      retryable: true
    },
    provenance_policy: {
      code: "provenance_policy",
      message: "Publication requires verified source provenance.",
      retryable: false
    }
  };
  if (
    reason.kind === "qualification_failed" &&
    reason.failureKind === "time_limit" &&
    (reason.role === "alternative" || reason.role?.startsWith("quality-alt"))
  )
    return {
      code: "alternative_timeout",
      message: "The alternative solver exceeded the execution time limit.",
      retryable: true
    };
  return values[reason.kind];
}
export function projectJob(job: AiJobEntity): AiJobProjection {
  const state = job.state || {};
  const result = state.generated;
  const projection: AiJobProjection = {
    version: 1,
    requested: job.input?.count || 0,
    planned: state.caseAllocation?.count ?? null,
    generated: result?.count ?? state.caseProgress?.generated ?? null,
    qualified: result?.count ?? state.caseProgress?.qualified ?? null,
    activated: result?.count ?? null,
    rejectedPlans: state.planRejections || 0,
    provenance:
      state.workflow?.provenance?.status ||
      (state.sourceSearch?.status === "verified" || state.sourceEvidence?.verified === true
        ? "verified"
        : state.sourceEvidence || state.sourceSearch
          ? "unverified"
          : "not_attempted")
  };
  // A's contract/provenance states can supply a small typed reason without exposing its diagnostic payload.
  if (state.attention && typeof state.attention.code === "string" && typeof state.attention.message === "string")
    projection.attention = {
      code: state.attention.code.slice(0, 80),
      message: state.attention.message.slice(0, 300),
      retryable: state.attention.retryable === true
    };
  else {
    const reason = workflowAttention(state.workflow?.blocking);
    if (reason) projection.attention = reason;
    else if (
      job.status !== "failed" &&
      (state.warnings?.includes("source_unverified") || state.warnings?.includes("SOURCE_REVIEW_REQUIRED"))
    )
      projection.attention = {
        code: "source_unverified",
        message: "Source provenance remains unverified; review the source diagnostics.",
        retryable: false
      };
  }
  return projection;
}
function trimTimeline(job: Pick<AiJobEntity, "timeline">) {
  const excess = job.timeline.entries.length - 500;
  if (excess > 0) {
    job.timeline.entries = job.timeline.entries.slice(excess);
    job.timeline.omitted += excess;
  }
}
/** The dispatch ledger and step spans share one persisted timeline and immutable request IDs. */
export function syncWorkflowTimeline(job: Pick<AiJobEntity, "timeline" | "state">): void {
  const stages: WorkflowStage[] = job.state?.workflow?.stages || [];
  if (!stages.length) return;
  job.timeline ||= { entries: [], omitted: 0, legacyHistoryUnavailable: true };
  for (const stage of stages) {
    let entry = job.timeline.entries.find(value => value.id === stage.id);
    if (!entry && stage.timelineRecorded) continue;
    if (!entry) {
      entry = {
        id: stage.id,
        attempt: stage.jobAttempt ?? 0,
        stage: stageKind(stage.stage),
        step: stage.stage,
        startedAt: stage.startedAt,
        scope: "dispatch",
        parentId: stage.parentId,
        deployment: job.timeline.entries.find(value => value.id === stage.parentId)?.deployment
      };
      job.timeline.entries.push(entry);
    }
    stage.timelineRecorded = true;
    Object.assign(entry, {
      workflowAttempt: stage.attempt,
      generationId: stage.generationId,
      status: stage.status,
      model: stage.model,
      policy: stage.policy,
      promptBytes: stage.promptBytes,
      outputBytes: stage.outputBytes,
      durationMs: stage.durationMs,
      requests: stage.requests,
      responsePolls: stage.responsePolls,
      failedRequests: stage.failedRequests,
      reuses: stage.reuses,
      invalidates: stage.invalidates,
      resumptions: stage.resumptions,
      endedAt: stage.finishedAt,
      outcome: stage.status === "running" ? undefined : stage.status
    });
  }
  job.timeline.entries.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  trimTimeline(job);
}

export function advanceStage(
  job: Pick<AiJobEntity, "timeline" | "attempt" | "stageStartedAt" | "stageEndedAt">,
  step: string = "queued",
  outcome?: AiStageAttempt["outcome"]
): void {
  const now = new Date().toISOString();
  job.timeline ||= { entries: [], omitted: 0, legacyHistoryUnavailable: true };
  const last = job.timeline.entries
    .slice()
    .reverse()
    .find(entry => entry.scope !== "dispatch");
  if (last && !last.endedAt && (last.step !== step || last.attempt !== job.attempt || outcome)) {
    last.endedAt = now;
    last.outcome = outcome || (last.attempt !== job.attempt ? "interrupted" : "advanced");
  }
  if (!outcome && (!last || last.endedAt || last.step !== step)) {
    job.timeline.entries.push({
      id: randomUUID(),
      scope: "step",
      attempt: job.attempt || 0,
      stage: stageKind(step),
      step: step.slice(0, 80),
      startedAt: now,
      deployment: {
        backendBuild: deploymentBuildIdentity.backend.sha256,
        qualityPolicyVersion: deploymentBuildIdentity.qualityPolicyVersion,
        receiptVersion: deploymentBuildIdentity.receiptVersion,
        executionProtocolVersion: deploymentBuildIdentity.executionProtocolVersion
      }
    });
    job.stageStartedAt = new Date(now);
    job.stageEndedAt = null;
  }
  if (outcome) job.stageEndedAt = new Date(now);
  trimTimeline(job);
}
/** Queue time belongs to the next claim; old jobs keep an explicit gap in their retained ledger. */
export function queueStage(job: Pick<AiJobEntity, "attempt" | "timeline">) {
  const queued = {
    attempt: (job.attempt || 0) + 1,
    timeline: job.timeline ? { ...job.timeline, entries: job.timeline.entries.map(entry => ({ ...entry })) } : null,
    stageStartedAt: null as Date,
    stageEndedAt: null as Date
  };
  advanceStage(queued, "queued");
  return { timeline: queued.timeline, stageStartedAt: queued.stageStartedAt, stageEndedAt: queued.stageEndedAt };
}

export function jobSummary(
  job: AiJobEntity,
  problem: { id: number; displayId: number | null; title: string | null } | null
) {
  const blocking = attention(job);
  const active = ["queued", "running"].includes(job.status);
  return {
    id: job.id,
    problem: problem || (job.problemId ? { id: job.problemId, displayId: null, title: null } : null),
    action: job.action,
    state: job.status,
    stage: {
      kind: stageKind(job.step),
      step: job.step,
      startedAt: job.stageStartedAt || null,
      elapsedMs: job.stageStartedAt
        ? Math.max(
            0,
            (active ? Date.now() : (job.stageEndedAt || job.updatedAt).getTime()) - job.stageStartedAt.getTime()
          )
        : null
    },
    attention: blocking,
    relevantAction: { kind: active ? "cancel" : blocking?.retryable ? "retry" : "details", jobId: job.id },
    updatedAt: job.updatedAt,
    revision: job.revision || 1
  };
}
