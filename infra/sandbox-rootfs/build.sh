#!/bin/bash

set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIRECTORY/../.." && pwd)"
OUTPUT_DIRECTORY="${OUTPUT_DIRECTORY:-$SCRIPT_DIRECTORY/dist}"

# The rootfs of this machine's architecture, unless ROOTFS_ARCHITECTURE names the other one (Docker then needs QEMU
# user emulation). Each has its own recipe, and so its own ID: amd64 (x86-64) the files here, arm64 (AArch64) those in
# arm64/ with the shared wrappers.
case "${ROOTFS_ARCHITECTURE:-$(uname -m)}" in
    amd64|x86_64) ROOTFS_ARCHITECTURE=amd64; RECIPE_DIRECTORY=infra/sandbox-rootfs ;;
    arm64|aarch64) ROOTFS_ARCHITECTURE=arm64; RECIPE_DIRECTORY=infra/sandbox-rootfs/arm64 ;;
    *) echo "There is no rootfs recipe for ${ROOTFS_ARCHITECTURE:-$(uname -m)} (amd64 and arm64 have one)" >&2; exit 1 ;;
esac

mapfile -t RECIPE_FILES <<EOF
apps/judge/src/languages/compile-java.sh
apps/judge/src/languages/compile-python.sh
$RECIPE_DIRECTORY/Dockerfile
infra/sandbox-rootfs/csc
infra/sandbox-rootfs/fsharpc
infra/sandbox-rootfs/mono
$RECIPE_DIRECTORY/smoke-test.sh
EOF

ROOTFS_ID="$({
    for file in "${RECIPE_FILES[@]}"; do
        printf '%s  %s\n' "$(git -C "$REPOSITORY_ROOT" hash-object "$file")" "$file"
    done
} | sha256sum | cut -d' ' -f1)"
ARCHIVE="rootfs-$ROOTFS_ID.tar.gz"
mkdir -p "$OUTPUT_DIRECTORY"
TEMPORARY_DIRECTORY="$(mktemp -d "$OUTPUT_DIRECTORY/.rootfs-build-XXXXXXXX")"
trap 'rm -rf "$TEMPORARY_DIRECTORY"' EXIT

docker buildx build \
    --platform "linux/$ROOTFS_ARCHITECTURE" \
    --build-arg "ROOTFS_ID=$ROOTFS_ID" \
    --file "$REPOSITORY_ROOT/$RECIPE_DIRECTORY/Dockerfile" \
    --output "type=tar,dest=$TEMPORARY_DIRECTORY/rootfs.tar" \
    "$REPOSITORY_ROOT"

# Archiving a local rootfs should not spend minutes on maximum compression.
# dd reports input bytes/rate on stderr; stdout remains machine-readable below.
printf 'Compressing rootfs archive (gzip level 1): %s bytes\n' "$(stat -c %s "$TEMPORARY_DIRECTORY/rootfs.tar")" >&2
dd if="$TEMPORARY_DIRECTORY/rootfs.tar" bs=4M status=progress | gzip -n -1 > "$TEMPORARY_DIRECTORY/rootfs.tar.gz"
printf 'Rootfs compression complete; writing archive and SHA-256 checksum.\n' >&2
mv "$TEMPORARY_DIRECTORY/rootfs.tar.gz" "$OUTPUT_DIRECTORY/$ARCHIVE"

(
    cd "$OUTPUT_DIRECTORY"
    sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
)

printf 'ROOTFS_ID=%s\n' "$ROOTFS_ID"
printf 'ARCHITECTURE=%s\n' "$ROOTFS_ARCHITECTURE"
printf 'ARCHIVE=%s\n' "$OUTPUT_DIRECTORY/$ARCHIVE"
