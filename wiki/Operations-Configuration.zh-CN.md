# 安装后运维

简体中文 | [English](Operations-Configuration.md) | [Wiki 首页](Home.md) | [配置总览](Configuration.zh-CN.md)

本页列出安装器为 Nginx、Redis、MariaDB、MinIO 和 systemd 写入的设置，说明哪些设置需要一起修改，并介绍健康检查、统计数据和备份。`<root>` 表示安装目录，默认为 `/opt/LLMOJ`。本页没有列出的设置，请参阅对应软件版本的文档。

修改之前，请先备份文件并记下原来的值。修改数据库或存储时请选在空闲时段。

## Nginx：`config/nginx.conf`

| 设置 | 安装器写入的值 |
| --- | --- |
| `user`、`worker_processes`、`events.worker_connections` | `www-data`、`auto`、`1024`。这是 Nginx 自己的进程，与评测无关 |
| `pid`、`access_log`、`error_log`、`log_format` | PID 文件 `<root>/data/nginx/nginx.pid`，日志在 `<root>/logs/nginx`。`private_request` 日志格式只记录不含查询参数的路径，因为查询参数中可能有密钥 |
| `include`、`default_type` | `/etc/nginx/mime.types`、`application/octet-stream` |
| `client_max_body_size` | 通过 `/storage/` 传输的文件为 `128m`；`/api/` 为 `32m`，即后端自身的限制。前面的代理或后端对某类文件的限制可能更小 |
| `client_body_temp_path`、`proxy_temp_path` | `<root>/data/nginx/client_body` 和 `<root>/data/nginx/proxy`；`www-data` 必须能写入 |
| `listen`、`server_name`、`root` | 安装时选择的地址和端口（默认 `0.0.0.0:80`）、`_`、`<root>/public` |
| `map $http_upgrade $connection_upgrade` | 用于转发 WebSocket 连接 |
| `location /api/` | 转发到后端 `http://127.0.0.1:2002`，并带上 Host、X-Real-IP、X-Forwarded-For 和 X-Forwarded-Proto 头 |
| `location /api/socket`、`location /socket.io/` | 到后端的 WebSocket 连接，最长保持一小时（`3600s`）。评测机连接 `/api/socket` 不记录访问日志，错误日志也只记录严重错误 |
| `location /storage/` | 转发到 MinIO `http://127.0.0.1:19000/`，并设置 MinIO 下载签名所需的 Host 头，关闭缓冲 |
| `location /` | 提供前端页面，找不到文件时返回 `/index.html`，使任意页面链接都能打开 |

检查并应用修改（按你的安装调整路径）：

```bash
sudo /usr/sbin/nginx -t -p /opt/LLMOJ/ -c /opt/LLMOJ/config/nginx.conf
# 仅在检查通过后执行：
sudo systemctl reload libreoj-nginx
```

如果检查失败，不要重载：恢复备份后重新检查。

## Redis：`config/redis.conf`

| 设置 | 安装器写入的值 |
| --- | --- |
| `bind`、`port`、`protected-mode`、`requirepass` | `127.0.0.1`、`16379`、`yes`，以及随机密码，必须与后端的 Redis 地址一致 |
| `dir`、`appendonly`、`appendfsync`、`save` | `<root>/data/redis`、`yes`、`everysec`，以及 `900 1` 和 `300 10` 两条快照规则 |
| `maxmemory`、`maxmemory-policy` | `192mb`、`noeviction`：Redis 满了之后写入会失败，而不是删除数据。请关注它的内存；不要改用会淘汰键的策略，否则会丢失登录会话和排队中的任务 |
| `logfile`、`daemonize` | 空、`no`：日志交给 systemd |

## MariaDB：`config/mariadb.cnf`

| 设置 | 安装器写入的值 |
| --- | --- |
| `user`、`bind-address`、`port` | `mysql`、`127.0.0.1`、`13306` |
| `datadir`、`socket`、`pid-file`、`log-error` | 数据在 `<root>/data/mariadb`（包括 `mysql.sock` 和 `mysql.pid`），日志在 `<root>/logs/mariadb/error.log` |
| `character-set-server`、`collation-server` | `utf8mb4`、`utf8mb4_unicode_ci`。修改它们不会转换已有的表 |
| `innodb-buffer-pool-size`、`max-connections`、`skip-name-resolve` | `128M`、`60`、开启。请根据内存和负载调整；后端自己的连接池另外配置 |

如果安装时 MariaDB 初始化失败，见[安装](Installation.zh-CN.md#mariadb-初始化失败与安全重试)。不要通过关闭 AppArmor 或删除数据库来绕过。

## MinIO：`config/minio.env` 及其服务

| 设置 | 安装器写入的值 |
| --- | --- |
| `MINIO_ROOT_USER`、`MINIO_ROOT_PASSWORD` | 存储凭据，保存在只有 root 能读取的 `minio.env` 中，必须与 `backend.yaml` 中的 `accessKey` 和 `secretKey` 一致 |
| `MINIO_BROWSER`、`MINIO_UPDATE`、`MINIO_CALLHOME_ENABLE` | 均为 `off` |
| `--address`、`--console-address`、数据目录 | `127.0.0.1:19000`、`127.0.0.1:19001` 和 `<root>/data/minio`，写在服务的 `ExecStart` 中 |

## systemd 服务

| 设置 | 安装器写入的内容 |
| --- | --- |
| `User`、`Group` | MariaDB 以 `mysql` 运行，Redis 以 `redis` 运行，后端和 MinIO 以 `libreoj` 运行；Nginx 的工作进程以 `www-data` 运行。评测机使用的用户见[评测配置](Judge-Configuration.zh-CN.md) |
| `WorkingDirectory`、`ExecStart`、`Environment`、`EnvironmentFile` | 安装目录中的路径；后端在 `apps/backend` 中运行；MinIO 读取 `minio.env`。环境变量见[环境变量](Environment.zh-CN.md) |
| `After`、`Requires`、`PartOf`、`Wants`、`WantedBy` | 后端依赖 MariaDB、Redis 和 MinIO；Nginx 依赖后端。所有服务都属于开机启动的 `libreoj.target` |
| `Restart`、`RestartSec`、`UMask`、`LimitCORE` | 网页和存储服务失败 3 秒后重启，umask 为 `0077`，不生成 core 文件；评测机的 umask 为 `0022` |
| `StandardOutput`、`StandardError` | `journal` |
| `TimeoutStartSec` | MariaDB：120 秒 |
| `Type`、`ExecReload`、`KillSignal` | Nginx：`simple`，使用自己的配置重载，以 `SIGQUIT` 停止 |
| `AllowedCPUs`、`UV_THREADPOOL_SIZE`、`TasksMax`、`Delegate`、`RequiresMountsFor` | 评测机的 CPU、线程和挂载设置，必须与 `judge.yaml` 一致，见[评测配置](Judge-Configuration.zh-CN.md) |

正在使用的服务单元在 `/etc/systemd/system`；`deploy/systemd` 中是生成它们的模板。要长期修改环境变量或资源限制，请添加 drop-in，例如 `sudo systemctl edit libreoj-backend`，然后执行 `sudo systemctl daemon-reload` 并重启服务。请检查 drop-in 没有覆盖安装器或扩缩容命令写入的设置，例如 `AllowedCPUs`。完整的服务单元及其环境变量可能包含密钥，只在可信的终端中查看。

安装器还会为 Redis 在 `/etc/sysctl.d/99-libreoj-redis.conf` 中设置 `vm.overcommit_memory=1`（该文件已存在时不覆盖），并安装评测沙箱所需的 AppArmor 规则。Docker 下载源见 [Docker 源](Docker-Sources.zh-CN.md)。Node.js、Go、pnpm 的版本和沙箱镜像属于每个发行版本，不是可修改的设置。

### 服务器错误

页面报告服务器错误时，消息末尾会附上错误编号。后端日志以同一编号（在行首的方括号中）记录了详细信息；对于 AI 页面，日志只记录错误类型，不记录具体内容。每个 API 响应的 `X-Request-Id` 头中也带有它的编号；后端在处理该请求期间记录的其他日志行都标有 `[request <编号>]`，一次搜索即可全部找到。

```bash
sudo journalctl -u libreoj-backend --since today | grep '消息中的错误编号'
```

## 健康检查

### 运行 doctor

```bash
sudo bash /opt/LLMOJ/deploy/doctor.sh
```

`doctor.zh-CN.sh` 以中文输出相同内容。doctor 只读取：不启动、不停止、不写入任何东西，也不输出任何密码、密钥或令牌。它检查：

| 方面 | 检查内容 |
| --- | --- |
| 安装 | 版本和最近一次升级；中途停止的升级 |
| 服务 | 各服务正在运行、没有因故障反复重启；`libreoj.target` 开机自启 |
| 后端 | 后端有响应，并能连接数据库、Redis 和对象存储；Nginx 正常转发请求；`nginx.conf` 中配置的 HTTPS 证书至少还有 14 天有效期；数据库与当前版本的定义一致（见[启动时检查数据库](Upgrade.zh-CN.md#启动时检查数据库)） |
| Redis | 数据能保存到磁盘；内存用量（用满后写入会失败）；从不淘汰键；连接数 |
| 数据库、对象存储 | MariaDB 和 MinIO 有响应；网站数据的大小 |
| 本机评测 | 沙箱镜像与配置一致；评测能限制 CPU、内存和进程；工作目录已挂载；AI 运行器套接字存在 |
| 工作队列 | 已连接的评测机、等待中的提交及最早一个的等待时间、等待中的进行中比赛的提交、失去评测机的任务、失败的任务、题目和用户计数落后多少、等待中的 AI 任务、账号可以使用哪些 AI 地址、没有报告用量的 AI 请求。需要后端的[指标](#指标)，安装器默认开启。 |
| 本服务器 | 磁盘剩余空间和 inode、可用内存、系统时间是否同步 |
| 文件与权限 | 配置、密钥、数据目录和备份的所有者与安装器设置的一致，其他用户无法读取 |
| 备份 | 最近一次 `backup.sh` 备份的时间；升级备份占用的空间 |

每行为 **正常**、**信息**、**警告** 或 **失败**；有失败项时命令以 1 退出，否则以 0 退出。[运维手册](Runbook.zh-CN.md)说明每项警告和失败该如何处理。`--json` 以 JSON 输出结果，便于监控；`--prefix` 检查其他安装目录。doctor 不在沙箱中运行程序，因为那会与评测争用资源：要深入检查沙箱和各语言，请运行 `sudo bash /opt/LLMOJ/deploy/sandbox/self-test.sh`。

### 存活与就绪检查

后端在以下两个地址上无需会话即可应答，访客无法查看的网站也一样：

| 地址 | 应答 |
| --- | --- |
| `/api/health/live` | 进程能处理请求时返回 `200` 和 `{"status":"ok"}` |
| `/api/health/ready` | 数据库、Redis 和对象存储都在 2 秒内响应时返回 `200`；否则返回 `503`，并把未响应的项标为 `"failed"`。1 秒内的多次探测共用一次检查。 |

安装器和升级器在开放网站之前会等待 `/api/health/ready`。监控程序可以通过 Nginx 使用 `http://<你的网站>/api/health/ready`。应答只说明哪项依赖失败；原因记录在后端日志中，每分钟最多一次。

### 指标

`backend.yaml` 中设置了 `metrics` 时（安装器设为 `127.0.0.1:2020`），`http://127.0.0.1:2020/metrics` 提供 Prometheus 指标。除了请求耗时和 Node.js 数据外，以下指标描述工作队列，在读取指标时从数据库读取：

| 指标 | 含义 | 需要关注的情况 |
| --- | --- | --- |
| `libreoj_judge_clients{state}` | 连接到此后端进程的评测机，`accepting`（接收任务）或 `draining`（排空中） | 没有评测机在接收任务 |
| `libreoj_judge_jobs{state}` | 等待中（`Queued`）或正在评测（`Leased`）的评测任务 | |
| `libreoj_judge_oldest_queued_job_seconds` | 最早一个等待中任务已等待的时间 | 持续增长 |
| `libreoj_judge_expired_leases` | 评测机不再响应、尚未重新排队的任务 | 超过一分钟仍大于 0 |
| `libreoj_judge_failed_jobs_last_day` | 过去 24 小时内失败的任务 | 大于 0：查看 **评测机状态** 页面的 **评测队列** |
| `libreoj_judge_queued_jobs_by_class{class}` | 按[类别](Distributed-Judging.zh-CN.md#下一个任务是哪个)统计的等待中任务：`live_contest`、`practice`、`rejudge`、`hack_and_self_evaluation`、`ai` | `live_contest` 持续大于 0 |
| `libreoj_statistics_outbox_pending`、`libreoj_statistics_outbox_oldest_seconds` | 尚未应用的[计数变化](#提交数与通过数)及最早一项的时长 | 时长超过几分钟 |
| `libreoj_ai_jobs{state}`、`libreoj_ai_oldest_queued_job_seconds` | `queued`（排队）和 `running`（运行）的 AI 任务，及最早一个的等待时间 | |
| `libreoj_ai_provider_requests{state}` | 正在进行（`running`）和在 **网站管理** 的 AI 限制下等待空位（`waiting`）的模型请求 | 大量请求长时间等待 |
| `libreoj_ai_paused` | AI 暂停时为 1 | |
| `libreoj_ai_unreported_usage_last_day` | 过去 24 小时内服务商没有报告用量的 AI 请求；它们按最大值计入预算 | 持续增长：服务商可能不报告用量 |
| `libreoj_ai_approved_endpoints`、`libreoj_ai_approved_endpoints_only` | **站点管理** 中批准的 [AI 地址](AI.zh-CN.md#账号可以使用哪些地址)数量；账号只能使用这些地址时后者为 1 | |
| `libreoj_database_schema_differences{kind}` | 后端启动时发现的数据库与当前版本定义的差异：`changed`（列定义不同、缺少索引），`extra`（更新版本添加的内容） | `changed` 大于 0 |
| `libreoj_ai_worker_errors{stage}` | 后端启动以来 AI 任务调度（`worker`）的错误和任务内部错误（`job`） | 持续增长：查看后端日志 |
| `libreoj_error_count{error}` | 按类型统计的服务器错误，包括数据库或 Redis 连接中断 | 持续增长 |
| `libreoj_request_sql_queries{api}` | 每个请求的 SQL 查询数，按地址统计 | 某页面的平均值随数据量增长（每项一次查询） |
| `libreoj_request_sql_seconds{api}` | 一个请求中耗时超过 1 毫秒的 SQL 查询的时间之和（同时进行的查询加起来可能超过请求本身的时长） | |
| `libreoj_sql_slow_queries` | 后端启动以来耗时超过 1 秒（`LIBREOJ_SLOW_QUERY_MS`）的 SQL 查询；每条都会记录，但不含参数 | 持续增长 |

无法读取的值为 `NaN`，原因记录在后端日志中，绝不会给出旧的数值。指标中不含用户、源代码或密钥。小型网站能承受的负载见[容量](Capacity.zh-CN.md)。

## 需要一起修改的设置

| 修改 | 同时修改 |
| --- | --- |
| CPU、内存或评测槽数量 | 使用[扩缩容命令](Judge-Configuration.zh-CN.md)，它会一起更新 `judge.yaml`、评测服务及其检查 |
| 站点名称或标志 | `backend.yaml` 中的 `preference.siteName` 和 `preference.misc.appLogo`，然后[重新构建前端](Frontend-Configuration.zh-CN.md)以更新页面加载时显示的名称 |
| 站点端口或监听地址 | `nginx.conf` 中的 `listen`；用户访问的地址；公开端口变化时，MinIO 地址 `forUserUpload`、`forUserDownload` 和 `forJudge.urlEndpoint`；本机 `downloadEndpointOverride` 中的端口；各远程评测机 `judge.yaml` 中的 `serverUrl`；防火墙和前面的代理 |
| 域名，或从 HTTP 改为 HTTPS | 三个 MinIO `urlEndpoint` 都改为 `https://<新域名>/storage/`；HTTPS 代理及其转发头；远程评测机的 `serverUrl`；邮件链接允许的地址。见 [HTTPS](HTTPS.zh-CN.md) |
| 数据库、Redis 或文件存储 | 先备份并迁移数据，再让后端的连接设置与服务器的地址和密码一致。Redis 地址中密码的特殊字符需要百分号编码。只修改 `secrets.json` 不会有任何效果 |
| 开启邮件和邮箱验证 | 设置 `services.mail.address` 和真实的 `transport`，确认能收到邮件后再开启 `preference.security.requireEmailVerification`。默认的 `jsonTransport` 不会发送邮件 |
| 允许更大的上传 | Nginx 及前面代理的 `client_max_body_size`、`backend.yaml` 中对应的 `resourceLimit`，以及可用磁盘空间 |
| 为服务分配更多内存 | 分别规划 Node.js（`NODE_OPTIONS`）、Redis `maxmemory`、MariaDB 缓冲池、评测和临时文件系统；评测槽只是其中一部分 |

修改后重启受影响的服务：`backend.yaml` 重启 `libreoj-backend`；MariaDB、Redis 或 MinIO 的配置在空闲时重启对应服务。然后不要只检查首页能否打开：请登录、提交一次代码、上传并下载一个小文件、确认远程评测机重新连接，并运行一个小的 AI 任务。

## 提交数与通过数

每道题目的提交数和通过数，以及每个用户的提交数和通过题数，始终与非比赛提交一致。每次变化都与提交一起记录，并在提交后立即应用；如果后端在这之间停止，其他后端进程或重启后的后端会在大约一分钟内应用。

需要核对计数与提交是否一致时（例如恢复备份或退回旧版本之后）：

```bash
sudo bash /opt/LLMOJ/deploy/rebuild-statistics.sh
```

它输出一行 JSON：分别给出 `problems` 和 `users` 中不一致的行数，以及最多 20 个示例的 `stored`（存储值）和 `counted`（统计值）。修正：

```bash
sudo bash /opt/LLMOJ/deploy/rebuild-statistics.sh --apply
```

两者都可以在站点运行时执行。其他安装目录请使用 `--prefix`。

## 密钥与安装记录

- `config/secrets.json` 记录安装时生成的密码和密钥（`database`、`redis`、`minioAccess`、`minioSecret`、`session`、`maintenance`、`judge`、`instanceId`）。修改这个文件不会改变任何地方的密码：要修改某一项，请在使用它的服务、`backend.yaml` 和评测机上分别修改。不要删除这个文件后重新安装。
- `config/admin-credentials.json` 记录第一个管理员的密码；修改这个文件不会改变账号密码。
- `config/install-state.json` 记录最初的安装参数和进度，不记录扩缩容等之后的修改。
- AI 状态目录中保存 AI 主密钥和 `two-factor.key`。它们用于解密数据库中用户的 AI 密钥（`ai_configuration.encrypted`）和身份验证器密钥（`user_two_factor`），因此数据库备份必须配合对应的密钥才能使用。移动该目录请见 [AI 环境](AI-Environment.zh-CN.md)。

不要递归修改整个安装目录的所有者：沙箱镜像和评测目录需要特定的所有者和挂载。

## 备份

```bash
sudo bash /opt/LLMOJ/deploy/backup.sh
```

它备份 `/opt/LLMOJ`，或用 `--prefix`（或 `HYHOJ_ROOT`）指定的目录。它会：

1. 在安装、升级或评测扩缩容进行时拒绝运行；
2. 停止站点服务，因此备份期间网站不可用；
3. 把 `config`、`data` 和 `deploy` 写入 `backups/libreoj-<UTC 时间>.tar.gz`，并生成 `.sha256` 校验文件；不包括 `data/judge`、`data/tmp`、`data/nginx` 和 `data/ai-generated`；
4. 重新启动之前在运行的服务，即使备份失败也是如此；之前已停止的站点保持停止；
5. 使用下面的选项时，在网站恢复之后把备份复制到其他地方，并删除较旧的备份。

| 选项 | 作用 |
| --- | --- |
| `--encrypt-to KEY.asc` | 在写入的同时用一个 OpenPGP 公钥文件加密备份：备份为 `libreoj-<UTC 时间>.tar.gz.gpg`，磁盘上从不出现未加密的副本。只有对应的私钥能读取它；请把私钥放在服务器之外，这样备份被盗或服务器被入侵都不会泄露网站的密钥。 |
| `--copy-to 目标` | 用 `rsync` 把备份及其 `.sha256` 复制到一个目录（例如挂载的网络共享），或经 SSH 复制到 `user@host:目录`（使用 root 的 SSH 密钥）。复制失败时备份保留在原处，命令以 3 退出。 |
| `--keep N` | 备份成功后，只保留 `backups/` 中最新的 `N` 个备份（`backups/upgrade` 中的升级备份不受影响）。复制到其他地方的副本需要你自己轮换。 |

`.sha256` 文件按文件名记录备份，因此无论副本在哪里，都可以用 `sha256sum -c libreoj-<UTC 时间>.tar.gz.sha256` 检查。

生成密钥时，请在另一台机器上运行 `gpg --quick-gen-key "LLMOJ backups" future-default encrypt never`，再运行 `gpg --armor --export "LLMOJ backups" > llmoj-backups.asc`，只把 `llmoj-backups.asc` 复制到服务器。请妥善保管私钥（`gpg --armor --export-secret-keys "LLMOJ backups"`）：没有它，加密的备份无法恢复。

要在每天 3:00 备份、本机保留一周的备份并在另一台机器上保存副本，请创建 `/etc/systemd/system/llmoj-backup.service`：

```ini
[Unit]
Description=LLMOJ backup

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/LLMOJ/deploy/backup.sh --encrypt-to /root/llmoj-backups.asc --copy-to backup@nas.example.org:llmoj/ --keep 7
```

和 `/etc/systemd/system/llmoj-backup.timer`：

```ini
[Unit]
Description=Nightly LLMOJ backup

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

然后运行 `sudo systemctl daemon-reload && sudo systemctl enable --now llmoj-backup.timer`。每次运行都会让网站短暂不可用，请选择访问较少的时间。

备份不包括沙箱镜像、已安装的运行环境、`/etc/systemd/system` 中的 drop-in、`data/ai-generated` 中未发布的 AI 结果，也不包括远程评测机。请另外保存你需要的其他内容，把备份存放到其他机器上，并实际演练恢复。备份中包含网站的全部密钥：离开服务器的备份请加密。

### 检查备份

```bash
sudo bash /opt/LLMOJ/deploy/verify-backup.zh-CN.sh /opt/LLMOJ/backups/libreoj-<UTC 时间>.tar.gz
```

`verify-backup.sh` 以英文输出相同内容。它在网站继续运行的同时检查备份能否恢复：

1. 归档与其 `.sha256` 文件一致，并且只包含 `backup.sh` 写入的内容：没有指向归档以外的路径或链接，没有设备文件。加密的备份（`.tar.gz.gpg`）用 root 的 GnuPG 密钥环中的私钥解密：请先在进行检查的机器上导入私钥（`sudo gpg --import llmoj-backups-private.asc`），最好不是服务器本身；
2. 把归档解到 `/var/tmp` 中的私有临时目录。可用 `--work-dir` 指定其他有足够空间的目录；它必须位于 `/var/tmp` 或 `/tmp` 下，这是 AppArmor 允许 MariaDB 在其自身目录之外工作的仅有位置；
3. 在该数据库副本上启动一个独立的 MariaDB（不联网、使用自己的套接字），并对每张数据表运行 `CHECK TABLE`；
4. 检查数据库列出的每个文件都在备份的对象存储中；
5. 在该存储副本上启动一个临时 MinIO（只监听本机接口，以无特权用户运行），读取数据库记录了内容哈希的每个文件，比较哈希和大小。`--no-contents` 跳过这一步（它会读取全部存储）；
6. 用 `data/ai/master.key` 和 `data/ai/two-factor.key` 尝试解密它们保护的已保存 AI 设置和验证器密钥；
7. 停止临时服务并删除副本。`--keep` 保留副本以便检查；用完后请删除，因为其中含有密钥。

它只输出数量，从不输出内容或密钥；备份无法直接恢复时以 1 退出。运行期间需要容纳解开副本的磁盘空间，以及临时 MariaDB 的少量内存（缓冲池为 64 MB）。它无法证明恢复后的网站能评测提交：为此请在备用机器上演练恢复。

### 恢复备份

请恢复到相同 LLMOJ 版本、相同角色（网站和评测，或仅网站）和相同安装目录的安装中。在新机器上，请先安装该版本。后端拒绝在缺少其版本所需数据表或列的数据库上启动（[启动时检查数据库](Upgrade.zh-CN.md#启动时检查数据库)），因此较旧版本的备份需要先安装该版本，再升级。以下步骤用备份中的配置和数据替换网站当前的配置和数据；当前的内容会被移到一旁，不会删除。操作期间网站不可用。

加密的备份需先在私钥所在的地方解密：`gpg --output libreoj-<UTC 时间>.tar.gz --decrypt libreoj-<UTC 时间>.tar.gz.gpg`。然后：

```bash
sudo bash /opt/LLMOJ/deploy/verify-backup.zh-CN.sh /path/to/libreoj-<UTC 时间>.tar.gz
sudo systemctl stop libreoj.target
sudo systemctl stop libreoj-nginx libreoj-judge libreoj-backend libreoj-minio libreoj-redis libreoj-mariadb
findmnt -rn -o TARGET | grep '^/opt/LLMOJ/data/'
```

仅网站的安装请去掉 `libreoj-judge`。只有最后一条命令没有任何输出时才能继续：评测工作目录必须已卸载。如果列出了挂载点，请用 `sudo systemctl stop 'opt-LLMOJ-data-judge-work-*.mount'` 停止它们后再检查一次。

```bash
cd /opt/LLMOJ
sudo mv config config.before-restore
sudo mv data data.before-restore
sudo tar --numeric-owner -xzf /path/to/libreoj-<UTC 时间>.tar.gz config data
for name in judge tmp nginx ai-generated; do if [ -e "data.before-restore/$name" ]; then sudo mv "data.before-restore/$name" data/; fi; done
```

最后一行取回备份中不包含的内容：评测目录、临时文件和 Nginx 的工作目录。在其他机器上，系统用户的 ID 可能不同，因此请为恢复的文件设置所有者：

```bash
sudo chown -R mysql:mysql data/mariadb data/mariadb-init
sudo chown -R redis:redis data/redis
sudo chown -R libreoj:libreoj data/minio data/ai data/ai-sample-inputs data/backend-archives
sudo chgrp libreoj config/backend.yaml
sudo chgrp mysql config/mariadb.cnf
sudo chgrp redis config/redis.conf
```

然后启动网站并检查：

```bash
sudo systemctl start libreoj.target
sudo bash /opt/LLMOJ/deploy/doctor.zh-CN.sh
```

请登录、上传并下载一个小文件，并评测一个提交。备份时的会话仍然有效；要让所有人退出登录，请在启动前在 `config/backend.yaml` 中设置新的随机 `security.sessionSecret`（例如用 `openssl rand -hex 32` 生成）。如果新机器的 CPU 不同，请用[扩缩容命令](Judge-Configuration.zh-CN.md)让评测适应它。确认网站正常后，请自行删除 `config.before-restore` 和 `data.before-restore`。

来源：[configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-local.py)、[nginx.conf.example](https://github.com/houyhlouis/LLMOJ/blob/main/config/nginx.conf.example)、[configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py)、[backup.sh](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/backup.sh)、[doctor.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/doctor.py)、[verify-backup.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/verify-backup.py)。
