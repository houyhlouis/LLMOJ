import { AiError, LlmConfiguration } from "./ai.types";

export const MAX_CONFIGURED_OUTPUT_TOKENS = 1000000;
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 393216;
const DEEPSEEK_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Validate the actual generation budget before making a paid call. */
export function validateLlmConfiguration(config: LlmConfiguration): void {
  if (config.responsesRecovery != null && !["auto", "off", "background"].includes(config.responsesRecovery))
    throw new AiError("INVALID_RESPONSES_RECOVERY");
  const maxTokens = config.maxTokens ?? 16384;
  if (!Number.isInteger(maxTokens) || maxTokens < 512 || maxTokens > MAX_CONFIGURED_OUTPUT_TOKENS)
    throw new AiError("INVALID_MAX_TOKENS");
  let host: string;
  try {
    host = new URL(config.baseUrl).hostname;
  } catch {
    throw new AiError("INVALID_BASE_URL");
  }
  if (host === "api.deepseek.com") {
    if (config.type === "responses" && config.responsesRecovery === "background")
      throw new AiError("RESPONSES_RECOVERY_UNSUPPORTED");
    // https://api-docs.deepseek.com/api/create-chat-completion/ — 384K = 393216, including reasoning.
    if (maxTokens > DEEPSEEK_MAX_OUTPUT_TOKENS)
      throw new AiError("DEEPSEEK_MAX_OUTPUT_TOKENS", String(DEEPSEEK_MAX_OUTPUT_TOKENS));
    if (config.reasoning?.trim() && !DEEPSEEK_EFFORTS.includes(config.reasoning.trim()))
      throw new AiError("INVALID_DEEPSEEK_REASONING");
  }
}

/** Accept a requested budget when saving and cap it to the provider's output limit. */
export function normalizeLlmConfiguration(config: LlmConfiguration): LlmConfiguration {
  const normalized = { ...config };
  const maxTokens = config.maxTokens ?? 16384;
  if (!Number.isInteger(maxTokens) || maxTokens < 512 || maxTokens > MAX_CONFIGURED_OUTPUT_TOKENS)
    throw new AiError("INVALID_MAX_TOKENS");
  let host: string;
  try {
    host = new URL(config.baseUrl).hostname;
  } catch {
    throw new AiError("INVALID_BASE_URL");
  }
  normalized.maxTokens = host === "api.deepseek.com" ? Math.min(maxTokens, DEEPSEEK_MAX_OUTPUT_TOKENS) : maxTokens;
  validateLlmConfiguration(normalized);
  return normalized;
}
