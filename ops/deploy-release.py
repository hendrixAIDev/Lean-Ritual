#!/usr/bin/python3
"""Root-owned, no-argument SSH receiver. Never execute uploaded code as root."""
import contextlib
import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import signal
import sqlite3
import stat
import subprocess
import sys
import syslog
import tarfile
import tempfile
import time
import urllib.request

RELEASES = Path("/opt/bojin-releases")
CURRENT = Path("/opt/bojin")
DATA = Path("/var/lib/bojin")
BACKUPS = Path("/var/backups/bojin-deploy")
DAILY_BACKUPS = Path("/var/backups/bojin")
LOCK = Path("/run/bojin/maintenance.lock")
# Transition compatibility (one release): also lock the legacy path after LOCK so an
# un-upgraded host helper or manual command cannot run maintenance concurrently.
# Remove in the next release once /etc/tmpfiles.d/bojin.conf, lean-ritual-deploy,
# bojin-backup, bojin-watchdog and operator runbooks on the host all use LOCK.
LEGACY_LOCK = Path("/run/lock/bojin-maintenance.lock")
ALERT = Path("/usr/local/libexec/bojin-alert")
WATCHDOG_STATE_DIR = Path(os.environ.get("BOJIN_WATCHDOG_STATE_DIR", "/run/bojin-watchdog"))
UPTIME_FILE = Path(os.environ.get("BOJIN_WATCHDOG_UPTIME_FILE", "/proc/uptime"))
ENV_FILE = Path("/etc/bojin/environment")
STOPPED_DEPLOY_FLAG = Path("/etc/bojin/allow-deploy-when-stopped")
ALLOWED = {"server.js", "package.json", "package-lock.json", ".release.json", "lib", "scripts", "public", "node_modules"}
MAX_BYTES = 600 * 1024 * 1024
MIN_FREE_HEADROOM = (3 * 1024 ** 3) // 2
DISK_WARN_PERCENT = 80
DISK_CRIT_PERCENT = 90
DISK_COOLDOWN_SEC = 21600
UPLOAD_TIMEOUT = 300
ALLOWED_SERVICE_STATES = {"active", "activating", "reloading", "failed"}
STOPPED_SERVICE_STATES = {"inactive", "deactivating"}
DATABASE_NAMES = ("bojin.db", "auth.sqlite")
BLOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
BLOB_PATH_RE = re.compile(r"^blobs/[0-9a-f]{32}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def unpack_release(stream, destination):
    """Reject traversal, duplicate files, links, devices and oversized archives."""
    size = count = 0
    seen = set()
    with tarfile.open(fileobj=stream, mode="r|gz") as archive:
        for member in archive:
            name = member.name.rstrip("/")
            parts = PurePosixPath(name).parts
            if (not parts or name.startswith("/") or ".." in parts or "\\" in name
                    or str(PurePosixPath(name)) != name or parts[0] not in ALLOWED
                    or not (member.isfile() or member.isdir()) or name in seen):
                raise ValueError("Unsafe release archive entry")
            if len(parts) > 1 and parts[0] in {"server.js", "package.json", "package-lock.json", ".release.json"}:
                raise ValueError("Invalid release layout")
            count += 1
            size += member.size
            if size > MAX_BYTES or count > 50000:
                raise ValueError("Release archive exceeds limits")
            seen.add(name)
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(0o755)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                # No archive entry may replace an already-created directory/file.
                with target.open("xb") as output:
                    shutil.copyfileobj(archive.extractfile(member), output)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
    for required in ["server.js", "package.json", "package-lock.json", "public/index.html", "public/csp-hashes.json",
                     "scripts/data-backup.js", "lib/snapshots.js", "node_modules/sharp/package.json"]:
        if not (destination / required).is_file():
            raise ValueError("Incomplete release")
    metadata = json.loads((destination / ".release.json").read_text())
    if (not re.fullmatch(r"[0-9a-f]{40}", metadata.get("revision", ""))
            or metadata.get("platform") != "linux" or metadata.get("arch") != "x64"
            or not re.fullmatch(r"24\.\d+\.\d+", metadata.get("node", ""))):
        raise ValueError("Unsupported release metadata")
    # mkdir(parents=True) uses umask; ensure the service can traverse every folder.
    for parent, directories, _ in os.walk(destination):
        Path(parent).chmod(0o755)
    return metadata


def notify_alert(message):
    if ALERT.is_file() and os.access(ALERT, os.X_OK):
        try:
            res = subprocess.run([str(ALERT), message], check=False, stdin=subprocess.DEVNULL, timeout=30)
            return res.returncode == 0
        except (OSError, subprocess.SubprocessError) as error:
            syslog.syslog(syslog.LOG_ERR, "lean-ritual-deploy alert failed: " + repr(error))
    return False


def fsync_file(path):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError("Refusing to fsync non-regular file")
        os.fsync(fd)
    finally:
        os.close(fd)


def fsync_dir(dir_path):
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(dir_path, flags)
    try:
        st = os.fstat(fd)
        if not stat.S_ISDIR(st.st_mode):
            raise ValueError("Refusing to fsync non-directory")
        try:
            os.fsync(fd)
        except OSError as error:
            if error.errno not in (errno.EINVAL, errno.EBADF, errno.EROFS):
                raise
    finally:
        os.close(fd)


def sync_tree_durable(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Refusing to sync non-directory tree")
    for parent, _, files in os.walk(root, topdown=False, followlinks=False):
        parent_path = Path(parent)
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
        digest = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        return digest.hexdigest()
    finally:
        os.close(fd)


def release_supports_defer_blobs(release_dir):
    try:
        base = Path(release_dir)
        if base.is_symlink():
            base = base.resolve(strict=True)
        script = base / "scripts/data-backup.js"
        if script.is_symlink() or not script.is_file():
            return False
        return "--defer-blobs" in script.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False


def iter_existing_snapshots(backup_roots):
    seen = set()
    for raw_root in backup_roots:
        if raw_root is None:
            continue
        root = Path(raw_root)
        try:
            if root.is_symlink() or not root.is_dir():
                continue
            entries = sorted(root.iterdir(), key=lambda p: p.name, reverse=True)
        except OSError:
            continue
        for entry in entries:
            if entry.name.startswith(".") or entry.is_symlink() or not entry.is_dir():
                continue
            for candidate in (entry, entry / "snapshot"):
                try:
                    if candidate.is_symlink() or not candidate.is_dir():
                        continue
                    manifest = candidate / "manifest.json"
                    db = candidate / "bojin.db"
                    blobs = candidate / "blobs"
                    if (manifest.is_symlink() or not manifest.is_file()
                            or db.is_symlink() or not db.is_file()
                            or blobs.is_symlink() or not blobs.is_dir()):
                        continue
                    key = (candidate.lstat().st_dev, candidate.lstat().st_ino)
                except OSError:
                    continue
                if key in seen:
                    continue
                seen.add(key)
                yield candidate


def index_existing_blobs(backup_roots, target_dev):
    by_id = {}
    by_sha256 = {}
    seen_inodes = {}
    expected_uid = os.getuid()
    for snap in iter_existing_snapshots(backup_roots):
        try:
            manifest = json.loads((snap / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(manifest, dict) or manifest.get("version") != 1 or not isinstance(manifest.get("files"), list):
            continue
        for item in manifest["files"]:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            size = item.get("size")
            sha = item.get("sha256")
            if (not isinstance(name, str) or not BLOB_PATH_RE.fullmatch(name)
                    or not isinstance(size, int) or isinstance(size, bool) or size < 0
                    or not isinstance(sha, str) or not SHA256_RE.fullmatch(sha)):
                continue
            blob_id = name[6:]
            cand = snap / "blobs" / blob_id
            try:
                st = cand.lstat()
            except OSError:
                continue
            if (not stat.S_ISREG(st.st_mode) or st.st_dev != target_dev
                    or st.st_size != size or st.st_uid != expected_uid
                    or (stat.S_IMODE(st.st_mode) & 0o077) != 0):
                continue
            if blob_id not in by_id:
                by_id[blob_id] = (size, st.st_dev, st.st_ino)
            inode_key = (st.st_dev, st.st_ino)
            inode_set = seen_inodes.setdefault(sha, set())
            if inode_key in inode_set:
                continue
            inode_set.add(inode_key)
            existing = by_sha256.get(sha)
            if existing is None:
                by_sha256[sha] = (size, [cand])
            elif existing[0] == size:
                existing[1].append(cand)
    return by_id, by_sha256


def data_size(path):
    total = 0
    for root, _, files in os.walk(Path(path).resolve()):
        for name in files:
            try:
                st = (Path(root) / name).lstat()
                if stat.S_ISREG(st.st_mode):
                    total += st.st_size
            except FileNotFoundError:
                pass
    return total


def prepare_prelinked_blobs(data_dir, backup_roots, stage_dir):
    """Link and SHA-256-verify unchanged blobs into private root-only staging."""
    stage_dir = Path(stage_dir)
    target_dev = stage_dir.stat().st_dev
    _, by_sha256 = index_existing_blobs(backup_roots, target_dev)
    if not by_sha256:
        return {}, {}
    data_path = Path(data_dir).resolve()
    blobs_dir = data_path / "blobs"
    if blobs_dir.is_symlink() or not blobs_dir.is_dir():
        return {}, {}
    expected_uid = os.getuid()
    prelinked_by_id = {}
    prelinked_by_sha = {}
    for entry in sorted(blobs_dir.iterdir(), key=lambda p: p.name):
        name = entry.name
        if not BLOB_ID_RE.fullmatch(name):
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
        dest = stage_dir / name
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
                prelinked_by_id[name] = (live_st.st_size, live_sha, dest)
                if live_sha not in prelinked_by_sha:
                    prelinked_by_sha[live_sha] = (live_st.st_size, dest)
                break
            dest.unlink(missing_ok=True)
    return prelinked_by_id, prelinked_by_sha


def estimate_snapshot_bytes(data_dir, backup_roots=None, target_dev=None, dedup_enabled=True,
                            prelinked_by_id=None, probe_parent=None):
    """Return (db_bytes, new_blob_bytes), discounting only blobs with verified hardlinks."""
    data_path = Path(data_dir).resolve()
    blobs_dir = data_path / "blobs"
    secured = prelinked_by_id
    if dedup_enabled and secured is None and backup_roots and probe_parent is not None:
        probe_dir = None
        try:
            probe_dir = Path(tempfile.mkdtemp(prefix=".preflight-", dir=probe_parent))
            probe_dir.chmod(0o700)
            secured, _ = prepare_prelinked_blobs(data_path, backup_roots, probe_dir)
        except OSError:
            secured = {}
        finally:
            if probe_dir is not None and probe_dir.exists():
                shutil.rmtree(probe_dir, ignore_errors=True)
    if secured is None:
        secured = {}

    db_bytes = 0
    new_blob_bytes = 0
    for root, _, files in os.walk(data_path):
        root_path = Path(root)
        in_blobs = (root_path == blobs_dir)
        for name in files:
            try:
                st = (root_path / name).lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            if in_blobs and BLOB_ID_RE.fullmatch(name):
                if dedup_enabled:
                    item = secured.get(name)
                    if item is not None and item[0] == st.st_size:
                        continue
                new_blob_bytes += st.st_size
            else:
                db_bytes += st.st_size
    return db_bytes, new_blob_bytes


def existing_parent(path):
    current = Path(path)
    while not current.exists():
        current = current.parent
    return current


def mount_point_for(path):
    current = existing_parent(path).resolve()
    while current != current.parent and not os.path.ismount(current):
        current = current.parent
    return str(current)


def mount_key_for(mount_id):
    return re.sub(r"[^a-zA-Z0-9]", "_", mount_id)


def monotonic_now():
    try:
        raw = UPTIME_FILE.read_text(encoding="utf-8").split()[0].split(".")[0]
        if raw.isdigit():
            return int(raw)
    except (OSError, IndexError):
        pass
    return int(time.time())


def safe_watchdog_state_dir():
    state = Path(WATCHDOG_STATE_DIR)
    try:
        if state.is_symlink():
            return None
        if not state.exists():
            state.mkdir(mode=0o700, parents=True, exist_ok=True)
        st = state.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            return None
        return state
    except OSError:
        return None


def is_disk_alert_cooled_down(state_dir, key, window=DISK_COOLDOWN_SEC):
    if state_dir is None:
        return False
    stamp = state_dir / f"alert-{key}"
    try:
        st = stamp.lstat()
        if not stat.S_ISREG(st.st_mode):
            return False
        raw = stamp.read_text(encoding="utf-8").strip()
        if not raw.isdigit():
            return False
        now = monotonic_now()
        last = int(raw)
        return now >= last and (now - last) < window
    except OSError:
        return False


def record_disk_alert_sent(state_dir, key):
    if state_dir is None:
        return
    stamp = state_dir / f"alert-{key}"
    tmp = state_dir / f"alert-{key}.tmp.{os.getpid()}"
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


def send_throttled_disk_alert(path, severity, message):
    state_dir = safe_watchdog_state_dir()
    mount_key = mount_key_for(mount_point_for(path))
    crit_key = f"disk-crit-{mount_key}"
    warn_key = f"disk-{mount_key}"
    if severity == "crit":
        if is_disk_alert_cooled_down(state_dir, crit_key):
            return False
        if notify_alert(message):
            record_disk_alert_sent(state_dir, crit_key)
            return True
        return False
    if is_disk_alert_cooled_down(state_dir, crit_key) or is_disk_alert_cooled_down(state_dir, warn_key):
        return False
    if notify_alert(message):
        record_disk_alert_sent(state_dir, warn_key)
        return True
    return False


def disk_usage_percent(path):
    usage = shutil.disk_usage(existing_parent(path))
    denom = usage.used + usage.free
    pct = math.ceil(usage.used * 100 / denom) if denom > 0 else 100
    return pct, usage.free


def check_disk_usage_guard(*targets, warn_percent=DISK_WARN_PERCENT, crit_percent=DISK_CRIT_PERCENT):
    seen_devs = set()
    alerts = []
    for target in targets:
        parent = existing_parent(target)
        dev = parent.stat().st_dev
        if dev in seen_devs:
            continue
        seen_devs.add(dev)
        pct, free = disk_usage_percent(parent)
        free_gib = free / (1024 ** 3)
        mount_id = mount_point_for(parent)
        if crit_percent > warn_percent and pct >= crit_percent:
            message = (
                f"CRITICAL: disk holding {parent} ({mount_id}) is {pct}% full ({free_gib:.1f} GiB free) during deploy; "
                f"free space before writes start failing"
            )
            syslog.syslog(syslog.LOG_WARNING, "lean-ritual-deploy: " + message)
            if send_throttled_disk_alert(parent, "crit", message):
                alerts.append(message)
        elif pct >= warn_percent:
            message = (
                f"disk holding {parent} ({mount_id}) is {pct}% full ({free_gib:.1f} GiB free, warning threshold {warn_percent}%) "
                f"during deploy; inspect backups, releases, and photos before disk fills"
            )
            syslog.syslog(syslog.LOG_WARNING, "lean-ritual-deploy: " + message)
            if send_throttled_disk_alert(parent, "warn", message):
                alerts.append(message)
    return alerts


def check_free_space(data_dir, *targets, backup_roots=None, dedup_enabled=True, prelinked_by_id=None):
    if not targets:
        raise ValueError("check_free_space requires at least one target")
    roots = backup_roots if backup_roots is not None else targets
    backup_parent = existing_parent(targets[-1])
    backup_dev = backup_parent.stat().st_dev
    tmp_parent = existing_parent(tempfile.gettempdir())
    tmp_dev = tmp_parent.stat().st_dev
    db_bytes, new_blob_bytes = estimate_snapshot_bytes(
        data_dir, roots, backup_dev, dedup_enabled=dedup_enabled,
        prelinked_by_id=prelinked_by_id, probe_parent=backup_parent,
    )

    # Account for peak space per filesystem: snapshot DBs + new blobs on backup_dev,
    # plus private DB verification copies on tmp_dev (summed when same filesystem).
    peak_by_dev = {}
    path_by_dev = {}
    for target in targets:
        parent = existing_parent(target)
        dev = parent.stat().st_dev
        peak_by_dev.setdefault(dev, 0)
        path_by_dev.setdefault(dev, parent)
    peak_by_dev[backup_dev] = peak_by_dev.get(backup_dev, 0) + db_bytes + new_blob_bytes
    path_by_dev.setdefault(backup_dev, backup_parent)
    peak_by_dev[tmp_dev] = peak_by_dev.get(tmp_dev, 0) + db_bytes
    path_by_dev.setdefault(tmp_dev, tmp_parent)

    for dev, peak_bytes in peak_by_dev.items():
        check_path = path_by_dev[dev]
        required = peak_bytes + MIN_FREE_HEADROOM
        free = shutil.disk_usage(check_path).free
        if free <= required:
            raise ValueError(
                f"Need more than peak snapshot bytes ({peak_bytes}) + 1.5 GiB free on {check_path} "
                f"(need > {required} bytes, have {free} bytes)"
            )


def consume_stopped_deploy_flag():
    try:
        info = os.lstat(STOPPED_DEPLOY_FLAG)
    except FileNotFoundError:
        return False
    if not (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600):
        raise ValueError("/etc/bojin/allow-deploy-when-stopped must be a root-owned 0600 regular file")
    STOPPED_DEPLOY_FLAG.unlink()
    syslog.syslog(syslog.LOG_INFO, "lean-ritual-deploy: consumed /etc/bojin/allow-deploy-when-stopped")
    print("Consumed one-shot /etc/bojin/allow-deploy-when-stopped authorization", flush=True)
    return True


def verify_service_unit(check_active_state=True):
    output = subprocess.check_output(
        ["/usr/bin/systemctl", "show", "bojin.service", "--property=LoadState", "--property=ActiveState"],
        text=True, stdin=subprocess.DEVNULL,
    )
    properties = dict(line.split("=", 1) for line in output.strip().splitlines() if "=" in line)
    if properties.get("LoadState") != "loaded":
        raise ValueError("bojin.service unit must exist before deployment")
    if not check_active_state:
        return
    state = properties.get("ActiveState", "unknown")
    if state in ALLOWED_SERVICE_STATES:
        return
    if state in STOPPED_SERVICE_STATES:
        if consume_stopped_deploy_flag():
            return
        raise ValueError(
            f"bojin.service is {state}; start it first or create root-owned 0600 /etc/bojin/allow-deploy-when-stopped to authorize one deployment"
        )
    raise ValueError("bojin.service is in an unsupported state: " + state)


def stage_release(stream, releases_dir, timeout=UPLOAD_TIMEOUT):
    def handle_timeout(signum, frame):
        raise TimeoutError("Timed out receiving release archive")

    previous_handler = signal.signal(signal.SIGALRM, handle_timeout)
    incoming = Path(tempfile.mkdtemp(prefix=".incoming-", dir=releases_dir))
    candidate = None
    signal.alarm(timeout)
    try:
        metadata = unpack_release(stream, incoming)
        revision = metadata["revision"]
        candidate = releases_dir / f"{revision}-{time.time_ns()}-{os.getpid()}"
        incoming.rename(candidate)
        return candidate, metadata
    except BaseException:
        if candidate is not None and candidate.exists():
            shutil.rmtree(candidate, ignore_errors=True)
        raise
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)
        if incoming.exists():
            shutil.rmtree(incoming, ignore_errors=True)


def point_current(current, target):
    temporary = current.with_name(current.name + ".next")
    if temporary.exists() or temporary.is_symlink():
        temporary.unlink()
    temporary.symlink_to(target)
    os.replace(temporary, current)


def activate(candidate, current, stop, start, healthy, backup):
    if not current.is_symlink() or not current.resolve().is_dir():
        raise ValueError("Complete the one-time symlink setup first")
    previous = current.resolve()
    stopped = False
    try:
        stop()
        stopped = True
        backup(previous)
        point_current(current, candidate)
        start()
        if not healthy():
            raise RuntimeError("New release did not become healthy")
        # Called under the maintenance lock; only successful activation changes rollback target.
        point_current(current.with_name("bojin-previous"), previous)
    except BaseException:
        if stopped:
            try:
                try:
                    stop()
                finally:
                    point_current(current, previous)
                start()
                if not healthy(rollback=True):
                    raise RuntimeError("Deployment failed and previous code did not recover; investigate on host")
            except BaseException as rollback_error:
                notify_alert("deploy failed and rollback did not recover; investigate bojin.service")
                if isinstance(rollback_error, RuntimeError) and str(rollback_error) == "Deployment failed and previous code did not recover; investigate on host":
                    raise rollback_error from None
                raise RuntimeError("Deployment failed and previous code did not recover; investigate on host") from rollback_error
        raise


def command(*args):
    # Uploaded programs are only run through runuser below, never this root helper.
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL)


def take_custody_tree(root, expected_uid=None):
    """Validate untrusted staged tree top-down without following symlinks and take root custody."""
    root = Path(root)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    odir = getattr(os, "O_DIRECTORY", 0)
    enforce_uid = (os.getuid() == 0 and expected_uid is not None)

    def claim_dir(dir_path):
        dfd = os.open(dir_path, os.O_RDONLY | odir | nofollow)
        try:
            fst = os.fstat(dfd)
            if not stat.S_ISDIR(fst.st_mode):
                raise ValueError("Refusing non-directory in backup staging")
            if enforce_uid and fst.st_uid != expected_uid:
                raise ValueError("Refusing unexpected owner on staged backup directory")
            os.chown(dir_path, 0, 0, follow_symlinks=False)
            os.fchmod(dfd, 0o700)
            lst = os.lstat(dir_path)
            if (lst.st_dev, lst.st_ino) != (fst.st_dev, fst.st_ino):
                raise ValueError("Staged backup directory changed during custody handoff")
        finally:
            os.close(dfd)

        entries = sorted(os.listdir(dir_path))
        for name in entries:
            child = dir_path / name
            lst = os.lstat(child)
            if stat.S_ISLNK(lst.st_mode):
                raise ValueError("Refusing symlink inside backup")
            if stat.S_ISDIR(lst.st_mode):
                claim_dir(child)
            elif stat.S_ISREG(lst.st_mode):
                cfd = os.open(child, os.O_RDONLY | nofollow)
                try:
                    cfst = os.fstat(cfd)
                    if not stat.S_ISREG(cfst.st_mode):
                        raise ValueError("Refusing non-regular file inside backup")
                    if cfst.st_nlink != 1:
                        raise ValueError("Refusing multi-linked file in untrusted backup staging")
                    if enforce_uid and cfst.st_uid != expected_uid:
                        raise ValueError("Refusing unexpected owner on staged backup file")
                    os.chown(child, 0, 0, follow_symlinks=False)
                    os.fchmod(cfd, 0o600)
                    clst = os.lstat(child)
                    if (clst.st_dev, clst.st_ino) != (cfst.st_dev, cfst.st_ino):
                        raise ValueError("Staged backup file changed during custody handoff")
                finally:
                    os.close(cfd)
            else:
                raise ValueError("Refusing special file inside backup")

    claim_dir(root)


def chown_root_tree(root):
    take_custody_tree(root)


def copy_regular_file_verified(src_path, dst_path, expected_size, expected_sha):
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    src_fd = os.open(src_path, os.O_RDONLY | nofollow)
    dst_fd = None
    try:
        src_st = os.fstat(src_fd)
        if not stat.S_ISREG(src_st.st_mode):
            raise ValueError("Source blob must be a regular file")
        dst_fd = os.open(dst_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow, 0o600)
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(src_fd, 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(dst_fd, view)
                view = view[written:]
            digest.update(chunk)
            total += len(chunk)
        os.fchmod(dst_fd, 0o600)
        os.fsync(dst_fd)
    except BaseException:
        if dst_fd is not None:
            os.close(dst_fd)
            dst_fd = None
        Path(dst_path).unlink(missing_ok=True)
        raise
    finally:
        os.close(src_fd)
        if dst_fd is not None:
            os.close(dst_fd)
    if total != expected_size or digest.hexdigest() != expected_sha:
        Path(dst_path).unlink(missing_ok=True)
        raise ValueError("Copied blob checksum mismatch")


def materialize_and_verify_snapshot(snapshot_dir, data_dir, by_sha256, target_dev, verify_full=True,
                                    prelinked_by_id=None, prelinked_by_sha=None):
    snapshot_dir = Path(snapshot_dir)
    data_path = Path(data_dir).resolve()
    blobs_dir = snapshot_dir / "blobs"
    manifest_path = snapshot_dir / "manifest.json"
    if (snapshot_dir.is_symlink() or not snapshot_dir.is_dir()
            or blobs_dir.is_symlink() or not blobs_dir.is_dir()
            or manifest_path.is_symlink() or not manifest_path.is_file()):
        raise ValueError("Invalid snapshot layout")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("version") != 1 or not isinstance(manifest.get("files"), list):
        if not verify_full:
            return
        raise ValueError("Unsupported snapshot manifest")

    expected_uid = os.getuid()
    prelinked_by_id = prelinked_by_id or {}
    prelinked_by_sha = prelinked_by_sha or {}
    seen_names = set()
    manifest_sizes = {}
    for item in manifest["files"]:
        if not isinstance(item, dict):
            raise ValueError("Invalid snapshot manifest entry")
        name = item.get("name")
        size = item.get("size")
        sha = item.get("sha256")
        is_db = name in DATABASE_NAMES
        is_blob = isinstance(name, str) and bool(BLOB_PATH_RE.fullmatch(name))
        if (not (is_db or is_blob) or name in seen_names
                or not isinstance(size, int) or isinstance(size, bool) or size < 0
                or not isinstance(sha, str) or not SHA256_RE.fullmatch(sha)):
            raise ValueError("Unsafe or invalid snapshot manifest entry")
        seen_names.add(name)
        manifest_sizes[name] = size
        dest = snapshot_dir / name

        if is_db:
            if not verify_full:
                continue
            if dest.is_symlink() or not dest.is_file():
                raise ValueError("Snapshot database must be a regular file")
            if Path(str(dest) + "-wal").exists():
                raise ValueError("Snapshot contains a WAL sidecar")
            if dest.lstat().st_size != size or sha256_file(dest) != sha:
                raise ValueError("Snapshot checksum mismatch: " + name)
            continue

        blob_id = name[6:]
        live_blob = data_path / "blobs" / blob_id
        live_id = None
        try:
            live_st = live_blob.lstat()
            if stat.S_ISREG(live_st.st_mode):
                live_id = (live_st.st_dev, live_st.st_ino)
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
            elif by_sha256 and sha in by_sha256 and by_sha256[sha][0] == size:
                # Legacy transition: replace copied blob with a verified hardlink to an existing snapshot.
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
                        tmp_link = blobs_dir / (".dedup-" + blob_id)
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

        # Deferred blob: move from already-verified root-only prelink stage, link, or copy+fsync.
        materialized = False
        secured = prelinked_by_id.get(blob_id)
        if secured is not None and secured[0] == size and secured[1] == sha:
            sec_path = secured[2]
            if sec_path.exists() and not sec_path.is_symlink():
                try:
                    os.replace(sec_path, dest)
                    dst_st = dest.lstat()
                    if stat.S_ISREG(dst_st.st_mode) and dst_st.st_size == size and sha256_file(dest) == sha:
                        materialized = True
                except (OSError, ValueError):
                    dest.unlink(missing_ok=True)
        if not materialized and sha in prelinked_by_sha and prelinked_by_sha[sha][0] == size:
            sec_path = prelinked_by_sha[sha][1]
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
            copy_regular_file_verified(live_blob, dest, size, sha)

    if not verify_full:
        return

    if "bojin.db" not in seen_names:
        raise ValueError("Snapshot has no application database")
    for entry in blobs_dir.iterdir():
        if entry.is_symlink() or not entry.is_file() or ("blobs/" + entry.name) not in seen_names:
            raise ValueError("Unexpected file in snapshot blobs: " + entry.name)

    with tempfile.TemporaryDirectory(prefix="bojin-verify-") as tmpdir:
        tmp_path = Path(tmpdir)
        for db_name in DATABASE_NAMES:
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
                    for blob_id, blob_size in conn.execute("SELECT id, size FROM blobs"):
                        rel = "blobs/" + str(blob_id)
                        if (not isinstance(blob_id, str) or not BLOB_ID_RE.fullmatch(blob_id)
                                or rel not in seen_names
                                or (blobs_dir / blob_id).lstat().st_size != blob_size):
                            raise ValueError("Snapshot is missing a referenced photo")
            finally:
                conn.close()


def snapshot(previous, prelink_stage=None):
    if BACKUPS.is_symlink():
        raise ValueError("Refusing symlink deploy backup directory")
    BACKUPS.mkdir(mode=0o710, parents=True, exist_ok=True)
    import pwd
    app = pwd.getpwnam("bojin")
    os.chown(BACKUPS, 0, app.pw_gid)
    BACKUPS.chmod(0o710)
    stamp = time.strftime("%Y%m%dT%H%M%SZ-", time.gmtime())
    custody = Path(tempfile.mkdtemp(prefix=".stage-" + stamp, dir=BACKUPS))
    os.chown(custody, 0, 0, follow_symlinks=False)
    custody.chmod(0o700)
    work = Path(tempfile.mkdtemp(prefix=".work-" + stamp, dir=BACKUPS))
    published = BACKUPS / work.name.removeprefix(".work-")
    try:
        os.chown(work, app.pw_uid, app.pw_gid)
        work.chmod(0o700)
        target_dev = custody.stat().st_dev
        supports_defer = release_supports_defer_blobs(previous)
        if prelink_stage is not None:
            prelinked_by_id, prelinked_by_sha = prelink_stage
            _, by_sha256 = index_existing_blobs((BACKUPS, DAILY_BACKUPS), target_dev)
        elif supports_defer:
            prelink_dir = custody / "prelinked"
            prelink_dir.mkdir(mode=0o700)
            prelinked_by_id, prelinked_by_sha = prepare_prelinked_blobs(DATA, (BACKUPS, DAILY_BACKUPS), prelink_dir)
            _, by_sha256 = index_existing_blobs((BACKUPS, DAILY_BACKUPS), target_dev)
        else:
            prelinked_by_id, prelinked_by_sha = {}, {}
            _, by_sha256 = index_existing_blobs((BACKUPS, DAILY_BACKUPS), target_dev)

        use_defer = supports_defer and bool(prelinked_by_sha)
        dedup_index = work / "dedup-index.json"
        if use_defer:
            dedup_index.write_text(
                json.dumps({"version": 1, "sha256": {h: sz for h, (sz, _) in prelinked_by_sha.items()}}),
                encoding="utf-8",
            )
            os.chown(dedup_index, 0, app.pw_gid, follow_symlinks=False)
            dedup_index.chmod(0o640)
            backup_args = ("backup", str(work / "snapshot"), "--defer-blobs", str(dedup_index))
        else:
            backup_args = ("backup", str(work / "snapshot"))
        for arguments in [backup_args, ("ledger", str(work / "deletions.json"))]:
            command("/usr/sbin/runuser", "-u", "bojin", "--", "/usr/bin/env", "-i",
                    "PATH=/usr/bin:/bin", "DATA_DIR=" + str(DATA), "/usr/bin/node",
                    str(previous / "scripts/data-backup.js"), *arguments)

        # Move untrusted bojin output under root-only custody before validation and ownership transfer.
        drop = custody / "drop"
        work.rename(drop)
        work = None
        staged_index = drop / "dedup-index.json"
        if staged_index.is_symlink():
            raise ValueError("Refusing symlink dedup index in staged backup")
        staged_index.unlink(missing_ok=True)
        take_custody_tree(drop, expected_uid=app.pw_uid)

        pub_stage = custody / "pub"
        pub_stage.mkdir(mode=0o700)
        os.chown(pub_stage, 0, 0, follow_symlinks=False)
        (drop / "snapshot").rename(pub_stage / "snapshot")
        (drop / "deletions.json").rename(pub_stage / "deletions.json")
        (pub_stage / "snapshot").chmod(0o700)
        (pub_stage / "deletions.json").chmod(0o600)

        if use_defer:
            materialize_and_verify_snapshot(
                pub_stage / "snapshot", DATA, by_sha256, target_dev, verify_full=True,
                prelinked_by_id=prelinked_by_id, prelinked_by_sha=prelinked_by_sha,
            )
        elif by_sha256:
            materialize_and_verify_snapshot(pub_stage / "snapshot", DATA, by_sha256, target_dev, verify_full=False)

        sync_tree_durable(pub_stage)
        if published.exists() or published.is_symlink():
            raise FileExistsError("Deploy snapshot destination already exists")
        pub_stage.rename(published)
        fsync_dir(BACKUPS)
    finally:
        if work is not None and work.exists():
            shutil.rmtree(work, ignore_errors=True)
        if custody.exists():
            shutil.rmtree(custody, ignore_errors=True)
    print("Pre-deployment snapshot and deletion ledger saved on host", flush=True)
    return published


_SNAPSHOT_IMPL = snapshot


@contextlib.contextmanager
def maintenance_lock():
    lock_dir = LOCK.parent
    try:
        dir_info = os.lstat(lock_dir)
    except FileNotFoundError:
        command("/usr/bin/install", "-d", "-o", "root", "-g", "root", "-m", "0755", str(lock_dir))
        dir_info = os.lstat(lock_dir)
    if stat.S_ISLNK(dir_info.st_mode) or not stat.S_ISDIR(dir_info.st_mode):
        raise ValueError(f"Refusing symlink or non-directory maintenance lock path: {lock_dir}")
    if dir_info.st_uid != 0:
        raise ValueError(f"Refusing non-root maintenance lock directory: {lock_dir}")

    try:
        lock_info = os.lstat(LOCK)
    except FileNotFoundError:
        lock_info = None
    if lock_info is not None:
        if stat.S_ISLNK(lock_info.st_mode) or not stat.S_ISREG(lock_info.st_mode):
            raise ValueError(f"Refusing symlink or non-regular maintenance lock: {LOCK}")
        if lock_info.st_uid != 0:
            raise ValueError(f"Refusing non-root maintenance lock: {LOCK}")

    open_flags = os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    try:
        new_fd = os.open(LOCK, open_flags, 0o600)
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ValueError(f"Refusing symlink maintenance lock: {LOCK}") from error
        raise

    legacy_fd = None
    try:
        fd_info = os.fstat(new_fd)
        if not stat.S_ISREG(fd_info.st_mode) or fd_info.st_uid != 0:
            raise ValueError(f"Refusing unsafe maintenance lock: {LOCK}")
        fcntl.flock(new_fd, fcntl.LOCK_EX)

        try:
            legacy_fd = os.open(LEGACY_LOCK, open_flags, 0o600)
        except OSError as error:
            if error.errno != errno.EACCES:
                raise
            retry_flags = os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
            legacy_fd = os.open(LEGACY_LOCK, retry_flags)
            warning = (
                f"lean-ritual-deploy: O_CREAT on legacy lock {LEGACY_LOCK} failed with EACCES "
                f"(fs.protected_regular); opened existing file without O_CREAT for flock"
            )
            syslog.syslog(syslog.LOG_WARNING, warning)
            print("Warning: " + warning, file=sys.stderr, flush=True)
        legacy_info = os.fstat(legacy_fd)
        if not stat.S_ISREG(legacy_info.st_mode):
            raise ValueError(f"Refusing non-regular legacy maintenance lock: {LEGACY_LOCK}")
        fcntl.flock(legacy_fd, fcntl.LOCK_EX)

        yield
    finally:
        if legacy_fd is not None:
            os.close(legacy_fd)
        os.close(new_fd)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise ValueError("Install as a root-owned no-argument receiver")
    os.umask(0o022)
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ValueError("This build targets Linux x64")
    version = subprocess.check_output(["/usr/bin/node", "-p", "process.versions.node"], text=True).strip()
    if version.split(".")[0] != "24":
        raise ValueError("Host requires Node 24")
    if not ENV_FILE.is_file() or not DATA.is_dir():
        raise ValueError("Complete and verify the one-time host setup first")
    verify_service_unit(check_active_state=False)
    RELEASES.mkdir(mode=0o755, exist_ok=True)
    dedup_enabled = release_supports_defer_blobs(CURRENT)
    try:
        check_free_space(DATA, RELEASES, BACKUPS, backup_roots=(BACKUPS, DAILY_BACKUPS), dedup_enabled=dedup_enabled)
    except ValueError:
        send_throttled_disk_alert(
            BACKUPS,
            "crit",
            "CRITICAL: deploy blocked by low disk space; free space before deploys and backups fail",
        )
        raise
    candidate = None
    prelink_custody = None
    try:
        with maintenance_lock():
            # Staging shares the maintenance lock with retention.
            candidate, metadata = stage_release(sys.stdin.buffer, RELEASES)
            revision = metadata["revision"]
            dedup_enabled = release_supports_defer_blobs(CURRENT)
            prelink_stage = None
            prelinked_by_id = None
            if dedup_enabled and BACKUPS.is_dir() and not BACKUPS.is_symlink():
                prelink_custody = Path(tempfile.mkdtemp(prefix=".prelink-", dir=BACKUPS))
                os.chown(prelink_custody, 0, 0, follow_symlinks=False)
                prelink_custody.chmod(0o700)
                prelinked_by_id, prelinked_by_sha = prepare_prelinked_blobs(
                    DATA, (BACKUPS, DAILY_BACKUPS), prelink_custody,
                )
                prelink_stage = (prelinked_by_id, prelinked_by_sha)
            try:
                check_free_space(
                    DATA, RELEASES, BACKUPS,
                    backup_roots=(BACKUPS, DAILY_BACKUPS),
                    dedup_enabled=dedup_enabled,
                    prelinked_by_id=prelinked_by_id,
                )
            except ValueError:
                send_throttled_disk_alert(
                    BACKUPS,
                    "crit",
                    "CRITICAL: deploy blocked by low disk space after staging; free space before deploys and backups fail",
                )
                raise
            verify_service_unit(check_active_state=True)

            def healthy(rollback=False):
                # Ignore inherited HTTP proxies only for this loopback health check.
                client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                for _ in range(30):
                    try:
                        active = subprocess.run(["/usr/bin/systemctl", "is-active", "--quiet", "bojin.service"]).returncode == 0
                        with client.open("http://127.0.0.1:8080/api/health", timeout=2) as response:
                            result = json.load(response)
                        if active and result.get("ok") is True and (rollback or result.get("revision") == revision):
                            return True
                    except (OSError, ValueError):
                        pass
                    time.sleep(1)
                return False

            def start_service():
                subprocess.run(["/usr/bin/systemctl", "reset-failed", "bojin.service"], stdin=subprocess.DEVNULL)
                command("/usr/bin/systemctl", "start", "bojin.service")

            backup_fn = (
                (lambda prev: snapshot(prev, prelink_stage=prelink_stage))
                if prelink_stage is not None and snapshot is _SNAPSHOT_IMPL
                else snapshot
            )
            activate(candidate, CURRENT,
                     lambda: command("/usr/bin/systemctl", "stop", "bojin.service"),
                     start_service, healthy, backup_fn)
    except BaseException:
        if candidate is not None and candidate.exists() and (not CURRENT.is_symlink() or CURRENT.resolve() != candidate.resolve()):
            shutil.rmtree(candidate, ignore_errors=True)
        raise
    finally:
        if prelink_custody is not None and prelink_custody.exists():
            shutil.rmtree(prelink_custody, ignore_errors=True)
    check_disk_usage_guard(DATA, RELEASES, BACKUPS)
    print("Deployed " + revision, flush=True)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        # Backup/health failures may include private filenames. Keep details on-host.
        syslog.syslog(syslog.LOG_ERR, "lean-ritual-deploy: " + repr(error))
        print("Deployment failed; inspect the host and retained releases/backups. No automatic database restore was performed.", file=sys.stderr)
        sys.exit(1)
