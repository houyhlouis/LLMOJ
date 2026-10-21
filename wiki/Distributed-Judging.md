# Distributed judging

[简体中文](Distributed-Judging.zh-CN.md) | English | [Wiki home](Home.en.md)

A site can judge on its own server, on separate judge servers, or both.

- **`all` site plus remote judges:** the site keeps its own judge and the local AI worker, and remote judges share ordinary judging. AI programs run on the site's own judge.
- **`web` site plus remote judges:** the site does no judging and doesn't build a sandbox; remote judges do all judging, and also run AI programs (see [AI](#ai)).

```mermaid
flowchart LR
    Browser[Browser] --> Nginx[Nginx]
    Nginx --> Frontend[Frontend]
    Nginx --> Backend[Backend]
    Backend --> DB[MariaDB]
    Backend --> Redis[Redis]
    Backend --> MinIO[MinIO]
    Judges[Local or remote judges] <-->|Authenticated WebSocket /api/socket| Backend
    Judges --> Sandbox[Each judge's own sandbox]
    Judges -->|Signed /storage/ downloads| Nginx
    Backend -->|all role: local socket| AIWorker[Local AI worker]
    Judges -->|web role: AI files, signed uploads| Nginx
```

Judges connect to the site, so they need no open incoming port. They have no database, Redis or MinIO credentials: they receive tasks from the backend, download and cache test data through signed links, and send back results. There is one backend and one database; this isn't a high-availability cluster.

## Setting up the site

For a site that only serves the web:

```bash
sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ \
  --role web --public-url http://oj.example.com
```

Judges send their key when they connect, so set up [HTTPS](HTTPS.md) before connecting judges over the internet, or use a private network you control.

The installer already sets up WebSocket connections on `/api/socket` and points judge downloads (`services.minio.forJudge.urlEndpoint`) at `/storage/` on the public address. The database and MinIO stay reachable only from the site's server.

## Adding a judge

1. As a site administrator, open **Judge Machine** (`/judge-machine`), click **Add**, enter a name such as `judge-01` and confirm.
2. Click the key icon in the new judge's row to show its key, and save it in the judge server's private key file. Don't paste it anywhere else.
3. Set up the judge server as described in [Remote judges](Remote-Judge.md), with the same version and sandbox image recipe as the site.
4. When the judge's log shows "Successfully authorized as …", its row on **Judge Machine** shows **Online**.
5. Submit a simple C++ program and check that it's downloaded, compiled, run and Accepted. Also try a compile error, a time limit, a memory limit and cancelling, on each judge.

Register every judge separately with its own key: when a second connection uses the same key, it replaces the first. The `allowedHosts` field of a judge isn't checked when it connects; to restrict where judges may connect from, use a firewall, VPN or reverse proxy.

## The judge queue

Judge tasks are stored in the database (table `judge_job`), not only in Redis: a submission, hack or Self Eval run is saved together with its task, so restarting the backend or Redis loses no queued work. Redis only wakes up waiting judges, which also check for tasks every few seconds.

- Each task goes to one judge connection at a time, under a lease that the backend renews while the judge stays connected. The result is saved together with finishing the task, and a result from an older lease (for example from before a reconnect) is ignored.
- When a judge disconnects, its unfinished tasks are queued again at once. When the backend itself stops, its leases expire after 90 seconds, and another backend process, or the restarted one, queues them again. So a task may be judged more than once, but its result counts once.
- A task is given up after 5 interruptions, or after 10 failures to prepare it (for example because test data is missing). Its submission then shows **System Error** with the reason, and can be rejudged.
- Site administrators see the queue at the bottom of **Judge Machine**: tasks waiting or being judged, the judge holding each, retries, and the tasks given up in the last 7 days. The `libreoj_judge_jobs` metric reports waiting and running tasks.
- Every lease is recorded in `judge_job_attempt` with how it ended. Finished tasks and their records are deleted after 30 days.

## Which task comes next

When a judge's task thread is free, it gets the waiting task of the first class, and within a class the one queued first:

1. **Live contests:** new submissions to a contest that hasn't ended.
2. **Practice:** other new submissions. A user with many submissions waiting, or who used much judging time in the last 15 minutes, comes after others (`preference.serverSideOnly.dynamicTaskPriority` in `backend.yaml`).
3. **Rejudges**, and preparing Self Eval.
4. **Hacks** and **Self Eval** runs.
5. **AI** program runs. A judge runs at most its AI slots of them at once, and always keeps a thread for other work.

Two settings in **Site management** → **Judging** change this. They apply within a few seconds and are recorded in the audit log:

- **Task threads each judge machine keeps for running contests** (0 by default): while a contest is running, a judge whose other tasks fill all but this many of its threads gives the rest only to contest submissions. A long rejudge or AI run then can't delay a contest. A judge needs more task threads than this to keep any, and the threads idle when no contest submission waits.
- **Minutes before a waiting task is moved ahead** (30 by default): once a task has waited this long, every fifth task a backend process gives out goes to the task waiting longest, whatever its class, unless a contest submission waits. Rejudges, hacks and AI runs then keep moving while new submissions arrive. 0 turns this off.

The `libreoj_judge_queued_jobs_by_class` [metric](Operations-Configuration.md#metrics) shows the waiting tasks by class, and [doctor](Operations-Configuration.md#doctor) warns when contest submissions wait.

## Draining, keys and capabilities

These actions are on the **Judge Machine** page for site administrators. Every change is recorded in the audit log (`judge_client.add`, `delete`, `reset_key`, `drain`, `resume`).

- **Drain** (pause icon) stops sending new tasks to a judge; it finishes those it has. Its status shows **Draining** while it's still judging, then **Drained**: you can now stop, upgrade or resize it without interrupting judging, while the other judges take the queue. It stays drained after reconnecting, or after the backend restarts, until you **Resume** it (play icon). Draining doesn't affect the local AI worker, which doesn't use the queue; AI program runs on judges are queued and drain like other tasks.
- **Reset key** and **Delete** take effect at once: the judge is disconnected from every backend process, and its unfinished tasks are queued again for other judges. Reset a key that may have leaked, then put the new key on the judge server.
- **Capacity:** when a judge connects, it reports its protocol version, the task types it can run, its task threads, judge slots, slots for AI checks and memory budget, shown in the **Capacity** column. The backend sends it only the task types it reported. An older judge reports nothing and is marked **Legacy**: it receives only submissions, so hacks and Self Eval runs wait until an updated judge is online.
- **Runtime:** a judge of protocol version 3 also reports its judge program (a digest of its source files), its sandbox image and its Node.js version, shown with its capacity. Each result records them, with the judge machine ([What judged a result](Submissions.md#what-judged-a-result)). When online judges report different judge programs or sandbox images, the page warns that a submission may get a different result depending on which one judges it: update them to the same version. Judges of protocol version 3 also check test data against its [content hashes](Submissions.md#content-hashes); older ones still judge, without either.

To change a judge's number of slots, see [Judge configuration](Judge-Configuration.md#changing-the-number-of-slots). Work on one judge at a time, and check it before moving on to the next.

## AI

AI features that only call a model, such as editing, translation and search, work in every layout. Checking AI reference solutions and generating test data also compile and run programs: generators, reference solutions, validators and checkers.

- **`all` site:** the site's own judge runs them through its local AI worker, through a local socket and private directories. Remote judges don't take over this work.
- **`web` site** (no local AI worker): each run is a task in the judge queue, shown as **AI program run**, which any online judge of protocol version 4 takes. The judge downloads the hidden samples through signed links and checks them against their [content hashes](Submissions.md#content-hashes), runs the programs in its sandbox within its AI slots, and uploads what they generate through signed forms. The backend downloads each file and checks its size and SHA-256 before publishing it, as with the local worker. The AI job's result is the same either way.

AI runs wait behind all other judging. A judge with several task threads keeps at least one for other work, and runs at most as many AI runs at once as its AI slots; a judge with a single task thread runs none. If no judge takes a run within 15 minutes, the AI job fails with `SANDBOX_UNAVAILABLE`. To choose where AI programs run, set `LLMOJ_AI_EXECUTION` for the backend (see [AI environment](AI-Environment.md)).

Model and search keys stay on the site: a judge only gets the programs and data to run, as when judging. A judge running AI programs sees the reference solution and hidden samples, just as it sees test data and checkers when judging. Don't replace the local socket with an open TCP port or a shared directory.

## Troubleshooting

- **A judge can't connect:** check the site's address, HTTPS, WebSocket forwarding of `/api/socket`, and the judge's key.
- **A judge is online but downloads fail:** check whether the download links point to `127.0.0.1`, port 19000 or an address the judge can't reach, and check how `/storage/` is forwarded.
- **Judges keep disconnecting each other:** two of them share a key.
- **cgroup errors:** check systemd delegation, cgroup v2 and the kernel.
- **AI checks fail with `SANDBOX_UNAVAILABLE` on a `web` site:** no judge took the run within 15 minutes. Update a judge to the current version (protocol version 4, which lists **AI program run** under **Capacity**), resume it if it's drained, and give it at least two task threads.
- **Hacks or Self Eval runs keep waiting:** check that an online judge that isn't drained runs the current version (not **Legacy**) and lists them under **Capacity**.
- **A judge gets no tasks:** check whether it's drained, and resume it.
- **A submission fails with "doesn't match its recorded content":** the stored file changed after it was accepted (in object storage, or by a second upload with the same upload form). Upload the file again and rejudge. If it happens for many files, check the object storage's disk.
