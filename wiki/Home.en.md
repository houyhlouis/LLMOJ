# LLMOJ Wiki

[简体中文](Home.md) | English | [Repository](https://github.com/houyhlouis/LLMOJ)

LLMOJ is an AI-assisted online judge based on LibreOJ. Start with [Configuration overview](Configuration.md) to find a setting, or the installation guide for a new deployment. After changing CPU or RAM capacity, follow [Judge configuration and resizing](Judge-Configuration.md) to update execution slots, CPU affinity, and systemd units together.

| Topic | Page |
| --- | --- |
| Registration policy and delegated review | [Registration approval](Registration-Approval.md) |
| Preserve configuration/data while upgrading; compatibility and rollback | [Upgrade](Upgrade.md) |
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

Registration approval and the upgrader extend baseline `20dec6f86213e886e79859187b9ef599bd33ec25`; new files must be published together with their release. Deployment and functional validation have been performed on Ubuntu 24.04 amd64; each revision’s test report defines its verified scope. The main project uses MIT; upstream components retain their licenses.
