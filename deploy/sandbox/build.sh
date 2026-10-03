#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIRECTORY/../.." && pwd)"
RUNTIME_DIRECTORY="${RUNTIME_DIRECTORY:-$REPOSITORY_ROOT/runtime}"
OUTPUT_DIRECTORY="${OUTPUT_DIRECTORY:-$RUNTIME_DIRECTORY/sandbox-archives}"

recipe_id() {
    local file
    {
        for file in \
            apps/judge/src/languages/compile-java.sh \
            apps/judge/src/languages/compile-python.sh \
            infra/sandbox-rootfs/Dockerfile \
            infra/sandbox-rootfs/csc \
            infra/sandbox-rootfs/fsharpc \
            infra/sandbox-rootfs/mono \
            infra/sandbox-rootfs/smoke-test.sh; do
            printf '%s  %s\n' "$(git -C "$REPOSITORY_ROOT" hash-object "$file")" "$file"
        done
    } | sha256sum | cut -d' ' -f1
}

case "${1:-plan}" in
    plan)
        printf 'ROOTFS_ID=%s\n' "$(recipe_id)"
        printf 'RECIPE=%s\n' "$REPOSITORY_ROOT/infra/sandbox-rootfs/Dockerfile"
        printf 'OUTPUT_DIRECTORY=%s\n' "$OUTPUT_DIRECTORY"
        printf 'ROOTFS=%s\n' "$RUNTIME_DIRECTORY/sandbox-rootfs"
        ;;
    build)
        command -v docker >/dev/null
        # Send only recipe inputs to Docker, never this instance's credentials,
        # runtime downloads, database or node_modules as build context.
        mkdir -p "$RUNTIME_DIRECTORY"
        context="$(mktemp -d "$RUNTIME_DIRECTORY/.upstream-rootfs-context-XXXXXXXX")"
        trap 'rm -rf "$context"' EXIT
        for file in \
            apps/judge/src/languages/compile-java.sh \
            apps/judge/src/languages/compile-python.sh \
            infra/sandbox-rootfs/Dockerfile \
            infra/sandbox-rootfs/build.sh \
            infra/sandbox-rootfs/csc \
            infra/sandbox-rootfs/fsharpc \
            infra/sandbox-rootfs/mono \
            infra/sandbox-rootfs/smoke-test.sh; do
            mkdir -p "$context/$(dirname "$file")"
            cp --preserve=mode "$REPOSITORY_ROOT/$file" "$context/$file"
        done
        OUTPUT_DIRECTORY="$OUTPUT_DIRECTORY" bash "$context/infra/sandbox-rootfs/build.sh"
        ;;
    stage)
        if [[ "$EUID" -ne 0 ]]; then
            echo 'Run the stage command as root.' >&2
            exit 1
        fi
        archive="${2:?Pass an absolute rootfs archive path}"
        if [[ "$archive" != /* ]] || [[ "$RUNTIME_DIRECTORY" != /* ]]; then
            echo 'Archive and RUNTIME_DIRECTORY must be absolute paths.' >&2
            exit 1
        fi
        archive="$(realpath "$archive")"
        basename="$(basename "$archive")"
        if [[ ! "$basename" =~ ^rootfs-([0-9a-f]{64})\.tar\.gz$ ]]; then
            echo 'Invalid rootfs archive filename.' >&2
            exit 1
        fi
        rootfs_id="${BASH_REMATCH[1]}"
        if [[ "$rootfs_id" != "$(recipe_id)" ]]; then
            echo 'Archive rootfs ID does not match the current upstream recipe.' >&2
            exit 1
        fi
        if [[ -e "$RUNTIME_DIRECTORY/sandbox-rootfs" || -L "$RUNTIME_DIRECTORY/sandbox-rootfs" ]]; then
            echo 'sandbox-rootfs already exists; refusing to replace it.' >&2
            exit 1
        fi
        x32_supported="${LIBREOJ_X32_SUPPORTED:-1}"
        case "$x32_supported" in
            1) staging_script="$REPOSITORY_ROOT/infra/sandbox-rootfs/stage.sh" ;;
            0) staging_script="$SCRIPT_DIRECTORY/stage-host.sh" ;;
            *) echo "LIBREOJ_X32_SUPPORTED must be 0 or 1" >&2; exit 1 ;;
        esac
        mkdir -p "$RUNTIME_DIRECTORY"
        ARCHIVE="$archive" CHECKSUM="$archive.sha256" DESTINATION_PARENT="$RUNTIME_DIRECTORY" \
            LIBREOJ_X32_SUPPORTED="$x32_supported" bash "$staging_script"
        ln -s "rootfs-$rootfs_id" "$RUNTIME_DIRECTORY/sandbox-rootfs"
        printf '%s\n' "$rootfs_id" > "$RUNTIME_DIRECTORY/rootfs-id"
        chmod 0644 "$RUNTIME_DIRECTORY/rootfs-id"
        printf 'ROOTFS=%s\n' "$RUNTIME_DIRECTORY/sandbox-rootfs"
        ;;
    *)
        echo 'Usage: build.sh [plan | build | stage /absolute/rootfs-ID.tar.gz]' >&2
        exit 2
        ;;
esac
