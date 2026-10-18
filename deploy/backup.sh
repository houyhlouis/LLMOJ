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
# Share the installer/upgrade/resize maintenance lock: never stop or copy an instance they are changing.
[[ ! -L /run/libreoj-installer ]] || { printf 'Unsafe maintenance lock directory\n' >&2; exit 1; }
install -d -m 0700 -o root -g root /run/libreoj-installer
exec 9>/run/libreoj-installer/lock
flock -n 9 || { printf 'Another installation, upgrade or maintenance task is running\n' >&2; exit 1; }
install -d -m 0700 "$libreoj_backup_root/backups"
libreoj_backup_file="$libreoj_backup_root/backups/libreoj-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
libreoj_backup_installed() { [[ -n "$(systemctl show "$1" --property=FragmentPath --value 2>/dev/null)" ]]; }
# Only units installed for this role (a web-only installation has no judge), in stop order.
libreoj_backup_units=()
for libreoj_backup_unit in libreoj-nginx.service libreoj-judge.service libreoj-backend.service libreoj-minio.service libreoj-redis.service libreoj-mariadb.service; do
    if libreoj_backup_installed "$libreoj_backup_unit"; then libreoj_backup_units+=("$libreoj_backup_unit"); fi
done
((${#libreoj_backup_units[@]})) || { printf 'No LLMOJ services are installed\n' >&2; exit 1; }
# Afterwards, start only what was running before: a stopped instance stays stopped.
libreoj_backup_target=0
if libreoj_backup_installed libreoj.target && systemctl is-active --quiet libreoj.target; then libreoj_backup_target=1; fi
libreoj_backup_active=()
for libreoj_backup_unit in "${libreoj_backup_units[@]}"; do
    if systemctl is-active --quiet "$libreoj_backup_unit"; then libreoj_backup_active+=("$libreoj_backup_unit"); fi
done
libreoj_backup_restore() {
    if ((libreoj_backup_target)); then systemctl start libreoj.target; fi
    if ((${#libreoj_backup_active[@]})); then systemctl start "${libreoj_backup_active[@]}"; fi
}
trap libreoj_backup_restore EXIT
if ((libreoj_backup_target)); then systemctl stop libreoj.target; fi
# A target stop can finish before its PartOf services have stopped. Wait for all.
systemctl stop "${libreoj_backup_units[@]}"
tar --numeric-owner -czf "$libreoj_backup_file.partial" \
 --exclude='data/judge' --exclude='data/tmp' --exclude='data/nginx' --exclude='data/ai-generated' \
 -C "$libreoj_backup_root" config data deploy
mv "$libreoj_backup_file.partial" "$libreoj_backup_file"
sha256sum "$libreoj_backup_file" > "$libreoj_backup_file.sha256"
printf 'Backup: %s\n' "$libreoj_backup_file"
printf 'To check that it can be restored: sudo bash %s/deploy/verify-backup.sh %s\n' "$libreoj_backup_root" "$libreoj_backup_file"
