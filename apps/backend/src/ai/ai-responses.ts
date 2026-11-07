import { createHash, randomUUID } from "crypto";

import { AiResponseCheckpoint, currentAiPurpose, currentAiRuntime, waitForAiDelay } from "./ai-runtime";
import { AiError, LlmConfiguration } from "./ai.types";
import type { ProviderResponse } from "./ai-provider";
import { currentModelDispatch } from "./ai-model-dispatch";

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
export function providerBindingHash(config: LlmConfiguration): string {
  return createHash("sha256")
    .update(JSON.stringify([config.type, config.baseUrl, config.apiKey]))
    .digest("hex");
}

export async function recoverableResponse(
  config: LlmConfiguration,
  body: Record<string, unknown>,
  request: (
    suffix: string,
    body: Record<string, unknown> | undefined,
    operation: string,
    identity?: {
      generationId?: string;
      purpose?: string;
      stageId?: string;
      accountBinding?: string;
      requestAttempt: number;
    }
  ) => Promise<ProviderResponse>,
  options: { pollMs?: number; recoveryWindowMs?: number; timeoutMs?: number; background?: boolean } = {}
) {
  const context = currentAiRuntime();
  const purpose = currentAiPurpose()?.slice(0, 20);
  const dispatch = currentModelDispatch();
  const stageId = dispatch?.stageId ?? context?.stageId?.();
  // Include a one-way key binding so credential rotation cannot reuse another account's handle.
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ baseUrl: config.baseUrl, key: config.apiKey, body }))
    .digest("hex");
  let checkpoint = await context?.loadResponse?.(requestHash);
  if (dispatch?.requiredGenerationId && checkpoint?.generationId !== dispatch.requiredGenerationId)
    throw new AiError(
      "AI_PLAN_REPAIR_EXHAUSTED",
      "The original field-repair request cannot be recovered under this configuration"
    );
  let fresh = !checkpoint;
  if (!checkpoint) {
    checkpoint = {
      responseId: "",
      createdAt: Date.now(),
      generationId: dispatch?.generationId || randomUUID(),
      purpose,
      requestAttempts: 0,
      stageId,
      bindingHash: providerBindingHash(config),
      lifecycle: "dispatching"
    };
    // Write intent before a request can leave the process. No request/response text is retained.
    if (context?.claimResponse) {
      const claim = await context.claimResponse(requestHash, checkpoint);
      checkpoint = claim.checkpoint;
      fresh = claim.created;
    } else await context?.saveResponse?.(requestHash, checkpoint);
  }
  if (dispatch) {
    // Recovery always uses the original identity, including an honestly unlinked legacy handle.
    dispatch.stageId = checkpoint.stageId;
    dispatch.generationId = checkpoint.generationId;
    await dispatch.bindIdentity?.(checkpoint);
  }
  const background = !!checkpoint.responseId || options.background !== false;
  if (checkpoint.lifecycle === "prepared" && !checkpoint.responseId) {
    fresh = true;
    checkpoint.lifecycle = "dispatching";
    checkpoint.createdAt = Date.now();
  }
  if (!fresh && !checkpoint.responseId && checkpoint.lifecycle === "terminal")
    throw new AiError("PROVIDER_RESULT_UNRECOVERABLE");
  if (!fresh && !checkpoint.responseId) {
    // A crash/lost acknowledgement may have left paid work running. Only explicit retry may start fresh work.
    throw new AiError("PROVIDER_ACKNOWLEDGEMENT_UNKNOWN");
  }
  const saved: AiResponseCheckpoint = checkpoint;
  const send = async (suffix: string, payload: Record<string, unknown> | undefined, operation: string) => {
    saved.requestAttempts = context?.nextResponseAttempt
      ? await context.nextResponseAttempt(requestHash)
      : (saved.requestAttempts || 0) + 1;
    await context?.saveResponse?.(requestHash, { ...saved });
    return await request(suffix, payload, operation, {
      generationId: saved.generationId,
      purpose: saved.generationId ? saved.purpose : null,
      stageId: saved.stageId ?? null,
      accountBinding: saved.bindingHash || undefined,
      requestAttempt: saved.requestAttempts
    });
  };
  const timeoutMs = options.timeoutMs ?? 1800000;
  const pollMs = options.pollMs ?? 2000;
  const recoveryWindowMs = options.recoveryWindowMs ?? 120000;
  let response: ProviderResponse;
  if (fresh) {
    try {
      response = await send("", background ? { ...body, background: true, store: false } : body, "generate");
    } catch (error) {
      // These admission failures occur before provider transport starts; unlike a lost acknowledgement they are safe to resume.
      if (
        error instanceof AiError &&
        ["AI_PAUSED", "AI_BUSY", "AI_REQUEST_EXCEEDS_BUDGET", "AI_BUDGET_EXCEEDED", "AI_JOB_REQUEST_LIMIT"].includes(
          error.code
        )
      ) {
        saved.lifecycle = "prepared";
        await context?.saveResponse?.(requestHash, { ...saved });
      }
      throw error;
    }
    if (background && (!response || typeof response.id !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(response.id)))
      throw new AiError("INVALID_PROVIDER_RESPONSE");
    saved.responseId = background ? response.id : "";
    saved.lifecycle = background ? "pending" : "terminal";
    saved.terminalStatus = background ? undefined : "completed";
    await context?.saveResponse?.(requestHash, { ...saved });
  }
  if (!background) return response;
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
      response = await send(`/${encodeURIComponent(checkpoint.responseId)}`, undefined, "responses.poll");
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
  saved.lifecycle = "terminal";
  saved.terminalStatus = response.status?.slice(0, 20);
  await context?.saveResponse?.(requestHash, { ...saved });
  return response;
}
