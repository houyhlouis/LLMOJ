// This file is generated automatically, do NOT modify it.

/// <reference path="../types.d.ts" />

import { createGetApi, createPostApi } from "@/api";

export const list = createPostApi<ApiTypes.ContestRequestDto, void>("contest/list", {});
export const detail = createPostApi<ApiTypes.ContestRequestDto, void>("contest/detail", {});
export const save = createPostApi<ApiTypes.ContestRequestDto, void>("contest/save", {});
export const delete_ = createPostApi<ApiTypes.ContestRequestDto, void>("contest/delete", {});
export const saveProblem = createPostApi<ApiTypes.ContestRequestDto, void>("contest/saveProblem", {});
export const removeProblem = createPostApi<ApiTypes.ContestRequestDto, void>("contest/removeProblem", {});
export const problem = createPostApi<ApiTypes.ContestRequestDto, void>("contest/problem", {});
export const attachment = createPostApi<ApiTypes.ContestRequestDto, void>("contest/attachment", {});
export const removeAttachment = createPostApi<ApiTypes.ContestRequestDto, void>("contest/removeAttachment", {});
export const download = createPostApi<ApiTypes.ContestRequestDto, void>("contest/download", {});
export const submit = createPostApi<ApiTypes.ContestRequestDto, void, { proofOfWorkAction: "submit_problem" }>(
  "contest/submit",
  { proofOfWorkAction: "submit_problem" }
);
export const prepareUpload = createPostApi<
  ApiTypes.ContestRequestDto,
  void,
  { proofOfWorkAction: "prepare_submission_file_upload" }
>("contest/prepareUpload", { proofOfWorkAction: "prepare_submission_file_upload" });
export const submissions = createPostApi<ApiTypes.ContestRequestDto, void>("contest/submissions", {});
export const submission = createPostApi<ApiTypes.ContestRequestDto, void>("contest/submission", {});
export const ranklist = createPostApi<ApiTypes.ContestRequestDto, void>("contest/ranklist", {});
export const export_ = createPostApi<ApiTypes.ContestRequestDto, void>("contest/export", {});
export const rejudge = createPostApi<ApiTypes.ContestRequestDto, void>("contest/rejudge", {});
export const summary = createPostApi<ApiTypes.ContestRequestDto, void>("contest/summary", {});
export const saveSummary = createPostApi<ApiTypes.ContestRequestDto, void>("contest/saveSummary", {});
export const summaries = createPostApi<ApiTypes.ContestRequestDto, void>("contest/summaries", {});
