// This file is generated automatically, do NOT modify it.

/// <reference path="../types.d.ts" />

import { createGetApi, createPostApi } from "@/api";

export const getSettings = createGetApi<void, ApiTypes.SiteManagementSettingsDto>("site-management/getSettings");
export const updateRegistrationMode = createPostApi<
  ApiTypes.UpdateRegistrationModeRequestDto,
  ApiTypes.SiteManagementSettingsDto
>("site-management/updateRegistrationMode", {});
export const getAiPolicy = createGetApi<void, ApiTypes.AiPolicyDto>("site-management/getAiPolicy");
export const updateAiPolicy = createPostApi<ApiTypes.AiPolicyDto, ApiTypes.AiPolicyDto>(
  "site-management/updateAiPolicy",
  {}
);
export const getJudgePolicy = createGetApi<void, ApiTypes.JudgePolicyDto>("site-management/getJudgePolicy");
export const updateJudgePolicy = createPostApi<ApiTypes.JudgePolicyDto, ApiTypes.JudgePolicyDto>(
  "site-management/updateJudgePolicy",
  {}
);
export const getAiEndpointPolicy = createGetApi<void, ApiTypes.AiEndpointPolicyDto>(
  "site-management/getAiEndpointPolicy"
);
export const updateAiEndpointPolicy = createPostApi<ApiTypes.AiEndpointPolicyDto, ApiTypes.AiEndpointPolicyDto>(
  "site-management/updateAiEndpointPolicy",
  {}
);
