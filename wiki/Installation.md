# Installation and ports

English | [简体中文](Installation.zh-CN.md)

## Supported servers

Ubuntu 24.04 / 26.04 amd64, a normal VM or physical server, systemd 254+, and unified cgroup v2 with cpu/memory/pids controllers. At least 3 GiB RAM; 30 GiB free disk for `all`, 10 GiB for `web`. Compilation is more comfortable with 8 GiB RAM. Restricted Docker/LXC containers are unsupported.

First installation needs access to Ubuntu repositories, GitHub, npm, Node and Go, plus Docker images and rootfs download sources in complete mode. The operating system and required kernel features must already be available.

## Download and run

Replace the public repository path:

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/install.sh -o /tmp/llmoj-install.sh
sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ
```

If necessary, install curl with `sudo apt-get update && sudo apt-get install -y curl ca-certificates`. The entry point resolves a commit, downloads that snapshot and records the repository/commit. It does not log in to GitHub or publish source. For private repositories, authenticate and download the source yourself, then run `sudo bash deploy/install.sh`.

Interactive installation asks for role, listener, HTTP port, directory, site name and browser hostname/IP. Complete mode also asks for Docker sources. Port 80 needs no browser suffix. Behind NAT, enter the actual public IP/domain rather than accepting a detected private interface address.

## Options

| Option | Meaning |
| --- | --- |
| `--repository OWNER/REPO` | Public repository; download entry point only |
| `--ref TAG_OR_COMMIT` | Source version; download entry point only; defaults to main |
| `--role all` / `web` | Complete server / web-only node |
| `--port 80` | Website HTTP port |
| `--listen 0.0.0.0` / `127.0.0.1` | Public / local listener |
| `--public-url https://oj.example.com` | Final browser/download origin; does not create TLS certificates |
| `--prefix /opt/LibreOJ` | Instance directory; one instance per server |
| `--site-name LLMOJ` | Display name |
| `--judge-slots 2` | Local execution slots, 1–7 within machine capacity; all mode only |
| `--docker-source https://download.docker.com` | Package source base URL; appends `/linux/ubuntu` |
| `--docker-mirrors https://mirror.example.com` | Comma-separated HTTPS Docker Hub mirrors; empty preserves existing defaults |
| `--yes` / `--interactive` | Non-interactive / force terminal prompts |
| `--plan` / `--check` | Read-only plan / environment checks |

```bash
sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ \
  --yes --port 8080 --public-url http://oj.example.com:8080 --site-name LLMOJ
```

Docker options apply when rootfs must be built. Package source changes do not replace an already installed Docker. Applying changed registry mirrors restarts Docker; other settings are preserved and the previous file is backed up. See [Docker sources](Docker-Sources.md).

The installer does not change firewall/cloud security-group rules. Allow only the chosen website port. Database, Redis, MinIO, backend and metrics remain on loopback. Configure [HTTPS](HTTPS.md) for a public deployment.

## Admin, services and retries

Success prints full-permission `admin` and a random 32-character password. The root-owned credential file is `config/admin-credentials.json`, mode `0600`. Save it privately and change the password after login. Retrying does not reset it.

```bash
sudo systemctl status libreoj.target
sudo systemctl restart libreoj.target
sudo systemctl stop libreoj.target
sudo systemctl disable libreoj.target
sudo journalctl -u libreoj-backend -u libreoj-judge -u libreoj-nginx -n 100 --no-pager
```

After a failed installation, fix the error and rerun with the original directory, role, site name, origin, listener, port, slots and Docker source options. Do not delete private config/state to bypass a mismatch. Completed installations are not automatically upgraded; back up the database and matching AI master key before planning a migration.

Configuration and build steps have checks; a complete installation on a fresh server remains unverified end to end.
