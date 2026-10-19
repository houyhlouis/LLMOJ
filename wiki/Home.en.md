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
| [Capacity](Capacity.md) | How a small site performed under a measured load, before and after this release |

## Using LLMOJ

| Page | Contents |
| --- | --- |
| [Contest rules](Contest-Rules.md) | Scoring and feedback in NOI / OI, IOI, ICPC and Strict IOI contests |
| [Teams](Teams.md) | Private teams: joining by ID, reviews, groups and shared resources |
| [Solutions](Solutions.md) | Solutions on problem pages, My discussions and AI solutions |
| [Submissions](Submissions.md) | Submission previews, test data versions and earlier results |
| [Hacks](Hacks.md) | Hacking submissions, the problem STD and hack results |
| [Self Eval](Self-Evaluation.md) | Hidden pretests in NOI / OI contests and their quota |
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

A full installation (`--role all`) runs the website, storage and a local judge, and can use remote judge machines too. A website-only installation (`--role web`) builds no local judging environment: remote judges handle submissions, and up-to-date ones (protocol version 4) also run AI validation and test data generation (see [Distributed judging](Distributed-Judging.md)).

LLMOJ is tested on Ubuntu 24.04 amd64. Its own code is under the MIT license; upstream components keep their licenses.
