import { randomUUID } from "crypto";

import type { AiRunnerCapabilities, AiTaskContract } from "@libreoj/judge-protocol";

import type { AiUsageRecord } from "./ai-runtime";

import type { AiAction, AiJobEntity } from "./ai.entity";
import type { AiPlanIssue } from "./ai-testdata-quality";

export type AiWorkflowOption = "default" | "qualify_first" | "metadata_only";
export type AiCorpusPolicy = "private" | "summaries" | "model_visible";
export type AiBlockingReason =
  | { kind: "needs_configuration"; required: AiTaskContract; available: AiRunnerCapabilities[]; missing: string[] }
  | { kind: "plan_schema"; issues: AiPlanIssue[]; hash: string; remaining: number; status: string }
  | { kind: "plan_feasibility"; issues: AiPlanIssue[] }
  | {
      kind: "interface_mismatch";
      role: string;
      expected: AiTaskContract["interface"];
      proposed: { main: boolean; missing: string[] };
      diagnostics?: string;
    }
  | {
      kind: "candidate_baseline";
      candidate: string;
      corpus: "public_example" | "author_validation";
      sample?: string;
      reason: string;
    }
  | {
      kind: "qualification_failed";
      role?: string;
      observationId?: string;
      failureKind: string;
      subject?: string;
      profile?: unknown;
      inputSize?: number;
      replay: string;
    }
  | { kind: "provenance_policy"; status: "unverified" | "not_attempted" };
export interface AiStageAttempt {
  id: string;
  stage: string;
  attempt: number;
  jobAttempt?: number;
  parentId?: string;
  /** Internal marker: an omitted timeline entry must not be reinserted on every checkpoint. */
  timelineRecorded?: boolean;
  resumptions?: { attempt: number; startedAt: string; endedAt?: string; status?: AiStageAttempt["status"] }[];
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed" | "interrupted";
  generationId?: string;
  model?: string;
  policy?: string;
  promptBytes?: number;
  outputBytes?: number;
  durationMs?: number;
  requests?: number;
  responsePolls?: number;
  failedRequests?: number;
  reuses: string[];
  invalidates: string[];
}
export interface AiWorkflowState {
  version: 1;
  option: AiWorkflowOption;
  stages: AiStageAttempt[];
  blocking?: AiBlockingReason;
  contract?: {
    status: "verified" | "unverified";
    value?: AiTaskContract;
    snapshot: string;
    available: AiRunnerCapabilities[];
    checkedAt: string;
  };
  provenance: { status: "verified" | "unverified" | "not_attempted"; reason?: string };
  corpus: {
    id: string;
    class: "public_example" | "author_validation" | "sealed_final";
    modelAccess: AiCorpusPolicy;
    inputBytes?: number;
    outputBytes?: number;
  }[];
  candidates: {
    id: string;
    role: "baseline" | "novel" | "unqualified";
    status: "compiled" | "qualified" | "rejected";
    claim: string;
    reason?: string;
    source: string;
    qualification?: string;
  }[];
  compiled: Record<string, { source: string; interface?: string; profiles: string; at: string }>;
  regressions: {
    observationId: string;
    role: string;
    kind: string;
    replay: "pending" | "passed" | "failed" | "unstable" | "untested";
  }[];
  receipts?: { executions: number; comparisons: number; legality: number; fresh: number; reusedTiming: number };
}
export function workflowState(state: Record<string, unknown>, option: AiWorkflowOption = "default"): AiWorkflowState {
  if (!state.workflow)
    state.workflow = {
      version: 1,
      option,
      stages: [],
      provenance: { status: "not_attempted" },
      corpus: [],
      candidates: [],
      compiled: {},
      regressions: []
    } satisfies AiWorkflowState;
  return state.workflow as AiWorkflowState;
}
export function startStage(state: AiWorkflowState, stage: string, reuses: string[] = [], invalidates: string[] = []) {
  const previous = state.stages.filter(s => s.stage === stage);
  for (const s of previous) if (s.status === "running") s.status = "interrupted";
  const attempt: AiStageAttempt = {
    id: randomUUID(),
    stage,
    attempt: previous.length + 1,
    startedAt: new Date().toISOString(),
    status: "running",
    reuses,
    invalidates
  };
  state.stages.push(attempt);
  return attempt;
}
export function startJobStage(job: AiJobEntity, stage: string, reuses: string[] = [], invalidates: string[] = []) {
  const result = startStage(workflowState(job.state, job.input?.workflow), stage, reuses, invalidates);
  result.jobAttempt = job.attempt || 0;
  result.parentId = job.timeline?.entries
    .slice()
    .reverse()
    .find(entry => entry.scope !== "dispatch")?.id;
  return result;
}
/** Persist transport attribution without retaining provider payloads or reasoning. */
export function tallyWorkflowRequest(state: Record<string, unknown>, record: AiUsageRecord) {
  const workflow = state.workflow as AiWorkflowState | undefined;
  const stage = workflow?.stages.find(attempt => attempt.id === record.stageId);
  if (!stage) return;
  stage.requests = (stage.requests || 0) + 1;
  if (record.operation === "responses.poll") stage.responsePolls = (stage.responsePolls || 0) + 1;
  if (!record.success) stage.failedRequests = (stage.failedRequests || 0) + 1;
}

export function workflowActions(action: AiAction, option: AiWorkflowOption): AiAction[] {
  if (option === "metadata_only")
    return [...(action === "import" ? ["import" as const] : []), "source", "translate", "tags", "difficulty"];
  if (action === "all" || action === "import")
    return [
      ...(action === "import" ? ["import" as const] : []),
      ...(option === "qualify_first"
        ? (["testdata", "source", "translate", "tags", "tutorial", "difficulty"] as AiAction[])
        : (["source", "translate", "tags", "difficulty", "tutorial", "testdata"] as AiAction[]))
    ];
  return action === "metadata" ? ["source", "translate", "tags", "difficulty"] : [action];
}
