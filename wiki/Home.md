# LLMOJ Wiki

English | [简体中文](Home.zh-CN.md)

LLMOJ is an AI-assisted online judge based on LibreOJ. Start with [Configuration overview](Configuration.md) to find a setting, or the installation guide for a new deployment. After changing CPU or RAM capacity, follow [Judge configuration and resizing](Judge-Configuration.md) to update execution slots, CPU affinity, and systemd units together.

| Topic | Page |
| --- | --- |
| Installation entry points, every flag, and retries | [Installation](Installation.md) |
| Backend YAML: accounts, security, database, mail, storage, contests, and presentation | [Backend-Configuration](Backend-Configuration.md) |
| Judge YAML, CPU/RAM resizing, service units, verification, and rollback | [Judge-Configuration](Judge-Configuration.md) |
| Per-user AI models, search, permissions, and jobs | [AI](AI.md) |
| AI directories, sandbox communication, key persistence, and environment | [AI-Environment](AI-Environment.md) |
| Runtime, installation, and build environment variables; maintenance tool arguments | [Environment](Environment.md) |
| Local frontend builds and optional CDN/bootstrap settings | [Frontend-Configuration](Frontend-Configuration.md) |
| Nginx, MariaDB, Redis, MinIO, systemd, and post-install changes | [Operations-Configuration](Operations-Configuration.md) |
| Distributed workflow diagrams and node responsibilities | [Distributed-Judging](Distributed-Judging.md) |
| Remote judge setup and connection checks | [Remote-Judge](Remote-Judge.md) |
| Docker package sources and registry mirrors | [Docker-Sources](Docker-Sources.md) |
| Domains, TLS, and external reverse proxies | [HTTPS](HTTPS.md) |
| Updating documentation with GitHub Desktop and publishing the Wiki | [Publishing](Publishing.md) |

The full installation includes the website, storage, and a local judge, with optional remote judges. `--role web` does not build a local rootfs; remote submission judging currently does not replace the local worker required for AI verification and data generation.

The configuration reference was checked against commit `43a88bdd62fbf200889b36932fa921439a293190`. Deployment and functional validation have been performed on Ubuntu 24.04 amd64; see [Installation](Installation.md) for version and test boundaries. The main project uses MIT; upstream components retain their own licenses.
