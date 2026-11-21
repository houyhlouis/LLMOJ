import { AI_ERROR_REPORT_MESSAGE, isAiRequest } from "../ai/ai-security";

const REDACTED = "[REDACTED]";
const MAX_TEXT_LENGTH = 8192;
const MAX_PRIVATE_VALUES = 256;

// A labelled value may contain whitespace, quotes or source code. Omit the entire message rather than guessing
// where the value ends. Unlabelled provider keys and tokens are removed separately.
const PRIVATE_FIELD =
  /(?:password|passwd|passphrase|pwd|secret(?:key)?|token|session(?:id|key|token)?|apikey|authorization|cookie|email|verification|recovery|backup|reauth|totp|otp|2fa|twofactor|source(?:code)?|code|answer|content|key)s?$/i;
const PRIVATE_CONTENT = /-----BEGIN [^-]*PRIVATE KEY-----|```|#include\s*[<"]|\bint\s+main\s*\(|\bdef\s+\w+\s*\(/i;

function privateField(key: string): boolean {
  return PRIVATE_FIELD.test(key.replace(/[^a-z0-9]/gi, ""));
}

function hasPrivateLabel(text: string): boolean {
  return [...text.matchAll(/\b([a-z0-9][a-z0-9_-]*)["']?(?:\s*[:=]|\s+)/gi)].some(match => privateField(match[1]));
}

export interface ReportRequest {
  requestId?: string;
  method?: string;
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: unknown };
  body?: unknown;
  query?: unknown;
  headers?: unknown;
  session?: { sessionKey?: string; user?: { id?: number } };
}

interface PrivateValues {
  values: string[];
  complete: boolean;
  sensitive: boolean;
}

function requestQuery(request?: ReportRequest): string {
  const url = request?.originalUrl ?? "";
  const start = url.indexOf("?");
  return start === -1 ? "" : url.slice(start + 1);
}

/** Collect values only for removal. External reports bound traversal; local logs redact all readable values. */
function privateRequestValues(request?: ReportRequest, bounded = true): PrivateValues {
  const values = new Set<string>();
  const seen = new Set<object>();
  let remaining = MAX_PRIVATE_VALUES;
  let complete = true;
  let sensitive = typeof request?.body === "string";
  const visit = (value: unknown, sensitiveKeys: boolean) => {
    const pending = [{ value, depth: 0 }];
    while (pending.length) {
      const { value: current, depth } = pending.pop();
      if (bounded && (--remaining < 0 || depth > 8)) {
        complete = false;
        break;
      }
      if (typeof current === "string" || typeof current === "number") {
        const text = String(current);
        if (bounded && text.length > MAX_TEXT_LENGTH) complete = false;
        else if (text.length) values.add(text);
      } else if (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
          if (sensitiveKeys && privateField(key)) sensitive = true;
          if (!("value" in descriptor)) complete = false;
          else pending.push({ value: descriptor.value, depth: depth + 1 });
        }
      }
      if (bounded && !complete) break;
    }
  };
  visit(request?.body, true);
  visit(request?.query, true);
  // Authentication metadata is removed by value, but its presence alone must not suppress useful diagnostics.
  visit(request?.headers, false);
  visit(request?.session?.sessionKey, false);
  const rawQuery = requestQuery(request);
  if (rawQuery) {
    if (bounded && rawQuery.length > MAX_TEXT_LENGTH) complete = false;
    else
      for (const [key, value] of new URLSearchParams(rawQuery)) {
        if (privateField(key)) sensitive = true;
        visit(value, true);
      }
  }
  return { values: [...values].sort((a, b) => b.length - a.length), complete, sensitive };
}

function redactExactValues(value: unknown, privateValues: readonly string[]): string {
  if (typeof value !== "string") return "";
  let result = value;
  for (const secret of privateValues) {
    if (!secret) continue;
    const representations = new Set([secret, JSON.stringify(secret).slice(1, -1)]);
    try {
      representations.add(encodeURIComponent(secret));
    } catch {
      // Unpaired surrogates have no URI encoding; the raw and JSON representations still need redaction.
    }
    for (const representation of representations) result = result.split(representation).join(REDACTED);
  }
  return result;
}

/** Local non-AI diagnostics retain messages and stacks; only exact request values are removed. */
export function localErrorDiagnostics(error: Error, request?: ReportRequest): { message: string; stack?: string } {
  const { values } = privateRequestValues(request, false);
  return {
    message: redactExactValues(error.message, values),
    stack: typeof error.stack === "string" ? redactExactValues(error.stack, values) : undefined
  };
}

/** Only strings enter reports. Never call toString/toJSON on an exception or arbitrary context object. */
export function redactReportText(value: unknown, privateValues: readonly string[] = []): string {
  if (typeof value !== "string") return "";
  const result = redactExactValues(value, privateValues);
  if (value.length > MAX_TEXT_LENGTH || hasPrivateLabel(result) || PRIVATE_CONTENT.test(result)) return REDACTED;
  return result
    .replace(/\b(?:sk|tvly|tvly-dev|tvly-prod)[_-][a-z0-9_-]+/gi, REDACTED)
    .replace(/\b(?:gh[pousr]_|github_pat_)[a-z0-9_]+/gi, REDACTED)
    .replace(/\bAIza[a-z0-9_-]+/gi, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\bxox[baprs]-[a-z0-9-]+/gi, REDACTED)
    .replace(/\beyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, REDACTED)
    .replace(/\b[a-f0-9]{32,}\b/gi, REDACTED)
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL omitted]")
    .slice(0, 2000);
}

export function reportErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const name = Object.getPrototypeOf(error)?.constructor?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : "Error";
}

export function reportErrorMessage(error: unknown, request?: ReportRequest): string {
  if (isAiRequest(request?.originalUrl)) return AI_ERROR_REPORT_MESSAGE;
  if (!(error instanceof Error)) return "Unexpected exception; details omitted.";
  const secrets = privateRequestValues(request);
  // Sensitive inputs can appear as arbitrary substrings in library errors; exact replacement alone cannot protect
  // a truncated password or source excerpt. Keep only the error class and request metadata for these requests.
  return secrets.complete && !secrets.sensitive ? redactReportText(error.message, secrets.values) : REDACTED;
}

/** The only request fields allowed across the reporting boundary. Bodies, header values and query values stay local. */
export function createReportContext({
  eventId,
  requestId,
  request,
  error,
  message
}: {
  eventId: string;
  requestId?: string;
  request?: ReportRequest;
  error?: unknown;
  message?: string;
}) {
  const secrets = privateRequestValues(request);
  const sanitize = (value: unknown) => (secrets.complete ? redactReportText(value, secrets.values) : REDACTED);
  const route =
    typeof request?.route?.path === "string" ? `${request.baseUrl ?? ""}${request.route.path}` : "[unmatched route]";
  const query = requestQuery(request);
  const queryKeys =
    query.length > MAX_TEXT_LENGTH
      ? [REDACTED]
      : [...new Set(new URLSearchParams(query).keys())].slice(0, 32).map(key => {
          const safeKey = /^[a-z][a-z0-9_.[\]-]{0,63}$/i.test(key) ? key : REDACTED;
          return sanitize(safeKey);
        });
  const userId = request?.session?.user?.id;
  return {
    eventId,
    requestId: redactReportText(requestId ?? request?.requestId) || undefined,
    method: request?.method && /^[A-Z]{1,16}$/.test(request.method) ? request.method : undefined,
    route: request ? redactReportText(route, secrets.values) : undefined,
    queryKeys: request ? queryKeys : undefined,
    userId: Number.isSafeInteger(userId) && userId > 0 ? userId : undefined,
    errorClass: error === undefined ? undefined : reportErrorClass(error),
    errorMessage: error === undefined ? undefined : reportErrorMessage(error, request),
    message: isAiRequest(request?.originalUrl)
      ? AI_ERROR_REPORT_MESSAGE
      : secrets.sensitive
        ? REDACTED
        : sanitize(message)
  };
}
