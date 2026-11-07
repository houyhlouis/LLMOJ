import { createHash } from "crypto";

import { AiError } from "./ai.types";

export interface AiSearchDiagnostic {
  provider: string;
  category:
    "invalid_request" | "authentication" | "permission" | "rate_limit" | "quota" | "transient" | "configuration";
  httpStatus?: number;
  code: string;
  message: string;
  requestId?: string;
  requestShape: "search-v1";
  queryHash: string;
  retryable: boolean;
}
export function safeHttpError(status: number, requestId: unknown, secrets: string[] = []) {
  const id =
    typeof requestId === "string" &&
    /^[a-zA-Z0-9._:-]{1,128}$/.test(requestId) &&
    !secrets.some(secret => secret && requestId.includes(secret))
      ? requestId
      : undefined;
  return Object.assign(new AiError("PROVIDER_HTTP_ERROR", String(status)), { httpStatus: status, requestId: id });
}
export function safeMcpError(value: unknown) {
  const code = (value as { code?: number })?.code;
  const safeCode = [-32600, -32602, -32700].includes(code)
    ? "mcp_invalid_request"
    : code === -32603
      ? "mcp_internal_error"
      : "mcp_error";
  return Object.assign(new AiError("MCP_ERROR"), { safeCode });
}
export function searchDiagnostic(error: unknown, provider: string, query: string): AiSearchDiagnostic {
  const e = error as AiError & { httpStatus?: number; requestId?: string; safeCode?: string };
  const status = e?.httpStatus || Number(/PROVIDER_HTTP_ERROR: (\d{3})/.exec(e?.message || "")?.[1]) || undefined;
  const category: AiSearchDiagnostic["category"] =
    status === 400 || status === 422 || e?.safeCode === "mcp_invalid_request"
      ? "invalid_request"
      : status === 401
        ? "authentication"
        : status === 403
          ? "permission"
          : status === 402 || (provider === "tavily" && [432, 433].includes(status))
            ? "quota"
            : status === 429
              ? "rate_limit"
              : status >= 500 ||
                  e?.safeCode === "mcp_internal_error" ||
                  ["PROVIDER_TIMEOUT", "PROVIDER_NETWORK_ERROR", "SEARCH_NETWORK_ERROR"].includes(e?.code)
                ? "transient"
                : "configuration";
  return {
    provider,
    category,
    ...(status ? { httpStatus: status } : {}),
    code: e?.safeCode || (status ? `http_${status}` : category),
    message: {
      invalid_request: "Provider rejected the search request.",
      authentication: "Provider authentication failed.",
      permission: "Provider denied access.",
      rate_limit: "Provider rate limit reached.",
      quota: "Provider plan or spending limit reached.",
      transient: "Provider temporarily unavailable.",
      configuration: "Search configuration or response requires review."
    }[category],
    ...(e?.requestId ? { requestId: e.requestId } : {}),
    requestShape: "search-v1",
    queryHash: createHash("sha256").update(query).digest("hex"),
    retryable: ["rate_limit", "transient"].includes(category)
  };
}
