import { ApiProperty, ApiSchema } from "@nestjs/swagger";

import { ArrayMaxSize, ArrayUnique, IsArray, IsInt, IsUUID, Max, Min, ValidateIf } from "class-validator";

import { JudgeTaskType, SubmissionStatus } from "@libreoj/judge-protocol";

import { BuildProvenanceDto, WorkerProvenanceDto } from "../health/build-provenance.dto";
import { REGISTRATION_MODES, RegistrationMode } from "../settings/registration-settings.service";
import { AI_JOB_STATUSES } from "../ai/ai.entity";

export const SELECTION_LIMIT = 50;
export const MACHINE_LIMIT = 100;
export const TESTCASE_LIMIT = 200;
export const FAILED_JOB_LIMIT = 20;
export const BUNDLE_BYTE_LIMIT = 256 * 1024;

export class DiagnosticBundleRequestDto {
  @ApiProperty({
    type: "array",
    items: { type: "integer", minimum: 1, maximum: 2147483647 },
    required: false,
    maxItems: SELECTION_LIMIT,
    uniqueItems: true
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(SELECTION_LIMIT)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  submissionIds?: number[];

  @ApiProperty({
    type: "array",
    items: {
      type: "string",
      format: "uuid",
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
    },
    required: false,
    maxItems: SELECTION_LIMIT,
    uniqueItems: true
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(SELECTION_LIMIT)
  @ArrayUnique(id => (typeof id === "string" ? id.toLowerCase() : id))
  @IsUUID("4", { each: true })
  aiJobIds?: string[];
}

// Closed schemas are also the allowlist checked by the export regression suite.
const model = { description: "Allowlisted site diagnostic metadata.", additionalProperties: false };
const nullableNumber = { type: Number, nullable: true };
const nullableText = { type: String, nullable: true };
// The generated client treats null inside a string enum as the literal "null". A pattern constrains
// the non-null wire values and keeps the generated type nullable.
const jobStatus = { ...nullableText, pattern: `^(?:${AI_JOB_STATUSES.join("|")})$` };
const submissionStatus = { ...nullableText, pattern: `^(?:${Object.values(SubmissionStatus).join("|")})$` };
const timestamp = { type: String, format: "date-time" };
const nullableTime = { ...timestamp, nullable: true };
const uuid = { type: String, format: "uuid" };

@ApiSchema(model)
class BundleHeaderDto {
  @ApiProperty({ type: Number, enum: [2] }) bundleVersion: 2;
  @ApiProperty(timestamp) generatedAt: string;
  @ApiProperty(uuid) requestId: string;
  @ApiProperty() administratorId: number;
}

@ApiSchema(model)
class DiagnosticSettingsDto {
  @ApiProperty({ enum: [...REGISTRATION_MODES] }) registrationMode: RegistrationMode;
  @ApiProperty() requireEmailVerification: boolean;
  @ApiProperty() mailConfigured: boolean;
  @ApiProperty() captchaConfigured: boolean;
  @ApiProperty() crossOriginEnabled: boolean;
  @ApiProperty() metricsConfigured: boolean;
  @ApiProperty(nullableNumber) rateLimitMaxRequests: number | null;
  @ApiProperty(nullableNumber) rateLimitDurationSeconds: number | null;
  @ApiProperty(nullableNumber) proofOfWorkDifficulty: number | null;
  @ApiProperty(nullableNumber) expensiveActionDifficulty: number | null;
  @ApiProperty(nullableNumber) problemTestcases: number | null;
  @ApiProperty(nullableNumber) problemTimeLimit: number | null;
  @ApiProperty(nullableNumber) problemMemoryLimit: number | null;
  @ApiProperty(nullableNumber) submissionFileSize: number | null;
  @ApiProperty(nullableNumber) submissionQueryLimit: number | null;
  @ApiProperty(nullableNumber) problemSetQueryLimit: number | null;
}

@ApiSchema(model)
export class DiagnosticDeploymentDto {
  @ApiProperty() serverVersion: string;
  @ApiProperty(nullableText) revision: string | null;
  @ApiProperty({ type: BuildProvenanceDto }) backendProvenance: BuildProvenanceDto;
  @ApiProperty(nullableText) backendBuild: string | null;
  @ApiProperty() nodeVersion: string;
  @ApiProperty() platform: string;
  @ApiProperty() architecture: string;
  @ApiProperty() uptimeSeconds: number;
  @ApiProperty() workerCount: number;
  @ApiProperty({ enum: ["local", "judges"] }) aiExecutionMode: "local" | "judges";
  @ApiProperty() settings: DiagnosticSettingsDto;
}

@ApiSchema(model)
class DiagnosticHealthCheckDto {
  @ApiProperty({ enum: ["ok", "failed"] }) status: "ok" | "failed";
  @ApiProperty() durationMs: number;
}

@ApiSchema(model)
class DiagnosticHealthDto {
  @ApiProperty({ enum: ["ready", "unavailable"] }) status: "ready" | "unavailable";
  @ApiProperty() database: DiagnosticHealthCheckDto;
  @ApiProperty() redis: DiagnosticHealthCheckDto;
  @ApiProperty() storage: DiagnosticHealthCheckDto;
}

@ApiSchema(model)
export class DiagnosticJudgeMachineDto {
  @ApiProperty() id: number;
  @ApiProperty({ type: Boolean, nullable: true }) online: boolean | null;
  @ApiProperty() draining: boolean;
  @ApiProperty({ type: Boolean, nullable: true }) revoked: boolean | null;
  @ApiProperty(nullableNumber) protocolVersion: number | null;
  @ApiProperty(nullableText) architecture: string | null;
  @ApiProperty(nullableNumber) consumerThreads: number | null;
  @ApiProperty(nullableNumber) executionSlots: number | null;
  @ApiProperty(nullableNumber) aiExecutionSlots: number | null;
  @ApiProperty(nullableNumber) memoryBudget: number | null;
  @ApiProperty(nullableText) nodeVersion: string | null;
  @ApiProperty({ type: WorkerProvenanceDto }) provenance: WorkerProvenanceDto;
  @ApiProperty(nullableText) judgeProgram: string | null;
  @ApiProperty(nullableText) sandboxImage: string | null;
  @ApiProperty(nullableNumber) lastSeenAgeSeconds: number | null;
}

@ApiSchema(model)
class DiagnosticQueueCountDto {
  @ApiProperty({ enum: JudgeTaskType }) kind: JudgeTaskType;
  @ApiProperty() queued: number;
  @ApiProperty() leased: number;
}

@ApiSchema(model)
export class DiagnosticJudgingDto {
  @ApiProperty({ type: [DiagnosticJudgeMachineDto], maxItems: MACHINE_LIMIT }) machines: DiagnosticJudgeMachineDto[];
  @ApiProperty() machineCount: number;
  @ApiProperty({ type: [DiagnosticQueueCountDto] }) queue: DiagnosticQueueCountDto[];
  @ApiProperty(nullableNumber) oldestWaitingAgeSeconds: number | null;
}

@ApiSchema(model)
class DiagnosticHttpErrorDto {
  @ApiProperty(uuid) requestId: string;
  @ApiProperty(timestamp) time: string;
  @ApiProperty(nullableText) method: string | null;
  @ApiProperty(nullableText) route: string | null;
  @ApiProperty({ type: Number, enum: [500] }) status: 500;
  @ApiProperty() errorClass: string;
}

@ApiSchema(model)
class DiagnosticErrorCountDto {
  @ApiProperty() errorClass: string;
  @ApiProperty() count: number;
}

@ApiSchema(model)
class DiagnosticErrorsDto {
  @ApiProperty({ enum: ["responding_process"] }) scope: "responding_process";
  @ApiProperty({ type: [DiagnosticHttpErrorDto], maxItems: 100 }) recent: DiagnosticHttpErrorDto[];
  @ApiProperty({ type: [DiagnosticErrorCountDto], maxItems: 64 }) totals: DiagnosticErrorCountDto[];
}

@ApiSchema(model)
export class DiagnosticJobDto {
  @ApiProperty(uuid) id: string;
  @ApiProperty(nullableNumber) problemId: number | null;
  @ApiProperty() revision: number;
  @ApiProperty(nullableText) action: string | null;
  @ApiProperty(jobStatus) status: string | null;
  @ApiProperty() stage: string;
  @ApiProperty() attempt: number;
  @ApiProperty(nullableText) errorCode: string | null;
  @ApiProperty(nullableText) failureRole: string | null;
  @ApiProperty(timestamp) createdAt: string;
  @ApiProperty(timestamp) updatedAt: string;
  @ApiProperty(nullableTime) stageStartedAt: string | null;
  @ApiProperty(nullableTime) stageEndedAt: string | null;
}

@ApiSchema(model)
class DiagnosticJobCountsDto {
  @ApiProperty() queued: number;
  @ApiProperty() running: number;
  @ApiProperty() completed: number;
  @ApiProperty() failed: number;
  @ApiProperty() cancelled: number;
}

@ApiSchema(model)
class DiagnosticAiDto {
  @ApiProperty() paused: boolean;
  @ApiProperty() userDailyTokens: number;
  @ApiProperty() userDailyRequests: number;
  @ApiProperty() jobRequests: number;
  @ApiProperty() concurrentRequests: number;
  @ApiProperty() jobCounts: DiagnosticJobCountsDto;
  @ApiProperty({ type: [DiagnosticJobDto], maxItems: FAILED_JOB_LIMIT }) recentFailed: DiagnosticJobDto[];
}

@ApiSchema(model)
export class DiagnosticTestcaseDto {
  @ApiProperty(submissionStatus)
  status: string | null;
  @ApiProperty(nullableNumber) timeLimit: number | null;
  @ApiProperty(nullableNumber) memoryLimit: number | null;
}

@ApiSchema(model)
export class DiagnosticSubmissionDto {
  @ApiProperty() id: number;
  @ApiProperty() problemId: number;
  @ApiProperty(nullableNumber) contestId: number | null;
  @ApiProperty(submissionStatus)
  status: string | null;
  @ApiProperty(nullableNumber) score: number | null;
  @ApiProperty(nullableNumber) timeUsed: number | null;
  @ApiProperty(nullableNumber) memoryUsed: number | null;
  @ApiProperty(timestamp) submitTime: string;
  @ApiProperty(nullableTime) judgedAt: string | null;
  @ApiProperty(nullableNumber) problemDataVersionId: number | null;
  @ApiProperty(nullableNumber) judgeMachineId: number | null;
  @ApiProperty() testcaseCount: number;
  @ApiProperty({ type: [DiagnosticTestcaseDto], maxItems: TESTCASE_LIMIT }) testcases: DiagnosticTestcaseDto[];
}

@ApiSchema(model)
class DiagnosticSelectionDto {
  @ApiProperty({ type: [DiagnosticSubmissionDto], maxItems: SELECTION_LIMIT }) submissions: DiagnosticSubmissionDto[];
  @ApiProperty({ type: [DiagnosticJobDto], maxItems: SELECTION_LIMIT }) aiJobs: DiagnosticJobDto[];
  @ApiProperty({ type: [Number], maxItems: SELECTION_LIMIT }) missingSubmissionIds: number[];
  @ApiProperty({ type: [String], maxItems: SELECTION_LIMIT }) missingAiJobIds: string[];
}

@ApiSchema(model)
export class DiagnosticBundleResponseDto {
  @ApiProperty() bundle: BundleHeaderDto;
  @ApiProperty() deployment: DiagnosticDeploymentDto;
  @ApiProperty() health: DiagnosticHealthDto;
  @ApiProperty() judging: DiagnosticJudgingDto;
  @ApiProperty() errors: DiagnosticErrorsDto;
  @ApiProperty() ai: DiagnosticAiDto;
  @ApiProperty({ required: false }) selected?: DiagnosticSelectionDto;
  @ApiProperty({ type: [String] }) excluded: string[];
}
