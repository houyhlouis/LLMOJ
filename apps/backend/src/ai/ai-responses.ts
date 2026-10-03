import { createHash } from "crypto";

import { currentAiRuntime, waitForAiDelay } from "./ai-runtime";
import { AiError, LlmConfiguration } from "./ai.types";
import type { ProviderResponse } from "./ai-provider";

/** Known capability, not inferred from an endpoint merely accepting the Responses wire format. */
export function responsesRecoveryEnabled(config: LlmConfiguration): boolean {
  if (config.type !== "responses" || config.responsesRecovery === "off") return false;
  const { hostname } = new URL(config.baseUrl);
  if (hostname === "api.deepseek.com") {
    if (config.responsesRecovery === "background") throw new AiError("RESPONSES_RECOVERY_UNSUPPORTED");
    return false;
  }
  return config.responsesRecovery === "background" || hostname === "api.openai.com";
}
export async function recoverableResponse(
  config: LlmConfiguration,
  body: Record<string, unknown>,
  request: (suffix: string, body: Record<string, unknown> | undefined, operation: string) => Promise<ProviderResponse>,
  options: { pollMs?: number; recoveryWindowMs?: number; timeoutMs?: number } = {}
) {
  const context = currentAiRuntime();
  // Include a one-way key binding so credential rotation cannot reuse another account's handle.
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ baseUrl: config.baseUrl, key: config.apiKey, body }))
    .digest("hex");
  let checkpoint = await context?.loadResponse?.(requestHash);
  const timeoutMs = options.timeoutMs ?? 1800000;
  const pollMs = options.pollMs ?? 2000;
  const recoveryWindowMs = options.recoveryWindowMs ?? 120000;
  let response: ProviderResponse;
  if (!checkpoint) {
    // Do not repeat POST when its acknowledgement is lost: the first call might already be billed.
    response = await request("", { ...body, background: true, store: false }, "generate");
    if (!response || typeof response.id !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(response.id))
      throw new AiError("INVALID_PROVIDER_RESPONSE");
    checkpoint = { responseId: response.id, createdAt: Date.now() };
    await context?.saveResponse?.(requestHash, checkpoint);
  }
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(checkpoint.responseId)) throw new AiError("INVALID_PROVIDER_RESPONSE");
  const deadline = checkpoint.createdAt + timeoutMs;
  let unavailableSince = 0;
  let attempts = 0;
  while (!response || ["queued", "in_progress"].includes(response.status)) {
    // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
    await context?.checkActive?.();
    if (Date.now() >= deadline) throw new AiError("PROVIDER_TIMEOUT");
    // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
    if (response || attempts) await waitForAiDelay(Math.min(pollMs * Math.max(1, attempts), 10000));
    try {
      // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
      response = await request(`/${encodeURIComponent(checkpoint.responseId)}`, undefined, "responses.poll");
      if (!response || response.id !== checkpoint.responseId) throw new AiError("INVALID_PROVIDER_RESPONSE");
      unavailableSince = 0;
      attempts = 0;
    } catch (error) {
      if (error instanceof AiError && error.code === "PROVIDER_HTTP_ERROR" && /:\s*(404|410)$/.test(error.message))
        throw new AiError("RESPONSE_RECOVERY_EXPIRED");
      const transient =
        error instanceof AiError &&
        (["PROVIDER_NETWORK_ERROR", "PROVIDER_TIMEOUT"].includes(error.code) ||
          (error.code === "PROVIDER_HTTP_ERROR" && /:\s*(408|429|50[0234])$/.test(error.message)));
      if (!transient) throw error;
      unavailableSince ||= Date.now();
      if (Date.now() - unavailableSince >= recoveryWindowMs) throw new AiError("RESPONSE_RECOVERY_INTERRUPTED");
      attempts++;
      response = undefined;
    }
  }
  return response;
}
