# Source package and external downloads

English | [简体中文](SOURCE-PACKAGE.zh-CN.md)

Included: backend, frontend, judge, simple-sandbox, vendored testlib and licenses, original rootfs recipe, English/Chinese install entry points and documentation, configuration templates, CI and lockfiles. The archive can seed a new Git repository without the old deployment history.

Excluded: real passwords/API keys, databases, problem/user data, logs, backups, node_modules, full rootfs, Docker images, system ISO files and installed binaries.

| Download | Source |
| --- | --- |
| MariaDB, Redis, Nginx and build packages | Server's configured Ubuntu repositories |
| Node 24.21.0 | nodejs.org; fixed checksum |
| pnpm 11.13.0 and locked dependencies | npm registry |
| Go 1.26.8 | go.dev; fixed checksum |
| Pinned MinIO source | GitHub codeload; fixed commit/checksum, built locally |
| Twemoji/Hack and some native dependency resources | Their upstream GitHub projects |
| Docker Engine/buildx, if missing | Official Docker repository or selected package mirror; official signing key |
| Rootfs base images | Docker Hub or selected Hub mirror; original fixed image digest |
| Rootfs tools/packages | Fixed versions and sources in infra/sandbox-rootfs/Dockerfile, including dated APT snapshots |

Full rootfs is built on the server, not downloaded from this project's Releases. Web-only mode does not build rootfs or install Docker. Docker mirrors affect container-image pulls, not all other dependency sources.

Generated config, systemd units, random admin credentials and runtime data stay on the installation server. The main MIT license does not replace third-party licenses; binary/rootfs redistribution needs separate compliance review.

Exact URLs and versions appear in install.sh, deploy/install.sh, pnpm-lock.yaml, deploy/build-frontend-offline.mjs and infra/sandbox-rootfs/Dockerfile.
