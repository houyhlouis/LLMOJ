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

| Option | Default and constraints |
| --- | --- |
| `--repository OWNER/REPO` | Required by download entry; public repository |
| `--ref BRANCH_OR_TAG_OR_COMMIT` | Default `main`; branch, tag, or commit; download entry only |
| `--prefix PATH` | Default `/opt/LibreOJ`; dedicated absolute path without spaces/special characters; one instance per host |
| `--role all\|web` | Default `all`; full site or web-only; web has no local AI worker |
| `--port NUMBER` | Default `80`; 1–65535, excluding internal ports 2002, 2020, 13306, 16379, 19000, 19001 |
| `--listen ADDRESS` | Default `0.0.0.0`; only that address or `127.0.0.1` is accepted |
| `--public-url ORIGIN` | Guessed from interface IP and port; HTTP(S) origin without path, query, fragment, or credentials; does not configure TLS |
| `--site-name TEXT` | Default `LLMOJ`; 1–60 printable characters, not all whitespace |
| `--judge-slots NUMBER` | Omit for automatic selection (internal value 0; explicit 0 is also accepted); explicit slots 1–7 within CPU/RAM capacity; all only |
| `--docker-source URL` | Default `https://download.docker.com`; HTTPS package-source base, with `/linux/ubuntu` appended |
| `--docker-mirrors URL[,URL]` | Default empty, retaining existing settings; comma-separated HTTPS mirrors; see Docker source validation rules |
| `--yes` / `--non-interactive` | Aliases; use supplied/default values without prompts |
| `--interactive` | Force interaction; requires a terminal; default prompts only for installation with a terminal |
| `--check` | Check environment; download entry still fetches temporary source; no installation/service start |
| `--plan` | Show plan; download entry still fetches temporary source; no installation/service start |
| `--help` / `-h` | Show help for the current entry point without installing |

The local `deploy/install.sh` does not accept `--repository` or `--ref`; these belong to the outer download entry.

```bash
sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ \
  --yes --port 8080 --public-url http://oj.example.com:8080 --site-name LLMOJ
```

Docker options apply when rootfs must be built. Package source changes do not replace an already installed Docker. Applying changed registry mirrors restarts Docker; other settings are preserved and the previous file is backed up. See [Docker sources](Docker-Sources.md).

For Redis background saves, the installer applies `vm.overcommit_memory=1` and persists it in `/etc/sysctl.d/99-libreoj-redis.conf`; an existing custom file of that name is not overwritten. The single-node MinIO warning about host failure describes the absence of multi-node redundancy; keep independent backups.

The installer does not change firewall/cloud security-group rules. Allow only the chosen website port. Database, Redis, MinIO, backend and metrics remain on loopback. Configure [HTTPS](HTTPS.md) for a public deployment.

## Admin, services and retries

At the end of a successful installation, the controlling terminal shows the full-permission `admin` username, its random 32-character password and the absolute credential-file path. This remains visible when build output is redirected; without a controlling terminal, it falls back to standard output. The server also retains `config/admin-credentials.json`, owned by root with mode `0600`. Retries verify the recorded password before displaying it. A changed password or missing record is never replaced or presented as a valid old password. Keep terminal output private.

```bash
sudo systemctl status libreoj.target
sudo systemctl restart libreoj.target
sudo systemctl stop libreoj.target
sudo systemctl disable libreoj.target
sudo journalctl -u libreoj-backend -u libreoj-judge -u libreoj-nginx -n 100 --no-pager
```

After a failed installation, fix the error and rerun with the original directory, role, site name, origin, listener, port, slots and Docker source options. Do not delete private config/state to bypass a mismatch. Completed installations are not automatically upgraded; back up the database and matching AI master key before planning a migration.

## Post-install configuration

Adding CPU cores or RAM does not automatically increase judge capacity. Use [Judge configuration and resizing](Judge-Configuration.md); changing installation metadata or rerunning `--judge-slots` is not a supported resize procedure. See [Configuration overview](Configuration.md) for the full inventory and [Operations](Operations-Configuration.md) for services, ports, mail, and storage.

## Validation scope

Deployment and browser-based functional validation have been performed on Ubuntu 24.04 amd64, including accounts/permissions, problem management, four problem types, all 12 configured submission languages, judging/rejudging, contests, discussions, and problem sets. Subsequent AI business and multi-user permission tests used real DeepSeek/Tavily configurations; this does not establish equivalent behavior for other providers. Reported issues received fixes and targeted regression checks. A fresh installation of the fixed revision, Ubuntu 26.04, and real multi-machine deployment still require separate acceptance testing. This Wiki audit is not a new deployment or a complete business test run.
