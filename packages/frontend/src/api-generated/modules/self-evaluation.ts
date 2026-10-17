// This file is generated automatically, do NOT modify it.

/// <reference path="../types.d.ts" />

import { createGetApi, createPostApi } from "@/api";

export const info = createPostApi<ApiTypes.SelfEvalRequestDto, void>("selfEval/info", {});
export const configureProfile = createPostApi<ApiTypes.SelfEvalRequestDto, void>("selfEval/configureProfile", {});
export const prepare = createPostApi<ApiTypes.SelfEvalRequestDto, void>("selfEval/prepare", {});
export const create = createPostApi<ApiTypes.SelfEvalRequestDto, void>("selfEval/create", {});
export const get = createPostApi<ApiTypes.SelfEvalRequestDto, void>("selfEval/get", {});
export const list = createPostApi<ApiTypes.SelfEvalRequestDto, void>("selfEval/list", {});
