# LLMOJ

简体中文 | [English](README.en.md)

**LLMOJ 是基于 LibreOJ 的在线评测平台，面向算法竞赛、日常训练与 AI 辅助出题。** 它将题库、比赛、评测和用户权限管理整合在一起，并提供题面整理、翻译、来源检索及测试数据生成等 AI 工作流。

[项目仓库](https://github.com/houyhlouis/LLMOJ) · [使用文档](wiki/Home.md) · [AI 配置](wiki/AI.zh-CN.md) · [分布式评测](wiki/Distributed-Judging.zh-CN.md) · [问题反馈](https://github.com/houyhlouis/LLMOJ/issues)

## 功能特性

### 题库、竞赛与权限管理

- 中英文界面与浏览器代码编辑器，支持题目管理、题单、讨论及提交记录查询。
- 支持 [NOI / OI、IOI、ICPC 与严格 IOI 赛制](wiki/Contest-Rules.zh-CN.md)，提供比赛权限、排行榜和重评功能；严格 IOI 按子任务合并历次最高分。
- 支持多用户、用户组、题目与讨论授权，以及比赛和管理功能的权限控制。
- [私人团队](wiki/Teams.zh-CN.md)：从自己的个人主页进入“我的团队”，通过团队编号加入；免审核、申请审核或邀请均不公开团队目录，支持分组与分权、题库、比赛、题单作业、讨论和文件共享。
- [题解](wiki/Solutions.zh-CN.md)：在题目页内查看和撰写，保留讨论回复与“我的讨论”，支持旧讨论明确分类和 AI 题解；顶部导航和讨论区不增加独立题解专区。
- [Fake 评测](wiki/Submission-Moderation.zh-CN.md)：保留作弊证据并将有效成绩归零，同步更新通过题统计、比赛和作业计分。
- [Hack](wiki/Hacks.zh-CN.md)：从具体提交详情提供反例；管理员在代码编辑器中维护题目 STD，或将已通过提交设为 STD。Hack 页沿用提交列表样式，仅展示记录、筛选和“我的 Hack”；成功后保留证据并作废目标成绩。
- [Self Eval](wiki/Self-Evaluation.zh-CN.md)：仅 NOI / OI 比赛可选择开启，入口在比赛题目页；赛前在代码编辑器填写 `make.cpp`、`std.cpp`，沿用正式 SPJ，AI 也可生成并绑定同版程序。固定隐藏预测试集不计正式成绩，默认每位选手全场最多 30 次。
- 权限管理新增团队访问与创建、团队管理、Fake、Hack 查看／创建／管理和自测权限，网站级禁止规则与团队私有内容限制依然生效。
- 管理员可在“网站管理”网页切换开放注册、注册审核或关闭注册，保存立即生效，无需重启；也可委派审核，已拒绝申请可改为通过。
- 页脚随站点名称显示“站点名称 Powered by LLMOJ”，保留自定义版权说明。

### 多语言评测与扩展

- 支持 C/C++、Python、Java 等语言，以及传统题、交互题、通信题和提交答案题。
- 采用 LibreOJ 的 `simple-sandbox` 与原版 rootfs 配方，提供进程、文件系统、网络隔离和资源限制。
- 普通提交可由本机或多台远程评测机处理；每台评测机使用独立凭据连接，并按需下载测试文件。

### AI 辅助出题与学习

- **题面与题解：** 整理导入内容、跨语言翻译，辅助生成标签、难度建议和题解草稿。
- **来源检索：** 结合搜索结果与语义核对，辅助查找题目原始出处。
- **测试数据：** 传统题先用独立参考算法完成至少 64 组小数据对拍，再由另一份正解交叉校验正式数据；针对错误或低效实现构造反例，所有目标均被实际拦截后才安装数据，并保存验证报告。交互题和通信题使用协议模拟校验。
- **任务管理：** 查看进度，取消或重试任务；写入题目时重新检查用户权限和题目版本。
- **独立配置：** 用户配置自己的模型与搜索服务（Tavily/MCP），API Key 加密保存；支持 HTTP/HTTPS 与公网服务地址；内网及本机地址限站点管理员使用，或由服务器管理员通过 `HYHOJ_AI_PRIVATE_HOSTS` 开放。

AI 生成内容需要审核。标程验证和测试数据生成的执行环节依赖网页节点上的本机沙盒；部署模式和配置方法见下文及 [AI 文档](wiki/AI.zh-CN.md)。

## 一键安装

### 环境要求

| 项目 | 要求 |
| --- | --- |
| 已验证系统 | Ubuntu 24.04 amd64，普通虚拟机或物理机 |
| 评测资源 | 至少 2 个有效逻辑 CPU；每个执行槽按 256 MiB 有效内存计算，编译建议 8 GiB |
| 空闲磁盘 | 完整安装至少 30 GiB，建议 40 GiB；仅网页模式至少 10 GiB |
| 系统与网络 | systemd 254+、cgroup v2；能够访问软件源、GitHub 及构建依赖下载源 |

在服务器终端运行中文安装入口：

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/install.zh-CN.sh -o /tmp/llmoj-install.zh-CN.sh && \
  sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ
```

脚本会交互设置部署模式、端口、域名、站名、安装目录和 Docker 源，随后安装依赖、构建应用并配置服务。完整模式还会构建评测 rootfs，首次安装需要等待下载和编译完成。

默认安装到 `/opt/LLMOJ`，站点监听 `0.0.0.0:80`，浏览器访问 `http://服务器IP`。自定义端口、镜像源、无人值守安装及固定版本方法见 [安装教程](wiki/Installation.zh-CN.md)。

完整模式首次生成评测配置且未指定槽数时，会询问评测实例数（执行槽）；默认值和最大值均为 `min(有效 CPU 数-1, 有效内存 MiB//256, 511)`，不额外预留内存，默认不会超过最大值。例如至少 3 个有效 CPU、512 MiB 内存时默认 2 槽；1 核或内存不足 256 MiB 时不能本机评测，可使用仅网页模式。槽数不是 OS 线程数，已有安装请使用 [扩缩容脚本教程](wiki/Judge-Configuration.zh-CN.md)。Ubuntu 26.04 的数据库初始化问题已有隔离复现与修复流程，完整新装仍未验收，详见 [安装与排错](wiki/Installation.zh-CN.md)。

### 安装后

1. **登录管理账号：** 安装成功后，终端直接打印 `admin` 与随机密码；服务器同时保存 `config/admin-credentials.json`（默认位于 `/opt/LLMOJ`，仅 root 可读）。首次登录后修改密码，重跑安装不会重置账号密码。
2. **开始使用：** 创建用户、配置权限并添加题目，提交一个简单程序确认评测结果，再按需创建题单或比赛。
3. **配置 AI：** 具有 AI 配置权限的用户填写自己的服务地址、模型和 API Key，并执行连接测试；项目不提供共享 Key 或预付费服务。

公网使用请配置 [HTTPS](wiki/HTTPS.zh-CN.md)，并在防火墙或云安全组中放行选定的网站端口。安装器不会自动修改防火墙规则。

## 注册审核与版本升级

管理员从用户菜单进入“网站管理”（`/site-management`），选择开放、需审核或关闭注册并保存，立即生效，无需重启。网页设置保存在数据库并覆盖 YAML；未保存或选择“恢复服务器配置”时回退服务器配置。只有站点管理员能更改注册模式，审核权限和首页编辑权限不能代替管理员身份。

管理员或获授 `ManageRegistrationReviews` 的审核者从“注册审核”处理申请。待审核和已拒绝申请独立保存，切换模式不会自动激活；通过时才创建账户并分配用户 ID，原拒绝记录保留，已通过申请不能反转。详见 [注册审核](wiki/Registration-Approval.zh-CN.md)。

已有官方一键安装实例可使用独立升级入口：

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/upgrade.zh-CN.sh -o /tmp/llmoj-upgrade.zh-CN.sh && \
  sudo bash /tmp/llmoj-upgrade.zh-CN.sh --prefix /opt/LLMOJ
```

脚本检查兼容性、在暂存目录构建、备份并在确认维护窗口后切换版本，保留账号、题库、API Key、配置和评测槽数。先加 `--plan` 可只读检查。它支持已知兼容的官方 `all` / `web` 布局；依赖、运行时或数据库结构不兼容时会停止，不保证跨越任意历史版本。维护前须暂停新提交、等待本机及远程评测和 AI 任务结束。首次使用本功能时，先确认本次修改包已经上传到 GitHub；升级流程、参数和回滚见 [升级教程](wiki/Upgrade.zh-CN.md)。

## 部署模式

团队、题解、Fake、Hack、严格 IOI 与自测版本包含固定增量数据库迁移和经过审核的评测任务扩展；已有实例请阅读 [社区功能升级](wiki/Community-Upgrade.zh-CN.md)。升级器会检查固定结构、在数据库副本上验证后执行，禁止未知改表和可能绕过团队访问、作弊处罚、自测额度或新权限规则的旧版回滚。新增 Hack／自测评测任务的自动升级仅支持 `all`；`web` 部署须另行协调远程评测机版本。未上传 GitHub 的源码可使用教程中的本地完整源码升级流程。

| 模式 | 包含内容与用途 |
| --- | --- |
| `--role all`（默认） | 网页、存储、本机评测和 AI 执行环境；可再添加远程评测机分担普通提交 |
| `--role web` | 网页和存储，不构建本机 rootfs；普通提交需接入远程评测机 |

需要 AI 标程验证和数据生成时，网页节点使用 `all`。远程普通评测机不会自动替代本机 AI worker。详细架构图、节点注册和部署步骤见 [分布式评测](wiki/Distributed-Judging.zh-CN.md)。

团队文件总空间为 10 GiB，不设独立单文件限制，较大文件自动分块上传。提交列表支持保留筛选位置的悬浮详情及原页面入口，参见 [提交预览](wiki/Submissions.zh-CN.md)。Members 从首页排名面板右上角的“查看全部”进入。

## 文档与开发

| 文档 | 内容 |
| --- | --- |
| [安装与配置](wiki/Installation.zh-CN.md) · [Docker 源](wiki/Docker-Sources.zh-CN.md) | 安装参数、镜像源、服务管理与重试 |
| [分布式评测](wiki/Distributed-Judging.zh-CN.md) · [独立评测机](wiki/Remote-Judge.zh-CN.md) | 系统架构、网页与评测分离、节点接入 |
| [注册审核](wiki/Registration-Approval.zh-CN.md) · [安全升级](wiki/Upgrade.zh-CN.md) | 网页注册设置、委派审核、保留配置升级与回滚 |
| [比赛赛制](wiki/Contest-Rules.zh-CN.md) · [Hack](wiki/Hacks.zh-CN.md) · [自测](wiki/Self-Evaluation.zh-CN.md) | 子任务计分、提交详情 Hack、NOI 隐藏预测试与全场额度 |
| [AI 功能](wiki/AI.zh-CN.md) · [HTTPS](wiki/HTTPS.zh-CN.md) | 模型配置、执行环境与站点加密访问 |
| [开发说明](README-DEVELOPMENT.zh-CN.md) · [源码包](deploy/SOURCE-PACKAGE.zh-CN.md) | 构建、测试与发布文件范围 |

完整文档见 [中文 Wiki](wiki/Home.md) / [English Wiki](wiki/Home.en.md)。

## 许可与致谢

项目基于 LibreOJ，主体采用 [MIT](LICENSE)，保留上游版权和许可。感谢 LibreOJ 及相关开源组件的贡献者；第三方组件和 rootfs 配方遵循各自许可，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。
