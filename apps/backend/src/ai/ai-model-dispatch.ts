import { AsyncLocalStorage } from "async_hooks";

import type { LlmConfiguration } from "./ai.types";
import type { AiResponseCheckpoint } from "./ai-runtime";

export interface AiModelOutput {
  name: string;
  schema: Record<string, unknown>;
}
export interface AiModelDispatch {
  stageId: string;
  generationId: string;
  /** A lifetime-budgeted repair may only resume its original generation. */
  requiredGenerationId?: string;
  output?: AiModelOutput;
  /** Called after the durable identity is claimed/recovered and before transport. */
  bindIdentity?: (identity: AiResponseCheckpoint) => Promise<void>;
}
export const dispatch = new AsyncLocalStorage<AiModelDispatch>();
export const currentModelDispatch = () => dispatch.getStore();

export function structuredOutputBody(config: LlmConfiguration, output?: AiModelOutput): Record<string, unknown> {
  if (!output || config.structuredOutput !== "json_schema" || config.type === "anthropic") return {};
  const spec = { name: output.name, schema: output.schema, strict: true };
  return config.type === "responses"
    ? { text: { format: { type: "json_schema", ...spec } } }
    : { response_format: { type: "json_schema", json_schema: spec } };
}
