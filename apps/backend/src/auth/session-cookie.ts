import type { Request } from "express"; // eslint-disable-line import/no-extraneous-dependencies

/*
 * Sign-in sessions kept in an HttpOnly cookie, so that page scripts never see the session token.
 *
 * A page on the API's own origin asks for this with the header `X-Session-Mode: cookie`. Signing in then sets the
 * cookie and gives the page a marker (`cookie:<session ID>`) instead of the token. The marker only tells the page
 * which session it has; it is no credential.
 *
 * The cookie is SameSite=Strict, so browsers don't send it from other sites. As well, a request authenticated by the
 * cookie must carry the header and come from the same origin to change anything (`cookieSessionAllowed`): other
 * origins can't send a custom header without a CORS preflight, which this API never allows. Pages on other origins
 * (the cross-origin proxy, JSONP) and API scripts keep sending the token in the Authorization header.
 */

export const SESSION_COOKIE = "llmoj_session";
export const SESSION_MODE_HEADER = "x-session-mode";
const MARKER_PREFIX = "cookie:";

/** Browsers keep a cookie for at most 400 days. */
const MAXIMUM_COOKIE_DAYS = 400;

export function sessionMarker(sessionId: number): string {
  return `${MARKER_PREFIX}${sessionId}`;
}

export function isSessionMarker(value: string): boolean {
  return typeof value === "string" && value.startsWith(MARKER_PREFIX);
}

/** The session token of the Authorization header; a page's marker is none. */
export function bearerSessionKey(req: Pick<Request, "headers">): string {
  const header = req.headers.authorization;
  const key = header && header.split(" ")[1];
  return key && !isSessionMarker(key) ? key : null;
}

/** The session token of the session cookie, if the request has one. */
export function cookieSessionKey(req: Pick<Request, "headers">): string {
  const header = req.headers.cookie;
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The host this request was sent to, as the browser saw it. */
function requestHost(req: Pick<Request, "headers">): string {
  const forwarded = req.headers["x-forwarded-host"];
  const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0].trim() || req.headers.host;
  return (host || "").toLowerCase();
}

/**
 * Whether the browser sent the request from a page of the same origin. Browsers say so in `Sec-Fetch-Site`; older
 * ones only send `Origin`, which then has to name this host. A request with neither isn't from another site's page.
 */
export function isSameOriginRequest(req: Pick<Request, "headers">): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site != null) return site === "same-origin";
  const { origin } = req.headers;
  if (origin == null) return true;
  try {
    return new URL(origin).host.toLowerCase() === requestHost(req);
  } catch {
    return false;
  }
}

/** Whether the page asks for its session in the cookie, from the same origin. */
export function wantsCookieSession(req: Pick<Request, "headers">): boolean {
  return req.headers[SESSION_MODE_HEADER] === "cookie" && isSameOriginRequest(req);
}

/**
 * Whether the session cookie may authenticate this request. Reading needs the request to come from the same origin
 * (when the browser says where it comes from); JSONP never uses the cookie. Anything else needs the session mode
 * header too, which other origins can't send.
 */
export function cookieSessionAllowed(req: Pick<Request, "headers" | "method" | "query">): boolean {
  if (req.query && "jsonp" in req.query) return false;
  if (!isSameOriginRequest(req)) return false;
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  return req.headers[SESSION_MODE_HEADER] === "cookie";
}

/**
 * Whether the page is on HTTPS, so that the cookie may only travel over HTTPS. Proxies say so in
 * `X-Forwarded-Proto`; behind a chain of them (such as Caddy in front of LLMOJ's Nginx) the page's own `Origin` does.
 */
function secure(req: Pick<Request, "headers" | "secure">): boolean {
  const proto = req.headers["x-forwarded-proto"];
  return (
    !!req.secure ||
    (Array.isArray(proto) ? proto[0] : proto)?.split(",")[0].trim() === "https" ||
    /^https:\/\//i.test(req.headers.origin || "")
  );
}

/**
 * The `Set-Cookie` value that keeps a session. It lasts as long as a session can (`maxAgeDays`, 0: as long as browsers
 * keep cookies); the server ends sessions on its own terms before that.
 */
export function sessionCookie(
  req: Pick<Request, "headers" | "secure">,
  sessionKey: string,
  maxAgeDays: number
): string {
  const days = maxAgeDays > 0 ? Math.min(maxAgeDays, MAXIMUM_COOKIE_DAYS) : MAXIMUM_COOKIE_DAYS;
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionKey)}`,
    "Path=/",
    `Max-Age=${Math.round(days * 24 * 60 * 60)}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure(req) ? ["Secure"] : [])
  ].join("; ");
}

/** The `Set-Cookie` value that removes the session cookie. */
export function expiredSessionCookie(req: Pick<Request, "headers" | "secure">): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure(req) ? ["Secure"] : [])
  ].join("; ");
}
