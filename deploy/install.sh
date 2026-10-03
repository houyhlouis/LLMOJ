#!/usr/bin/env bash
# Install one local instance. Do not enable shell tracing: this script handles secrets.
set -Eeuo pipefail
umask 0077

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PYTHON=/usr/bin/python3
PROJECT_ROOT=/opt/LibreOJ
PUBLIC_PORT=80
PUBLIC_ORIGIN=
LISTEN_ADDRESS=0.0.0.0
INSTALL_ROLE=all
SITE_NAME=LLMOJ
DOCKER_SOURCE=https://download.docker.com
DOCKER_MIRRORS=
DOCKER_SOURCE_GIVEN=0
DOCKER_MIRRORS_GIVEN=0
export LLMOJ_INSTALL_LANG="${LLMOJ_INSTALL_LANG:-en}"
source "$SOURCE_ROOT/deploy/install-messages.sh"
JUDGE_SLOTS=0
INTERACTIVE=auto
PORT_GIVEN=0
ORIGIN_GIVEN=0
LISTEN_GIVEN=0
ROLE_GIVEN=0
PREFIX_GIVEN=0
NAME_GIVEN=0
MODE=install
STEP=arguments
POLICY_CREATED=0
ROLLBACK_STARTED=0
INSTALL_SUCCESS=0
MOUNT_UNITS=()
NEW_DEFAULT_UNITS=()
SERVICE_UNITS=(libreoj-judge.service libreoj-nginx.service libreoj-backend.service libreoj-minio.service libreoj-redis.service libreoj-mariadb.service)

usage() {
    if [[ "$LLMOJ_INSTALL_LANG" == zh-CN ]]; then
        cat <<'USAGE_ZH'
用法：sudo bash deploy/install.zh-CN.sh [--prefix /opt/LibreOJ] [--port 80]
      [--listen 0.0.0.0|127.0.0.1] [--public-url https://oj.example.com]
      [--site-name LLMOJ] [--role all|web] [--judge-slots 1..7]
      [--docker-source https://download.docker.com] [--docker-mirrors HTTPS镜像源]
      [--yes | --interactive] [--check | --plan]
Ubuntu 24.04 / 26.04 amd64、systemd >=254、cgroup v2；每台服务器一个实例。
终端安装会询问选项；--yes 使用提供的参数和默认值。
默认公网 HTTP 80 端口；内部服务仅回环监听。防火墙和 TLS 需单独配置。
Docker 源仅在需要构建 rootfs 时使用。修改镜像加速源会重启 Docker。
--check 只检查环境，--plan 只显示流程；均不安装或启动服务。
成功后输出全权限 admin 的随机密码，私有凭据保存在 config/。
USAGE_ZH
        return
    fi
    cat <<'USAGE'
Usage: sudo bash deploy/install.sh [--prefix /opt/LibreOJ] [--port 80]
       [--listen 0.0.0.0|127.0.0.1] [--public-url https://oj.example.com]
       [--site-name LLMOJ] [--role all|web] [--judge-slots 1..7]
       [--docker-source https://download.docker.com] [--docker-mirrors https://mirror.example.com]
       [--yes | --interactive] [--check | --plan]
Ubuntu 24.04 / 26.04 amd64, systemd >=254, cgroup v2; one instance per server.
--check: read-only environment/resource/port checks; does not install anything.
--plan:  read-only list of installation steps; does not install anything.
Private credentials stay under config/. The admin password is printed after success.
Interactive terminal installs ask for options. --yes uses supplied/default options.
Nginx defaults to public HTTP on port 80. Internal services remain loopback-only.
The installer does not change firewall rules or configure TLS certificates.
See deploy/INSTALL.md for SSH tunneling, reverse proxies and restart instructions.
USAGE
}

die() { printf '%s\n' "$(translate "$*")" >&2; exit 1; }
while (($#)); do
    case "$1" in
        --prefix|--port|--public-url|--listen|--role|--site-name|--judge-slots|--docker-source|--docker-mirrors)
            (($# >= 2)) && [[ "$2" != --* ]] || die "Missing value for $1"
            case "$1" in
                --prefix) PROJECT_ROOT="$2"; PREFIX_GIVEN=1 ;;
                --port) PUBLIC_PORT="$2"; PORT_GIVEN=1 ;;
                --public-url) PUBLIC_ORIGIN="${2%/}"; ORIGIN_GIVEN=1 ;;
                --listen) LISTEN_ADDRESS="$2"; LISTEN_GIVEN=1 ;;
                --role) INSTALL_ROLE="$2"; ROLE_GIVEN=1 ;;
                --site-name) SITE_NAME="$2"; NAME_GIVEN=1 ;;
                --judge-slots) JUDGE_SLOTS="$2" ;;
                --docker-source) DOCKER_SOURCE="${2%/}"; DOCKER_SOURCE_GIVEN=1 ;;
                --docker-mirrors) DOCKER_MIRRORS="$2"; DOCKER_MIRRORS_GIVEN=1 ;;
            esac
            shift 2 ;;
        --check) MODE=check; shift ;;
        --plan) MODE=plan; shift ;;
        --help|-h) usage; exit 0 ;;
        --yes|--non-interactive) INTERACTIVE=no; shift ;;
        --interactive) INTERACTIVE=yes; shift ;;
        *) die "Unknown argument: $1" ;;
    esac
done
ask() {
    local destination=$1 prompt=$2 default=$3 answer
    read -r -p "$(translate "$prompt") [$default]: " answer || die "Input ended; use --yes for non-interactive installation"
    printf -v "$destination" '%s' "${answer:-$default}"
}
if [[ "$MODE" == install && ( "$INTERACTIVE" == yes || ( "$INTERACTIVE" == auto && -t 0 ) ) ]]; then
    [[ -t 0 ]] || die "Interactive installation needs a terminal; download the script to a file and run it"
    say '\nLLMOJ installation options (press Enter to keep defaults)\n'
    if [[ "$ROLE_GIVEN" == 0 ]]; then
        ask INSTALL_ROLE 'Installation: all = website + local judge; web = website only' "$INSTALL_ROLE"
    fi
    if [[ "$LISTEN_GIVEN" == 0 ]]; then
        ask LISTEN_ADDRESS 'Website listener: 0.0.0.0 = public; 127.0.0.1 = local only' "$LISTEN_ADDRESS"
    fi
    [[ "$PORT_GIVEN" == 1 ]] || ask PUBLIC_PORT 'HTTP port (80 needs no port suffix in the browser)' "$PUBLIC_PORT"
    [[ "$PREFIX_GIVEN" == 1 ]] || ask PROJECT_ROOT 'Installation directory' "$PROJECT_ROOT"
    [[ "$NAME_GIVEN" == 1 ]] || ask SITE_NAME 'Website name' "$SITE_NAME"
    if [[ "$INSTALL_ROLE" == all ]]; then
        [[ "$DOCKER_SOURCE_GIVEN" == 1 ]] || ask DOCKER_SOURCE 'Docker package source base URL (HTTPS, official by default)' "$DOCKER_SOURCE"
        [[ "$DOCKER_MIRRORS_GIVEN" == 1 ]] || ask DOCKER_MIRRORS 'Docker Hub mirrors (comma-separated HTTPS URLs; blank keeps Docker defaults; changes restart Docker)' "$DOCKER_MIRRORS"
    fi
fi
DOCKER_SOURCE="${DOCKER_SOURCE%/}"
"$PYTHON" "$SOURCE_ROOT/deploy/docker-support.py" --source "$DOCKER_SOURCE" --mirrors "$DOCKER_MIRRORS"
[[ "$PROJECT_ROOT" =~ ^/[A-Za-z0-9_./-]+$ ]] || die "Use an absolute prefix without spaces or special characters"
PROJECT_ROOT="$(realpath -m "$PROJECT_ROOT")"
case "$PROJECT_ROOT" in /|/opt|/srv|/usr|/etc|/var|/home|/root|/tmp|/run|/bin|/sbin) die "Choose a dedicated project directory" ;; esac
[[ "$PUBLIC_PORT" =~ ^[0-9]{1,5}$ ]] || die "Invalid public port"
PUBLIC_PORT=$((10#$PUBLIC_PORT))
if [[ -z "$PUBLIC_ORIGIN" ]]; then
    SITE_HOST=127.0.0.1
    if [[ "$LISTEN_ADDRESS" == 0.0.0.0 ]]; then
        SITE_HOST="$(hostname -I | awk '{ for (i=1;i<=NF;i++) if ($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) { print $i; exit } }')"
        SITE_HOST="${SITE_HOST:-127.0.0.1}"
    fi
    if [[ "$MODE" == install && "$ORIGIN_GIVEN" == 0 && ( "$INTERACTIVE" == yes || ( "$INTERACTIVE" == auto && -t 0 ) ) ]]; then
        ask SITE_HOST 'Browser hostname/IP (behind NAT, enter the real public IP or domain)' "$SITE_HOST"
    fi
    PUBLIC_ORIGIN="http://$SITE_HOST"
    [[ "$PUBLIC_PORT" == 80 ]] || PUBLIC_ORIGIN+=":$PUBLIC_PORT"
fi
SUPPORT=("$PYTHON" "$SOURCE_ROOT/deploy/install-support.py")
SUPPORT_ARGS=(--root "$PROJECT_ROOT" --origin "$PUBLIC_ORIGIN" --port "$PUBLIC_PORT"
    --listen "$LISTEN_ADDRESS" --role "$INSTALL_ROLE" --site-name "$SITE_NAME" --judge-slots "$JUDGE_SLOTS"
    --docker-source "$DOCKER_SOURCE" --docker-mirrors "$DOCKER_MIRRORS")
"${SUPPORT[@]}" validate "${SUPPORT_ARGS[@]}"
if [[ "$MODE" == plan ]]; then
    say 'Directory: %s\nSite origin: %s\nListen address: %s:%s\nRole: %s\nSite name: %s\n' "$PROJECT_ROOT" "$PUBLIC_ORIGIN" "$LISTEN_ADDRESS" "$PUBLIC_PORT" "$INSTALL_ROLE" "$SITE_NAME"
    say 'Docker package source: %s/linux/ubuntu\nDocker Hub mirrors: %s\n' "$DOCKER_SOURCE" "${DOCKER_MIRRORS:-$(translate 'official/default')}"
    if [[ "$LLMOJ_INSTALL_LANG" == zh-CN ]]; then
        cat <<'PLAN_ZH'
1. 检查 Ubuntu、systemd/cgroup v2、资源、端口和已有实例。
2. 安装系统依赖，下载校验过的 Node / Go，构建固定 MinIO 源码。
3. 安装锁定依赖，编译后端与前端；all 模式还构建原生沙盒。
4. all 模式：按所选 Docker 源构建、验证原版 LibreOJ rootfs。
5. 生成私有配置、权限、systemd 单元和 AppArmor 配置。
6. 初始化本实例的 MariaDB、Redis 和私有 MinIO 存储桶。
7. 启动后端，创建全权限 admin 和随机密码。
8. all 模式：注册、验证并启动本机评测；启动 Nginx 并检查状态。
9. 设置开机启动，保存完成标记，向终端输出管理员凭据。
PLAN_ZH
    else
    cat <<'PLAN'
1. Check Ubuntu, systemd/cgroup v2, available RAM/disk, ports and existing instance.
2. Install apt dependencies; download verified Node and Go; build pinned MinIO source.
3. Install locked pnpm dependencies; compile backend/frontend; native sandbox for role all.
4. For role all: build and validate original LibreOJ rootfs (NOI Linux is not used).
5. Generate private configuration and systemd units; prepare ownership and AppArmor.
6. Initialize this instance's MariaDB, Redis and private MinIO bucket.
7. Start backend; create random-password admin with all permissions.
8. For role all: register/test/start local judge. Start Nginx; check health.
9. Enable systemd startup; save completion marker; print admin credentials in terminal.
PLAN
    fi
    exit 0
fi
if [[ "$INSTALL_ROLE" == web ]]; then
    SERVICE_UNITS=(libreoj-nginx.service libreoj-backend.service libreoj-minio.service libreoj-redis.service libreoj-mariadb.service)
fi
"${SUPPORT[@]}" preflight "${SUPPORT_ARGS[@]}"
[[ "$MODE" != check ]] || exit 0
[[ "$EUID" == 0 ]] || die "Run this installer with sudo"
[[ -f "$SOURCE_ROOT/package.json" && -f "$SOURCE_ROOT/infra/sandbox-rootfs/Dockerfile" ]] || die "Run the script from the complete source tree"
[[ ! -L /run/libreoj-installer ]] || die "Unsafe installer lock directory"
install -d -m 0700 -o root -g root /run/libreoj-installer
exec 9>/run/libreoj-installer/lock
flock -n 9 || die "Another LibreOJ installer is running"

cleanup() {
    local status=$?
    trap - EXIT
    if [[ "$POLICY_CREATED" == 1 ]]; then
        rm -f /usr/sbin/policy-rc.d
    fi
    for default_unit in "${NEW_DEFAULT_UNITS[@]}"; do
        systemctl disable --now "$default_unit" >/dev/null 2>&1 || true
    done
    if [[ "$status" != 0 && "$ROLLBACK_STARTED" == 1 && "$INSTALL_SUCCESS" == 0 ]]; then
        systemctl stop libreoj.target "${SERVICE_UNITS[@]}" >/dev/null 2>&1 || true
        if ((${#MOUNT_UNITS[@]})); then
            systemctl stop "${MOUNT_UNITS[@]}" >/dev/null 2>&1 || true
        fi
        systemctl disable libreoj.target >/dev/null 2>&1 || true
    fi
    if [[ "$status" != 0 ]]; then
        say '\nInstallation stopped at: %s\nNo runtime data was deleted. Correct the issue and rerun with the same arguments.\n' "$STEP" >&2
    fi
    exit "$status"
}
trap cleanup EXIT
step() { STEP="$1"; printf '\n[LLMOJ] %s\n' "$(translate "$STEP")"; }
support() { "$PYTHON" "$PROJECT_ROOT/deploy/install-support.py" "$1" "${SUPPORT_ARGS[@]}"; }
wait_http() {
    local url=$1 attempt
    for ((attempt=0; attempt<90; attempt++)); do
        if curl --fail --silent --max-time 3 "$url" -o /dev/null; then return 0; fi
        sleep 1
    done
    die "Service readiness timeout: $url (inspect systemctl status and journalctl)"
}
wait_judge() {
    local attempt
    for ((attempt=0; attempt<60; attempt++)); do
        if "$NODE" "$PROJECT_ROOT/deploy/bootstrap-services.mjs" --root "$PROJECT_ROOT" --phase verify-judge >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    die "Judge did not connect; inspect journalctl -u libreoj-judge.service"
}

if [[ -f "$PROJECT_ROOT/config/install-complete.json" ]]; then
    step 'Verify existing installation (retain credentials and configuration)'
    NODE="$PROJECT_ROOT/runtime/node/bin/node"
    support verify-network
    systemctl start libreoj.target
    wait_http http://127.0.0.1:2002/docs-json
    wait_http "http://127.0.0.1:$PUBLIC_PORT/"
    [[ "$INSTALL_ROLE" != all ]] || wait_judge
    "$NODE" "$PROJECT_ROOT/deploy/bootstrap-admin.mjs" --root "$PROJECT_ROOT"
    INSTALL_SUCCESS=1
    say '\nSite URL: %s\n' "$PUBLIC_ORIGIN"
    "$NODE" "$PROJECT_ROOT/deploy/bootstrap-admin.mjs" --root "$PROJECT_ROOT" --show-credentials
    exit 0
fi

step 'Claim this installation directory'
if [[ "$SOURCE_ROOT" != "$PROJECT_ROOT" && -d "$PROJECT_ROOT/apps" && ! -f "$PROJECT_ROOT/config/install-state.json" ]]; then
    die "Target already contains source without installation metadata; run its installer directly or choose a new directory"
fi
"${SUPPORT[@]}" claim "${SUPPORT_ARGS[@]}"

step 'Install distribution dependencies'
export DEBIAN_FRONTEND=noninteractive
for default_unit in mariadb.service redis-server.service nginx.service; do
    if [[ -z "$(systemctl show "$default_unit" --property=FragmentPath --value 2>/dev/null || true)" ]]; then
        NEW_DEFAULT_UNITS+=("$default_unit")
    fi
done
# Fresh packages must not start a second, default database or public web server.
# Preserve any policy already provided by the server administrator.
if [[ ! -e /usr/sbin/policy-rc.d && ! -L /usr/sbin/policy-rc.d ]]; then
    printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
    chmod 0755 /usr/sbin/policy-rc.d
    POLICY_CREATED=1
fi
apt-get update
apt-get install -y --no-install-recommends --no-remove --no-upgrade ca-certificates curl xz-utils git rsync openssl \
    build-essential cmake libfmt-dev python3 python3-yaml mariadb-server mariadb-client \
    redis-server nginx util-linux pkg-config
for default_unit in "${NEW_DEFAULT_UNITS[@]}"; do systemctl disable --now "$default_unit"; done
if [[ "$POLICY_CREATED" == 1 ]]; then rm -f /usr/sbin/policy-rc.d; POLICY_CREATED=0; fi
if ! id libreoj >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$PROJECT_ROOT" --no-create-home --shell /usr/sbin/nologin libreoj
fi

step 'Prepare source and pinned runtime tools'
if [[ ! -f "$SOURCE_ROOT/apps/judge/vendor/testlib/testlib.h" ]]; then
    [[ -e "$SOURCE_ROOT/.git" ]] || die "testlib source is missing; use a full source archive or clone with submodules"
    git -c safe.directory="$SOURCE_ROOT" -C "$SOURCE_ROOT" submodule update --init --recursive
fi
if [[ "$SOURCE_ROOT" != "$PROJECT_ROOT" ]]; then
    rsync -a --exclude='.git' --exclude='node_modules' --exclude='__pycache__' \
        --exclude='/runtime/' --exclude='/data/' --exclude='/logs/' --exclude='/backups/' \
        --exclude='/release/' --exclude='/public/' --exclude='dist/' --exclude='build/' --exclude='lib/' \
        --include='/config/*.example' --exclude='/config/*' "$SOURCE_ROOT/" "$PROJECT_ROOT/"
fi
install -d -m 0755 -o root -g root "$PROJECT_ROOT" "$PROJECT_ROOT/runtime" "$PROJECT_ROOT/runtime/downloads"
install -d -m 0751 -o root -g root "$PROJECT_ROOT/config"
for directory in apps packages infra deploy; do
    chown -R root:root "$PROJECT_ROOT/$directory"
    chmod -R a+rX "$PROJECT_ROOT/$directory"
done
DOWNLOADS="$PROJECT_ROOT/runtime/downloads"
download() {
    local url=$1 sha=$2 archive=$3
    if [[ -f "$archive" ]] && printf '%s  %s\n' "$sha" "$archive" | sha256sum --check --status; then return; fi
    curl --proto '=https' --tlsv1.2 --fail --location --retry 3 --output "$archive.partial" "$url"
    printf '%s  %s\n' "$sha" "$archive.partial" | sha256sum --check --status || die "Download checksum mismatch"
    mv "$archive.partial" "$archive"
}
NODE_VERSION=24.21.0
NODE_ARCHIVE="$DOWNLOADS/node-v$NODE_VERSION-linux-x64.tar.xz"
download "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
    fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 "$NODE_ARCHIVE"
tar -xJf "$NODE_ARCHIVE" -C "$PROJECT_ROOT/runtime"
[[ ! -d "$PROJECT_ROOT/runtime/node" || -L "$PROJECT_ROOT/runtime/node" ]] || die "runtime/node must be an installer symlink"
ln -sfn "node-v$NODE_VERSION-linux-x64" "$PROJECT_ROOT/runtime/node"
NODE="$PROJECT_ROOT/runtime/node/bin/node"
export PATH="$PROJECT_ROOT/runtime/node/bin:$PROJECT_ROOT/runtime/tooling/node_modules/.bin:$PATH"
npm install --prefix "$PROJECT_ROOT/runtime/tooling" --no-audit --no-fund --ignore-scripts pnpm@11.13.0
export CMAKE_BUILD_PARALLEL_LEVEL=2
export npm_config_nodedir="$PROJECT_ROOT/runtime/node"
export NODE_OPTIONS=--max-old-space-size=2300
export pnpm_config_verify_deps_before_run=false

step 'Build pinned MinIO from source and retain its AGPL license/source'
GO_VERSION=1.26.8
GO_ARCHIVE="$DOWNLOADS/go$GO_VERSION.linux-amd64.tar.gz"
download "https://go.dev/dl/go$GO_VERSION.linux-amd64.tar.gz" \
    d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b "$GO_ARCHIVE"
install -d -m 0755 "$PROJECT_ROOT/runtime/go-$GO_VERSION"
tar -xzf "$GO_ARCHIVE" --strip-components=1 -C "$PROJECT_ROOT/runtime/go-$GO_VERSION"
MINIO_COMMIT=7aac2a2c5b7c882e68c1ce017d8256be2feea27f
MINIO_ARCHIVE="$DOWNLOADS/minio-$MINIO_COMMIT.tar.gz"
download "https://codeload.github.com/minio/minio/tar.gz/$MINIO_COMMIT" \
    71794c2df26aad0cc99e8421c58b7aa2dd55969f979b0e7d1e931042e9fabcd6 "$MINIO_ARCHIVE"
install -d -m 0755 "$PROJECT_ROOT/runtime/third-party"
tar -xzf "$MINIO_ARCHIVE" -C "$PROJECT_ROOT/runtime/third-party"
MINIO_SOURCE="$PROJECT_ROOT/runtime/third-party/minio-$MINIO_COMMIT"
if [[ ! -x "$PROJECT_ROOT/runtime/minio" || ! -f "$PROJECT_ROOT/runtime/minio.commit" || "$(cat "$PROJECT_ROOT/runtime/minio.commit")" != "$MINIO_COMMIT" ]]; then
    (cd "$MINIO_SOURCE"
     GOTOOLCHAIN=local GOMAXPROCS=2 CGO_ENABLED=0 \
     GOCACHE="$PROJECT_ROOT/runtime/go-cache" GOMODCACHE="$PROJECT_ROOT/runtime/go-modules" \
        "$PROJECT_ROOT/runtime/go-$GO_VERSION/bin/go" build -mod=readonly -buildvcs=false -trimpath -o "$PROJECT_ROOT/runtime/minio.partial" .)
    mv "$PROJECT_ROOT/runtime/minio.partial" "$PROJECT_ROOT/runtime/minio"
    printf '%s\n' "$MINIO_COMMIT" > "$PROJECT_ROOT/runtime/minio.commit"
fi
chmod 0755 "$PROJECT_ROOT/runtime/minio"

step 'Install locked workspace dependencies and build the application'
cd "$PROJECT_ROOT"
pnpm install --frozen-lockfile --store-dir "$PROJECT_ROOT/runtime/pnpm-store"
pnpm build:artifacts
if [[ "$INSTALL_ROLE" == all ]]; then
    pnpm --filter simple-sandbox build
    pnpm build:native
fi
pnpm --filter @libreoj/backend build
[[ "$INSTALL_ROLE" != all ]] || pnpm --filter @libreoj/judge build
HYHOJ_PUBLIC_DIR="$PROJECT_ROOT/public" PNPM_BINARY="$PROJECT_ROOT/runtime/tooling/node_modules/.bin/pnpm" \
    HYHOJ_QUOTE_FILE= OJ_SITE_NAME="$SITE_NAME" "$NODE" deploy/build-frontend-offline.mjs --build
chmod -R a+rX "$PROJECT_ROOT/apps" "$PROJECT_ROOT/packages"

if [[ "$INSTALL_ROLE" == all ]]; then
step 'Build and validate original LibreOJ sandbox'
ROOTFS_ID="$(bash deploy/sandbox/build.sh plan | sed -n 's/^ROOTFS_ID=//p')"
if [[ -e "$PROJECT_ROOT/runtime/sandbox-rootfs" ]]; then
    [[ "$(cat "$PROJECT_ROOT/runtime/sandbox-rootfs/etc/libreoj-rootfs-id")" == "$ROOTFS_ID" ]] || die "Existing rootfs differs from the source recipe"
    [[ "$(stat -c %u "$PROJECT_ROOT/runtime/sandbox-rootfs/")" == 0 ]] || die "Existing sandbox root must belong to root"
    printf '%s\n' "$ROOTFS_ID" > "$PROJECT_ROOT/runtime/rootfs-id"
else
    if command -v docker >/dev/null 2>&1; then
        if ! docker buildx version >/dev/null 2>&1; then
            if apt-cache show docker-buildx >/dev/null 2>&1; then apt-get install -y --no-remove --no-upgrade docker-buildx
            elif apt-cache show docker-buildx-plugin >/dev/null 2>&1; then apt-get install -y --no-remove --no-upgrade docker-buildx-plugin
            else die "Existing Docker has no buildx plugin; install its matching buildx package and retry"; fi
        fi
    else
        # Selectable package mirror; retain Docker's official signing key.
        install -d -m 0755 /etc/apt/keyrings
        curl --proto '=https' --tlsv1.2 --fail --location --retry 3 \
            https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/libreoj-docker.asc
        chmod 0644 /etc/apt/keyrings/libreoj-docker.asc
        . /etc/os-release
        cat > /etc/apt/sources.list.d/libreoj-docker.sources <<DOCKER
Types: deb
URIs: $DOCKER_SOURCE/linux/ubuntu
Suites: $VERSION_CODENAME
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/libreoj-docker.asc
DOCKER
        chmod 0644 /etc/apt/sources.list.d/libreoj-docker.sources
        apt-get update
        apt-get install -y --no-remove --no-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin
    fi
    DOCKER_CONFIG_RESULT="$("$PYTHON" deploy/docker-support.py --source "$DOCKER_SOURCE" --mirrors "$DOCKER_MIRRORS" --configure)"
    if [[ "$DOCKER_CONFIG_RESULT" == changed ]]; then
        say 'Applying registry mirrors and restarting Docker (existing containers may be affected).\n'
        systemctl restart docker.service
    else
        systemctl start docker.service
    fi
    docker info >/dev/null
    ARCHIVES="$PROJECT_ROOT/runtime/sandbox-archives"
    ARCHIVE="$ARCHIVES/rootfs-$ROOTFS_ID.tar.gz"
    if [[ ! -f "$ARCHIVE" || ! -f "$ARCHIVE.sha256" ]] || ! (cd "$ARCHIVES" && sha256sum --check --status "$ARCHIVE.sha256"); then
        BUILDX_BUILDER=default OUTPUT_DIRECTORY="$ARCHIVES" bash deploy/sandbox/build.sh build
    fi
    LIBREOJ_X32_SUPPORTED=0 unshare --net --mount --propagation private -- bash deploy/sandbox/build.sh stage "$ARCHIVE"
fi
fi

step 'Generate private configuration, permissions and systemd definitions'
export HYHOJ_ROOT="$PROJECT_ROOT" HYHOJ_PORT="$PUBLIC_PORT" HYHOJ_PUBLIC_ORIGIN="$PUBLIC_ORIGIN" NODE_BINARY="$NODE"
export OJ_LISTEN_ADDRESS="$LISTEN_ADDRESS" OJ_INSTALL_ROLE="$INSTALL_ROLE" OJ_SITE_NAME="$SITE_NAME"
"$PYTHON" deploy/configure-local.py
LIBREOJ_CONFIG_FILE="$PROJECT_ROOT/config/backend.yaml" "$NODE" -e '
try {
  const requireBackend = require("node:module").createRequire(process.argv[1]);
  requireBackend("reflect-metadata");
  const { ConfigService } = requireBackend("./dist/config/config.service.js");
  new ConfigService();
  console.log("Backend configuration validated; credentials withheld.");
} catch {
  console.error("Backend configuration validation failed; review config/backend.yaml (credentials withheld).");
  process.exit(1);
}' "$PROJECT_ROOT/apps/backend/package.json"
support permissions
if [[ "$INSTALL_ROLE" == all ]]; then
    [[ "$JUDGE_SLOTS" == 0 ]] || export HYHOJ_JUDGE_SLOTS="$JUDGE_SLOTS"
    "$PYTHON" deploy/configure-judge.py
fi
support apparmor
chmod -R a+rX "$PROJECT_ROOT/node_modules" "$PROJECT_ROOT/runtime/pnpm-store" \
    "$PROJECT_ROOT/runtime/node-v$NODE_VERSION-linux-x64" "$PROJECT_ROOT/runtime/tooling" "$PROJECT_ROOT/public"
chown -R root:root "$PROJECT_ROOT/public"
# Keep rootfs ownership (including uid 999) intact; never recursively chown runtime/.
support verify-network
shopt -s nullglob
UNIT_FILES=("$PROJECT_ROOT"/deploy/systemd/*.service "$PROJECT_ROOT"/deploy/systemd/*.mount "$PROJECT_ROOT"/deploy/systemd/libreoj.target)
for unit in "$PROJECT_ROOT"/deploy/systemd/*.mount; do MOUNT_UNITS+=("$(basename "$unit")"); done
systemd-analyze verify "${UNIT_FILES[@]}"
for unit in "${UNIT_FILES[@]}"; do install -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"; done
systemctl daemon-reload

step 'Initialize this instance database, Redis and object storage'
ROLLBACK_STARTED=1
if [[ ! -d "$PROJECT_ROOT/data/mariadb/mysql" ]]; then
    mariadb-install-db --no-defaults --user=mysql --datadir="$PROJECT_ROOT/data/mariadb" \
        --auth-root-authentication-method=socket --skip-test-db >/dev/null
fi
systemctl start libreoj-mariadb.service libreoj-redis.service libreoj-minio.service
DB_READY=0
for ((attempt=0; attempt<90; attempt++)); do
    if mariadb --protocol=socket --socket="$PROJECT_ROOT/data/mariadb/mysql.sock" --user=root --execute='SELECT 1' >/dev/null 2>&1; then DB_READY=1; break; fi
    sleep 1
done
[[ "$DB_READY" == 1 ]] || die "Project MariaDB readiness timed out"
support database
wait_http http://127.0.0.1:19000/minio/health/ready
"$NODE" deploy/bootstrap-services.mjs --root "$PROJECT_ROOT" --phase storage

step 'Start backend and create admin with all permissions'
systemctl start libreoj-backend.service
wait_http http://127.0.0.1:2002/docs-json
"$NODE" deploy/bootstrap-admin.mjs --root "$PROJECT_ROOT"
if [[ "$INSTALL_ROLE" == all ]]; then
"$NODE" deploy/bootstrap-services.mjs --root "$PROJECT_ROOT" --phase judge
step 'Verify real sandbox execution in a delegated cgroup'
systemctl start "${MOUNT_UNITS[@]}"
systemd-run --unit=libreoj-install-sandbox-check --wait --pipe --collect \
    --property='Delegate=cpu memory pids' --property=DelegateSubgroup=supervisor \
    --property=LimitCORE=0 --property=RuntimeMaxSec=120 --property=TimeoutStopSec=15 \
    --property="WorkingDirectory=$PROJECT_ROOT/apps/judge" \
    "$NODE" "$PROJECT_ROOT/deploy/sandbox/verify-installed.mjs" --root "$PROJECT_ROOT"
fi

step 'Start judge and web server, check health, enable automatic startup'
if [[ "$INSTALL_ROLE" == all ]]; then
    systemctl start libreoj-judge.service
    wait_judge
fi
systemctl start libreoj-nginx.service
wait_http "http://127.0.0.1:$PUBLIC_PORT/"
wait_http "http://127.0.0.1:$PUBLIC_PORT/api/auth/getSessionInfo"
systemctl enable "${SERVICE_UNITS[@]}" "${MOUNT_UNITS[@]}" libreoj.target
systemctl start libreoj.target
support finish
INSTALL_SUCCESS=1
say '\nInstallation complete. Site URL: %s\n' "$PUBLIC_ORIGIN"
"$NODE" deploy/bootstrap-admin.mjs --root "$PROJECT_ROOT" --show-credentials
say 'Initial credentials: %s/config/admin-credentials.json (root only)\n' "$PROJECT_ROOT"
say 'Nginx listener: %s:%s. Internal services remain on loopback.\n' "$LISTEN_ADDRESS" "$PUBLIC_PORT"
if [[ "$LISTEN_ADDRESS" == 0.0.0.0 ]]; then
    say 'Allow the selected website port in your firewall/cloud security group. TLS is configured separately.\n'
else
    say 'Use an SSH tunnel or an existing reverse proxy for remote access.\n'
fi
[[ "$INSTALL_ROLE" != web ]] || say 'Web-only deployment: add remote judges using wiki/Distributed-Judging.md. Local AI sandbox actions are unavailable.\n'
