import { randomUUID } from "crypto";
import { cpus } from "os";

import { ForbiddenException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { AI_PROFILE_ROLES, JudgeClientCapabilities, JudgeTaskType, SubmissionStatus } from "@libreoj/judge-protocol";
import { DataSource, EntityManager } from "typeorm";

import {
  BUNDLE_BYTE_LIMIT,
  DiagnosticBundleRequestDto,
  DiagnosticBundleResponseDto,
  DiagnosticDeploymentDto,
  DiagnosticJobDto,
  DiagnosticJudgingDto,
  DiagnosticSubmissionDto,
  DiagnosticTestcaseDto,
  FAILED_JOB_LIMIT,
  MACHINE_LIMIT,
  TESTCASE_LIMIT
} from "./diagnostic-bundle.dto";

import { stageKind } from "../ai/ai-job-view";
import { defaultAiExecutionMode } from "../ai/ai-execution-mode";
import { diagnosticJobIdentity, redactDiagnostic } from "../ai/ai-diagnostic-export";
import { AI_JOB_STATUSES, AiJobEntity } from "../ai/ai.entity";
import { AuditService } from "../audit/audit.service";
import { ConfigService } from "../config/config.service";
import { REQUEST_UUID, unexpectedErrors } from "../event-report/unexpected-errors";
import { deploymentBuildIdentity } from "../health/deployment-identity";
import { HealthService, withTimeout } from "../health/health.service";
import { JudgeClientEntity } from "../judge/judge-client.entity";
import { JudgeClientService } from "../judge/judge-client.service";
import { AiPolicyService } from "../settings/ai-policy.service";
import { RegistrationMode, RegistrationSettingsService } from "../settings/registration-settings.service";
import { UserEntity } from "../user/user.entity";
import { appGitRepoInfo } from "../common/server-revision";

// eslint-disable-next-line @typescript-eslint/no-var-requires, import/extensions
const serverVersion: string = require("../../package.json").version;

const EXCLUDED = [
  "credentials and session secrets",
  "network addresses and endpoints",
  "source code and submission contents",
  "test data filenames and contents",
  "program inputs and outputs",
  "compiler and checker messages",
  "AI prompts, model outputs, reasoning and provider responses",
  "request bodies, query strings and raw logs"
];

const ARCHITECTURES = [
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64"
];
const STATUSES = Object.values(SubmissionStatus);
const KINDS = Object.values(JudgeTaskType);

// Stored error text may contain arbitrary private values. Only these backend error codes may be exported.
const JOB_ERROR_CODES = new Set([
  "AI_ALLOCATION_REVIEW_REQUIRED",
  "AI_ARTIFACT_COMPILE_FAILED",
  "AI_BUDGET_EXCEEDED",
  "AI_BUSY",
  "AI_CAPABILITY_UNSUPPORTED",
  "AI_DIAGNOSTICS_BUSY",
  "AI_HELPER_SETTINGS_UNSUPPORTED",
  "AI_IMPORT_TRADITIONAL_ONLY",
  "AI_IMPORT_TYPE_UNSUPPORTED",
  "AI_INTERFACE_MISMATCH",
  "AI_JOB_ACTIVE",
  "AI_JOB_REQUEST_LIMIT",
  "AI_NOVEL_TARGET_REQUIRED",
  "AI_PAUSED",
  "AI_PLAN_REPAIR_EXHAUSTED",
  "AI_PROBLEM_TYPE_MISMATCH",
  "AI_PROFILE_MISMATCH",
  "AI_PROTOCOL_HELPER_MISSING",
  "AI_PROTOCOL_HELPER_UNSUPPORTED",
  "AI_PROVENANCE_POLICY",
  "AI_REPAIR_REVIEW_REQUIRED",
  "AI_REPLAY_BUSY",
  "AI_REPLAY_UNSUPPORTED",
  "AI_REQUEST_EXCEEDS_BUDGET",
  "AI_SCORING_REVIEW_REQUIRED",
  "AI_SOURCE_BUDGET_EXHAUSTED",
  "AI_TASK_NEEDS_CONFIGURATION",
  "ALLOCATION_REVIEW_CHANGED",
  "AMBIGUOUS_ZIP_PAIR",
  "ATTACHMENT_SIZE_MISMATCH",
  "CREATE_PROBLEM_FAILED",
  "DEEPSEEK_MAX_OUTPUT_TOKENS",
  "DUPLICATE_ZIP_PATH",
  "EMPTY_MODEL_OUTPUT",
  "ENDPOINT_NOT_APPROVED",
  "EVIDENCE_UNAVAILABLE",
  "FILE_ALREADY_EXISTS",
  "FILE_HASH_MISMATCH",
  "GENERATOR_FILENAME_CONFLICT",
  "HIDDEN_SAMPLE_FILE_MISSING",
  "IMPORT_CONTENT_REQUIRED",
  "INCOMPLETE_TESTDATA",
  "INTERNAL_ERROR",
  "INVALID_AI_CONCURRENCY",
  "INVALID_AI_DIFFICULTY",
  "INVALID_AI_FILE_IO",
  "INVALID_AI_PLAN_FIELD_REPAIR",
  "INVALID_AI_PROTOCOL",
  "INVALID_AI_QUALITY_PLAN",
  "INVALID_AI_RESOURCE_LIMITS",
  "INVALID_AI_SAMPLE",
  "INVALID_AI_STATEMENT",
  "INVALID_AI_TAGS",
  "INVALID_AI_TASK_CONTRACT",
  "INVALID_AI_TRANSLATION",
  "INVALID_AI_TUTORIAL",
  "INVALID_ARTIFACT_RANGE",
  "INVALID_ATTACHMENT_TOKEN",
  "INVALID_BASE_URL",
  "INVALID_DEEPSEEK_REASONING",
  "INVALID_GENERATED_CODE",
  "INVALID_GENERATED_JUDGE_INFO",
  "INVALID_HIDDEN_SAMPLES",
  "INVALID_IMAGE",
  "INVALID_IMPORT_TARGET",
  "INVALID_JOB_CURSOR",
  "INVALID_MAX_TOKENS",
  "INVALID_MODEL_JSON",
  "INVALID_PROVIDER_RESPONSE",
  "INVALID_REASONING_BUDGET",
  "INVALID_RESPONSES_RECOVERY",
  "INVALID_RETRY_MODE",
  "INVALID_SANDBOX_FILE",
  "INVALID_SANDBOX_RESPONSE",
  "INVALID_SEARCH_RESPONSE",
  "INVALID_SUBTASK_SCORES",
  "INVALID_TEST_COUNT",
  "INVALID_TEST_PLAN",
  "INVALID_USAGE_PERIOD",
  "INVALID_ZIP",
  "INVALID_ZIP_FILENAME",
  "INVALID_ZIP_LIMIT",
  "JOB_CANCELLED",
  "JOB_LEASE_LOST",
  "JOB_NOT_COMPLETED",
  "JOB_NOT_FAILED",
  "LLM_NOT_CONFIGURED",
  "MCP_ERROR",
  "MCP_SEARCH_FAILED",
  "MCP_SEARCH_TOOL_NOT_FOUND",
  "MODEL_DISCOVERY_UNSUPPORTED",
  "MODEL_NOT_CONFIGURED",
  "MODEL_OUTPUT_INCOMPLETE",
  "MODEL_OUTPUT_TRUNCATED",
  "NO_SUCH_DISCUSSION",
  "NO_SUCH_JOB",
  "NO_SUCH_OBSERVATION",
  "NO_SUCH_PROBLEM",
  "NO_SUCH_REPAIR",
  "PARTIAL_SCORE_CHECKER_NOT_ALLOWED",
  "PERMISSION_DENIED",
  "PRIVATE_ENDPOINT_BLOCKED",
  "PROBLEM_AI_BUSY",
  "PROBLEM_CHANGED_DURING_AI",
  "PROVIDER_ACKNOWLEDGEMENT_UNKNOWN",
  "PROVIDER_CANCEL_UNSUPPORTED",
  "PROVIDER_HTTP_ERROR",
  "PROVIDER_NETWORK_ERROR",
  "PROVIDER_RESPONSE_TOO_LARGE",
  "PROVIDER_RESULT_UNRECOVERABLE",
  "PROVIDER_TIMEOUT",
  "RESPONSES_RECOVERY_UNSUPPORTED",
  "RESPONSE_RECOVERY_EXPIRED",
  "RESPONSE_RECOVERY_INTERRUPTED",
  "SAMPLES_TOO_LARGE",
  "SAMPLE_SIZE_LIMIT",
  "SANDBOX_DISCONNECTED",
  "SANDBOX_GENERATION_FAILED",
  "SANDBOX_TIMEOUT",
  "SANDBOX_UNAVAILABLE",
  "SEARCH_NOT_CONFIGURED",
  "TESTDATA_QUALITY_GATE_FAILED",
  "TESTDATA_TOO_LARGE",
  "TEST_COUNT_COVERAGE_EXCEEDED",
  "TEST_COUNT_RATIO_UNREPRESENTABLE",
  "TOO_MANY_ACTIVE_JOBS",
  "TOO_MANY_FILES",
  "TOTAL_SIZE_TOO_LARGE",
  "TUTORIAL_CORRECTION_UNAVAILABLE",
  "UNREADABLE_STATEMENT",
  "UNSAFE_ZIP_ENTRY",
  "UNSAFE_ZIP_PATH",
  "UNSUPPORTED_ZIP",
  "UNVERIFIED_AI_FILE_IO",
  "UNVERIFIED_AI_SOURCE",
  "UPLOAD_GENERATED_FILE_FAILED",
  "ZIP_DESTINATION_NOT_EMPTY",
  "ZIP_DIRECTORY_LIMIT",
  "ZIP_EXPANSION_LIMIT",
  "ZIP_FILENAME_CONFLICT",
  "ZIP_FILE_COUNT_LIMIT",
  "ZIP_FILE_SIZE_LIMIT",
  "ZIP_INSUFFICIENT_STORAGE",
  "ZIP_INTEGRITY_ERROR",
  "ZIP_SIZE_LIMIT",
  "ZIP_TIMEOUT",
  "ZIP_TOTAL_SIZE_LIMIT"
]);

function numberOrNull(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value))) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

const match = (value: unknown, pattern: RegExp) => (typeof value === "string" && pattern.test(value) ? value : null);
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T | null =>
  values.includes(value as T) ? (value as T) : null;

function iso(value: Date | string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

type JobRow = Pick<
  AiJobEntity,
  | "id"
  | "problemId"
  | "revision"
  | "action"
  | "status"
  | "step"
  | "attempt"
  | "createdAt"
  | "updatedAt"
  | "stageStartedAt"
  | "stageEndedAt"
> & { errorCode: string | null; role: string | null };

function diagnosticJob(row: JobRow): DiagnosticJobDto {
  const role =
    oneOf(row.role, [...AI_PROFILE_ROLES, "make", "quality-small-make", "quality-oracle"]) ??
    match(row.role, /^quality-(?:alt|challenge)-\d{1,5}$/);
  return {
    ...diagnosticJobIdentity(row, row.id.toLowerCase()),
    problemId: numberOrNull(row.problemId),
    stage: stageKind(row.step),
    attempt: row.attempt,
    errorCode: row.errorCode == null ? null : JOB_ERROR_CODES.has(row.errorCode) ? row.errorCode : "UNCLASSIFIED_ERROR",
    failureRole: role,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    stageStartedAt: iso(row.stageStartedAt),
    stageEndedAt: iso(row.stageEndedAt)
  };
}

interface SubmissionRow {
  id: number;
  problemId: number;
  contestId: number | null;
  status: string;
  score: number | null;
  timeUsed: number | null;
  memoryUsed: number | null;
  submitTime: Date;
  judgedAt: string | null;
  judgeMachineId: number | null;
  problemDataVersionId: number | null;
  testcaseCount: number;
}

function diagnosticSubmission(row: SubmissionRow): DiagnosticSubmissionDto {
  return {
    id: row.id,
    problemId: row.problemId,
    contestId: numberOrNull(row.contestId),
    status: oneOf(row.status, STATUSES),
    score: numberOrNull(row.score),
    timeUsed: numberOrNull(row.timeUsed),
    memoryUsed: numberOrNull(row.memoryUsed),
    submitTime: iso(row.submitTime),
    judgedAt: iso(row.judgedAt),
    judgeMachineId: numberOrNull(row.judgeMachineId),
    problemDataVersionId: numberOrNull(row.problemDataVersionId),
    testcaseCount: Number(row.testcaseCount || 0),
    testcases: []
  };
}

interface CaseRow {
  submissionId: number;
  status: string;
  timeLimit: number | null;
  memoryLimit: number | null;
}

function safeString(_key: string, value: unknown) {
  return typeof value === "string" ? redactDiagnostic(value) : value;
}

/** Account for the complete redacted UTF-8 envelope, then add cases in request order until it is full. */
function finishBundle(bundle: DiagnosticBundleResponseDto, rows: CaseRow[]): DiagnosticBundleResponseDto {
  let bytes = Buffer.byteLength(JSON.stringify(bundle, safeString));
  if (bytes > BUNDLE_BYTE_LIMIT) throw new Error("Diagnostic metadata exceeds the bundle byte limit");
  const submissions = new Map(bundle.selected?.submissions.map(row => [row.id, row]));
  for (const row of rows) {
    const submission = submissions.get(row.submissionId);
    if (!submission || submission.testcases.length >= TESTCASE_LIMIT) continue;
    const testcase: DiagnosticTestcaseDto = {
      status: oneOf(row.status, STATUSES),
      timeLimit: numberOrNull(row.timeLimit),
      memoryLimit: numberOrNull(row.memoryLimit)
    };
    const added = Buffer.byteLength(JSON.stringify(testcase, safeString)) + (submission.testcases.length ? 1 : 0);
    if (bytes + added > BUNDLE_BYTE_LIMIT) break;
    submission.testcases.push(testcase);
    bytes += added;
  }
  return JSON.parse(JSON.stringify(bundle, safeString));
}

@Injectable()
export class DiagnosticBundleService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly config: ConfigService,
    private readonly registration: RegistrationSettingsService,
    private readonly policies: AiPolicyService,
    private readonly health: HealthService,
    private readonly clients: JudgeClientService,
    private readonly audit: AuditService
  ) {}

  async export(
    user: UserEntity,
    request: DiagnosticBundleRequestDto,
    requestId: string
  ): Promise<DiagnosticBundleResponseDto> {
    if (!user?.isAdmin) throw new ForbiddenException();
    // This reads and locks the current user row, including when middleware supplied a stale administrator snapshot.
    const { registrationMode } = await this.registration.getForAdministrator(user);
    const now = Date.now();
    const submissionIds = request.submissionIds || [];
    const aiJobIds = request.aiJobIds?.map(id => id.toLowerCase()) || [];
    const [ready, judging, ai, selectedJobs, { submissions, testcases }] = await Promise.all([
      this.health.timedReadiness(),
      this.judging(now),
      this.ai(),
      this.jobs(aiJobIds),
      this.selectedSubmissions(submissionIds)
    ]);
    const jobMap = new Map(selectedJobs.map(job => [job.id, job]));
    const subMap = new Map(submissions.map(sub => [sub.id, sub]));
    const check = (name: "database" | "redis" | "storage") => ({
      status: ready[name].status,
      durationMs: ready[name].durationMs
    });
    const bundle = finishBundle(
      {
        bundle: {
          bundleVersion: 1,
          generatedAt: new Date(now).toISOString(),
          requestId: REQUEST_UUID.test(requestId) ? requestId : randomUUID(),
          administratorId: user.id
        },
        deployment: this.deployment(registrationMode),
        health: { status: ready.status, database: check("database"), redis: check("redis"), storage: check("storage") },
        judging,
        errors: unexpectedErrors.snapshot(now),
        ai,
        ...(submissionIds.length || aiJobIds.length
          ? {
              selected: {
                submissions: submissionIds.filter(id => subMap.has(id)).map(id => subMap.get(id)),
                aiJobs: aiJobIds.filter(id => jobMap.has(id)).map(id => jobMap.get(id)),
                missingSubmissionIds: submissionIds.filter(id => !subMap.has(id)),
                missingAiJobIds: aiJobIds.filter(id => !jobMap.has(id))
              }
            }
          : {}),
        excluded: [...EXCLUDED]
      },
      testcases
    );
    await this.audit.log(user.id, "site.diagnostic_bundle.export", {
      requestId: bundle.bundle.requestId,
      submissionIds,
      aiJobIds
    });
    return bundle;
  }

  private deployment(registrationMode: RegistrationMode): DiagnosticDeploymentDto {
    const { server, services, security, preference, metrics, resourceLimit, queryLimit } = this.config.config;
    return {
      serverVersion,
      revision: match(appGitRepoInfo.abbreviatedSha, /^[0-9a-f]{4,40}$/),
      backendBuild: deploymentBuildIdentity.backend.sha256,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      uptimeSeconds: Math.floor(process.uptime()),
      workerCount: server.clusters == null ? 1 : server.clusters || cpus().length,
      aiExecutionMode: defaultAiExecutionMode(),
      settings: {
        registrationMode,
        requireEmailVerification: !!preference.security.requireEmailVerification,
        mailConfigured: !!services.mail,
        captchaConfigured: !!(security.captcha?.turnstile || security.captcha?.tencentCaptcha),
        crossOriginEnabled: !!security.crossOrigin?.enabled,
        metricsConfigured: !!metrics,
        rateLimitMaxRequests: numberOrNull(security.rateLimit?.maxRequests),
        rateLimitDurationSeconds: numberOrNull(security.rateLimit?.durationSeconds),
        proofOfWorkDifficulty: numberOrNull(security.proofOfWork?.difficulty),
        expensiveActionDifficulty: numberOrNull(security.proofOfWork?.expensiveActionDifficulty),
        problemTestcases: numberOrNull(resourceLimit?.problemTestcases),
        problemTimeLimit: numberOrNull(resourceLimit?.problemTimeLimit),
        problemMemoryLimit: numberOrNull(resourceLimit?.problemMemoryLimit),
        submissionFileSize: numberOrNull(resourceLimit?.submissionFileSize),
        submissionQueryLimit: numberOrNull(queryLimit?.submissions),
        problemSetQueryLimit: numberOrNull(queryLimit?.problemSet)
      }
    };
  }

  private async judging(now: number): Promise<DiagnosticJudgingDto> {
    const [[machines, machineCount], counts] = await Promise.all([
      this.db
        .getRepository(JudgeClientEntity)
        .findAndCount({ select: ["id", "draining"], order: { id: "ASC" }, take: MACHINE_LIMIT }),
      this.db.query<{ kind: JudgeTaskType; queued: string; leased: string; oldest: number | null }[]>(
        `SELECT type AS kind, SUM(state = 'Queued') AS queued, SUM(state = 'Leased') AS leased,
           TIMESTAMPDIFF(SECOND, MIN(IF(state = 'Queued', createdAt, NULL)), NOW(3)) AS oldest
         FROM judge_job WHERE state IN ('Queued', 'Leased') GROUP BY type`
      )
    ]);
    const states = machines.length
      ? await withTimeout(this.clients.diagnosticStates(machines.map(machine => machine.id)), 2000).catch(() => [])
      : [];
    const byId = new Map(states.map(state => [state.id, state] as const));
    const byKind = new Map(counts.map(row => [row.kind, row]));
    const ages = counts.map(row => numberOrNull(row.oldest)).filter(age => age !== null);
    return {
      machineCount,
      machines: machines.map(machine => {
        const state = byId.get(machine.id);
        const caps: JudgeClientCapabilities = state?.capabilities;
        return {
          id: machine.id,
          online: state?.online ?? null,
          draining: machine.draining,
          revoked: state?.revoked ?? null,
          protocolVersion: numberOrNull(caps?.protocolVersion) ?? (state?.online ? 1 : null),
          architecture: oneOf(caps?.runtime?.arch, ARCHITECTURES),
          consumerThreads: numberOrNull(caps?.consumerThreads),
          executionSlots: numberOrNull(caps?.executionSlots),
          aiExecutionSlots: numberOrNull(caps?.aiExecutionSlots),
          memoryBudget: numberOrNull(caps?.memoryBudget),
          nodeVersion: match(caps?.runtime?.node, /^v?\d{1,3}\.\d{1,3}\.\d{1,4}$/),
          judgeProgram: match(caps?.runtime?.judgeProgram, /^[a-f0-9]{64}$/),
          sandboxImage: match(caps?.runtime?.sandboxImage, /^[a-f0-9]{64}$/),
          lastSeenAgeSeconds: state?.seenAt ? Math.max(0, Math.floor((now - state.seenAt) / 1000)) : null
        };
      }),
      queue: KINDS.map(kind => ({
        kind,
        queued: Number(byKind.get(kind)?.queued || 0),
        leased: Number(byKind.get(kind)?.leased || 0)
      })),
      oldestWaitingAgeSeconds: ages.length ? Math.max(0, ...ages) : null
    };
  }

  private async ai(): Promise<DiagnosticBundleResponseDto["ai"]> {
    const [policy, counts, recentFailed] = await Promise.all([
      this.policies.get(),
      this.db.query<{ status: string; count: number }[]>(
        "SELECT status, COUNT(*) AS count FROM ai_job GROUP BY status"
      ),
      this.jobs()
    ]);
    const jobCounts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const row of counts)
      if (AI_JOB_STATUSES.includes(row.status as AiJobEntity["status"])) jobCounts[row.status] = Number(row.count);
    return {
      paused: policy.paused,
      userDailyTokens: policy.userDailyTokens,
      userDailyRequests: policy.userDailyRequests,
      jobRequests: policy.jobRequests,
      concurrentRequests: policy.concurrentRequests,
      jobCounts,
      recentFailed
    };
  }

  private async jobs(ids?: string[]): Promise<DiagnosticJobDto[]> {
    if (ids?.length === 0) return [];
    // Project the same job/stage/error metadata as AI diagnostics without loading the private input, state,
    // observation or error message. The failure role belongs to this attempt, just as in the job detail view.
    const rows = await this.db.query<JobRow[]>(
      `SELECT j.id, j.problemId, j.revision, j.action, j.status, j.step, j.attempt, j.createdAt, j.updatedAt,
         j.stageStartedAt, j.stageEndedAt, LEFT(SUBSTRING_INDEX(j.error, ':', 1), 81) AS errorCode,
         (SELECT JSON_UNQUOTE(JSON_EXTRACT(o.observation, '$.role')) FROM ai_observation o
          WHERE o.jobId = j.id AND o.fatal = 1 AND o.runToken <=> j.runToken ORDER BY o.createdAt DESC, o.id DESC LIMIT 1) AS role
       FROM ai_job j WHERE ${ids ? "j.id IN (?)" : `j.status = 'failed' ORDER BY j.updatedAt DESC, j.id DESC LIMIT ${FAILED_JOB_LIMIT}`}`,
      ids ? [ids] : []
    );
    return rows.filter(row => REQUEST_UUID.test(row.id)).map(diagnosticJob);
  }

  private async selectedSubmissions(
    ids: number[]
  ): Promise<{ submissions: DiagnosticSubmissionDto[]; testcases: CaseRow[] }> {
    if (!ids.length) return { submissions: [], testcases: [] };
    // A rejudge can replace both the result and the pinned data version while the bundle is being collected.
    return await this.db.transaction("REPEATABLE READ", async manager => ({
      submissions: await this.submissions(manager, ids),
      testcases: await this.testcases(manager, ids)
    }));
  }

  private async submissions(manager: EntityManager, ids: number[]): Promise<DiagnosticSubmissionDto[]> {
    const rows = await manager.query<SubmissionRow[]>(
      `SELECT s.id, s.problemId, s.contestId, s.status, s.score, s.timeUsed, s.memoryUsed, s.submitTime, s.problemDataVersionId,
         JSON_UNQUOTE(JSON_EXTRACT(d.result, '$.completion.judgedAt')) AS judgedAt,
         COALESCE(r.judgeClientId, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(d.result, '$.completion.judgeMachineId')), 'null')) AS judgeMachineId,
         JSON_LENGTH(d.result, '$.testcaseResult') AS testcaseCount
       FROM submission s LEFT JOIN submission_detail d ON d.submissionId = s.id
       LEFT JOIN judge_runtime r ON r.id = s.judgeRuntimeId WHERE s.id IN (?)`,
      [ids]
    );
    return rows.map(diagnosticSubmission);
  }

  private async testcases(manager: EntityManager, ids: number[]): Promise<CaseRow[]> {
    return await manager.query<CaseRow[]>(
      `SELECT d.submissionId, c.status, c.timeLimit, c.memoryLimit FROM submission_detail d
       JOIN JSON_TABLE(d.result, '$.testcaseResult.*' COLUMNS (
         positionInResult FOR ORDINALITY, status VARCHAR(32) PATH '$.status',
         timeLimit DOUBLE PATH '$.testcaseInfo.timeLimit', memoryLimit DOUBLE PATH '$.testcaseInfo.memoryLimit'
       )) c ON c.positionInResult <= ?
       WHERE d.submissionId IN (?) ORDER BY FIELD(d.submissionId, ?), c.positionInResult`,
      [TESTCASE_LIMIT, ids, ids]
    );
  }
}
