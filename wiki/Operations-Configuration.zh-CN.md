# 基础服务与安装后运维配置

[English](Operations-Configuration.md) | 简体中文 | [配置总览](Configuration.zh-CN.md)

本文列出项目模板／生成器写入的基础服务配置，第三方软件其他可选指令以其对应版本文档为准。表中 `<root>` 为安装目录，默认 `/opt/LibreOJ`。修改配置前先备份并记录原值；数据库或存储迁移须规划维护窗口。

## Nginx：config/nginx.conf

| 参数 | 生成值与作用 |
| --- | --- |
| `user`, `worker_processes`, `events.worker_connections` | `www-data`、`auto`、`1024`；Nginx 工作进程及连接，不等于评测并发 |
| `pid`, `access_log`, `error_log`, `log_format` | PID 在 `<root>/data/nginx/nginx.pid`；日志在 `<root>/logs/nginx`；`private_request` 使用 `$uri`，不记录含密钥的查询串 |
| `include`, `default_type` | `/etc/nginx/mime.types` 与 `application/octet-stream` |
| `client_max_body_size` | `128m`；外层代理和后端单项上传限制还可能更小 |
| `client_body_temp_path`, `proxy_temp_path` | `<root>/data/nginx/client_body` 和 `proxy`；保持 www-data 可写 |
| `listen`, `server_name`, `root` | 安装参数生成监听地址／端口，默认 `0.0.0.0:80`；`server_name _`；静态目录 `<root>/public` |
| `map $http_upgrade $connection_upgrade` | 有 Upgrade 时用 `upgrade`，空时 `close`；支持 WebSocket |
| `location /api/` | `proxy_pass http://127.0.0.1:2002`，HTTP/1.1；Host、X-Real-IP、X-Forwarded-For、X-Forwarded-Proto 转发给后端 |
| `location /api/socket`, `location /socket.io/` | 同一后端，额外 Upgrade／Connection；`proxy_read_timeout`、`proxy_send_timeout` 都为 `3600s`；评测 `/api/socket` 关闭 access_log，error_log 仅 crit |
| `location /storage/` | `proxy_pass http://127.0.0.1:19000/` 去掉前缀；Host 必须恢复为签名用的 `127.0.0.1:19000`；HTTP/1.1、Connection 空、`proxy_request_buffering off`、`proxy_buffering off` |
| `location /`, `try_files` | `$uri $uri/ /index.html`；页面深链接回退 |

## Redis：config/redis.conf

| 参数 | 生成值与作用 |
| --- | --- |
| `bind`, `port`, `protected-mode`, `requirepass` | `127.0.0.1`、`16379`、`yes`、随机实例密码；与后端 Redis URL 同步 |
| `dir`, `appendonly`, `appendfsync`, `save` | `<root>/data/redis`；`yes`；`everysec`；`900 1` 和 `300 10` 两条快照规则 |
| `maxmemory`, `maxmemory-policy` | `192mb`、`noeviction`；用满后写入可失败，监控会话／队列，不能随意改成淘汰任务数据 |
| `logfile`, `daemonize` | 空字符串、`no`；日志交给 systemd |

## MariaDB：config/mariadb.cnf

| 参数 | 生成值与作用 |
| --- | --- |
| `user`, `bind-address`, `port` | `mysql`、`127.0.0.1`、`13306` |
| `datadir`, `socket`, `pid-file`, `log-error` | 数据目录 `<root>/data/mariadb`；其下 mysql.sock、mysql.pid；日志 `<root>/logs/mariadb/error.log` |
| `character-set-server`, `collation-server` | `utf8mb4`、`utf8mb4_unicode_ci`；改默认不会自动转换现有表 |
| `innodb-buffer-pool-size`, `max-connections`, `skip-name-resolve` | `128M`、`60`、启用；依据内存和连接负载规划，不等于后端连接池配置 |

初始化现在以 mysql 身份在私有暂存目录进行，校验系统表后再发布；已有目录不会因存在 `mysql/` 就被判定为完整。AppArmor 的 Err13 机制、保留失败数据及重试边界见 [安装排错](Installation.zh-CN.md#mariadb-初始化失败与安全重试)。不要通过关闭 AppArmor、添加 DAC 绕过能力或删除数据库来跳过检查。

## MinIO：config/minio.env 与服务单元

| 参数 | 生成值与作用 |
| --- | --- |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | 实例存储凭据，写入 root:root 0600 的 minio.env；必须与后端 accessKey／secretKey 一致 |
| `MINIO_BROWSER`, `MINIO_UPDATE`, `MINIO_CALLHOME_ENABLE` | 均为 `off`；项目生成的环境选项 |
| `--address`, `--console-address`, `server PATH` | `127.0.0.1:19000`、`127.0.0.1:19001`、`<root>/data/minio`；在 systemd ExecStart 内 |

## systemd

| 字段 | 生成规则 |
| --- | --- |
| `User`, `Group` | MariaDB 用 mysql，Redis 用 redis，后端／MinIO 用 libreoj；Nginx 主进程启动后降权；评测服务权限和委派见评测页 |
| `WorkingDirectory`, `ExecStart`, `Environment`, `EnvironmentFile` | 指向实例路径；生成器将后端工作目录设为 apps/backend；运行变量见环境页；MinIO 加载 minio.env |
| `After`, `Requires`, `PartOf`, `Wants`, `WantedBy` | 后端依赖三个存储服务，Nginx 依赖后端；服务 PartOf／WantedBy libreoj.target；target Wants 站点服务（all 含 judge），WantedBy multi-user.target |
| `Restart`, `RestartSec`, `UMask`, `LimitCORE` | 网页／存储服务 `on-failure`、`3` 秒、`0077`、`0`；评测 UMask 为 `0022` |
| `StandardOutput`, `StandardError` | 均 `journal`；systemd 日志中仍不可随意打印密钥 |
| `TimeoutStartSec` | MariaDB `120` 秒 |
| `Type`, `ExecReload`, `KillSignal` | Nginx `simple`，执行带本实例 -p/-c 的 nginx -s reload，退出信号 SIGQUIT |
| `AllowedCPUs`, `UV_THREADPOOL_SIZE`, `TasksMax`, `Delegate`, `RequiresMountsFor` | 评测资源配置及工作目录 mount 必须同步，完整生成参数见评测页 |

安装后的实际单元在 `/etc/systemd/system`，`deploy/systemd` 是生成／安装源，两者不能混淆。长期自定义环境或资源上限可使用 `sudo systemctl edit libreoj-backend` 等服务 drop-in；运行 `daemon-reload` 后还需重启对应进程。检查 drop-in 是否覆盖了新生成的 AllowedCPUs／线程池，不要以为生成成功就已生效。读取完整单元或环境时可能包含秘密，仅在可信终端查看。

安装器另为 Redis 写入 `/etc/sysctl.d/99-libreoj-redis.conf` 的 `vm.overcommit_memory=1`（保留已有同名自定义文件），并安装所需沙盒 AppArmor 规则。Docker 软件包源和 `registry-mirrors` 见 [Docker 源](Docker-Sources.zh-CN.md)。Node/Go/pnpm 版本、rootfs ID 是安装／构建配方选择，不是可通过 backend.yaml 修改的配置。

## 常见修改的完整关联

| 目标 | 一起检查的设置 |
| --- | --- |
| 增减 CPU／内存、评测槽数 | judge.yaml 的执行槽／工作目录／CPU、threadpool、mount、服务 AllowedCPUs；按 [专门流程](Judge-Configuration.zh-CN.md) 验证与回滚 |
| 修改站名或 logo | 后端 `preference.siteName`、`preference.misc.appLogo`；初始标题与静态资源另按 [前端配置](Frontend-Configuration.zh-CN.md) 构建 |
| 修改站点端口／监听 | nginx.conf 的 listen；浏览器访问 URL；有端口变化时的 MinIO `forUserUpload`／`forUserDownload`／`forJudge.urlEndpoint`；本机 `downloadEndpointOverride` 的回环端口；远程 judge.yaml 的 serverUrl；防火墙／外层代理 |
| 更换域名、HTTP → HTTPS | 三组 MinIO urlEndpoint 改为最终 `https://新域名/storage/`；TLS 代理和可信转发头；外部 judge.yaml 的 serverUrl；允许的邮件链接来源；见 HTTPS 页 |
| 更换数据库／Redis／对象存储 | 先迁移和备份数据，后端连接参数与服务端账号／监听同步；Redis URL 的密码做 URI 编码；MinIO 签名 endpoint 与代理 Host／前缀匹配；不要只改 secrets.json |
| 启用邮件与邮箱验证 | `services.mail.address` 和真正的 `transport`；先验证收信，再启用 `preference.security.requireEmailVerification`；默认 jsonTransport 不投递邮件 |
| 增大上传文件 | Nginx `client_max_body_size`、外层代理、后端 `resourceLimit` 对应单项限制及可用磁盘；同时核查浏览器上传类型限制 |
| 提高服务内存 | 分别规划 V8 `NODE_OPTIONS`、Redis maxmemory、MariaDB buffer pool、评测任务与 tmpfs；不能把增加槽数当作唯一设置 |

### 修改 Nginx 后验证

以下示例只适用于默认目录，先按实际路径替换。配置检查失败不要 reload，恢复备份后重新检查。

```bash
sudo /usr/sbin/nginx -t -p /opt/LibreOJ/ -c /opt/LibreOJ/config/nginx.conf
# Run only after the preceding check succeeds.
sudo systemctl reload libreoj-nginx
```

后端 YAML 配置变更重启 `libreoj-backend`，数据库／Redis／MinIO 变更在维护窗口重启对应服务。验证首页及登录、普通提交、小文件上传／下载、远程评测连接、AI worker 的基础运行；不要只验证首页 HTTP 200。HTTPS 外层代理还需按 [HTTPS](HTTPS.zh-CN.md) 保持 WebSocket 和签名存储请求一致。

## 机密文件、安装状态与备份

`config/secrets.json` 的 `database`、`redis`、`minioAccess`、`minioSecret`、`session`、`maintenance`、`judge`、`instanceId` 是生成器的实例记录，不会热更新正在运行的服务。轮换应逐项同步真实数据库／服务端配置、backend.yaml、judge 节点记录和客户端，不能删除整个文件后重跑。`config/admin-credentials.json` 记录初始管理员凭据，安装器会核验后在终端显示；它不是修改管理员密码的入口。`config/install-state.json` 记录初次安装参数和阶段，不是后续扩容控制面板。

AI 状态目录保存主密钥，用户 API 配置密文保存于 MariaDB 的 `ai_configuration.encrypted`；数据库与主密钥的备份、恢复必须配套，修改目录路径还需迁移对应主密钥，见 [AI 环境](AI-Environment.zh-CN.md)。不要递归 chown 整个实例来修复权限，rootfs 和评测工作区有特定 UID／挂载权限要求。

`deploy/backup.sh` 当前硬编码 `/opt/LibreOJ`，停掉站点服务后备份 `config`、`data`、`deploy`，排除 `data/judge`、`data/tmp`、`data/nginx`、`data/ai-generated`，并在退出时启动 target。它不包含完整 rootfs、运行时二进制和 `/etc/systemd/system` drop-in；这些需另存或能够按同一版本重建。`data/ai-generated` 中未发布的生成结果也不会进入该备份。自定义 prefix 或远程评测节点不能把它当作完整通用备份；保存额外数据后进行恢复演练。

来源：[deploy/configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-local.py), [config/nginx.conf.example](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/config/nginx.conf.example), [deploy/configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-judge.py), [deploy/backup.sh](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/backup.sh).
