# 远程评测机

简体中文 | [English](Remote-Judge.md) | [Wiki 首页](Home.md)

本教程在独立的服务器上安装评测机，不安装网站、数据库、Redis 或 MinIO。评测机使用自己的密钥主动连接站点，因此站点不需要访问评测机上的任何端口。

需要：
- Ubuntu 24.04 或 26.04（amd64），systemd 254 或更高版本，cgroup v2。Ubuntu 26.04 尚未完整测试。限制命名空间、挂载或 cgroup 的容器无法使用。
- 一个评测槽至少需要 2 个 CPU 和 256 MiB 内存，以及 30 GiB 空闲磁盘空间。在评测机上构建需要更多内存，建议 8 GiB。
- 一台已在站点上注册的评测机及其密钥（见[分布式评测](Distributed-Judging.zh-CN.md)）。

## 1. 下载与站点相同的版本

评测机必须运行与站点相同的版本。在站点的 `config/install-complete.json` 中查看 `sourceCommit`，或在两边使用相同的发布标签。然后执行：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git xz-utils build-essential cmake \
  libfmt-dev python3 python3-yaml util-linux pkg-config
sudo git clone https://github.com/houyhlouis/LLMOJ.git /opt/LLMOJ
cd /opt/LLMOJ
sudo git checkout WEB_SERVER_COMMIT_OR_TAG
# 本项目的干净源码包包含 testlib；仅在缺少 testlib.h 时初始化子模块：
if [ ! -f apps/judge/vendor/testlib/testlib.h ]; then
  sudo git submodule update --init --recursive
fi
```

## 2. 安装 Node.js 和 pnpm 并构建评测机

以下版本和校验值与安装器相同。如果校验失败，请停止。

```bash
OJ_NODE_STAGE=$(mktemp -d)
curl --proto '=https' --tlsv1.2 -fL --retry 3 \
  https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz \
  -o "$OJ_NODE_STAGE/node.tar.xz"
printf '%s  %s\n' \
  fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 \
  "$OJ_NODE_STAGE/node.tar.xz" | sha256sum --check
# 仅在上面的校验成功后执行：
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

然后用同样的工具构建：

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

`build:artifacts` 也会构建与网站共用的文件，但不会在评测机上安装或启动网站。

## 3. 准备沙箱镜像

按 [Docker 的 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/) 安装 Docker Engine 和 buildx（其他下载源见 [Docker 源](Docker-Sources.zh-CN.md)），然后构建镜像：

```bash
sudo docker info
sudo docker buildx version
sudo env BUILDX_BUILDER=default bash deploy/sandbox/build.sh build
bash deploy/sandbox/build.sh plan
```

用构建输出的 `ROOTFS_ID` 和压缩包路径安装镜像。与安装器一样，x32 程序只编译不运行，其他检查照常进行。

```bash
sudo env LIBREOJ_X32_SUPPORTED=0 unshare --net --mount --propagation private -- \
  bash deploy/sandbox/build.sh stage /opt/LLMOJ/runtime/sandbox-archives/rootfs-ACTUAL_ROOTFS_ID.tar.gz
```

如果不想在评测机上安装 Docker，也可以在一台可信的机器上用相同配方构建，把 `rootfs-<ID>.tar.gz` 及其 `.sha256` 文件复制到评测机，再按上面的方法安装。不要混用不同版本。Docker 只用于构建镜像：提交的程序在 LLMOJ 自己的沙箱中运行。

## 4. 保存密钥并生成配置

用编辑器把评测机密钥写成一行，以免它出现在 shell 历史记录中。如果 `/root/judge-01.key` 已经存在，请保留它，不要重新创建。

```bash
sudo install -m 0600 /dev/null /root/judge-01.key
sudoedit /root/judge-01.key
sudo install -d -m 0751 /opt/LLMOJ/data
sudo install -d -m 0700 /opt/LLMOJ/data/judge /opt/LLMOJ/data/judge/testdata /opt/LLMOJ/data/judge/cache
sudo env HYHOJ_ROOT=/opt/LLMOJ NODE_BINARY=/opt/LLMOJ/runtime/node/bin/node \
  OJ_JUDGE_REMOTE=1 OJ_JUDGE_SERVER=https://oj.example.com \
  OJ_JUDGE_KEY_FILE=/root/judge-01.key OJ_JUDGE_SLOTS=2 \
  python3 deploy/configure-judge.py
```

- `OJ_JUDGE_SERVER` 是站点的地址，不带 `/api`。
- 密钥文件必须是所有者为 root、权限为 `0600` 的普通文件；其内容不会被输出。
- `OJ_JUDGE_SLOTS` 必须符合服务器的 CPU 和内存。不设置时使用自动值（见[评测配置](Judge-Configuration.zh-CN.md#如何确定评测槽数量)）。只有一个 CPU 或内存不足 256 MiB 的服务器不能评测。

生成的 `config/judge.yaml` 只有 root 可读。远程评测机没有本机 AI 任务，并使用自己的 `libreoj-judge.target`。再次运行脚本会保留已有配置，并拒绝不同的站点或密钥；要更换密钥，请停止评测机后明确修改。之后要修改评测槽数量，请使用[扩缩容命令](Judge-Configuration.zh-CN.md#修改评测槽数量)。每项设置的说明见[评测配置](Judge-Configuration.zh-CN.md)。

## 5. 安装服务并检查沙箱

只安装评测服务及其工作目录挂载（不要安装网站的服务），检查沙箱，然后开始评测：

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
# 只有沙盒检查成功后才启动评测：
sudo systemctl enable --now libreoj-judge.target
sudo systemctl status libreoj-judge.service
sudo journalctl -u libreoj-judge.service -n 50 --no-pager
```

该检查会编译并运行一个真实的程序，检查沙箱用户、只读文件系统、网络隔离、系统调用过滤器、tmpfs 和 cgroup 限制。之后可以运行 `sudo bash /opt/LLMOJ/deploy/sandbox/self-test.sh` 检查每种语言（见[自检](Judge-Configuration.zh-CN.md#沙箱系统调用过滤器与自检)）。不要递归修改沙箱镜像中文件的所有者：其中有专门的沙箱用户。

最后在站点上确认评测机在线，并提交几份程序。评测机需要能主动访问站点地址及其下载地址，不需要开放入站端口。

停止评测机：`sudo systemctl stop libreoj-judge.target`。取消开机启动：`sudo systemctl disable libreoj-judge.target`。
