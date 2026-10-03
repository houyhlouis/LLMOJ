// This file is generated automatically, do NOT modify it.

/// <reference path="../types.d.ts" />

import { createGetApi, createPostApi } from "@/api";

export const getConfiguration = createPostApi<void, void>("ai/getConfiguration", {});
export const saveConfiguration = createPostApi<ApiTypes.SaveAiConfigurationDto, void>("ai/saveConfiguration", {});
export const models = createPostApi<void, void>("ai/models", {});
export const test = createPostApi<ApiTypes.AiTestDto, void>("ai/test", {});
export const start = createPostApi<ApiTypes.StartAiJobDto, void>("ai/start", {});
export const jobs = createPostApi<ApiTypes.AiJobQueryDto, void>("ai/jobs", {});
export const cancel = createPostApi<ApiTypes.AiJobIdDto, void>("ai/cancel", {});
export const retry = createPostApi<ApiTypes.AiJobIdDto, void>("ai/retry", {});
