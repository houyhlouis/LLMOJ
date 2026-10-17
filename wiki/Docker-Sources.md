# Docker sources

[简体中文](Docker-Sources.zh-CN.md) | English | [Wiki home](Home.en.md)

The installer uses Docker for two different downloads, and you can choose a source for each:

- the **package repository** that Docker Engine and buildx are installed from;
- a **Docker Hub mirror** for the base images used to build the judge's sandbox file system (the rootfs).

By default Docker's official package repository is used, and the server's existing Docker Hub settings are left alone, which on a new server means the official Docker Hub.

## Choosing sources

A full installation in a terminal asks for both; press Enter to keep the defaults. Without prompts, pass them as options:

```bash
sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ \
  --yes --docker-source https://YOUR_PACKAGE_MIRROR/docker-ce \
  --docker-mirrors https://YOUR_DOCKER_HUB_MIRROR
```

The addresses above are placeholders, not real mirrors. Use HTTPS addresses without user names, passwords or query strings, and separate several Docker Hub mirrors with commas.

| Option | Address to give |
| --- | --- |
| `--docker-source` | The repository's base address, such as `https://download.docker.com`. The installer adds `/linux/ubuntu` itself, so don't include it. |
| `--docker-mirrors` | A Docker Hub pull-through mirror, such as `https://mirror.example.com` |

The package repository must provide Docker's signed packages for your Ubuntu version. The signing key is still downloaded from `https://download.docker.com/linux/ubuntu/gpg`, so packages are checked against Docker's official key. If Docker is already installed, it isn't replaced. See [Docker's Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/).

## What the installer changes

When it has to build the rootfs and you chose Docker Hub mirrors, the installer adds them as `registry-mirrors` to `/etc/docker/daemon.json`, keeping your other settings. It checks the new file with `dockerd --validate`, saves the old one as `daemon.json.llmoj-backup-<UTC time>` and replaces it in one step; if the result is invalid, the old file is kept. Docker is then restarted, which may interrupt containers that are running.

Leaving the mirror empty leaves `daemon.json` unchanged. A web-only installation, or one that reuses an existing rootfs, doesn't touch Docker. If you run the installer again, give the same sources as the first time; to change them after installing, change the Docker configuration yourself.

The rootfs is built with Docker's default builder, so that the mirror settings apply; the build recipe and its pinned base image are unchanged. The mirrors only speed up Docker Hub images: Ubuntu packages, GitHub, npm and language toolchain downloads don't go through them, nor do other image registries. See [Docker's mirror documentation](https://docs.docker.com/docker-hub/image-library/mirror/).

## Separate judge servers

When [setting up a judge server by hand](Remote-Judge.md), install Docker from a repository that suits the server, then set the Docker Hub mirrors, if you want them, with the installer's helper:

```bash
sudo python3 deploy/docker-support.py --mirrors https://YOUR_DOCKER_HUB_MIRROR --configure
```

It prints `changed` or `unchanged`. If it printed `changed`, restart Docker; otherwise just make sure Docker is running. Then build with the default builder:

```bash
sudo systemctl restart docker  # only if the helper printed "changed"
sudo env BUILDX_BUILDER=default bash deploy/sandbox/build.sh build
```

Keep the backup of `daemon.json` in case you want to undo the change. The helper never prints the contents of the server's configuration.
