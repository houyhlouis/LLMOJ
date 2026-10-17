#!/bin/bash
# Checks this judge machine's sandbox and every language through the judge's own code: each language compiles and
# runs a small program, and the syscall filter is probed (apps/judge/self-test.mjs). It uses its own directories and
# never the judge's key, so it can run while the judge runs; it competes with judging for CPU for a few seconds.
set -euo pipefail
PREFIX=/opt/LLMOJ
ONLY=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="${2:?--prefix needs a directory}"; shift 2 ;;
    --only) ONLY=(--only "${2:?--only needs languages, e.g. cpp,java}"); shift 2 ;;
    *) echo "Usage: $0 [--prefix DIR] [--only cpp,java,...]" >&2; exit 2 ;;
  esac
done
if [[ $EUID -ne 0 ]]; then
  echo "Run as root: the sandbox needs it, and it reads the private judge configuration." >&2
  exit 1
fi
exec systemd-run --unit=libreoj-judge-self-test --wait --pipe --collect --quiet \
  --property="Delegate=cpu memory pids" --property=DelegateSubgroup=supervisor \
  --property=LimitCORE=0 --property=RuntimeMaxSec=900 --property=TimeoutStopSec=15 \
  --property=WorkingDirectory="$PREFIX/apps/judge" --setenv=UV_THREADPOOL_SIZE=16 \
  --setenv=PATH="$PREFIX/runtime/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$PREFIX/runtime/node/bin/node" -r @swc-node/register self-test.mjs --config "$PREFIX/config/judge.yaml" "${ONLY[@]}"
