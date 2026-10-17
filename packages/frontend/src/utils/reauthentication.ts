/**
 * Sensitive changes are refused with `REAUTHENTICATION_REQUIRED` unless the password (and second factor) was entered
 * recently. The API clients then ask for it in the dialog that `ReauthenticationHost` registers here, and repeat the
 * refused request once: the server refuses such a request before changing anything.
 */
export const REAUTHENTICATION_REQUIRED = "REAUTHENTICATION_REQUIRED";

type ConfirmIdentity = () => Promise<boolean>;

let handler: ConfirmIdentity = null;
let pending: Promise<boolean> = null;

export function setReauthenticationHandler(confirm: ConfirmIdentity): void {
  handler = confirm;
}

/** Whether a response body or error body asks for the password. */
export function needsReauthentication(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { error?: unknown }).error === REAUTHENTICATION_REQUIRED;
}

/** Asks once for all requests refused at the same time. False when cancelled, or when no dialog is mounted. */
export function confirmIdentity(): Promise<boolean> {
  if (!handler) return Promise.resolve(false);
  pending ||= handler().finally(() => {
    pending = null;
  });
  return pending;
}
