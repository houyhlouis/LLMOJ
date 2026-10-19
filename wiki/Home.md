# LLMOJ Wiki

简体中文 | [English](Home.en.md) | [项目仓库](https://github.com/houyhlouis/LLMOJ)

LLMOJ 是基于 LibreOJ 的在线评测系统，提供 AI 辅助出题功能。初次部署请从[安装教程](Installation.zh-CN.md)开始；查找某个配置项请看[配置总览](Configuration.zh-CN.md)。

## 安装与维护

| 页面 | 内容 |
| --- | --- |
| [安装教程](Installation.zh-CN.md) | 安装脚本、全部参数、安装失败后重试 |
| [升级](Upgrade.zh-CN.md) | 保留配置和数据升级；兼容范围与回滚 |
| [功能升级](Community-Upgrade.zh-CN.md) | LLMOJ 各项功能的数据库修改，以及在自定义安装上应用它们 |
| [HTTPS](HTTPS.zh-CN.md) | 域名、TLS 证书和外部反向代理 |
| [Docker 源](Docker-Sources.zh-CN.md) | Docker 软件包源和镜像加速源 |
| [运维配置](Operations-Configuration.zh-CN.md) | 安装后的 Nginx、MariaDB、Redis、MinIO 与 systemd；健康检查、备份与计数修正 |
| [容量](Capacity.zh-CN.md) | 小型网站在实测负载下的表现，以及本版本前后的对比 |

## 使用

| 页面 | 内容 |
| --- | --- |
| [比赛赛制](Contest-Rules.zh-CN.md) | NOI / OI、IOI、ICPC 与严格 IOI 的计分和反馈 |
| [私人团队](Teams.zh-CN.md) | 通过编号加入、审核、分组与共享资源 |
| [题解](Solutions.zh-CN.md) | 题目页内的题解、我的讨论与 AI 题解 |
| [提交记录](Submissions.zh-CN.md) | 提交预览、测试数据版本与此前的评测结果 |
| [Hack](Hacks.zh-CN.md) | 发起 Hack、题目 STD 与 Hack 记录 |
| [自测](Self-Evaluation.zh-CN.md) | NOI / OI 比赛中的隐藏预测试与额度 |
| [Fake 处罚](Submission-Moderation.zh-CN.md) | 作废作弊提交并保留证据 |
| [注册审核](Registration-Approval.zh-CN.md) | 注册设置与委派审核 |
| [两步验证](Two-Factor-Sign-In.zh-CN.md) | 验证器应用、通行密钥、恢复码与敏感操作确认 |
| [键盘与读屏软件](Accessibility.zh-CN.md) | 不用鼠标使用网站、实时更新、手机上的缩放 |

用户列表（`/u`）从网站首页“排名”面板的“查看全部”进入，需要 `ViewUsers` 权限。

## 评测

| 页面 | 内容 |
| --- | --- |
| [分布式评测](Distributed-Judging.zh-CN.md) | 架构、评测队列、排空与吊销评测机 |
| [远程评测机](Remote-Judge.zh-CN.md) | 部署独立的评测机并检查 |
| [评测机配置](Judge-Configuration.zh-CN.md) | 评测设置、沙箱与自检、容量与扩缩容 |

## AI

| 页面 | 内容 |
| --- | --- |
| [AI](AI.zh-CN.md) | 用户自己的模型和搜索服务、权限、AI 任务，以及站点的 AI 暂停和限制 |
| [AI 环境](AI-Environment.zh-CN.md) | AI 目录、本机沙箱连接、密钥与环境变量 |

## 参考

| 页面 | 内容 |
| --- | --- |
| [配置总览](Configuration.zh-CN.md) | 各配置项所在的位置 |
| [后端配置](Backend-Configuration.zh-CN.md) | 后端设置：账号、安全、数据库、邮件、存储、比赛和显示 |
| [前端配置](Frontend-Configuration.zh-CN.md) | 本地构建前端；可选的 CDN 设置 |
| [环境变量](Environment.zh-CN.md) | 运行、安装和构建用的环境变量；维护脚本 |
| [发布](Publishing.zh-CN.md) | 用 GitHub Desktop 应用更新、发布本 Wiki 和创建版本 |

完整安装（`--role all`）包含网站、存储和本机评测，也可以再接入远程评测机。仅网页安装（`--role web`）不构建本机评测环境：提交由远程评测机评测，已更新的评测机（协议版本 4）也负责 AI 验证标程和生成测试数据（见[分布式评测](Distributed-Judging.zh-CN.md)）。

LLMOJ 在 Ubuntu 24.04 amd64 上经过测试。本项目代码采用 MIT 许可，上游组件保留各自的许可。
