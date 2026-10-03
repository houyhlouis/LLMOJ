import http from "http";
import https from "https";
import { promises as dns } from "dns";
import { isIP } from "net";

import { AiError, LlmConfiguration, SearchConfiguration } from "./ai.types";
import {
  meterProviderRequest,
  AiRequestMetadata,
  currentAiRuntime,
  awaitAiActive,
  aiCancellationError
} from "./ai-runtime";
import { recoverableResponse, responsesRecoveryEnabled } from "./ai-responses";
import { validateLlmConfiguration } from "./ai-validation";

export interface ProviderUsage {
  input_tokens?: unknown;
  prompt_tokens?: unknown;
  output_tokens?: unknown;
  completion_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown };
  prompt_tokens_details?: { cached_tokens?: unknown };
  output_tokens_details?: { reasoning_tokens?: unknown };
  completion_tokens_details?: { reasoning_tokens?: unknown };
  prompt_cache_hit_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  credits?: unknown;
}
export interface ProviderResponse {
  id?: string;
  object?: string;
  status?: string;
  error?: unknown;
  stop_reason?: string;
  results?: Array<{ title?: string; url?: string; content?: unknown }>;
  usage?: ProviderUsage;
  data?: Array<{ id?: string }>;
  has_more?: boolean;
  last_id?: string;
  incomplete_details?: { reason?: string };
  output_text?: string;
  content?: Array<{ type?: string; text?: string }>;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  result?: {
    usage?: ProviderUsage;
    _meta?: { usage?: ProviderUsage };
    isError?: boolean;
    protocolVersion?: string;
    tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
    content?: unknown;
  };
}

function privateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value.includes(":")) {
    if (value.startsWith("::ffff:")) return privateAddress(value.slice(7));
    return value === "::" || value === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(value) || !/^[23]/.test(value);
  }
  const [a, b] = value.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** A URL may never contain a secret. Keys are added to the outgoing request only. */
export function validateBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AiError("INVALID_BASE_URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new AiError("INVALID_BASE_URL");
  return url;
}

/** Both non-streaming blank-line keepalives and SSE comments are valid provider traffic. */
export function parseProviderResponse(text: string, contentType: string): ProviderResponse | null {
  if (!contentType.toLowerCase().includes("text/event-stream")) return text.trim() ? JSON.parse(text) : null;
  const events = text
    .split(/\r?\n\r?\n/)
    .map(event => {
      const lines = event.split(/\r?\n/);
      const data = lines
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data || data === "[DONE]") return null;
      const value = JSON.parse(data);
      const type =
        value.type ||
        lines
          .find(line => line.startsWith("event:"))
          ?.slice(6)
          .trim();
      return { type, value };
    })
    .filter(Boolean);
  const terminal = events
    .filter(event => ["response.completed", "response.incomplete", "response.failed"].includes(event.type))
    .pop();
  if (terminal) {
    if (!terminal.value.response || typeof terminal.value.response !== "object")
      throw new AiError("INVALID_PROVIDER_RESPONSE");
    return { ...terminal.value.response, status: terminal.type.slice("response.".length) };
  }
  if (events.some(event => String(event.type).startsWith("response."))) throw new AiError("MODEL_OUTPUT_INCOMPLETE");
  // MCP is JSON-RPC over SSE. Notifications and keepalive comments are not the RPC result.
  return events.filter(event => event.value.jsonrpc === "2.0" && event.value.id != null).pop()?.value || null;
}

async function rawProviderRequest(
  urlText: string,
  headers: Record<string, string>,
  body: unknown,
  timeout: number
): Promise<{ data: ProviderResponse | null; headers: http.IncomingHttpHeaders }> {
  const signal = currentAiRuntime()?.signal;
  if (signal?.aborted) throw aiCancellationError(signal);
  const url = new URL(urlText);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const allowed = (process.env.HYHOJ_AI_PRIVATE_HOSTS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await awaitAiActive(
        dns.lookup(hostname, { all: true }).catch(() => {
          throw new AiError("PROVIDER_NETWORK_ERROR");
        }),
        signal
      );
  if (signal?.aborted) throw aiCancellationError(signal);
  if (!records.length || (!allowed.includes(hostname) && records.some(x => privateAddress(x.address))))
    throw new AiError("PRIVATE_ENDPOINT_BLOCKED");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowed.includes(hostname)))
    throw new AiError("HTTPS_REQUIRED");
  const data = body === undefined ? null : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        signal,
        method: data === null ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          ...headers,
          ...(data === null
            ? {}
            : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data).toString() })
        },
        lookup: (_name, options, cb) => {
          if ((options as { all?: boolean }).all)
            (cb as unknown as (error: Error | null, addresses: Array<{ address: string; family: number }>) => void)(
              null,
              records.map(record => ({ address: record.address, family: record.family }))
            );
          else cb(null, records[0].address, records[0].family);
        }
      },
      response => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) req.destroy(new AiError("PROVIDER_RESPONSE_TOO_LARGE"));
          else chunks.push(chunk);
        });
        response.on("error", () =>
          reject(signal?.aborted ? aiCancellationError(signal) : new AiError("PROVIDER_NETWORK_ERROR"))
        );
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new AiError("PROVIDER_HTTP_ERROR", String(response.statusCode)));
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed = parseProviderResponse(text, response.headers["content-type"] || "");
            resolve({ data: parsed, headers: response.headers });
          } catch (error) {
            reject(error instanceof AiError ? error : new AiError("INVALID_PROVIDER_RESPONSE"));
          }
        });
      }
    );
    const timer = setTimeout(() => req.destroy(new AiError("PROVIDER_TIMEOUT")), timeout);
    req.on("close", () => clearTimeout(timer));
    req.on("error", error =>
      reject(
        signal?.aborted
          ? aiCancellationError(signal)
          : error instanceof AiError
          ? error
          : new AiError("PROVIDER_NETWORK_ERROR")
      )
    );
    if (data !== null) req.write(data);
    req.end();
  });
}

/** DNS is checked and pinned for each request; redirects are intentionally not followed. */
export async function providerRequest(
  urlText: string,
  headers: Record<string, string>,
  body?: unknown,
  timeout?: number,
  metadata?: AiRequestMetadata
): Promise<{ data: ProviderResponse | null; headers: http.IncomingHttpHeaders }> {
  return await meterProviderRequest(metadata, () => rawProviderRequest(urlText, headers, body, timeout ?? 300000));
}

function endpoint(baseUrl: string, path: string) {
  return `${validateBaseUrl(baseUrl).toString().replace(/\/$/, "")}/${path}`;
}
function authorization(config: LlmConfiguration) {
  if (!config.apiKey) throw new AiError("LLM_NOT_CONFIGURED");
  return config.type === "anthropic"
    ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${config.apiKey}` };
}
export async function listModels(config: LlmConfiguration): Promise<string[]> {
  const result: string[] = [];
  let after = "";
  for (let page = 0; page < 20; page++) {
    const url = endpoint(config.baseUrl, "models") + (after ? `?after_id=${encodeURIComponent(after)}` : "");
    // eslint-disable-next-line no-await-in-loop -- Each step depends on prior results, cancellation checks, or retry state.
    const { data } = await providerRequest(url, authorization(config), undefined, 30000, {
      target: "llm",
      provider: config.type,
      host: new URL(config.baseUrl).hostname,
      model: config.model,
      operation: "models"
    });
    if (!Array.isArray(data?.data)) throw new AiError("MODEL_DISCOVERY_UNSUPPORTED");
    for (const model of data.data) if (typeof model.id === "string") result.push(model.id);
    if (config.type !== "anthropic" || !data.has_more || !data.last_id) break;
    after = data.last_id;
  }
  return [...new Set(result)].sort();
}
export async function generateText(
  config: LlmConfiguration,
  system: string,
  prompt: string,
  image?: string
): Promise<string> {
  if (!config.model) throw new AiError("MODEL_NOT_CONFIGURED");
  validateLlmConfiguration(config);
  const headers = authorization(config);
  const effort = config.reasoning?.trim();
  const maxTokens = config.maxTokens || 16384;
  let body: Record<string, unknown>;
  let path: string;
  if (config.type === "anthropic") {
    const content: Record<string, unknown>[] = [{ type: "text", text: prompt }];
    if (image) {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image);
      if (!match) throw new AiError("INVALID_IMAGE");
      content.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
    }
    body = { model: config.model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] };
    if (effort && effort !== "none") {
      if (/^\d+$/.test(effort)) {
        const budget = Number(effort);
        if (budget < 1024 || budget >= maxTokens) throw new AiError("INVALID_REASONING_BUDGET");
        body.thinking = { type: "enabled", budget_tokens: budget };
      } else {
        body.thinking = { type: "adaptive" };
        body.output_config = { effort };
      }
    }
    path = "messages";
  } else if (config.type === "responses") {
    body = {
      model: config.model,
      instructions: system,
      store: false,
      max_output_tokens: maxTokens,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }, ...(image ? [{ type: "input_image", image_url: image }] : [])]
        }
      ]
    };
    if (effort) body.reasoning = { effort };
    path = "responses";
  } else {
    body = {
      model: config.model,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: image
            ? [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: image } }
              ]
            : prompt
        }
      ]
    };
    // Reasoning models use max_completion_tokens; classic compatible services use max_tokens.
    const openai = new URL(config.baseUrl).hostname === "api.openai.com";
    body[openai ? "max_completion_tokens" : "max_tokens"] = maxTokens;
    if (effort) {
      const host = new URL(config.baseUrl).hostname;
      if (host === "api.deepseek.com") {
        body.thinking = { type: effort === "none" ? "disabled" : "enabled" };
        if (effort !== "none") body.reasoning_effort = effort;
      } else if (host.endsWith("dashscope.aliyuncs.com")) {
        body.enable_thinking = effort !== "none";
        if (/^\d+$/.test(effort)) body.thinking_budget = Number(effort);
      } else if (host === "openrouter.ai") {
        body.reasoning = effort === "none" ? { enabled: false } : { effort };
      } else body.reasoning_effort = effort;
    }
    path = "chat/completions";
  }
  // High-effort generations can run beyond the old five-minute deadline. Search/model discovery keep their shorter limits.
  const request = async (suffix: string, payload: unknown, operation: string) => {
    const result = await providerRequest(
      endpoint(config.baseUrl, path) + suffix,
      headers,
      payload,
      operation === "responses.poll" ? 30000 : 1800000,
      { target: "llm", provider: config.type, host: new URL(config.baseUrl).hostname, model: config.model, operation }
    );
    return result.data;
  };
  const data = responsesRecoveryEnabled(config)
    ? await recoverableResponse(config, body, request)
    : await request("", body, "generate");
  let text: string;
  if (config.type === "anthropic") {
    if (data?.stop_reason === "max_tokens") throw new AiError("MODEL_OUTPUT_TRUNCATED");
    text = data?.content
      ?.filter(x => x.type === "text")
      .map(x => x.text)
      .join("\n");
  } else if (config.type === "responses") {
    if (data?.status === "incomplete" && data?.incomplete_details?.reason === "max_output_tokens")
      throw new AiError("MODEL_OUTPUT_TRUNCATED");
    if (["incomplete", "failed", "cancelled", "in_progress", "queued"].includes(data?.status) || data?.error)
      throw new AiError("MODEL_OUTPUT_INCOMPLETE");
    text =
      data?.output_text ||
      data?.output
        ?.flatMap(x => x.content || [])
        .filter(x => x.type === "output_text")
        .map(x => x.text)
        .join("\n");
  } else {
    if (data?.choices?.[0]?.finish_reason === "length") throw new AiError("MODEL_OUTPUT_TRUNCATED");
    text = data?.choices?.[0]?.message?.content;
  }
  if (typeof text !== "string" || !text.trim()) throw new AiError("EMPTY_MODEL_OUTPUT");
  return text;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Legacy model callers validate different JSON schemas after parsing; retain this compatibility boundary.
export function parseModelJson(text: string): any {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AiError("INVALID_MODEL_JSON");
  }
}
export async function searchWeb(config: SearchConfiguration, query: string): Promise<string> {
  if (!config.apiKey) throw new AiError("SEARCH_NOT_CONFIGURED");
  if (config.type === "tavily") {
    const { data } = await providerRequest(
      endpoint(config.baseUrl, "search"),
      { Authorization: `Bearer ${config.apiKey}` },
      {
        query: query.slice(0, 400),
        max_results: 5,
        search_depth: "advanced",
        include_answer: false,
        include_usage: true
      },
      60000,
      { target: "search", provider: "tavily", host: new URL(config.baseUrl).hostname, operation: "search" }
    );
    if (!Array.isArray(data?.results)) throw new AiError("INVALID_SEARCH_RESPONSE");
    return JSON.stringify(
      data.results.map(x => ({ title: x.title, url: x.url, content: String(x.content).slice(0, 6000) }))
    );
  }
  const url = validateBaseUrl(config.baseUrl);
  // Tavily's hosted MCP authenticates via its documented query parameter; never return it to clients.
  if (url.hostname === "mcp.tavily.com") url.searchParams.set("tavilyApiKey", config.apiKey);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json, text/event-stream"
  };
  let nextId = 0;
  const rpc = async (method: string, params: unknown, notification = false) => {
    const response = await providerRequest(
      url.toString(),
      headers,
      { jsonrpc: "2.0", ...(notification ? {} : { id: ++nextId }), method, params },
      60000,
      { target: "search", provider: "mcp", host: url.hostname, operation: method }
    );
    if (response.headers["mcp-session-id"]) headers["Mcp-Session-Id"] = String(response.headers["mcp-session-id"]);
    if (response.data?.error) throw new AiError("MCP_ERROR");
    return response.data?.result;
  };
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "LLMOJ", version: "1.0" }
  });
  headers["MCP-Protocol-Version"] = initialized?.protocolVersion || "2025-03-26";
  await rpc("notifications/initialized", {}, true);
  const available = await rpc("tools/list", {});
  const tool = config.tool
    ? available?.tools?.find(x => x.name === config.tool)
    : available?.tools?.find(x => /search/i.test(x.name));
  if (!tool) throw new AiError("MCP_SEARCH_TOOL_NOT_FOUND");
  const properties = tool.inputSchema?.properties || {};
  const queryKey =
    "query" in properties ? "query" : "search_query" in properties ? "search_query" : "q" in properties ? "q" : "query";
  const args: Record<string, unknown> = { [queryKey]: query.slice(0, 400) };
  if ("max_results" in properties) args.max_results = 5;
  const result = await rpc("tools/call", { name: tool.name, arguments: args });
  if (result?.isError) throw new AiError("MCP_SEARCH_FAILED");
  return JSON.stringify(result?.content || result).slice(0, 40000);
}
