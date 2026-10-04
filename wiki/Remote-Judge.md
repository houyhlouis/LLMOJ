# Independent judge installation

English | [简体中文](Remote-Judge.zh-CN.md)

This guide installs only judge, without web/database/Redis/MinIO services. Each judge has its own key and initiates the web-server connection. Use Ubuntu 24.04 / 26.04 amd64, systemd 254+, unified cgroup v2, at least 3 GiB RAM and 30 GiB free disk. Restricted namespace/mount/cgroup containers are unsupported.

## 1. Download the same source version

Read `sourceCommit` in the web node's `config/install-complete.json`, or select the same release tag for both nodes. Replace the repository and version:


```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git xz-utils build-essential cmake \
  libfmt-dev python3 python3-yaml util-linux pkg-config
sudo git clone https://github.com/houyhlouis/LLMOJ.git /opt/LibreOJ
cd /opt/LibreOJ
sudo git checkout WEB_SERVER_COMMIT_OR_TAG
# Source archives include testlib; initialize only if testlib.h is absent:
if [ ! -f apps/judge/vendor/testlib/testlib.h ]; then
  sudo git submodule update --init --recursive
fi
```

## 2. Install pinned Node/pnpm and build judge

Versions and checksum match the installer. Stop on a checksum failure; do not bypass validation.


```bash
OJ_NODE_STAGE=$(mktemp -d)
curl --proto '=https' --tlsv1.2 -fL --retry 3 \
  https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz \
  -o "$OJ_NODE_STAGE/node.tar.xz"
printf '%s  %s\n' \
  fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 \
  "$OJ_NODE_STAGE/node.tar.xz" | sha256sum --check
# Continue only after the checksum succeeds:
sudo install -d -m 0755 /opt/LibreOJ/runtime
sudo tar -xJf "$OJ_NODE_STAGE/node.tar.xz" -C /opt/LibreOJ/runtime
sudo ln -sfn node-v24.21.0-linux-x64 /opt/LibreOJ/runtime/node
rm -r -- "$OJ_NODE_STAGE"

sudo env PATH=/opt/LibreOJ/runtime/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  npm install --prefix /opt/LibreOJ/runtime/tooling --ignore-scripts --no-audit --no-fund pnpm@11.13.1

sudo env PATH=/opt/LibreOJ/runtime/node/bin:/opt/LibreOJ/runtime/tooling/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  npm_config_nodedir=/opt/LibreOJ/runtime/node CMAKE_BUILD_PARALLEL_LEVEL=2 \
  NODE_OPTIONS=--max-old-space-size=2300 pnpm install --frozen-lockfile --store-dir runtime/pnpm-store
```

Continue building with the same tool path:


```bash
sudo env PATH=/opt/LibreOJ/runtime/node/bin:/opt/LibreOJ/runtime/tooling/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  npm_config_nodedir=/opt/LibreOJ/runtime/node CMAKE_BUILD_PARALLEL_LEVEL=2 \
  NODE_OPTIONS=--max-old-space-size=2300 pnpm_config_verify_deps_before_run=false bash -e -c '
    pnpm build:artifacts
    pnpm --filter simple-sandbox build
    pnpm build:native
    pnpm --filter @libreoj/judge build
  '
```

Workspace dependencies are installed. `build:artifacts` also builds shared frontend/bootstrap artifacts; it does not install or start a web service on this judge node.

## 3. Prepare the original rootfs

Follow [Docker's Ubuntu guide](https://docs.docker.com/engine/install/ubuntu/) to install Engine and buildx. For custom sources, see [Docker-Sources](Docker-Sources.md). Then build:


```bash
sudo docker info
sudo docker buildx version
sudo env BUILDX_BUILDER=default bash deploy/sandbox/build.sh build
bash deploy/sandbox/build.sh plan
```

Use the actual `ROOTFS_ID` and archive path printed by the plan/build. The following matches the installer's host profile: x32 is compiled but not executed; amd64/i386 and language checks still run.


```bash
sudo env LIBREOJ_X32_SUPPORTED=0 unshare --net --mount --propagation private -- \
  bash deploy/sandbox/build.sh stage /opt/LibreOJ/runtime/sandbox-archives/rootfs-ACTUAL_ROOTFS_ID.tar.gz
```

Alternatively, build the identical recipe on a trusted build machine and copy `rootfs-<ID>.tar.gz` plus its `.sha256` file to the judge for staging and language verification. This avoids Docker on the judge itself. Do not mix versions. Docker is for building; submissions execute in native `simple-sandbox`.

## 4. Save the private key and generate config

Register the node using [Distributed-Judging](Distributed-Judging.md). Put its key on a single line using an editor, keeping it out of command history:


```bash
sudo install -m 0600 /dev/null /root/judge-01.key
sudoedit /root/judge-01.key
sudo install -d -m 0751 /opt/LibreOJ/data
sudo install -d -m 0700 /opt/LibreOJ/data/judge /opt/LibreOJ/data/judge/testdata /opt/LibreOJ/data/judge/cache
sudo env HYHOJ_ROOT=/opt/LibreOJ NODE_BINARY=/opt/LibreOJ/runtime/node/bin/node \
  OJ_JUDGE_REMOTE=1 OJ_JUDGE_SERVER=https://oj.example.com \
  OJ_JUDGE_KEY_FILE=/root/judge-01.key OJ_JUDGE_SLOTS=2 \
  python3 deploy/configure-judge.py
```

The server URL must be an origin without `/api`. The key file must be regular, root-owned and `0600`; its contents are not printed. Slots range from 1–7 within machine capacity; omitting `OJ_JUDGE_SLOTS` chooses automatically.

The generated `config/judge.yaml` is also root-only. Remote mode disables the local AI socket and creates `libreoj-judge.target`. Reruns retain config and reject a different server/key; rotate credentials explicitly after stopping the judge.

## 5. Register systemd and verify isolation

Install only judge units/workspace mounts, avoiding the web service templates:


```bash
sudo chmod -R a+rX apps packages node_modules runtime/node-v24.21.0-linux-x64 runtime/tooling runtime/pnpm-store
shopt -s nullglob
OJ_JUDGE_MOUNTS=(deploy/systemd/*.mount)
sudo systemd-analyze verify deploy/systemd/libreoj-judge.service \
  deploy/systemd/libreoj-judge.target "${OJ_JUDGE_MOUNTS[@]}"
sudo install -m 0644 deploy/systemd/libreoj-judge.service \
  deploy/systemd/libreoj-judge.target "${OJ_JUDGE_MOUNTS[@]}" /etc/systemd/system/
sudo systemctl daemon-reload
for OJ_JUDGE_MOUNT in "${OJ_JUDGE_MOUNTS[@]}"; do
  sudo systemctl start "$(basename "$OJ_JUDGE_MOUNT")"
done
sudo systemd-run --unit=libreoj-install-sandbox-check --wait --pipe --collect \
  --property='Delegate=cpu memory pids' --property=DelegateSubgroup=supervisor \
  --property=LimitCORE=0 --property=RuntimeMaxSec=120 --property=TimeoutStopSec=15 \
  --property=WorkingDirectory=/opt/LibreOJ/apps/judge \
  /opt/LibreOJ/runtime/node/bin/node /opt/LibreOJ/deploy/sandbox/verify-installed.mjs --root /opt/LibreOJ
# Start judging only after the sandbox check succeeds:
sudo systemctl enable --now libreoj-judge.target
sudo systemctl status libreoj-judge.service
sudo journalctl -u libreoj-judge.service -n 50 --no-pager
```

The check compiles and runs a real program and verifies UID, read-only rootfs, network isolation, tmpfs and cgroup limits. Never recursively change rootfs ownership; it contains the sandbox UID.

Confirm the judge is online and submit programs on the web site. No inbound judge web port is required; allow outbound access to the web origin/download sources. Stop with `sudo systemctl stop libreoj-judge.target`; disable startup with `sudo systemctl disable libreoj-judge.target`.

Generated configuration/units have isolated checks; full independent-machine installation and real multi-node scheduling still require on-site verification.
