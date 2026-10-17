// This file is generated automatically, do NOT modify it.

/// <reference path="../types.d.ts" />

import { createGetApi, createPostApi } from "@/api";

export const list = createGetApi<{ mine: string }, void>("team/list");
export const get = createPostApi<ApiTypes.TeamRequestDto, void>("team/get", {});
export const joinPreview = createPostApi<ApiTypes.TeamRequestDto, void>("team/joinPreview", {});
export const create = createPostApi<ApiTypes.TeamRequestDto, void>("team/create", {});
export const save = createPostApi<ApiTypes.TeamRequestDto, void>("team/save", {});
export const join = createPostApi<ApiTypes.TeamRequestDto, void>("team/join", {});
export const leave = createPostApi<ApiTypes.TeamRequestDto, void>("team/leave", {});
export const members = createPostApi<ApiTypes.TeamRequestDto, void>("team/members", {});
export const manageMembers = createPostApi<ApiTypes.TeamRequestDto, void>("team/manageMembers", {});
export const transfer = createPostApi<ApiTypes.TeamRequestDto, void>("team/transfer", {});
export const saveGroup = createPostApi<ApiTypes.TeamRequestDto, void>("team/saveGroup", {});
export const changeGroup = createPostApi<ApiTypes.TeamRequestDto, void>("team/changeGroup", {});
export const createProblem = createPostApi<ApiTypes.TeamRequestDto, void>("team/createProblem", {});
export const createContest = createPostApi<ApiTypes.TeamRequestDto, void>("team/createContest", {});
export const updateContestAccess = createPostApi<ApiTypes.TeamRequestDto, void>("team/updateContestAccess", {});
export const createDiscussion = createPostApi<ApiTypes.TeamRequestDto, void>("team/createDiscussion", {});
export const archiveResource = createPostApi<ApiTypes.TeamRequestDto, void>("team/archiveResource", {});
export const saveAssignment = createPostApi<ApiTypes.TeamRequestDto, void>("team/saveAssignment", {});
export const assignment = createPostApi<ApiTypes.TeamRequestDto, void>("team/assignment", {});
export const exportAssignment = createPostApi<ApiTypes.TeamRequestDto, void>("team/exportAssignment", {});
export const prepareFileUpload = createPostApi<ApiTypes.TeamRequestDto, void>("team/prepareFileUpload", {});
export const uploadFile = createPostApi<ApiTypes.TeamRequestDto, void>("team/uploadFile", {});
export const prepareFileUploadPart = createPostApi<ApiTypes.TeamRequestDto, void>("team/prepareFileUploadPart", {});
export const cancelFileUpload = createPostApi<ApiTypes.TeamRequestDto, void>("team/cancelFileUpload", {});
export const downloadFile = createPostApi<ApiTypes.TeamRequestDto, void>("team/downloadFile", {});
export const archiveFile = createPostApi<ApiTypes.TeamRequestDto, void>("team/archiveFile", {});
export const createInvitation = createPostApi<ApiTypes.TeamRequestDto, void>("team/createInvitation", {});
export const invitations = createPostApi<ApiTypes.TeamRequestDto, void>("team/invitations", {});
export const deactivateInvitation = createPostApi<ApiTypes.TeamRequestDto, void>("team/deactivateInvitation", {});
export const acceptInvitation = createPostApi<ApiTypes.TeamRequestDto, void>("team/acceptInvitation", {});
export const acceptContestInvitation = createPostApi<ApiTypes.TeamRequestDto, void>("team/acceptContestInvitation", {});
