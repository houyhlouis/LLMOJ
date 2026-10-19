import { appState } from "@/appState";

/*
 * On the API's own origin the server keeps the sign-in session in an HttpOnly cookie that page scripts can't read.
 * The client then keeps only a marker of its session in `appState.token` ("cookie:" and the session's ID): it tells
 * the client which session it has, and is no credential. See the backend's auth/session-cookie.ts.
 */

const MARKER_PREFIX = "cookie:";

/** Whether the API is on this page's origin, so that the server may keep the session in the cookie. */
export function apiSameOrigin(): boolean {
  const endpoint = window.apiEndpoint;
  return !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(endpoint) || endpoint.indexOf(location.origin + "/") === 0;
}

/** Whether `token` is a marker of a session kept in the cookie, rather than a session token. */
export function isSessionMarker(token: string): boolean {
  return typeof token === "string" && token.startsWith(MARKER_PREFIX);
}

/**
 * The request headers that carry the session: a session token goes in `Authorization`, a cookie session carries
 * itself. Pages on the API's origin also say that they keep their session in the cookie: the cookie may then
 * authenticate changes, and signing in sets it.
 */
export function sessionHeaders(token: string): Record<string, string> {
  return {
    ...(token && !isSessionMarker(token) ? { Authorization: `Bearer ${token}` } : {}),
    ...(apiSameOrigin() ? { "X-Session-Mode": "cookie" } : {})
  };
}

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
