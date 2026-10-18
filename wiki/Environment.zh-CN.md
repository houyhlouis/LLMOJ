# 环境变量与维护脚本

简体中文 | [English](Environment.md) | [Wiki 首页](Home.md) | [配置总览](Configuration.zh-CN.md)

变量按读取它们的程序分组。旧前缀 `LIBREOJ_`、`HYHOJ_` 和 `OJ_` 仍在使用，不要改名。

在 shell 中设置变量不会影响正在运行的服务。要修改服务的环境变量，请添加 systemd drop-in，执行 `systemctl daemon-reload` 并重启服务（见[安装后运维](Operations-Configuration.zh-CN.md#systemd-服务)）。不要把密钥的值贴到问题报告或日志中。

## 服务

| 变量 | 含义 |
| --- | --- |
| `LIBREOJ_CONFIG_FILE` | 后端 YAML 文件的路径（必填）；安装后为 `<root>/config/backend.yaml` |
| `LIBREOJ_JUDGE_CONFIG_FILE` | 评测机 YAML 文件的路径（必填）；安装后为 `<root>/config/judge.yaml` |
| `LIBREOJ_JUDGE_LOG_LEVEL` | 评测机日志级别：`error`、`warn`、`info`（默认）或 `debug` |
| `LIBREOJ_SCHEMA_SYNC` | 后端启动时是否可以修改数据库结构。安装的服务只有在它恰好为 `1` 时才会这样做；`0` 在所有环境中都关闭。安装时用 `deploy/initialize-schema.mjs` 创建数据库，[升级器](Upgrade.zh-CN.md)执行经过检查的修改并把它设为 `0`。不要为了绕过升级器的检查而打开它 |
| `LIBREOJ_LOG_SQL` | 记录每条 SQL 查询。任何非空值都会开启，包括 `0` 或 `false`；删除该变量即可关闭 |
| `NODE_ENV` | 安装的服务中为 `production`，此时后端只记录警告和错误 |
| `NODE_OPTIONS` | 安装的服务中为 `--max-old-space-size=512`，构建时为 `2300`：Node.js 堆内存大小（MiB），不是进程或其运行的程序的总内存 |
| `UV_THREADPOOL_SIZE` | 评测机线程池，至少为评测槽数的两倍加二；由评测配置设置。见[评测配置](Judge-Configuration.zh-CN.md) |
| `TMPDIR` | 后端为 `<root>/data/tmp`；`libreoj` 必须能写入 |
| `PATH` | 服务优先使用安装目录自带的 Node.js（`<root>/runtime/node/bin`），可能与 shell 中的不同 |
| `LIBREOJ_MIGRATION_CONFIG_FILE` | 让后端执行从旧版 LibreOJ 的一次性迁移，而不是提供网站服务；见[下文](#从旧版-libreoj-迁移) |

AI 相关变量 `HYHOJ_AI_STATE_DIR`、`HYHOJ_AI_GENERATED_DIR`、`HYHOJ_AI_SAMPLE_INPUTS_DIR`、`HYHOJ_AI_RUNNER_SOCKET`、`HYHOJ_ARCHIVE_WORK_DIRECTORY` 和 `HYHOJ_AI_PRIVATE_HOSTS` 见 [AI 环境](AI-Environment.zh-CN.md)。

在 **网站管理** 中选择的注册模式保存在数据库中，而不是环境变量中；见[注册审核](Registration-Approval.zh-CN.md)。

## 安装器与配置脚本

以下变量由安装器和生成配置的脚本读取，它们不会修改已有的配置。

| 变量 | 含义 |
| --- | --- |
| `HYHOJ_ROOT` | 配置脚本和备份使用的安装目录，默认 `/opt/LLMOJ`。设置它不会移动安装 |
| `NODE_BINARY` | 脚本使用的 Node.js，默认 `<root>/runtime/node/bin/node` |
| `HYHOJ_PORT` | 站点端口，默认 `80` |
| `HYHOJ_PUBLIC_ORIGIN` | 站点的公开地址；安装器会传入你选择的地址 |
| `OJ_LISTEN_ADDRESS` | `0.0.0.0`（默认）或 `127.0.0.1` |
| `OJ_INSTALL_ROLE` | `all`（默认）或 `web`。不能用它把已有安装切换为另一种模式 |
| `OJ_SITE_NAME` | 新生成的 `backend.yaml` 和前端构建使用的站点名称，默认 `LLMOJ` |
| `OJ_JUDGE_REMOTE` | 设为 `1` 时配置远程评测机，默认 `0` |
| `OJ_JUDGE_SERVER` | 远程评测机连接的站点地址（必填） |
| `OJ_JUDGE_KEY_FILE` | 远程评测机密钥文件的绝对路径，所有者为 root、权限为 `0600`（必填） |
| `OJ_JUDGE_SLOTS` | 新生成的 `judge.yaml` 使用的评测槽数量。不设置时使用自动值（见[安装](Installation.zh-CN.md#如何选择评测槽数量)）；这里不接受 `0`。`HYHOJ_JUDGE_SLOTS` 是旧名称，仅在没有设置 `OJ_JUDGE_SLOTS` 时读取 |
| `LLMOJ_INSTALL_LANG` | 安装器提示的语言：`zh-CN` 为中文，其他值为英文。由 `install.sh` 和 `install.zh-CN.sh` 设置 |
| `LLMOJ_LANG` | 升级和扩缩容脚本提示的语言：`zh-CN` 为中文，其他值为英文。`.zh-CN.sh` 入口脚本设为 `zh-CN`，其他入口设为 `en` |
| `OJ_SOURCE_REPOSITORY`、`OJ_SOURCE_COMMIT` | 下载脚本安装的仓库和提交，仅作记录 |
| `LIBREOJ_ROOT` | 未给出 `--root` 时 `bootstrap-admin.mjs` 使用的安装目录，默认 `/opt/LLMOJ` |
| `INVOCATION_ID`、`JOURNAL_STREAM` | 由 systemd 设置。管理员脚本用它们避免把密码写进服务日志；不要自行设置 |

## 构建与沙箱镜像

| 变量 | 含义 |
| --- | --- |
| `HYHOJ_PUBLIC_DIR`、`HYHOJ_QUOTE_FILE`、`PNPM_BINARY` | 前端构建设置，见[前端配置](Frontend-Configuration.zh-CN.md) |
| `CMAKE_BUILD_PARALLEL_LEVEL` | 原生代码构建的并行数；安装器使用 `2` |
| `npm_config_nodedir` | 原生代码构建所用的 Node.js 头文件；安装器使用 `<root>/runtime/node` |
| `pnpm_config_verify_deps_before_run` | 安装器设为 `false` |
| `RUNTIME_DIRECTORY` | 沙箱镜像构建保存文件的目录，默认 `<仓库>/runtime` |
| `OUTPUT_DIRECTORY` | 沙箱镜像压缩包的输出目录，默认 `<runtime>/sandbox-archives` |
| `LIBREOJ_X32_SUPPORTED` | `1`（默认）或 `0`。安装器使用 `0` 跳过在本机对沙箱镜像进行的 x32 测试，其他测试照常运行 |
| `ARCHIVE`、`CHECKSUM`、`DESTINATION_PARENT` | 安装沙箱镜像压缩包时使用的路径，通常由 `deploy/sandbox/build.sh` 设置 |
| `BUILDX_BUILDER` | Docker Buildx 的 builder，见 [Docker 源](Docker-Sources.zh-CN.md#独立评测服务器) |
| `CLOUDFLARE_WORKER_NAME`、`CLOUDFLARE_ACCOUNT_ID` | 用于可选的 Cloudflare bootstrap 构建，安装器不使用 |
| `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_OSS_BUCKET`、`ALIYUN_OSS_ENDPOINT` | 用于可选的阿里云 OSS bootstrap 构建，会上传到外部存储，安装器不使用 |

安装器会自己设置 `NODE_OPTIONS`、`CMAKE_BUILD_PARALLEL_LEVEL`、`npm_config_nodedir` 和 `pnpm_config_verify_deps_before_run`，事先设置它们没有作用。沙箱镜像 ID（`ROOTFS_ID`）由镜像配方计算得出，不能自行指定。

只在测试中使用的变量见[开发说明](../README-DEVELOPMENT.zh-CN.md#数据库测试)。

## 从旧版 LibreOJ 迁移

`LIBREOJ_MIGRATION_CONFIG_FILE` 指向一个包含旧站点设置的文件：`database.host`（文本）、`database.port`（数字）、`database.username`、`database.password` 和 `database.database`（文本），以及 `uploads`（旧附件目录）。它们都没有默认值。迁移会写入数据库；完成后请删除该变量。它不是升级 LLMOJ 本身的方式：升级请使用[升级器](Upgrade.zh-CN.md)。

## 维护脚本

| 脚本 | 参数与作用 |
| --- | --- |
| `upgrade.sh`、`upgrade.zh-CN.sh` | 升级站点：`--prefix`、`--plan`、`--ref`、`--source`、`--source-sha256`、`--apply --drained`、`--rollback BACKUP --drained`。`upgrade.sh` 输出英文，`upgrade.zh-CN.sh` 输出中文。见[升级](Upgrade.zh-CN.md) |
| `deploy/resize-judge.sh`、`deploy/resize-judge.zh-CN.sh` | 修改评测槽数量：`--prefix`（默认 `/opt/LLMOJ`）、`--slots`、`--plan`、`--apply --drained`、`--rollback BACKUP --drained`、`--mode auto\|all\|remote`。`resize-judge.sh` 输出英文，`resize-judge.zh-CN.sh` 输出中文。见[评测配置](Judge-Configuration.zh-CN.md) |
| `deploy/judge_capacity.py` | 显示服务器能运行多少个评测槽，不做任何修改：`--remote`、`--json`、`--slots N` |
| `deploy/rebuild-statistics.sh` | 比较提交数和通过数与实际提交，加 `--apply` 时修正；`--prefix`。见[安装后运维](Operations-Configuration.zh-CN.md#提交数与通过数) |
| `deploy/sandbox/self-test.sh` | 用已安装的评测机评测几份固定程序以检查沙箱：`--prefix`、`--only cpp,java,…`。评测机有变化时升级器会运行它 |
| `deploy/sandbox/verify-installed.mjs` | 对安装（`--root`，默认 `/opt/LLMOJ`）运行真实的沙箱检查 |
| `deploy/backup.sh` | 备份站点（`--prefix`），见[安装后运维](Operations-Configuration.zh-CN.md#备份) |
| `deploy/verify-backup.sh`、`deploy/verify-backup.zh-CN.sh` | 检查备份能否恢复，不影响网站：`BACKUP`、`--prefix`、`--work-dir`（默认 `/var/tmp`）、`--keep`。见[安装后运维](Operations-Configuration.zh-CN.md#检查备份) |
| `deploy/doctor.sh`、`deploy/doctor.zh-CN.sh` | 只读检查安装的健康状况：`--prefix`、`--json`。见[安装后运维](Operations-Configuration.zh-CN.md#运行-doctor) |
| `deploy/bootstrap-admin.mjs` | 创建第一个管理员：`--root`、`--config`、`--email`（默认 `admin@localhost.invalid`）、`--show-credentials`。它不能用来重置密码 |
| `deploy/bootstrap-services.mjs` | 由安装器使用：`--root` 和 `--phase storage\|judge\|verify-judge` 分别创建存储桶、注册本机评测机或检查其连接 |
| `deploy/initialize-mariadb.py` | 由安装器用于创建数据库（`--root`），见[安装](Installation.zh-CN.md#mariadb-初始化失败与安全重试) |
| `deploy/install-support.py` | 由安装器用于执行各个步骤；不用于升级 |
| `deploy/build-frontend-offline.mjs` | 构建并发布前端：`--build`、`--assets-only`，见[前端配置](Frontend-Configuration.zh-CN.md) |
| `deploy/docker-support.py` | 检查 Docker 下载源（`--source`、`--mirrors`），加 `--configure` 时把镜像源写入 Docker 配置，但不重启 Docker |
| `deploy/sandbox/build.sh` | 构建沙箱镜像：`plan`（默认）、`build` 或 `stage ARCHIVE` |
| `deploy/export-wiki.py` | 导出 Wiki：`--repository OWNER/REPO --output DIR`，见[发布](Publishing.zh-CN.md) |
| `deploy/prepare-github.py` | 用 Git 跟踪的文件生成源码压缩包（`--archive PATH`）；不会覆盖已有的压缩包 |

来源：[configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-local.py)、[configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py)、[install.sh](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/install.sh)、[main.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/main.ts)、[migration-config.schema.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/backend/src/migration/migration-config.schema.ts)、[评测机 config.ts](https://github.com/houyhlouis/LLMOJ/blob/main/apps/judge/src/config.ts)。
