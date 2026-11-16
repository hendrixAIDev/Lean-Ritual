#!/usr/bin/env bash
set -euo pipefail
: "${DATA_DIR:?Set DATA_DIR}"
: "${BACKUP_ROOT:?Set BACKUP_ROOT outside DATA_DIR}"
: "${BACKUP_RETENTION_DAYS:=7}"
[[ "$BACKUP_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid BACKUP_RETENTION_DAYS" >&2; exit 1; }
# Install this wrapper root-owned outside the deployable application tree.
exec 9>/run/lock/bojin-maintenance.lock
flock -x 9
cd /opt/bojin
read -r start_epoch stamp < <(python3 -c 'import time; t = int(time.time()); print(t, time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(t)))')
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
# Prune only after publication, under the same maintenance lock.
python3 - "$BACKUP_ROOT" "$BACKUP_RETENTION_DAYS" "$snapshot" "$ledger" "$start_epoch" <<'PYRET'
import datetime, pathlib, re, shutil, sys

def check_root(base):
    if base.is_symlink():
        raise RuntimeError(f"Refusing symlink retention root: {base}")
    if not base.exists():
        return None
    return base.resolve(strict=True)

def parse_stamp(name):
    m = re.search(r"([0-9]{8}T[0-9]{6}Z)", name)
    if not m:
        return None
    try:
        return (datetime.datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ")
                .replace(tzinfo=datetime.timezone.utc).timestamp())
    except ValueError:
        return None

now = int(sys.argv[5])
cutoff = now - int(sys.argv[2]) * 86400
new_protected = {
    pathlib.Path(sys.argv[3]).resolve(strict=True),
    pathlib.Path(sys.argv[4]).resolve(strict=True),
}

def dated_entries(raw_base, pattern, directory):
    base = check_root(raw_base)
    if base is None:
        return []
    found = []
    for p in base.iterdir():
        if (re.fullmatch(pattern, p.name) and not p.is_symlink()
                and (p.is_dir() if directory else p.is_file())):
            ts = parse_stamp(p.name)
            if ts is None:
                print(f"skipping invalid timestamp entry {p.name}", file=sys.stderr, flush=True)
                continue
            if ts > now + 3600:
                print("skipping future timestamp entry " + p.name, file=sys.stderr)
                continue
            found.append((ts, p.name, p))
    found.sort(reverse=True)
    return found

def newest_keep(dated_list, count):
    return {p for _, _, p in dated_list[:count]}

def prune_dated(dated_list, keep):
    for ts, _, p in dated_list:
        if p in keep or p in new_protected:
            continue
        st = p.lstat()
        if ts < cutoff and st.st_mtime < cutoff:
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p)
            else:
                p.unlink()
            print("pruned " + p.name, flush=True)

root = pathlib.Path(sys.argv[1])
snapshots = dated_entries(root, r"snapshot-[0-9]{8}T[0-9]{6}Z", True)
ledgers = dated_entries(root, r"deletions-[0-9]{8}T[0-9]{6}Z\.json", False)
keep = newest_keep(snapshots, 2) | {pathlib.Path(sys.argv[3]).resolve(strict=True)}
ledger_keep = newest_keep(ledgers, 1) | {pathlib.Path(sys.argv[4]).resolve(strict=True)}
if snapshots:
    resolved_root = root.resolve(strict=True)
    ledger_keep.update(resolved_root / ("deletions-" + p.name[9:] + ".json") for p in keep)
prune_dated(snapshots, keep)
prune_dated(ledgers, ledger_keep)

deploy = dated_entries(pathlib.Path("/var/backups/bojin-deploy"),
                       r"[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9_]{8}", True)
prune_dated(deploy, newest_keep(deploy, 2))

rel_base = check_root(pathlib.Path("/opt/bojin-releases"))
if rel_base is not None:
    rel_re = re.compile(r"[0-9a-f]{40}-([0-9]+)-[0-9]+")
    releases = sorted(
        (p for p in rel_base.iterdir()
         if rel_re.fullmatch(p.name) and not p.is_symlink() and p.is_dir()),
        key=lambda p: int(rel_re.fullmatch(p.name).group(1)),
        reverse=True,
    )
    active = pathlib.Path("/opt/bojin").resolve(strict=True)
    protected = {active}
    prev_link = pathlib.Path("/opt/bojin-previous")
    if prev_link.is_symlink() or prev_link.exists():
        protected.add(prev_link.resolve(strict=True))
    else:
        print("release pruning disabled: previous pointer missing", file=sys.stderr)
        sys.exit(0)
    others = [p for p in releases if p not in protected]
    protected.update(others[:5])
    for p in releases:
        if p in protected or p.samefile(active):
            continue
        st = p.lstat()
        if max(st.st_mtime, st.st_ctime) < cutoff:
            shutil.rmtree(p)
            print("pruned " + p.name, flush=True)
PYRET
flock -u 9
exec 9>&-
# SSH keys and destination permissions are configured by the operator. No deletion
# flags: remote retention must be configured and verified before public launch.
if [[ -z "${OFFSITE_DEST:-}" ]]; then
  echo "offsite disabled"
  exit 0
fi
rsync -a --timeout=120 \
  -e "ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3" \
  -- "$snapshot" "$ledger" "$OFFSITE_DEST/"
