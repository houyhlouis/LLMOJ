export interface LlmConfiguration {
  type: "chat" | "responses" | "anthropic";
  baseUrl: string;
  apiKey?: string;
  model: string;
  reasoning?: string;
  maxTokens?: number;
  responsesRecovery?: "auto" | "off" | "background";
}
export interface SearchConfiguration {
  type: "tavily" | "mcp";
  baseUrl: string;
  apiKey?: string;
  tool?: string;
}
export interface AiConfiguration {
  llm: LlmConfiguration;
  search: SearchConfiguration;
  autoOnSave: boolean;
  maxConcurrentJobs?: number;
}
export const defaultConfiguration: AiConfiguration = {
  llm: { type: "chat", baseUrl: "https://api.openai.com/v1", model: "", reasoning: "", maxTokens: 16384 },
  search: { type: "tavily", baseUrl: "https://api.tavily.com", tool: "" },
  maxConcurrentJobs: 3,
  autoOnSave: false
};
export const providerPresets = [
  { name: "OpenAI", type: "responses", baseUrl: "https://api.openai.com/v1" },
  { name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { name: "DeepSeek", type: "chat", baseUrl: "https://api.deepseek.com/v1" },
  { name: "Google Gemini", type: "chat", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { name: "Groq", type: "chat", baseUrl: "https://api.groq.com/openai/v1" },
  { name: "Mistral", type: "chat", baseUrl: "https://api.mistral.ai/v1" },
  { name: "OpenRouter", type: "chat", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "SiliconFlow", type: "chat", baseUrl: "https://api.siliconflow.cn/v1" },
  { name: "Alibaba Cloud / 阿里云百炼", type: "chat", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "Moonshot / 月之暗面", type: "chat", baseUrl: "https://api.moonshot.cn/v1" }
];
/** Statement fields consumed by AI evidence helpers; extra editor fields are preserved by callers. */
export interface AiStatementText {
  locale?: string;
  title?: string;
  contentSections?: Array<{ type?: string; sectionTitle?: string; text?: string }>;
}

export class AiError extends Error {
  candidateFailure?: boolean;

  constructor(public code: string, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
  }
}
