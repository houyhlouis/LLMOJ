# Remote judges

[简体中文](Remote-Judge.zh-CN.md) | English | [Wiki home](Home.en.md)

This guide sets up a judge on its own server, without the website, database, Redis or MinIO. The judge connects to the site itself, using its own key, so the site needs no open port on the judge.

You need:
- Ubuntu 24.04 or 26.04 (amd64), systemd 254 or later and cgroup v2. Ubuntu 26.04 hasn't been tested end to end yet. Containers that restrict namespaces, mounts or cgroups won't work.
- At least 2 CPUs and 256 MiB of memory for one judge slot, and 30 GiB of free disk. Building on the judge needs more memory: 8 GiB is recommended.
- A judge registered on the site, with its key (see [Distributed judging](Distributed-Judging.md)).

## 1. Download the same version as the site

The judge must run the same version as the site. Find it as `sourceCommit` in the site's `config/install-complete.json`, or use the same release tag on both. Then:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git xz-utils build-essential cmake \
  libfmt-dev python3 python3-yaml util-linux pkg-config
sudo git clone https://github.com/houyhlouis/LLMOJ.git /opt/LLMOJ
cd /opt/LLMOJ
sudo git checkout WEB_SERVER_COMMIT_OR_TAG
# Source archives include testlib; initialize only if testlib.h is absent:
if [ ! -f apps/judge/vendor/testlib/testlib.h ]; then
  sudo git submodule update --init --recursive
fi
```

## 2. Install Node.js and pnpm, and build the judge

These are the versions and checksum the installer uses. If the checksum doesn't match, stop.

```bash
OJ_NODE_STAGE=$(mktemp -d)
curl --proto '=https' --tlsv1.2 -fL --retry 3 \
  https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz \
  -o "$OJ_NODE_STAGE/node.tar.xz"
printf '%s  %s\n' \
  fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 \
  "$OJ_NODE_STAGE/node.tar.xz" | sha256sum --check
# Continue only after the checksum succeeds:
sudo install -d -m 0755 /opt/LLMOJ/runtime
sudo tar -xJf "$OJ_NODE_STAGE/node.tar.xz" -C /opt/LLMOJ/runtime
sudo ln -sfn node-v24.21.0-linux-x64 /opt/LLMOJ/runtime/node
rm -r -- "$OJ_NODE_STAGE"

sudo env PATH=/opt/LLMOJ/runtime/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  npm install --prefix /opt/LLMOJ/runtime/tooling --ignore-scripts --no-audit --no-fund pnpm@11.13.1

sudo env PATH=/opt/LLMOJ/runtime/node/bin:/opt/LLMOJ/runtime/tooling/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  npm_config_nodedir=/opt/LLMOJ/runtime/node CMAKE_BUILD_PARALLEL_LEVEL=2 \
  NODE_OPTIONS=--max-old-space-size=2300 pnpm install --frozen-lockfile --store-dir runtime/pnpm-store
```

Then build with the same tools:

```bash
sudo env PATH=/opt/LLMOJ/runtime/node/bin:/opt/LLMOJ/runtime/tooling/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  npm_config_nodedir=/opt/LLMOJ/runtime/node CMAKE_BUILD_PARALLEL_LEVEL=2 \
  NODE_OPTIONS=--max-old-space-size=2300 pnpm_config_verify_deps_before_run=false bash -e -c '
    pnpm build:artifacts
    pnpm --filter simple-sandbox build
    pnpm build:native
    pnpm --filter @libreoj/judge build
  '
```

`build:artifacts` also builds files shared with the website; it doesn't install or start a website on the judge.

## 3. Prepare the sandbox image

Install Docker Engine and buildx as described in [Docker's Ubuntu guide](https://docs.docker.com/engine/install/ubuntu/) (for other download sources, see [Docker sources](Docker-Sources.md)), then build the image:

```bash
sudo docker info
sudo docker buildx version
sudo env BUILDX_BUILDER=default bash deploy/sandbox/build.sh build
bash deploy/sandbox/build.sh plan
```

Install it with the `ROOTFS_ID` and archive path that the build printed. As in the installer, x32 programs are compiled but not run; the other checks still run.

```bash
sudo env LIBREOJ_X32_SUPPORTED=0 unshare --net --mount --propagation private -- \
  bash deploy/sandbox/build.sh stage /opt/LLMOJ/runtime/sandbox-archives/rootfs-ACTUAL_ROOTFS_ID.tar.gz
```

Instead of installing Docker on the judge, you can build the same recipe on a trusted machine and copy `rootfs-<ID>.tar.gz` and its `.sha256` file to the judge, then install them as above. Don't mix versions. Docker is only used to build the image: submissions run in LLMOJ's own sandbox.

## 4. Save the key and write the configuration

Save the judge's key on one line with an editor, so it doesn't end up in your shell history. If `/root/judge-01.key` already exists, keep it instead of creating it again.

```bash
sudo install -m 0600 /dev/null /root/judge-01.key
sudoedit /root/judge-01.key
sudo install -d -m 0751 /opt/LLMOJ/data
sudo install -d -m 0711 /opt/LLMOJ/data/judge
sudo install -d -m 0700 /opt/LLMOJ/data/judge/testdata /opt/LLMOJ/data/judge/cache
sudo env HYHOJ_ROOT=/opt/LLMOJ NODE_BINARY=/opt/LLMOJ/runtime/node/bin/node \
  OJ_JUDGE_REMOTE=1 OJ_JUDGE_SERVER=https://oj.example.com \
  OJ_JUDGE_KEY_FILE=/root/judge-01.key OJ_JUDGE_SLOTS=2 \
  python3 deploy/configure-judge.py
```

- `OJ_JUDGE_SERVER` is the site's address, without `/api`.
- The key file must be a regular file owned by root with mode `0600`; its contents are never printed.
- `OJ_JUDGE_SLOTS` must fit the server's CPUs and memory. Leave it out for the automatic number (see [Judge configuration](Judge-Configuration.md#choosing-the-number-of-slots)). A server with one CPU or less than 256 MiB of memory can't judge.

The script also creates the account `libreoj-judge`, a system account without login. The judge runs as this account; only its [sandbox launcher](Judge-Configuration.md#the-judges-account-and-its-sandbox-launcher) runs as root, and gives the judge its directories when it starts.

The resulting `config/judge.yaml` is readable only by root. A remote judge has no local AI worker; for a `web` site it runs AI programs from the judge queue instead ([Distributed judging](Distributed-Judging.md#ai)). It gets its own `libreoj-judge.target`. Running the script again keeps the configuration and refuses a different site or key; to change the key, stop the judge and change it deliberately. To change the number of slots later, use the [resize command](Judge-Configuration.md#changing-the-number-of-slots). [Judge configuration](Judge-Configuration.md) describes every setting.

## 5. Install the service and check the sandbox

Install only the judge's service and its working directory mounts (not the website's services), check the sandbox, then start judging:

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
  sudo systemctl enable --now "$(basename "$OJ_JUDGE_MOUNT")"
done
sudo systemd-run --unit=libreoj-install-sandbox-check --wait --pipe --collect \
  --property='Delegate=cpu memory pids' --property=DelegateSubgroup=supervisor \
  --property=LimitCORE=0 --property=RuntimeMaxSec=120 --property=TimeoutStopSec=15 \
  --property=WorkingDirectory=/opt/LLMOJ/apps/judge \
  /opt/LLMOJ/runtime/node/bin/node /opt/LLMOJ/deploy/sandbox/verify-installed.mjs --root /opt/LLMOJ
# Start judging only after the sandbox check succeeds:
sudo systemctl enable --now libreoj-judge.target
sudo systemctl status libreoj-judge.service
sudo journalctl -u libreoj-judge.service -n 50 --no-pager
```

The check compiles and runs a real program and checks the sandbox user, the read-only file system, network isolation, the system call filter, tmpfs and cgroup limits. Afterwards, `sudo bash /opt/LLMOJ/deploy/sandbox/self-test.sh` checks every language (see [self-test](Judge-Configuration.md#sandbox-syscall-filter-and-self-test)). Never change the owner of the sandbox image's files recursively: it has its own sandbox user.

Finally, check on the site that the judge is online, and make a few submissions. The judge needs outgoing access to the site's address and its download addresses, and no incoming port.

To stop the judge: `sudo systemctl stop libreoj-judge.target`. To stop it starting at boot: `sudo systemctl disable libreoj-judge.target`.

## Updating a remote judge

Update a remote judge to the site's version after the site:
1. On the site's **Judge Machine** page, [drain](Distributed-Judging.md#draining-keys-and-capabilities) it and wait until it shows **Drained**. Then stop it: `sudo systemctl stop libreoj-judge.target`.
2. In `/opt/LLMOJ`, check out the site's version as in [step 1](#1-download-the-same-version-as-the-site). Remove the native build directories, so that the add-ons are configured again with the new build tools: `sudo rm -rf apps/judge/build packages/simple-sandbox/build`. Then install and build as in [step 2](#2-install-nodejs-and-pnpm-and-build-the-judge); `pnpm install` installs the dependencies the new version locks.
3. Run `configure-judge.py` again with the same variables as in [step 4](#4-save-the-key-and-write-the-configuration). It keeps the configuration, and creates the judge's account if it's missing. Versions from before the sandbox launcher ran the whole judge as root and had no account.
4. Make the files readable and check the sandbox as in [step 5](#5-install-the-service-and-check-the-sandbox) (`chmod`, then the sandbox check), and run `sudo bash /opt/LLMOJ/deploy/sandbox/self-test.sh`.
5. Start it with `sudo systemctl start libreoj-judge.target`, and **Resume** it on the **Judge Machine** page.
