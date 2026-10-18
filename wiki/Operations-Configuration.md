# Operations

[简体中文](Operations-Configuration.zh-CN.md) | English | [Wiki home](Home.en.md) | [Configuration overview](Configuration.md)

This page lists the settings the installer writes for Nginx, Redis, MariaDB, MinIO and systemd, explains which settings must change together, and covers health checks, statistics and backups. `<root>` is the installation directory, `/opt/LLMOJ` by default. For settings not listed here, see the documentation of that program's version.

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

### Server errors

When a page reports a server error, the message ends with an error ID. The backend's log has the details under the same ID, in brackets at the start of the line. For AI pages, the log names only the kind of error, never its details. Every API response also carries its ID in the `X-Request-Id` header, and every other line the backend logs while answering that request is marked `[request <ID>]`, so one search finds them all.

```bash
sudo journalctl -u libreoj-backend --since today | grep 'ERROR-ID-FROM-THE-MESSAGE'
```

## Health checks

### Doctor

```bash
sudo bash /opt/LLMOJ/deploy/doctor.sh
```

`doctor.zh-CN.sh` prints the same in Chinese. Doctor only reads: it starts, stops and writes nothing, and prints no password, key or token. It checks:

| Area | What it checks |
| --- | --- |
| Installation | The version and the last upgrade; an upgrade that stopped halfway |
| Services | Each service runs and hasn't been restarting after failures; `libreoj.target` starts at boot |
| Backend | The backend answers and reaches the database, Redis and object storage; Nginx passes requests to it; HTTPS certificates set in `nginx.conf` are valid for at least 14 more days |
| Redis | It saves its data to disk; how full it is (writes fail when it's full); that it never evicts keys; its number of connections |
| Database, object storage | MariaDB and MinIO answer; the size of the site's data |
| Judging on this server | The sandbox image is the configured one; the judge can limit CPU, memory and processes; its workspaces are mounted; the AI runner socket exists |
| Work queues | Connected judge machines, waiting submissions and how long the oldest has waited, tasks that lost their judge machine, failed tasks, how far the problem and user counts are behind, waiting AI jobs. Needs the backend's [metrics](#metrics), which the installer turns on. |
| This server | Free disk space and file entries, available memory, whether the clock is synchronized |
| Files and permissions | Configuration, keys, data directories and backups have the owners the installer gives them, and other users can't read them |
| Backups | The age of the latest `backup.sh` backup; the space upgrade backups use |

Each line is **OK**, **INFO**, **WARN** or **FAIL**, and the command exits with 1 if anything failed, otherwise 0. `--json` prints the result as JSON, for monitoring; `--prefix` checks another installation directory. Doctor doesn't run programs in the sandbox, because that competes with judging: for an in-depth check of the sandbox and every language, run `sudo bash /opt/LLMOJ/deploy/sandbox/self-test.sh`.

### Liveness and readiness

The backend answers two addresses without a session, also on sites that visitors can't view:

| Address | Answer |
| --- | --- |
| `/api/health/live` | `200` and `{"status":"ok"}` while the process answers requests |
| `/api/health/ready` | `200` when the database, Redis and object storage each answer within 2 seconds; otherwise `503`, with `"failed"` for each one that didn't. Probes within one second share a check. |

The installer and the upgrader wait for `/api/health/ready` before they open the site. A monitor can use `http://<your site>/api/health/ready` through Nginx. The answers name only which dependency failed; the backend logs the reason, at most once a minute.

### Metrics

With `metrics` set in `backend.yaml` (the installer sets `127.0.0.1:2020`), `http://127.0.0.1:2020/metrics` serves Prometheus metrics. Besides request times and Node.js figures, these describe the work queues. They're read from the database when the metrics are read:

| Metric | Meaning | Look into it when |
| --- | --- | --- |
| `libreoj_judge_clients{state}` | Judge machines connected to this backend process, `accepting` or `draining` | none is accepting |
| `libreoj_judge_jobs{state}` | Judging tasks waiting (`Queued`) or being judged (`Leased`) | |
| `libreoj_judge_oldest_queued_job_seconds` | How long the oldest waiting task has waited | it keeps growing |
| `libreoj_judge_expired_leases` | Tasks whose judge machine stopped answering and that aren't queued again yet | it stays above 0 for more than a minute |
| `libreoj_judge_failed_jobs_last_day` | Tasks that failed in the last 24 hours | above 0: see **Judge queue** on the **Judge Machine** page |
| `libreoj_statistics_outbox_pending`, `libreoj_statistics_outbox_oldest_seconds` | [Count changes](#submission-and-accepted-counts) not applied yet, and the age of the oldest | the age passes a few minutes |
| `libreoj_ai_jobs{state}`, `libreoj_ai_oldest_queued_job_seconds` | AI jobs `queued` and `running`, and how long the oldest has waited | |
| `libreoj_ai_provider_requests{state}` | Model requests `running`, and `waiting` for a free slot under the AI limits in **Site management** | many wait for long |
| `libreoj_ai_paused` | 1 while AI is paused | |
| `libreoj_ai_worker_errors{stage}` | Errors of the AI job scheduler (`worker`) and internal errors of jobs (`job`) since the backend started | it grows: see the backend log |
| `libreoj_error_count{error}` | Server errors by type, including lost database or Redis connections | it grows |

A value that couldn't be read is `NaN`, with the reason in the backend's log, never an old number. No metric carries a user, source code or key.

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

A backup holds every secret of the site. To keep a copy elsewhere encrypted, for example with GnuPG and a key whose private part isn't on the server: `gpg --encrypt --recipient YOUR-KEY-ID libreoj-<UTC time>.tar.gz`, then copy the `.gpg` file and the `.sha256` file.

### Verifying a backup

```bash
sudo bash /opt/LLMOJ/deploy/verify-backup.sh /opt/LLMOJ/backups/libreoj-<UTC time>.tar.gz
```

`verify-backup.zh-CN.sh` prints the same in Chinese. It checks that the backup can be restored, while the site keeps running:

1. the archive matches its `.sha256` file and holds only what `backup.sh` writes: no paths or links that leave it, no device files;
2. it unpacks the archive into a private temporary directory in `/var/tmp`. Use `--work-dir` for another directory with room for the unpacked backup; it must be under `/var/tmp` or `/tmp`, the only places outside its own where AppArmor lets MariaDB work;
3. it starts a separate MariaDB on that copy of the database, without network access and on its own socket, and runs `CHECK TABLE` on every table;
4. it checks that each file the database lists is in the backup's object storage;
5. it tries `data/ai/master.key` and `data/ai/two-factor.key` on the saved AI settings and authenticator secrets they protect;
6. it stops that MariaDB and deletes the copy. `--keep` keeps the copy for inspection; delete it afterwards, because it holds secrets.

It prints counts, never contents or secrets, and exits with 1 if the backup can't be restored as it is. While it runs, it needs disk space for the unpacked copy and some memory for the temporary MariaDB, which gets a 64 MB buffer pool. It can't show that a restored site judges submissions: for that, practise a restore on a spare machine.

### Restoring a backup

Restore into an installation of the same LLMOJ version, with the same role (site and judge, or site only) and installation directory. On a new machine, install that version first. These steps replace the site's configuration and data with the backup's; the current ones are moved aside, not deleted. The site is down while you do this:

```bash
sudo bash /opt/LLMOJ/deploy/verify-backup.sh /path/to/libreoj-<UTC time>.tar.gz
sudo systemctl stop libreoj.target
sudo systemctl stop libreoj-nginx libreoj-judge libreoj-backend libreoj-minio libreoj-redis libreoj-mariadb
findmnt -rn -o TARGET | grep '^/opt/LLMOJ/data/'
```

On a site-only installation, leave `libreoj-judge` out. Continue only when the last command prints nothing: the judge's workspaces must be unmounted. If it lists some, stop them with `sudo systemctl stop 'opt-LLMOJ-data-judge-work-*.mount'` and check again.

```bash
cd /opt/LLMOJ
sudo mv config config.before-restore
sudo mv data data.before-restore
sudo tar --numeric-owner -xzf /path/to/libreoj-<UTC time>.tar.gz config data
for name in judge tmp nginx ai-generated; do if [ -e "data.before-restore/$name" ]; then sudo mv "data.before-restore/$name" data/; fi; done
```

The last line brings back what backups leave out: the judge's directories, temporary files and Nginx's working directories. On another machine, the system users may have other IDs, so give the restored files their owners:

```bash
sudo chown -R mysql:mysql data/mariadb data/mariadb-init
sudo chown -R redis:redis data/redis
sudo chown -R libreoj:libreoj data/minio data/ai data/ai-sample-inputs data/backend-archives
sudo chgrp libreoj config/backend.yaml
sudo chgrp mysql config/mariadb.cnf
sudo chgrp redis config/redis.conf
```

Then start the site and check it:

```bash
sudo systemctl start libreoj.target
sudo bash /opt/LLMOJ/deploy/doctor.sh
```

Sign in, upload and download a small file, and judge a submission. Sessions from the time of the backup still work; to sign everyone out, put a new random `security.sessionSecret` (for example from `openssl rand -hex 32`) in `config/backend.yaml` before starting. If the new machine has different CPUs, fit the judge to them with the [resize command](Judge-Configuration.md). Once the site works, delete `config.before-restore` and `data.before-restore` yourself.

Sources: [configure-local.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-local.py), [nginx.conf.example](https://github.com/houyhlouis/LLMOJ/blob/main/config/nginx.conf.example), [configure-judge.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/configure-judge.py), [backup.sh](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/backup.sh), [doctor.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/doctor.py), [verify-backup.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/verify-backup.py).
