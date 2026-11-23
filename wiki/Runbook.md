# Runbook

[简体中文](Runbook.zh-CN.md) | English | [Wiki home](Home.en.md)

What to do when [doctor](Operations-Configuration.md#doctor) warns or fails, a [metric](Operations-Configuration.md#metrics) crosses its line, or users report a problem. Start with:

```bash
sudo bash /opt/LLMOJ/deploy/doctor.sh
```

Doctor only reads. Each section below names doctor's message, what it means, and what to do. The backend's log (`sudo journalctl -u libreoj-backend --since "1 hour ago"`) has the details of most problems; an error ID a user reports finds its lines (`grep 'ID'`). To ask someone else for help, send them a [diagnostic bundle](#collecting-a-diagnostic-bundle).

## The site is down or not ready

**"The backend doesn't answer"** or **"The backend isn't ready"**
- `sudo systemctl status libreoj-backend` shows whether it runs. If it restarts again and again, read its log.
- **The log says "The database lacks what this release needs"**: the database is older than the code, for example after restoring a backup of an older version. Run the upgrader, or restore a backup that matches the installed version. See [The database at startup](Upgrade.md#the-database-at-startup).
- **The log says the configuration is invalid**: a recent edit to `config/backend.yaml` broke it. Undo it and restart the backend.

**"The backend can't reach the database / Redis / object storage"**: that service is down. See its section below, then check again; the backend reconnects by itself.

**"Nginx doesn't pass requests to the backend"**: `sudo systemctl status libreoj-nginx`. After editing `config/nginx.conf`, test it as [Nginx](Operations-Configuration.md#nginx-confignginxconf) describes before reloading.

**"The certificate … expires in N days"** or **"expired"**: renew it ([HTTPS](HTTPS.md)). Browsers refuse an expired certificate.

**Stopping or restarting the backend** (`systemctl stop`, `systemctl restart`, or an upgrade): the backend shuts down in an orderly way and quickly. It closes open HTTP and judge connections and ends its active lock leases. With several cluster workers (`server.clusters`), each worker gets up to 5 seconds to finish before it is stopped forcefully, and anything still left is forced to exit after 10 seconds. Judges reconnect to the backend by themselves once it is back, and work they hadn't finished is queued again.

## Redis

**"Redis doesn't answer"**: `sudo systemctl status libreoj-redis`. Users are signed out and live updates stop until it's back; queued judging is kept in the database.

**"Redis couldn't write its data to disk"**: the disk is usually full. Free space (see [The server](#the-server)); Redis retries by itself.

**"Redis evicts keys when full"**: set `maxmemory-policy noeviction` in `config/redis.conf`, as installed ([Redis](Operations-Configuration.md#redis-configredisconf)), and restart Redis. Eviction can drop sessions and queued work.

**"Redis has N connections"**: something keeps opening connections. `sudo systemctl restart libreoj-backend` releases them; report it, with the version, because it's a bug.

**`LOCK_LEASE_LOST` in responses or the backend log**: an operation lost the Redis lock that protected it (Redis became unreachable, slow, restarted or evicted the lock, or the backend process paused past the lock's 5-second lease). Each response carries a request ID; search the backend log for that ID to see the cause. Check Redis reachability and latency, whether Redis is evicting keys, the server's memory pressure or swapping, and whether the backend is paused or overloaded. While Redis is unreachable, operations that need a lock fail at once instead of waiting: lock commands time out after 2.5 seconds and aren't queued for a reconnect.

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

**An AI job failed at `testdata.candidate-preflight` with `INVALID_SANDBOX_RESPONSE: The runner didn't report how it made its result`** (on the job page, `INVALID_SANDBOX_RESPONSE` shows **"The sandbox response or test-data validation is incomplete."**): a runner built before the qualification-record fix returns results without the complete record of how they were made, and the backend rightly rejects them. That runner still announces the same execution protocol, quality-policy and receipt versions (`9` / `2` / `1`), so it stays eligible: versions don't distinguish an old runner from a fixed one, and an artifact digest is not a commit.
1. Identify the backend and every runner eligible for AI jobs, local and remote: check **Deployment identity** on the AI configuration page (the backend's digest and source — `source <commit>` or `source tree <treeSha256>` **(verified)**, **differs from its release manifest**, or **source unknown** — and each judge's **Build** and whether it is **(this server's release)** or **source unknown**) and the **Release** row under **Capacity** on **Judge Machine** (**This server's release** or **Not this server's verified release; its source isn't known**). Record each one's digest and source; don't infer what is running from a checkout.
2. Update and restart every runner that isn't shown as **(this server's release)** / **This server's release** (for remote judges, see [Updating a remote judge](Remote-Judge.md#updating-a-remote-judge)), or take it out of service until it is. Keep strict validation on; there is nothing to relax.
3. Retry the job with its ordinary **Retry** (**Retry failed step** on the job page or **My AI jobs**; an empty list of alternative retry modes doesn't disable it). It keeps the job's source and program artifacts, clears generated test data and quality results, and qualifies the existing candidate again. A changed runner may recompile programs, and later steps may call the provider again.
4. Watch the new attempt: it should pass `testdata.candidate-preflight` on an identified, updated runner.
5. Record two outcomes separately: whether `testdata.candidate-preflight` passed (which confirms the defect is fixed in the deployment) and the job's final outcome. Only a completed job means the job recovered; a later, different failure is a new problem to investigate on its own, not the old defect returning. Use **Export diagnostics** on the job page to keep the evidence.

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

## Collecting a diagnostic bundle

To send whoever supports your site what it needs to look into a problem, download a **diagnostic bundle**: **Site management** → **Diagnostic bundle** (site administrators only). It's one JSON file (format version 2, `bundleVersion: 2`) with:

- the site's version, backend artifact digest (`backendBuild`), verified build provenance (`backendProvenance` and full commit in `revision`, or `null` when no commit is verified), Node.js version, platform, uptime and a summary of its non-secret settings;
- the health checks of the database, Redis and storage;
- the judge machines (state, protocol, architecture, capacity, announced judge program digest and provenance) and the judge queue;
- recent unexpected errors of the backend process that answered: their request IDs, times, routes and error classes;
- the AI pause, limits and the status of recent failed AI jobs;
- if you name them, the metadata of particular submissions and AI jobs.

Next to each artifact digest, diagnostics (the bundle, **Judge Machine**, and the AI page's **Deployment identity** and **Export diagnostics** download, export version 2 / `exportVersion: 2`) show the source it was built from only when that was verified at build time from `deploy/release-manifest.json` (see [Upgrading](Upgrade.md#release-manifest)). A digest is never presented as a commit:

- `verified`: the source commit, or the source tree's SHA-256 when upgraded from a trusted local source tree;
- `mismatch`: the files on disk differ from what was recorded when the release was built;
- `unknown`: no manifest or an invalid one, or a modified or unattributed build.

The backend keeps the last 20 verified backend builds in the database (`deployment.buildHistory`), so an older AI job's diagnostic export can name the source of the backend that ran an earlier timeline step; older digest-only entries and entries that have aged out stay `unknown`, while a recorded mismatch stays `mismatch`. For judge machines, provenance shows **This server's release** (`server_release`) only when the judge's announced judge program digest equals this server's verified release, otherwise `unknown`.

It never contains code, test data, inputs or outputs, compiler or checker messages, prompts, passwords, keys or other secrets, even for the submissions and jobs you name. Each download is recorded in the audit log. A user's report with a request ID (see [Using the API](API.md#answers-and-errors)) and the bundle's recent errors can be matched by that ID.
