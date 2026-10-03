# Docker sources

English | [简体中文](Docker-Sources.zh-CN.md)

Two settings serve different downloads: the **package repository** installs Docker Engine/buildx; a **Docker Hub registry mirror** supplies container base images used to build rootfs. Defaults use Docker's official package source and leave the host's Docker image-source configuration unchanged. On a new host, that means official Docker Hub.

## Interactive or command-line selection

Complete-mode terminal installation asks for both settings. Press Enter to keep defaults. In non-interactive mode:

```bash
sudo bash /tmp/llmoj-install.sh --repository houyhlouis/LLMOJ \
  --yes --docker-source https://YOUR_PACKAGE_MIRROR/docker-ce \
  --docker-mirrors https://YOUR_DOCKER_HUB_MIRROR
```

Use only HTTPS URLs without credentials/query strings. Multiple Hub mirrors use commas. Example URLs above are placeholders, not operating public mirrors.

| Option | Expected URL |
| --- | --- |
| `--docker-source` | Base such as `https://download.docker.com`; installer adds `/linux/ubuntu` |
| `--docker-mirrors` | Docker Hub pull-through endpoint, such as `https://mirror.example.com` |

Do not append `/linux/ubuntu` to the package-source option. The custom repository must carry Docker's signed Ubuntu packages for your version. The GPG key is still downloaded from `https://download.docker.com/linux/ubuntu/gpg`, preserving the official trust key. Existing Docker is not replaced by this option. See [Docker's Ubuntu repository instructions](https://docs.docker.com/engine/install/ubuntu/).

## Configuration behavior

When rootfs must be built and custom mirrors are selected, the installer merges `registry-mirrors` into `/etc/docker/daemon.json`, preserves unrelated settings, validates the candidate with `dockerd --validate`, backs up the previous file as `daemon.json.llmoj-backup-<UTC timestamp>`, and applies the change atomically. Invalid JSON/configuration stops before replacement. A changed configuration restarts Docker and may interrupt existing containers.

Blank mirror input leaves `daemon.json` unchanged. Web-only installation and reuse of an existing rootfs skip Docker setup. Selecting a different mirror/source on a retry conflicts with recorded installation options; reuse the original options, or perform an explicit configuration migration after installation.

Rootfs builds use the local Docker default builder so daemon mirror settings apply. The original rootfs recipe and pinned base-image digest are retained. Mirrors do not accelerate Ubuntu snapshots, GitHub, npm or language downloads; configure those separately if needed. Docker Hub pull-through mirrors also do not mirror arbitrary third-party registries. See [Docker's mirror documentation](https://docs.docker.com/docker-hub/image-library/mirror/).

## Independent judges

For manual [judge setup](Remote-Judge.md), install Docker from a repository suited to your server and then, if desired, configure the mirrors with the same helper:

```bash
sudo python3 deploy/docker-support.py --mirrors https://YOUR_DOCKER_HUB_MIRROR --configure
```

It prints `changed` or `unchanged`. If changed, restart Docker before building; if unchanged, start it if needed. Then use the default builder:

```bash
sudo systemctl restart docker  # Only when mirror configuration changed.
sudo env BUILDX_BUILDER=default bash deploy/sandbox/build.sh build
```

Keep the previous Docker backup when planning rollback. This helper never prints private host configuration.
