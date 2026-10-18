#!/bin/bash
# Read-only health report of this installation; see wiki/Operations-Configuration.md#doctor
set -euo pipefail
OJ_DOCTOR_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Messages in English; doctor.zh-CN.sh prints them in Chinese
export LLMOJ_LANG=en
exec python3 "$OJ_DOCTOR_SCRIPT_DIR/doctor.py" "$@"
