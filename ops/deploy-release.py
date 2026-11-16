#!/usr/bin/python3
"""Root-owned, no-argument SSH receiver. Never execute uploaded code as root."""
import contextlib
import errno
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import signal
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
LOCK = Path("/run/bojin/maintenance.lock")
# Transition compatibility (one release): also lock the legacy path after LOCK so an
# un-upgraded host helper or manual command cannot run maintenance concurrently.
# Remove in the next release once /etc/tmpfiles.d/bojin.conf, lean-ritual-deploy,
# bojin-backup, bojin-watchdog and operator runbooks on the host all use LOCK.
LEGACY_LOCK = Path("/run/lock/bojin-maintenance.lock")
ALERT = Path("/usr/local/libexec/bojin-alert")
ENV_FILE = Path("/etc/bojin/environment")
STOPPED_DEPLOY_FLAG = Path("/etc/bojin/allow-deploy-when-stopped")
ALLOWED = {"server.js", "package.json", "package-lock.json", ".release.json", "lib", "scripts", "public", "node_modules"}
MAX_BYTES = 600 * 1024 * 1024
MIN_FREE_HEADROOM = (3 * 1024 ** 3) // 2
UPLOAD_TIMEOUT = 300
ALLOWED_SERVICE_STATES = {"active", "activating", "reloading", "failed"}
STOPPED_SERVICE_STATES = {"inactive", "deactivating"}


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
    for required in ["server.js", "package.json", "package-lock.json", "public/index.html",
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
            subprocess.run([str(ALERT), message], check=False, stdin=subprocess.DEVNULL, timeout=30)
        except (OSError, subprocess.SubprocessError) as error:
            syslog.syslog(syslog.LOG_ERR, "lean-ritual-deploy alert failed: " + repr(error))


def data_size(path):
    total = 0
    for root, _, files in os.walk(Path(path).resolve()):
        for name in files:
            try:
                total += (Path(root) / name).lstat().st_size
            except FileNotFoundError:
                pass
    return total


def existing_parent(path):
    current = Path(path)
    while not current.exists():
        current = current.parent
    return current


def check_free_space(data_dir, *targets):
    required = data_size(data_dir) + MIN_FREE_HEADROOM
    for target in targets:
        if shutil.disk_usage(existing_parent(target)).free <= required:
            raise ValueError("Need more than DATA_DIR size + 1.5 GiB free before staging and snapshot")


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


def chown_root_tree(root):
    root = Path(root)
    if root.is_symlink():
        raise ValueError("Refusing symlink backup directory")
    os.chown(root, 0, 0, follow_symlinks=False)
    for parent, directories, files in os.walk(root, followlinks=False):
        parent_path = Path(parent)
        if parent_path.is_symlink():
            raise ValueError("Refusing symlink inside backup")
        os.chown(parent_path, 0, 0, follow_symlinks=False)
        for name in directories + files:
            entry = parent_path / name
            if entry.is_symlink():
                raise ValueError("Refusing symlink inside backup")
            os.chown(entry, 0, 0, follow_symlinks=False)


def snapshot(previous):
    if BACKUPS.is_symlink():
        raise ValueError("Refusing symlink deploy backup directory")
    BACKUPS.mkdir(mode=0o710, parents=True, exist_ok=True)
    import pwd
    app = pwd.getpwnam("bojin")
    os.chown(BACKUPS, 0, app.pw_gid)
    BACKUPS.chmod(0o710)
    stamp = time.strftime("%Y%m%dT%H%M%SZ-", time.gmtime())
    work = Path(tempfile.mkdtemp(prefix=".work-" + stamp, dir=BACKUPS))
    published = BACKUPS / work.name.removeprefix(".work-")
    try:
        os.chown(work, app.pw_uid, app.pw_gid)
        work.chmod(0o700)
        for arguments in [("backup", str(work / "snapshot")), ("ledger", str(work / "deletions.json"))]:
            command("/usr/sbin/runuser", "-u", "bojin", "--", "/usr/bin/env", "-i",
                    "PATH=/usr/bin:/bin", "DATA_DIR=" + str(DATA), "/usr/bin/node",
                    str(previous / "scripts/data-backup.js"), *arguments)
        chown_root_tree(work)
        work.chmod(0o700)
        (work / "snapshot").chmod(0o700)
        (work / "deletions.json").chmod(0o600)
        if published.exists() or published.is_symlink():
            raise FileExistsError("Deploy snapshot destination already exists")
        work.rename(published)
    except BaseException:
        if work.exists():
            shutil.rmtree(work, ignore_errors=True)
        raise
    print("Pre-deployment snapshot and deletion ledger saved on host", flush=True)
    return published


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
            if error.errno == errno.EACCES:
                warning = (
                    f"lean-ritual-deploy: ignoring EACCES opening legacy lock {LEGACY_LOCK} "
                    f"(fs.protected_regular); continuing with {LOCK} only"
                )
                syslog.syslog(syslog.LOG_WARNING, warning)
                print("Warning: " + warning, file=sys.stderr, flush=True)
            else:
                raise
        else:
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
    check_free_space(DATA, RELEASES, BACKUPS)
    candidate = None
    try:
        with maintenance_lock():
            # Staging shares the maintenance lock with retention.
            candidate, metadata = stage_release(sys.stdin.buffer, RELEASES)
            revision = metadata["revision"]
            check_free_space(DATA, RELEASES, BACKUPS)
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

            activate(candidate, CURRENT,
                     lambda: command("/usr/bin/systemctl", "stop", "bojin.service"),
                     start_service, healthy, snapshot)
    except BaseException:
        if candidate is not None and candidate.exists() and (not CURRENT.is_symlink() or CURRENT.resolve() != candidate.resolve()):
            shutil.rmtree(candidate, ignore_errors=True)
        raise
    print("Deployed " + revision, flush=True)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        # Backup/health failures may include private filenames. Keep details on-host.
        syslog.syslog(syslog.LOG_ERR, "lean-ritual-deploy: " + repr(error))
        print("Deployment failed; inspect the host and retained releases/backups. No automatic database restore was performed.", file=sys.stderr)
        sys.exit(1)
