#!/bin/bash
set -euo pipefail
OJ_RESIZE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# 以中文输出提示；resize-judge.sh 以英文输出
export LLMOJ_LANG=zh-CN
exec python3 "$OJ_RESIZE_SCRIPT_DIR/resize-judge.py" "$@"
