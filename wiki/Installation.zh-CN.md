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

| 参数 | 说明 |
| --- | --- |
| `--repository OWNER/REPO` | GitHub 入口使用的公开仓库 |
| `--ref TAG_OR_COMMIT` | GitHub 入口版本；默认 main，正式部署推荐固定版本 |
| `--role all` / `--role web` | 完整站点 / 仅网页节点 |
| `--port 80` | HTTP 端口；80 无需浏览器端口后缀 |
| `--listen 0.0.0.0` / `127.0.0.1` | 公网 / 本机监听 |
| `--public-url https://oj.example.com` | 浏览器及签名下载链接使用的最终 origin；不配置 TLS |
| `--prefix /opt/LibreOJ` | 实例目录；不支持同一服务器多个实例 |
| `--site-name "My AI OJ"` | 站点展示名 |
| `--judge-slots 2` | 本机执行槽数量；仅 all 模式，不能超过机器能力 |
| `--docker-source https://download.docker.com` | Docker 软件包源的基础 URL，追加 `/linux/ubuntu` |
| `--docker-mirrors HTTPS_URL[,URL]` | Docker Hub 加速源，留空保留现有设置 |
| `--yes` | 非交互执行，采用提供的参数与默认值 |
| `--interactive` | 强制交互，要求终端 |
| `--plan` / `--check` | 流程展示 / 环境检查，不安装或启动站点 |

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

已在 Ubuntu 24.04 amd64 完成实际部署和浏览器基础功能测试，覆盖账号与权限、题目管理、四种题型、全部 12 种已配置提交语言、评测与重评、比赛、讨论及题单。该次部署对发现的阻断问题采用了绕行措施；后续修复已有回归检查，但尚未对修复版再次执行全新安装。Ubuntu 26.04、使用真实服务凭据的完整 AI 流程，以及真实多机部署尚未完成端到端验收。
