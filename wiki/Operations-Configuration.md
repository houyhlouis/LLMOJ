# Operations

[简体中文](Operations-Configuration.zh-CN.md) | English | [Wiki home](Home.en.md) | [Configuration overview](Configuration.md)

This page lists the settings the installer writes for Nginx, Redis, MariaDB, MinIO and systemd, explains which settings must change together, and covers statistics and backups. `<root>` is the installation directory, `/opt/LLMOJ` by default. For settings not listed here, see the documentation of that program's version.

Before changing anything, back up the file and note the original values. Plan a quiet period for database or storage changes.

## Nginx: `config/nginx.conf`

| Setting | Value written by the installer |
| --- | --- |
| `user`, `worker_processes`, `events.worker_connections` | `www-data`, `auto`, `1024`. These are Nginx's own processes and have nothing to do with judging. |
| `pid`, `access_log`, `error_log`, `log_format` | PID file `<root>/data/nginx/nginx.pid`, logs in `<root>/logs/nginx`. The `private_request` log format records paths without query strings, which may contain keys. |
| `include`, `default_type` | `/etc/nginx/mime.types`, `application/octet-stream` |
| `client_max_body_size` | `128m` for files sent through `/storage/`; `32m` for `/api/`, the backend's own limit. A proxy in front or a backend limit for a particular kind of file may be lower. |
| `client_body_temp_path`, `proxy_temp_path` | `<root>/data/nginx/client_body` and `<root>/data/nginx/proxy`; `www-data` must be able to write to them |
| `listen`, `server_name`, `root` | The address and port chosen at installation (`0.0.0.0:80` by default), `_`, and `<root>/public` |
| `map $http_upgrade $connection_upgrade` | Lets WebSocket connections through |
| `location /api/` | Forwards to the backend at `http://127.0.0.1:2002` with the Host, X-Real-IP, X-Forwarded-For and X-Forwarded-Proto headers |
| `location /api/socket`, `location /socket.io/` | WebSocket connections to the backend, kept open up to an hour (`3600s`). The judge connection `/api/socket` isn't logged, and only critical errors are. |
| `location /storage/` | Forwards to MinIO at `http://127.0.0.1:19000/`, setting the Host header MinIO's download signatures expect, with buffering turned off |
| `location /` | Serves the frontend, falling back to `/index.html` so that links to any page work |

To check and apply a change (adjust the paths for your installation):

```bash
sudo /usr/sbin/nginx -t -p /opt/LLMOJ/ -c /opt/LLMOJ/config/nginx.conf
# only if the check succeeded:
sudo systemctl reload libreoj-nginx
```

If the check fails, don't reload: restore your backup and check again.

## Redis: `config/redis.conf`

| Setting | Value written by the installer |
| --- | --- |
| `bind`, `port`, `protected-mode`, `requirepass` | `127.0.0.1`, `16379`, `yes`, and a random password, which must match the backend's Redis address |
| `dir`, `appendonly`, `appendfsync`, `save` | `<root>/data/redis`, `yes`, `everysec`, and snapshots after `900 1` and `300 10` |
| `maxmemory`, `maxmemory-policy` | `192mb`, `noeviction`: when Redis is full, writes fail instead of deleting data. Keep an eye on its memory; don't switch to a policy that evicts keys, as it would drop sessions and queued work. |
| `logfile`, `daemonize` | Empty and `no`: logs go to systemd |

## MariaDB: `config/mariadb.cnf`

| Setting | Value written by the installer |
| --- | --- |
| `user`, `bind-address`, `port` | `mysql`, `127.0.0.1`, `13306` |
| `datadir`, `socket`, `pid-file`, `log-error` | Data in `<root>/data/mariadb` (with `mysql.sock` and `mysql.pid`), log in `<root>/logs/mariadb/error.log` |
| `character-set-server`, `collation-server` | `utf8mb4`, `utf8mb4_unicode_ci`. Changing them doesn't convert existing tables. |
| `innodb-buffer-pool-size`, `max-connections`, `skip-name-resolve` | `128M`, `60`, on. Size them for your memory and load; the backend's own connection pool is configured separately. |

If MariaDB fails to initialize during installation, see [Installation](Installation.md#mariadb-initialization-failures-and-safe-retries). Don't work round it by turning off AppArmor or deleting the database.

## MinIO: `config/minio.env` and its service

| Setting | Value written by the installer |
| --- | --- |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | Storage credentials, in `minio.env`, which only root can read. They must match `accessKey` and `secretKey` in `backend.yaml`. |
| `MINIO_BROWSER`, `MINIO_UPDATE`, `MINIO_CALLHOME_ENABLE` | All `off` |
| `--address`, `--console-address`, data directory | `127.0.0.1:19000`, `127.0.0.1:19001` and `<root>/data/minio`, given in the service's `ExecStart` |

## systemd services

| Setting | What the installer writes |
| --- | --- |
| `User`, `Group` | MariaDB runs as `mysql`, Redis as `redis`, the backend and MinIO as `libreoj`; Nginx's workers run as `www-data`. The judge's users are described in [Judge configuration](Judge-Configuration.md). |
| `WorkingDirectory`, `ExecStart`, `Environment`, `EnvironmentFile` | Paths in the installation directory; the backend runs in `apps/backend`; MinIO reads `minio.env`. Environment variables are listed in [Environment variables](Environment.md). |
| `After`, `Requires`, `PartOf`, `Wants`, `WantedBy` | The backend needs MariaDB, Redis and MinIO; Nginx needs the backend. All services are part of `libreoj.target`, which starts at boot. |
| `Restart`, `RestartSec`, `UMask`, `LimitCORE` | Web and storage services restart 3 seconds after a failure, with umask `0077` and no core dumps; the judge uses umask `0022`. |
| `StandardOutput`, `StandardError` | `journal` |
| `TimeoutStartSec` | MariaDB: 120 seconds |
| `Type`, `ExecReload`, `KillSignal` | Nginx: `simple`, reloads with its own configuration, stops on `SIGQUIT` |
| `AllowedCPUs`, `UV_THREADPOOL_SIZE`, `TasksMax`, `Delegate`, `RequiresMountsFor` | The judge's CPU, thread and mount settings, which must match `judge.yaml`; see [Judge configuration](Judge-Configuration.md) |

The services in use are in `/etc/systemd/system`; `deploy/systemd` holds the templates they're generated from. To change an environment variable or a resource limit permanently, add a drop-in, for example with `sudo systemctl edit libreoj-backend`, then run `sudo systemctl daemon-reload` and restart the service. Check that a drop-in doesn't override settings the installer or the resize command writes, such as `AllowedCPUs`. The full unit and its environment may contain secrets, so only look at them in a trusted terminal.

The installer also sets `vm.overcommit_memory=1` for Redis in `/etc/sysctl.d/99-libreoj-redis.conf` (unless that file already exists) and installs the AppArmor rules the judge's sandbox needs. Docker sources are described in [Docker sources](Docker-Sources.md). The versions of Node.js, Go and pnpm and the sandbox image are part of each release, not settings.

## Settings that change together

| To change | Also change |
| --- | --- |
| CPUs, memory or judge slots | Use the [resize command](Judge-Configuration.md), which updates `judge.yaml`, the judge service and its checks together. |
| Site name or logo | `preference.siteName` and `preference.misc.appLogo` in `backend.yaml`, then [rebuild the frontend](Frontend-Configuration.md) for the name shown while pages load. |
| The site's port or listening address | `listen` in `nginx.conf`; the address people use; if the public port changes, the MinIO addresses `forUserUpload`, `forUserDownload` and `forJudge.urlEndpoint`; the port in a local `downloadEndpointOverride`; `serverUrl` in each remote judge's `judge.yaml`; the firewall and any proxy in front. |
| The domain, or HTTP to HTTPS | All three MinIO `urlEndpoint` values become `https://<new domain>/storage/`; the HTTPS proxy and its forwarded headers; `serverUrl` on remote judges; the addresses allowed in emailed links. See [HTTPS](HTTPS.md). |
| Database, Redis or file storage | Back up and move the data first, then make the backend's connection settings match the servers' addresses and passwords. Percent-encode special characters in a password in the Redis URL. Editing `secrets.json` alone changes nothing. |
| Turning on email and email verification | Set `services.mail.address` and a real `transport` and check that mail arrives before turning on `preference.security.requireEmailVerification`. The default `jsonTransport` doesn't send anything. |
| Larger uploads | `client_max_body_size` in Nginx and any proxy in front, the matching `resourceLimit` in `backend.yaml`, and free disk space |
| More memory for services | Plan Node.js (`NODE_OPTIONS`), Redis `maxmemory`, the MariaDB buffer pool, judging and temporary file systems separately; judge slots are only part of it. |

After a change, restart what it affects: `libreoj-backend` for `backend.yaml`, and MariaDB, Redis or MinIO at a quiet time for theirs. Then check more than that the home page loads: sign in, make a submission, upload and download a small file, check that remote judges reconnect, and run a small AI job.

## Submission and accepted counts

The submission and accepted counts of each problem, and the submission and accepted-problem counts of each user, always match the non-contest submissions. Each change is recorded together with the submission and applied straight after it; if the backend stops in between, another backend process, or the same one after restarting, applies it within about a minute.

To check the counts against the submissions, for example after restoring a backup or going back to an older version:

```bash
sudo bash /opt/LLMOJ/deploy/rebuild-statistics.sh
```

It prints one line of JSON: for `problems` and `users`, how many rows differ, with up to 20 examples showing the `stored` and `counted` values. To correct them:

```bash
sudo bash /opt/LLMOJ/deploy/rebuild-statistics.sh --apply
```

Both are safe while the site is running. Use `--prefix` for another installation directory.

## Secrets and installation records

- `config/secrets.json` records the passwords and keys generated at installation (`database`, `redis`, `minioAccess`, `minioSecret`, `session`, `maintenance`, `judge`, `instanceId`). Editing it doesn't change them anywhere: to change one, change it in the service that uses it, in `backend.yaml` and on the judges. Never delete the file and reinstall.
- `config/admin-credentials.json` records the first administrator's password; changing the file doesn't change the account.
- `config/install-state.json` records the original installation options and progress, not later changes such as resizing.
- The AI state directory holds the AI master key and `two-factor.key`. They decrypt users' AI keys (`ai_configuration.encrypted`) and authenticator secrets (`user_two_factor`) in the database, so a database backup is only usable with the matching keys. To move the directory, see [AI environment](AI-Environment.md).

Don't change the owner of the whole installation directory recursively: the sandbox image and judge directories need specific owners and mounts.

## Backups

```bash
sudo bash /opt/LLMOJ/deploy/backup.sh
```

It backs up `/opt/LLMOJ`, or the directory given with `--prefix` (or `HYHOJ_ROOT`). It:

1. refuses to run while an installation, upgrade or judge resize is in progress;
2. stops the site's services, so the site is down while it runs;
3. writes `config`, `data` and `deploy` to `backups/libreoj-<UTC time>.tar.gz` with a `.sha256` checksum, leaving out `data/judge`, `data/tmp`, `data/nginx` and `data/ai-generated`;
4. starts again whatever was running before, even if the backup failed; a site that was stopped stays stopped.

The backup doesn't include the sandbox image, the installed runtimes, systemd drop-ins in `/etc/systemd/system`, unpublished AI results in `data/ai-generated` or remote judges. Keep copies of anything else you need, store backups on another machine, and practise restoring one.

Sources: [configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-local.py), [nginx.conf.example](https://github.com/houyhlouis/LLMOJ/blob/main/config/nginx.conf.example), [configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py), [backup.sh](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/backup.sh).
