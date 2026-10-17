# 安装后运维

简体中文 | [English](Operations-Configuration.md) | [Wiki 首页](Home.md) | [配置总览](Configuration.zh-CN.md)

本页列出安装器为 Nginx、Redis、MariaDB、MinIO 和 systemd 写入的设置，说明哪些设置需要一起修改，并介绍统计数据和备份。`<root>` 表示安装目录，默认为 `/opt/LLMOJ`。本页没有列出的设置，请参阅对应软件版本的文档。

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

页面报告服务器错误时，消息末尾会附上错误编号。后端日志以同一编号（在行首的方括号中）记录了详细信息；对于 AI 页面，日志只记录错误类型，不记录具体内容。每个 API 响应的 `X-Request-Id` 头中也带有它的编号。

```bash
sudo journalctl -u libreoj-backend --since today | grep '消息中的错误编号'
```

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
4. 重新启动之前在运行的服务，即使备份失败也是如此；之前已停止的站点保持停止。

备份不包括沙箱镜像、已安装的运行环境、`/etc/systemd/system` 中的 drop-in、`data/ai-generated` 中未发布的 AI 结果，也不包括远程评测机。请另外保存你需要的其他内容，把备份存放到其他机器上，并实际演练恢复。

来源：[configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-local.py)、[nginx.conf.example](https://github.com/houyhlouis/LLMOJ/blob/main/config/nginx.conf.example)、[configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py)、[backup.sh](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/backup.sh)。
