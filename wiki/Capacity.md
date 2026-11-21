# Capacity

[简体中文](Capacity.zh-CN.md) | English | [Wiki home](Home.en.md) | [Operations](Operations-Configuration.md)

This page records how a small site performed under a measured load, to help you size a server. Your numbers depend on your hardware, data and visitors; to watch your own site, see [Metrics](Operations-Configuration.md#metrics).

## What was measured

| | |
| --- | --- |
| Server | Intel Core i7-11370H (4 cores, 8 threads), 3.3 GiB of memory, SSD, Ubuntu 26.04. MariaDB 11.8, Redis and MinIO on the same server; one backend process (`server.clusters: null`, as installed); a judge with 2 slots on one CPU. |
| Data (synthetic) | 2,000 users; 1,500 problems (1,400 public) with statements in two languages and two tags each; 300,000 practice submissions over a year; 30 contests of 6 problems (about 1,000 submissions each when ended, 2,551 in the running one); 3,000 discussions with 5 replies each; 300 study lists of 50 problems and one of 1,000. About 300 MB of data. |
| Visitors | Page views arrive at a fixed rate. Each one sends the API requests that page sends in a browser (recorded with Chromium), with varying problems, submissions, users and discussions. 75% are signed in. The mix: running contest 20%, its standings 10%, a problem 20%, the submission list 12%, a submission 8%, the problem set 8%, the home page 6%, and other contests, discussions, users and study lists. |
| Judging | A C++ submission every 2 seconds throughout, judged for real |
| Rates | 20 page views a second for 2 minutes, which is about a 300-student contest where everyone reloads every 15 seconds; then 40 for 90 seconds and 80 for 60 seconds |
| Revisions | The release measured was `5a1d5cf` (2026-10-18); "before this release" below is its parent, `3f1c52d`. |
| Workload | The scripts used for this measurement weren't kept. The [benchmark kit](https://github.com/houyhlouis/LLMOJ/tree/main/deploy/benchmark) now builds the same data and page mix again; see [Repeating the measurement](#repeating-the-measurement). |

Requests went straight to the backend, so Nginx and TLS aren't included. Rate limiting was off, because all simulated visitors shared one address.

## Results

| Page views a second | Requests a second | Page view p50 / p95 | Request p95 | Wait for a judge p95 | Backend CPU average / peak | MariaDB CPU |
| --- | --- | --- | --- | --- | --- | --- |
| 20 | 29 | 12 / 35 ms | 20 ms | 16 ms | 28% / 63% | 11% |
| 40 | 59 | 11 / 30 ms | 16 ms | 14 ms | 40% / 57% | 19% |
| 80 | 116 | 12 / 37 ms | 22 ms | 19 ms | 71% / 95% | 34% |

No request failed. The backend used about 450 MB of memory, and MariaDB about 200 MB. 100% CPU is one core.

The slowest page is a study list of 1,000 problems (about 100 ms). The proposed goal of a p95 below 300 ms for page reads holds with a wide margin at all three rates. Near 120 requests a second, the backend process uses most of one core, so that's where this server's single process would reach its limit. Running several backend processes (`server.clusters`) wasn't part of this measurement.

### Before this release

The same load against the previous release: at 20 page views a second, pages took 6.2 s at the median and 15.5 s at p95, and submissions waited up to 90 seconds for a judge. The backend process was saturated (152% CPU, counting garbage collection), and at 40 a second it fell minutes behind. Contest pages computed the standings from all of the contest's submissions on every view, the problem set read each problem's tags separately, and a study list read each problem separately (2,118 queries for 1,000 problems). These are now:

| Page | Queries before → now | Time before → now (one at a time) |
| --- | --- | --- |
| Running contest, standings | 13–14 → 12–13, with standings kept until a submission changes | 75–115 ms → 9–20 ms |
| Problem set (50 problems) | 103–109 → 5–11 | 31–49 ms → 11–19 ms |
| Study list of 1,000 problems | 2,118 → 120 | 1,242 ms → 108 ms |
| Discussion | 24–50 → 13–18 | 10–19 ms → 7–12 ms |

An open contest page also requests its detail once when it opens instead of twice, and stops refreshing while its browser tab is hidden.

## Cached results

Some results are kept between requests:

| What | Kept for at most | Computed again |
| --- | --- | --- |
| A problem's judge settings as judges receive them (with the test cases found in its data), in Redis | 5 minutes | when its settings, test data or type change |
| A problem's practice statistics (the score distribution and the fastest, smallest and earliest accepted submissions), in Redis | 60 seconds | when a submission's result changes: judging, rejudging, Fake, Hacked or deletion |
| A contest's scores, in each backend process | 60 seconds | when any submission of the contest changes |

A change moves the cached result's generation on, so a request that started reading the old data before the change can't store it afterwards. If Redis can't be reached when something changes, the backend that made the change discards the cached result as soon as Redis is back, and the time limits above bound how long anything else could show it. Without Redis, results are computed from the database every time. Since November 2026, these Redis entries have new names: an upgrade doesn't need to clear Redis, and the old entries are no longer read (they expire by themselves within 30 days).

## Database indexes

All of the backend's queries during these pages were logged with MariaDB's slow query log at 0 seconds and their plans examined. None was slow: the most rows any query examined was 4,500 (counting visible discussions). The submission list answered in 3 to 19 ms with each of its filters (problem, user, status, language and their combinations) over 330,000 submissions, using the composite indexes it already has. So this release adds no index.

## Strict IOI scoring

Computing a Strict IOI contest's scores reads each submission's judging result, for its subtasks. Versions before November 2026 read each submission's whole stored detail, source code included; it now reads only the result. Measured on 2026-11-20 on the server above with `deploy/benchmark/strict-ioi.mjs` (MariaDB 11.8, a finished Strict IOI contest of 1,000 submissions with 64 KiB of source each; both ways in the same build):

| Read | From MariaDB | Time | Peak memory of the scoring process |
| --- | --- | --- | --- |
| Whole detail rows (earlier) | 66.2 MB | 204 ms | 372 MiB |
| Judging results only (now) | 0.58 MB | 35 ms | 143 MiB |

Both give the same scores: the tool compares a digest of every ranked row. The peak memory includes the backend's own startup, about 140 MiB.

## Repeating the measurement

The kit in `deploy/benchmark` runs this kind of measurement on a disposable stack (see [Local development](Development.md)), never on a real site:

| File | What it does |
| --- | --- |
| `seed.mjs` | Writes the synthetic data described above into a new database, the same for the same `--seed` and `--as-of` date, at any size (`--scale 0.1` for a tenth). `--strict-submissions N` and `--source-bytes N` add a finished Strict IOI contest for `strict-ioi.mjs`. It refuses a database that already has data, and one whose name doesn't start with `llmoj_bench` or `llmoj_dev` unless it's given `--yes-this-is-disposable`. |
| `capacity.json` | The page mix: the API requests each page sends, as the site's pages send them, and its share of page views. |
| `load.mjs` | Opens pages at a fixed rate whatever the answers (`--rate`, `--seconds`, `--signed-in`), and reports the p50, p95 and maximum of every page and API request, the errors, and the rate achieved, in `PREFIX.json` and `PREFIX.txt` (`--out PREFIX`). With `--metrics-url` it adds the SQL queries per request, the backend's memory, and judge queue waits. It checks that it's talking to the seeded stack before sending anything, and needs `--yes-this-is-disposable` for an address that isn't on this machine. |
| `metrics.mjs` | Compares two readings of the backend's metrics, for `load.mjs`. |
| `strict-ioi.mjs` | The Strict IOI comparison above. |

The rates in the first table, at full size:

```bash
BENCH=/var/tmp/llmoj-capacity-$(id -u)
node deploy/dev/stack.mjs start --dir "$BENCH" --base-port 28600
# Every simulated visitor has the same address: set security.rateLimit to null in "$BENCH/backend.yaml" now
node deploy/benchmark/seed.mjs --config "$BENCH/backend.yaml" --seed 42 --as-of 2025-01-01 --scale 1
```

Then start the backend on that stack in another terminal, `(cd apps/backend && . "$BENCH/backend.env" && node dist/main)`, and:

```bash
for run in '20 120' '40 90' '80 60'; do
  read -r rate seconds <<< "$run"
  node deploy/benchmark/load.mjs --manifest "$BENCH/benchmark.json" --seed 42 --signed-in 0.75 \
    --metrics-url http://127.0.0.1:28601/metrics --rate "$rate" --seconds "$seconds" --out "load-$rate"
done
```

Stop the backend and remove the stack afterwards with `node deploy/dev/stack.mjs reset --dir "$BENCH"`.

What the kit doesn't reproduce:

- **Judging.** The measurement above judged a C++ submission every 2 seconds. The kit's problems have judging turned off and its submissions are already judged, so it measures page reads only; for waits for a judge, connect a judge and submit separately.
- **The smaller pages' shares.** How the last 16% of page views divided between other contests, discussions, users and study lists wasn't recorded: the kit gives each 4%. Every share can be changed in `capacity.json`.
- **The browser.** Requests go straight to the backend: no static files, Nginx or TLS, no live updates, polling or filters a visitor opens.
- **CPU and caches.** The kit doesn't record CPU use (watch it with `top` or `pidstat` during a run), and the backend exports no cache hit or miss counts.
- **One machine.** Unless you run `load.mjs` elsewhere, it shares the machine with what it measures.

To publish results, keep the JSON files with the revision (`git rev-parse HEAD`, and `git status --short` for uncommitted changes), the machine (CPU, memory, operating system, MariaDB and Redis versions) and whether the caches were warm. Compare two releases only with runs made the same way on the same machine.

On 2026-11-20 the kit was checked on the server above, with the code of that date, at a tenth of the size (`--scale 0.1`, seed 42), the rate limit off and no judging: 20 page views a second for 60 seconds took 9.4 ms at p50 and 17.5 ms at p95, and 40 a second for 30 seconds 7.8 and 13.7 ms, with no errors and about 11 SQL queries per request. This shows that the kit works; these numbers can't be compared with the full-size results above.
