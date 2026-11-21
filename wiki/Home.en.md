# LLMOJ Wiki

[简体中文](Home.md) | English | [Repository](https://github.com/houyhlouis/LLMOJ)

LLMOJ is an online judge based on LibreOJ, with AI tools for problem setting. New here? Start with [Installation](Installation.md). To find a particular setting, see the [Configuration overview](Configuration.md).

## Installing and maintaining

| Page | Contents |
| --- | --- |
| [Installation](Installation.md) | Installation scripts, every option, and retrying a failed installation |
| [Upgrade](Upgrade.md) | Upgrading while keeping configuration and data; compatibility and rollback |
| [Feature upgrades](Community-Upgrade.md) | The database changes of LLMOJ's features, and applying them to a custom installation |
| [HTTPS](HTTPS.md) | Domains, TLS certificates and external reverse proxies |
| [Docker sources](Docker-Sources.md) | Docker package sources and registry mirrors |
| [Operations](Operations-Configuration.md) | Nginx, MariaDB, Redis, MinIO and systemd after installation; health checks, backups and counts |
| [Runbook](Runbook.md) | What to do when doctor warns, a metric crosses its line, or users report a problem; the diagnostic bundle |
| [Capacity](Capacity.md) | How a small site performed under a measured load, before and after this release |
| [ARM64 servers](ARM64.md) | Installing on arm64 (AArch64), what differs for C and C++, and judge machines of both architectures |

## Using LLMOJ

| Page | Contents |
| --- | --- |
| [Contest rules](Contest-Rules.md) | Scoring and feedback in NOI / OI, IOI, ICPC and Strict IOI contests; code drafts on contest problem pages; virtual participation |
| [Problem authoring](Problem-Authoring.md) | The statement, test data, the judge settings of the four problem types, testing, sharing and publishing |
| [Study lists and discussions](Study-Lists-and-Discussions.md) | Personal study lists; who may post in discussions, public and hidden posts |
| [Permissions](Permissions.md) | Who may do what: site permissions, privileges, groups and teams, and which rule wins |
| [Teams](Teams.md) | Private teams: joining by ID, reviews, groups and shared resources |
| [Solutions](Solutions.md) | Solutions on problem pages, My discussions and AI solutions |
| [Submissions](Submissions.md) | Submission previews, test data versions and earlier results |
| [Hacks](Hacks.md) | Hacking submissions, the problem STD and hack results |
| [Self Eval](Self-Evaluation.md) | Hidden pretests in NOI / OI contests and their quota |
| [Statement downloads](Statement-Downloads.md) | A statement as Markdown; a contest's problems as a ZIP (PDF, samples and attachments) |
| [Fake moderation](Submission-Moderation.md) | Voiding cheating submissions while keeping the evidence |
| [Registration approval](Registration-Approval.md) | Registration settings and delegated reviews |
| [Two-factor sign-in](Two-Factor-Sign-In.md) | Authenticator apps, passkeys, recovery codes and confirming sensitive changes |
| [Keyboard and screen readers](Accessibility.md) | Using the site without a mouse, live updates, zooming on phones |

The member list (`/u`) opens from **View all** in the **Top Users** panel on the home page, for users with the `ViewUsers` privilege.

## Judging

| Page | Contents |
| --- | --- |
| [Distributed judging](Distributed-Judging.md) | Architecture, the judge queue, draining and revoking judge machines |
| [Remote judges](Remote-Judge.md) | Setting up a separate judge machine and checking it |
| [Judge configuration](Judge-Configuration.md) | Judge settings, the sandbox and its self-test, capacity and resizing |

## AI

| Page | Contents |
| --- | --- |
| [AI](AI.md) | Each user's models and search services, permissions, AI jobs, and the site's AI pause and limits |
| [AI environment](AI-Environment.md) | AI directories, the local sandbox connection, keys and environment variables |

## Reference

| Page | Contents |
| --- | --- |
| [Configuration overview](Configuration.md) | Where each setting lives |
| [Backend configuration](Backend-Configuration.md) | Backend settings: accounts, security, database, mail, storage, contests and display |
| [Frontend configuration](Frontend-Configuration.md) | Building the frontend locally; optional CDN settings |
| [Environment](Environment.md) | Environment variables for running, installing and building; maintenance scripts |
| [Publishing](Publishing.md) | Applying updates with GitHub Desktop, publishing this wiki, and releases |
| [Dependencies](Dependencies.md) | Supported Node.js, pnpm, library and browser versions, what's held back, the self-contained frontend build, the inventory and the advisory check |
| [Development](Development.md) | Running the backend and frontend from a checkout with a disposable database, Redis and MinIO; sample data and tests |
| [Using the API](API.md) | Signing in, errors and request IDs, pages of results, proof of work, uploads and live judging updates |

A full installation (`--role all`) runs the website, storage and a local judge, and can use remote judge machines too. A website-only installation (`--role web`) builds no local judging environment: remote judges handle submissions, and those of judge protocol 9 that announce quality policy 2 and receipt version 1 also run the programs of AI validation and test data generation (see [Distributed judging](Distributed-Judging.md)).

LLMOJ runs on Ubuntu 24.04 and 26.04, on amd64 and arm64; what has been tested, where and when, is listed in [Tested platforms](Installation.md#tested-platforms). Its own code is under the MIT license; upstream components keep their licenses.
