# 安装与端口配置

[English](Installation.md) | 简体中文

## 目标环境与验收范围

安装预检面向 Ubuntu 24.04 / 26.04 amd64；实际完整部署记录来自 24.04，26.04 尚未完成全新安装验收。使用普通虚拟机或物理机，systemd 254+，cgroup v2 提供 cpu / memory / pids 控制器。至少 3 GiB RAM；完整模式至少 30 GiB 空闲磁盘，仅网页模式至少 10 GiB。首次编译建议 8 GiB RAM。受限 Docker / LXC 容器不在支持范围内。

需要访问 Ubuntu 软件源、GitHub、npm、Node、Go，以及完整模式的 Docker 镜像和配方下载源。服务器的操作系统与内核能力须预先具备。

## GitHub 下载入口

替换实际公开仓库地址：

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/install.zh-CN.sh -o /tmp/llmoj-install.zh-CN.sh
sudo bash /tmp/llmoj-install.zh-CN.sh --repository houyhlouis/LLMOJ
```

需要先安装 curl 时，可执行 `sudo apt-get update && sudo apt-get install -y curl ca-certificates`。入口会解析目标提交并下载同一提交的源码，记录源仓库和提交；不会登录 GitHub、创建仓库或发布网站源码。私有仓库不能用此匿名入口，应自行认证、克隆后运行 `sudo bash deploy/install.zh-CN.sh`。

安装时询问模式、监听地址、端口、安装目录、站名和浏览器域名/IP；完整模式还询问 Docker 软件包源、镜像加速源；首次生成 judge.yaml 且未指定 --judge-slots 时询问评测实例数（执行槽，默认有效 CPU 数减 2，最低 1）。端口默认 80，直接访问 `http://服务器IP`。NAT / 云服务器应输入真实公网 IP 或域名；检测到的接口地址可能只是内网地址。

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
| `--judge-slots NUMBER` | 省略/0 为 `max(1, 有效 CPU 数-2)`；显式正整数须符合 CPU／内存预算及 511 上限；仅 all |
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

## 评测实例数怎么选择？

“评测实例数”是执行槽数，不是 OS 线程数，也不是同机部署多套站点。完整模式在首次生成 `judge.yaml` 且没有显式 `--judge-slots` 时才提问，显示当前有效 CPU、内存最大值和默认 `max(1, 有效 CPU 数-2)`；web 模式不问。按回车或输入 `0` 保留自动选择语义；输入正整数保存明确选择。默认值不符合内存预算时，交互安装要求重新输入较少数量，不会暗中降低；无人值守首次安装则报错。已有 `judge.yaml` 且未指定该参数的重试会保留原配置和 `judgeSlots: 0` 自动语义，不再询问或以新的 CPU-2 默认阻挡合法旧配置；首次使用显式正整数的实例仍须按原参数重试。

例如有效 CPU 为 4、8、16 且内存足够时，默认分别为 2、6、14 槽。旧的 7 槽上限已经移除；仍受有效 CPU、RAM 和 libuv 最大 511 槽限制。增加系统线程数或 AI 并发不会增加执行槽。详细预算与已有实例的一键扩缩容见 [评测配置](Judge-Configuration.zh-CN.md)。`--plan` 展示资源与流程，不等于可安装性验收；`--check` 和实际安装预检会拒绝不适合的资源配置。

## MariaDB 初始化失败与安全重试

若日志出现数据目录 `Errcode: 13 Permission denied`，即使目录已归 mysql 所有，也可能是 AppArmor 拒绝 root 在降权前使用 `dac_read_search` / `dac_override`，不能只靠反复 chmod/chown 解决。

新流程由 [initialize-mariadb.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/initialize-mariadb.py) 在执行数据库程序前切换到 mysql 用户，在私有 `data/mariadb-init/stage-*` 中初始化，启动禁止网络的临时服务器检查系统表和 socket 账号，再发布到空目标目录。仅有 `data/mariadb/mysql/` 不再视为初始化成功。失败暂存和日志保留；目标已有内容时先验证并保留，损坏/不完整数据会拒绝继续，不自动删除、覆盖或重设密码。相关服务运行或残留 socket/PID 时也拒绝盲目启动第二个服务器。现有库验证会启动数据库引擎，可能进行正常恢复和日志更新；保留数据不等于逐字节只读。此脚本是安装流程的内部工具，正常运行实例不要单独执行它。

修复保留 AppArmor 隔离，只补实例数据/暂存目录访问，不增加上述 DAC 绕过能力，也不关闭全局策略。该实现属于待提交修订，使用前确认更新版本含此文件。失败后阅读指定的私有日志并修复原因，按原参数重试；不要删除数据库、密钥、安装状态或修改元数据绕过检查。已有不完整数据库需先备份，再由管理员修复/恢复。

本次在 Ubuntu 24.04 的 MariaDB 10.11.14 上，用 Ubuntu 26.04 的 MariaDB 11.8.6-5 软件包 AppArmor 规则建立独立临时 profile：root 启动再 `--user=mysql` 复现相同 Err13 和两项 capability 拒绝，直接 mysql 身份初始化成功创建系统表。临时规则仅重命名并授权测试路径，未增加 capability；仍观察到一项不影响初始化的 sys 设备读取拒绝。这证明故障机制及身份切换方案，不代表完整 Ubuntu 26.04 新安装、所有 MariaDB 版本或所有 AppArmor 行为已经验收。

随后使用生产初始化 helper 完成以下检查，各项作用范围分别记录：

| 环境 | 实际结果 | 没有证明的范围 |
| --- | --- | --- |
| Ubuntu 24.04 本机 MariaDB 10.11.14，独立临时目录 | 全新初始化及已有库重试通过系统表/socket SQL 验证 | 未重装线上 OJ |
| 官方 Ubuntu 26.04 容器，OS 26.04.1、MariaDB 11.8.6-5ubuntu0.1 | 同一生产 helper 的全新初始化及已有库复验 SQL 通过 | 容器使用 `docker-default` enforce，不是 MariaDB 专用 profile，也不是 systemd 虚拟机 |
| Ubuntu 24.04 主机加载独立命名的 Ubuntu 26.04 MariaDB profile | 复现 root-first 失败、mysql-first 成功的 AppArmor 机制 | 使用主机 MariaDB 版本，不是完整 26.04 环境 |

这些证据互补；**Ubuntu 26.04 整站全新虚拟机安装和业务验收仍未完成**，不能把组件检查表述为全部兼容保证。

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
