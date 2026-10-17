# Installation and ports

[简体中文](Installation.zh-CN.md) | English | [Wiki home](Home.en.md)

## Requirements

- **Operating system:** Ubuntu 24.04 or 26.04, amd64, on an ordinary virtual machine or physical server. Restricted Docker or LXC containers aren't supported.
- **System features:** systemd 254 or later, and cgroup v2 with the cpu, memory and pids controllers.
- **Judging on the same server:** at least 2 CPUs and 256 MiB of memory available to LLMOJ. 8 GiB of memory makes the first build more comfortable.
- **Disk space:** 30 GiB free for a full installation, 10 GiB for a web-only one.
- **Network:** the first installation downloads from the Ubuntu repositories, GitHub, npm, Node.js and Go, and, for a full installation, Docker images and the judge's sandbox files.

Full installations have been tested on Ubuntu 24.04. Ubuntu 26.04 passes the installer's checks, but a complete fresh installation on it hasn't been tested yet.

New installations go to `/opt/LLMOJ`. Installations made when the default was `/opt/LibreOJ` stay there; pass `--prefix /opt/LibreOJ` when running the installer for them.

## Installing

```bash
curl -fsSL https://raw.githubusercontent.com/houyhlouis/LLMOJ/main/install.sh -o /tmp/llmoj-install.sh
sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ
```

If curl is missing, install it first with `sudo apt-get update && sudo apt-get install -y curl ca-certificates`. For messages in Chinese, use `install.zh-CN.sh` instead.

The script downloads the chosen commit of the repository and records which repository and commit were installed. It doesn't sign in to GitHub. For a private repository, download the source yourself and run `sudo bash deploy/install.sh` in it.

The installer asks for:

- the role: a full site, or web only;
- the listening address and HTTP port;
- the installation directory and site name;
- the address people will use in their browsers. Behind NAT or on a cloud server, enter the real public IP address or domain, since the detected address may be a private one;
- for a full site, the [Docker sources](Docker-Sources.md) and, the first time, the number of [judge slots](#choosing-the-number-of-judge-slots).

## Options

| Option | Meaning |
| --- | --- |
| `--repository OWNER/REPO` | The public repository to install from (required by the download script) |
| `--ref BRANCH_OR_TAG_OR_COMMIT` | What to install; `main` by default (download script only) |
| `--prefix PATH` | Installation directory, `/opt/LLMOJ` by default: an absolute path without spaces or special characters. One installation per server. |
| `--role all\|web` | `all` (default) for the full site, `web` for a site without judging or local AI workers |
| `--port NUMBER` | HTTP port, `80` by default. 2002, 2020, 13306, 16379, 19000 and 19001 are used internally. |
| `--listen ADDRESS` | `0.0.0.0` (default, every address) or `127.0.0.1` (only this server, for use behind a [proxy](HTTPS.md)) |
| `--public-url ORIGIN` | The address people use, such as `https://oj.example.com`, without a path. Guessed from the server's IP address and port by default. It doesn't set up HTTPS by itself. |
| `--site-name TEXT` | Site name, `LLMOJ` by default; 1 to 60 characters |
| `--judge-slots NUMBER` | Number of judge slots (full site only); `0` or omitted means automatic |
| `--docker-source URL` | Docker package repository, `https://download.docker.com` by default |
| `--docker-mirrors URL[,URL]` | Docker Hub mirrors; none by default, which keeps the server's existing settings |
| `--yes`, `--non-interactive` | Don't ask questions; use the options given and defaults for the rest |
| `--interactive` | Ask questions even when they'd normally be skipped (needs a terminal) |
| `--check` | Only check whether the server is suitable |
| `--plan` | Only show what would be done |
| `--help`, `-h` | Show help |

`--check` and `--plan` still download the source to a temporary directory, but install nothing. `--repository` and `--ref` belong to the download script, not to `deploy/install.sh`.

For example:

```bash
sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ \
  --yes --port 8080 --public-url http://oj.example.com:8080 --site-name LLMOJ
```

## Choosing the number of judge slots

A judge slot runs one program at a time; more slots judge more submissions in parallel. The default, which is also the maximum, is:

> the number of CPUs minus one, or the memory in MiB divided by 256, whichever is smaller (and at most 511)

so one CPU stays free for the rest of the site and each slot gets 256 MiB. For example, with enough memory, 4, 8 and 16 CPUs give 3, 7 and 15 slots. A server with only one CPU or less than 256 MiB of memory can't judge: install it with `--role web` or give it more resources.

The installer asks only when it first creates `judge.yaml` and you didn't pass `--judge-slots`. Press Enter (or enter `0`) for the automatic value, or enter a smaller number. Running the installer again keeps the existing number. To change it later, after adding CPUs or memory for example, use the [resize command](Judge-Configuration.md); rerunning the installer with a different `--judge-slots` doesn't change an existing installation.

## Firewall, HTTPS and other system changes

The installer doesn't change the firewall or cloud security groups: allow the site's port yourself. The database, Redis, MinIO, the backend and its metrics listen only on the server itself; don't make them reachable from outside. The site uses plain HTTP until you set up [HTTPS](HTTPS.md).

For Redis, the installer sets `vm.overcommit_memory=1` and saves it in `/etc/sysctl.d/99-libreoj-redis.conf`, unless a file with that name already exists. MinIO may warn that the data becomes unavailable if the server fails: it runs on a single server, so keep separate [backups](Operations-Configuration.md).

## After installing

When installation succeeds, the terminal shows the `admin` user name, its random 32-character password and the path of the file that also holds them, `config/admin-credentials.json` (readable only by root). Keep this output private. If you run the installer again, it shows the password only if it still works.

Manage the services with:

```bash
sudo systemctl status libreoj.target
sudo systemctl restart libreoj.target
sudo systemctl stop libreoj.target
sudo systemctl disable libreoj.target
sudo journalctl -u libreoj-backend -u libreoj-judge -u libreoj-nginx -n 100 --no-pager
```

To change settings later, see the [configuration overview](Configuration.md); services, ports, mail and storage are in [Operations](Operations-Configuration.md). To install a newer version, use the [upgrader](Upgrade.md), not the installer.

## If installation fails

Fix the reported problem and run the installer again with the same options as the first time: directory, role, site name, address, listening address, port, judge slots and Docker sources. Don't delete configuration or installation state to get round a mismatch.

## MariaDB initialization failures and safe retries

If MariaDB fails to initialize with `Errcode: 13 Permission denied` on its data directory, even though the directory belongs to `mysql`, AppArmor is the likely cause: it stops root from reading the directory before MariaDB switches to the `mysql` user. Changing owners or permissions doesn't help.

The installer avoids this by running the database programs as `mysql` from the start (see [initialize-mariadb.py](https://github.com/houyhlouis/LLMOJ/blob/main/deploy/initialize-mariadb.py)). It keeps AppArmor on, and only allows the installation's own directories. It prepares the database in a private staging directory, checks it with a temporary server that has networking turned off, and only then moves it into place.

An existing database is checked and kept: if it's incomplete or damaged, the installer stops rather than deleting it, overwriting it or giving it new passwords. Failed attempts keep their staging data and logs. Read the log the installer names, fix the cause and run the installer again with the same options. Don't delete the database, keys or installation state; back up an incomplete database before repairing or restoring it.

This tool is part of installation; don't run it against a working site.
