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
