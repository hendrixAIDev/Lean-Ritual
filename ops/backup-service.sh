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
work=""
publishing=0
restart=0
finish() {
  local status=$?
  if [[ -n "$work" && -e "$work" ]]; then
    rm -rf -- "$work"
  fi
  if [[ "$publishing" == 1 ]]; then
    rm -rf -- "$snapshot" "$ledger"
  fi
  if [[ "$restart" == 1 ]]; then
    if systemctl start bojin.service; then
      :
    else
      status=$?
    fi
  fi
  exit "$status"
}
trap finish EXIT
[[ -d "$DATA_DIR" ]] || { echo "Missing DATA_DIR: $DATA_DIR" >&2; exit 1; }
mkdir -p -- "$BACKUP_ROOT"
chown -- root:bojin "$BACKUP_ROOT"
chmod -- 710 "$BACKUP_ROOT"
[[ ! -e "$snapshot" && ! -L "$snapshot" && ! -e "$ledger" && ! -L "$ledger" ]] || {
  echo "Backup target already exists for $stamp" >&2
  exit 1
}
python3 - "$DATA_DIR" "$BACKUP_ROOT" <<'PY'
import os, pathlib, shutil, sys
data_dir = pathlib.Path(sys.argv[1]).resolve()
backup_root = pathlib.Path(sys.argv[2])
size = 0
for root, _, files in os.walk(data_dir):
    for name in files:
        try:
            size += (pathlib.Path(root) / name).lstat().st_size
        except FileNotFoundError:
            pass
required = size + (3 * 1024 ** 3) // 2
free = shutil.disk_usage(backup_root).free
if free <= required:
    sys.exit(f"Insufficient free space in {backup_root}: need > {required} bytes, have {free} bytes")
PY
state=$(systemctl show -p ActiveState --value bojin.service)
case "$state" in
  active|activating|reloading) restart=1 ;;
esac
systemctl stop bojin.service
work=$(mktemp -d "$BACKUP_ROOT/.run-XXXXXXXX")
chown -- bojin:bojin "$work"
chmod -- 700 "$work"
run_backup() {
  runuser -u bojin -- env -i PATH=/usr/bin:/bin DATA_DIR="$DATA_DIR" \
    /usr/bin/node /opt/bojin/scripts/data-backup.js "$@"
}
# Application-supplied JS must never run as root, including during backups.
run_backup backup "$work/snapshot"
run_backup ledger "$work/deletions.json"
if [[ -n $(find "$work" -type l -print -quit) ]]; then
  echo "Refusing symlink inside staged backup" >&2
  exit 1
fi
chown -RP -- root:root "$work/snapshot" "$work/deletions.json"
chmod -- 700 "$work/snapshot"
chmod -- 600 "$work/deletions.json"
publishing=1
mv -- "$work/snapshot" "$snapshot"
mv -- "$work/deletions.json" "$ledger"
publishing=0
rmdir -- "$work"
work=""
if [[ "$restart" == 1 ]]; then
  restart=0
  systemctl start bojin.service
fi
flock -u 9
exec 9>&-
# SSH keys and destination permissions are configured by the operator. No deletion
# flags: remote retention must be configured and verified before public launch.
rsync -a --timeout=120 \
  -e "ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3" \
  -- "$snapshot" "$ledger" "$OFFSITE_DEST/"
