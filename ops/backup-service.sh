#!/usr/bin/env bash
set -euo pipefail
: "${DATA_DIR:?Set DATA_DIR}"
: "${BACKUP_ROOT:?Set BACKUP_ROOT outside DATA_DIR}"
: "${BACKUP_RETENTION_DAYS:=7}"
[[ "$BACKUP_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid BACKUP_RETENTION_DAYS" >&2; exit 1; }
# Install this wrapper root-owned outside the deployable application tree.
LOCK_DIR=/run/bojin
LOCK_FILE=/run/bojin/maintenance.lock
# Transition compatibility (one release): also lock the legacy path after LOCK_FILE
# so an un-upgraded host helper or manual command cannot run maintenance concurrently.
# Remove in the next release once /etc/tmpfiles.d/bojin.conf, lean-ritual-deploy,
# bojin-backup, bojin-watchdog and operator runbooks on the host all use LOCK_FILE.
LEGACY_LOCK_FILE=/run/lock/bojin-maintenance.lock

path_uid() {
  if stat -c '%u' / >/dev/null 2>&1; then
    stat -c '%u' -- "$1"
  else
    stat -f '%u' "$1"
  fi
}

[[ ! -L "$LOCK_DIR" ]] || { echo "Refusing symlink maintenance lock directory: $LOCK_DIR" >&2; exit 1; }
if [[ ! -e "$LOCK_DIR" ]]; then
  install -d -o root -g root -m 0755 "$LOCK_DIR"
fi
[[ ! -L "$LOCK_DIR" && -d "$LOCK_DIR" && "$(path_uid "$LOCK_DIR")" == 0 ]] || {
  echo "Refusing non-root or invalid maintenance lock directory: $LOCK_DIR" >&2
  exit 1
}
[[ ! -L "$LOCK_FILE" ]] || { echo "Refusing symlink maintenance lock: $LOCK_FILE" >&2; exit 1; }
if [[ -e "$LOCK_FILE" ]]; then
  [[ -f "$LOCK_FILE" && "$(path_uid "$LOCK_FILE")" == 0 ]] || {
    echo "Refusing non-root or non-regular maintenance lock: $LOCK_FILE" >&2
    exit 1
  }
fi
exec 9>>"$LOCK_FILE"
[[ ! -L "$LOCK_FILE" && -f "$LOCK_FILE" && "$(path_uid "$LOCK_FILE")" == 0 ]] || {
  exec 9>&-
  echo "Refusing unsafe maintenance lock: $LOCK_FILE" >&2
  exit 1
}
flock -x 9

legacy_locked=0
[[ ! -L "$LEGACY_LOCK_FILE" ]] || { echo "Refusing symlink legacy maintenance lock: $LEGACY_LOCK_FILE" >&2; exit 1; }
if [[ -e "$LEGACY_LOCK_FILE" && ! -f "$LEGACY_LOCK_FILE" ]]; then
  echo "Refusing non-regular legacy maintenance lock: $LEGACY_LOCK_FILE" >&2
  exit 1
fi
if { exec 8>>"$LEGACY_LOCK_FILE"; } 2>/dev/null; then
  [[ ! -L "$LEGACY_LOCK_FILE" && -f "$LEGACY_LOCK_FILE" ]] || {
    exec 8>&-
    echo "Refusing unsafe legacy maintenance lock: $LEGACY_LOCK_FILE" >&2
    exit 1
  }
  flock -x 8
  legacy_locked=1
elif python3 -c '
import errno, os, sys
flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
try:
    os.close(os.open(sys.argv[1], flags, 0o600))
except OSError as e:
    sys.exit(0 if e.errno == errno.EACCES else 1)
sys.exit(1)
' "$LEGACY_LOCK_FILE"; then
  echo "Warning: legacy maintenance lock $LEGACY_LOCK_FILE failed with EACCES (fs.protected_regular); continuing with $LOCK_FILE only" >&2
  if command -v logger >/dev/null 2>&1; then
    logger -t bojin-backup -p daemon.warning -- \
      "legacy maintenance lock $LEGACY_LOCK_FILE failed with EACCES (fs.protected_regular); continuing with $LOCK_FILE only" 8>&- 9>&- || true
  fi
else
  echo "Failed to open legacy maintenance lock: $LEGACY_LOCK_FILE" >&2
  exit 1
fi
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
[[ ! -L "$BACKUP_ROOT" ]] || { echo "Refusing symlink BACKUP_ROOT" >&2; exit 1; }
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
    /usr/bin/node /opt/bojin/scripts/data-backup.js "$@" 8>&- 9>&-
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

def sized_file(p, minimum):
    return not p.is_symlink() and p.is_file() and p.stat().st_size >= minimum

def complete_snapshot(p):
    return (not p.is_symlink() and sized_file(p / "manifest.json", 2)
            and sized_file(p / "bojin.db", 100))

def newest_keep(dated_list, count, usable):
    complete = []
    for _, _, p in dated_list:
        if usable(p):
            complete.append(p)
        else:
            print("incomplete backup " + p.name, file=sys.stderr)
    return set(complete[:count])

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
keep = newest_keep(snapshots, 2, complete_snapshot) | {pathlib.Path(sys.argv[3]).resolve(strict=True)}
ledger_keep = newest_keep(ledgers, 1, lambda p: sized_file(p, 2)) | {pathlib.Path(sys.argv[4]).resolve(strict=True)}
if snapshots:
    resolved_root = root.resolve(strict=True)
    ledger_keep.update(resolved_root / ("deletions-" + p.name[9:] + ".json") for p in keep)
prune_dated(snapshots, keep)
prune_dated(ledgers, ledger_keep)

deploy = dated_entries(pathlib.Path("/var/backups/bojin-deploy"),
                       r"[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9_]{8}", True)
prune_dated(deploy, newest_keep(deploy, 2, lambda p: complete_snapshot(p / "snapshot") and sized_file(p / "deletions.json", 2)))

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
    if not prev_link.is_symlink():
        print("release pruning disabled: previous pointer missing or not a symlink", file=sys.stderr)
        sys.exit(0)
    prev_target = prev_link.resolve(strict=True)
    if not prev_target.is_dir() or prev_target.parent != rel_base:
        print("release pruning disabled: invalid previous target", file=sys.stderr)
        sys.exit(0)
    protected.add(prev_target)
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
if [[ "$legacy_locked" == 1 ]]; then
  flock -u 8
  exec 8>&-
fi
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
