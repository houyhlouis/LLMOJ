import { appState } from "@/appState";

/**
 * The server answers a request whose login session can't be used any more (expired, signed out elsewhere, or
 * revoked) with `X-Session-Ended`, and treats it as a visitor's. Forget that token, unless a newer sign-in already
 * replaced it, and let the layout tell the user.
 */
export function noteSessionEnded(token: string): void {
  if (!token || appState.token !== token) return;
  appState.token = "";
  appState.sessionEnded = true;
}

const REQUEST_ID = /^[0-9a-f-]{36}$/i;

/** The ID the server gave a request (its `X-Request-Id`, or `requestId` in an error body), if it looks like one. */
export function responseRequestId(headers: unknown, data: unknown): string | undefined {
  const header = (headers as Record<string, unknown>)?.["x-request-id"];
  const body = data && typeof data === "object" ? (data as { requestId?: unknown }).requestId : undefined;
  const id = typeof header === "string" ? header : body;
  return typeof id === "string" && REQUEST_ID.test(id) ? id : undefined;
}
