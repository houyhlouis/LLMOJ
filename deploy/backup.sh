#!/bin/bash
set -euo pipefail
libreoj_backup_root="${HYHOJ_ROOT:-/opt/LLMOJ}"
while (($#)); do
    case "$1" in
        --prefix)
            (($# >= 2)) || { printf 'Missing value for --prefix\n' >&2; exit 1; }
            libreoj_backup_root=$2
            shift 2 ;;
        --help|-h)
            printf 'Usage: sudo bash deploy/backup.sh [--prefix /opt/LLMOJ]\nHYHOJ_ROOT supplies the default installation directory.\n'
            exit 0 ;;
        *) printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
    esac
done
[[ "$libreoj_backup_root" == /* ]] || { printf 'Use an absolute installation directory\n' >&2; exit 1; }
if [ "$EUID" -ne 0 ]; then exec sudo bash "$0" --prefix "$libreoj_backup_root"; fi
umask 077
libreoj_backup_root="$(realpath -e "$libreoj_backup_root")"
for libreoj_backup_directory in config data deploy; do
    [[ -d "$libreoj_backup_root/$libreoj_backup_directory" ]] || { printf 'Missing instance directory: %s\n' "$libreoj_backup_root/$libreoj_backup_directory" >&2; exit 1; }
done
install -d -m 0700 "$libreoj_backup_root/backups"
libreoj_backup_file="$libreoj_backup_root/backups/libreoj-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
trap 'systemctl start libreoj.target' EXIT
systemctl stop libreoj.target
# A target stop can finish before its PartOf services have stopped. Wait for all.
systemctl stop libreoj-nginx.service libreoj-judge.service libreoj-backend.service libreoj-minio.service libreoj-redis.service libreoj-mariadb.service
tar --numeric-owner -czf "$libreoj_backup_file.partial" \
 --exclude='data/judge' --exclude='data/tmp' --exclude='data/nginx' --exclude='data/ai-generated' \
 -C "$libreoj_backup_root" config data deploy
mv "$libreoj_backup_file.partial" "$libreoj_backup_file"
sha256sum "$libreoj_backup_file" > "$libreoj_backup_file.sha256"
printf 'Backup: %s\n' "$libreoj_backup_file"
