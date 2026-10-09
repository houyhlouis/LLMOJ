# 配置总览与生效规则

[English](Configuration.md) | 简体中文 | [Wiki 首页](Home.md)

本参考按 `43a88bdd62fbf200889b36932fa921439a293190` 的安装器、配置 schema、示例、实际读取位置和生成器核对。“全部配置”包括项目提供的安装参数、后端／评测 YAML、用户 AI 设置、环境变量、前端 bootstrap 设置，以及项目生成的基础服务参数。题目、比赛、题单等业务内容的逐个表单字段，以及第三方软件允许的全部扩展指令，不属于服务器配置清单；开放配置字典会明确标注并链接来源。

## 从哪里修改

| 配置入口 | 说明 |
| --- | --- |
| [Installation](Installation.zh-CN.md) | 安装入口、全部参数和安装重试 |
| [Backend-Configuration](Backend-Configuration.zh-CN.md) | 后端 YAML：账号、安全、数据库、邮件、存储、比赛和显示偏好 |
| [Judge-Configuration](Judge-Configuration.zh-CN.md) | 评测 YAML、CPU／内存扩缩容、服务单元、验证和回滚 |
| [AI](AI.zh-CN.md) | 用户 AI 模型、搜索服务、权限和任务设置 |
| [AI-Environment](AI-Environment.zh-CN.md) | AI 目录、沙盒通信、密钥持久化和环境变量 |
| [Environment](Environment.zh-CN.md) | 全部运行／安装／构建环境变量与维护工具参数 |
| [Frontend-Configuration](Frontend-Configuration.zh-CN.md) | 本地前端构建、可选 CDN/bootstrap 配置 |
| [Operations-Configuration](Operations-Configuration.zh-CN.md) | Nginx、MariaDB、Redis、MinIO、systemd 与安装后变更 |

## 四种值不能混用

- **程序默认值**：代码实际在缺省时采用的值。后端和评测 YAML 通常没有自动补全；不能删掉字段后期待套用示例。
- **示例值**：仓库的 `*.example` 或上游 bootstrap 演示配置，可能是其他站点地址。
- **安装器生成值**：首次安装按目录、端口、CPU 和内存生成，优先于示例。后续一般保留已有配置。
- **当前生效值**：服务器实际配置文件、systemd 主单元和 drop-in 的合并结果；页面中的 AI 设置还按用户分别存储。

文中默认目录为 `/opt/LibreOJ`。自定义 `--prefix` 时必须把所有路径替换成自己的实例目录，不能只改一个环境变量来移动实例。

## 修改与生效

| 修改对象 | 生效方式 |
| --- | --- |
| `config/backend.yaml` | 校验完整 YAML 后重启 `libreoj-backend`；浏览器刷新以重新读取公共偏好 |
| `config/judge.yaml` | 停止接收／等待在途评测结束，按评测指南维护；槽数、CPU、目录变更还须重新生成、安装 systemd 单元 |
| systemd `Environment`／资源限制／drop-in | `systemctl daemon-reload` 后重启对应服务；只 reload 不会重启进程 |
| `config/nginx.conf` | `nginx -t` 通过后 reload；域名和存储签名地址必须同步 |
| MariaDB／Redis／MinIO 配置 | 维护窗口内重启对应服务，并验证后端连接与持久化 |
| 前端构建配置或静态资源 | 重新构建／发布到 Nginx 实际目录，再刷新浏览器；不是只重启后端 |
| AI 模型和搜索设置、用户权限 | 在页面保存；运行中的任务还受权限重新检查，详见 AI 页面 |

安装参数是首次安装输入。已完成安装后重新运行 `--judge-slots`、`--port` 或 `--public-url` 不是配置变更接口；安装状态可能拒绝不一致值，而且生成器保留已有 YAML。不要删除安装状态、`secrets.json`、AI 主密钥或数据来绕过这一行为。

## 常见变更

增加 CPU／内存或减少资源：按 [评测扩缩容](Judge-Configuration.zh-CN.md) 操作。修改站名、端口、域名、邮件、上传上限或服务内存：见 [安装后运维](Operations-Configuration.zh-CN.md)。更换 AI 模型或 Tavily/MCP：见 [AI](AI.zh-CN.md)。

备份应同时包含数据库、对象存储、配置和 AI 密钥状态；仅备份源码不能恢复站点。配置文件中的密钥不应放进 Wiki 或 GitHub。新版本若新增配置字段，需要重新对照 schema 与环境变量读取点更新本参考。
