#!/bin/bash
set -euo pipefail
OJ_RESIZE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Messages in English; resize-judge.zh-CN.sh prints them in Chinese
export LLMOJ_LANG=en
exec python3 "$OJ_RESIZE_SCRIPT_DIR/resize-judge.py" "$@"
