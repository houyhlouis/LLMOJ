# 独立评测机安装

[English](Remote-Judge.md) | 简体中文

本教程只安装 judge，不安装网页、数据库、Redis 或 MinIO。每台评测机使用独立 key，主动连接网页服务器。目标为 Ubuntu 24.04 / 26.04 amd64（26.04 完整安装未验收）、systemd 254+、统一 cgroup v2，至少 3 GiB 内存、30 GiB 空闲空间。使用普通虚拟机或物理机；限制 namespaces、挂载或 cgroup 委托的容器不适用。

## 1. 下载同版本源码

先在网页节点查看 `config/install-complete.json` 的 `sourceCommit`，或使用双方统一的发布标签。以下命令中的仓库和提交必须替换：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git xz-utils build-essential cmake \
  libfmt-dev python3 python3-yaml util-linux pkg-config
sudo git clone https://github.com/houyhlouis/LLMOJ.git /opt/LibreOJ
cd /opt/LibreOJ
sudo git checkout WEB_SERVER_COMMIT_OR_TAG
# 本项目的干净源码包包含 testlib；仅在缺少 testlib.h 时初始化子模块：
if [ ! -f apps/judge/vendor/testlib/testlib.h ]; then
  sudo git submodule update --init --recursive
fi
```

## 2. 安装固定 Node 和 pnpm，构建 judge

以下版本和校验值与一键安装器一致。校验失败时停止，不跳过校验。

```bash
OJ_NODE_STAGE=$(mktemp -d)
curl --proto '=https' --tlsv1.2 -fL --retry 3 \
  https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz \
  -o "$OJ_NODE_STAGE/node.tar.xz"
printf '%s  %s\n' \
  fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 \
  "$OJ_NODE_STAGE/node.tar.xz" | sha256sum --check
# 仅在上面的校验成功后执行：
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

继续使用相同工具路径构建：

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

此步骤安装工作区依赖；build:artifacts 也构建共享前端/bootstrap 产物，但不会在评测机上安装或启动网页服务。

## 3. 准备原版 rootfs

按 [Docker 官方 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/) 安装 Docker Engine 与 buildx；自定义源见 [Docker 源](Docker-Sources.zh-CN.md)。然后执行：

```bash
sudo docker info
sudo docker buildx version
sudo env BUILDX_BUILDER=default bash deploy/sandbox/build.sh build
bash deploy/sandbox/build.sh plan
```

用输出的实际 `ROOTFS_ID` 和 `ARCHIVE` 路径进行暂存。此处使用与一键安装器一致的验证配置：编译 x32，但不执行 x32 程序；仍完整验证 amd64/i386 和各语言。

```bash
sudo env LIBREOJ_X32_SUPPORTED=0 unshare --net --mount --propagation private -- \
  bash deploy/sandbox/build.sh stage /opt/LibreOJ/runtime/sandbox-archives/rootfs-ACTUAL_ROOTFS_ID.tar.gz
```

也可以在可信构建机上构建相同配方，复制 `rootfs-<ID>.tar.gz` 及其 `.sha256` 到评测机，再执行暂存与语言验证；这样评测机本身无需 Docker。不要混用不同版本的 rootfs。Docker 仅用于构建，每次提交由原生 `simple-sandbox` 执行。

## 4. 保存 key 并生成远程配置

先按 [分布式教程](Distributed-Judging.zh-CN.md) 注册该节点，取得独立 key。用编辑器把 key 单独一行写入文件，避免出现在命令历史中：

以下创建 key 文件的命令仅用于首次准备；已有 `/root/judge-01.key` 时不要覆盖，用原文件。

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

网页 URL 必须是 origin，不带 `/api`。key 文件必须为 root 所有、`0600` 的普通文件；脚本不输出 key。首次生成显式槽数须符合有效 CPU、内存和 libuv 的 511 上限；省略 `OJ_JUDGE_SLOTS` 时默认为 `max(1, 有效 CPU 数-2)`，内存不足时要求明确选择更少槽数。已有 YAML 不会因该变量改变而自动扩容，请使用正式 resize 脚本。完整字段、线程池与已有节点扩缩容见 [评测端配置](Judge-Configuration.zh-CN.md)。

生成的 `config/judge.yaml` 同样仅 root 可读；远程模式关闭本机 AI socket，并生成独立 `libreoj-judge.target`。再次生成会核对原配置，不覆盖不同服务器或 key；轮换密钥需停机后明确更新私有配置。

## 5. 注册 systemd 和验证沙盒

只安装 judge 单元及工作目录挂载，避免把网页服务模板注册到评测机：

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
  --property=WorkingDirectory=/opt/LibreOJ/apps/judge \
  /opt/LibreOJ/runtime/node/bin/node /opt/LibreOJ/deploy/sandbox/verify-installed.mjs --root /opt/LibreOJ
# 只有沙盒检查成功后才启动评测：
sudo systemctl enable --now libreoj-judge.target
sudo systemctl status libreoj-judge.service
sudo journalctl -u libreoj-judge.service -n 50 --no-pager
```

该检查实际编译并运行程序，核对 UID、只读 rootfs、网络隔离、tmpfs 和 cgroup 资源限制。不要递归修改 rootfs 的所有权；其中有专门的 sandbox UID。

最后在网页端确认节点在线并提交程序验收。评测机无需开放入站网页端口，只需允许出站连接网页 origin 和必要下载源。停止用 `sudo systemctl stop libreoj-judge.target`；取消开机启动用 `sudo systemctl disable libreoj-judge.target`。

当前教程的配置与 systemd 单元已经隔离验证；完整独立机器安装和真实多机调度仍需部署者现场验收。
