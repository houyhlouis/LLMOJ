#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Standalone public-GitHub entry point. Download this file, then run it with sudo.
set -Eeuo pipefail
umask 0077
export LLMOJ_INSTALL_LANG=en

REPOSITORY=
REF=main
INSTALL_ARGUMENTS=()
READ_ONLY=0

translate() {
    local message=$1
    if [[ "$LLMOJ_INSTALL_LANG" != zh-CN ]]; then printf '%s' "$message"; return; fi
    case "$message" in
        'Specify a public repository with --repository OWNER/REPO') message='请使用 --repository 用户名/仓库名 指定公开仓库' ;;
        'Invalid GitHub branch, tag or commit') message='GitHub 分支、标签或提交无效' ;;
        'Run the downloaded script with sudo') message='请使用 sudo 运行下载的脚本' ;;
        'Install curl and python3 before --check/--plan') message='使用 --check/--plan 前请安装 curl 与 python3' ;;
        'An Ubuntu server with apt-get is required') message='需要提供 apt-get 的 Ubuntu 服务器' ;;
        'Resolving public repository %s at %s...\n') message='正在解析公开仓库 %s 的 %s...\n' ;;
        'Downloading source commit %s...\n') message='正在下载源码提交 %s...\n' ;;
        'Cannot resolve this public repository/ref. Check its visibility, network and GitHub API rate limit.') message='无法解析公开仓库/版本；请检查可见性、网络和 GitHub API 限额' ;;
        'Missing value for '*) message="缺少参数值：${message#Missing value for }" ;;
    esac
    printf '%s' "$message"
}
say() { local format; format="$(translate "$1")"; shift; printf "$format" "$@"; }
usage() {
    if [[ "$LLMOJ_INSTALL_LANG" == zh-CN ]]; then
        cat <<'USAGE_ZH'
用法：sudo bash install.zh-CN.sh --repository 用户名/仓库名 [--ref 标签或提交] [安装选项]
从公开 GitHub 仓库下载固定提交源码，再运行同一套安装器（中文提示）。
默认分支 main；无需 GitHub 登录、Token 或预装 Docker。
安装选项：--port、--listen、--public-url、--prefix、--site-name、--role all|web、
--docker-source、--docker-mirrors、--judge-slots、--yes、--interactive、--check、--plan。
Docker 软件包源默认 https://download.docker.com；镜像加速源默认留空，保留 Docker 默认。
--check/--plan 仅下载临时源码，不安装软件或启动服务。
USAGE_ZH
        return
    fi
    cat <<'USAGE'
Usage: sudo bash install.sh --repository OWNER/REPO [--ref TAG_OR_COMMIT] [installer options]
Downloads a public GitHub source snapshot and runs deploy/install.sh from that snapshot.
Default ref: main. No GitHub login, token or preinstalled Docker is required.
Installer options include --port, --listen, --public-url, --prefix, --site-name,
--docker-source (default https://download.docker.com), --docker-mirrors (optional),
--role all|web, --judge-slots, --yes, --interactive, --check and --plan.
--check/--plan download a temporary snapshot but do not install software or services.
USAGE
}
die() { printf '%s\n' "$(translate "$*")" >&2; exit 1; }
while (($#)); do
    case "$1" in
        --repository|--ref)
            (($# >= 2)) && [[ "$2" != --* ]] || die "Missing value for $1"
            case "$1" in --repository) REPOSITORY="$2" ;; --ref) REF="$2" ;; esac
            shift 2 ;;
        --help|-h) usage; exit 0 ;;
        --check|--plan) READ_ONLY=1; INSTALL_ARGUMENTS+=("$1"); shift ;;
        *) INSTALL_ARGUMENTS+=("$1"); shift ;;
    esac
done
[[ "$REPOSITORY" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die 'Specify a public repository with --repository OWNER/REPO'
[[ -n "$REF" && ${#REF} -le 200 && "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9_./-]*$ && "$REF" != *..* ]] || die 'Invalid GitHub branch, tag or commit'
if [[ "$READ_ONLY" == 0 ]]; then
    [[ "$EUID" == 0 ]] || die 'Run the downloaded script with sudo'
fi
for command in curl python3; do
    if ! command -v "$command" >/dev/null; then
        [[ "$READ_ONLY" == 0 ]] || die 'Install curl and python3 before --check/--plan'
        command -v apt-get >/dev/null || die 'An Ubuntu server with apt-get is required'
        apt-get update
        apt-get install -y --no-install-recommends --no-remove --no-upgrade ca-certificates curl python3
        break
    fi
done
DOWNLOAD_DIRECTORY="$(mktemp -d /var/tmp/libreoj-source-XXXXXXXX)"
trap 'rm -rf "$DOWNLOAD_DIRECTORY"' EXIT
ENCODED_REF="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$REF")"
API_URL="https://api.github.com/repos/$REPOSITORY/commits/$ENCODED_REF"
say 'Resolving public repository %s at %s...\n' "$REPOSITORY" "$REF"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 \
    -H 'Accept: application/vnd.github+json' -o "$DOWNLOAD_DIRECTORY/commit.json" "$API_URL" || \
    die 'Cannot resolve this public repository/ref. Check its visibility, network and GitHub API rate limit.'
SOURCE_COMMIT="$(python3 - "$DOWNLOAD_DIRECTORY/commit.json" <<'PY'
import json, re, sys
try:
    sha = json.load(open(sys.argv[1]))['sha']
    if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError()
except Exception:
    raise SystemExit('GitHub did not return a valid commit; installation stopped')
print(sha)
PY
)"
say 'Downloading source commit %s...\n' "$SOURCE_COMMIT"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 \
    -o "$DOWNLOAD_DIRECTORY/source.tar.gz" "https://codeload.github.com/$REPOSITORY/tar.gz/$SOURCE_COMMIT"
SOURCE_DIRECTORY="$(python3 - "$DOWNLOAD_DIRECTORY" <<'PY'
import tarfile, sys
from pathlib import Path, PurePosixPath
destination = Path(sys.argv[1])
with tarfile.open(destination / 'source.tar.gz', 'r:gz') as package:
    members = package.getmembers()
    if not members or len(members) > 20000 or sum(m.size for m in members) > 256 * 1024**2:
        raise SystemExit('Source archive is empty or unexpectedly large')
    roots = set()
    names = set()
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or member.name in names:
            raise SystemExit('Invalid source archive path')
        if not (member.isfile() or member.isdir()):
            raise SystemExit('Source archive contains a link or special file')
        roots.add(path.parts[0])
        names.add(member.name)
    if len(roots) != 1:
        raise SystemExit('Expected one source directory')
    package.extractall(destination, filter='data')
source = destination / next(iter(roots))
for required in ('deploy/install.sh', 'package.json', 'LICENSE', 'infra/sandbox-rootfs/Dockerfile'):
    if not (source / required).is_file():
        raise SystemExit('This repository does not contain the complete installation source')
print(source)
PY
)"
export OJ_SOURCE_REPOSITORY="$REPOSITORY" OJ_SOURCE_COMMIT="$SOURCE_COMMIT"
bash "$SOURCE_DIRECTORY/deploy/install.sh" "${INSTALL_ARGUMENTS[@]}"
