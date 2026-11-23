#!/usr/bin/env bash
# Build the installer binary in a private directory; only the executable goes in the Actions cache.
set -euo pipefail
die() { echo "$*" >&2; exit 1; }
source "$(dirname "$0")/../minio-source.sh"
target=${1:?supply the CI MinIO binary destination}
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/var/tmp}}/llmoj-minio-build.XXXXXXXX")
staged=
cleanup() {
    local status=$?
    set +e
    if [[ -n "$staged" ]]; then
        rm -f -- "$staged" || echo "Could not remove staged MinIO: $staged" >&2
    fi
    rm -rf -- "$scratch" || echo "Could not remove MinIO build directory: $scratch" >&2
    exit "$status"
}
trap cleanup EXIT
GOFLAGS="${GOFLAGS:+$GOFLAGS }-modcacherw" build_minio "$scratch" "$(dpkg --print-architecture)"
# Publish by rename on the destination filesystem so a failed copy preserves the previous executable.
mkdir -p -- "$(dirname -- "$target")"
staged=$(mktemp -- "$target.tmp.XXXXXXXX")
install -m 0755 -- "$scratch/minio" "$staged"
mv -fT -- "$staged" "$target"
staged=
