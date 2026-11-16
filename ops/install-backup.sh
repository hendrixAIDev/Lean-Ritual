#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo "Run as root" >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
path_uid() {
  if stat -c '%u' / >/dev/null 2>&1; then
    stat -c '%u' -- "$1"
  else
    stat -f '%u' "$1"
  fi
}
[[ ! -L /etc/tmpfiles.d && ! -L /etc/tmpfiles.d/bojin.conf ]] || { echo "Refusing symlink tmpfiles path" >&2; exit 1; }
install -o root -g root -d -m 0755 /etc/tmpfiles.d
install -o root -g root -m 0644 "$source_dir/bojin-tmpfiles.conf" /etc/tmpfiles.d/bojin.conf
[[ ! -L /run/bojin ]] || { echo "Refusing symlink /run/bojin" >&2; exit 1; }
if [[ -e /run/bojin ]]; then
  [[ -d /run/bojin && "$(path_uid /run/bojin)" == 0 ]] || { echo "Refusing non-root or invalid /run/bojin" >&2; exit 1; }
fi
if command -v systemd-tmpfiles >/dev/null 2>&1; then
  systemd-tmpfiles --create /etc/tmpfiles.d/bojin.conf
fi
if [[ ! -e /run/bojin ]]; then
  install -o root -g root -d -m 0755 /run/bojin
fi
[[ ! -L /run/bojin && -d /run/bojin && "$(path_uid /run/bojin)" == 0 ]] || { echo "Refusing non-root or invalid /run/bojin" >&2; exit 1; }
install -o root -g root -d -m 0755 /usr/local/libexec
install -o root -g root -d -m 0755 /usr/local/sbin
install -o root -g root -m 0755 "$source_dir/backup-service.sh" /usr/local/libexec/bojin-backup
install -o root -g root -m 0755 "$source_dir/maintenance-lock.sh" /usr/local/sbin/bojin-maintenance-lock
for unit in bojin-backup.service bojin-backup.timer; do
  install -o root -g root -m 0644 "$source_dir/$unit" "/etc/systemd/system/$unit"
done
[[ ! -L /etc/bojin-backup.env ]] || { echo "Refusing symlink backup env" >&2; exit 1; }
if [[ ! -e /etc/bojin-backup.env ]]; then
  (umask 077; set -o noclobber; cat > /etc/bojin-backup.env <<'ENV'
DATA_DIR=/var/lib/bojin
BACKUP_ROOT=/var/backups/bojin
BACKUP_RETENTION_DAYS=7
ENV
  )
  chown root:root /etc/bojin-backup.env
fi
[[ -f /etc/bojin-backup.env ]] || { echo "Backup env must be a regular file" >&2; exit 1; }
chown root:root /etc/bojin-backup.env
chmod 0600 /etc/bojin-backup.env
if systemctl is-active --quiet bojin-backup-local.service; then
  echo "Wait for active bojin-backup-local.service to finish first" >&2
  exit 1
fi
systemctl daemon-reload
if systemctl is-enabled --quiet bojin-backup-local.timer 2>/dev/null || systemctl is-active --quiet bojin-backup-local.timer; then
  systemctl disable --now bojin-backup-local.timer
  echo "Disabled bojin-backup-local.timer (unit files preserved)"
fi
systemctl enable --now bojin-backup.timer
systemctl list-timers bojin-backup.timer --no-pager
