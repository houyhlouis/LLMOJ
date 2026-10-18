#!/bin/bash
# Checks that a backup made by backup.sh can be restored, without touching the running site; see
# wiki/Operations-Configuration.md#verifying-a-backup
set -euo pipefail
OJ_VERIFY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Messages in English; verify-backup.zh-CN.sh prints them in Chinese
export LLMOJ_LANG=en
exec python3 "$OJ_VERIFY_SCRIPT_DIR/verify-backup.py" "$@"
