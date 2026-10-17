#!/bin/bash
# Checks the problem and user counts derived from submissions; --apply corrects the ones that differ.
set -euo pipefail
PREFIX=/opt/LLMOJ
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:?--prefix needs a directory}"; shift 2 ;;
    --apply) ARGS+=(--apply); shift ;;
    *) echo "Usage: $0 [--prefix DIR] [--apply]" >&2; exit 2 ;;
  esac
done
if [[ $EUID -ne 0 ]]; then
  echo "Run as root: it reads the private backend configuration." >&2
  exit 1
fi
exec "$PREFIX/runtime/node/bin/node" "$PREFIX/deploy/rebuild-statistics.mjs" \
  --root "$PREFIX" --config "$PREFIX/config/backend.yaml" "${ARGS[@]}"
