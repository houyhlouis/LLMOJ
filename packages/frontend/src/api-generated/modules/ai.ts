// This file is generated automatically, do NOT modify it.

/// <reference path="../types.d.ts" />

import { createGetApi, createPostApi } from "@/api";

export const getConfiguration = createPostApi<void, void>("ai/getConfiguration", {});
export const saveConfiguration = createPostApi<ApiTypes.SaveAiConfigurationDto, void>("ai/saveConfiguration", {});
export const listEndpointUsage = createPostApi<void, void>("ai/listEndpointUsage", {});
export const models = createPostApi<void, void>("ai/models", {});
export const test = createPostApi<ApiTypes.AiTestDto, void>("ai/test", {});
export const prepareAttachment = createPostApi<ApiTypes.AiPrepareAttachmentDto, void>("ai/prepareAttachment", {});
export const usage = createPostApi<ApiTypes.AiUsageQueryDto, void>("ai/usage", {});
export const start = createPostApi<ApiTypes.StartAiJobDto, void>("ai/start", {});
export const jobs = createPostApi<ApiTypes.AiJobQueryDto, void>("ai/jobs", {});
export const jobsSummary = createPostApi<ApiTypes.AiJobSummaryQueryDto, ApiTypes.AiJobSummaryResponseDto>(
  "ai/jobsSummary",
  {}
);
export const jobDetail = createPostApi<ApiTypes.AiJobDetailDto, ApiTypes.AiJobDetailResponseDto>("ai/jobDetail", {});
export const approveAllocation = createPostApi<
  ApiTypes.AiAllocationApprovalDto,
  ApiTypes.AiAllocationApprovalResponseDto
>("ai/approveAllocation", {});
export const deploymentIdentity = createPostApi<void, ApiTypes.AiDeploymentIdentityResponseDto>(
  "ai/deploymentIdentity",
  {}
);
export const exportDiagnostic = createPostApi<ApiTypes.AiDiagnosticExportDto, ApiTypes.AiDiagnosticExportResponseDto>(
  "ai/exportDiagnostic",
  {}
);
export const cancel = createPostApi<ApiTypes.AiJobIdDto, void>("ai/cancel", {});
export const retry = createPostApi<ApiTypes.AiRetryJobDto, void>("ai/retry", {});
export const failures = createPostApi<ApiTypes.AiFailuresDto, void>("ai/failures", {});
export const failureArtifact = createPostApi<ApiTypes.AiFailureArtifactDto, void>("ai/failureArtifact", {});
export const downloadFailureArtifact = createPostApi<ApiTypes.AiFailureArtifactDto, void>(
  "ai/downloadFailureArtifact",
  {}
);
export const correctTutorial = createPostApi<ApiTypes.AiJobIdDto, void>("ai/correctTutorial", {});
export const tutorialStatus = createPostApi<ApiTypes.AiTutorialStatusDto, void>("ai/tutorialStatus", {});
export const replayFailure = createPostApi<ApiTypes.AiReplayFailureDto, void>("ai/replayFailure", {});
export const repairChange = createPostApi<ApiTypes.AiRepairChangeDto, void>("ai/repairChange", {});
