#!/bin/bash
set -euo pipefail
libreoj_backup_root="${HYHOJ_ROOT:-/opt/LLMOJ}"
libreoj_backup_args=("$@")
libreoj_backup_encrypt_to=""
libreoj_backup_copy_to=""
libreoj_backup_keep=0
libreoj_backup_usage='Usage: sudo bash deploy/backup.sh [--prefix /opt/LLMOJ] [--encrypt-to KEY.asc] [--copy-to DESTINATION] [--keep N]
  --encrypt-to  encrypt the backup for this OpenPGP public key file; only the matching private key can read it
  --copy-to     copy the backup and its checksum to a directory or to user@host:directory (rsync over SSH)
  --keep        keep only the newest N backups in backups/ (older ones are deleted after a successful backup)
HYHOJ_ROOT supplies the default installation directory.
'
while (($#)); do
    case "$1" in
        --prefix|--encrypt-to|--copy-to|--keep)
            (($# >= 2)) || { printf 'Missing value for %s\n' "$1" >&2; exit 1; }
            case "$1" in
                --prefix) libreoj_backup_root=$2 ;;
                --encrypt-to) libreoj_backup_encrypt_to=$2 ;;
                --copy-to) libreoj_backup_copy_to=$2 ;;
                --keep) libreoj_backup_keep=$2 ;;
            esac
            shift 2 ;;
        --help|-h)
            printf '%s' "$libreoj_backup_usage"
            exit 0 ;;
        *) printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
    esac
done
[[ "$libreoj_backup_root" == /* ]] || { printf 'Use an absolute installation directory\n' >&2; exit 1; }
[[ "$libreoj_backup_keep" =~ ^[0-9]{1,4}$ ]] || { printf -- '--keep needs a number of backups (0 keeps all)\n' >&2; exit 1; }
if [ "$EUID" -ne 0 ]; then exec sudo bash "$0" "${libreoj_backup_args[@]}"; fi
umask 077
libreoj_backup_root="$(realpath -e "$libreoj_backup_root")"
for libreoj_backup_directory in config data deploy; do
    [[ -d "$libreoj_backup_root/$libreoj_backup_directory" ]] || { printf 'Missing instance directory: %s\n' "$libreoj_backup_root/$libreoj_backup_directory" >&2; exit 1; }
done
# Checked before anything is stopped: a key that can't be used would only fail after the archive was written.
libreoj_backup_gnupg=""
if [[ -n "$libreoj_backup_encrypt_to" ]]; then
    [[ -f "$libreoj_backup_encrypt_to" ]] || { printf 'No public key file: %s\n' "$libreoj_backup_encrypt_to" >&2; exit 1; }
    command -v gpg >/dev/null || { printf 'Encrypting needs gpg (apt install gnupg)\n' >&2; exit 1; }
    # A keyring of its own: root's keyring is neither read nor changed
    libreoj_backup_gnupg="$(mktemp -d)"
    if ! printf 'check' | gpg --homedir "$libreoj_backup_gnupg" --batch --quiet --trust-model always \
        --recipient-file "$libreoj_backup_encrypt_to" --encrypt >/dev/null 2>&1; then
        rm -rf "$libreoj_backup_gnupg"
        printf 'The file %s is not an OpenPGP public key that can encrypt\n' "$libreoj_backup_encrypt_to" >&2
        exit 1
    fi
fi
if [[ -n "$libreoj_backup_copy_to" ]]; then
    command -v rsync >/dev/null || { printf 'Copying needs rsync (apt install rsync)\n' >&2; exit 1; }
fi
# Share the installer/upgrade/resize maintenance lock: never stop or copy an instance they are changing.
[[ ! -L /run/libreoj-installer ]] || { printf 'Unsafe maintenance lock directory\n' >&2; exit 1; }
install -d -m 0700 -o root -g root /run/libreoj-installer
exec 9>/run/libreoj-installer/lock
flock -n 9 || { printf 'Another installation, upgrade or maintenance task is running\n' >&2; exit 1; }
install -d -m 0700 "$libreoj_backup_root/backups"
libreoj_backup_file="$libreoj_backup_root/backups/libreoj-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
[[ -z "$libreoj_backup_encrypt_to" ]] || libreoj_backup_file="$libreoj_backup_file.gpg"
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
libreoj_backup_restored=0
libreoj_backup_restore() {
    ((libreoj_backup_restored)) && return 0
    libreoj_backup_restored=1
    if ((libreoj_backup_target)); then systemctl start libreoj.target; fi
    if ((${#libreoj_backup_active[@]})); then systemctl start "${libreoj_backup_active[@]}"; fi
}
libreoj_backup_finish() {
    libreoj_backup_restore
    [[ -z "$libreoj_backup_gnupg" ]] || rm -rf "$libreoj_backup_gnupg"
}
trap libreoj_backup_finish EXIT
if ((libreoj_backup_target)); then systemctl stop libreoj.target; fi
# A target stop can finish before its PartOf services have stopped. Wait for all.
systemctl stop "${libreoj_backup_units[@]}"
libreoj_backup_archive() {
    tar --numeric-owner -cz \
     --exclude='data/judge' --exclude='data/tmp' --exclude='data/nginx' --exclude='data/ai-generated' \
     -C "$libreoj_backup_root" config data deploy
}
if [[ -n "$libreoj_backup_encrypt_to" ]]; then
    # Encrypted as it's written: no unencrypted copy is ever on disk
    libreoj_backup_archive | gpg --homedir "$libreoj_backup_gnupg" --batch --quiet --trust-model always \
        --recipient-file "$libreoj_backup_encrypt_to" --encrypt --output "$libreoj_backup_file.partial"
else
    libreoj_backup_archive > "$libreoj_backup_file.partial"
fi
mv "$libreoj_backup_file.partial" "$libreoj_backup_file"
# By file name, so that `sha256sum -c` works wherever the two files are copied
(cd "$libreoj_backup_root/backups" && sha256sum "$(basename "$libreoj_backup_file")") > "$libreoj_backup_file.sha256"
# The site is back before the backup is copied anywhere, and other maintenance may start
libreoj_backup_restore
exec 9>&-
printf 'Backup: %s\n' "$libreoj_backup_file"
if [[ -n "$libreoj_backup_copy_to" ]]; then
    if rsync --times --chmod=F600 "$libreoj_backup_file" "$libreoj_backup_file.sha256" "${libreoj_backup_copy_to%/}/"; then
        printf 'Copied to %s\n' "$libreoj_backup_copy_to"
    else
        printf 'The backup was made, but copying it to %s failed\n' "$libreoj_backup_copy_to" >&2
        exit 3
    fi
fi
if ((libreoj_backup_keep > 0)); then
    # Newest first: the names sort by their UTC time
    mapfile -t libreoj_backup_old < <(find "$libreoj_backup_root/backups" -maxdepth 1 -type f \
        \( -name 'libreoj-*.tar.gz' -o -name 'libreoj-*.tar.gz.gpg' \) -printf '%f\n' | sort -r | tail -n "+$((libreoj_backup_keep + 1))")
    for libreoj_backup_name in "${libreoj_backup_old[@]}"; do
        rm -f -- "$libreoj_backup_root/backups/$libreoj_backup_name" "$libreoj_backup_root/backups/$libreoj_backup_name.sha256"
        printf 'Deleted the older backup %s\n' "$libreoj_backup_name"
    done
fi
printf 'To check that it can be restored: sudo bash %s/deploy/verify-backup.sh %s\n' "$libreoj_backup_root" "$libreoj_backup_file"
