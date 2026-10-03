#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# 本地源码安装入口；GitHub 一键下载请使用根目录 install.zh-CN.sh。
set -Eeuo pipefail
export LLMOJ_INSTALL_LANG=zh-CN
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/install.sh" "$@"
