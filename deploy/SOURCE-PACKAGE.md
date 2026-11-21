# Source package and external downloads

English | [简体中文](SOURCE-PACKAGE.zh-CN.md)

Included: backend, frontend, judge, simple-sandbox, vendored testlib and licenses, original rootfs recipe, English/Chinese install and upgrade entry points (`install.sh`, `upgrade.sh` and their `.zh-CN` versions) and documentation, the shared lint rules (`eslint.airbnb-base.mjs`), configuration templates, CI and lockfiles. The archive can seed a new Git repository without the old deployment history.

Completeness is checked, not assumed: every file Git tracks is either in the archive or left out by one of these named rules: Git metadata, installed dependencies, build output, instance configuration and data (`config/*` except the `.example` files, `data`, `runtime`, `backups`, `logs`, `cache`), release and verification output, logs and core dumps, downloaded images, private keys, local archives, `.env` files, private installation state, and the old deployment artifacts in `deploy/noi`, `deploy/september20` and `deploy/rootfs`. A tracked file that matches no rule, or one that's missing, stops `deploy/prepare-github.py` instead of being left out, and so does a symbolic link. CI builds an archive on every push, extracts it, installs its locked dependencies offline and runs the type checks and lint inside it. Like a fresh clone, an extracted archive needs `git init` and a first commit before it builds: the legacy bootstrap packages record the commit they were built from. Only files Git tracks are taken (testlib's from its submodule's own index); `--include-untracked` adds files Git doesn't track but doesn't ignore. The tool needs a Git checkout: in an installed copy without `.git` it writes nothing and prints how to check out the installed revision instead.

Excluded: real passwords/API keys, databases, problem/user data, logs, backups, node_modules, full rootfs, Docker images, system ISO files and installed binaries.

| Download | Source |
| --- | --- |
| MariaDB, Redis, Nginx and build packages | Server's configured Ubuntu repositories |
| Node 24.21.0 | nodejs.org; fixed checksum |
| pnpm 11.13.1 and locked dependencies | npm registry |
| Go 1.26.8 | go.dev; fixed checksum |
| Pinned MinIO source | GitHub codeload; fixed commit/checksum, built locally |
| Twemoji/Hack and some native dependency resources | Their upstream GitHub projects |
| Docker Engine/buildx, if missing | Official Docker repository or selected package mirror; official signing key |
| Rootfs base images | Docker Hub or selected Hub mirror; original fixed image digest |
| Rootfs tools/packages | Fixed versions and sources in infra/sandbox-rootfs/Dockerfile, including dated APT snapshots |

Full rootfs is built on the server, not downloaded from this project's Releases. Web-only mode does not build rootfs or install Docker. Docker mirrors affect container-image pulls, not all other dependency sources.

Generated config, systemd units, random admin credentials and runtime data stay on the installation server. The main MIT license does not replace third-party licenses; binary/rootfs redistribution needs separate compliance review.

Exact URLs and versions appear in install.sh, deploy/install.sh, pnpm-lock.yaml, deploy/build-frontend-offline.mjs and infra/sandbox-rootfs/Dockerfile.
