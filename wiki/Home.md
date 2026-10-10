# LLMOJ Wiki

简体中文 | [English](Home.en.md) | [项目仓库](https://github.com/houyhlouis/LLMOJ)

LLMOJ 是基于 LibreOJ 的 AI 辅助在线评测平台。从 [配置总览](Configuration.zh-CN.md) 查找配置项，首次部署从安装教程开始。CPU 核心数或内存调整后，请按 [评测配置与扩缩容](Judge-Configuration.zh-CN.md) 同步更新执行槽、CPU 绑定和 systemd 单元。

| 场景 | 页面 |
| --- | --- |
| 注册方式、委派审核、待审核申请限制 | [注册审核](Registration-Approval.zh-CN.md) |
| 保留配置与数据升级、兼容检查和回滚 | [一键升级](Upgrade.zh-CN.md) |
| 安装入口、全部参数和安装重试 | [Installation](Installation.zh-CN.md) |
| 后端 YAML：账号、安全、数据库、邮件、存储、比赛和显示偏好 | [Backend-Configuration](Backend-Configuration.zh-CN.md) |
| 评测 YAML、CPU／内存扩缩容、服务单元、验证和回滚 | [Judge-Configuration](Judge-Configuration.zh-CN.md) |
| 用户 AI 模型、搜索服务、权限和任务设置 | [AI](AI.zh-CN.md) |
| AI 目录、沙盒通信、密钥持久化和环境变量 | [AI-Environment](AI-Environment.zh-CN.md) |
| 全部运行／安装／构建环境变量与维护工具参数 | [Environment](Environment.zh-CN.md) |
| 本地前端构建、可选 CDN/bootstrap 配置 | [Frontend-Configuration](Frontend-Configuration.zh-CN.md) |
| Nginx、MariaDB、Redis、MinIO、systemd 与安装后变更 | [Operations-Configuration](Operations-Configuration.zh-CN.md) |
| 分布式流程图与网页／评测节点职责 | [Distributed-Judging](Distributed-Judging.zh-CN.md) |
| 独立评测机配置与连接检查 | [Remote-Judge](Remote-Judge.zh-CN.md) |
| Docker 软件包与镜像源 | [Docker-Sources](Docker-Sources.zh-CN.md) |
| 域名、TLS 和外部反向代理 | [HTTPS](HTTPS.zh-CN.md) |
| GitHub Desktop 更新文档与发布 Wiki | [Publishing](Publishing.zh-CN.md) |

默认完整安装保留网页、存储和本机评测，可额外连接远程评测机。`--role web` 不构建本机 rootfs；目前远程提交评测不能替代 AI 验证／数据生成所需的本机 worker。

注册审核与升级工具基于 `20dec6f86213e886e79859187b9ef599bd33ec25` 扩展；新增文件须随对应版本发布。Ubuntu 24.04 amd64 已通过实际部署与功能验证；各次修订的验证范围以测试报告为准。项目主体采用 MIT；各上游组件保留各自许可。
