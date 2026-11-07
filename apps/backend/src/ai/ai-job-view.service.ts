import { createHash } from "crypto";

import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, In } from "typeorm";

import { boundedDiagnosticExport, diagnosticPlanCandidate } from "./ai-diagnostic-export";
import { AiUsageEntity } from "./ai-usage.entity";

import { AiJobEntity } from "./ai.entity";
import { serializeAiJobs } from "./ai-job-serialization";
import { AiEvidenceService } from "./ai-evidence.service";
import { AiError } from "./ai.types";
import { AiJobCoordinator } from "./ai-job-coordinator.service";
import { AiWorkflowService } from "./ai-workflow.service";
import { AiUsageService } from "./ai-usage.service";
import { AiObservationEntity } from "./ai-observation.entity";
import { attention, jobSummary, projectJob, syncWorkflowTimeline, workflowAttention } from "./ai-job-view";
import type { AiSearchDiagnostic } from "./ai-search-diagnostics";
import { AiJobSummaryQueryDto, AiJobDetailDto } from "./ai.dto";

import { JudgeClientService } from "../judge/judge-client.service";
import { SettingsEntity } from "../settings/settings.entity";
import { deploymentBuildIdentity } from "../health/deployment-identity";

import { UserEntity } from "../user/user.entity";
import { ProblemAccessService, ProblemPermissionType } from "../problem/problem-access.service";
import { ProblemEntity } from "../problem/problem.entity";
import { ProblemService } from "../problem/problem.service";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

@Injectable()
export class AiJobViewService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly coordinator: AiJobCoordinator,
    private readonly workflow: AiWorkflowService,
    private readonly usage: AiUsageService,
    private readonly problems: ProblemService,
    private readonly judges: JudgeClientService,
    private readonly access: ProblemAccessService,
    private readonly evidence: AiEvidenceService
  ) {}

  private async problemRows(jobs: AiJobEntity[], user: UserEntity) {
    const ids = [...new Set(jobs.map(job => job.problemId).filter(Boolean))];
    if (!ids.length) return new Map<number, { id: number; displayId: number; title: string }>();
    const problems = await this.db.getRepository(ProblemEntity).find({ where: { id: In(ids) } });
    const permissions = await Promise.all(
      problems.map(problem => this.access.userHasPermission(user, problem, ProblemPermissionType.View))
    );
    const readable = problems.filter((_, index) => permissions[index]);
    const titles = readable.length
      ? await this.problems.getProblemLocalizedTitles(
          readable,
          readable.map(p => p.locales[0])
        )
      : [];
    const visible = new Map(readable.map((problem, index) => [problem.id, titles[index]?.slice(0, 240) || null]));
    return new Map(
      problems.map(problem => [
        problem.id,
        {
          id: problem.id,
          displayId: visible.has(problem.id) ? problem.displayId : null,
          title: visible.get(problem.id) || null
        }
      ])
    );
  }

  /** Active/attention queues and history have independent cursors. Source-bearing state is never selected. */
  async summaries(user: UserEntity, query: AiJobSummaryQueryDto) {
    if (!user) throw new AiError("PERMISSION_DENIED");
    const section = query.section || "active";
    const statuses =
      section === "active" ? ["queued", "running"] : section === "attention" ? ["failed"] : ["completed", "cancelled"];
    const base = this.db
      .getRepository(AiJobEntity)
      .createQueryBuilder("job")
      .where("job.ownerId = :ownerId", { ownerId: user.id });
    if (section === "attention")
      base.andWhere(
        "(job.status NOT IN (:...excluded) OR JSON_EXTRACT(job.projection, '$.attention.code') IS NOT NULL)",
        { excluded: ["queued", "running", "completed", "cancelled"] }
      );
    else {
      base.andWhere("job.status IN (:...statuses)", { statuses });
      if (section === "history") base.andWhere("JSON_EXTRACT(job.projection, '$.attention.code') IS NULL");
    }
    if (query.problemId) base.andWhere("job.problemId = :problemId", { problemId: query.problemId });
    const marker = await base
      .clone()
      .select("COUNT(*)", "count")
      .addSelect("COALESCE(SUM(job.revision), 0)", "revisions")
      .addSelect("MAX(job.updatedAt)", "updatedAt")
      .getRawOne();
    if (query.cursor) {
      let cursor: { at: string; id: string };
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
      } catch {
        throw new AiError("INVALID_JOB_CURSOR");
      }
      if (
        !cursor ||
        typeof cursor.at !== "string" ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(cursor.at) ||
        !Number.isFinite(Date.parse(`${cursor.at.replace(" ", "T")}Z`)) ||
        typeof cursor.id !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(cursor.id)
      )
        throw new AiError("INVALID_JOB_CURSOR");
      base.andWhere("(job.createdAt < :at OR (job.createdAt = :at AND job.id < :id))", {
        at: cursor.at,
        id: cursor.id
      });
    }
    const limit = query.limit || 50;
    const { entities: jobs, raw } = await base
      .select([
        "job.id",
        "job.problemId",
        "job.action",
        "job.status",
        "job.step",
        "job.error",
        "job.stageStartedAt",
        "job.stageEndedAt",
        "job.updatedAt",
        "job.createdAt",
        "job.revision",
        "job.projection"
      ])
      .addSelect("DATE_FORMAT(job.createdAt, '%Y-%m-%d %H:%i:%s.%f')", "cursorCreatedAt")
      .orderBy("job.createdAt", "DESC")
      .addOrderBy("job.id", "DESC")
      .take(limit + 1)
      .getRawAndEntities();
    const hasMore = jobs.length > limit;
    const page = jobs.slice(0, limit);
    const problems = await this.problemRows(page, user);
    const { paused } = await this.coordinator.policy();
    const version = digest({
      section,
      problemId: query.problemId || null,
      cursor: query.cursor || null,
      limit: query.limit || 50,
      paused,
      marker,
      problems: [...problems]
    });
    if (query.ifVersion === version) return { unchanged: true, version, section };
    const last = page[page.length - 1];
    return {
      unchanged: false,
      version,
      section,
      total: Number(marker.count),
      jobs: page.map(job => jobSummary(job, problems.get(job.problemId) || null)),
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ at: raw[page.length - 1].cursorCreatedAt, id: last.id })).toString("base64url")
          : null,
      paused
    };
  }

  async authorizedJob(user: UserEntity, id: string) {
    if (!user) throw new AiError("PERMISSION_DENIED");
    const job = await this.db.getRepository(AiJobEntity).findOneBy({ id, ownerId: user.id });
    if (!job) throw new AiError("NO_SUCH_JOB");
    await this.coordinator.assertEvidenceAccess(user, job);
    return job;
  }

  private async administrator(user: UserEntity) {
    if (!user || !(await this.db.getRepository(UserEntity).findOneBy({ id: user.id }))?.isAdmin)
      throw new AiError("PERMISSION_DENIED");
  }

  async deployment(user: UserEntity) {
    await this.administrator(user);
    const clients = (await this.judges.listJudgeClients()).slice(0, 100);
    const workers = await Promise.all(
      clients.map(async client => {
        const capabilities = await this.judges.getJudgeClientCapabilities(client);
        return {
          id: client.id,
          online: await this.judges.isJudgeClientOnline(client),
          build: capabilities?.runtime?.judgeProgram || null,
          sandboxImage: capabilities?.runtime?.sandboxImage || null,
          protocolVersion: capabilities?.protocolVersion || null,
          qualityPolicies: capabilities?.aiQualityPolicyVersions || [],
          receiptVersions: capabilities?.aiReceiptVersions || [],
          taskCapabilities: capabilities?.aiCapabilities || null
        };
      })
    );
    const schema = await this.db.getRepository(SettingsEntity).findOneBy({ key: "deployment.schema" });
    const columns: Array<{ name: string }> = await this.db.query(
      "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ai_usage' AND COLUMN_NAME IN ('purpose','generationId')"
    );
    return {
      ...deploymentBuildIdentity,
      schema: schema?.value || { version: null, status: "unrecorded" },
      usageIdentityColumns: {
        purpose: columns.some(c => c.name === "purpose"),
        generationId: columns.some(c => c.name === "generationId")
      },
      workers,
      workersTruncated: clients.length >= 100
    };
  }

  async exportDiagnostic(user: UserEntity, id: string, includeRejectedProposal = false) {
    await this.administrator(user);
    const job = await this.authorizedJob(user, id);
    const detail = await this.detail(user, { id });
    const requests = await this.db
      .getRepository(AiUsageEntity)
      .find({ where: { ownerId: user.id, jobId: id }, order: { createdAt: "DESC" }, take: 1001 });
    const state = job.state || {};
    return boundedDiagnosticExport({
      deployment: await this.deployment(user),
      job: { id, revision: job.revision, action: job.action, status: job.status },
      detail,
      requests: requests.slice(0, 1000).map(r => ({
        id: r.id,
        generationId: r.generationId,
        stageId: r.stageId || null,
        purpose: r.purpose,
        requestAttempt: r.requestAttempt,
        operation: r.operation,
        target: r.target,
        provider: r.provider,
        host: r.host,
        model: r.model || null,
        success: r.success,
        errorCode: r.errorCode,
        diagnostics: r.diagnostics,
        elapsedMs: r.elapsedMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        usageReported: r.usageReported,
        createdAt: r.createdAt
      })),
      requestHistory: { truncated: requests.length > 1000, limit: 1000, retentionMayHaveRemovedRows: true },
      planProposal: {
        hash: state.planProposal?.hash || null,
        issues: state.planProposal?.issues || [],
        candidate: includeRejectedProposal
          ? state.planProposal?.candidate === undefined
            ? { missing: true }
            : diagnosticPlanCandidate(state.planProposal.candidate)
          : { unexported: "explicit_opt_in_required" }
      },
      repairs: (state.repair?.revisions || []).map(r => ({
        round: r.round,
        role: r.role,
        from: r.from,
        to: r.to,
        parentRevision: r.round - 1,
        accepted: !r.rejected,
        qualification: r.test || null,
        result: r.result || null
      })),
      ioProfile: state.ioProfile
    });
  }

  async approveAllocation(user: UserEntity, id: string, reviewDigest: string) {
    const job = await this.authorizedJob(user, id);
    if (job.error !== "AI_ALLOCATION_REVIEW_REQUIRED" || job.state.allocationReview?.digest !== reviewDigest)
      throw new AiError("ALLOCATION_REVIEW_CHANGED");
    await this.coordinator.requeue(user, job, () => ({ ...job.state, allocationApproval: reviewDigest }));
    await this.coordinator.recordAiAudit(user, "allocation.approve", job, { digest: reviewDigest });
    this.coordinator.wake();
    return { queued: true, id };
  }

  async detail(user: UserEntity, query: AiJobDetailDto) {
    const job = await this.authorizedJob(user, query.id);
    // Authorization is checked even for an unchanged response.
    if (query.ifRevision === job.revision) return { unchanged: true, id: job.id, revision: job.revision };
    const [totals, generations, observations, problems, generationCounts, requestFailures, stageTotals] =
      await Promise.all([
        this.usage.jobTotals(user.id, [job.id]),
        this.usage.generations(user.id, job.id),
        this.db
          .getRepository(AiObservationEntity)
          .find({ where: { jobId: job.id }, order: { createdAt: "DESC" }, take: 65 }),
        this.problemRows([job], user),
        this.usage.generationCounts(user.id, job.id),
        this.usage.recentFailures(user.id, job.id),
        this.usage.stageTotals(user.id, job.id)
      ]);
    const [legacyJob] = await serializeAiJobs(
      user,
      [job],
      { workflow: this.workflow, usage: this.usage, evidence: this.evidence },
      totals
    );
    await this.coordinator.assertEvidenceAccess(user, job);
    const state = job.state || {};
    const projection = { ...projectJob(job), ...job.projection };
    // Small progress projections may predate the last full workflow checkpoint.
    const workflowProjection = projectJob(job);
    if (workflowProjection.attention) projection.attention = workflowProjection.attention;
    if (state.workflow?.provenance) projection.provenance = workflowProjection.provenance;
    syncWorkflowTimeline(job);
    for (const entry of job.timeline?.entries || []) {
      const retained = stageTotals.get(entry.id);
      // Checkpoints can precede the last durable request, while retention can remove older rows.
      if (retained)
        for (const key of ["requests", "responsePolls", "failedRequests"] as const)
          entry[key] = Math.max(entry[key] || 0, retained[key]);
    }
    const usage = totals.get(job.id);
    const latest = observations.find(o => o.fatal && o.runToken === job.runToken);
    let blockingReason: ReturnType<typeof attention> & { kind?: string; data?: unknown } = attention({
      ...job,
      projection
    });
    if (state.workflow?.blocking)
      blockingReason = {
        ...workflowAttention(state.workflow.blocking),
        kind: state.workflow.blocking.kind,
        data: state.workflow.blocking
      };
    if (
      !projection.attention &&
      job.status === "failed" &&
      latest?.kind === "time_limit" &&
      latest.observation.role?.startsWith("quality-alt")
    )
      blockingReason = {
        code: "alternative_timeout",
        message: "The alternative solver exceeded the execution time limit.",
        retryable: true
      };
    if (!projection.attention && job.status === "failed" && latest?.kind === "invalid_challenge")
      blockingReason = {
        code: "baseline_challenge",
        message: "The challenge candidate failed the validation corpus.",
        retryable: true
      };
    const rows = observations.slice(0, 64);
    const searches: Array<{ attempts?: number; diagnostic?: AiSearchDiagnostic }> = [
      ...(state.sourceSearchTrace?.searches || []),
      ...Object.values(state.optionalSearchFailures || {})
    ];
    const diagnostics = searches.filter(search => search.diagnostic);
    return {
      unchanged: false,
      id: job.id,
      revision: job.revision || 1,
      job: legacyJob,
      blockingReason,
      errorCode: job.error?.match(/^([A-Z][A-Z0-9_]{0,79})(?::|$)/)?.[1] ?? (job.error ? "UNCLASSIFIED_ERROR" : null),
      requestFailures,
      warnings: state.warnings || [],
      summary: jobSummary({ ...job, projection }, problems.get(job.problemId) || null),
      technical: {
        ...(state.technical || {}),
        execution: state.generated?.execution || null,
        allocationMode: state.caseAllocation?.mode || null,
        allocationReviewDigest: state.generated?.scoring?.allocationReviewDigest || null,
        taskContract: state.workflow?.contract?.value || state.taskContract || null,
        contractAdmission: state.workflow?.contract || null,
        workflowOption: state.workflow?.option || job.input?.workflow || null,
        corpusMembership: state.workflow?.corpus || null,
        candidates: state.workflow?.candidates || null,
        compiled: state.workflow?.compiled || null,
        regressions: state.workflow?.regressions || null,
        receipts: state.workflow?.receipts || state.generated?.execution?.receipts || null,
        planRepair: state.planRepair || null,
        provenance: state.workflow?.provenance || { status: projection.provenance },
        searchDiagnostics: diagnostics.slice(-100).map(({ attempts, diagnostic: d }) => ({
          attempts: attempts || 0,
          provider: d.provider,
          category: d.category,
          httpStatus: d.httpStatus,
          code: d.code,
          message: d.message,
          requestId: d.requestId,
          requestShape: d.requestShape,
          queryHash: d.queryHash,
          retryable: d.retryable
        })),
        searchDiagnosticsOmitted: Math.max(0, diagnostics.length - 100),
        protocol: state.protocolPlan || null,
        publicAbi:
          state.workflow?.contract?.value?.interface ||
          state.technical?.publicAbi ||
          state.plan?.publicInterface ||
          null,
        executionMode:
          state.technical?.executionMode || state.generated?.execution?.origin || state.executionMode || null,
        sourceRevision: state.technical?.sourceRevision || state.generated?.revision || state.sourceRevision || null,
        profiles: state.technical?.profiles || state.executionProfiles || latest?.observation.profile || null,
        corpus: state.technical?.corpus || state.corpusMembership || state.generated?.corpus || null,
        limits: state.plan
          ? { timeLimitMs: state.plan.timeLimitMs ?? null, memoryLimitMiB: state.plan.memoryLimitMiB ?? null }
          : null
      },
      timeline: {
        entries: job.timeline?.entries || [],
        omitted: job.timeline?.omitted || 0,
        legacyHistoryUnavailable: job.timeline?.legacyHistoryUnavailable ?? !job.timeline
      },
      runs: {
        entries: (state.runs || []).slice(-20).map(run => ({
          at: run.at,
          operation: run.operation,
          seconds: run.seconds,
          result: run.result,
          origin: run.origin,
          reuse: run.reuse,
          repair: run.repair
        })),
        limit: 20,
        complete: false
      },
      retry: {
        options: this.workflow.retryOptions(job),
        roles: this.workflow.repairRoles(job),
        reuses: [
          "accepted statement and completed metadata",
          "unchanged source/build/input caches under exact hashes",
          ...(job.error?.startsWith("RESPONSE_RECOVERY_INTERRUPTED")
            ? ["existing provider generation and response handle"]
            : [])
        ],
        invalidates: [
          "qualification affected by a changed source, checker, validator, profile or policy",
          "publication authorization and problem snapshot are rechecked"
        ],
        newProviderGeneration: !job.error?.startsWith("RESPONSE_RECOVERY_INTERRUPTED")
      },
      counters: {
        cases: {
          requested: projection.requested,
          planned: projection.planned,
          generated: projection.generated,
          qualified: projection.qualified,
          activated: projection.activated
        },
        logicalGenerations: generationCounts.logicalGenerations,
        legacyGenerationRequests: generationCounts.legacyGenerationRequests,
        responsePolls: usage?.polls ?? 0,
        failedProviderRequests: usage?.failed ?? 0,
        rejectedPlans: projection.rejectedPlans,
        invalidCandidates: rows.filter(o => o.kind === "invalid_challenge").length,
        failedQualifications: rows.filter(
          o => !["invalid_challenge", "infrastructure_error", "canceled", "unclassified"].includes(o.kind)
        ).length
      },
      usage: {
        reported: usage
          ? {
              ...usage,
              inputTokens:
                usage.inputTokensReported || (usage.inputTokensReported === undefined && usage.inputTokens > 0)
                  ? usage.inputTokens
                  : null,
              outputTokens:
                usage.outputTokensReported || (usage.outputTokensReported === undefined && usage.outputTokens > 0)
                  ? usage.outputTokens
                  : null
            }
          : null,
        complete: false,
        legacyUnlinkedRequests: usage?.legacyUnlinkedRequests || 0,
        limitations: [
          "Provider usage can be absent or incomplete; unknown usage is not zero.",
          "Usage and failure counts cover retained records, not guaranteed lifetime billing.",
          "Reasoning and cached tokens are breakdowns, not additional totals."
        ]
      },
      provenance: projection.provenance,
      ioProfile: state.ioProfile || null,
      providerCancellation: {
        localCancelled: job.status === "cancelled",
        generations: generations.slice(0, 1000).map(g => ({
          id: g.generationId || null,
          stageId: g.stageId || null,
          purpose: g.purpose || null,
          requestAttempts: g.requestAttempts,
          lifecycle: g.lifecycle,
          terminalStatus: g.terminalStatus || null,
          status: g.cancellation,
          error: g.cancellationError || null,
          createdAt: g.createdAt,
          identityStatus: g.generationId ? "linked" : "legacy_unlinked"
        })),
        truncated: generations.length > 1000
      },
      planIssues: state.planProposal?.issues || [],
      planRepair: state.planRepair || null,
      allocationReview: state.allocationReview || null,
      scoringReview: state.scoringReview || null,
      failures: rows.map(row => ({
        id: row.id,
        attemptId: row.observation.attemptId,
        kind: row.kind,
        role: row.observation.role,
        phase: row.observation.phase,
        subject: row.observation.subject,
        execution: row.observation.execution,
        evidence: row.evidence,
        artifacts: row.observation.artifacts.map(a => ({
          role: a.role,
          size: a.size,
          sha256: a.sha256,
          stored: a.stored
        }))
      })),
      retention: {
        observationsTruncated: observations.length > 64,
        runsRetained: state.runs?.length || 0,
        artifacts: "lazy; current permissions checked on every read"
      }
    };
  }
}
