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
