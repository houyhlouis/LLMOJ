#!/bin/bash
set -euo pipefail
if [ "$EUID" -ne 0 ]; then exec sudo "$0" "$@"; fi
umask 077
install -d -m 0700 /opt/LibreOJ/backups
libreoj_backup_file="/opt/LibreOJ/backups/libreoj-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
trap 'systemctl start libreoj.target' EXIT
systemctl stop libreoj.target
# A target stop can finish before its PartOf services have stopped. Wait for all.
systemctl stop libreoj-nginx.service libreoj-judge.service libreoj-backend.service libreoj-minio.service libreoj-redis.service libreoj-mariadb.service
tar --numeric-owner -czf "$libreoj_backup_file.partial" \
 --exclude='data/judge' --exclude='data/tmp' --exclude='data/nginx' --exclude='data/ai-generated' \
 -C /opt/LibreOJ config data deploy
mv "$libreoj_backup_file.partial" "$libreoj_backup_file"
sha256sum "$libreoj_backup_file" > "$libreoj_backup_file.sha256"
printf 'Backup: %s\n' "$libreoj_backup_file"
