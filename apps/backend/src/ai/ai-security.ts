/** AI requests can carry keys, private statements and images; never attach them to error reports. */
export function isAiRequest(url: unknown): boolean {
  if (typeof url !== "string") return false;
  let pathname = url.split("?")[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // A malformed URL is still checked using its original path.
  }
  return /^\/api\/ai(?:\/|$)/i.test(pathname);
}

export const AI_ERROR_REPORT_MESSAGE = "AI request failed; sensitive details omitted.";
export const AI_REQUEST_BODY_REDACTED = "[AI request body redacted]";
