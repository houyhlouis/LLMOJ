#!/bin/bash
# 检查 backup.sh 生成的备份能否恢复，不影响正在运行的网站；见
# wiki/Operations-Configuration.zh-CN.md#检查备份
set -euo pipefail
OJ_VERIFY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# 以中文输出提示；verify-backup.sh 以英文输出
export LLMOJ_LANG=zh-CN
exec python3 "$OJ_VERIFY_SCRIPT_DIR/verify-backup.py" "$@"
