# 配置总览

简体中文 | [English](Configuration.md) | [Wiki 首页](Home.md)

本页说明各类设置保存在哪里，以及修改后如何生效。文中路径以默认安装目录 `/opt/LLMOJ` 为例；如果安装时用 `--prefix` 指定了其他目录，请把所有路径换成你的目录。

## 设置在哪里

| 页面 | 内容 |
| --- | --- |
| [安装](Installation.zh-CN.md) | 安装器及其参数 |
| [后端配置](Backend-Configuration.zh-CN.md) | `config/backend.yaml`：账号、安全、数据库、邮件、存储、比赛和显示 |
| [注册审核](Registration-Approval.zh-CN.md) | 在 **网站管理** 中设置的注册模式、它在 `backend.yaml` 中的默认值，以及审核者 |
| [两步验证](Two-Factor-Sign-In.zh-CN.md) | 用户自行设置的身份验证器和通行密钥，以及 `two-factor.key` 文件 |
| [评测配置](Judge-Configuration.zh-CN.md) | `config/judge.yaml`、随 CPU 增减扩缩容、服务和检查 |
| [AI](AI.zh-CN.md) | 每位用户在网站中设置的 AI 模型、联网搜索、权限和任务 |
| [AI 环境](AI-Environment.zh-CN.md) | 服务器上的 AI 目录、密钥和环境变量 |
| [环境变量](Environment.zh-CN.md) | 运行、安装和构建所用的环境变量，以及维护脚本的参数 |
| [前端配置](Frontend-Configuration.zh-CN.md) | 构建前端和可选的 CDN 设置 |
| [安装后运维](Operations-Configuration.zh-CN.md) | Nginx、MariaDB、Redis、MinIO、systemd 以及安装后的修改 |

## 默认值、示例值与实际值

- **内置默认值**是设置缺失时代码使用的值。`backend.yaml` 和 `judge.yaml` 中的大多数设置没有内置默认值，所以删掉一行并不会恢复示例中的值。
- **示例**（仓库中的 `*.example` 文件）可能包含适用于其他站点的值。
- **安装器生成的值**在首次安装时根据目录、端口、CPU 和内存计算。再次运行安装器会保留已有文件。
- **实际生效的值**来自你的配置文件，加上 systemd 服务单元及其附加配置（drop-in）。在 **网站管理** 中保存的注册模式优先于 `backend.yaml`；AI 设置按用户分别保存。

## 修改后如何生效

| 修改内容 | 操作 |
| --- | --- |
| `config/backend.yaml` | 确认 YAML 有效后重启 `libreoj-backend`，并刷新浏览器。**网站管理** 中保存的注册模式仍然优先 |
| **网站管理** 中的注册模式 | 无需操作，保存后立即生效。见[注册审核](Registration-Approval.zh-CN.md) |
| `config/judge.yaml` | 按[评测配置](Judge-Configuration.zh-CN.md)操作：先等正在进行的评测完成。修改评测槽、CPU 或目录时还需要更新 systemd 服务单元 |
| systemd 环境变量、资源限制或 drop-in | 执行 `systemctl daemon-reload`，然后重启服务。只执行 `daemon-reload` 不会重启任何服务 |
| `config/nginx.conf` | 用 `nginx -t` 检查后重载 Nginx。域名和存储下载地址要保持一致 |
| MariaDB、Redis 或 MinIO | 在空闲时重启服务，并确认后端仍能正常使用 |
| 前端构建设置或静态文件 | 重新构建，把结果复制到 Nginx 提供的目录，然后刷新浏览器 |
| AI 模型、搜索和权限 | 在网站中保存。运行中的任务会再次检查权限，见 [AI](AI.zh-CN.md) |

安装器的参数只用于首次安装。用不同的 `--judge-slots`、`--port` 或 `--public-url` 再次运行安装器不会修改站点配置：安装器可能拒绝新值，并且会保留已有的 YAML 文件。不要通过删除安装状态、`secrets.json`、AI 主密钥或数据来绕过。

## 常见修改

- 增加或减少 CPU、内存：[评测扩缩容](Judge-Configuration.zh-CN.md)。
- 站点名称、端口、域名、邮件、上传限制或服务内存：[安装后运维](Operations-Configuration.zh-CN.md)。
- AI 模型、Tavily 或 MCP：[AI](AI.zh-CN.md)。

请同时备份数据库、文件存储、配置和 AI 密钥：只有源码无法恢复站点。不要把真实的密码或密钥放进 Wiki 或 GitHub。
