// This file is generated automatically, do NOT modify it.

/// <reference path="../types.d.ts" />

import { createGetApi, createPostApi } from "@/api";

export const catalog = createGetApi<void, void>("access/catalog");
export const mine = createGetApi<void, void>("access/mine");
export const get = createPostApi<ApiTypes.GetPermissionsDto, void>("access/get", {});
export const set = createPostApi<ApiTypes.SetPermissionsDto, void>("access/set", {});
