# 安装与端口配置

[English](Installation.md) | 简体中文

## 支持环境

Ubuntu 24.04 / 26.04 amd64，普通虚拟机或物理机，systemd 254+，cgroup v2 提供 cpu / memory / pids 控制器。至少 3 GiB RAM；完整模式至少 30 GiB 空闲磁盘，仅网页模式至少 10 GiB。首次编译建议 8 GiB RAM。受限 Docker / LXC 容器不在支持范围内。

需要访问 Ubuntu 软件源、GitHub、npm、Node、Go，以及完整模式的 Docker 镜像和配方下载源。服务器的操作系统与内核能力须预先具备。

## GitHub 下载入口

替换实际公开仓库地址：

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/install.zh-CN.sh -o /tmp/llmoj-install.zh-CN.sh
sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ
```

需要先安装 curl 时，可执行 `sudo apt-get update && sudo apt-get install -y curl ca-certificates`。入口会解析目标提交并下载同一提交的源码，记录源仓库和提交；不会登录 GitHub、创建仓库或发布网站源码。私有仓库不能用此匿名入口，应自行认证、克隆后运行 `sudo bash deploy/install.zh-CN.sh`。

安装时询问模式、监听地址、端口、安装目录、站名和浏览器域名/IP；完整模式还询问 Docker 软件包源和镜像加速源。端口默认 80，直接访问 `http://服务器IP`。NAT / 云服务器应输入真实公网 IP 或域名；检测到的接口地址可能只是内网地址。

## 参数

| 参数 | 默认值与限制 |
| --- | --- |
| `--repository OWNER/REPO` | 入口必填；公开仓库 |
| `--ref BRANCH_OR_TAG_OR_COMMIT` | 默认 `main`；分支、标签或提交；仅下载入口 |
| `--prefix PATH` | 默认 `/opt/LibreOJ`；专用绝对目录，不含空格／特殊字符；不支持同机多实例 |
| `--role all\|web` | 默认 `all`；完整安装／仅网页；web 无本机 AI worker |
| `--port NUMBER` | 默认 `80`；1–65535，排除内部端口 2002、2020、13306、16379、19000、19001 |
| `--listen ADDRESS` | 默认 `0.0.0.0`；只接受它或 `127.0.0.1` |
| `--public-url ORIGIN` | 默认根据接口 IP 和端口推测；HTTP(S) origin，无路径、查询、片段或账号；不配置 TLS |
| `--site-name TEXT` | 默认 `LLMOJ`；1–60 个可打印字符，不得全空白 |
| `--judge-slots NUMBER` | 省略为自动（内部值 0，也接受显式 0）；显式槽数 1–7 且不超过 CPU／内存能力；仅 all |
| `--docker-source URL` | 默认 `https://download.docker.com`；HTTPS 软件包源基础地址，追加 `/linux/ubuntu` |
| `--docker-mirrors URL[,URL]` | 默认空，保留现有配置；逗号分隔 HTTPS 镜像源；见 Docker 源页的校验规则 |
| `--yes` / `--non-interactive` | 等价；不提问，使用传入值和默认值 |
| `--interactive` | 强制交互，必须有可用终端；默认仅在有终端且执行安装时交互 |
| `--check` | 只检查环境；下载入口仍下载临时源码，不安装／启动服务 |
| `--plan` | 展示流程；下载入口仍下载临时源码，不安装／启动服务 |
| `--help` / `-h` | 显示当前入口帮助，不执行安装 |

本地源码安装器不接收 `--repository` 或 `--ref`；这些是外层下载入口的参数。

示例：

```bash
sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ \
  --yes --port 8080 --public-url http://oj.example.com:8080 --site-name "AI Practice"
```

安装器为 Redis 后台持久化设置 `vm.overcommit_memory=1`，并保存到 `/etc/sysctl.d/99-libreoj-redis.conf`；已有同名自定义文件不被覆盖。单机 MinIO 的“主机故障会使数据不可用”提示说明该部署没有多节点冗余，独立备份仍然必要。

脚本不会修改防火墙或云安全组；请允许所选站点端口。数据库、Redis、MinIO、后端和监控均只监听本机，勿为它们建立公网入口。默认是 HTTP，正式公网部署按 [HTTPS](HTTPS.zh-CN.md) 设置 TLS。

## 管理员、服务与重试

安装成功的最后会直接在控制终端打印全权限 `admin`、随机 32 字符密码和凭据文件绝对路径。即使构建日志重定向到文件，凭据仍显示在控制终端；没有控制终端时输出到标准输出。服务器同时保存 `config/admin-credentials.json`（root 所有、0600）。重试先核验保存的密码；用户已改密或原密码记录缺失时不会显示过期密码，也不会重置账号。不要上传或公开密码输出。

```bash
sudo systemctl status libreoj.target
sudo systemctl restart libreoj.target
sudo systemctl stop libreoj.target
sudo systemctl disable libreoj.target
sudo journalctl -u libreoj-backend -u libreoj-judge -u libreoj-nginx -n 100 --no-pager
```

安装失败后解决报错，使用首次执行的同一目录、模式、站名、origin、监听地址、端口、并发和 Docker 源参数重跑。不要删除配置或安装状态来绕过冲突。已完成实例不会被安装器当作升级目标；更新前须备份数据库与 AI 主密钥，并制定迁移方案。

Docker 参数在需要构建 rootfs 时使用；留空镜像源不会覆盖现有配置。应用镜像源变更会重启 Docker，见 [Docker 源](Docker-Sources.zh-CN.md)。

## 安装后修改配置

CPU／内存升级后不会自动扩容。请使用 [评测配置与扩缩容](Judge-Configuration.zh-CN.md)，不要通过修改安装记录或重跑 `--judge-slots` 调整已安装实例。完整参数索引见 [配置总览](Configuration.zh-CN.md)，服务、端口、邮件与存储见 [安装后运维](Operations-Configuration.zh-CN.md)。

## 验证范围

已在 Ubuntu 24.04 amd64 完成实际部署和浏览器基础功能测试，覆盖账号与权限、题目管理、四种题型、全部 12 种已配置提交语言、评测与重评、比赛、讨论及题单。后续也使用真实 DeepSeek／Tavily 配置进行了 AI 业务和多用户权限测试；不能据此保证其他模型提供方的行为相同。发现的问题已形成修复及针对性回归检查。修复版尚未再次完成全新安装验收，Ubuntu 26.04 和真实多机部署也仍需单独验收。本次 Wiki 配置核对不是一次新的部署或完整业务测试。
