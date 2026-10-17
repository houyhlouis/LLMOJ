// This file is generated automatically, do NOT modify it.

/// <reference path="../types.d.ts" />

import { createGetApi, createPostApi } from "@/api";

export const list = createGetApi<
  {
    id?: string;
    problemId?: string;
    submissionId?: string;
    contestId?: string;
    hackerId?: string;
    page?: string;
    hacker?: string;
    status?: string;
    inputData?: string;
    referenceSubmissionId?: string;
    standardCode?: string;
    standardLanguage?: string;
    standardFileIo?: string;
    validatorCode?: string;
    validatorLanguage?: string;
  },
  void
>("hack");
export const listPost = createPostApi<ApiTypes.HackRequestDto, void>("hack/list", {});
export const get = createPostApi<ApiTypes.HackRequestDto, void>("hack/get", {});
export const eligibility = createPostApi<ApiTypes.HackRequestDto, void>("hack/eligibility", {});
export const create = createPostApi<ApiTypes.HackRequestDto, void>("hack/create", {});
export const config = createPostApi<ApiTypes.HackRequestDto, void>("hack/config", {});
export const saveConfig = createPostApi<ApiTypes.HackRequestDto, void>("hack/saveConfig", {});
export const useSubmissionReference = createPostApi<ApiTypes.HackRequestDto, void>("hack/useSubmissionReference", {});
export const rejudge = createPostApi<ApiTypes.HackRequestDto, void>("hack/rejudge", {});
