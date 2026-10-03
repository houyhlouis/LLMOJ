#!/bin/bash
set -euo pipefail
systemctl --no-pager --plain status libreoj.target libreoj-nginx libreoj-backend libreoj-judge libreoj-mariadb libreoj-redis libreoj-minio
