#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo "Run as root" >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -d -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$source_dir/backup-service.sh" /usr/local/libexec/bojin-backup
for unit in bojin-backup.service bojin-backup.timer; do
  install -o root -g root -m 0644 "$source_dir/$unit" "/etc/systemd/system/$unit"
done
if [[ ! -e /etc/bojin-backup.env ]]; then
  (umask 077; set -o noclobber; cat > /etc/bojin-backup.env <<'ENV'
DATA_DIR=/var/lib/bojin
BACKUP_ROOT=/var/backups/bojin
BACKUP_RETENTION_DAYS=7
ENV
  )
  chown root:root /etc/bojin-backup.env
fi
systemctl daemon-reload
if [[ $(systemctl show -p LoadState --value bojin-backup-local.timer) != not-found ]]; then
  systemctl disable --now bojin-backup-local.timer
  echo "Disabled bojin-backup-local.timer (unit files preserved)"
fi
systemctl enable --now bojin-backup.timer
systemctl list-timers bojin-backup.timer --no-pager
