// This file is generated automatically, do NOT modify it.

/// <reference path="../types.d.ts" />

import { createGetApi, createPostApi } from "@/api";

export const list = createGetApi<void, void>("studyList/list");
export const get = createPostApi<ApiTypes.StudyListIdDto, void>("studyList/get", {});
export const save = createPostApi<ApiTypes.SaveDto, void>("studyList/save", {});
export const remove = createPostApi<ApiTypes.StudyListIdDto, void>("studyList/delete", {});
