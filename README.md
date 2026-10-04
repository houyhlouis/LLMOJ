# LLMOJ

简体中文 | [English](README.en.md)

**LLMOJ 是基于 LibreOJ 的在线评测平台，面向算法竞赛、日常训练与 AI 辅助出题。** 它将题库、比赛、评测和用户权限管理整合在一起，并提供题面整理、翻译、来源检索及测试数据生成等 AI 工作流。

[使用文档](wiki/Home.zh-CN.md) · [AI 配置](wiki/AI.zh-CN.md) · [分布式评测](wiki/Distributed-Judging.zh-CN.md) · [问题反馈](https://github.com/houyhlouis/LLMOJ/issues)

## 功能特性

### 题库、竞赛与权限管理

- 中英文界面与浏览器代码编辑器，支持题目管理、题单、讨论及提交记录查询。
- 支持 NOI、IOI、ICPC 赛制，提供比赛权限、排行榜和重评功能。
- 支持多用户、用户组、题目与讨论授权，以及比赛和管理功能的权限控制。

### 多语言评测与扩展

- 支持 C/C++、Python、Java 等语言，以及传统题、交互题、通信题和提交答案题。
- 采用 LibreOJ 的 `simple-sandbox` 与原版 rootfs 配方，提供进程、文件系统、网络隔离和资源限制。
- 普通提交可由本机或多台远程评测机处理；每台评测机使用独立凭据连接，并按需下载测试文件。

### AI 辅助出题与学习

- **题面与题解：** 整理导入内容、跨语言翻译，辅助生成标签、难度建议和题解草稿。
- **来源检索：** 结合搜索结果与语义核对，辅助查找题目原始出处。
- **测试数据：** 生成标程、数据生成器和校验程序，在沙盒中编译、运行与校验，通过后写入测试文件与评测配置。
- **任务管理：** 查看进度，取消或重试任务；写入题目时重新检查用户权限和题目版本。
- **独立配置：** 用户配置自己的模型与搜索服务（Tavily/MCP），API Key 加密保存；支持 HTTP/HTTPS、公网、内网及本机服务地址。

AI 生成内容需要审核。标程验证和测试数据生成的执行环节依赖网页节点上的本机沙盒；部署模式和配置方法见下文及 [AI 文档](wiki/AI.zh-CN.md)。

## 一键安装

### 环境要求

| 项目 | 要求 |
| --- | --- |
| 已验证系统 | Ubuntu 24.04 amd64，普通虚拟机或物理机 |
| 内存 | 至少 3 GiB，编译建议 8 GiB |
| 空闲磁盘 | 完整安装至少 30 GiB，建议 40 GiB；仅网页模式至少 10 GiB |
| 系统与网络 | systemd 254+、cgroup v2；能够访问软件源、GitHub 及构建依赖下载源 |

在服务器终端运行中文安装入口：

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/install.zh-CN.sh -o /tmp/llmoj-install.zh-CN.sh && \
  sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ
```

脚本会交互设置部署模式、端口、域名、站名、安装目录和 Docker 源，随后安装依赖、构建应用并配置服务。完整模式还会构建评测 rootfs，首次安装需要等待下载和编译完成。

默认安装到 `/opt/LibreOJ`，站点监听 `0.0.0.0:80`，浏览器访问 `http://服务器IP`。自定义端口、镜像源、无人值守安装及固定版本方法见 [安装教程](wiki/Installation.zh-CN.md)。

### 安装后

1. **登录管理账号：** 安装成功后，终端直接打印 `admin` 与随机密码；服务器同时保存 `config/admin-credentials.json`（默认位于 `/opt/LibreOJ`，仅 root 可读）。首次登录后修改密码，重跑安装不会重置账号密码。
2. **开始使用：** 创建用户、配置权限并添加题目，提交一个简单程序确认评测结果，再按需创建题单或比赛。
3. **配置 AI：** 具有 AI 配置权限的用户填写自己的服务地址、模型和 API Key，并执行连接测试；项目不提供共享 Key 或预付费服务。

公网使用请配置 [HTTPS](wiki/HTTPS.zh-CN.md)，并在防火墙或云安全组中放行选定的网站端口。安装器不会自动修改防火墙规则。

## 部署模式

| 模式 | 包含内容与用途 |
| --- | --- |
| `--role all`（默认） | 网页、存储、本机评测和 AI 执行环境；可再添加远程评测机分担普通提交 |
| `--role web` | 网页和存储，不构建本机 rootfs；普通提交需接入远程评测机 |

需要 AI 标程验证和数据生成时，网页节点使用 `all`。远程普通评测机不会自动替代本机 AI worker。详细架构图、节点注册和部署步骤见 [分布式评测](wiki/Distributed-Judging.zh-CN.md)。

## 文档与开发

| 文档 | 内容 |
| --- | --- |
| [安装与配置](wiki/Installation.zh-CN.md) · [Docker 源](wiki/Docker-Sources.zh-CN.md) | 安装参数、镜像源、服务管理与重试 |
| [分布式评测](wiki/Distributed-Judging.zh-CN.md) · [独立评测机](wiki/Remote-Judge.zh-CN.md) | 系统架构、网页与评测分离、节点接入 |
| [AI 功能](wiki/AI.zh-CN.md) · [HTTPS](wiki/HTTPS.zh-CN.md) | 模型配置、执行环境与站点加密访问 |
| [开发说明](README-DEVELOPMENT.zh-CN.md) · [源码包](deploy/SOURCE-PACKAGE.zh-CN.md) | 构建、测试与发布文件范围 |

完整文档见 [中文 Wiki](wiki/Home.zh-CN.md) / [English Wiki](wiki/Home.md)。

## 许可与致谢

项目基于 LibreOJ，主体采用 [MIT](LICENSE)，保留上游版权和许可。感谢 LibreOJ 及相关开源组件的贡献者；第三方组件和 rootfs 配方遵循各自许可，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。
