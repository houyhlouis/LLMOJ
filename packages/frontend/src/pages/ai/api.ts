import { callApiWithFileUpload, FileUploadApiProgress } from "@/utils/callApiWithFileUpload";
import axios from "axios";
import { appState } from "@/appState";
export const aiText = (zh: string, en: string) => (appState.locale === "zh_CN" ? zh : en);
const errors: Record<string, [string, string]> = {
  INVALID_ATTACHMENT_TOKEN: [
    "附加文件上传凭据已失效，请重新选择并上传压缩包。",
    "The attachment upload token is invalid or expired. Select and upload the ZIP again."
  ],
  ATTACHMENT_SIZE_LIMIT: ["附加文件 ZIP 不能超过 64 MiB。", "Attachment ZIP archives must not exceed 64 MiB."],
  ATTACHMENT_SIZE_MISMATCH: [
    "附加文件上传大小不匹配，请重新上传。",
    "The uploaded attachment size does not match. Upload it again."
  ],
  HIDDEN_SAMPLE_FILE_MISSING: [
    "附加大样例的输入或输出文件缺失，请检查压缩包。",
    "A large sample's input or output file is missing. Check the archive."
  ],
  SAMPLE_SIZE_LIMIT: [
    "样例文件超出大小限制，请检查附加样例。",
    "Sample files exceed the size limit. Check the attached samples."
  ],
  INVALID_AI_CONCURRENCY: [
    "最大并行任务数须为 1–8 的整数。",
    "Maximum concurrent jobs must be an integer from 1 to 8."
  ],
  INVALID_USAGE_PERIOD: ["统计周期须为 1–366 天。", "The usage period must be from 1 to 366 days."],
  INVALID_RESPONSES_RECOVERY: ["请选择有效的断线恢复模式。", "Choose a valid connection recovery mode."],
  RESPONSES_RECOVERY_UNSUPPORTED: [
    "此服务商不支持后台响应恢复；请使用自动或关闭模式。",
    "This provider does not support background response recovery. Choose Automatic or Off."
  ],
  RESPONSE_RECOVERY_EXPIRED: [
    "服务商保存的响应已过期，无法继续恢复。",
    "The provider's saved response has expired and can no longer be recovered."
  ],
  RESPONSE_RECOVERY_INTERRUPTED: [
    "暂时无法恢复连接，任务已保存响应 ID；网络恢复后可以重试继续获取结果。",
    "The connection could not be recovered yet. The response ID was saved; retry after the network recovers to retrieve the result."
  ],
  INVALID_MAX_TOKENS: [
    "输出 token 上限必须为 512 至 1000000 的整数。",
    "Maximum output tokens must be an integer between 512 and 1000000."
  ],
  DEEPSEEK_MAX_OUTPUT_TOKENS: [
    "DeepSeek 的输出 token 上限为 393216（384K）；1M 是上下文长度，不能作为输出上限。",
    "DeepSeek allows at most 393216 (384K) output tokens. 1M is the context window, not the output limit."
  ],
  INVALID_DEEPSEEK_REASONING: [
    "DeepSeek 推理强度无效，请填写 none、minimal、low、medium、high、xhigh、max 或 ultra。",
    "Invalid DeepSeek reasoning effort. Use none, minimal, low, medium, high, xhigh, max or ultra."
  ],
  INVALID_IMPORT_TARGET: [
    "导入任务必须创建新题目，不能指定已有题目。",
    "Import creates a new problem; an existing problem ID is not allowed."
  ],
  GENERATOR_FILENAME_CONFLICT: [
    "已有附加源码正在使用 make.cpp、std.cpp、validator.cpp 或 data.yaml，请先重命名冲突文件。",
    "Existing extra source files use make.cpp, std.cpp, validator.cpp or data.yaml. Rename the conflicting file first."
  ],
  NO_SUCH_PROBLEM: ["题目不存在。", "The problem does not exist."],
  NO_SUCH_JOB: ["任务不存在。", "The job does not exist."],
  JOB_NOT_FAILED: ["只有失败的任务可以重试。", "Only failed jobs can be retried."],
  JOB_CANCELLED: ["任务已取消。", "The job was cancelled."],
  EMPTY_MODEL_OUTPUT: ["模型没有返回有效内容。", "The model returned no content."],
  INVALID_PROVIDER_RESPONSE: ["服务商返回的响应格式无效。", "The provider returned an invalid response."],
  INVALID_SEARCH_RESPONSE: ["搜索服务返回的格式无效。", "The search service returned an invalid response."],
  MCP_ERROR: ["MCP 协议请求失败。", "The MCP protocol request failed."],
  MCP_SEARCH_FAILED: ["MCP 搜索执行失败。", "The MCP search failed."],
  MCP_SEARCH_TOOL_NOT_FOUND: ["没有找到可用的 MCP 搜索工具。", "No usable MCP search tool was found."],
  MODEL_OUTPUT_INCOMPLETE: ["模型未能完整生成结果，请重试。", "The model did not complete the result. Please retry."],
  PROVIDER_RESPONSE_TOO_LARGE: ["服务商的响应超过大小限制。", "The provider response exceeds the size limit."],
  CREATE_PROBLEM_FAILED: ["创建题目失败。", "Problem creation failed."],
  INCOMPLETE_TESTDATA: ["沙箱没有生成完整的输入输出文件。", "The sandbox did not produce all input/output files."],
  INVALID_AI_DIFFICULTY: ["AI 返回的 CF 难度格式无效。", "The AI returned an invalid Codeforces rating."],
  INVALID_AI_RESOURCE_LIMITS: ["AI 返回的时间或内存限制无效。", "The AI returned invalid time or memory limits."],
  INVALID_AI_SAMPLE: ["AI 返回的样例格式无效。", "The AI returned invalid samples."],
  INVALID_AI_SOURCE: ["AI 返回的原题地址无效。", "The AI returned an invalid original-problem URL."],
  UNREADABLE_STATEMENT: [
    "无法辨认题面内容。请上传文字清晰、显示完整的图片，或直接提供 Markdown 题面。",
    "The problem statement could not be read. Upload a clear image with complete, readable text, or provide the statement as Markdown."
  ],
  INVALID_AI_STATEMENT: [
    "AI 返回的题面结构无效，请核对图片或文字是否清晰。",
    "The AI returned an invalid statement. Check that the image or text is readable."
  ],
  INVALID_AI_TAGS: ["AI 返回的中英标签格式无效。", "The AI returned invalid bilingual tags."],
  INVALID_AI_FILE_IO: ["生成的文件输入输出配置无效。", "The generated file I/O configuration is invalid."],
  UNVERIFIED_AI_FILE_IO: [
    "生成的输入输出文件名与题面声明不一致，请检查题面。",
    "The generated input/output filenames do not match the statement. Please check the statement."
  ],
  INVALID_AI_TRANSLATION: ["AI 返回的翻译格式无效。", "The AI returned an invalid translation."],
  INVALID_AI_TUTORIAL: ["AI 返回的中英题解格式无效。", "The AI returned an invalid bilingual tutorial."],
  INVALID_GENERATED_CODE: ["AI 生成的 C++ 源码无效或过大。", "The generated C++ source is invalid or too large."],
  INVALID_GENERATED_JUDGE_INFO: ["生成的评测配置未通过校验。", "The generated judge configuration failed validation."],
  INVALID_SANDBOX_FILE: ["沙箱产物不符合文件或大小要求。", "A sandbox output failed file or size validation."],
  INVALID_SANDBOX_RESPONSE: [
    "沙箱响应或样例验证结果不完整。",
    "The sandbox response or sample validation is incomplete."
  ],
  INVALID_SUBTASK_SCORES: ["子任务分值之和必须为 100。", "Subtask scores must sum to 100."],
  TEST_COUNT_RATIO_UNREPRESENTABLE: [
    "无法在 1000 个测试点以内按子任务分值精确等分，请调整子任务分值。",
    "The subtask scores cannot be represented by equally weighted tests within 1,000 cases. Adjust the subtask scores."
  ],
  TEST_COUNT_ADJUSTED: [
    "已增加测试点数量，使每个测试点分值相同并符合子任务分值比例。",
    "The test count was increased to preserve equal points per test and the subtask score ratios."
  ],
  INVALID_TEST_COUNT: ["测试数据组数必须为 5 到 1000。", "The number of test cases must be between 5 and 1000."],
  INVALID_TEST_PLAN: ["AI 返回的子任务和数据范围规划无效。", "The AI returned an invalid subtask/constraint plan."],
  PARTIAL_SCORE_CHECKER_NOT_ALLOWED: [
    "SPJ 必须采用通过或失败的二元评分。",
    "The SPJ must use binary pass/fail scoring."
  ],
  SAMPLES_TOO_LARGE: ["样例和源码请求总大小超过 16 MiB。", "Samples and source exceed the 16 MiB request limit."],
  SANDBOX_DISCONNECTED: ["沙箱连接中断，请重试。", "The sandbox disconnected. Please retry."],
  SANDBOX_TIMEOUT: ["生成任务超过沙箱运行时限。", "Generation exceeded the sandbox time limit."],
  TESTDATA_TOO_LARGE: ["生成的数据超过 8 GiB 上限。", "Generated data exceeds the 8 GiB limit."],
  UNVERIFIED_AI_SOURCE: [
    "搜索结果无法验证 AI 返回的原题地址。",
    "Search results do not verify the original-problem URL returned by AI."
  ],
  UPLOAD_GENERATED_FILE_FAILED: ["保存生成的数据文件失败。", "Saving a generated data file failed."],
  PROBLEM_CHANGED_DURING_AI: [
    "题面或评测配置在执行期间发生了修改。任务已停止覆盖，请核对后重试。",
    "The problem changed while AI was running. Updates stopped; review and retry."
  ],
  PERMISSION_DENIED: ["没有执行此操作的权限。", "You do not have permission for this action."],
  LLM_NOT_CONFIGURED: ["请先配置 LLM API Key 和模型。", "Configure an LLM API key and model first."],
  MODEL_NOT_CONFIGURED: ["请先选择或输入模型编号。", "Select or enter a model ID first."],
  SEARCH_NOT_CONFIGURED: [
    "尚未配置搜索服务；原题检索需要搜索 API。",
    "Search is not configured; source discovery requires a search API."
  ],
  PROVIDER_HTTP_ERROR: [
    "服务商拒绝了请求，请检查 API 格式、模型、密钥与推理参数。",
    "The provider rejected the request. Check API format, model, key and reasoning settings."
  ],
  PROVIDER_NETWORK_ERROR: ["无法连接到服务商。", "Unable to connect to the provider."],
  PROVIDER_TIMEOUT: ["服务商请求超时，请稍后重试。", "The provider timed out. Please retry."],
  MODEL_DISCOVERY_UNSUPPORTED: [
    "此服务商不支持模型列表，请手工填写模型编号。",
    "Model discovery is unsupported; enter the model ID manually."
  ],
  PRIVATE_ENDPOINT_BLOCKED: [
    "内网 API 地址需要服务器管理员将主机名加入 HYHOJ_AI_PRIVATE_HOSTS。",
    "A private API host must be allowed by the server administrator in HYHOJ_AI_PRIVATE_HOSTS."
  ],
  HTTPS_REQUIRED: ["请使用 HTTPS API 地址。", "Use an HTTPS API endpoint."],
  INVALID_BASE_URL: [
    "Base URL 必须是有效地址，不能包含密钥、查询参数或用户名密码。",
    "Base URL must be valid and contain no credentials or query parameters."
  ],
  TOO_MANY_ACTIVE_JOBS: [
    "最多同时保留三个执行中或排队的 AI 任务。",
    "You may have at most three active or queued AI jobs."
  ],
  PROBLEM_AI_BUSY: ["此题已有 AI 任务正在执行。", "An AI job is already running for this problem."],
  SANDBOX_UNAVAILABLE: ["评测沙箱暂不可用，请稍后重试。", "The judging sandbox is unavailable. Please retry."],
  SANDBOX_GENERATION_FAILED: [
    "生成程序编译、运行、输入约束或样例验证失败。",
    "Generated code failed compilation, execution, input validation or sample validation."
  ],
  INVALID_MODEL_JSON: [
    "模型返回格式错误，请重试或更换模型。",
    "The model returned invalid JSON. Retry or choose another model."
  ],
  MODEL_OUTPUT_TRUNCATED: [
    "模型输出达到长度上限，请提高输出 token 上限。",
    "Model output was truncated. Increase the output token limit."
  ],
  OUTPUT_CASE_REVIEW_RECOMMENDED: [
    "题面中的大小写要求不明确，已保留 AI 判断，请核对输出格式与判题规则。",
    "The statement does not clearly specify output case rules. The AI decision was kept; review the output format and checker."
  ],
  GENERATED_DATA_REVIEW_RECOMMENDED: [
    "数据已生成并完成可执行验证；仍请审阅约束覆盖和算法正确性。",
    "Data passed executable checks; review constraint coverage and algorithm correctness."
  ],
  AI_PROTOCOL_HELPER_UNSUPPORTED: [
    "当前辅助评测程序的语言或接口不支持 AI 自动生成；请使用受支持的 C++、testlib、标准输入输出协议，或手动配置评测。",
    "The configured judging helper is unsupported by AI generation. Use a supported C++/testlib/stdio protocol or configure judging manually."
  ],
  AI_PROTOCOL_HELPER_MISSING: [
    "已配置的辅助评测程序源文件缺失，请上传文件或修正评测配置。",
    "A configured judging helper source file is missing. Upload it or correct the judge settings."
  ],
  PROTOCOL_ATTACHMENT_SAMPLES_NOT_APPLICABLE: [
    "附件已保留；协议题附件中的输入输出对未被当作可执行交互样例。请通过协议评测验证。",
    "Attachments were preserved. Input/output pairs in protocol-task attachments were not treated as executable interaction samples; validate them through the judging protocol."
  ],
  AI_IMPORT_TYPE_UNSUPPORTED: [
    "AI 导入支持传统题、交互题和通信题；提交答案题请手工创建。",
    "AI import supports traditional, interactive and communication problems. Create output-only tasks manually."
  ],
  AI_PROBLEM_TYPE_MISMATCH: [
    "所选题型或通信方式与题面协议不一致，请检查选择和题面。",
    "The selected problem type or communication mode conflicts with the statement. Check your selection and protocol."
  ],
  INVALID_AI_PROTOCOL: [
    "评测协议不完整或无效，请补充交互规则、通信流程和所需接口文件。",
    "The judging protocol is incomplete or invalid. Provide the interaction rules, communication flow and required interface files."
  ],
  REFERENCE_SAMPLES_UNAVAILABLE: [
    "没有适用样例，当前标程尚未通过样例校验。",
    "No applicable samples are available; the reference solution has not passed sample validation."
  ],
  TUTORIAL_REFERENCE_REJECTED: [
    "现有题解代码未通过编译或样例校验，已回退为独立生成标程。",
    "Existing tutorial code failed compilation or sample validation; an independent reference solution was generated instead."
  ],
  AI_IMPORT_TRADITIONAL_ONLY: [
    "此任务使用的导入流程不支持该题型。请选择传统题、交互题或通信题后重新导入；提交答案题请手工创建。",
    "This job used an import flow that did not support its type. Start a new import as traditional, interactive or communication; create output-only tasks manually."
  ],
  TESTDATA_TRADITIONAL_ONLY: [
    "自动数据生成支持传统题、交互题和通信题；提交答案题请手工配置数据。",
    "Automatic test-data generation supports traditional, interactive and communication problems. Configure output-only data manually."
  ],
  INVALID_REASONING_BUDGET: [
    "Anthropic 数字推理预算须至少为 1024，且小于输出 token 上限。",
    "Anthropic reasoning budget must be at least 1024 and below the output token limit."
  ],
  IMPORT_CONTENT_REQUIRED: ["请上传题面图片或输入 Markdown。", "Upload a problem image or enter Markdown."],
  INVALID_IMAGE: ["请使用 PNG、JPEG、WebP 或 GIF 图片。", "Use PNG, JPEG, WebP or GIF images."],
  INTERNAL_ERROR: [
    "后台任务发生错误，请检查服务器日志或重试。",
    "The background task failed. Check server logs or retry."
  ]
};
export function aiError(value: string) {
  const [code, detail = ""] = String(value || "INTERNAL_ERROR").split(/:\s*/, 2);
  const status = /^\d{3}$/.test(detail) ? Number(detail) : undefined;
  if (code === "PROVIDER_HTTP_ERROR" && status) {
    const messages: Record<number, [string, string]> = {
      400: [
        "服务商拒绝了参数，请检查模型、推理强度与输出 token 上限。",
        "The provider rejected the parameters. Check the model, reasoning effort and output token limit."
      ],
      401: [
        "服务商未接受 API Key，请检查密钥是否正确或已过期。",
        "The provider rejected the API key. Check whether it is correct or expired."
      ],
      402: ["服务商账户余额不足，请检查账户额度。", "The provider account has insufficient credit. Check its balance."],
      403: ["此 API Key 没有访问所选模型或服务的权限。", "This API key cannot access the selected model or service."],
      404: [
        "服务商接口或模型不存在，请检查 Base URL 和模型编号。",
        "The provider endpoint or model was not found. Check the Base URL and model ID."
      ],
      429: [
        "服务商请求过于频繁或额度已用尽，请稍后重试或检查额度。",
        "The provider rate limit or quota was reached. Retry later or check your quota."
      ]
    };
    return aiText(...(messages[status] || errors.PROVIDER_HTTP_ERROR)) + ` (HTTP ${status})`;
  }
  const translation = errors[code];
  // Error payloads can include provider responses. Never render arbitrary text or credentials.
  return translation
    ? aiText(...translation)
    : aiText("AI 操作失败，请重试或检查服务器日志。", "The AI action failed. Retry or check server logs.");
}

function validationError(data: any) {
  const messages: string[] = Array.isArray(data?.message)
    ? data.message.filter(value => typeof value === "string")
    : [];
  const details = messages
    .map(message => {
      if (/^(?:llm\.)?maxTokens\b/.test(message)) {
        const maximum = message.match(/must not be greater than (\d+)$/)?.[1];
        const minimum = message.match(/must not be less than (\d+)$/)?.[1];
        if (maximum)
          return aiText(`输出 token 上限不能超过 ${maximum}。`, `Maximum output tokens must not exceed ${maximum}.`);
        if (minimum)
          return aiText(`输出 token 上限不能小于 ${minimum}。`, `Maximum output tokens must be at least ${minimum}.`);
        return aiText("输出 token 上限必须为整数。", "Maximum output tokens must be an integer.");
      }
      const field = message.match(/^(llm|search)\.(baseUrl|apiKey|model|reasoning|type|tool)\b/);
      if (field) {
        const names: Record<string, [string, string]> = {
          baseUrl: ["Base URL", "Base URL"],
          apiKey: ["API Key", "API key"],
          model: ["模型编号", "Model ID"],
          reasoning: ["推理强度 / token 预算", "Reasoning effort / token budget"],
          type: ["API 类型", "API format"],
          tool: ["搜索工具名", "Search tool name"]
        };
        return (
          aiText(
            field[1] === "llm" ? "语言模型：" : "搜索服务：",
            field[1] === "llm" ? "Language model: " : "Search: "
          ) +
          aiText(...names[field[2]]) +
          aiText("格式或长度无效。", " has an invalid format or length.")
        );
      }
      return "";
    })
    .filter(Boolean);
  return (
    [...new Set(details)].join(" ") ||
    aiText("请求参数无效，请检查表单中的输入。", "Invalid request parameters. Check the form inputs.")
  );
}

export async function aiCall<T = any>(method: string, body: any = {}): Promise<T> {
  let response;
  try {
    response = await axios.post(window.apiEndpoint + `api/ai/${method}`, body, {
      headers: { Authorization: appState.token ? `Bearer ${appState.token}` : undefined },
      validateStatus: () => true
    });
  } catch {
    throw new Error(
      aiText(
        "无法连接到 OJ 服务器，请检查网络后重试。",
        "Unable to connect to the OJ server. Check your connection and retry."
      )
    );
  }
  const { status, data } = response;
  if (status === 400) throw new Error(validationError(data) + " (HTTP 400)");
  const httpErrors: Record<number, [string, string]> = {
    401: ["登录已失效，请重新登录后重试。", "Your session has expired. Sign in again and retry."],
    403: ["没有执行此操作的权限。", "You do not have permission for this action."],
    404: [
      "OJ 的 AI 接口不可用，请联系管理员检查部署。",
      "The OJ AI endpoint is unavailable. Ask the administrator to check the deployment."
    ],
    413: ["请求内容过大，请减小图片或题面的大小。", "The request is too large. Reduce the image or statement size."],
    429: ["OJ 请求过于频繁，请稍后重试。", "Too many OJ requests. Please retry later."],
    502: ["OJ 后端暂时不可用，请稍后重试。", "The OJ backend is temporarily unavailable. Please retry later."],
    503: ["OJ 后端暂时不可用，请稍后重试。", "The OJ backend is temporarily unavailable. Please retry later."],
    504: [
      "OJ 等待服务商响应超时。配置可能已保存，请刷新确认后再测试。",
      "The OJ timed out waiting for the provider. Configuration may already be saved; refresh to confirm before testing again."
    ]
  };
  if (status < 200 || status >= 300)
    throw new Error(
      aiText(
        ...(httpErrors[status] || [
          "OJ 服务器处理请求失败，请稍后重试。",
          "The OJ server could not process the request. Please retry later."
        ])
      ) + ` (HTTP ${status})`
    );
  if (!data || typeof data !== "object")
    throw new Error(
      aiText("OJ 服务器返回了无效响应，请稍后重试。", "The OJ server returned an invalid response. Please retry later.")
    );
  if (data.error) throw new Error(aiError(data.message || data.error));
  return data;
}
export async function uploadAiAttachment(
  file: File,
  onProgress: (value: FileUploadApiProgress) => void
): Promise<string> {
  let attachmentToken: string;
  const result = await callApiWithFileUpload<any, any>({
    api: async request => {
      if (request.uploadInfo?.uuid) return { response: { attachmentToken } };
      const prepared = await aiCall("prepareAttachment", { filename: file.name, size: file.size });
      attachmentToken = prepared.attachmentToken;
      return { response: prepared };
    },
    request: {},
    file,
    onProgress
  });
  if (result.uploadError || result.uploadCancelled || result.requestError || !attachmentToken)
    throw new Error(aiText("附加文件上传失败，请重试。", "Attachment upload failed. Please retry."));
  return attachmentToken;
}

export async function startAiAfterSave(problemId: number) {
  if (!appState.currentUserHasPrivilege("UseAi" as any)) return;
  return aiCall("start", { problemId, action: "metadata", automatic: true });
}
export interface AiJob {
  id: string;
  problemId?: number;
  action: string;
  status: string;
  progress: number;
  step: string;
  error?: string;
  retryOptions?: Array<"validate-samples" | "std">;
  result: {
    discussionId?: number;
    discussionIds?: Record<string, number>;
    warnings?: string[];
    difficultyRationale?: string;
    sourceEvidence?: string;
    sourceSearch?: { status: string; searchCount: number };
    referenceSource?: { kind: "tutorial" | "model"; discussionId?: number; samplesPassed: number; validated: boolean };
    requestedCount?: number;
    generatedCount?: number;
  };
}
export const actionName = (name: string) =>
  ({
    metadata: aiText("自动补全题面信息", "Complete problem metadata"),
    tags: aiText("标签", "Tags"),
    source: aiText("原题检索", "Find original problem"),
    searching: aiText("检索题目特征", "Search problem features"),
    evaluating: aiText("分析搜索结果", "Review search results"),
    verifying: aiText("核对原题内容", "Verify candidate statement"),
    difficulty: aiText("难度", "Difficulty"),
    translate: aiText("翻译", "Translate"),
    tutorial: aiText("题解-AI", "Tutorial-AI"),
    testdata: aiText("测试数据", "Test data"),
    all: aiText("一键执行", "Run all"),
    import: aiText("导入题目", "Import problem"),
    queued: aiText("排队中", "Queued"),
    running: aiText("运行中", "Running"),
    failed: aiText("失败", "Failed"),
    completed: aiText("完成", "Completed"),
    cancelled: aiText("已取消", "Cancelled"),
    plan: aiText("分析子任务", "Plan subtasks"),
    make: aiText("生成 make.cpp", "Generate make.cpp"),
    std: aiText("生成 std.cpp", "Generate std.cpp"),
    checker: aiText("生成 SPJ", "Generate SPJ"),
    interactor: aiText("生成交互程序", "Generate interactor"),
    manager: aiText("生成通信管理程序", "Generate communication manager"),
    grader: aiText("生成函数接口 grader", "Generate function grader"),
    "reference-validate": aiText("验证题解标程", "Validate tutorial reference solution"),
    "compile-interactor": aiText("编译交互程序", "Compile interactor"),
    "compile-manager": aiText("编译通信管理程序", "Compile communication manager"),
    "compile-grader": aiText("编译函数接口 grader", "Compile function grader"),
    validator: aiText("生成输入校验器", "Generate input validator"),
    compile: aiText("编译", "Compile"),
    "compile-make": aiText("编译 make.cpp", "Compile make.cpp"),
    "compile-std": aiText("编译 std.cpp", "Compile std.cpp"),
    "compile-checker": aiText("编译 SPJ", "Compile SPJ"),
    "compile-validator": aiText("编译输入校验器", "Compile input validator"),
    "validate-inputs": aiText("验证数据约束", "Validate input constraints"),
    "validate-samples": aiText("验证样例", "Validate samples"),
    "validate-sample-inputs": aiText("验证样例输入约束", "Validate sample input constraints"),
    generate: aiText("运行生成器", "Run generator"),
    upload: aiText("保存数据", "Save test data"),
    samples: aiText("验证样例", "Validate samples")
  }[name] || name);
