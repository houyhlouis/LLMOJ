# AI

简体中文 | [English](AI.md) | [Wiki 首页](Home.md) | [配置总览](Configuration.zh-CN.md) | [AI 环境](AI-Environment.zh-CN.md)

LLMOJ 可以借助 AI 模型导入题目、翻译和添加标签、估计难度、撰写题解、查找题目出处，以及生成并检验测试数据。每位用户使用**自己的**服务商账号和密钥设置 AI：网站不提供模型、密钥或额度。

- **AI API 配置**（`/ai/configuration`）：你的服务商、模型、联网搜索和用量。
- **AI 导入**（`/ai/import`）：根据题面创建题目。
- 题目编辑页中的 **AI** 面板：对已有题目执行 AI 操作。

LLMOJ 发给模型的指令是英文的，但模型输出的内容遵循所要求的语言：导入的题面保持原文语言，`zh_CN` 内容用中文撰写，`en_US` 内容用英文撰写。你自己的文本、题目和搜索结果按原样发送。

## 设置

1. 请管理员授予你需要的权限（见[权限与任务](#权限与任务)），然后打开 **AI API 配置**。
2. 选择 **服务商预设**，或自行填写 **API 类型**、Base URL、密钥和模型。预设只会填写 API 类型和 Base URL。
3. **获取模型列表** 会先保存表单，再加载服务商的模型列表；选择模型后再保存一次。如果服务商无法列出模型，请直接输入模型编号。
4. 如需联网搜索（用于查找题目出处），请配置 **搜索 / MCP**。
5. **保存并测试连通性** 会先保存，然后发出一次真实请求：一条简短的模型回复或一次搜索。这可能消耗服务商额度。测试失败不会撤销保存。

保存不会启动任何 AI 操作；请在导入页面或题目的 AI 面板中启动。

**Base URL** 必须使用 HTTP 或 HTTPS，长度 1～2000 个字符，不能包含用户名、密码、查询参数或片段。LLMOJ 会自动添加路径，因此不要包含 `/chat/completions`、`/responses`、`/messages` 或 `/models`；MCP 请填写完整的接口地址。

**内网地址。** 请求从服务器发出，因此内网、本机回环和链路本地地址会让用户访问到服务器所在的网络。只有站点管理员自己的配置，以及服务器管理员在 `HYHOJ_AI_PRIVATE_HOSTS` 中列出的主机（见 [AI 环境](AI-Environment.zh-CN.md)）可以使用这些地址；其他用户会收到 `PRIVATE_ENDPOINT_BLOCKED`。每个解析出的地址都会被检查并固定用于该次连接，也不会跟随重定向。

在公开站点上让用户填写密钥之前，请先配置 [HTTPS](HTTPS.zh-CN.md)。

## 配置字段

以下是配置页面保存的字段。每次保存都会同时检查模型和搜索设置，即使你只修改了其中一项。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `llm.type` | `chat` | API 类型：`chat`、`responses` 或 `anthropic`（见下文） |
| `llm.baseUrl` | `https://api.openai.com/v1` | 服务商地址 |
| `llm.apiKey` | 无 | 最多 4096 个字符。留空时，只有 Base URL 完全相同才保留已保存的密钥；URL 的任何改动（哪怕只是末尾的斜杠）都会清除它 |
| `llm.model` | 空 | 模型编号，最多 200 个字符。生成和测试时必须填写 |
| `llm.reasoning` | 空 | 推理强度或 token 预算，最多 50 个字符；为空时使用服务商的默认值（见下文） |
| `llm.maxTokens` | `16384` | **输出 token 上限**，512～1000000：是输出上限，不是上下文长度。对 `api.deepseek.com` 最多为 393216，页面会提示调整 |
| `llm.responsesRecovery` | `auto` | `responses` 类型的 **断线恢复**：`auto`、`off` 或 `background` |
| `search.type` | `tavily` | `tavily` 或 `mcp` |
| `search.baseUrl` | `https://api.tavily.com` | Tavily 会加上 `/search`；MCP 按原样使用。切换到 MCP 时自动填入 `https://mcp.tavily.com/mcp/` |
| `search.apiKey` | 无 | 保留和清除规则与模型密钥相同。Tavily 和 MCP 都需要密钥 |
| `search.tool` | 空 | 仅 MCP：要调用的工具名，必须与 `tools/list` 中的名称完全一致。为空时使用第一个名称包含 `search` 的工具 |
| `maxConcurrentJobs` | `3` | **最大并行 AI 任务数**：你同时运行的任务数，1～8 |

已保存的密钥永远不会返回给浏览器；页面只显示是否已保存。**删除已保存的密钥** 会删除当前标签页的密钥。

### API 类型与预设

| 类型 | 接口与认证 | 输出上限与推理 |
| --- | --- | --- |
| `chat` | `/chat/completions`，Bearer 密钥 | `api.openai.com` 使用 `max_completion_tokens`，其他服务商使用 `max_tokens`；推理以 `reasoning_effort` 发送 |
| `responses` | `/responses`，Bearer 密钥 | `max_output_tokens`；推理以 `reasoning.effort` 发送 |
| `anthropic` | `/messages`，`x-api-key` 和 `anthropic-version: 2023-06-01` | `max_tokens`；思考方式见下文 |

模型列表来自 Base URL 下的 `/models`（Anthropic 最多读取 20 页）。预设如下：

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
| 阿里云 | `chat` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Moonshot | `chat` | `https://api.moonshot.cn/v1` |

预设只填写类型和地址，并不代表该服务商的每个模型都在 LLMOJ 中测试过。

**推理强度**按以下方式传递；你的模型必须支持收到的参数。
- **DeepSeek**（`api.deepseek.com`）：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 或 `ultra`。`none` 关闭思考，其他值以该强度开启思考。
- **Anthropic：** 为空或 `none` 时不开启思考。数字表示思考的 token 预算：至少 1024，且小于输出 token 上限。其他值以该强度请求自适应思考。
- **阿里云**（`dashscope.aliyuncs.com`，`chat`）：`none` 关闭思考，其他值开启思考；数字还会设置思考预算。
- **OpenRouter**（`chat`）：`none` 关闭推理，其他值设置推理强度。
- **其他 `chat` 服务商**按原样收到 `reasoning_effort`。

### 断线恢复

开启 **断线恢复** 后，`responses` 请求在服务商处后台运行（`background: true`、`store: false`），LLMOJ 保存响应 ID 并轮询结果。连接中断时，任务可以继续获取同一个响应，而不必为新请求付费；如果只是回复丢失，LLMOJ 永远不会重新发送原请求。`auto` 只对官方 `api.openai.com` 使用这一方式；`background` 为其他支持的服务商开启（`api.deepseek.com` 不支持）；`off` 关闭。修改密钥、地址或请求内容后会成为新的请求。

### 搜索与 MCP

Tavily 以 `advanced` 搜索请求最多五条结果。MCP 服务器通过 Streamable HTTP（JSON 或事件流）访问，使用 `initialize`、`notifications/initialized`、`tools/list` 和 `tools/call`；不支持本地 stdio MCP 服务器。查询以工具接受的 `query`、`search_query` 或 `q` 传递，接受时还会加上 `max_results=5`；需要其他参数的工具可能无法使用。对于 Tavily 托管的 MCP，LLMOJ 会自行把密钥加到地址中：不要把密钥写进 Base URL。

没有搜索密钥时，**出处**操作会以 `SEARCH_NOT_CONFIGURED` 失败，组合操作则跳过查找出处并继续。无法核实的出处永远不会被当作原题。

## 权限与任务

| 操作 | 需要 |
| --- | --- |
| 修改 AI 配置、获取模型列表、测试连通性 | `ManageAiConfiguration`，只能操作自己的配置 |
| 对题目启动或重试 AI 操作 | `UseAi` 和修改该题的权限 |
| 生成测试数据（`testdata`、`all`） | 另外需要 `GenerateTestdata` 和编辑该题数据的权限 |
| 导入题目（包括 ZIP 附件） | `UseAi`、`ImportProblem`、`GenerateTestdata` 和创建题目的权限 |
| 查看或取消任务和用量 | 只能查看自己的。管理员也看不到其他用户的密钥 |

写入任何内容之前都会再次检查权限。如果任务运行期间有人修改了题面、样例或评测设置，或者你的权限被撤销，任务会以冲突或权限错误停止，而不会覆盖这些修改。

- 任务在开始时读取你的配置，并在整个过程中使用它。修改只对之后启动（或重试）的任务生效。
- 全站同时最多运行 8 个任务，每道题同时只有一个。每位用户最多同时运行 **最大并行 AI 任务数** 个任务，运行中和排队中的总数最多 100 个。调低上限不会停止正在运行的任务。
- 生成的程序由本机评测机编译和运行，它同时最多运行三个 AI 流程，并与普通评测共用评测槽；见[评测配置](Judge-Configuration.zh-CN.md)。
- **导入**依次执行：识别题面、出处、翻译、标签、难度、题解、测试数据。**全部**执行同样的步骤但不创建题目；**元数据**只执行出处、翻译、标签和难度。
- 可以要求生成 5～1000 组测试数据（默认 20 组）。为了让子任务分数能够整除，数量可能会被调高（最多 1000），页面会提示。导入支持传统题、交互题和通信题（通信方式为 `run-twice` 或 C++ `grader`，自动识别或手动选择）；提交答案题请手动创建。
- 导入接受最大 10 MiB 的题面文件（Markdown 或文本，或 PNG、JPEG、WebP、GIF 图片），以及最大 64 MiB 的 ZIP 附件。

## 站点限制

站点管理员可以在 **网站管理**（`/site-management`）的 **AI** 部分限制 AI 的使用。修改立即对所有账号生效，并写入审计日志。

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| **暂停 AI** | 关闭 | 暂停期间不会发出任何 AI 请求：没有模型调用、搜索、模型列表或连通性测试。正在进行的请求会完成。排队中和运行中的任务会等待，恢复后从中断处继续 |
| **每个账号 24 小时内的 token 数** | 0（不限制） | 服务商报告的输入和输出 token，按任意 24 小时计算 |
| **每个账号 24 小时内的模型和搜索请求数** | 0（不限制） | 模型生成和联网搜索的次数，按任意 24 小时计算 |
| **每个任务的模型和搜索请求数** | 500 | 一个任务所有尝试（包括重试）的总数（0 表示不限制） |
| **同时进行的 AI 请求数** | 16 | 全站（每个后端进程）的数量。任务会等待空位；没有空位时，模型列表和连通性测试会被拒绝 |

限制计入请求所使用的配置（也就是服务商密钥）所属的账号。模型列表、后台响应的进度查询和 MCP 握手不计为请求，但同样会在暂停时停止，并等待空位。连通性测试会计入：它会发出真实的模型请求或搜索。

**token 如何计算。** 模型请求发出之前，会先占用它可能使用的最大 token 数：输出上限，加上对输入的宽松估计（每个 token 约三个英文字符或一个中文字符，每张图片 4096）。服务商报告实际用量后，用报告的数字代替占用的数量。如果服务商没有报告，或请求被中断，占用的数量会一直按最大值计算。服务商以错误状态拒绝的请求不计入。因此，如果已用量加上请求可能的用量会超过上限，请求就会被拒绝；如果单个请求的输出上限本身就超过上限，则会提示调低 **输出 token 上限**。

用户可以在 **用量** 中查看自己最近 24 小时内已使用的额度，包括仍被占用的 token。

任务因限制而停止时，会以说明是哪项限制的信息失败，并保留进度：额度允许后可以重试。这些额度不是金额：LLMOJ 不知道服务商的价格，被中断的请求也可能仍被服务商收费。

暂停 AI 不会清空队列：[升级器](Upgrade.zh-CN.md)仍会等待排队中的 AI 任务，因此升级前请取消它们或等待其完成。

## 测试数据验证与覆盖

对于传统题，生成的测试数据在发布前要通过以下检查：

1. **规划。** 模型分析题目的限制、退化情形和复杂度，规划覆盖方案：正确算法、用于小数据的精确检查程序（“oracle”），以及一到四个需要击败的、看似合理的错误或过慢程序，其中至少一个是错误程序。
2. **独立程序。** 小数据生成器、oracle 和另一个高效解法各自单独编写，只依据题面、限制和规划，看不到主生成器或参考解法。oracle 优先使用简单的穷举方法；如果没有合法的极小数据，则使用在最小合法规模下可行的精确方法。
3. **对拍。** 至少 64 组合法的小数据（子任务超过 64 个时更多），覆盖每个子任务，先由独立的校验器检查，然后参考解法和另一个解法都必须与 oracle 在全部数据上一致。
4. **交叉检查。** 每组最终测试数据都用另一个解法检查，并使用真实的 checker，因此多解和浮点输出的题目不会逐字比较。
5. **挑战。** 规划中的错误和过慢程序会被编译和运行，每个都必须在导出的某组最终测试数据上失败。

只有全部检查通过，数据才会发布。

挑战程序必须通过所有官方样例。错误程序必须在其针对的每个子任务中至少通过一组小数据，过慢程序必须通过其适用的所有小数据。错误程序在最终测试数据上答案错误、运行错误、超时或超内存都算被击败；过慢程序只有真正超出时间或内存限制才算（答案错误或崩溃会使该探测无效）。编译错误、checker 失败和基础设施错误都不算击败程序。

生成器会为每个目标构造特定的合法输入，而不只依赖大规模随机数据。例如，最短路题中的 SPFA 只有在限制允许构造出真正让它超时的图时，才会被当作“过慢”目标；程序永远不会因算法名称而被拒绝，合法的其他算法会被真实的 checker 接受。

如果某个目标通过了第一批最终测试，最多再尝试 16 次构造反例。有用的反例会替换同一子任务中的一组普通数据；最小和最大边界数据以及所有已有反例都会保留，数据组数和子任务分数不变。如果仍有目标存活，生成失败，数据不会发布。

任务页面会显示对拍数量、另一个解法的检查结果、每个目标的结果以及击败它的测试数据；`result.testdataQuality.extraAttemptsUsed` 记录额外尝试次数。`data.yaml` 记录规划（`qualityPlan`）、结果（`qualityValidation`）、最终数据编号（`finalCaseIndices`）以及辅助程序的 SHA-256（`verificationSources`）。`seed` 是场景编号而不是随机种子：导出的输入本身就是证据。辅助程序只保存在任务中，不会随数据发布。

交互题和通信题保留其协议模拟和检查，但无法使用这种独立测试，并会收到 `TESTDATA_QUALITY_PROTOCOL_UNSUPPORTED` 警告。无论通过多少测试，都不能证明所有错误或过慢的程序都会失败，也不能证明参考解法正确。这些检查需要更多的模型调用、费用和时间；见 [AI 环境](AI-Environment.zh-CN.md)。

## 上传、取消与失败

- 文件上传成功后才会创建任务。**取消上传** 可以停止准备或上传，离开页面也会取消它们。服务器接受任务之后，关闭页面不会停止任务：请在 **我的 AI 任务** 中取消。如果启动任务超时，请先在 **我的 AI 任务** 中查看，再决定是否重新导入。
- 取消无法撤销服务商已经收取的费用，也无法撤销任务已经发布的内容。
- 如果生成的 `make.cpp` 无法编译，模型有一次修复的机会。上传的 checker、交互器、manager 和 grader 永远不会被改写。第二次失败、样例失败或数据检查失败都会使任务失败。
- 题解在发布前会检查其中关于出处和计分的说法；这不能代替你自己审阅其中的算法。
- 如果浏览器无法读取文件（例如以 Snap 安装的 Firefox 读取 root 拥有的文件），请把文件复制到桌面用户拥有的文件夹。不要关闭浏览器的沙箱。

## AI 在哪里运行，密钥保存在哪里

模型和搜索请求由后端发出。编译和运行生成的程序使用**同一台服务器**上的评测机，通过本机 socket 进行（`all` 模式）；在 `web` 站点上则通过评测队列使用远程评测机，结果相同。见[分布式评测](Distributed-Judging.zh-CN.md#ai)。

AI 配置保存在 `ai_configuration` 表中，每份都用站点主密钥以 AES-256-GCM 加密，主密钥默认为 `data/ai/master.key`（目录权限 `0700`，密钥 `0600`，所有者都是后端的运行用户）。如果已有保存的配置但密钥缺失，后端会拒绝启动，而不是创建新密钥。**请同时备份数据库和主密钥**：其他密钥无法解密。见 [AI 环境](AI-Environment.zh-CN.md)。

用量记录保存每次请求的服务商、模型、耗时和报告的用量，从不保存密钥、提示词或回复。**用量** 可显示 1～366 天（默认 30 天）；服务商没有报告的用量在那里不做估计，失败和重试的请求都计为调用。

## 题解与自测

AI 撰写的题解显示在题目的 **题解** 标签和作者的 **我的讨论** 中；见[题解](Solutions.zh-CN.md)。

为传统题发布正式数据时，还会保存生成这些数据的 make.cpp、std.cpp 和输入校验器，供之后开启[自测](Self-Evaluation.zh-CN.md)的 NOI / OI 比赛使用。在 **配置 Self Eval** 中，**AI 生成正式数据与 Self Eval 程序** 会运行测试数据操作，并使用该管理员自己的 AI 配置和权限。

## 来源

[ai.dto.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.dto.ts)、[ai.types.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.types.ts)、[ai-provider.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-provider.ts)、[ai-admission.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-admission.service.ts)、[ai-responses.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-responses.ts)、[ai.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.service.ts)、[ai-workflow.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-workflow.service.ts)、[ai-job-coordinator.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-job-coordinator.service.ts)、[ai-artifact-publisher.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-artifact-publisher.service.ts)、[ai-crypto.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-crypto.ts)、[ai-testdata-quality.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-testdata-quality.ts)、[aiQuality.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiQuality.ts)、[aiRunner.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiRunner.ts)。
