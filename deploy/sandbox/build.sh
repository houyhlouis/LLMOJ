#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIRECTORY/../.." && pwd)"
RUNTIME_DIRECTORY="${RUNTIME_DIRECTORY:-$REPOSITORY_ROOT/runtime}"
OUTPUT_DIRECTORY="${OUTPUT_DIRECTORY:-$RUNTIME_DIRECTORY/sandbox-archives}"

case "$(uname -m)" in
    x86_64) HOST_ARCHITECTURE=amd64 ;;
    aarch64) HOST_ARCHITECTURE=arm64 ;;
    *) HOST_ARCHITECTURE="$(uname -m)" ;;
esac
# This machine's architecture, unless ROOTFS_ARCHITECTURE names one (to plan or build the other's rootfs). amd64 and
# arm64 each have a recipe of their own (infra/sandbox-rootfs/build.sh), and so their own rootfs ID.
case "${ROOTFS_ARCHITECTURE:-$HOST_ARCHITECTURE}" in
    amd64|x86_64) ROOTFS_ARCHITECTURE=amd64; RECIPE_DIRECTORY=infra/sandbox-rootfs ;;
    arm64|aarch64) ROOTFS_ARCHITECTURE=arm64; RECIPE_DIRECTORY=infra/sandbox-rootfs/arm64 ;;
    *) echo "There is no sandbox rootfs for ${ROOTFS_ARCHITECTURE:-$HOST_ARCHITECTURE}; LLMOJ judges on amd64 and arm64" >&2; exit 1 ;;
esac

# The files the rootfs ID covers, in order; the same list as infra/sandbox-rootfs/build.sh
recipe_files() {
    printf '%s\n' \
        apps/judge/src/languages/compile-java.sh \
        apps/judge/src/languages/compile-python.sh \
        "$RECIPE_DIRECTORY/Dockerfile" \
        infra/sandbox-rootfs/csc \
        infra/sandbox-rootfs/fsharpc \
        infra/sandbox-rootfs/mono \
        "$RECIPE_DIRECTORY/smoke-test.sh"
}

recipe_id() {
    local file
    {
        while read -r file; do
            printf '%s  %s\n' "$(git -C "$REPOSITORY_ROOT" hash-object "$file")" "$file"
        done < <(recipe_files)
    } | sha256sum | cut -d' ' -f1
}

case "${1:-plan}" in
    plan)
        printf 'ROOTFS_ID=%s\n' "$(recipe_id)"
        printf 'ARCHITECTURE=%s\n' "$ROOTFS_ARCHITECTURE"
        printf 'RECIPE=%s\n' "$REPOSITORY_ROOT/$RECIPE_DIRECTORY/Dockerfile"
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
        while read -r file; do
            mkdir -p "$context/$(dirname "$file")"
            cp --preserve=mode "$REPOSITORY_ROOT/$file" "$context/$file"
        done < <(recipe_files; echo infra/sandbox-rootfs/build.sh)
        OUTPUT_DIRECTORY="$OUTPUT_DIRECTORY" ROOTFS_ARCHITECTURE="$ROOTFS_ARCHITECTURE" \
            bash "$context/infra/sandbox-rootfs/build.sh"
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
        if [[ "$ROOTFS_ARCHITECTURE" != "$HOST_ARCHITECTURE" ]]; then
            echo "This machine can't run the $ROOTFS_ARCHITECTURE rootfs's checks; stage it on an $ROOTFS_ARCHITECTURE machine." >&2
            exit 1
        fi
        # x32 is an x86-64 ABI: the arm64 rootfs is checked with its own smoke test, through the host profile
        [[ "$ROOTFS_ARCHITECTURE" == amd64 ]] || { x32_supported=0; staging_script="$SCRIPT_DIRECTORY/stage-host.sh"; }
        mkdir -p "$RUNTIME_DIRECTORY"
        ARCHIVE="$archive" CHECKSUM="$archive.sha256" DESTINATION_PARENT="$RUNTIME_DIRECTORY" \
            LIBREOJ_X32_SUPPORTED="$x32_supported" ROOTFS_ARCHITECTURE="$ROOTFS_ARCHITECTURE" bash "$staging_script"
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
