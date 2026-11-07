import AiUsage from "./AiUsage";
import React, { useEffect, useState } from "react";
import { Button, Dropdown, Form, Header, Menu, Message } from "semantic-ui-react";
import { observer } from "mobx-react";
import { appState } from "@/appState";
import { defineRoute } from "@/AppRouter";
import { aiCall, aiText } from "./api";
import preferenceStyle from "../user/edit/UserEdit.module.less";
import style from "./Ai.module.less";
import AiDeploymentIdentity from "./AiDeploymentIdentity";
import { actsAsButton } from "@/utils/keyboard";

export const AiConfigurationPage = observer(function AiConfigurationPage() {
  const [config, setConfig] = useState<any>(null),
    [tab, setTab] = useState("llm"),
    [models, setModels] = useState<string[]>([]);
  const [llmKey, setLlmKey] = useState(""),
    [searchKey, setSearchKey] = useState("");
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [adjustment, setAdjustment] = useState("");
  useEffect(() => {
    appState.enterNewPage(aiText("AI API 配置", "AI API Configuration"), null, false);
    void aiCall("getConfiguration")
      .then(setConfig)
      .catch(e => setError(e.message));
  }, []);
  const update = (section: string, key: string, value: any) =>
    setConfig(previous => ({ ...previous, [section]: { ...previous[section], [key]: value } }));
  let isDeepSeek = false;
  try {
    isDeepSeek = new URL(config?.llm.baseUrl || "").hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    // The server will validate the endpoint and return a readable field error.
  }
  const maxOutputTokens = 1000000;
  const requestedMaxTokens = config?.llm.maxTokens ?? 16384;
  const invalidMaxTokens =
    config &&
    (!Number.isInteger(requestedMaxTokens) || requestedMaxTokens < 512 || requestedMaxTokens > maxOutputTokens);
  const maxTokensError = invalidMaxTokens
    ? aiText(
        `输出 token 上限必须为 512 至 ${maxOutputTokens} 的整数。`,
        `Maximum output tokens must be an integer between 512 and ${maxOutputTokens}.`
      )
    : "";
  const save = async (clearLlmKey = false, clearSearchKey = false) => {
    const { type, baseUrl, model, reasoning, maxTokens, responsesRecovery = "auto", structuredOutput } = config.llm;
    // Purposes left without a model inherit the main model (review Part V, R5)
    const modelPolicies = Object.fromEntries(
      Object.entries((config.modelPolicies || {}) as Record<string, AiModelPolicy>)
        .filter(([, policy]) => policy?.model?.trim())
        .map(([purpose, policy]) => [
          purpose,
          {
            model: policy.model.trim(),
            ...(policy.reasoning?.trim() ? { reasoning: policy.reasoning.trim() } : {}),
            ...(policy.maxTokens ? { maxTokens: Number(policy.maxTokens) } : {})
          }
        ])
    );
    const result = await aiCall("saveConfiguration", {
      llm: {
        type,
        baseUrl,
        model,
        reasoning,
        maxTokens,
        responsesRecovery,
        ...(structuredOutput ? { structuredOutput } : {}),
        ...(llmKey ? { apiKey: llmKey } : {})
      },
      sourcePolicy: config.sourcePolicy || "optional",
      modelPolicies,
      search: {
        type: config.search.type,
        baseUrl: config.search.baseUrl,
        tool: config.search.tool || "",
        ...(searchKey ? { apiKey: searchKey } : {})
      },
      autoOnSave: false,
      maxConcurrentJobs: config.maxConcurrentJobs ?? 3,
      clearLlmKey,
      clearSearchKey
    });
    setConfig(result);
    if (result.adjustments?.maxTokens)
      setAdjustment(
        aiText(
          `已按 DeepSeek 的输出限制自动调整为 ${result.adjustments.maxTokens.applied} token，配置已保存。`,
          `Adjusted to DeepSeek's output limit of ${result.adjustments.maxTokens.applied} tokens. Configuration saved.`
        )
      );
    setLlmKey("");
    setSearchKey("");
    return result;
  };
  const action = async (method: "save" | "models" | "test" | "clear") => {
    setError("");
    setMessage("");
    setAdjustment("");
    if (invalidMaxTokens) {
      setError(maxTokensError);
      return;
    }
    if (
      !Number.isInteger(config.maxConcurrentJobs ?? 3) ||
      (config.maxConcurrentJobs ?? 3) < 1 ||
      (config.maxConcurrentJobs ?? 3) > (config.parallelism?.max ?? 8)
    ) {
      setError(aiText("最大并行任务数须为 1–8 的整数。", "Maximum concurrent jobs must be an integer from 1 to 8."));
      return;
    }
    setPending(true);
    let saved = false;
    try {
      await save(method === "clear" && tab === "llm", method === "clear" && tab === "search");
      saved = true;
      if (method === "models") {
        setMessage(aiText("配置已保存，正在获取模型列表……", "Configuration saved. Fetching models…"));
        const result = await aiCall("models");
        setModels(result.models);
        setMessage(aiText(`已获取 ${result.models.length} 个模型。`, `Fetched ${result.models.length} models.`));
      } else if (method === "test") {
        setMessage(aiText("配置已保存，正在等待服务商响应……", "Configuration saved. Waiting for the provider…"));
        const result = await aiCall("test", { target: tab });
        setMessage(aiText(`连接成功，耗时 ${result.elapsedMs} 毫秒。`, `Connected in ${result.elapsedMs} ms.`));
      } else setMessage(aiText("配置已保存。", "Configuration saved."));
    } catch (e) {
      setError(e.message);
      if (saved)
        setMessage(
          aiText(
            "配置已保存；后续请求失败不会清除已保存的密钥。",
            "Configuration saved. The later request failed, but your saved key is unchanged."
          )
        );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className={`${preferenceStyle.container} ${style.configuration}`}>
      <div className={`${preferenceStyle.menu} ${style.configurationMenu}`}>
        <Menu vertical secondary>
          <Menu.Item {...actsAsButton} active={tab === "llm"} onClick={() => setTab("llm")}>
            {aiText("语言模型", "Language model")}
          </Menu.Item>
          <Menu.Item {...actsAsButton} active={tab === "search"} onClick={() => setTab("search")}>
            {aiText("搜索 / MCP", "Search / MCP")}
          </Menu.Item>
          <Menu.Item
            {...actsAsButton}
            active={tab === "usage"}
            onClick={() => {
              setTab("usage");
              setError("");
              setMessage("");
              setAdjustment("");
            }}
          >
            {aiText("用量", "Usage")}
          </Menu.Item>
        </Menu>
      </div>
      <div className={`${preferenceStyle.main} ${style.configurationMain}`}>
        <Header as="h1" size="large" className={preferenceStyle.sectionHeader}>
          {aiText("AI API 配置", "AI API Configuration")}
        </Header>
        {error && <Message negative>{error}</Message>}
        {adjustment && <Message info>{adjustment}</Message>}
        {config?.sitePolicy?.paused && (
          <Message warning>
            {aiText(
              "站点管理员已暂停 AI：现在不会发出任何 AI 请求，包括模型列表和连接测试。",
              "AI is paused by the site administrator: no AI requests are made, including model lists and connection tests."
            )}
          </Message>
        )}
        {config?.sitePolicy?.approvedEndpointsOnly && (
          <Message info>
            {aiText(
              "本站只允许使用站点管理员批准的地址：请从预设中选择服务商和搜索服务。",
              "This site allows only addresses a site administrator approved: choose the provider and search service from the presets."
            )}
          </Message>
        )}
        {message && (
          <Message positive={!pending} info={pending}>
            {message}
          </Message>
        )}
        {tab === "usage" ? (
          <AiUsage />
        ) : (
          config && (
            <>
              <Form onSubmit={e => e.preventDefault()} loading={pending} autoComplete="off">
                {tab === "llm" ? (
                  <>
                    <Form.Field>
                      <label>{aiText("服务商预设", "Provider preset")}</label>
                      <Dropdown
                        fluid
                        selection
                        search
                        placeholder={aiText(
                          "选择服务商或自行输入 Base URL",
                          "Choose a provider or enter a custom Base URL"
                        )}
                        options={config.presets.map((preset, i) => ({ key: i, value: i, text: preset.name }))}
                        onChange={(_e, { value }) => {
                          const preset = config.presets[Number(value)];
                          setConfig(previous => ({
                            ...previous,
                            llm: { ...previous.llm, type: preset.type, baseUrl: preset.baseUrl, model: "" }
                          }));
                          setModels([]);
                        }}
                      />
                    </Form.Field>
                    <Form.Select
                      label={aiText("API 类型", "API format")}
                      value={config.llm.type}
                      options={[
                        { value: "chat", text: "OpenAI Compatible (Chat Completions)" },
                        { value: "responses", text: "Responses" },
                        { value: "anthropic", text: "Anthropic Messages" }
                      ]}
                      onChange={(_e, { value }) => update("llm", "type", value)}
                    />
                    <Form.Input
                      label="Base URL"
                      value={config.llm.baseUrl}
                      onChange={(_e, { value }) => update("llm", "baseUrl", value)}
                    />
                    <Form.Input
                      label="API Key"
                      type="password"
                      autoComplete="new-password"
                      value={llmKey}
                      placeholder={
                        config.llm.hasKey
                          ? aiText("已保存在服务器，留空保持不变", "Stored on the server; leave blank to keep")
                          : aiText("输入 API Key", "Enter API key")
                      }
                      onChange={(_e, { value }) => setLlmKey(value)}
                    />
                    <Form.Field>
                      <label>{aiText("模型", "Model")}</label>
                      <div className={style.modelField}>
                        <Dropdown
                          fluid
                          search
                          selection
                          allowAdditions
                          value={config.llm.model}
                          options={[...new Set([...models, ...(config.llm.model ? [config.llm.model] : [])])].map(
                            id => ({
                              key: id,
                              value: id,
                              text: id
                            })
                          )}
                          placeholder={aiText("选择或手工输入模型编号", "Select or enter a model ID")}
                          additionLabel={aiText("使用模型：", "Use model: ")}
                          onAddItem={(_e, { value }) => {
                            setModels(previous => [...previous, String(value)]);
                            update("llm", "model", value);
                          }}
                          onChange={(_e, { value }) => update("llm", "model", value)}
                        />
                        <Button type="button" onClick={() => action("models")}>
                          {aiText("获取模型列表", "Fetch models")}
                        </Button>
                      </div>
                    </Form.Field>
                    <Form.Input
                      label={aiText("推理强度 / token 预算", "Reasoning effort / token budget")}
                      value={config.llm.reasoning || ""}
                      placeholder="low / medium / high / max / ..."
                      onChange={(_e, { value }) => update("llm", "reasoning", value)}
                    />
                    <p className={preferenceStyle.notes}>
                      {aiText(
                        "留空使用服务商默认值。Anthropic 支持强度名称或数字 token 预算；可用参数由所选模型决定。",
                        "Leave blank for the provider default. Anthropic accepts an effort name or numeric token budget; supported values depend on the selected model."
                      )}
                    </p>
                    <Form.Input
                      label={aiText("输出 token 上限", "Maximum output tokens")}
                      type="number"
                      min={512}
                      max={maxOutputTokens}
                      step={1}
                      aria-label={aiText("输出 token 上限", "Maximum output tokens")}
                      error={maxTokensError ? { content: maxTokensError } : false}
                      value={config.llm.maxTokens ?? 16384}
                      onChange={(_e, { value }) => update("llm", "maxTokens", Number(value))}
                    />
                    {isDeepSeek && (
                      <p className={preferenceStyle.notes}>
                        {aiText(
                          "DeepSeek 支持 1M 上下文；最大输出为 393216 token（384K），包含思考 token。较大的设置会在保存时自动调整，不影响密钥保存。",
                          "DeepSeek supports a 1M context window; its output limit is 393216 tokens (384K), including thinking tokens. Larger values are adjusted on save without blocking key storage."
                        )}
                      </p>
                    )}
                    <Form.Input
                      type="number"
                      min={config.parallelism?.min ?? 1}
                      max={config.parallelism?.max ?? 8}
                      step={1}
                      label={aiText("最大并行 AI 任务数", "Maximum concurrent AI jobs")}
                      value={config.maxConcurrentJobs ?? 3}
                      onChange={(_e, { value }) =>
                        setConfig(previous => ({ ...previous, maxConcurrentJobs: Number(value) }))
                      }
                    />
                    <p className={preferenceStyle.notes}>
                      {aiText(
                        "允许不同题目的 AI 任务并行执行；同一道题已有任务时，请待其结束后再启动。此设置不改变评测并发数。保存题面只保存内容，使用题目页面的 AI 按钮启动任务。",
                        "AI jobs for different problems can run concurrently; wait for an existing job on the same problem to finish before starting another. This does not change judging concurrency. Saving a statement only saves it; start AI jobs with the problem page's AI buttons."
                      )}
                    </p>
                    {config.llm.type === "responses" && (
                      <>
                        <Form.Select
                          label={aiText("断线恢复", "Connection recovery")}
                          value={config.llm.responsesRecovery ?? "auto"}
                          options={[
                            {
                              value: "auto",
                              text: aiText("自动（已确认支持的服务商）", "Automatic (verified providers)")
                            },
                            { value: "off", text: aiText("关闭", "Off") },
                            {
                              value: "background",
                              text: aiText(
                                "后台响应（服务商须支持）",
                                "Background response (provider support required)"
                              )
                            }
                          ]}
                          onChange={(_e, { value }) => update("llm", "responsesRecovery", value)}
                        />
                        <p className={preferenceStyle.notes}>
                          {aiText(
                            "支持后台响应的服务商可在服务器短暂断网后恢复查询。该模式会让服务商暂存响应；DeepSeek 暂不支持。浏览器关闭或设备断网不会停止已在服务器运行的任务。",
                            "Providers supporting background responses can resume retrieval after a brief server disconnection. This mode stores the response with the provider; DeepSeek does not support it. Closing the browser or disconnecting your device does not stop server-side jobs."
                          )}
                        </p>
                      </>
                    )}
                    <Form.Select
                      label={aiText("测试方案的结构化输出", "Structured output for testing plans")}
                      value={config.llm.structuredOutput || "off"}
                      options={[
                        {
                          value: "off",
                          text: aiText("关闭（在提示中说明格式）", "Off (format described in the prompt)")
                        },
                        {
                          value: "json_schema",
                          text: aiText("JSON Schema（服务商须支持）", "JSON Schema (provider support required)")
                        }
                      ]}
                      onChange={(_e, { value }) => update("llm", "structuredOutput", value)}
                    />
                    <p className={preferenceStyle.notes}>
                      {aiText(
                        "开启后，支持的 Chat/Responses 服务会按方案的 JSON Schema 返回；其他服务仍在提示中说明格式。两种方式都会在本站再次校验。",
                        "When on, supported Chat/Responses services answer in the plan's JSON Schema; others still get the format in the prompt. The site validates the plan either way."
                      )}
                    </p>
                    <AiModelPolicies
                      value={config.modelPolicies || {}}
                      onChange={modelPolicies => setConfig(previous => ({ ...previous, modelPolicies }))}
                    />
                  </>
                ) : (
                  <>
                    {config.searchPresets?.length > 0 && (
                      <Form.Field>
                        <label>{aiText("搜索服务预设", "Search service preset")}</label>
                        <Dropdown
                          fluid
                          selection
                          placeholder={aiText("选择站点批准的搜索服务", "Choose a search service the site approved")}
                          options={config.searchPresets.map((preset, i) => ({ key: i, value: i, text: preset.name }))}
                          onChange={(_e, { value }) => {
                            const preset = config.searchPresets[Number(value)];
                            setConfig(previous => ({
                              ...previous,
                              search: { ...previous.search, type: preset.type, baseUrl: preset.baseUrl }
                            }));
                          }}
                        />
                      </Form.Field>
                    )}
                    <Form.Select
                      label={aiText("搜索接口", "Search API")}
                      value={config.search.type}
                      options={[
                        { value: "tavily", text: "Tavily Search API" },
                        { value: "mcp", text: "MCP (Streamable HTTP)" }
                      ]}
                      onChange={(_e, { value }) =>
                        setConfig(previous => ({
                          ...previous,
                          search: {
                            ...previous.search,
                            type: value,
                            baseUrl: value === "tavily" ? "https://api.tavily.com" : "https://mcp.tavily.com/mcp/"
                          }
                        }))
                      }
                    />
                    <Form.Input
                      label="Base URL"
                      value={config.search.baseUrl}
                      onChange={(_e, { value }) => update("search", "baseUrl", value)}
                    />
                    <Form.Input
                      label="API Key"
                      type="password"
                      autoComplete="new-password"
                      value={searchKey}
                      placeholder={
                        config.search.hasKey
                          ? aiText("已保存在服务器，留空保持不变", "Stored on the server; leave blank to keep")
                          : aiText("输入 API Key", "Enter API key")
                      }
                      onChange={(_e, { value }) => setSearchKey(value)}
                    />
                    {config.search.type === "mcp" && (
                      <Form.Input
                        label={aiText("搜索工具名（可选）", "Search tool name (optional)")}
                        value={config.search.tool || ""}
                        placeholder={aiText("留空自动发现 search 工具", "Leave blank to discover a search tool")}
                        onChange={(_e, { value }) => update("search", "tool", value)}
                      />
                    )}
                    <Form.Select
                      label={aiText("原题检索", "Source search")}
                      value={config.sourcePolicy || "optional"}
                      options={[
                        {
                          value: "optional",
                          text: aiText(
                            "可选（检索失败不影响其他步骤）",
                            "Optional (a failed search doesn't stop other work)"
                          )
                        },
                        {
                          value: "required",
                          text: aiText(
                            "必需（发布数据前须核实原题）",
                            "Required (verify the source before publishing data)"
                          )
                        },
                        { value: "off", text: aiText("关闭", "Off") }
                      ]}
                      onChange={(_e, { value }) => setConfig(previous => ({ ...previous, sourcePolicy: value }))}
                    />
                    <p className={preferenceStyle.notes}>
                      {aiText(
                        "可选时，检索失败只会把原题标记为“未核实”，题面、题解和测试数据照常继续。“必需”是来源核实规则，不是评测故障：未核实时不会发布测试数据。站点也可能统一要求核实。",
                        "When optional, a failed search only marks the source as unverified; the statement, tutorial and test data carry on. Required is a provenance rule, not a judging failure: test data isn't published until the source is verified. The site may also require it for everyone."
                      )}
                    </p>
                  </>
                )}
                <div className={style.actions}>
                  <Button primary type="button" onClick={() => action("save")}>
                    {aiText("保存", "Save")}
                  </Button>
                  <Button type="button" onClick={() => action("test")}>
                    {aiText("保存并测试连通性", "Save and test connection")}
                  </Button>
                  <Button basic type="button" onClick={() => action("clear")}>
                    {aiText("删除已保存的密钥", "Delete saved key")}
                  </Button>
                </div>
              </Form>
              {appState.currentUser?.isAdmin && <AiDeploymentIdentity />}
              <div className={preferenceStyle.notes + " " + style.privacyNotes}>
                {aiText(
                  "密钥加密保存在后端，只属于当前账号。页面不会读取或显示已保存的密钥。AI 功能会将题面、样例和相关配置发送给你选择的模型服务；搜索请求发送给你配置的搜索服务。",
                  "Keys are encrypted on the backend and belong only to your account. Saved keys are never read back or displayed. AI actions send the statement, samples and relevant settings to your selected model provider; searches use your configured search service."
                )}
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
});
export interface AiModelPolicy {
  model: string;
  reasoning?: string;
  maxTokens?: number;
}

const policyPurposes: Array<[string, () => string, () => string]> = [
  [
    "reasoning",
    () => aiText("算法推理", "Algorithm reasoning"),
    () => aiText("标程、暴力解、生成器等程序和测试方案", "Solutions, oracles, generators and testing plans")
  ],
  [
    "schema_repair",
    () => aiText("方案字段修复", "Plan field repair"),
    () => aiText("只修改测试方案中被拒绝的字段", "Rewrites only a plan's rejected fields")
  ],
  [
    "metadata",
    () => aiText("题目信息", "Metadata"),
    () => aiText("标签、难度、翻译等格式化工作", "Tags, difficulty, translation and other formatting")
  ],
  [
    "compiler_fix",
    () => aiText("编译错误修复", "Compiler fixes"),
    () => aiText("根据编译器报错直接修改", "Direct fixes from compiler diagnostics")
  ]
];

/** A smaller model for work that doesn't need to solve the problem again; blank purposes use the main model (review Part V, R5). */
function AiModelPolicies({
  value,
  onChange
}: {
  value: Record<string, AiModelPolicy>;
  onChange: (value: Record<string, AiModelPolicy>) => void;
}) {
  const change = (purpose: string, field: keyof AiModelPolicy, fieldValue: string) =>
    onChange({
      ...value,
      [purpose]: {
        ...(value[purpose] || { model: "" }),
        [field]: field === "maxTokens" ? (fieldValue ? Number(fieldValue) : undefined) : fieldValue
      }
    });
  return (
    <Form.Field>
      <label>{aiText("按用途选择模型（可选）", "Models by purpose (optional)")}</label>
      <p className={preferenceStyle.notes}>
        {aiText(
          "使用同一服务和密钥。留空的用途使用上面的模型；修复字段、题目信息和编译错误一般不需要最强的模型。",
          "Uses the same service and key. Purposes left blank use the model above; field repair, metadata and compiler fixes usually don't need the strongest model."
        )}
      </p>
      <div className={style.modelPolicies}>
        {policyPurposes.map(([purpose, name, note]) => (
          <div key={purpose} className={style.modelPolicy}>
            <div>
              <strong>{name()}</strong>
              <div className={style.notes}>{note()}</div>
            </div>
            <Form.Input
              aria-label={aiText(`${name()}的模型`, `Model for ${name()}`)}
              placeholder={aiText("模型", "Model")}
              maxLength={200}
              value={value[purpose]?.model || ""}
              onChange={(_e, { value: model }) => change(purpose, "model", model)}
            />
            <Form.Input
              aria-label={aiText(`${name()}的推理强度`, `Reasoning for ${name()}`)}
              placeholder={aiText("推理强度", "Reasoning")}
              maxLength={50}
              value={value[purpose]?.reasoning || ""}
              onChange={(_e, { value: reasoning }) => change(purpose, "reasoning", reasoning)}
            />
            <Form.Input
              aria-label={aiText(`${name()}的输出 token 上限`, `Maximum output tokens for ${name()}`)}
              placeholder={aiText("输出上限", "Max tokens")}
              type="number"
              min={512}
              max={1000000}
              value={value[purpose]?.maxTokens ?? ""}
              onChange={(_e, { value: maxTokens }) => change(purpose, "maxTokens", maxTokens)}
            />
          </div>
        ))}
      </div>
    </Form.Field>
  );
}

export default defineRoute(async () => <AiConfigurationPage />);
