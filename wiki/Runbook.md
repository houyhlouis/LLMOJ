# Runbook

[简体中文](Runbook.zh-CN.md) | English | [Wiki home](Home.en.md)

What to do when [doctor](Operations-Configuration.md#doctor) warns or fails, a [metric](Operations-Configuration.md#metrics) crosses its line, or users report a problem. Start with:

```bash
sudo bash /opt/LLMOJ/deploy/doctor.sh
```

Doctor only reads. Each section below names doctor's message, what it means, and what to do. The backend's log (`sudo journalctl -u libreoj-backend --since "1 hour ago"`) has the details of most problems; an error ID a user reports finds its lines (`grep 'ID'`).

## The site is down or not ready

**"The backend doesn't answer"** or **"The backend isn't ready"**
- `sudo systemctl status libreoj-backend` shows whether it runs. If it restarts again and again, read its log.
- **The log says "The database lacks what this release needs"**: the database is older than the code, for example after restoring a backup of an older version. Run the upgrader, or restore a backup that matches the installed version. See [The database at startup](Upgrade.md#the-database-at-startup).
- **The log says the configuration is invalid**: a recent edit to `config/backend.yaml` broke it. Undo it and restart the backend.

**"The backend can't reach the database / Redis / object storage"**: that service is down. See its section below, then check again; the backend reconnects by itself.

**"Nginx doesn't pass requests to the backend"**: `sudo systemctl status libreoj-nginx`. After editing `config/nginx.conf`, test it as [Nginx](Operations-Configuration.md#nginx-confignginxconf) describes before reloading.

**"The certificate … expires in N days"** or **"expired"**: renew it ([HTTPS](HTTPS.md)). Browsers refuse an expired certificate.

## Redis

**"Redis doesn't answer"**: `sudo systemctl status libreoj-redis`. Users are signed out and live updates stop until it's back; queued judging is kept in the database.

**"Redis couldn't write its data to disk"**: the disk is usually full. Free space (see [The server](#the-server)); Redis retries by itself.

**"Redis evicts keys when full"**: set `maxmemory-policy noeviction` in `config/redis.conf`, as installed ([Redis](Operations-Configuration.md#redis-configredisconf)), and restart Redis. Eviction can drop sessions and queued work.

**"Redis has N connections"**: something keeps opening connections. `sudo systemctl restart libreoj-backend` releases them; report it, with the version, because it's a bug.

## Database and object storage

**"MariaDB doesn't answer"**: `sudo systemctl status libreoj-mariadb` and `sudo journalctl -u libreoj-mariadb`. A full disk is the usual cause.

**"MariaDB has N of M connections in use"**: a burst of requests, or queries that don't finish. If it persists, restart the backend, then look for slow queries in its log (`LIBREOJ_SLOW_QUERY_MS`).

**"MinIO doesn't answer"**: `sudo systemctl status libreoj-minio`. Uploads, downloads and judging, which downloads test data, stop until it's back.

**"The database differs from this release's definitions in N ways"**: the backend works with it, but a column is defined differently or an index is missing, so some pages may be slower or a constraint looser. The backend's log names the first ones when it starts. If an upgrade left them, report it with that log.

## Judging

**"All connected judge machines are draining"**: no new submission is judged. On **Judge Machine**, click the play icon (**Resume**) for each machine you're done with.

**"N submissions wait; the oldest for …"**
- **No judge machine is connected** (the `libreoj_judge_clients` metric, or **Judge Machine**): start the judge (`sudo systemctl start libreoj-judge`) or check the remote judges' logs.
- **They're connected but busy**: a rejudge or an AI run may be taking the threads. [Which task comes next](Distributed-Judging.md#which-task-comes-next) explains the order. Add judge slots ([Judge configuration](Judge-Configuration.md#changing-the-number-of-slots)) or a judge machine.

**"N submissions to running contests wait"**: contest submissions come first, so every thread is busy with long tasks. In **Site management** → **Judging**, keep a task thread or two per judge machine for running contests.

**"N judging tasks lost their judge machine"**: a backend process stopped while its judges were working. Their tasks are queued again within about 15 seconds; if the number stays, the backend may be stopping repeatedly: read its log.

**"N judging tasks failed in the last day"**: see **Judge queue** on **Judge Machine** for each task's reason. A task fails after 5 interruptions (for example a submission that crashes the judge) or 10 failures to prepare it (for example missing test data). Its submission shows **System Error**. Fix the cause, then rejudge it.

**"The sandbox image doesn't match"**, **"The judge can't limit …"** or **"judge workspaces aren't mounted"**: the judge's setup changed since it was installed. [Changing the number of slots](Judge-Configuration.md#changing-the-number-of-slots), even to the current number, sets up its workspaces and service again; then run `sudo bash /opt/LLMOJ/deploy/sandbox/self-test.sh`.

## Counts

**"Problem and user counts are … behind"**: count changes are applied within a minute. If they stay behind, read the backend's log, then check and repair them with `deploy/rebuild-statistics.sh` ([Submission and accepted counts](Operations-Configuration.md#submission-and-accepted-counts)).

## AI

**"N AI jobs wait"**
- **AI is paused** in **Site management**: resume it when you're ready.
- **The limits are full**: `libreoj_ai_provider_requests{state="waiting"}` grows. Raise **AI requests at the same time** in **Site management**, or wait.
- **The provider fails**: users see the reason on their jobs, and **Usage** on the AI configuration page counts failed requests.

**"The AI runner socket is missing"**: the judge on this server runs AI programs. Start it (`sudo systemctl start libreoj-judge`).

**"The AI job scheduler had N errors"**: read the backend's log; each error type is logged once a minute.

**"N AI requests in the last day had no usage reported"**: the provider doesn't report token usage, so each such request counts against the budgets at its maximum, and accounts reach their limits sooner. Choose a provider or API format that reports usage, or raise the limits.

**Users get "A private or local API address can be used only once a site administrator approves it"** or **"…allows only API addresses a site administrator approved"**: check the address in **Site management** → **AI addresses** → **Addresses in use**, and approve it if it's meant to be used ([Which addresses accounts may use](AI.md#which-addresses-accounts-may-use)).

## The server

**Disk space or file entries (inodes) running out**: old upgrade backups in `backups/upgrade` are the usual cause (doctor says how much they take); delete those you no longer need. Then old backups in `backups/` (`backup.sh --keep` deletes them for you), then logs (`sudo journalctl --vacuum-time=30d`).

**Little memory available**: the judge's memory budget ([Judge configuration](Judge-Configuration.md)) and the number of slots decide most of it. Reduce the slots, or add memory.

**"The clock isn't synchronized"**: `sudo timedatectl set-ntp true`. Authenticator codes and session times depend on it.

## Backups

**"No backup was made"** or the latest one is old: run `sudo bash /opt/LLMOJ/deploy/backup.sh`, and schedule it ([Backups](Operations-Configuration.md#backups) has a nightly timer).

**`verify-backup.sh` fails**
- **"doesn't match its .sha256 checksum"**: the copy is damaged or incomplete. Copy it again, or use another backup.
- **"can't be decrypted"**: import the private key the backup was encrypted for on the machine that verifies.
- **"files are missing from storage"** or **"differ from their recorded content hash"**: the site's storage was already damaged when the backup was made, or the copy was. Check the site's own storage with a new backup; restore the missing files from an older backup that has them.
- **"data/ai/master.key doesn't decrypt"**: the key file doesn't belong to this database. Saved AI settings in a restored site would be unreadable. Find the matching key; users would otherwise have to enter their keys again.

## Upgrades

**"The upgrade … stopped halfway"**: see [If the upgrade fails](Upgrade.md#if-the-upgrade-fails): fix the cause and run the upgrader again with the same options, or [roll back](Upgrade.md#rolling-back).
