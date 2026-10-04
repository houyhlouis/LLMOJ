# Install LLMOJ

[English tutorial](../wiki/Installation.md) | [中文教程](../wiki/Installation.zh-CN.md)

From local source, run `sudo bash deploy/install.sh` (English) or `sudo bash deploy/install.zh-CN.sh` (Chinese). For standalone GitHub downloads, follow the matching [English README](../README.en.md) or [中文 README](../README.md).

Defaults: public `0.0.0.0:80`, full deployment, site name LLMOJ. Options include ports, hostname, role, directory, slots and [Docker sources](../wiki/Docker-Sources.md). Internal services stay local. TLS/firewalls are configured separately. Success prints full-permission admin and a random password; retries preserve data and credentials.

See [distributed judging](../wiki/Distributed-Judging.md), [independent judges](../wiki/Remote-Judge.md) and [AI execution limits](../wiki/AI.md). Services retain `libreoj-*` names and /opt/LibreOJ paths; internal HYHOJ_* variables remain for code compatibility. Configuration tools do not start services.

Deployment and core functionality have been verified on Ubuntu 24.04 amd64. See the installation tutorial for the validation scope.
