# LLMOJ Wiki

[English](Home.md) | 简体中文

LLMOJ 是基于 LibreOJ 的 AI 辅助在线评测平台。按部署方式选择教程：

| 场景 | 教程 |
| --- | --- |
| 第一次安装、选择端口与站名 | [Installation](Installation.zh-CN.md) |
| 自定义 Docker 软件包与镜像源 | [Docker-Sources](Docker-Sources.zh-CN.md) |
| 多台评测机、网页节点与评测分离 | [Distributed-Judging](Distributed-Judging.zh-CN.md) |
| 独立评测节点 | [Remote-Judge](Remote-Judge.zh-CN.md) |
| AI 模型配置和本机沙盒 worker | [AI](AI.zh-CN.md) |
| 域名、HTTPS 和现有反向代理 | [HTTPS](HTTPS.zh-CN.md) |
| 发布源码、版本与 GitHub Wiki | [Publishing](Publishing.zh-CN.md) |

默认完整安装保留网页、存储和本机评测，可额外加入远程评测机。纯网页安装用 `--role web`，不构建 rootfs；当前纯网页节点没有 AI 标程验证和数据生成的本机执行能力。

MIT 适用于本项目主体源码；保留各上游与第三方组件的独立许可。源码发布不包含账号、API Key、数据库或完整 rootfs。
