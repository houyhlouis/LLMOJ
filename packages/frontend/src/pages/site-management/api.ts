import { ApiResponse, createGetApi, createPostApi } from "@/api";

export type RegistrationMode = "open" | "approval" | "closed";

export interface SiteSettings {
  registrationMode: RegistrationMode;
  configuredRegistrationMode: RegistrationMode;
  usesOverride: boolean;
}

export class InvalidSiteSettingsResponse extends Error {}

export class SiteSettingsRequestError extends Error {
  constructor(readonly result: ApiResponse<SiteSettings>) {
    super();
  }
}

export const isRegistrationMode = (value: unknown): value is RegistrationMode =>
  value === "open" || value === "approval" || value === "closed";

function settingsResponse(result: ApiResponse<SiteSettings>): SiteSettings {
  if (result.requestError) throw new SiteSettingsRequestError(result);
  const value = result.response;
  if (
    !value ||
    !isRegistrationMode(value.registrationMode) ||
    !isRegistrationMode(value.configuredRegistrationMode) ||
    typeof value.usesOverride !== "boolean"
  )
    throw new InvalidSiteSettingsResponse();
  return value;
}

const getSettings = createGetApi<void, SiteSettings>("site-management/getSettings");
const saveMode = createPostApi<{ registrationMode: RegistrationMode | null }, SiteSettings>(
  "site-management/updateRegistrationMode",
  {}
);

export const getSiteSettings = async (): Promise<SiteSettings> => settingsResponse(await getSettings());

export const updateRegistrationMode = async (registrationMode: RegistrationMode | null): Promise<SiteSettings> =>
  settingsResponse(await saveMode({ registrationMode }));

export interface AiPolicy {
  paused: boolean;
  userDailyTokens: number;
  userDailyRequests: number;
  jobRequests: number;
  concurrentRequests: number;
}

/** The same ranges the server enforces; 0 means no limit except for simultaneous requests. */
export const AI_POLICY_RANGES: Readonly<Record<Exclude<keyof AiPolicy, "paused">, readonly [number, number]>> = {
  userDailyTokens: [0, 1e12],
  userDailyRequests: [0, 1e7],
  jobRequests: [0, 100000],
  concurrentRequests: [1, 256]
};

export class AiPolicyRequestError extends Error {
  constructor(readonly result: ApiResponse<AiPolicy>) {
    super();
  }
}

export function isAiPolicy(value: unknown): value is AiPolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Record<string, unknown>;
  return (
    typeof policy.paused === "boolean" &&
    Object.entries(AI_POLICY_RANGES).every(
      ([key, [min, max]]) =>
        Number.isSafeInteger(policy[key]) && (policy[key] as number) >= min && (policy[key] as number) <= max
    )
  );
}

function aiPolicyResponse(result: ApiResponse<AiPolicy>): AiPolicy {
  if (result.requestError) throw new AiPolicyRequestError(result);
  if (!isAiPolicy(result.response)) throw new InvalidSiteSettingsResponse();
  return result.response;
}

const getPolicy = createGetApi<void, AiPolicy>("site-management/getAiPolicy");
const savePolicy = createPostApi<AiPolicy, AiPolicy>("site-management/updateAiPolicy", {});

export const getAiPolicy = async (): Promise<AiPolicy> => aiPolicyResponse(await getPolicy());

export const updateAiPolicy = async (policy: AiPolicy): Promise<AiPolicy> => aiPolicyResponse(await savePolicy(policy));

export interface JudgePolicy {
  contestReservedThreads: number;
  agingMinutes: number;
}

/** The same ranges the server enforces. */
export const JUDGE_POLICY_RANGES: Readonly<Record<keyof JudgePolicy, readonly [number, number]>> = {
  contestReservedThreads: [0, 64],
  agingMinutes: [0, 10080]
};

export class JudgePolicyRequestError extends Error {
  constructor(readonly result: ApiResponse<JudgePolicy>) {
    super();
  }
}

export function isJudgePolicy(value: unknown): value is JudgePolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Record<string, unknown>;
  return Object.entries(JUDGE_POLICY_RANGES).every(
    ([key, [min, max]]) =>
      Number.isSafeInteger(policy[key]) && (policy[key] as number) >= min && (policy[key] as number) <= max
  );
}

function judgePolicyResponse(result: ApiResponse<JudgePolicy>): JudgePolicy {
  if (result.requestError) throw new JudgePolicyRequestError(result);
  if (!isJudgePolicy(result.response)) throw new InvalidSiteSettingsResponse();
  return result.response;
}

const getJudging = createGetApi<void, JudgePolicy>("site-management/getJudgePolicy");
const saveJudging = createPostApi<JudgePolicy, JudgePolicy>("site-management/updateJudgePolicy", {});

export const getJudgePolicy = async (): Promise<JudgePolicy> => judgePolicyResponse(await getJudging());

export const updateJudgePolicy = async (policy: JudgePolicy): Promise<JudgePolicy> =>
  judgePolicyResponse(await saveJudging(policy));

export const AI_ENDPOINT_TYPES = ["chat", "responses", "anthropic", "tavily", "mcp"] as const;
export type AiEndpointType = (typeof AI_ENDPOINT_TYPES)[number];

export interface AiApprovedEndpoint {
  name: string;
  type: AiEndpointType;
  baseUrl: string;
}

export interface AiEndpointPolicy {
  customEndpoints: "public" | "approved";
  endpoints: AiApprovedEndpoint[];
}

/** An address accounts saved in their AI configurations (see the backend's AiService.endpointUsage). */
export interface AiEndpointUsage {
  kind: "model" | "search";
  type: string;
  baseUrl: string;
  accounts: number;
  administratorAccounts: number;
  destination: "public" | "private" | "unresolved";
  status: "approved" | "public" | "private" | "not_approved";
}

export class AiEndpointPolicyRequestError extends Error {
  constructor(readonly result: ApiResponse<AiEndpointPolicy>) {
    super();
  }
}

export function isAiEndpointPolicy(value: unknown): value is AiEndpointPolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Record<string, unknown>;
  return (
    (policy.customEndpoints === "public" || policy.customEndpoints === "approved") &&
    Array.isArray(policy.endpoints) &&
    policy.endpoints.every(
      endpoint =>
        endpoint &&
        typeof endpoint.name === "string" &&
        typeof endpoint.baseUrl === "string" &&
        (AI_ENDPOINT_TYPES as readonly unknown[]).includes(endpoint.type)
    )
  );
}

function aiEndpointPolicyResponse(result: ApiResponse<AiEndpointPolicy>): AiEndpointPolicy {
  if (result.requestError) throw new AiEndpointPolicyRequestError(result);
  if (!isAiEndpointPolicy(result.response)) throw new InvalidSiteSettingsResponse();
  return result.response;
}

const getEndpoints = createGetApi<void, AiEndpointPolicy>("site-management/getAiEndpointPolicy");
const saveEndpoints = createPostApi<AiEndpointPolicy, AiEndpointPolicy>("site-management/updateAiEndpointPolicy", {});

export const getAiEndpointPolicy = async (): Promise<AiEndpointPolicy> =>
  aiEndpointPolicyResponse(await getEndpoints());

export const updateAiEndpointPolicy = async (policy: AiEndpointPolicy): Promise<AiEndpointPolicy> =>
  aiEndpointPolicyResponse(await saveEndpoints(policy));

const listUsage = createPostApi<void, { endpoints?: AiEndpointUsage[]; error?: string }>("ai/listEndpointUsage", {});

export class AiEndpointUsageError extends Error {
  constructor(readonly result: ApiResponse<{ endpoints?: AiEndpointUsage[]; error?: string }>) {
    super();
  }
}

/** The addresses accounts saved in their AI configurations (site administrators only). */
export async function listAiEndpointUsage(): Promise<AiEndpointUsage[]> {
  const result = await listUsage();
  if (result.requestError || result.response?.error) throw new AiEndpointUsageError(result);
  if (!Array.isArray(result.response?.endpoints)) throw new InvalidSiteSettingsResponse();
  return result.response.endpoints;
}
