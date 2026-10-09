# Infrastructure and post-install operations

English | [简体中文](Operations-Configuration.zh-CN.md) | [Configuration overview](Configuration.md)

These tables cover infrastructure settings emitted by project templates/generators. Other third-party directives belong to their version-specific documentation. `<root>` is the installation directory, default `/opt/LibreOJ`. Back up and record original settings before editing; plan a maintenance window for database/storage migrations.

## Nginx: config/nginx.conf

| Setting | Generated value and purpose |
| --- | --- |
| `user`, `worker_processes`, `events.worker_connections` | `www-data`, `auto`, `1024`; Nginx workers/connections, independent of judge capacity |
| `pid`, `access_log`, `error_log`, `log_format` | PID `<root>/data/nginx/nginx.pid`; logs `<root>/logs/nginx`; `private_request` uses `$uri` to omit secret-bearing query strings |
| `include`, `default_type` | `/etc/nginx/mime.types` and `application/octet-stream` |
| `client_max_body_size` | `128m`; an outer proxy or backend per-file limits can be lower |
| `client_body_temp_path`, `proxy_temp_path` | `<root>/data/nginx/client_body` and `proxy`; keep writable by www-data |
| `listen`, `server_name`, `root` | Installer-selected address/port, default `0.0.0.0:80`; `server_name _`; static root `<root>/public` |
| `map $http_upgrade $connection_upgrade` | Use `upgrade` when Upgrade is present, otherwise `close`; WebSocket support |
| `location /api/` | `proxy_pass http://127.0.0.1:2002`, HTTP/1.1; forwards Host, X-Real-IP, X-Forwarded-For, X-Forwarded-Proto |
| `location /api/socket`, `location /socket.io/` | Same backend with Upgrade/Connection; read/send timeouts `3600s`; judge `/api/socket` disables access logging and limits error logs to crit |
| `location /storage/` | `proxy_pass http://127.0.0.1:19000/` removes prefix; Host restores signed `127.0.0.1:19000`; HTTP/1.1, empty Connection, request/response buffering off |
| `location /`, `try_files` | `$uri $uri/ /index.html`; SPA deep-link fallback |

## Redis: config/redis.conf

| Setting | Generated value and purpose |
| --- | --- |
| `bind`, `port`, `protected-mode`, `requirepass` | `127.0.0.1`, `16379`, `yes`, generated password; match backend Redis URL |
| `dir`, `appendonly`, `appendfsync`, `save` | `<root>/data/redis`; `yes`; `everysec`; snapshot rules `900 1` and `300 10` |
| `maxmemory`, `maxmemory-policy` | `192mb`, `noeviction`; writes can fail when full; monitor sessions/queues and avoid evicting task data |
| `logfile`, `daemonize` | Empty string, `no`; logs go to systemd |

## MariaDB: config/mariadb.cnf

| Setting | Generated value and purpose |
| --- | --- |
| `user`, `bind-address`, `port` | `mysql`, `127.0.0.1`, `13306` |
| `datadir`, `socket`, `pid-file`, `log-error` | Data `<root>/data/mariadb`, containing mysql.sock/mysql.pid; log `<root>/logs/mariadb/error.log` |
| `character-set-server`, `collation-server` | `utf8mb4`, `utf8mb4_unicode_ci`; changes do not convert existing tables automatically |
| `innodb-buffer-pool-size`, `max-connections`, `skip-name-resolve` | `128M`, `60`, enabled; size against memory/connection load, distinct from backend pool settings |

## MinIO: config/minio.env and service unit

| Setting | Generated value and purpose |
| --- | --- |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | Instance storage credentials in root:root 0600 minio.env; must match backend accessKey/secretKey |
| `MINIO_BROWSER`, `MINIO_UPDATE`, `MINIO_CALLHOME_ENABLE` | All `off`; environment settings emitted by this project |
| `--address`, `--console-address`, `server PATH` | `127.0.0.1:19000`, `127.0.0.1:19001`, `<root>/data/minio`; in systemd ExecStart |

## systemd

| Field | Generated behavior |
| --- | --- |
| `User`, `Group` | MariaDB mysql, Redis redis, backend/MinIO libreoj; Nginx workers drop privileges; judge permissions/delegation in judge guide |
| `WorkingDirectory`, `ExecStart`, `Environment`, `EnvironmentFile` | Instance paths; generated backend working directory apps/backend; runtime environment in Environment guide; MinIO loads minio.env |
| `After`, `Requires`, `PartOf`, `Wants`, `WantedBy` | Backend requires three storage services; Nginx requires backend; services PartOf/WantedBy libreoj.target; target Wants site services (judge in all mode) and is WantedBy multi-user.target |
| `Restart`, `RestartSec`, `UMask`, `LimitCORE` | Web/storage services use `on-failure`, `3` seconds, `0077`, `0`; judge UMask is `0022` |
| `StandardOutput`, `StandardError` | Both `journal`; do not print secrets into service logs |
| `TimeoutStartSec` | MariaDB `120` seconds |
| `Type`, `ExecReload`, `KillSignal` | Nginx `simple`, reload using instance-specific -p/-c, exit signal SIGQUIT |
| `AllowedCPUs`, `UV_THREADPOOL_SIZE`, `TasksMax`, `Delegate`, `RequiresMountsFor` | Judge resource settings and workspace mounts must match; complete generated parameters in judge guide |

Installed units live in `/etc/systemd/system`; `deploy/systemd` contains generated installation sources. Persistent environment/resource overrides can use service drop-ins such as `sudo systemctl edit libreoj-backend`; daemon-reload still requires a process restart. Check whether a drop-in overrides newly generated AllowedCPUs/thread-pool settings. Full unit/environment output may contain secrets; inspect only in a trusted terminal.

The installer also writes `vm.overcommit_memory=1` to `/etc/sysctl.d/99-libreoj-redis.conf` for Redis, retaining an existing custom file, and installs required sandbox AppArmor rules. Docker package sources and `registry-mirrors` are covered in [Docker sources](Docker-Sources.md). Node/Go/pnpm versions and rootfs IDs are installer/build recipe choices, not backend.yaml options.

## Settings that must change together

| Goal | Related settings |
| --- | --- |
| Resize CPU/RAM/judge slots | judge.yaml slots/workspaces/affinity, thread pool, mounts, service AllowedCPUs; follow [resizing](Judge-Configuration.md) for verification and rollback |
| Change site name/logo | Backend `preference.siteName`, `preference.misc.appLogo`; rebuild initial title/static assets via [frontend configuration](Frontend-Configuration.md) |
| Change website port/listener | Nginx listen, browser URL, MinIO forUserUpload/forUserDownload/forJudge.urlEndpoint when the public port changes, local `downloadEndpointOverride` loopback port, remote judge.yaml serverUrl, firewall/outer proxy |
| Change domain or enable HTTPS | All three MinIO urlEndpoint values become final `https://new-domain/storage/`; TLS proxy/trusted forwarding, remote judge.yaml serverUrl, allowed mail-link origins; see HTTPS |
| Change database/Redis/storage | Back up/migrate data first; match backend endpoints and server credentials/listeners; URI-encode Redis URL passwords; match MinIO signed Host/prefix; editing secrets.json alone is insufficient |
| Enable mail/email verification | Set `services.mail.address` and a real `transport`; verify delivery before enabling `preference.security.requireEmailVerification`; default jsonTransport does not send mail |
| Increase upload sizes | Nginx `client_max_body_size`, outer proxy, matching backend `resourceLimit` entries, free disk, and browser type limits |
| Increase service memory | Budget V8 `NODE_OPTIONS`, Redis maxmemory, MariaDB buffer pool, judge processes, and tmpfs separately; slot count is only one part |

### Validate Nginx changes

Substitute the actual instance paths. If validation fails, do not reload; restore the backup and test again.

```bash
sudo /usr/sbin/nginx -t -p /opt/LibreOJ/ -c /opt/LibreOJ/config/nginx.conf
# Run only after the preceding check succeeds.
sudo systemctl reload libreoj-nginx
```

Restart `libreoj-backend` for backend YAML changes. Restart database/Redis/MinIO in a maintenance window when their configuration changes. Verify login, a normal submission, a small upload/download, remote judge connectivity, and basic AI worker execution; a home-page HTTP 200 alone is insufficient. For an outer TLS proxy, preserve WebSocket and signed storage behavior as described in [HTTPS](HTTPS.md).

## Secrets, installation state, and backups

`config/secrets.json` fields `database`, `redis`, `minioAccess`, `minioSecret`, `session`, `maintenance`, `judge`, and `instanceId` are generator records, not live-update controls. Rotation requires matching real service credentials, backend.yaml, judge records, and clients. Do not delete the file and rerun installation. `config/admin-credentials.json` records initial administrator credentials, verified before terminal display; editing it does not change the account password. `config/install-state.json` records initial inputs/phases, not later capacity changes.

The AI state directory holds the master key; encrypted user API settings live in MariaDB `ai_configuration.encrypted`. Back up and restore the database with its matching key, and move the key when changing the state directory, as described in [AI environment](AI-Environment.md). Do not recursively chown the instance: rootfs and judge workspaces have specific UID/mount requirements.

`deploy/backup.sh` currently hardcodes `/opt/LibreOJ`. It stops site services, archives `config`, `data`, and `deploy`, excludes `data/judge`, `data/tmp`, `data/nginx`, and `data/ai-generated`, then starts the target on exit. It does not include the full rootfs, runtime binaries, or `/etc/systemd/system` drop-ins; save those separately or ensure they can be rebuilt at the same version. Unpublished results in `data/ai-generated` are also excluded. It is not a universal backup for custom prefixes or remote judges. Preserve any additional required data and test restoration.

Sources: [deploy/configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-local.py), [config/nginx.conf.example](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/config/nginx.conf.example), [deploy/configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/configure-judge.py), [deploy/backup.sh](https://github.com/houyhlouis/LLMOJ/blob/43a88bdd62fbf200889b36932fa921439a293190/deploy/backup.sh).
