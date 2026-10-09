#!/bin/bash
set -euo pipefail
OJ_RESIZE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "$OJ_RESIZE_SCRIPT_DIR/resize-judge.py" "$@"
