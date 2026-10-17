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
