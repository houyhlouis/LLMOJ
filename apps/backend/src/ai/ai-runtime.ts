import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";

import { AiError } from "./ai.types";
import type { ProviderResponse } from "./ai-provider";

/** MariaDB advisory locks are server-wide, so isolate independent application databases. */
export function aiWorkerLockName(database?: unknown): string {
  const name = typeof database === "string" && database ? database : "default";
  return `hyhoj_ai_worker:${createHash("sha256").update(name).digest("hex").slice(0, 48)}`;
}

export interface AiRequestMetadata {
  target: "llm" | "search";
  provider: string;
  host: string;
  model?: string;
  operation: string;
  /** The most tokens a billable request can use: its output limit plus an upper estimate of its input. */
  reserveTokens?: number;
}
/** Model generations and searches; polls, model listings and MCP handshakes aren't billed by providers. */
export function isBillableRequest(metadata: Pick<AiRequestMetadata, "target" | "operation">): boolean {
  return metadata.target === "llm"
    ? metadata.operation === "generate"
    : ["search", "tools/call"].includes(metadata.operation);
}
/** An upper estimate of a prompt's tokens: English averages about four characters a token, CJK about one. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 128) ascii++;
    // A surrogate pair is one character.
    else if (code < 0xdc00 || code > 0xdfff) other++;
  }
  return Math.ceil(ascii / 3) + other;
}
/** Generous for one image at the resolutions providers accept. */
export const IMAGE_TOKEN_ESTIMATE = 4096;
export interface AiAdmission {
  reservationId?: string;
  release(): void;
}
export interface AiUsageRecord extends Omit<AiRequestMetadata, "reserveTokens"> {
  success: boolean;
  errorCode: string | null;
  elapsedMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  searchCredits: number | null;
  usageReported: boolean;
  responseId?: string;
  /** A background response still being generated; its usage arrives with the poll that completes it. */
  pendingResponseId?: string;
}
export interface AiResponseCheckpoint {
  responseId: string;
  createdAt: number;
}
export interface AiRuntimeContext {
  ownerId: number;
  jobId?: string;
  signal?: AbortSignal;
  /** Whether the owner may reach private and local provider addresses not listed in HYHOJ_AI_PRIVATE_HOSTS. */
  allowPrivateNetwork?: () => Promise<boolean>;
  /**
   * Throws if the owner may not send a request to `url`, whose resolved addresses are private or local if
   * `privateDestination`; see AiEndpointPolicyService. Replaces allowPrivateNetwork when given.
   */
  checkEndpoint?: (url: URL, privateDestination: boolean) => Promise<void>;
  /** Site pause, budgets and concurrency, checked before every provider request; see AiAdmissionService. */
  admit?: (metadata: AiRequestMetadata) => Promise<AiAdmission>;
  record: (record: AiUsageRecord, reservationId?: string) => Promise<void>;
  checkActive?: () => Promise<void>;
  loadResponse?: (requestHash: string) => Promise<AiResponseCheckpoint | null>;
  saveResponse?: (requestHash: string, value: AiResponseCheckpoint) => Promise<void>;
}
const runtime = new AsyncLocalStorage<AiRuntimeContext>();
export function withAiRuntime<T>(context: AiRuntimeContext, work: () => Promise<T>): Promise<T> {
  return runtime.run(context, work);
}
export function currentAiRuntime() {
  return runtime.getStore();
}
export function aiCancellationError(signal: AbortSignal): AiError {
  return signal.reason instanceof AiError ? signal.reason : new AiError("JOB_CANCELLED");
}
/** Race only read-only waits; side-effecting operations must finish their own cleanup. */
export function awaitAiActive<T>(work: Promise<T>, signal = currentAiRuntime()?.signal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(aiCancellationError(signal));
    signal.addEventListener("abort", abort, { once: true });
    const finish = () => signal.removeEventListener("abort", abort);
    work.then(
      value => {
        finish();
        resolve(value);
      },
      error => {
        finish();
        reject(error);
      }
    );
    if (signal.aborted) {
      finish();
      abort();
    }
  });
}
export async function waitForAiDelay(milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await awaitAiActive(
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, milliseconds);
      })
    );
  } finally {
    clearTimeout(timer);
  }
}
function number(value: unknown, integer = true): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER &&
    (!integer || Number.isInteger(value))
    ? value
    : null;
}
/** Provider-reported values only. Missing usage is unknown, never an estimated zero. */
export function extractUsage(data: ProviderResponse) {
  // eslint-disable-next-line no-underscore-dangle -- MCP defines the wire field as _meta.
  const usage = data?.usage || data?.result?.usage || data?.result?._meta?.usage;
  const values = {
    inputTokens: number(usage?.input_tokens ?? usage?.prompt_tokens),
    outputTokens: number(usage?.output_tokens ?? usage?.completion_tokens),
    cachedTokens: number(
      usage?.input_tokens_details?.cached_tokens ??
        usage?.prompt_tokens_details?.cached_tokens ??
        usage?.prompt_cache_hit_tokens ??
        usage?.cache_read_input_tokens
    ),
    reasoningTokens: number(
      usage?.output_tokens_details?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens
    ),
    searchCredits: number(usage?.credits, false)
  };
  return { ...values, usageReported: Object.values(values).some(value => value !== null) };
}
function responseFailure(data: ProviderResponse): string | null {
  if (data?.error || data?.result?.isError) return "PROVIDER_REPORTED_ERROR";
  if (data?.status === "failed" || data?.status === "cancelled") return "MODEL_OUTPUT_INCOMPLETE";
  if (
    data?.status === "incomplete" ||
    data?.stop_reason === "max_tokens" ||
    data?.choices?.[0]?.finish_reason === "length"
  )
    return "MODEL_OUTPUT_TRUNCATED";
  return null;
}
export async function meterProviderRequest<T extends { data: ProviderResponse }>(
  metadata: AiRequestMetadata | undefined,
  work: () => Promise<T>
): Promise<T> {
  const context = runtime.getStore();
  if (!context || !metadata) return await work();
  await context.checkActive?.();
  const admission = await context.admit?.(metadata);
  try {
    const request = { ...metadata };
    delete request.reserveTokens;
    const start = Date.now();
    let result: T;
    let failure: unknown;
    try {
      result = await work();
    } catch (error) {
      failure = error;
    }
    const errorCode = failure
      ? failure instanceof AiError
        ? failure.code
        : "PROVIDER_NETWORK_ERROR"
      : responseFailure(result?.data);
    const response = result?.data;
    const responseObject = typeof response?.id === "string" && response?.object === "response";
    await context.record(
      {
        ...request,
        model: (metadata.model || "").slice(0, 200),
        success: !errorCode,
        errorCode,
        elapsedMs: Math.max(0, Date.now() - start),
        ...extractUsage(response),
        responseId:
          responseObject && ["completed", "incomplete", "failed"].includes(response.status) ? response.id : undefined,
        pendingResponseId:
          responseObject && ["queued", "in_progress"].includes(response.status) ? response.id : undefined
      },
      admission?.reservationId
    );
    if (failure) throw failure;
    return result;
  } finally {
    admission?.release();
  }
}
