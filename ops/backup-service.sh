#!/usr/bin/env bash
set -euo pipefail
: "${DATA_DIR:?Set DATA_DIR}"
: "${BACKUP_ROOT:?Set BACKUP_ROOT outside DATA_DIR}"
: "${OFFSITE_DEST:?Set a dedicated SSH rsync backup destination}"
# Install this wrapper root-owned outside the deployable application tree.
exec 9>/run/lock/bojin-maintenance.lock
flock -x 9
cd /opt/bojin
stamp=$(date -u +%Y%m%dT%H%M%SZ)
snapshot="$BACKUP_ROOT/snapshot-$stamp"
ledger="$BACKUP_ROOT/deletions-$stamp.json"
restart=0
if systemctl is-active --quiet bojin.service; then restart=1; fi
finish() { if [[ "$restart" == 1 ]]; then systemctl start bojin.service; fi; }
trap finish EXIT
systemctl stop bojin.service
mkdir -p -- "$BACKUP_ROOT"
chown root:bojin -- "$BACKUP_ROOT"
chmod 710 -- "$BACKUP_ROOT"
work=$(mktemp -d "$BACKUP_ROOT/.run-XXXXXXXX")
chown bojin:bojin -- "$work"
run_backup() {
  runuser -u bojin -- env -i PATH=/usr/bin:/bin DATA_DIR="$DATA_DIR" \
    /usr/bin/node /opt/bojin/scripts/data-backup.js "$@"
}
# Application-supplied JS must never run as root, including during backups.
run_backup backup "$work/snapshot"
run_backup ledger "$work/deletions.json"
mv -- "$work/snapshot" "$snapshot"
mv -- "$work/deletions.json" "$ledger"
rmdir -- "$work"
if [[ "$restart" == 1 ]]; then systemctl start bojin.service; restart=0; fi
# SSH keys and destination permissions are configured by the operator. No deletion
# flags: remote retention must be configured and verified before public launch.
rsync -a -- "$snapshot" "$ledger" "$OFFSITE_DEST/"
