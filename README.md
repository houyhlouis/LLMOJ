# LLMOJ

简体中文 | [English](README.en.md)

**LLMOJ 是基于 LibreOJ 的在线评测系统，适用于算法竞赛、日常训练和 AI 辅助出题。** 它集题库、比赛、评测和权限管理于一体，并提供整理题面、翻译、查找题目出处和生成测试数据等 AI 功能。

[项目仓库](https://github.com/houyhlouis/LLMOJ) · [使用文档](wiki/Home.md) · [AI 配置](wiki/AI.zh-CN.md) · [分布式评测](wiki/Distributed-Judging.zh-CN.md) · [问题反馈](https://github.com/houyhlouis/LLMOJ/issues)

## 功能

### 题库、比赛与社区

- 中英文界面，浏览器内代码编辑器；题库管理、题单、讨论和提交记录。
- [比赛赛制](wiki/Contest-Rules.zh-CN.md)：NOI / OI、IOI、ICPC 和严格 IOI（每个子任务取历次提交的最高分），支持排行榜和重测。
- 用户、用户组和细粒度权限：题目与讨论可单独授权，比赛和管理功能可分别授予。
- [私人团队](wiki/Teams.zh-CN.md)：在个人主页的“我的团队”中通过团队编号加入，不公开团队列表；团队内有分组与权限、题库、比赛、题单作业、讨论和共享文件（共 10 GiB，大文件自动分块上传）。
- [题解](wiki/Solutions.zh-CN.md)：在题目页内阅读和撰写，也可由 AI 生成。
- [Hack](wiki/Hacks.zh-CN.md)：在提交详情页用反例挑战一份提交；成功后该提交成绩作废，证据保留。
- [自测（Self Eval）](wiki/Self-Evaluation.zh-CN.md)：NOI / OI 比赛可选开启，选手用隐藏的预测试数据检验程序，不计正式成绩，默认每人全场 30 次。
- [Fake 处罚](wiki/Submission-Moderation.zh-CN.md)：作弊提交的成绩归零并同步更新统计，代码和评测记录作为证据保留。
- 注册方式可在“网站管理”中切换为开放、[审核](wiki/Registration-Approval.zh-CN.md)或关闭，保存即生效；审核工作可委派给其他用户。
- [两步验证](wiki/Two-Factor-Sign-In.zh-CN.md)：支持验证器应用和通行密钥（Passkey）。

### 评测

- 支持 C/C++、Python、Java 等 12 种语言，以及传统题、交互题、通信题和提交答案题。
- 沙箱基于 LibreOJ 的 `simple-sandbox` 与原版 rootfs：独立的进程、文件系统和网络环境，cgroup 资源限制，以及拒绝危险系统调用的过滤器。
- 评测任务保存在数据库中，后端或评测机重启都不会丢失提交；修改题目不会影响已在排队的提交，重测前的结果会保留。
- 可由本机评测，也可接入多台[远程评测机](wiki/Distributed-Judging.zh-CN.md)；每台使用独立密钥，可在“评测机”页面暂停派发任务（排空）以便维护。

### AI 辅助出题

- **题面与题解：** 整理导入的题面，翻译，建议标签和难度，撰写题解草稿。
- **出处查找：** 结合搜索结果和语义比对，帮助找到题目的原始出处。
- **测试数据：** 传统题先用独立的参考算法对拍至少 64 组小数据，再用另一份正解交叉检验全部数据，并要求预先准备的错误或低效程序确实被数据卡掉，之后才安装数据，同时保存验证报告。交互题和通信题通过模拟交互协议检验。
- **任务管理：** 查看进度，取消或重试；写入题目前会重新检查权限和题目是否已被修改。
- **自备服务：** 用户填写自己的模型与搜索服务（Tavily / MCP），API Key 加密保存。内网和本机地址只供站点管理员使用，或由服务器管理员通过 `HYHOJ_AI_PRIVATE_HOSTS` 开放。
- **站点限制：** 管理员可以暂停全站的 AI，并限制每个账号 24 小时内的 token 数和请求数、每个任务的请求数，以及同时进行的 AI 请求数。每个请求在发出前都会经过检查。

AI 生成的内容需要人工审核。验证标程和生成测试数据需要在网页服务器上运行本机沙箱，详见 [AI 文档](wiki/AI.zh-CN.md)。

## 安装

### 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Ubuntu 24.04 amd64（已验证），虚拟机或物理机 |
| 处理器与内存 | 至少 2 个逻辑 CPU；每个评测执行槽需 256 MiB 内存；编译构建建议 8 GiB 内存 |
| 磁盘 | 完整安装至少 30 GiB 可用空间（建议 40 GiB），仅网页模式至少 10 GiB |
| 其他 | systemd 254 以上、cgroup v2；能访问软件源、GitHub 和构建依赖的下载源 |

在服务器上运行中文安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/install.zh-CN.sh -o /tmp/llmoj-install.zh-CN.sh && \
  sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ
```

脚本会依次询问部署模式、端口、域名、站点名称、安装目录和 Docker 源，然后安装依赖、构建程序并配置服务。完整模式还要构建评测用的 rootfs，首次安装需要较长时间下载和编译。

默认安装在 `/opt/LLMOJ`，网站监听 `0.0.0.0:80`，用浏览器访问 `http://服务器IP` 即可。自定义端口、镜像源、无人值守安装和指定版本见[安装教程](wiki/Installation.zh-CN.md)。

完整模式会询问评测执行槽的数量（可同时运行的评测程序数），默认值为“逻辑 CPU 数减 1”与“内存 MiB ÷ 256”中较小的一个。例如 3 个 CPU、512 MiB 内存时为 2 个槽；只有 1 个 CPU 或内存不足 256 MiB 时无法本机评测，请使用仅网页模式。安装后调整槽数请用[扩缩容脚本](wiki/Judge-Configuration.zh-CN.md)。

### 安装之后

1. **登录管理员账号：** 安装完成时，终端会显示用户名 `admin` 和随机密码，它们也保存在安装目录下的 `config/admin-credentials.json`（仅 root 可读）。首次登录后请修改密码；重新运行安装脚本不会重置密码。
2. **开始使用：** 创建用户、分配权限、添加题目，提交一个简单程序确认评测正常，再按需创建题单或比赛。
3. **配置 AI：** 拥有 AI 配置权限的用户填写自己的服务地址、模型和 API Key，并测试连接。本项目不提供共享的 Key 或付费服务。

公网访问请配置 [HTTPS](wiki/HTTPS.zh-CN.md)，并在防火墙或云安全组中放行网站端口；安装脚本不会修改防火墙。

## 升级

已用一键脚本安装的实例可以这样升级：

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/upgrade.zh-CN.sh -o /tmp/llmoj-upgrade.zh-CN.sh && \
  sudo bash /tmp/llmoj-upgrade.zh-CN.sh --prefix /opt/LLMOJ
```

升级脚本先检查兼容性，在临时目录中构建新版本并备份，经确认后才切换版本；账号、题库、API Key、配置和评测槽数都会保留。加上 `--plan` 可以只做检查、不做任何修改。升级前请暂停新提交，并等待本机和远程评测机以及 AI 任务完成。不兼容的依赖、运行环境或数据库变更会被拒绝，因此不保证能从任意旧版本直接升级。参数和回滚方法见[升级教程](wiki/Upgrade.zh-CN.md)；各项功能带来的数据库修改见[功能升级](wiki/Community-Upgrade.zh-CN.md)。

## 部署模式

| 模式 | 内容 |
| --- | --- |
| `--role all`（默认） | 网站、存储、本机评测和 AI 执行环境；可再接入远程评测机分担评测 |
| `--role web` | 只有网站和存储，不构建 rootfs；提交需由远程评测机评测 |

需要 AI 验证标程和生成测试数据时，网页服务器请使用 `all` 模式；远程评测机不能代替本机的 AI 执行环境。架构图、评测机注册和部署步骤见[分布式评测](wiki/Distributed-Judging.zh-CN.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [安装教程](wiki/Installation.zh-CN.md) · [Docker 源](wiki/Docker-Sources.zh-CN.md) | 安装参数、镜像源、服务管理与重试 |
| [分布式评测](wiki/Distributed-Judging.zh-CN.md) · [远程评测机](wiki/Remote-Judge.zh-CN.md) · [评测机配置](wiki/Judge-Configuration.zh-CN.md) | 架构、评测机接入、沙箱与容量 |
| [注册审核](wiki/Registration-Approval.zh-CN.md) · [两步验证](wiki/Two-Factor-Sign-In.zh-CN.md) · [升级](wiki/Upgrade.zh-CN.md) | 注册设置、登录安全、升级与回滚 |
| [比赛赛制](wiki/Contest-Rules.zh-CN.md) · [Hack](wiki/Hacks.zh-CN.md) · [自测](wiki/Self-Evaluation.zh-CN.md) | 计分规则、Hack 与自测 |
| [AI 功能](wiki/AI.zh-CN.md) · [HTTPS](wiki/HTTPS.zh-CN.md) | 模型配置、执行环境、加密访问 |
| [开发说明](README-DEVELOPMENT.zh-CN.md) · [源码包](deploy/SOURCE-PACKAGE.zh-CN.md) | 构建、测试与源码发布范围 |

完整文档见 [中文 Wiki](wiki/Home.md) / [English Wiki](wiki/Home.en.md)。

## 许可与致谢

本项目基于 LibreOJ，主体代码采用 [MIT](LICENSE) 许可，并保留上游的版权和许可声明。感谢 LibreOJ 及各开源组件的贡献者。第三方组件和 rootfs 配方遵循各自的许可，详见[第三方声明](THIRD_PARTY_NOTICES.md)。
