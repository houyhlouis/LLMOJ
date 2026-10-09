# Installation and ports

English | [简体中文](Installation.zh-CN.md)

## Target environments and acceptance scope

Preflight targets Ubuntu 24.04 / 26.04 amd64. Full deployment records are from 24.04; a fresh 26.04 installation has not passed acceptance yet. Use a normal VM or physical server, systemd 254+, and unified cgroup v2 with cpu/memory/pids controllers. At least 3 GiB RAM; 30 GiB free disk for `all`, 10 GiB for `web`. Compilation is more comfortable with 8 GiB RAM. Restricted Docker/LXC containers are unsupported.

First installation needs access to Ubuntu repositories, GitHub, npm, Node and Go, plus Docker images and rootfs download sources in complete mode. The operating system and required kernel features must already be available.

## Download and run

Replace the public repository path:

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/install.sh -o /tmp/llmoj-install.sh
sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ
```

If necessary, install curl with `sudo apt-get update && sudo apt-get install -y curl ca-certificates`. The entry point resolves a commit, downloads that snapshot and records the repository/commit. It does not log in to GitHub or publish source. For private repositories, authenticate and download the source yourself, then run `sudo bash deploy/install.sh`.

Interactive installation asks for role, listener, HTTP port, directory, site name and browser hostname/IP. Complete mode also asks for Docker sources and, when creating judge.yaml for the first time without --judge-slots, execution slots (effective CPUs minus two, minimum one). Port 80 needs no browser suffix. Behind NAT, enter the actual public IP/domain rather than accepting a detected private interface address.

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
| `--judge-slots NUMBER` | Omitted/0 uses `max(1, effective CPUs-2)`; explicit positive counts must fit CPU/RAM and the 511 runtime limit; all only |
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

## How many judge instances?

“Judge instances” means execution slots, not OS threads or multiple OJ installations. All mode prompts only when first creating `judge.yaml` and `--judge-slots` was not explicitly supplied, showing effective CPU/RAM capacity and the default `max(1, effective CPUs-2)`; web mode does not ask. Enter or `0` keeps automatic-selection semantics; a positive number records an explicit choice. If the default exceeds memory capacity, interactive installation asks again for a smaller count instead of silently reducing it; unattended first installation fails clearly. A retry with existing `judge.yaml` and no explicit slot argument preserves the configuration and `judgeSlots: 0` automatic semantics without prompting or applying a new CPU-minus-two default to block valid old settings. An installation originally using an explicit positive value still requires that original argument when retried.

With 4, 8 or 16 effective CPUs and sufficient RAM, defaults are 2, 6 and 14 slots. The old seven-slot cap is removed; effective CPUs, RAM and the 511-slot libuv ceiling still apply. More OS threads or AI concurrency do not create execution slots. See [judge configuration](Judge-Configuration.md) for budgets and the maintained resize command. `--plan` displays resources/workflow without certifying installability; `--check` and installation preflight reject unsuitable resource settings.

## MariaDB initialization failures and safe retries

A datadir `Errcode: 13 Permission denied` can occur even when mysql owns the directory: AppArmor may reject root's `dac_read_search` / `dac_override` before it drops privileges. Repeated chmod/chown is not sufficient for that mechanism.

The new [initialize-mariadb.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/initialize-mariadb.py) switches to mysql before executing database programs. It initializes in private `data/mariadb-init/stage-*`, starts a temporary server with networking disabled, checks system tables and socket accounts, then publishes to an empty destination. A `data/mariadb/mysql/` directory alone no longer proves initialization succeeded. Failed staging data/logs are retained. Existing target contents are validated and preserved; incomplete or damaged databases stop the operation rather than being deleted, overwritten or assigned new credentials. Existing socket/PID files also prevent blindly starting another server. Existing-database validation starts the engine and may perform normal recovery and log updates; preservation is not byte-for-byte read-only access. This is an internal installation tool, not a command to run on a healthy live instance.

The fix retains AppArmor confinement, adding only instance data/staging paths rather than DAC-bypass capabilities or disabling policy. This implementation belongs to the pending revision; confirm the update includes it. Read the indicated private diagnostic log, fix the cause and rerun with the original installer options. Do not delete the database, keys or installation state or edit metadata to bypass checks. Back up an incomplete existing database before administrator repair/restore.

An isolated reproduction used Ubuntu 24.04 MariaDB 10.11.14 with a separately named profile from Ubuntu 26.04's MariaDB 11.8.6-5 package. Root-first startup with `--user=mysql` reproduced Err13 and both capability denials; starting directly as mysql created the system tables. The temporary profile only renamed the profile and allowed fixture paths, without adding capabilities. One nonfatal sys-device read denial remained. This validates the failure mechanism and identity-switch approach, not a complete fresh Ubuntu 26.04 deployment, every MariaDB version or all AppArmor behavior.

The production initialization helper subsequently passed these checks, with separate scopes:

| Environment | Actual result | Outside that result's scope |
| --- | --- | --- |
| Host Ubuntu 24.04 MariaDB 10.11.14, isolated temporary directories | Fresh initialization and existing-database retry passed system-table/socket SQL checks | No live OJ reinstall |
| Official Ubuntu 26.04 container, OS 26.04.1 and MariaDB 11.8.6-5ubuntu0.1 | The same production helper passed fresh initialization and existing-database SQL revalidation | Container uses enforced `docker-default`, not the MariaDB-specific profile or a systemd VM |
| Ubuntu 24.04 host with a separately named Ubuntu 26.04 MariaDB profile | Reproduced the AppArmor mechanism: root-first failed, mysql-first succeeded | Host MariaDB version, not a complete 26.04 environment |

These checks complement one another. **A fresh full-site Ubuntu 26.04 VM installation and business acceptance run remain outstanding**; component results are not an all-compatibility guarantee.

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
