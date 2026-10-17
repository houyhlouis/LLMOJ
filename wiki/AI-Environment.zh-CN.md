# AI 环境与固定限制

简体中文 | [English](AI-Environment.md) | [Wiki 首页](Home.md) | [AI](AI.zh-CN.md) | [环境变量](Environment.zh-CN.md) | [评测配置](Judge-Configuration.zh-CN.md)

本页面向服务器管理员：介绍 AI 功能使用的目录、密钥和 socket，以及它们的固定限制。每位用户的服务商、密钥、模型、输出上限和任务数量都在 **AI API 配置** 页面设置（见 [AI](AI.zh-CN.md)）；`OPENAI_API_KEY` 之类的环境变量不能代替它。全站的暂停和预算在 **网站管理** 中设置（见 [AI](AI.zh-CN.md#站点限制)）。

## 环境变量

安装器会在服务的 systemd 单元中按你的安装目录设置这些变量；下面的默认值只在变量缺失或为空时使用。

| 变量 | 读取者 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `HYHOJ_AI_STATE_DIR` | 后端 | `/opt/LLMOJ/data/ai` | 存放 `master.key`（以及 `two-factor.key`）。只要数据库中还有用它加密的配置，就绝不能删除或替换该密钥 |
| `HYHOJ_AI_GENERATED_DIR` | 后端 | `/opt/LLMOJ/data/ai-generated` | 后端读取 AI 任务结果的目录。必须与本机 `judge.yaml` 中的 `aiGeneratedDirectory` 一致 |
| `HYHOJ_AI_SAMPLE_INPUTS_DIR` | 后端和评测机 | `/opt/LLMOJ/data/ai-sample-inputs` | 交给 AI 任务的私有样例和输入文件。两个服务必须使用同一个目录 |
| `HYHOJ_AI_RUNNER_SOCKET` | 后端 | `/opt/LLMOJ/data/judge/ai-runner.sock` | 本机 AI 任务的 socket。必须与本机 `judge.yaml` 中的 `aiRunnerSocket` 一致 |
| `HYHOJ_ARCHIVE_WORK_DIRECTORY` | 后端 | `/opt/LLMOJ/data/backend-archives` | 压缩包的临时空间，包括检查中的 AI ZIP 附件 |
| `HYHOJ_AI_PRIVATE_HOSTS` | 后端 | 无 | 所有用户都可以使用的内网或本机服务商主机，用逗号或空格分隔，可带端口，例如 `llm.lan, 10.0.0.5:8000, [fd00::5]:8080`。不设置时，内网、本机回环和链路本地地址只能用于站点管理员自己的配置。公网地址无需列出 |

这些都是绝对的文件系统路径，不是 URL。设置它们不会移动已有数据，也不会修改另一个服务的配置；`HYHOJ_ROOT` 在运行时不会改变它们。

模型和搜索请求由后端发出；本机评测机负责编译和运行生成的程序。只有 `all` 模式有本机 AI 任务：远程评测机会关闭它，`web` 站点则没有。见[分布式评测](Distributed-Judging.zh-CN.md)。

## 目录、密钥与 socket

以 `libreoj` 作为后端的用户和组时，安装后有：

| 路径 | 所有者与权限 | 说明 |
| --- | --- | --- |
| `data/ai` | `libreoj:libreoj`，`0700` | 后端启动时会检查所有者并收紧权限 |
| `data/ai/master.key` | 后端用户，`0600` | 只有一个链接的 32 字节普通文件；拒绝符号链接。如果已有加密配置但密钥缺失，后端不会启动 |
| `data/ai/two-factor.key` | 后端用户，`0600` | 规则相同。用于加密[两步验证](Two-Factor-Sign-In.zh-CN.md)的身份验证器密钥，首次需要时创建。如果有用户设置了身份验证器，缺失的密钥永远不会被替换，他们的验证码将无法使用 |
| `data/ai-generated` | `root:libreoj`，`0750` | 由 AI 任务（root）写入，由后端读取。必须是真实目录，不能是链接 |
| `data/ai-sample-inputs` | `libreoj:libreoj`，`0700` | 由后端写入；AI 任务读取前会检查路径、所有者和大小 |
| `data/judge/ai-runner.sock` | `root:libreoj`，`0660` | 其所属组为 `judge.yaml` 中的 `aiRunnerGid`。这是本机 socket，不是网络端口 |
| `backend-archives` 下的 AI 目录 | 后端用户，`0700` | 临时目录，操作结束后删除 |

不要用 `0777` 解决访问问题，也不要让复制的 `master.key` 变成 root 所有。迁移密钥时，要与其数据库一起逐字节保留，并保持相同的所有者和权限，同时妥善保管其备份。见 [AI](AI.zh-CN.md#ai-在哪里运行密钥保存在哪里)。

### 修改目录

1. 等待正在运行的 AI 任务完成，备份配置，并停止相关服务，以免任务同时使用新旧两个路径。
2. 修改服务的环境变量。修改结果目录或 socket 时，还要修改 `judge.yaml`；修改样例目录时，两个服务都要修改。用正确的所有者和权限创建新目录，并迁移需要的数据。
3. 执行 `systemctl daemon-reload` 并重启服务。只在 shell 中设置变量，或只执行 `daemon-reload`，不会改变正在运行的服务。
4. 确认服务正常、目录和 socket 符合要求，然后试一次普通评测和一个小的 AI 任务。不要把密钥、配置、登录会话或带签名的上传链接贴到日志或报告中。

例如，只把压缩包工作目录移动到已准备好的 `/srv/libreoj/backend-archives`：运行 `sudo systemctl edit libreoj-backend.service` 并添加：

```ini
[Service]
Environment=HYHOJ_ARCHIVE_WORK_DIRECTORY=/srv/libreoj/backend-archives
```

确认后端用户可以访问该目录及其上级目录后：

```sh
sudo systemctl daemon-reload
sudo systemctl restart libreoj-backend.service
sudo systemctl is-active libreoj-backend.service
```

请像这样使用 drop-in，而不要直接修改主单元文件，配置脚本会重写它们。要修改 CPU 或评测槽，请使用[评测配置](Judge-Configuration.zh-CN.md)；AI 设置不能配置 CPU。

## 容易混淆的设置

| 名称 | 实际含义 |
| --- | --- |
| `llm.maxTokens`、`maxConcurrentJobs` | 每位用户在 AI 配置页面中的设置：单次请求的输出上限，以及其任务同时运行的数量。不是 `NODE_OPTIONS`，也不是评测槽 |
| 暂停、预算、同时进行的 AI 请求数 | **网站管理** 中的全站设置，保存在数据库中；见 [AI](AI.zh-CN.md#站点限制)。不是环境变量 |
| `aiRunnerSocket`、`aiGeneratedDirectory`、`aiRunnerGid` | `judge.yaml` 中的设置；见[评测配置](Judge-Configuration.zh-CN.md) |
| `autoOnSave` | 为兼容而保留，始终为 `false`；带 `automatic: true` 的请求会被忽略 |
| 浏览器读取和上传的时间限制 | 固定在前端中，没有变量可以修改 |

## 固定限制

以下限制固定在代码中；设置名称相似的变量不会有任何效果。

| 阶段 | 限制 |
| --- | --- |
| 在浏览器中读取文件 | 60 秒。读取或权限错误会显示出来，不会上传 |
| 开始导入 | 准备附件和启动任务各 30 秒；ZIP 上传 120 秒、只尝试一次。这些限制只适用于 AI 上传 |
| 模型请求 | 一次生成最长 30 分钟；获取模型列表 30 秒 |
| 搜索与 MCP | 每个请求 60 秒（MCP 的初始化、列出工具和调用是分开的请求） |
| 断线恢复 | 每 2 秒轮询一次，出错后逐步放慢到 10 秒；每次轮询 30 秒；连续 120 秒无法连接，或请求开始 30 分钟后放弃 |
| 任务 | 全站同时运行 8 个；每位用户运行中和排队中最多 100 个；每位用户同时运行 1～8 个（默认 3 个）；每道题同时一个。本机 AI 任务接受 8 个请求，同时运行 3 个流程，并共用评测槽 |
| AI 任务 socket | 请求最大 16 MiB；后端最多缓存 1048576 个字符的回复；最多 32 个连接，30 秒内没有请求即关闭 |
| AI 任务输出与磁盘 | 每个输出文件 16 MiB，每个样例输入 256 MiB，总计 8 GiB；生成时需要 2 GiB 空闲磁盘空间 |
| 测试数据检查 | 至少 64 组小数据（AI 任务接受 64～1000 组）、一个另外的解法（接受 1～3 个）、1～4 个挑战程序，以及最多 16 次额外的反例构造（接受 32 次） |
| 辅助程序 | 小数据生成器和 oracle 每次运行 5 秒、512 MiB；另一个解法和挑战程序使用题目自己的限制 |
| 等待 AI 任务 | 随数据组数和检查数量增加，总计最多 4 小时。这不是生成的程序可以运行的时长 |
| 临时结果 | 保留 24 小时，每小时清理一次。已发布的题目数据另外保存 |
| 预算占用记录 | 保留 48 小时后删除；只在最近 24 小时内计入 |
| 修复 `make.cpp` | 编译错误后自动修复一次 |

浏览器读取文件还受操作系统限制：以 Snap 安装的 Firefox 无法读取 root 拥有的测试文件，而由桌面用户拥有的副本可以读取。请使用这样的副本；不要关闭 AppArmor 或浏览器的沙箱。

## 仅用于测试的变量

不要在生产服务中设置它们。它们让测试使用可丢弃的资源；测试会写入数据库、创建题目和任务，并替换夹具账号的配置。

| 变量 | 用途 |
| --- | --- |
| `HYHOJ_AI_TEST_DB_CONFIG` | 供 `ai-*.mariadb.test.cjs` 使用的、包含 `services.database` 的 YAML 文件；这些测试使用真实数据库和临时表。请指向可丢弃的数据库。不设置时跳过。其中的 ZIP 用例要求临时目录（`TMPDIR`）至少有 2 GiB 可用空间 |
| `LLMOJ_AI_BUDGET_TEST_DB_CONFIG` | 供 `ai-budget.mariadb.test.cjs` 使用的、包含 `services.database` 的 YAML 文件，需要一个空的可丢弃数据库 |
| `HYHOJ_AI_TEST_RESULTS` | 部分数据库测试可选的 JSON 结果文件；其所在目录必须已存在 |
| `HYHOJ_TEST_CONFIG` | 集成测试使用的后端 YAML：数据库名必须以 `hyhoj_test_` 开头，主机必须是本机回环地址，Redis 必须是本机上专用的非零数据库（不能是 16379 端口） |
| `HYHOJ_TEST_STATE` | 包含集成测试夹具 `users` 和 `tokens` 的 JSON 文件；请勿公开 |
| `HYHOJ_TEST_BASE` | 测试 API 的地址：只能是本机回环的 HTTP 或 HTTPS，不含凭据、查询参数或路径；拒绝 2002 和 29533 端口 |
| `HYHOJ_AI_FIXTURE_USER` | 模拟服务商测试使用的账号（默认 `ai_fixture`，不能是 `admin`）；只有当其配置指向 `127.0.0.1:2230` 的模拟服务时才会被替换 |
| `HYHOJ_TEST_SPJ`、`HYHOJ_TEST_INVALID_INPUT` | 设为 `1` 时开启 `ai-integration.test.mjs` 中的 SPJ 和无效输入用例 |
| `HYHOJ_TEST_EVIDENCE_DIR` | `ai-browser.test.mjs` 保存截图的目录；不设置时不保存 |
| `BACKEND_ROOT`、`LAN_HOST` | `ai-network-policy.test.cjs` 用来找到后端的依赖并选择本机网络接口 |

模拟服务商只测试协议和错误处理，不代表真实服务的质量。更多测试变量见[开发说明](../README-DEVELOPMENT.zh-CN.md#数据库测试)。

## 来源

[ai.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai.service.ts)、[ai-crypto.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-crypto.ts)、[ai-admission.service.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-admission.service.ts)、[aiRunner.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiRunner.ts)、[configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-local.py)、[configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py)、[install-support.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/install-support.py)、[readBrowserFile.ts](https://github.com/houyhlouis/LLMOJ/blob/main/packages/frontend/src/utils/readBrowserFile.ts)、[ai-provider.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-provider.ts)、[ai-responses.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-responses.ts)、[ai-testdata-quality.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/ai/ai-testdata-quality.ts)、[aiQuality.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/aiQuality.ts)。
