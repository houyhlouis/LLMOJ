import { Injectable, Inject } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { AiJobEntity } from "./ai.entity";
import { AiConfiguration, AiError, providerPresets } from "./ai.types";
import { generateText, listModels, searchWeb, validateBaseUrl } from "./ai-provider";
import { SaveAiConfigurationDto, StartAiJobDto } from "./ai.dto";
import { normalizeLlmConfiguration } from "./ai-validation";
import { resolveAiImportType } from "./ai-import-type";

import { AiUsageService } from "./ai-usage.service";
import { AiAdmissionService } from "./ai-admission.service";
import { AiConfigurationService } from "./ai-configuration.service";
import { AiJobCoordinator } from "./ai-job-coordinator.service";
import { AiWorkflowService } from "./ai-workflow.service";

import { UserEntity } from "../user/user.entity";
import { UserPrivilegeType } from "../user/user-privilege.service";
import { ProblemAccessService } from "../problem/problem-access.service";
import { FileService } from "../file/file.service";

// Model listing and connection tests call providers directly rather than through the job scheduler.
// Bound how many run at the same time per user, and for the whole site (one backend process).
const MAX_DIAGNOSTIC_CALLS_PER_USER = 2;
const MAX_DIAGNOSTIC_CALLS = 8;
const diagnosticCalls = new Map<number, number>();

async function boundedDiagnosticCall<T>(userId: number, work: () => Promise<T>): Promise<T> {
  const own = diagnosticCalls.get(userId) || 0;
  let total = 0;
  diagnosticCalls.forEach(count => (total += count));
  if (own >= MAX_DIAGNOSTIC_CALLS_PER_USER || total >= MAX_DIAGNOSTIC_CALLS) throw new AiError("AI_DIAGNOSTICS_BUSY");
  diagnosticCalls.set(userId, own + 1);
  try {
    return await work();
  } finally {
    const remaining = (diagnosticCalls.get(userId) || 1) - 1;
    if (remaining > 0) diagnosticCalls.set(userId, remaining);
    else diagnosticCalls.delete(userId);
  }
}

/**
 * What the AI pages ask for: each user's provider configuration and its connection tests, usage, attachments, and
 * the user's jobs, which it queues, cancels and retries. AiJobCoordinator runs the jobs.
 */
@Injectable()
export class AiService {
  @Inject(AiUsageService) private readonly usage: AiUsageService;

  @Inject(AiAdmissionService) private readonly admission: AiAdmissionService;

  constructor(
    @InjectRepository(AiJobEntity) private readonly jobs: Repository<AiJobEntity>,
    private readonly problemAccess: ProblemAccessService,
    private readonly files: FileService,
    private readonly configuration: AiConfigurationService,
    private readonly coordinator: AiJobCoordinator,
    private readonly workflow: AiWorkflowService
  ) {}

  async prepareAttachment(user: UserEntity, value: { filename: string; size: number }) {
    await this.coordinator.requirePrivilege(user, UserPrivilegeType.UseAi);
    await this.coordinator.requirePrivilege(user, UserPrivilegeType.ImportProblem);
    await this.coordinator.requirePrivilege(user, UserPrivilegeType.GenerateTestdata);
    if (!(await this.problemAccess.userHasCreateProblemPermission(user))) throw new AiError("PERMISSION_DENIED");
    const signed = await this.files.prepareUploadRequest(value.size, size =>
      !Number.isSafeInteger(size) || size < 22 || size > 67108864 ? "ATTACHMENT_SIZE_LIMIT" : null
    );
    if (typeof signed === "string") throw new AiError(signed);
    const attachmentToken = this.configuration.signAttachment({
      ownerId: user.id,
      uuid: signed.uuid,
      filename: value.filename,
      size: value.size,
      expires: Date.now() + 24 * 60 * 60 * 1000
    });
    return { signedUploadRequest: signed, attachmentToken };
  }

  async getConfiguration(user: UserEntity) {
    await this.coordinator.requirePrivilege(user, UserPrivilegeType.ManageAiConfiguration);
    const config = await this.configuration.config(user.id);
    return {
      llm: { ...config.llm, apiKey: undefined, hasKey: !!config.llm.apiKey },
      search: { ...config.search, apiKey: undefined, hasKey: !!config.search.apiKey },
      autoOnSave: false,
      maxConcurrentJobs: config.maxConcurrentJobs,
      parallelism: { min: 1, max: 8, globalMax: 8, maxQueuedJobs: 100 },
      presets: providerPresets,
      sitePolicy: await this.userPolicy()
    };
  }

  async saveConfiguration(user: UserEntity, value: SaveAiConfigurationDto) {
    await this.coordinator.requirePrivilege(user, UserPrivilegeType.ManageAiConfiguration);
    validateBaseUrl(value.llm.baseUrl);
    validateBaseUrl(value.search.baseUrl);
    const llm = normalizeLlmConfiguration(value.llm);
    const previous = await this.configuration.config(user.id);
    const maxConcurrentJobs = value.maxConcurrentJobs ?? previous.maxConcurrentJobs ?? 3;
    if (!Number.isInteger(maxConcurrentJobs) || maxConcurrentJobs < 1 || maxConcurrentJobs > 8)
      throw new AiError("INVALID_AI_CONCURRENCY");
    const config: AiConfiguration = {
      maxConcurrentJobs,
      llm: {
        ...llm,
        apiKey: value.clearLlmKey
          ? ""
          : value.llm.apiKey || (value.llm.baseUrl === previous.llm.baseUrl ? previous.llm.apiKey : "")
      },
      search: {
        ...value.search,
        apiKey: value.clearSearchKey
          ? ""
          : value.search.apiKey || (value.search.baseUrl === previous.search.baseUrl ? previous.search.apiKey : "")
      },
      autoOnSave: false
    };
    await this.configuration.save(user.id, config);
    await this.coordinator.recordAiAudit(user, "configuration.save", undefined, {
      llmType: config.llm.type,
      searchType: config.search.type,
      maxConcurrentJobs
    });
    return {
      ...(await this.getConfiguration(user)),
      ...(value.llm.maxTokens != null && value.llm.maxTokens !== llm.maxTokens
        ? { adjustments: { maxTokens: { requested: value.llm.maxTokens, applied: llm.maxTokens } } }
        : {})
    };
  }

  async models(user: UserEntity) {
    await this.coordinator.requirePrivilege(user, UserPrivilegeType.ManageAiConfiguration);
    try {
      const models = await boundedDiagnosticCall(
        user.id,
        async () =>
          await this.coordinator.withRuntime(
            user.id,
            undefined,
            async () => await listModels((await this.configuration.config(user.id)).llm)
          )
      );
      await this.coordinator.recordAiAudit(user, "models.list", undefined, { success: true, count: models.length });
      return { models };
    } catch (error) {
      await this.coordinator.recordAiAudit(user, "models.list", undefined, {
        success: false,
        errorCode: error instanceof AiError ? error.code : "INTERNAL_ERROR"
      });
      throw error;
    }
  }

  async test(user: UserEntity, target: "llm" | "search") {
    await this.coordinator.requirePrivilege(user, UserPrivilegeType.ManageAiConfiguration);
    const start = Date.now();
    try {
      const config = await this.configuration.config(user.id);
      await boundedDiagnosticCall(
        user.id,
        async () =>
          await this.coordinator.withRuntime(user.id, undefined, async () => {
            if (target === "llm") await generateText(config.llm, "You are a connectivity test.", "Reply OK.");
            else await searchWeb(config.search, "Codeforces official programming contest");
          })
      );
      const elapsedMs = Date.now() - start;
      await this.coordinator.recordAiAudit(user, "connection.test", undefined, { success: true, target, elapsedMs });
      return { success: true, elapsedMs };
    } catch (error) {
      await this.coordinator.recordAiAudit(user, "connection.test", undefined, {
        success: false,
        target,
        elapsedMs: Date.now() - start,
        errorCode: error instanceof AiError ? error.code : "INTERNAL_ERROR"
      });
      throw error;
    }
  }

  async usageReport(user: UserEntity, days?: number) {
    if (!user) throw new AiError("PERMISSION_DENIED");
    const report = await this.usage.report(user.id, days);
    const policy = await this.userPolicy();
    const used = this.admission ? await this.admission.usage(user.id) : { tokens: 0, requests: 0, heldTokens: 0 };
    return {
      ...report,
      budget: {
        ...policy,
        windowHours: 24,
        usedTokens: used.tokens,
        usedRequests: used.requests,
        heldTokens: used.heldTokens
      }
    };
  }

  /** The limits that apply to every account; the number of simultaneous requests is the site's own concern. */
  private async userPolicy() {
    const { paused, userDailyTokens, userDailyRequests, jobRequests } = await this.coordinator.policy();
    return { paused, userDailyTokens, userDailyRequests, jobRequests };
  }

  private serialize(job: AiJobEntity) {
    return {
      id: job.id,
      problemId: job.problemId,
      action: job.action,
      status: job.status,
      progress: job.progress,
      step: job.step,
      error: job.error,
      retryOptions: this.workflow.canRetrySamples(job) ? ["validate-samples", "std"] : [],
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      result: {
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
          : undefined
      }
    };
  }

  async listJobs(user: UserEntity, problemId?: number) {
    if (!user) throw new AiError("PERMISSION_DENIED");
    const jobs = await this.jobs.find({
      where: { ownerId: user.id, ...(problemId ? { problemId } : {}) },
      order: { createdAt: "DESC" },
      take: 50
    });
    return { jobs: jobs.map(job => this.serialize(job)), paused: (await this.coordinator.policy()).paused };
  }

  async start(user: UserEntity, input: StartAiJobDto) {
    // Old browser tabs must not re-enable the removed automatic-on-save workflow.
    if (input.automatic) return { skipped: true };
    await this.coordinator.requirePrivilege(user, UserPrivilegeType.UseAi);
    if (["testdata", "all", "import"].includes(input.action))
      await this.coordinator.requirePrivilege(user, UserPrivilegeType.GenerateTestdata);
    if (input.action === "import") {
      if (input.problemId != null) throw new AiError("INVALID_IMPORT_TARGET");
      if (input.attachmentToken) await this.configuration.validateAttachmentToken(user, input.attachmentToken);
      await this.coordinator.requirePrivilege(user, UserPrivilegeType.ImportProblem);
      if (!(await this.problemAccess.userHasCreateProblemPermission(user))) throw new AiError("PERMISSION_DENIED");
      if (!input.markdown?.trim() && !input.image) throw new AiError("IMPORT_CONTENT_REQUIRED");
      resolveAiImportType(input.markdown || "", undefined, input.problemType);
      if (input.communicationMode && input.problemType && input.problemType !== "Communication")
        throw new AiError("INVALID_AI_PROTOCOL");
      if (input.image && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(input.image))
        throw new AiError("INVALID_IMAGE");
    } else {
      if (input.problemType || input.communicationMode) throw new AiError("INVALID_AI_PROTOCOL");
      if (!input.problemId) throw new AiError("NO_SUCH_PROBLEM");
      await this.coordinator.editable(user, input.problemId);
    }
    const config = await this.configuration.config(user.id);
    if (input.automatic && (!config.autoOnSave || !config.llm.apiKey || !config.llm.model)) return { skipped: true };
    if (!config.llm.apiKey || !config.llm.model) throw new AiError("LLM_NOT_CONFIGURED");
    const job = await this.coordinator.enqueue(user, input);
    await this.coordinator.recordAiAudit(user, "job.queue", job);
    this.coordinator.wake();
    return { job: this.serialize(job) };
  }

  async cancel(user: UserEntity, id: string) {
    if (!user) throw new AiError("PERMISSION_DENIED");
    await this.coordinator.cancel(user, id);
    return {};
  }

  async retry(user: UserEntity, id: string, retryFrom?: "validate-samples" | "std") {
    await this.coordinator.requirePrivilege(user, UserPrivilegeType.UseAi);
    const job = await this.jobs.findOneBy({ id, ownerId: user.id });
    if (!job) throw new AiError("NO_SUCH_JOB");
    if (job.status !== "failed") throw new AiError("JOB_NOT_FAILED");
    if (job.problemId) await this.coordinator.editable(user, job.problemId);
    if (["testdata", "all", "import"].includes(job.action))
      await this.coordinator.requirePrivilege(user, UserPrivilegeType.GenerateTestdata);
    await this.coordinator.requeue(user, job, () => this.workflow.retryState(job, retryFrom));
    await this.coordinator.recordAiAudit(user, "job.retry", job, { retryFrom: retryFrom || "default" });
    this.coordinator.wake();
    return {};
  }
}
