import type { AiJobEntity } from "./ai.entity";
import { AiError } from "./ai.types";
import type { AiJobUsage, AiUsageService } from "./ai-usage.service";
import type { AiEvidenceService, AiFailureSummary } from "./ai-evidence.service";
import type { AiWorkflowService } from "./ai-workflow.service";
import { AI_REPAIR_LIMITS, type AiRepairState } from "./ai-repair";
import type { AiPurpose, AiRunRecord, AiSpending } from "./ai-session";
import { tutorialCorrectionRefusal, tutorialViews } from "./ai-tutorial-binding";

import type { UserEntity } from "../user/user.entity";

interface JobSerializationContext {
  workflow: Pick<AiWorkflowService, "retryOptions" | "repairRoles">;
  usage?: Pick<AiUsageService, "jobTotals">;
  evidence?: Pick<AiEvidenceService, "summaries">;
}

/** Whether a job's tutorials can have their code replaced by its reference solution: "available", or why not. */
function tutorialCorrection(job: AiJobEntity) {
  if (job.state.tutorialCorrection) return ["queued", "running"].includes(job.status) ? "pending" : undefined;
  if (job.status !== "completed") return undefined;
  const refusal = tutorialCorrectionRefusal(job.state, job.state.plan?.fileIo || null);
  return refusal === "NOTHING_TO_CORRECT" ? undefined : refusal || "available";
}

/** A job's repairs as its owner sees them. */
function repairView(job: AiJobEntity) {
  const repairs = job.state.repair as AiRepairState;
  if (!repairs?.revisions) return undefined;
  return {
    automatic: repairs.automatic,
    limits: { automatic: AI_REPAIR_LIMITS.automatic, total: AI_REPAIR_LIMITS.total },
    // Without the failures' signatures, which only the job compares, and with only the size of each change (its text
    // is read with repairChange)
    revisions: repairs.revisions.map(revision => ({
      ...revision,
      signature: undefined,
      diff: revision.diff
        ? { added: revision.diff.added, removed: revision.diff.removed, truncated: revision.diff.truncated }
        : undefined
    })),
    review: job.status === "failed" ? repairs.review : undefined,
    pending: repairs.pending
  };
}

/** A job's runs and requests as its owner sees them; the totals are the recorded requests (see AiUsageService). */
function evidenceView(job: AiJobEntity, usage?: AiJobUsage) {
  const runs = (job.state.runs as AiRunRecord[]) || [];
  const spending = job.state.spending as Partial<Record<AiPurpose, AiSpending>>;
  if (!runs.length && !spending && !usage) return undefined;
  return { runs, spending: spending || {}, ...(usage ? { usage } : {}) };
}

export function serializeAiJob(
  job: AiJobEntity,
  workflow: JobSerializationContext["workflow"],
  observations?: { count: number; failure?: AiFailureSummary },
  usage?: AiJobUsage
) {
  return {
    id: job.id,
    revision: job.revision || 1,
    problemId: job.problemId,
    action: job.action,
    status: job.status,
    progress: job.progress,
    step: job.step,
    error: job.error,
    retryOptions: workflow.retryOptions(job),
    // The programs the owner may have repaired (retry "repair")
    repairRoles: workflow.repairRoles(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: {
      workflow: job.state.workflow,
      planRepair: job.state.planRepair,
      discussionId: job.state.discussionId,
      discussionIds: job.state.discussionIds,
      requestedCount: job.input.count,
      generatedCount: job.state.generated?.count || job.state.caseAllocation?.count,
      warnings: job.state.warnings || [],
      difficultyRationale: job.state.difficultyRationale,
      sourceEvidence: job.state.sourceEvidence,
      sourceSearch: job.state.sourceSearch,
      testdataQuality: job.state.generated?.qualityValidation || job.state.qualityValidation,
      referenceSource: job.state.referenceSource
        ? {
            kind: job.state.referenceSource.kind,
            discussionId: job.state.referenceSource.discussionId,
            samplesPassed: job.state.referenceSource.samplesPassed || 0,
            validated: job.state.referenceSource.validated === true
          }
        : undefined,
      // Failed runs kept with their evidence (see failures), and the one that ended the latest run
      observationCount: observations?.count || 0,
      failure: observations?.failure,
      // How the published data awards points and runs its helpers (see ai-judging-contract.ts)
      scoring: job.state.generated?.scoring,
      helpers: job.state.generated?.helpers,
      // Where its test data was made, and its cases' digest (review Part III, W03)
      execution: job.state.generated?.execution,
      corpus: job.state.generated?.corpus,
      // Subtasks given more cases than their points' share, so that their targets get one built (W05)
      caseCapacity: job.state.caseAllocation?.capacity?.length ? job.state.caseAllocation.capacity : undefined,
      // The testing plan's rejected fields, while the job's latest proposal is rejected, and how many proposals
      // the job had rejected: a completed request whose answer broke the plan's rules (review Part IV, W01)
      planIssues: job.state.planProposal?.issues,
      planRejections: job.state.planRejections || undefined,
      allocationReview: job.status === "failed" ? job.state.allocationReview : undefined,
      // A scoring change that waits for the owner's approval
      scoringReview: job.status === "failed" ? job.state.scoringReview : undefined,
      // The job's tutorials and what their code passed (review Part III, H08), and whether their code can be
      // replaced by the reference solution now (correctTutorial)
      tutorials: tutorialViews(job.state),
      tutorialCorrection: tutorialCorrection(job),
      // The programs the job replaced, and why it stopped for its owner (review Part III, W04)
      repair: repairView(job),
      revision: job.state.generated?.revision,
      // Its runs, and what its model requests were for and used (review Part III, §8.4)
      evidence: evidenceView(job, usage)
    }
  };
}

/** Shared legacy panels for already loaded, owner-scoped jobs, including a single detail snapshot. */
export async function serializeAiJobs(
  user: UserEntity,
  jobs: AiJobEntity[],
  context: JobSerializationContext,
  totals?: Map<string, AiJobUsage>
) {
  if (!user || jobs.some(job => job.ownerId !== user.id)) throw new AiError("PERMISSION_DENIED");
  const observations = await context.evidence?.summaries(jobs);
  const usage =
    totals ||
    (await context.usage?.jobTotals(
      user.id,
      jobs.map(job => job.id),
      jobs.length ? jobs[jobs.length - 1].createdAt : undefined
    ));
  return jobs.map(job => serializeAiJob(job, context.workflow, observations?.get(job.id), usage?.get(job.id)));
}
