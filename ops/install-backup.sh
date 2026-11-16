#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo "Run as root" >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -o root -g root -d -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$source_dir/backup-service.sh" /usr/local/libexec/bojin-backup
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
