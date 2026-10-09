# AI 运行环境变量与固定限制

[English](AI-Environment.md) | 简体中文 | [AI 账号配置](AI.zh-CN.md) | [全部环境变量](Environment.zh-CN.md) | [Judge 配置](Judge-Configuration.zh-CN.md)

本文按源码 `43a88bdd62fbf200889b36932fa921439a293190` 核对。以下运行变量控制后端与本机 AI runner 的目录和通信，不配置服务商账号。模型/搜索 Key、Base URL、模型、输出预算和每用户并发均在 `/ai/configuration` 保存到该用户的加密配置；没有用于代替该页面的 `OPENAI_API_KEY` 等 AI 提供商环境变量。

## 生产运行变量：完整清单

表中的回退值是程序未收到变量或收到空字符串时的默认值。一键安装会把安装根目录代入 systemd 的 `Environment=`：自定义安装根目录时，应以生成的服务配置为准，不要把下表的 `/opt/LibreOJ` 原样套用。

| 变量 | 读取进程 | 源码回退值 | 用途及必须保持的对应关系 |
| --- | --- | --- | --- |
| `HYHOJ_AI_STATE_DIR` | backend | `/opt/LibreOJ/data/ai` | 加密主密钥目录，包含 `master.key`；后端初始化时读取。已有加密账号配置时，不能移走/重新生成主密钥后继续使用原数据库。 |
| `HYHOJ_AI_GENERATED_DIR` | backend | `/opt/LibreOJ/data/ai-generated` | 读取、验证、发布 runner 的生成结果；必须与本机 judge YAML 的 `aiGeneratedDirectory` 一致。judge 不读取此环境变量。 |
| `HYHOJ_AI_SAMPLE_INPUTS_DIR` | backend 和 judge | `/opt/LibreOJ/data/ai-sample-inputs` | 后端准备私有样例、输入快照及受控辅助文件的暂存目录，runner 读取其中的受限文件；两进程必须使用同一目录。judge 在模块加载时读取一次。 |
| `HYHOJ_AI_RUNNER_SOCKET` | backend | `/opt/LibreOJ/data/judge/ai-runner.sock` | 后端连接本机 AI runner 的 UNIX socket；必须与 judge YAML 的 `aiRunnerSocket` 相同。judge 不读取此环境变量，也不接受远程 TCP runner 地址。 |
| `HYHOJ_ARCHIVE_WORK_DIRECTORY` | backend | `/opt/LibreOJ/data/backend-archives` | 共享的归档工作目录；AI ZIP 附件先在其中创建 `ai-attachment-*` 临时目录，再进行大小、路径和内容校验；其他归档操作也使用它。 |

这些值是文件系统路径，不是 URL；使用绝对路径并保留父目录的可穿越权限。环境变量不会替你搬迁已有数据，也不会自动更新另一进程的 YAML。`HYHOJ_ROOT` 是安装/配置脚本的输入，并非后端运行时自动替换上述回退值的开关。

模型调用发生在 backend；生成器、标程和 checker 等执行发生在同机 judge 的受限环境。远程普通 judge 与此 UNIX socket 流程不同。`--role all` 配置本机 runner，`--role web` 不单独提供 runner，远程评测配置生成器使用 `OJ_JUDGE_REMOTE=1`，在新建 judge YAML 时禁用 AI socket/生成目录（安装入口的 `--role` 只有 `all`、`web`）。部署关系见 [分布式评测](Distributed-Judging.zh-CN.md)。

## 目录、密钥和 socket 权限

以下是标准安装的预期状态，其中 `libreoj` 为后端服务用户/组：

| 路径或对象 | 所有者 / 模式 | 说明 |
| --- | --- | --- |
| `data/ai` | `libreoj:libreoj`，`0700` | 后端加密状态目录；初始化会检查目录所有权并收紧权限。 |
| `data/ai/master.key` | 后端服务用户，`0600` | 必须是 32 字节普通文件、单硬链接；不接受符号链接。数据库已有加密配置而该文件丢失时拒绝启动。 |
| `data/ai-generated` | `root:libreoj`，`0750` | runner 创建并验证非符号链接目录，结果由 root 写入，后端组读取。不要改为可被任意用户写入。 |
| `data/ai-sample-inputs` | `libreoj:libreoj`，`0700` | backend 写入，特权 runner 在验证路径、所有者、大小等条件后读取。 |
| `data/judge/ai-runner.sock` | `root:libreoj`，`0660` | runner 根据 YAML 的正整数 `aiRunnerGid` 设置组权限；并非开放网络接口。 |
| `backend-archives` 中 AI 临时子目录 | 后端服务用户，`0700` | 暂存上传内容；操作结束清理临时目录。工作目录还服务于其他归档操作。 |

不要通过放宽为 `0777` 解决读取失败，也不要复制 `master.key` 后意外使它归 root 所有。迁移主密钥必须保留对应数据库、原始字节、服务用户所有权与权限；备份应独立安全保存。详情见 [AI 密钥备份](AI.zh-CN.md#执行位置与密钥备份)。

### 修改与生效

1. 先等运行任务完成，保存现有配置与备份；目录迁移期间停止相关进程，避免一半任务读旧路径、一半读新路径。
2. 调整服务的环境设置；涉及生成目录/socket 时，同步调整 judge YAML；涉及样例目录时，两边都调整 `HYHOJ_AI_SAMPLE_INPUTS_DIR`。先建立正确所有者和模式的目标目录，再迁移必要数据。
3. 重新加载 systemd 配置并重启相关服务。仅修改当前终端的 `export` 或执行 `daemon-reload` 不会改变已有进程的环境。
4. 查看服务状态、日志中的错误类型及目录/socket 元数据；不要把密钥正文、完整配置、会话或上传签名 URL 发到日志/报告。先验证普通评测和小任务，确认双方路径一致。

例如只把后端归档临时目录迁到预先准备好的 `/srv/libreoj/backend-archives`，可通过 `sudo systemctl edit libreoj-backend.service` 添加：

```ini
[Service]
Environment=HYHOJ_ARCHIVE_WORK_DIRECTORY=/srv/libreoj/backend-archives
```

确保该目录及父目录允许后端服务用户访问后，再执行：

```sh
sudo systemctl daemon-reload
sudo systemctl restart libreoj-backend.service
sudo systemctl is-active libreoj-backend.service
```

这只是共享临时归档目录的示例，不是迁移整个 AI 数据目录的脚本。配置生成器会重写它管理的主 systemd 单元；已有私有 YAML 则保留并进行一致性检查，不会自动替换成新值。迁移时须自行同步 YAML，升级后复核自定义设置，避免手改主单元被覆盖。涉及 judge CPU 或执行槽位时使用 [Judge 配置教程](Judge-Configuration.zh-CN.md)，不要以增加 AI 任务并发代替 CPU 配置。

## 常见误区：不是运行配置的项目

| 名称 | 当前实际行为 |
| --- | --- |
| `HYHOJ_AI_PRIVATE_HOSTS` | **旧名称，当前生产实现不读取。** 仅残留在部分测试的设置/恢复逻辑中；设置它不会建立允许名单，清空它也不会阻止内网访问。当前允许 HTTP/HTTPS 的域名、内网及本机地址，按解析结果绑定连接且禁止跟随重定向。按账号权限管理谁能配置服务。 |
| `autoOnSave` | 账号 API 的兼容字段，不是环境变量；保存和读取均强制 `false`。旧 `automatic: true` 请求被跳过。 |
| `llm.maxTokens` / `maxConcurrentJobs` | 账号配置，不是 `NODE_OPTIONS` 或 judge 槽位。分别控制模型输出预算和每用户运行 AI 任务数。 |
| `aiRunnerSocket` / `aiGeneratedDirectory` / `aiRunnerGid` | judge YAML 字段，不是环境变量；详见 [Judge 配置](Judge-Configuration.zh-CN.md)。 |
| `LIBREOJ_CONFIG_FILE` / `LIBREOJ_JUDGE_CONFIG_FILE` | 通用配置文件定位变量，见 [全部环境变量](Environment.zh-CN.md)。`NODE_ENV`、`NODE_OPTIONS`、`PATH`、`TMPDIR`、`UV_THREADPOOL_SIZE` 也属于进程运行环境，不是服务商能力或 AI 额度开关。 |
| 浏览器读取/上传超时 | 前端源码常量，无受支持的环境变量覆盖入口，不能通过设置同名变量改变。 |

## 当前固定限制：不是可配置环境变量

这一节帮助理解超时和吞吐瓶颈；不要把源码常量误写入 systemd。以下值只对应本文版本。

| 环节 | 当前行为 |
| --- | --- |
| 浏览器读取文件 | `readBrowserFile` 默认 60 秒；出现权限/读取错误时可见报错，不继续上传。 |
| 导入准备与提交 | `prepareAttachment`、`ai/start` 各 30 秒；ZIP 上传 120 秒，单次上传尝试。取消/离页阻断尚未提交的异步流程；已被服务器接受的任务需在任务列表取消。 |
| 通用文件上传 | 通用 helper 的默认超时仍为 0（不设超时），AI 调用点显式覆盖。不要把 AI 的 120 秒限制推广到全站大文件上传。 |
| 模型 / 模型列表 | 单次生成请求最多 30 分钟；列模型请求 30 秒。慢模型仍受提供商限制或网络中断影响。 |
| 搜索 / MCP | 单次请求 60 秒；MCP 初始化、列工具、调用工具是不同请求，不等于整个业务最多 60 秒。 |
| Responses 恢复 | 默认轮询间隔 2 秒，瞬时错误时最多退避至 10 秒；单次轮询请求 30 秒，临时恢复窗口 120 秒，总期限按创建检查点起算 30 分钟。 |
| 调度 | 全局最多 8 个运行任务，每用户排队加运行最多 100；每用户默认运行 3、可配置 1–8。同一题串行。本机 runner 最多接纳 8 个任务，生成队列并行 3，共用实际 judge 槽位。 |
| runner socket | 请求体上限 16 MiB，后端未处理响应缓冲上限 1048576 个字符；最多 32 个连接，收到首个请求前有 30 秒连接超时。 |
| runner 输出与磁盘 | 普通输出单文件 16 MiB，输入样例单文件 256 MiB，总输出 8 GiB；生成时要求保留 2 GiB 磁盘余量。 |
| runner 执行等待 | 后端按案例数和标程限时计算等待预算，上限 4 小时；不是模型请求超时，也不是允许单个程序跑 4 小时。 |
| 临时生成结果 | 保留期 24 小时，runner 每小时清理符合其所有者/非活动等校验的过期目录；已发布题目数据有自己的持久存储。 |
| AI 生成器修复 | 只有 AI 生成的 `make.cpp` 明确编译失败可自动修复一次，预算持久化；不会无限重试用户提供的评测程序。 |

浏览器文件读取还受操作系统策略影响。曾复现 Snap Firefox 无权读取 root 拥有的测试文件，相同字节的当前用户副本可读。使用桌面用户有权读取的文件副本；不要关闭 AppArmor 或浏览器沙箱。该修复保证明确错误和取消流程，不能授予浏览器额外系统权限。

## 仅测试使用的变量

以下变量不应放进生产 systemd 单元。它们给仓库内主动运行的测试提供隔离资源，不是产品运行开关。测试可能写数据库、创建题目/任务和覆盖专用测试账号配置，应使用可丢弃环境。本文没有执行这些测试。

| 变量 | 默认 / 作用 | 使用范围与约束 |
| --- | --- | --- |
| `HYHOJ_AI_TEST_DB_CONFIG` | 不设置则相关 MariaDB 测试跳过；指定含 `services.database` 的 YAML 路径 | `ai-*.mariadb.test.cjs`；使用真实数据库及临时表。并非每个 CJS 套件都强制 `hyhoj_test_*` 名称，操作者必须选择可丢弃数据库，不能依赖后面的 MJS 防护。 |
| `HYHOJ_AI_TEST_RESULTS` | 可选 JSON 结果路径 | 部分 MariaDB CJS 套件写结果；某些临时目录也以其父目录为基准。父目录须存在且可写。 |
| `HYHOJ_TEST_CONFIG` | MJS 集成测试必填，后端 YAML 路径 | 共用 `integration-client.mjs`；数据库名必须为 `hyhoj_test_*` 且数据库主机为数字回环地址。Redis 要显式 URL、数字回环主机和非零专用数据库，不能使用端口 16379。 |
| `HYHOJ_TEST_STATE` | MJS 集成测试必填，JSON 状态文件路径 | 包含专用测试 `users` 和 `tokens`；文件含会话凭据，应私有保存，不纳入公开证据。 |
| `HYHOJ_TEST_BASE` | MJS 集成测试必填，API origin | 仅数字回环 HTTP/HTTPS，不接受凭据、查询、片段或子路径；拒绝端口 2002、29533，须部署独立测试 API。 |
| `HYHOJ_AI_FIXTURE_USER` | `ai_fixture` | MJS 模拟服务测试账号；拒绝 `admin`，用户/令牌必须已在测试状态中。已有真实服务配置不会被替换；检查只接受 `127.0.0.1:2230` 的模拟端点。 |
| `HYHOJ_TEST_SPJ` | 仅字符串 `1` 开启；默认关闭 | `ai-integration.test.mjs` 的 SPJ 测试路径。 |
| `HYHOJ_TEST_INVALID_INPUT` | 仅字符串 `1` 开启；默认关闭 | 同一集成测试的非法输入路径。 |
| `HYHOJ_TEST_EVIDENCE_DIR` | 可选截图目录 | `ai-browser.test.mjs` 保存浏览器证据；目录未设置则不保存这些截图。 |
| `BACKEND_ROOT` | 当前测试所在后端目录 | `ai-network-policy.test.cjs` 定位后端模块依赖；不是修改生产安装根目录的开关。 |
| `LAN_HOST` | 优先自动找本机私有 IPv4，其次其他非回环 IPv4 | 同一网络策略测试选择本机已绑定接口；传入其他主机地址会被拒绝，无可用接口时相关用例跳过。 |

测试里临时设置前述生产变量，是为了使用独立临时目录，不会使这些变量变成测试专属。模拟提供商验证协议/失败分支，不证明第三方在线服务质量；真实数据库、真实沙盒和真实浏览器各自证明其覆盖的层面。历史真实 DeepSeek/Tavily 部分业务与本次文档更新的边界见 [AI 验证范围](AI.zh-CN.md#已验证范围)。

## 源码依据

- [后端 AI 目录/socket 与调度](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai.service.ts)、[加密文件约束](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-crypto.ts)
- [AI runner](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/judge/src/aiRunner.ts)、[生成后端单元](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-local.py)、[生成 judge 配置/单元](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-judge.py)、[目录权限](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/install-support.py)
- [文件读取](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/utils/readBrowserFile.ts)、[AI 上传调用点](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/pages/ai/api.ts)、[导入取消/提交](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/pages/ai/AiImportPage.tsx)、[通用上传](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/packages/frontend/src/utils/callApiWithFileUpload.ts)
- [提供商超时与协议](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-provider.ts)、[Responses 恢复](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-responses.ts)
- [MJS 测试隔离约束](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/test/integration-client.mjs)、[专用账号约束](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-fixture-utils.mjs)、[网络测试变量](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/apps/backend/src/ai/ai-network-policy.test.cjs)
