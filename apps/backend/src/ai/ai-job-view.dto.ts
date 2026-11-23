import { ApiProperty } from "@nestjs/swagger";

import { BuildProvenanceDto, WorkerProvenanceDto } from "../health/build-provenance.dto";

/** Response envelopes also carry the existing expected-error shape. Conditional replies omit payload fields. */
export class AiViewResponseDto {
  error?: string;

  message?: string;

  unchanged?: boolean;
}
export class AiAttentionDto {
  /** Extensible code; clients display message for unknown codes. */
  code: string;

  message: string;

  retryable: boolean;

  /** Detail only: typed workflow decision and its data. */
  kind?: string;

  @ApiProperty({ type: Object, required: false }) data?: Record<string, unknown>;
}
export class AiJobProblemDto {
  id: number;

  @ApiProperty({ nullable: true }) displayId: number;

  @ApiProperty({ nullable: true }) title: string;
}
export class AiJobStageDto {
  @ApiProperty({
    enum: [
      "queued",
      "import",
      "source",
      "metadata",
      "planning",
      "programs",
      "qualification",
      "repair",
      "publication",
      "completed",
      "cancelled",
      "other"
    ]
  })
  kind: string;

  step: string;

  @ApiProperty({ nullable: true, format: "date-time" }) startedAt: string;

  @ApiProperty({ nullable: true }) elapsedMs: number;
}
export class AiRelevantActionDto {
  @ApiProperty({ enum: ["cancel", "retry", "details"] }) kind: string;

  jobId: string;
}
export class AiJobSummaryDto {
  id: string;

  @ApiProperty({ nullable: true, type: AiJobProblemDto }) problem: AiJobProblemDto;

  action: string;

  state: string;

  stage: AiJobStageDto;

  @ApiProperty({ nullable: true, type: AiAttentionDto }) attention: AiAttentionDto;

  relevantAction: AiRelevantActionDto;

  updatedAt: string;

  revision: number;
}
export class AiJobSummaryResponseDto extends AiViewResponseDto {
  version?: string;

  @ApiProperty({ enum: ["active", "attention", "history"], required: false }) section?: string;

  total?: number;

  paused?: boolean;

  @ApiProperty({ nullable: true, required: false }) nextCursor?: string;

  jobs?: AiJobSummaryDto[];
}
export class AiStageAttemptDto {
  id: string;

  attempt: number;

  stage: string;

  step: string;

  startedAt: string;

  endedAt?: string;

  outcome?: string;

  scope?: string;

  parentId?: string;

  workflowAttempt?: number;

  generationId?: string;

  status?: string;

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

  @ApiProperty({ type: [Object], required: false }) resumptions?: Record<string, unknown>[];

  @ApiProperty({ type: Object, required: false }) deployment?: Record<string, unknown>;
}
export class AiTimelineDto {
  entries: AiStageAttemptDto[];

  omitted: number;

  legacyHistoryUnavailable: boolean;
}
export class AiCaseCountersDto {
  requested: number;

  @ApiProperty({ nullable: true }) planned: number;

  @ApiProperty({ nullable: true }) generated: number;

  @ApiProperty({ nullable: true }) qualified: number;

  @ApiProperty({ nullable: true }) activated: number;
}
export class AiJobCountersDto {
  cases: AiCaseCountersDto;

  logicalGenerations: number;

  legacyGenerationRequests: number;

  responsePolls: number;

  failedProviderRequests: number;

  rejectedPlans: number;

  invalidCandidates: number;

  failedQualifications: number;
}
export class AiGenerationCancellationDto {
  @ApiProperty({ nullable: true }) id: string;

  @ApiProperty({ nullable: true }) stageId: string;

  @ApiProperty({ nullable: true }) purpose: string;

  requestAttempts: number;

  lifecycle: string;

  @ApiProperty({ nullable: true }) terminalStatus: string;

  @ApiProperty({ enum: ["not_requested", "requested", "confirmed", "failed", "unsupported", "not_needed"] })
  status: string;

  @ApiProperty({ nullable: true }) error: string;

  createdAt: string;

  identityStatus: string;
}
export class AiProviderCancellationDto {
  localCancelled: boolean;

  truncated: boolean;

  generations: AiGenerationCancellationDto[];
}
export class AiRetryExplanationDto {
  options: string[];

  roles: string[];

  reuses: string[];

  invalidates: string[];

  newProviderGeneration: boolean;
}
export class AiProviderRequestFailureDto {
  target: string;

  provider: string;

  host: string;

  @ApiProperty({ nullable: true }) model: string;

  id: string;

  @ApiProperty({ nullable: true }) purpose: string;

  @ApiProperty({ nullable: true }) stageId: string;

  @ApiProperty({ nullable: true }) generationId: string;

  operation: string;

  @ApiProperty({ nullable: true }) errorCode: string;

  @ApiProperty({ type: Object, nullable: true }) diagnostics: Record<string, unknown>;

  createdAt: string;
}
export class AiJobDetailResponseDto extends AiViewResponseDto {
  @ApiProperty({ nullable: true, required: false }) errorCode?: string;

  requestFailures?: AiProviderRequestFailureDto[];

  warnings?: string[];

  id?: string;

  revision?: number;

  /** The same legacy job/panel serialization as /ai/jobs; only present on changed detail replies. */
  @ApiProperty({ type: Object, required: false }) job?: Record<string, unknown>;

  @ApiProperty({ nullable: true, required: false, type: AiAttentionDto }) blockingReason?: AiAttentionDto;

  summary?: AiJobSummaryDto;

  @ApiProperty({ type: Object, required: false }) technical?: Record<string, unknown>;

  timeline?: AiTimelineDto;

  @ApiProperty({ type: Object, required: false }) runs?: Record<string, unknown>;

  retry?: AiRetryExplanationDto;

  counters?: AiJobCountersDto;

  @ApiProperty({ type: Object, required: false }) usage?: Record<string, unknown>;

  provenance?: string;

  @ApiProperty({ type: Object, nullable: true, required: false }) ioProfile?: Record<string, unknown>;

  providerCancellation?: AiProviderCancellationDto;

  @ApiProperty({ type: [Object], required: false }) planIssues?: Record<string, unknown>[];

  @ApiProperty({ type: Object, nullable: true, required: false }) planRepair?: Record<string, unknown>;

  @ApiProperty({ type: Object, nullable: true, required: false }) allocationReview?: Record<string, unknown>;

  @ApiProperty({ type: Object, nullable: true, required: false }) scoringReview?: Record<string, unknown>;

  @ApiProperty({ type: [Object], required: false }) failures?: Record<string, unknown>[];

  @ApiProperty({ type: Object, required: false }) retention?: Record<string, unknown>;
}
export class AiAllocationApprovalResponseDto extends AiViewResponseDto {
  queued?: boolean;

  id?: string;
}
class AiArtifactIdentityDto {
  @ApiProperty({ type: String, nullable: true }) sha256: string | null;

  @ApiProperty({ enum: ["available", "missing", "truncated"] }) status: string;

  @ApiProperty() basis: string;

  @ApiProperty({ type: BuildProvenanceDto }) provenance: BuildProvenanceDto;
}
class AiBackendIdentityDto extends AiArtifactIdentityDto {
  @ApiProperty({ format: "date-time" }) capturedAt: string;
}
class AiWorkerIdentityDto {
  @ApiProperty() id: number;

  @ApiProperty() online: boolean;

  @ApiProperty({ type: String, nullable: true }) build: string | null;

  @ApiProperty({ type: WorkerProvenanceDto }) provenance: WorkerProvenanceDto;

  @ApiProperty({ type: String, nullable: true }) sandboxImage: string | null;

  @ApiProperty({ type: Number, nullable: true }) protocolVersion: number | null;

  @ApiProperty({ type: [Number] }) qualityPolicies: number[];

  @ApiProperty({ type: [Number] }) receiptVersions: number[];

  @ApiProperty({ type: Object, nullable: true }) taskCapabilities: Record<string, unknown> | null;
}
export class AiDeploymentIdentityResponseDto extends AiViewResponseDto {
  @ApiProperty({ type: AiBackendIdentityDto, required: false }) backend?: AiBackendIdentityDto;

  @ApiProperty({ type: AiArtifactIdentityDto, required: false }) frontend?: AiArtifactIdentityDto;

  qualityPolicyVersion?: number;

  receiptVersion?: number;

  executionProtocolVersion?: number;

  @ApiProperty({ type: Object, required: false }) schema?: Record<string, unknown>;

  @ApiProperty({ type: Object, required: false }) usageIdentityColumns?: Record<string, boolean>;

  @ApiProperty({ type: [AiWorkerIdentityDto], required: false }) workers?: AiWorkerIdentityDto[];

  workersTruncated?: boolean;
}
export class AiDiagnosticExportResponseDto extends AiViewResponseDto {
  exportVersion?: number;

  exportedAt?: string;

  excluded?: string[];

  @ApiProperty({ type: Object, required: false }) deployment?: Record<string, unknown>;

  @ApiProperty({ type: Object, required: false }) job?: Record<string, unknown>;

  @ApiProperty({ type: Object, required: false }) detail?: Record<string, unknown>;

  @ApiProperty({ type: Object, required: false }) requests?: Record<string, unknown>;

  @ApiProperty({ type: Object, required: false }) requestHistory?: Record<string, unknown>;

  @ApiProperty({ type: Object, required: false }) planProposal?: Record<string, unknown>;

  @ApiProperty({ type: Object, required: false }) repairs?: Record<string, unknown>;

  @ApiProperty({ type: Object, required: false }) ioProfile?: Record<string, unknown>;
}
