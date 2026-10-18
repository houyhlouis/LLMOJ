#!/bin/bash
# 只读检查本安装的健康状况；见 wiki/Operations-Configuration.zh-CN.md#运行-doctor
set -euo pipefail
OJ_DOCTOR_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# 以中文输出提示；doctor.sh 以英文输出
export LLMOJ_LANG=zh-CN
exec python3 "$OJ_DOCTOR_SCRIPT_DIR/doctor.py" "$@"
