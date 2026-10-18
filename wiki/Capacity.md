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

## Database indexes

All of the backend's queries during these pages were logged with MariaDB's slow query log at 0 seconds and their plans examined. None was slow: the most rows any query examined was 4,500 (counting visible discussions). The submission list answered in 3 to 19 ms with each of its filters (problem, user, status, language and their combinations) over 330,000 submissions, using the composite indexes it already has. So this release adds no index.
