# AI 配置、权限与执行流程

[English](AI.md) | 简体中文 | [全部配置](Configuration.zh-CN.md) | [AI 环境变量](AI-Environment.zh-CN.md)

本文按仓库内的配置和执行代码核对。AI 配置属于当前登录账号，不是全站共享服务。项目不附带模型、公共 Key 或服务额度。页面入口是 `/ai/configuration`；导入入口是 `/ai/import`，已有题的编辑页提供 AI 操作。

仓库维护的 AI 系统指令和 Prompt 统一使用英文，覆盖导入/OCR、翻译、原题搜索与核验、题解、标签、难度、数据生成及修复。生成内容仍遵循原有语言要求：提取时保留原题语言，`zh_CN` 内容仍为中文，`en_US` 内容仍为英文，双语题解要求保持不变。用户输入、题目和搜索资料保留原语言；JSON 字段、评测约束和中文编辑器标签不变。

## 从页面完成配置

1. 管理员按下面的权限表授权。用户用自己的账号打开“AI API 配置”。
2. 选择预设或填写 API 类型、Base URL、Key、模型编号。预设只填写协议和地址，并清空模型选择；它不验证所选模型的能力。
3. “获取模型列表”会先保存整个表单，再请求模型列表。接口不支持列模型时仍可手工输入模型编号。选择模型后再次保存。
4. 在“搜索 / MCP”填写搜索服务；无需搜索时可不提供搜索 Key，但其 Base URL 仍须合法。
5. “保存并测试连通性”先保存整个表单，再对当前页签做真实服务请求。模型测试要求回答 `OK`；搜索测试执行一次搜索，可能消耗额度。测试失败不会撤销已保存配置或清空已保存 Key。
6. 保存只更新配置，不会自动运行题面、题解或数据任务。回到导入页或题目编辑页，明确点击所需 AI 操作。

Base URL 必须是 HTTP/HTTPS，不能包含用户名、密码、查询参数或片段；长度为 1–2000 字符。模型接口会在地址后追加路径，不要把 `/chat/completions`、`/responses`、`/messages` 或 `/models` 填进模型 Base URL。搜索 MCP 则填写完整 MCP 端点路径。公网域名和地址对所有用户开放。内网、本机和链路本地地址由服务器发起访问而非用户自己的浏览器，因此只允许站点管理员自己的配置使用，或由服务器管理员在 `HYHOJ_AI_PRIVATE_HOSTS` 中列出的主机使用（见 [AI 环境](AI-Environment.zh-CN.md)）；其他用户会得到 `PRIVATE_ENDPOINT_BLOCKED`。每个解析结果都会检查，DNS 本次解析结果绑定到本次连接，不跟随 HTTP 重定向。模型列表和连接测试每个用户最多同时 2 个、全站最多同时 8 个。对于公网访问的 OJ，先设置 [HTTPS](HTTPS.zh-CN.md)。

## 所有账号配置字段

下表是 `saveConfiguration` 的配置字段，不是环境变量。表单同时提交 `llm` 和 `search`，即使只修改一个页签，也会验证两组配置。

| 字段 | 初始值 / 缺省行为 | 校验与含义 |
| --- | --- | --- |
| `llm.type` | `chat` | `chat`、`responses`、`anthropic`，协议对应见下表。 |
| `llm.baseUrl` | `https://api.openai.com/v1` | HTTP/HTTPS，1–2000 字符，使用前述 URL 规则。 |
| `llm.apiKey` | 未配置 | 可省略，0–4096 字符。空值/省略仅在 Base URL 与已保存值**完全相同**时保留旧 Key。URL 改变且未给新 Key 时清除旧 Key；即使只是尾部斜线变化也属于不同字符串。调用模型时必须有非空 Key。 |
| `llm.model` | 空字符串 | 0–200 字符；允许先保存空值以获取模型列表，模型生成与连接测试必须填写模型编号。 |
| `llm.reasoning` | 空字符串 | 可省略，0–50 字符；空白按服务商默认行为，发送前去掉首尾空白。不同协议/域名的转换见下文。 |
| `llm.maxTokens` | `16384` | 整数 512–1000000。是输出预算，不是上下文长度；模型可能有更小限制。保存时，`api.deepseek.com` 被自动限制到 393216，并返回调整提示。 |
| `llm.responsesRecovery` | `auto` | `auto`、`off`、`background`；只对 `responses` 协议有意义，见下文。 |
| `search.type` | `tavily` | `tavily` 或 `mcp`。 |
| `search.baseUrl` | `https://api.tavily.com` | 同样的 URL/长度限制；Tavily 后接 `/search`，MCP 使用填入的完整端点。页面切换到 MCP 时预填 `https://mcp.tavily.com/mcp/`。 |
| `search.apiKey` | 未配置 | 可省略，0–4096 字符；保留/清除规则与模型 Key 相同。当前实现的 Tavily 和 MCP 搜索均要求非空 Key。 |
| `search.tool` | 空字符串 | 可省略，0–200 字符。仅 MCP 使用；指定名称须与 `tools/list` 完全匹配；留空选第一个名称包含 `search`（不区分大小写）的工具。 |
| `maxConcurrentJobs` | `3` | 每用户最大运行任务数，整数 1–8。保存时省略会保留旧值，再回落到 3；旧配置无效值读取时回落到 3。它不会改变评测槽位。 |
| `autoOnSave` | `false` | API DTO 仍要求布尔值，属于兼容字段；服务端保存/返回均强制为 `false`，页面也始终提交 `false`。传 `true` 不会恢复自动执行。 |
| `clearLlmKey` | 省略 / `false` | 保存请求的布尔控制项；为 `true` 时清除模型 Key，优先于本次填写的新 Key。不是持久化配置字段。 |
| `clearSearchKey` | 省略 / `false` | 同上，清除搜索 Key。页面“删除已保存的密钥”仅对当前页签设置对应标志。 |

`llm.hasKey`、`search.hasKey` 是只读状态，不是密钥值；`presets` 和 `parallelism` 是页面元数据，不要作为保存参数。Key 保存后不会回填到输入框。`parallelism` 返回 `min=1`、`max=8`、`globalMax=8`、`maxQueuedJobs=100`；最后一个名称实际限制的是该用户**排队中加运行中**的任务总数。

### 协议与服务商预设

| `type` | 生成路径 / 认证 | 输出预算与推理参数 |
| --- | --- | --- |
| `chat` | `/chat/completions`；Bearer Key | `api.openai.com` 使用 `max_completion_tokens`，其他地址使用 `max_tokens`。一般兼容服务发送 `reasoning_effort`。 |
| `responses` | `/responses`；Bearer Key | 使用 `max_output_tokens`；非空推理设置写入 `reasoning.effort`。 |
| `anthropic` | `/messages`；`x-api-key`，协议头 `anthropic-version: 2023-06-01` | 使用 `max_tokens`；具体推理转换见下文。 |

模型发现对三种协议均请求 Base URL 下的 `/models`；Anthropic 最多翻 20 页后去重排序。预设只是以下内置地址，不表示已对这些服务商的全部模型做真实验收：

| 预设 | 类型 | Base URL |
| --- | --- | --- |
| OpenAI | `responses` | `https://api.openai.com/v1` |
| Anthropic | `anthropic` | `https://api.anthropic.com/v1` |
| DeepSeek | `chat` | `https://api.deepseek.com/v1` |
| Google Gemini | `chat` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq | `chat` | `https://api.groq.com/openai/v1` |
| Mistral | `chat` | `https://api.mistral.ai/v1` |
| OpenRouter | `chat` | `https://openrouter.ai/api/v1` |
| SiliconFlow | `chat` | `https://api.siliconflow.cn/v1` |
| 阿里云百炼 | `chat` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 月之暗面 | `chat` | `https://api.moonshot.cn/v1` |

推理设置按当前实现转换，是否被模型接受仍取决于服务商：

- DeepSeek 官方域名：只接受 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`。`chat` 下 `none` 关闭 `thinking`，其他值开启并发送 `reasoning_effort`。最大输出 393216 的限制也按域名识别，不会自动识别第三方代理。
- Anthropic：空值或 `none` 不开启推理；纯数字须至少 1024 且严格小于 `maxTokens`，在生成/连接测试前校验，发送 `thinking.budget_tokens`。其他非空值发送 adaptive thinking 与 `output_config.effort`，未在本地枚举所有模型可用值。
- 阿里云 `*dashscope.aliyuncs.com` 的 `chat`：`none` 关闭 `enable_thinking`；其他值开启，纯数字还发送 `thinking_budget`。
- OpenRouter 的 `chat`：`none` 发送 `reasoning.enabled=false`，其他值发送 `reasoning.effort`。
- 其他 `chat` 端点直接发送 `reasoning_effort`；不能据此认定每个兼容端点都支持推理参数或图像输入。

### Responses 断线恢复

`auto` 只为 `responses` + 官方 `api.openai.com` 启用后台响应恢复；其他兼容端点默认关闭。`off` 明确关闭。`background` 为其他支持后台 Responses 的端点显式启用；DeepSeek 官方端点拒绝该组合。

恢复请求包含 `background: true`、`store: false`，已有响应 ID 会按当前用户、任务和请求指纹保存。获得 ID 后可轮询继续取结果；创建请求的响应丢失时不会盲目重复 POST。Key、地址或请求内容改变会改变指纹，不能承诺继续恢复旧请求。轮询窗口、恢复超时是源码常量，见 [AI 环境与固定限制](AI-Environment.zh-CN.md)。这不是所有 OpenAI-compatible 服务的通用断线重试功能。

### 搜索与 MCP

Tavily 每次搜索最多取 5 项、使用 `advanced` 深度，不请求聚合答案；请求计入提供商用量。MCP 支持 Streamable HTTP 的 JSON/事件流响应，顺序执行 `initialize`、`notifications/initialized`、`tools/list`、`tools/call`，保留服务端会话头。不是本地 stdio MCP 启动器，也不会读取用户电脑上的 MCP 配置。

工具参数只自动适配 `query`、`search_query`、`q` 三种查询字段（依次优先），若 schema 有 `max_results` 则发送 5；需要其他必填参数的任意 MCP 工具不保证兼容。Tavily 托管 MCP 的 Key 由后端加入其认证查询参数，不要自行把 Key 写入 Base URL。未配置搜索 Key 时，单独执行“来源”操作会以 `SEARCH_NOT_CONFIGURED` 失败；组合任务跳过该检索步骤并记录未配置状态，其他步骤仍可能运行。不能把“来源未经核实”解释为已找到原题。

## 权限、任务和生效时机

| 操作 | 所需权限 / 隔离边界 |
| --- | --- |
| 读取/保存 AI 配置，列模型，测试连接 | `ManageAiConfiguration`；只能操作自己的配置。 |
| 开始或重试 AI 任务 | `UseAi`；已有题必须有题目 `Modify` 权限。 |
| 导入新题及准备 ZIP 附件 | `UseAi`、`ImportProblem`、`GenerateTestdata`，并且有创建题目权限。 |
| `testdata`、`all`、`import` | 额外要求 `GenerateTestdata`；数据写入还检查 `EditProblemData` 决策及题目权限。 |
| 查看任务/用量，取消任务 | 登录后仅能访问自己的任务/用量；取消也只按拥有者查找任务。管理员身份不把其他用户的 Key 暴露出来。 |

权限决策包括全局允许/拒绝和题目 ACL；写入前会重新检查当前权限、任务状态与题目快照。任务运行期间改了题面、样例、评测配置或撤销权限，可能使任务以冲突/无权限结束，而不是覆盖用户刚保存的内容。

- 保存配置立即入库；列模型和连接测试读取最新配置。任务在开始实际执行时读取一份配置；已在运行的任务不会在每个阶段热切换 Key/模型，新任务及失败后重新执行的任务读取当时配置。
- 调度器使用最新的每用户并发设置来接纳后续任务，全站最多 8 个运行任务，同一题不会同时运行两个 AI 任务，每用户排队与运行总数最多 100。降低并发不会主动取消已运行任务。
- 本机 AI runner 最多接纳 8 个任务，固定同时执行 3 条生成流程，并与普通提交共用 judge 执行槽位。增加 `maxConcurrentJobs` 不能替代 [judge CPU/槽位配置](Judge-Configuration.zh-CN.md)。
- 导入按“题面识别→来源→翻译→标签→难度→题解→测试数据”执行；`all` 不包含新建题步骤；`metadata` 只执行来源、翻译、标签、难度。`automatic: true` 的旧自动请求直接返回跳过，不恢复自动保存功能。
- 数据数量默认 20，允许 5–1000。为了精确表达子任务等分分值，实际数量可能增加至不超过 1000，并有提示。AI 导入支持传统、交互、通信题；提交答案题需要手工创建。通信题可自动判断，也可指定 `run-twice` 或 C++ `grader` 接口。
- 导入前端接受不超过 10 MiB 的 Markdown/文本/PNG/JPEG/WebP/GIF 题面文件；服务端 Markdown 上限为 500000 字符，图像 data URL 上限为 15000000 字符。ZIP 上限 64 MiB，后端准备阶段还要求至少 22 字节且验证 ZIP 凭据与拥有者；凭据入队有效期为 24 小时。文件大小合格不代表内容合格。

## 测试数据验证与覆盖

传统题的数据生成在发布前执行以下检查，样例校验只是其中一步：

1. 先分析合法的边界、退化结构和复杂度反例，形成覆盖计划。计划说明正确算法、适用于小数据的精确参考算法，以及 1–4 个可实际运行的错误或低效实现，其中至少有一个错误实现。
2. 分别生成小数据生成器、精确参考程序和一份独立高效正解。生成这些程序时提供题面、约束和覆盖计划，不提供已有生成器、标程或其他实现的代码。小数据优先使用暴力枚举等直接方法；题目不存在合法的小规模输入时，使用能处理最小合法规模的精确方法。
3. 默认至少生成 64 组合法小数据，并覆盖每个子任务；子任务超过 64 个时相应增加组数。输入经过独立 validator 检查，再将标程和独立正解的输出与精确参考程序对拍。
4. 所有正式数据都由独立正解交叉校验。多解或浮点题使用该题实际 checker/SPJ 判定，允许不同的合法输出，不要求与标程逐字相同。
5. 编译并运行覆盖计划中的候选程序，验证正式数据确实能使每个目标失败。只有对拍、正解交叉校验和所有目标的反例验证均通过，才启用本次生成的数据。

候选程序也须先通过正式样例。错误实现还须在每个适用子任务中通过至少一组小数据；低效实现须通过所有适用的小数据。正式数据上的 WA、RE、TLE、MLE 可作为错误实现的反例；低效实现只接受由实际时间或内存限制产生的 TLE/MLE，出现 WA/RE 会使该探针验证失败。编译失败、checker 的 `_fail` 或执行环境故障不能算作卡掉目标。

生成器优先构造目标所需的合法数据，而不是只生成大规模随机输入。例如，最短路题只有在约束允许且真实图结构能触发超时时，才把某个 SPFA 实现视为低效目标；不能仅按算法名称拒绝程序。正确的替代算法按实际判题规则验收。

若初始正式数据未覆盖所有目标，后端最多再尝试 16 次反例搜索。找到反例后只替换同一子任务内的普通测试点，保留索引 1/2 的最小/最大边界测试点和已经卡掉目标的测试点，不改变测试点数量及子任务分值。搜索耗尽仍有目标通过时，本次数据生成失败，不启用未通过验证的数据。

任务页面显示对拍数量、独立正解校验数量，以及各目标的失败判定与正式测试点编号。接口 `result.testdataQuality` 还包含 `extraAttemptsUsed`，记录额外搜索次数。`data.yaml` 还保存 `qualityPlan`、`qualityValidation`、`finalCaseIndices` 和 `verificationSources`，记录覆盖计划、验证结果、最终子任务/索引及辅助源码的 SHA-256。这里的 `seed` 字段是生成器场景索引，不是可复现随机数种子；实际导出的输入文件才是反例凭据。小数据生成器、精确参考程序、独立正解和候选程序源码保留在私有任务状态，不随题目数据公开导出。

交互题、通信题保留原有协议模拟与校验，任务会提示 `TESTDATA_QUALITY_PROTOCOL_UNSUPPORTED`，表示上述独立对拍与反例验证暂不可用。有限数据和有限候选程序无法证明所有错误或低效实现都会失败，也不能证明标程绝对正确。新增的独立程序和候选程序生成会增加模型调用、费用及执行时间；并发和资源限制见 [AI 环境与固定限制](AI-Environment.zh-CN.md)。

## 文件读取、取消与生成失败

选择文件时先完成读取，再清空输入控件；ZIP 先形成浏览器内存中的文件副本。读取失败会显示错误，不继续上传。曾经真实复现的 Linux Snap Firefox 故障由 AppArmor 拒绝读取 root 所有的测试文件触发：把自己要上传的文件放在当前桌面用户有权访问的目录，并用该用户拥有的副本。不要为此关闭浏览器沙箱或全局放宽 AppArmor。

附件只有取得明确 HTTP 2xx 才继续创建任务。上传阶段可点击“取消上传”；离开页面会取消尚未完成的读取/准备/上传，并阻止其稍后再发送创建任务请求。若服务器已经接受任务，关闭页面不会撤回它，应在“我的 AI 任务”取消；创建请求超时应先查看任务列表，避免重复导入。取消不能撤销已完成的模型收费或已发布步骤。

生成器仅在 AI 自己生成的 `make.cpp` 出现明确的编译失败时自动修复一次，修复预算持久化；不会循环修复，也不会自动改写用户附加的 checker、interactor、manager 或 grader。第二次失败、样例失败、数据校验失败继续作为失败报告。自动修复会额外调用模型。题解来源和部分分描述会经过事实校验；失败时阻止该次发布并给出可重试提示，仍不能代替人工审阅所有算法论证。

## 执行位置与密钥备份

模型与搜索请求由后端发送；生成、编译、运行及数据验证交给**同机** judge 的 UNIX socket worker。普通评测可以分布到远程 judge，但当前没有远程 AI runner 协议。`--role all` 提供本机 worker；`--role web` 本身不提供生成程序的执行环境。需要完整 AI 数据生成时，在网页节点保留本机 runner，再让远程 judge 分担普通提交。目录、socket 和权限见 [AI 环境变量](AI-Environment.zh-CN.md)。

数据库 `ai_configuration` 按 `userId` 存储整个加密配置；算法为 AES-256-GCM。主密钥默认位于 `data/ai/master.key`，目录 `0700`、文件 `0600`，必须由后端服务用户拥有，且为单硬链接的普通 32 字节文件；拒绝符号链接和不合格文件。数据库已有加密配置而主密钥丢失时，后端启动失败，不能自动新建一个替换旧密钥。

备份数据库时必须同时安全备份对应主密钥；换一个不匹配的 Key 无法解密原配置。不要把数据库、主密钥、会话或提供商 Key 放入源码/报告包。用户配置读取仅返回 `hasKey`，用量记录保存请求元数据和服务商报告的消耗，不保存 Key、提示词或模型响应正文。用量默认查看 30 天，API 支持 1–366 天；没有提供商用量的请求不估算 token，失败和重试也属于调用。

## 已验证范围

此前在 Ubuntu 24.04 amd64 的真实部署中，使用真实 DeepSeek/Tavily 和 Firefox 完成过部分模型配置、搜索、图片/文字导入、题目内容与数据生成、提交评测和多用户权限路径。上传修复还经过实际 Firefox 组件回归，包括不可读文件、上传 HTTP 错误/超时、取消和离页；模拟服务用来控制网络响应时机。这不等于全部模型服务商、全部 MCP 服务、所有输出质量或真实多机 AI worker 已验收。

此版本后续修复还包括隔离单测、模拟服务、真实数据库或真实沙盒回归；各类测试只证明其实际覆盖范围。本次 Wiki 更新按源码核对配置，没有重新进行全新安装或完整付费 AI 业务验收。

## 源码依据

- [配置 DTO、范围与请求参数](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai.dto.ts)、[默认值和服务商预设](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai.types.ts)
- [服务商协议实现](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-provider.ts)、[预算校验](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-validation.ts)、[Responses 恢复](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-responses.ts)
- [权限、任务调度与写入](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.service.ts)、[密钥生命周期](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-crypto.ts)
- [配置界面](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/pages/ai/AiConfigurationPage.tsx)、[导入界面](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/pages/ai/AiImportPage.tsx)
- [测试数据覆盖计划与验收](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-testdata-quality.ts)、[对拍与反例验证](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiQuality.ts)、[runner 执行与判定](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiRunner.ts)

## 题解保存位置

AI 新生成的题解显示在对应题目页内的“题解”栏目，仍属于讨论并出现在作者的“我的讨论”中。已有 AI 题解只通过明确的任务讨论 ID、题目和作者校验进行迁移；普通讨论不会按标题自动分类。参阅 [题解](Solutions.zh-CN.md)。

## 为 NOI 比赛准备 Self Eval

传统题的正式数据发布同时绑定本次实际使用的不可变 `make.cpp`、`std.cpp` 和输入校验器版本，供以后已开启 Self Eval 的 NOI / OI 比赛复用。其它题型和普通题库不开放 Self Eval 运行。

比赛管理员可在赛前从比赛题目页的“自测”进入“配置 Self Eval”，点击“AI 生成正式数据与 Self Eval 程序”。该按钮运行已有 AI `testdata` 流程，会重新生成并更新本题正式评测数据；需要自己的已配置 AI 服务及相应 AI、出题和数据编辑权限。任务完成后界面载入同版 make/std，管理员再点击“准备预测试数据”，并沿用正式 checker/SPJ。生成或准备失败不会开放不完整的预测试集。手工维护 make/std 和全场次数限制见 [Self Eval](Self-Evaluation.zh-CN.md)。
