# 安装与端口配置

简体中文 | [English](Installation.md) | [Wiki 首页](Home.md)

## 环境要求

- **操作系统：** Ubuntu 24.04 或 26.04（amd64），运行在普通虚拟机或物理机上。不支持受限的 Docker 或 LXC 容器。
- **系统功能：** systemd 254 或更高版本，cgroup v2 并启用 cpu、memory 和 pids 控制器。
- **在本机评测：** LLMOJ 可用的 CPU 至少 2 个，内存至少 256 MiB。首次构建时有 8 GiB 内存会更顺利。
- **磁盘空间：** 完整安装需要 30 GiB 空闲空间，仅网页安装需要 10 GiB。
- **网络：** 首次安装需要从 Ubuntu 软件源、GitHub、npm、Node.js 和 Go 下载；完整安装还需要下载 Docker 镜像和评测沙箱文件。

完整安装已在 Ubuntu 24.04 上测试。Ubuntu 26.04 可以通过安装器的检查，但尚未完成一次全新的完整安装测试。

新安装默认位于 `/opt/LLMOJ`。默认目录还是 `/opt/LibreOJ` 时安装的站点保持原位置；对它们运行安装器时请加上 `--prefix /opt/LibreOJ`。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/install.zh-CN.sh -o /tmp/llmoj-install.zh-CN.sh
sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ
```

如果没有 curl，先执行 `sudo apt-get update && sudo apt-get install -y curl ca-certificates`。需要英文提示时改用 `install.sh`。

脚本会下载仓库的指定提交，并记录安装的仓库和提交。它不会登录 GitHub。私有仓库请自行下载源码，并在其中运行 `sudo bash deploy/install.zh-CN.sh`。

安装器会询问：

- 安装模式：完整站点或仅网页；
- 监听地址和 HTTP 端口；
- 安装目录和站点名称；
- 用户在浏览器中访问的地址。在 NAT 后或云服务器上，请填写真实的公网 IP 或域名，因为自动检测到的可能是内网地址；
- 完整站点还会询问 [Docker 源](Docker-Sources.zh-CN.md)，首次安装时还会询问[评测槽数量](#如何选择评测槽数量)。

## 参数

| 参数 | 说明 |
| --- | --- |
| `--repository OWNER/REPO` | 要安装的公开仓库（下载脚本必填） |
| `--ref BRANCH_OR_TAG_OR_COMMIT` | 要安装的分支、标签或提交，默认 `main`（仅下载脚本） |
| `--prefix PATH` | 安装目录，默认 `/opt/LLMOJ`；必须是不含空格和特殊字符的绝对路径。每台服务器只能安装一个站点 |
| `--role all\|web` | `all`（默认）为完整站点；`web` 为不含评测和本机 AI 任务的网站 |
| `--port NUMBER` | HTTP 端口，默认 `80`。2002、2020、13306、16379、19000 和 19001 为内部使用 |
| `--listen ADDRESS` | `0.0.0.0`（默认，所有地址）或 `127.0.0.1`（仅本机，用于[反向代理](HTTPS.zh-CN.md)之后） |
| `--public-url ORIGIN` | 用户访问的地址，例如 `https://oj.example.com`，不含路径。默认根据服务器 IP 和端口推测。它本身不会配置 HTTPS |
| `--site-name TEXT` | 站点名称，默认 `LLMOJ`，1～60 个字符 |
| `--judge-slots NUMBER` | 评测槽数量（仅完整站点）；`0` 或省略表示自动 |
| `--docker-source URL` | Docker 软件包源，默认 `https://download.docker.com` |
| `--docker-mirrors URL[,URL]` | Docker Hub 镜像源；默认不设置，保留服务器现有配置 |
| `--yes`、`--non-interactive` | 不提问，使用给出的参数，其余用默认值 |
| `--interactive` | 即使通常不提问也进行询问（需要终端） |
| `--check` | 只检查服务器是否满足要求 |
| `--plan` | 只显示将要执行的步骤 |
| `--help`、`-h` | 显示帮助 |

`--check` 和 `--plan` 仍会把源码下载到临时目录，但不会安装任何东西。`--repository` 和 `--ref` 属于下载脚本，`deploy/install.zh-CN.sh` 不接受它们。

示例：

```bash
sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ \
  --yes --port 8080 --public-url http://oj.example.com:8080 --site-name "AI Practice"
```

## 如何选择评测槽数量

每个评测槽同一时间运行一个程序；槽越多，能并行评测的提交越多。默认值同时也是最大值：

> CPU 数减一，与内存（MiB）除以 256，两者取较小值（且不超过 511）

这样留出一个 CPU 给网站的其他部分，并为每个槽分配 256 MiB 内存。例如内存足够时，4、8、16 个 CPU 分别对应 3、7、15 个槽。只有 1 个 CPU 或内存不足 256 MiB 的服务器不能评测：请使用 `--role web` 安装，或增加资源。

安装器只在首次生成 `judge.yaml` 且没有传入 `--judge-slots` 时询问。直接回车（或输入 `0`）使用自动值，也可以输入更小的数。再次运行安装器会保留已有的数量。之后如需修改，例如增加了 CPU 或内存，请使用[扩缩容命令](Judge-Configuration.zh-CN.md)；用不同的 `--judge-slots` 重新运行安装器不会修改已有安装。

## 防火墙、HTTPS 与其他系统修改

安装器不会修改防火墙或云安全组，请自行放行站点端口。数据库、Redis、MinIO、后端及其监控指标只在本机监听，不要让外部访问它们。在配置 [HTTPS](HTTPS.zh-CN.md) 之前，站点使用普通 HTTP。

为了 Redis，安装器会设置 `vm.overcommit_memory=1` 并保存到 `/etc/sysctl.d/99-libreoj-redis.conf`（已有同名文件时不覆盖）。MinIO 可能提示“服务器故障会导致数据不可用”：它运行在单台服务器上，因此请另外做好[备份](Operations-Configuration.zh-CN.md)。

## 安装完成后

安装成功后，终端会显示 `admin` 用户名、随机生成的 32 位密码，以及同样保存了它们的文件路径 `config/admin-credentials.json`（仅 root 可读）。请妥善保管，不要公开。再次运行安装器时，只有密码仍然有效才会显示。

使用以下命令管理服务：

```bash
sudo systemctl status libreoj.target
sudo systemctl restart libreoj.target
sudo systemctl stop libreoj.target
sudo systemctl disable libreoj.target
sudo journalctl -u libreoj-backend -u libreoj-judge -u libreoj-nginx -n 100 --no-pager
```

之后修改设置请参阅[配置总览](Configuration.zh-CN.md)；服务、端口、邮件和存储见[安装后运维](Operations-Configuration.zh-CN.md)。安装新版本请使用[升级器](Upgrade.zh-CN.md)，而不是安装器。

## 安装失败时

解决报告的问题后，用与第一次相同的参数重新运行安装器：目录、模式、站点名称、访问地址、监听地址、端口、评测槽数量和 Docker 源。不要通过删除配置或安装状态来绕过参数不一致。

## MariaDB 初始化失败与安全重试

如果 MariaDB 初始化时对数据目录报告 `Errcode: 13 Permission denied`，而该目录确实属于 `mysql`，原因很可能是 AppArmor：它阻止 root 在 MariaDB 切换到 `mysql` 用户之前读取该目录。修改所有者或权限无法解决。

安装器从一开始就以 `mysql` 用户运行数据库程序来避免这个问题（见 [initialize-mariadb.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/initialize-mariadb.py)）。AppArmor 保持开启，只额外允许访问本站点自己的目录。数据库先在私有的暂存目录中初始化，由一个关闭了网络的临时服务器检查，然后才移动到正式位置。

已有的数据库会被检查并保留：如果它不完整或已损坏，安装器会停止，而不会删除、覆盖或重设密码。失败的尝试会保留暂存数据和日志。请阅读安装器指出的日志，解决原因后用相同参数重新运行。不要删除数据库、密钥或安装状态；修复或恢复不完整的数据库之前请先备份。

该工具是安装流程的一部分，不要对正在运行的站点执行它。
