#!/usr/bin/env bash
set -euo pipefail
: "${DATA_DIR:?Set DATA_DIR}"
: "${BACKUP_ROOT:?Set BACKUP_ROOT outside DATA_DIR}"
: "${BACKUP_RETENTION_DAYS:=7}"
[[ "$BACKUP_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid BACKUP_RETENTION_DAYS" >&2; exit 1; }
: "${BACKUP_DISK_WARN_PERCENT:=80}"
[[ "$BACKUP_DISK_WARN_PERCENT" =~ ^([1-9][0-9]?|100)$ ]] || { echo "Invalid BACKUP_DISK_WARN_PERCENT" >&2; exit 1; }
: "${BACKUP_DISK_CRIT_PERCENT:=90}"
[[ "$BACKUP_DISK_CRIT_PERCENT" =~ ^([1-9][0-9]?|100)$ ]] || { echo "Invalid BACKUP_DISK_CRIT_PERCENT" >&2; exit 1; }
ALERT_BIN=${BOJIN_ALERT_BIN:-/usr/local/libexec/bojin-alert}
WATCHDOG_STATE_DIR=${BOJIN_WATCHDOG_STATE_DIR:-/run/bojin-watchdog}
UPTIME_FILE=${BOJIN_WATCHDOG_UPTIME_FILE:-/proc/uptime}
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
  python3 -c 'import os, stat, sys; sys.exit(0 if stat.S_ISREG(os.fstat(8).st_mode) and not os.path.islink(sys.argv[1]) else 1)' "$LEGACY_LOCK_FILE" 9>&- || {
    exec 8>&-
    echo "Refusing unsafe legacy maintenance lock: $LEGACY_LOCK_FILE" >&2
    exit 1
  }
  flock -x 8
  legacy_locked=1
elif legacy_meta=$(python3 -c '
import errno, os, stat, sys
path = sys.argv[1]
nofollow = getattr(os, "O_NOFOLLOW", 0)
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NONBLOCK | nofollow, 0o600)
except OSError as exc:
    if exc.errno != errno.EACCES:
        sys.exit(1)
    try:
        rfd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | nofollow)
    except OSError:
        sys.exit(1)
    try:
        st = os.fstat(rfd)
        if not stat.S_ISREG(st.st_mode):
            sys.exit(1)
        print(f"{st.st_dev} {st.st_ino}")
        sys.exit(0)
    finally:
        os.close(rfd)
else:
    os.close(fd)
    sys.exit(1)
' "$LEGACY_LOCK_FILE" 9>&-); then
  { exec 8<"$LEGACY_LOCK_FILE"; } 2>/dev/null || {
    echo "Failed to open existing legacy maintenance lock without O_CREAT: $LEGACY_LOCK_FILE" >&2
    exit 1
  }
  read -r exp_dev exp_ino <<<"$legacy_meta"
  python3 -c '
import os, stat, sys
st = os.fstat(8)
lst = os.lstat(sys.argv[1])
ok = (
    stat.S_ISREG(st.st_mode)
    and not stat.S_ISLNK(lst.st_mode)
    and (st.st_dev, st.st_ino) == (lst.st_dev, lst.st_ino) == (int(sys.argv[2]), int(sys.argv[3]))
)
sys.exit(0 if ok else 1)
' "$LEGACY_LOCK_FILE" "$exp_dev" "$exp_ino" 9>&- || {
    exec 8>&-
    echo "Refusing unsafe legacy maintenance lock fd: $LEGACY_LOCK_FILE" >&2
    exit 1
  }
  warn_msg="legacy maintenance lock $LEGACY_LOCK_FILE failed O_CREAT with EACCES (fs.protected_regular); opened existing regular file without O_CREAT for flock"
  echo "Warning: $warn_msg" >&2
  if command -v logger >/dev/null 2>&1; then
    logger -t bojin-backup -p daemon.warning -- "$warn_msg" 8>&- 9>&- || true
  fi
  flock -x 8
  legacy_locked=1
else
  echo "Failed to open legacy maintenance lock: $LEGACY_LOCK_FILE" >&2
  exit 1
fi
cd /opt/bojin
read -r start_epoch stamp < <(python3 -c 'import time; t = int(time.time()); print(t, time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(t)))')
snapshot="$BACKUP_ROOT/snapshot-$stamp"
ledger="$BACKUP_ROOT/deletions-$stamp.json"
work=""
custody=""
publishing=0
restart=0
finish() {
  local status=$?
  if [[ -n "$work" && -e "$work" ]]; then
    rm -rf -- "$work"
  fi
  if [[ -n "$custody" && -e "$custody" ]]; then
    rm -rf -- "$custody"
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
supports_defer=0
if [[ -f /opt/bojin/scripts/data-backup.js && ! -L /opt/bojin/scripts/data-backup.js ]] && grep -q -- '--defer-blobs' /opt/bojin/scripts/data-backup.js; then
  supports_defer=1
fi
custody=$(mktemp -d "$BACKUP_ROOT/.stage-XXXXXXXX")
chown -- root:root "$custody"
chmod -- 700 "$custody"
mkdir -m 700 -- "$custody/prelinked" "$custody/pub"
prelink_manifest="$custody/prelinked-manifest.json"
python3 - "$DATA_DIR" "$BACKUP_ROOT" "$supports_defer" "$custody/prelinked" "$prelink_manifest" <<'PY'
import hashlib, json, os, pathlib, re, shutil, stat, sys, tempfile
data_dir = pathlib.Path(sys.argv[1]).resolve()
backup_root = pathlib.Path(sys.argv[2])
dedup_enabled = sys.argv[3] == "1"
prelink_dir = pathlib.Path(sys.argv[4])
prelink_manifest = pathlib.Path(sys.argv[5])
blob_id_re = re.compile(r"^[0-9a-f]{32}$")
blob_path_re = re.compile(r"^blobs/[0-9a-f]{32}$")
sha256_re = re.compile(r"^[0-9a-f]{64}$")
target_dev = prelink_dir.stat().st_dev
expected_uid = os.getuid()

def sha256_file(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError("Snapshot files must be regular files")
        h = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
        return h.hexdigest()
    finally:
        os.close(fd)

by_sha256 = {}
seen_inodes = {}
if dedup_enabled:
    for raw_root in (backup_root, pathlib.Path("/var/backups/bojin-deploy")):
        try:
            if raw_root.is_symlink() or not raw_root.is_dir():
                continue
            entries = sorted(raw_root.iterdir(), key=lambda p: p.name, reverse=True)
        except OSError:
            continue
        for entry in entries:
            if entry.name.startswith(".") or entry.is_symlink() or not entry.is_dir():
                continue
            for snap in (entry, entry / "snapshot"):
                try:
                    if snap.is_symlink() or not snap.is_dir():
                        continue
                    mf = snap / "manifest.json"
                    db = snap / "bojin.db"
                    bd = snap / "blobs"
                    if mf.is_symlink() or not mf.is_file() or db.is_symlink() or not db.is_file() or bd.is_symlink() or not bd.is_dir():
                        continue
                    manifest = json.loads(mf.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if not isinstance(manifest, dict) or manifest.get("version") != 1 or not isinstance(manifest.get("files"), list):
                    continue
                for item in manifest["files"]:
                    if not isinstance(item, dict):
                        continue
                    name, sz, sha = item.get("name"), item.get("size"), item.get("sha256")
                    if (not isinstance(name, str) or not blob_path_re.fullmatch(name)
                            or not isinstance(sz, int) or isinstance(sz, bool) or sz < 0
                            or not isinstance(sha, str) or not sha256_re.fullmatch(sha)):
                        continue
                    cand = bd / name[6:]
                    try:
                        st = cand.lstat()
                    except OSError:
                        continue
                    if (not stat.S_ISREG(st.st_mode) or st.st_dev != target_dev
                            or st.st_size != sz or st.st_uid != expected_uid
                            or (stat.S_IMODE(st.st_mode) & 0o077) != 0):
                        continue
                    ikey = (st.st_dev, st.st_ino)
                    iset = seen_inodes.setdefault(sha, set())
                    if ikey in iset:
                        continue
                    iset.add(ikey)
                    cur = by_sha256.get(sha)
                    if cur is None:
                        by_sha256[sha] = (sz, [cand])
                    elif cur[0] == sz:
                        cur[1].append(cand)

blobs_dir = data_dir / "blobs"
prelinked_by_id = {}
prelinked_by_sha = {}
if dedup_enabled and by_sha256 and blobs_dir.is_dir() and not blobs_dir.is_symlink():
    for entry in sorted(blobs_dir.iterdir(), key=lambda p: p.name):
        name = entry.name
        if not blob_id_re.fullmatch(name):
            continue
        try:
            live_st = entry.lstat()
        except OSError:
            continue
        if not stat.S_ISREG(live_st.st_mode):
            continue
        try:
            live_sha = sha256_file(entry)
        except (OSError, ValueError):
            continue
        cand_entry = by_sha256.get(live_sha)
        if cand_entry is None or cand_entry[0] != live_st.st_size:
            continue
        live_id = (live_st.st_dev, live_st.st_ino)
        dest = prelink_dir / name
        for cand in cand_entry[1]:
            try:
                cst = cand.lstat()
                if (not stat.S_ISREG(cst.st_mode) or cst.st_dev != target_dev
                        or cst.st_size != live_st.st_size or cst.st_uid != expected_uid
                        or (stat.S_IMODE(cst.st_mode) & 0o077) != 0
                        or (cst.st_dev, cst.st_ino) == live_id):
                    continue
                os.link(cand, dest)
            except OSError:
                continue
            verified = False
            try:
                dst_st = dest.lstat()
                verified = (
                    stat.S_ISREG(dst_st.st_mode)
                    and dst_st.st_size == live_st.st_size
                    and sha256_file(dest) == live_sha
                )
            except (OSError, ValueError):
                verified = False
            if verified:
                prelinked_by_id[name] = [live_st.st_size, live_sha]
                if live_sha not in prelinked_by_sha:
                    prelinked_by_sha[live_sha] = [live_st.st_size, name]
                break
            dest.unlink(missing_ok=True)

prelink_manifest.write_text(
    json.dumps({"by_id": prelinked_by_id, "by_sha256": prelinked_by_sha}),
    encoding="utf-8",
)
prelink_manifest.chmod(0o600)

db_bytes = 0
new_blob_bytes = 0
for root, _, files in os.walk(data_dir):
    root_path = pathlib.Path(root)
    in_blobs = (root_path == blobs_dir)
    for name in files:
        try:
            st = (root_path / name).lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(st.st_mode):
            continue
        if in_blobs and blob_id_re.fullmatch(name):
            if dedup_enabled:
                item = prelinked_by_id.get(name)
                if item is not None and item[0] == st.st_size:
                    continue
            new_blob_bytes += st.st_size
        else:
            db_bytes += st.st_size

# Account for peak space per filesystem: snapshot DBs + new blobs on backup_root,
# plus private DB verification copies in system tmpdir (summed when same filesystem).
tmp_dir = pathlib.Path(tempfile.gettempdir())
tmp_dev = tmp_dir.stat().st_dev
peak_by_dev = {target_dev: db_bytes + new_blob_bytes}
path_by_dev = {target_dev: backup_root}
peak_by_dev[tmp_dev] = peak_by_dev.get(tmp_dev, 0) + db_bytes
path_by_dev.setdefault(tmp_dev, tmp_dir)

headroom = (3 * 1024 ** 3) // 2
for dev, peak_bytes in peak_by_dev.items():
    check_path = path_by_dev[dev]
    required = peak_bytes + headroom
    free = shutil.disk_usage(check_path).free
    if free <= required:
        sys.exit(
            f"Insufficient free space in {check_path}: need > {required} bytes "
            f"(peak={peak_bytes} bytes, db={db_bytes} bytes, new_blobs={new_blob_bytes} bytes), have {free} bytes"
        )
PY
state=$(systemctl show -p ActiveState --value bojin.service)
case "$state" in
  active|activating|reloading) restart=1 ;;
esac
systemctl stop bojin.service
work=$(mktemp -d "$BACKUP_ROOT/.run-XXXXXXXX")
chown -- bojin:bojin "$work"
chmod -- 700 "$work"
dedup_index="$work/dedup-index.json"
use_defer=0
if [[ "$supports_defer" == 1 ]]; then
  if python3 - "$prelink_manifest" "$dedup_index" <<'PYIDX'
import json, pathlib, sys
info = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
sha_sizes = {h: v[0] for h, v in info.get("by_sha256", {}).items()}
if not sha_sizes:
    sys.exit(2)
pathlib.Path(sys.argv[2]).write_text(json.dumps({"version": 1, "sha256": sha_sizes}), encoding="utf-8")
PYIDX
  then
    chown -- root:bojin "$dedup_index"
    chmod -- 640 "$dedup_index"
    use_defer=1
  else
    rc=$?
    if (( rc != 2 )); then
      exit "$rc"
    fi
  fi
fi
run_backup() {
  runuser -u bojin -- env -i PATH=/usr/bin:/bin DATA_DIR="$DATA_DIR" \
    /usr/bin/node /opt/bojin/scripts/data-backup.js "$@" 8>&- 9>&-
}
# Application-supplied JS must never run as root, including during backups.
if [[ "$use_defer" == 1 ]]; then
  run_backup backup "$work/snapshot" --defer-blobs "$dedup_index"
else
  run_backup backup "$work/snapshot"
fi
run_backup ledger "$work/deletions.json"
# Move untrusted staging output under root-only custody before validation and ownership transfer.
mv -- "$work" "$custody/drop"
work=""
python3 - "$custody/drop" <<'PYCUST'
import os, pathlib, pwd, stat, sys
drop = pathlib.Path(sys.argv[1])
nofollow = getattr(os, "O_NOFOLLOW", 0)
odir = getattr(os, "O_DIRECTORY", 0)
enforce_uid = (os.getuid() == 0)
expected_uid = pwd.getpwnam("bojin").pw_uid if enforce_uid else os.getuid()
idx = drop / "dedup-index.json"
if idx.is_symlink():
    raise ValueError("Refusing symlink dedup index inside staged backup")
idx.unlink(missing_ok=True)

def claim_dir(dir_path):
    dfd = os.open(dir_path, os.O_RDONLY | odir | nofollow)
    try:
        fst = os.fstat(dfd)
        if not stat.S_ISDIR(fst.st_mode):
            raise ValueError("Refusing non-directory inside staged backup")
        if enforce_uid and fst.st_uid != expected_uid:
            raise ValueError("Refusing unexpected owner on staged backup directory")
        if enforce_uid:
            os.fchown(dfd, 0, 0)
        os.fchmod(dfd, 0o700)
        lst = os.lstat(dir_path)
        if (lst.st_dev, lst.st_ino) != (fst.st_dev, fst.st_ino):
            raise ValueError("Staged backup directory changed during custody handoff")
    finally:
        os.close(dfd)
    for name in sorted(os.listdir(dir_path)):
        child = dir_path / name
        lst = os.lstat(child)
        if stat.S_ISLNK(lst.st_mode):
            raise ValueError("Refusing symlink inside staged backup")
        if stat.S_ISDIR(lst.st_mode):
            claim_dir(child)
        elif stat.S_ISREG(lst.st_mode):
            cfd = os.open(child, os.O_RDONLY | nofollow)
            try:
                cfst = os.fstat(cfd)
                if not stat.S_ISREG(cfst.st_mode):
                    raise ValueError("Refusing non-regular file inside staged backup")
                if cfst.st_nlink != 1:
                    raise ValueError("Refusing multi-linked file in untrusted staged backup")
                if enforce_uid and cfst.st_uid != expected_uid:
                    raise ValueError("Refusing unexpected owner on staged backup file")
                if enforce_uid:
                    os.fchown(cfd, 0, 0)
                os.fchmod(cfd, 0o600)
                clst = os.lstat(child)
                if (clst.st_dev, clst.st_ino) != (cfst.st_dev, cfst.st_ino):
                    raise ValueError("Staged backup file changed during custody handoff")
            finally:
                os.close(cfd)
        else:
            raise ValueError("Refusing special file inside staged backup")

claim_dir(drop)
PYCUST
chown -RP -- root:root "$custody/drop"
mv -- "$custody/drop/snapshot" "$custody/pub/snapshot"
mv -- "$custody/drop/deletions.json" "$custody/pub/deletions.json"
rm -rf -- "$custody/drop"
chmod -- 700 "$custody/pub/snapshot"
chmod -- 600 "$custody/pub/deletions.json"
python3 - "$custody/pub" "$DATA_DIR" "$BACKUP_ROOT" "$use_defer" "$custody/prelinked" "$prelink_manifest" <<'PYMAT'
import errno, hashlib, json, os, pathlib, re, shutil, sqlite3, stat, sys, tempfile
pub_dir = pathlib.Path(sys.argv[1])
snapshot_dir = pub_dir / "snapshot"
data_dir = pathlib.Path(sys.argv[2]).resolve()
backup_root = pathlib.Path(sys.argv[3])
verify_full = sys.argv[4] == "1"
prelink_dir = pathlib.Path(sys.argv[5])
prelink_info = json.loads(pathlib.Path(sys.argv[6]).read_text(encoding="utf-8"))
prelinked_by_id = prelink_info.get("by_id", {})
prelinked_by_sha = prelink_info.get("by_sha256", {})
blob_id_re = re.compile(r"^[0-9a-f]{32}$")
blob_path_re = re.compile(r"^blobs/[0-9a-f]{32}$")
sha256_re = re.compile(r"^[0-9a-f]{64}$")
database_names = ("bojin.db", "auth.sqlite")
target_dev = snapshot_dir.stat().st_dev
expected_uid = os.getuid()

def fsync_file(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Refusing to fsync non-regular file")
        os.fsync(fd)
    finally:
        os.close(fd)

def fsync_dir(dir_path):
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(dir_path, flags)
    try:
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            raise ValueError("Refusing to fsync non-directory")
        try:
            os.fsync(fd)
        except OSError as exc:
            if exc.errno not in (errno.EINVAL, errno.EBADF, errno.EROFS):
                raise
    finally:
        os.close(fd)

def sync_tree_durable(root):
    root = pathlib.Path(root)
    for parent, _, files in os.walk(root, topdown=False, followlinks=False):
        parent_path = pathlib.Path(parent)
        for name in files:
            entry = parent_path / name
            if entry.is_symlink():
                raise ValueError("Refusing symlink during durable sync")
            fsync_file(entry)
        fsync_dir(parent_path)

def sha256_file(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError("Snapshot files must be regular files")
        h = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
        return h.hexdigest()
    finally:
        os.close(fd)

def copy_verified(src, dst, exp_size, exp_sha):
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    sfd = os.open(src, os.O_RDONLY | nofollow)
    dfd = None
    try:
        if not stat.S_ISREG(os.fstat(sfd).st_mode):
            raise ValueError("Source blob must be a regular file")
        dfd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow, 0o600)
        h = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(sfd, 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                n = os.write(dfd, view)
                view = view[n:]
            h.update(chunk)
            total += len(chunk)
        os.fchmod(dfd, 0o600)
        os.fsync(dfd)
    except BaseException:
        if dfd is not None:
            os.close(dfd)
            dfd = None
        pathlib.Path(dst).unlink(missing_ok=True)
        raise
    finally:
        os.close(sfd)
        if dfd is not None:
            os.close(dfd)
    if total != exp_size or h.hexdigest() != exp_sha:
        pathlib.Path(dst).unlink(missing_ok=True)
        raise ValueError("Copied blob checksum mismatch")

by_sha256 = {}
seen_inodes = {}
for raw_root in (backup_root, pathlib.Path("/var/backups/bojin-deploy")):
    try:
        if raw_root.is_symlink() or not raw_root.is_dir():
            continue
        entries = sorted(raw_root.iterdir(), key=lambda p: p.name, reverse=True)
    except OSError:
        continue
    for entry in entries:
        if entry.name.startswith(".") or entry.is_symlink() or not entry.is_dir():
            continue
        for snap in (entry, entry / "snapshot"):
            try:
                if snap.is_symlink() or not snap.is_dir():
                    continue
                mf = snap / "manifest.json"
                db = snap / "bojin.db"
                bd = snap / "blobs"
                if mf.is_symlink() or not mf.is_file() or db.is_symlink() or not db.is_file() or bd.is_symlink() or not bd.is_dir():
                    continue
                manifest = json.loads(mf.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(manifest, dict) or manifest.get("version") != 1 or not isinstance(manifest.get("files"), list):
                continue
            for item in manifest["files"]:
                if not isinstance(item, dict):
                    continue
                name, sz, sha = item.get("name"), item.get("size"), item.get("sha256")
                if (not isinstance(name, str) or not blob_path_re.fullmatch(name)
                        or not isinstance(sz, int) or isinstance(sz, bool) or sz < 0
                        or not isinstance(sha, str) or not sha256_re.fullmatch(sha)):
                    continue
                cand = bd / name[6:]
                try:
                    st = cand.lstat()
                except OSError:
                    continue
                if (not stat.S_ISREG(st.st_mode) or st.st_dev != target_dev
                        or st.st_size != sz or st.st_uid != expected_uid
                        or (stat.S_IMODE(st.st_mode) & 0o077) != 0):
                    continue
                ikey = (st.st_dev, st.st_ino)
                iset = seen_inodes.setdefault(sha, set())
                if ikey in iset:
                    continue
                iset.add(ikey)
                cur = by_sha256.get(sha)
                if cur is None:
                    by_sha256[sha] = (sz, [cand])
                elif cur[0] == sz:
                    cur[1].append(cand)

if not verify_full and not by_sha256:
    sync_tree_durable(pub_dir)
    sys.exit(0)

blobs_dir = snapshot_dir / "blobs"
mf_path = snapshot_dir / "manifest.json"
if (snapshot_dir.is_symlink() or not snapshot_dir.is_dir()
        or blobs_dir.is_symlink() or not blobs_dir.is_dir()
        or mf_path.is_symlink() or not mf_path.is_file()):
    raise ValueError("Invalid snapshot layout")
manifest = json.loads(mf_path.read_text(encoding="utf-8"))
if not isinstance(manifest, dict) or manifest.get("version") != 1 or not isinstance(manifest.get("files"), list):
    if not verify_full:
        sys.exit(0)
    raise ValueError("Unsupported snapshot manifest")

seen_names = set()
for item in manifest["files"]:
    if not isinstance(item, dict):
        raise ValueError("Invalid snapshot manifest entry")
    name, size, sha = item.get("name"), item.get("size"), item.get("sha256")
    is_db = name in database_names
    is_blob = isinstance(name, str) and bool(blob_path_re.fullmatch(name))
    if (not (is_db or is_blob) or name in seen_names
            or not isinstance(size, int) or isinstance(size, bool) or size < 0
            or not isinstance(sha, str) or not sha256_re.fullmatch(sha)):
        raise ValueError("Unsafe or invalid snapshot manifest entry")
    seen_names.add(name)
    dest = snapshot_dir / name
    if is_db:
        if not verify_full:
            continue
        if dest.is_symlink() or not dest.is_file():
            raise ValueError("Snapshot database must be a regular file")
        if pathlib.Path(str(dest) + "-wal").exists():
            raise ValueError("Snapshot contains a WAL sidecar")
        if dest.lstat().st_size != size or sha256_file(dest) != sha:
            raise ValueError("Snapshot checksum mismatch: " + name)
        continue
    bid = name[6:]
    live_blob = data_dir / "blobs" / bid
    live_id = None
    try:
        lst = live_blob.lstat()
        if stat.S_ISREG(lst.st_mode):
            live_id = (lst.st_dev, lst.st_ino)
    except OSError:
        pass
    if dest.is_symlink():
        raise ValueError("Refusing symlink inside snapshot blobs")
    if dest.exists():
        if not stat.S_ISREG(dest.lstat().st_mode):
            raise ValueError("Snapshot blob must be a regular file")
        if verify_full:
            if dest.lstat().st_size != size or sha256_file(dest) != sha:
                raise ValueError("Snapshot checksum mismatch: " + name)
        elif sha in by_sha256 and by_sha256[sha][0] == size:
            for cand in by_sha256[sha][1]:
                try:
                    cst = cand.lstat()
                    if (not stat.S_ISREG(cst.st_mode) or cst.st_dev != target_dev
                            or cst.st_size != size or cst.st_uid != expected_uid
                            or (stat.S_IMODE(cst.st_mode) & 0o077) != 0
                            or (cst.st_dev, cst.st_ino) == live_id):
                        continue
                    if sha256_file(cand) != sha:
                        continue
                    tmp_link = blobs_dir / (".dedup-" + bid)
                    tmp_link.unlink(missing_ok=True)
                    os.link(cand, tmp_link)
                    try:
                        os.replace(tmp_link, dest)
                        break
                    except OSError:
                        tmp_link.unlink(missing_ok=True)
                except OSError:
                    continue
        continue
    materialized = False
    sec_entry = prelinked_by_id.get(bid)
    if sec_entry is not None and sec_entry[0] == size and sec_entry[1] == sha:
        sec_path = prelink_dir / bid
        if sec_path.exists() and not sec_path.is_symlink():
            try:
                os.replace(sec_path, dest)
                dst_st = dest.lstat()
                if stat.S_ISREG(dst_st.st_mode) and dst_st.st_size == size and sha256_file(dest) == sha:
                    materialized = True
            except (OSError, ValueError):
                dest.unlink(missing_ok=True)
    if not materialized and sha in prelinked_by_sha and prelinked_by_sha[sha][0] == size:
        sec_path = prelink_dir / prelinked_by_sha[sha][1]
        if sec_path.exists() and not sec_path.is_symlink():
            try:
                os.link(sec_path, dest)
                dst_st = dest.lstat()
                if stat.S_ISREG(dst_st.st_mode) and dst_st.st_size == size and sha256_file(dest) == sha:
                    materialized = True
            except (OSError, ValueError):
                dest.unlink(missing_ok=True)
    if not materialized:
        cand_entry = by_sha256.get(sha)
        if cand_entry is not None and cand_entry[0] == size:
            for cand in cand_entry[1]:
                try:
                    cst = cand.lstat()
                    if (not stat.S_ISREG(cst.st_mode) or cst.st_dev != target_dev
                            or cst.st_size != size or cst.st_uid != expected_uid
                            or (stat.S_IMODE(cst.st_mode) & 0o077) != 0
                            or (cst.st_dev, cst.st_ino) == live_id):
                        continue
                    os.link(cand, dest)
                except OSError:
                    continue
                try:
                    dst_st = dest.lstat()
                    if stat.S_ISREG(dst_st.st_mode) and dst_st.st_size == size and sha256_file(dest) == sha:
                        materialized = True
                        break
                except (OSError, ValueError):
                    pass
                dest.unlink(missing_ok=True)
    if not materialized:
        copy_verified(live_blob, dest, size, sha)

if not verify_full:
    sync_tree_durable(pub_dir)
    sys.exit(0)

if "bojin.db" not in seen_names:
    raise ValueError("Snapshot has no application database")
for entry in blobs_dir.iterdir():
    if entry.is_symlink() or not entry.is_file() or ("blobs/" + entry.name) not in seen_names:
        raise ValueError("Unexpected file in snapshot blobs: " + entry.name)

with tempfile.TemporaryDirectory(prefix="bojin-verify-") as tmpdir:
    tmp_path = pathlib.Path(tmpdir)
    for db_name in database_names:
        if db_name not in seen_names:
            continue
        copy_path = tmp_path / db_name
        shutil.copyfile(snapshot_dir / db_name, copy_path)
        copy_path.chmod(0o600)
        conn = sqlite3.connect(f"file:{copy_path}?mode=ro", uri=True)
        try:
            if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Database integrity check failed: " + db_name)
            if db_name == "bojin.db":
                for bid, bsz in conn.execute("SELECT id, size FROM blobs"):
                    rel = "blobs/" + str(bid)
                    if (not isinstance(bid, str) or not blob_id_re.fullmatch(bid)
                            or rel not in seen_names
                            or (blobs_dir / bid).lstat().st_size != bsz):
                        raise ValueError("Snapshot is missing a referenced photo")
        finally:
            conn.close()
sync_tree_durable(pub_dir)
PYMAT
publishing=1
mv -- "$custody/pub/snapshot" "$snapshot"
mv -- "$custody/pub/deletions.json" "$ledger"
python3 - "$BACKUP_ROOT" <<'PYSYNC'
import errno, os, stat, sys
flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
fd = os.open(sys.argv[1], flags)
try:
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        raise ValueError("BACKUP_ROOT is not a directory")
    try:
        os.fsync(fd)
    except OSError as exc:
        if exc.errno not in (errno.EINVAL, errno.EBADF, errno.EROFS):
            raise
finally:
    os.close(fd)
PYSYNC
publishing=0
rmdir -- "$custody/pub"
rm -rf -- "$custody"
custody=""
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
python3 - "$BACKUP_DISK_WARN_PERCENT" "$BACKUP_DISK_CRIT_PERCENT" "$ALERT_BIN" "$WATCHDOG_STATE_DIR" "$UPTIME_FILE" "$DATA_DIR" "$BACKUP_ROOT" <<'PYDISK' || true
import math, os, pathlib, re, shutil, stat, subprocess, sys, time
warn_pct = int(sys.argv[1])
crit_pct = int(sys.argv[2])
alert_bin = pathlib.Path(sys.argv[3])
state_dir = pathlib.Path(sys.argv[4])
uptime_file = pathlib.Path(sys.argv[5])
window = 21600

def monotonic_now():
    try:
        raw = uptime_file.read_text(encoding="utf-8").split()[0].split(".")[0]
        if raw.isdigit():
            return int(raw)
    except (OSError, IndexError):
        pass
    return int(time.time())

def mount_point_for(p):
    cur = p.resolve()
    while cur != cur.parent and not os.path.ismount(cur):
        cur = cur.parent
    return str(cur)

def safe_state_dir():
    try:
        if state_dir.is_symlink():
            return None
        if not state_dir.exists():
            state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        st = state_dir.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            return None
        return state_dir
    except OSError:
        return None

def is_cooled_down(sdir, key):
    if sdir is None:
        return False
    stamp = sdir / f"alert-{key}"
    try:
        if not stat.S_ISREG(stamp.lstat().st_mode):
            return False
        raw = stamp.read_text(encoding="utf-8").strip()
        if not raw.isdigit():
            return False
        now = monotonic_now()
        last = int(raw)
        return now >= last and (now - last) < window
    except OSError:
        return False

def record_sent(sdir, key):
    if sdir is None:
        return
    stamp = sdir / f"alert-{key}"
    tmp = sdir / f"alert-{key}.tmp.{os.getpid()}"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            os.write(fd, f"{monotonic_now()}\n".encode("ascii"))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, stamp)
    except OSError:
        tmp.unlink(missing_ok=True)

sdir = safe_state_dir()
seen_devs = set()
for raw in sys.argv[6:]:
    p = pathlib.Path(raw)
    if not p.exists():
        continue
    dev = p.stat().st_dev
    if dev in seen_devs:
        continue
    seen_devs.add(dev)
    usage = shutil.disk_usage(p)
    denom = usage.used + usage.free
    pct = math.ceil(usage.used * 100 / denom) if denom > 0 else 100
    free_gib = usage.free / (1024 ** 3)
    mount_id = mount_point_for(p)
    mount_key = re.sub(r"[^a-zA-Z0-9]", "_", mount_id)
    crit_key = f"disk-crit-{mount_key}"
    warn_key = f"disk-{mount_key}"
    if crit_pct > warn_pct and pct >= crit_pct:
        msg = (
            f"CRITICAL: disk holding {p} ({mount_id}) is {pct}% full ({free_gib:.1f} GiB free) after backup; "
            f"free space before writes start failing"
        )
        print("Warning: " + msg, file=sys.stderr, flush=True)
        if not is_cooled_down(sdir, crit_key) and alert_bin.is_file() and os.access(alert_bin, os.X_OK):
            try:
                res = subprocess.run([str(alert_bin), msg], check=False, stdin=subprocess.DEVNULL, timeout=30)
                if res.returncode == 0:
                    record_sent(sdir, crit_key)
            except (OSError, subprocess.SubprocessError):
                pass
    elif pct >= warn_pct:
        msg = (
            f"disk holding {p} ({mount_id}) is {pct}% full ({free_gib:.1f} GiB free, warning threshold {warn_pct}%) "
            f"after backup; inspect backups, releases, and photos before disk fills"
        )
        print("Warning: " + msg, file=sys.stderr, flush=True)
        if (not is_cooled_down(sdir, crit_key) and not is_cooled_down(sdir, warn_key)
                and alert_bin.is_file() and os.access(alert_bin, os.X_OK)):
            try:
                res = subprocess.run([str(alert_bin), msg], check=False, stdin=subprocess.DEVNULL, timeout=30)
                if res.returncode == 0:
                    record_sent(sdir, warn_key)
            except (OSError, subprocess.SubprocessError):
                pass
PYDISK
# SSH keys and destination permissions are configured by the operator. No deletion
# flags: remote retention must be configured and verified before public launch.
if [[ -z "${OFFSITE_DEST:-}" ]]; then
  echo "offsite disabled"
  exit 0
fi
rsync -a --timeout=120 \
  -e "ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3" \
  -- "$snapshot" "$ledger" "$OFFSITE_DEST/"
