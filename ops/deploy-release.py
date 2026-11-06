#!/usr/bin/python3
"""Root-owned, no-argument SSH receiver. Never execute uploaded code as root."""
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
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
LOCK = Path("/run/lock/bojin-maintenance.lock")
ALLOWED = {"server.js", "package.json", "package-lock.json", ".release.json", "lib", "scripts", "public", "node_modules"}
MAX_BYTES = 600 * 1024 * 1024


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
    except BaseException:
        if stopped:
            stop()
            point_current(current, previous)
            start()
            if not healthy(rollback=True):
                raise RuntimeError("Deployment failed and previous code did not recover; investigate on host") from None
        raise


def command(*args):
    # Uploaded programs are only run through runuser below, never this root helper.
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL)


def snapshot(previous):
    BACKUPS.mkdir(mode=0o710, parents=True, exist_ok=True)
    import pwd
    app = pwd.getpwnam("bojin")
    os.chown(BACKUPS, 0, app.pw_gid)
    BACKUPS.chmod(0o710)
    directory = Path(tempfile.mkdtemp(prefix=time.strftime("%Y%m%dT%H%M%SZ-", time.gmtime()), dir=BACKUPS))
    os.chown(directory, app.pw_uid, app.pw_gid)
    for arguments in [("backup", str(directory / "snapshot")), ("ledger", str(directory / "deletions.json"))]:
        command("/usr/sbin/runuser", "-u", "bojin", "--", "/usr/bin/env", "-i",
                "PATH=/usr/bin:/bin", "DATA_DIR=" + str(DATA), "/usr/bin/node",
                str(previous / "scripts/data-backup.js"), *arguments)
    print("Pre-deployment snapshot and deletion ledger saved on host", flush=True)


def main():
    if os.geteuid() != 0 or len(sys.argv) != 1:
        raise ValueError("Install as a root-owned no-argument receiver")
    os.umask(0o022)
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise ValueError("This build targets Linux x64")
    version = subprocess.check_output(["/usr/bin/node", "-p", "process.versions.node"], text=True).strip()
    if version.split(".")[0] != "24":
        raise ValueError("Host requires Node 24")
    if not Path("/etc/bojin/environment").is_file() or not DATA.is_dir():
        raise ValueError("Complete and verify the one-time host setup first")
    RELEASES.mkdir(mode=0o755, exist_ok=True)
    with LOCK.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if subprocess.run(["/usr/bin/systemctl", "is-active", "--quiet", "bojin.service"]).returncode:
            raise ValueError("App must be running before deployment")
        if shutil.disk_usage(RELEASES).free < 1024 ** 3:
            raise ValueError("Need at least 1 GiB free before staging and snapshot; check backup capacity too")
        incoming = Path(tempfile.mkdtemp(prefix=".incoming-", dir=RELEASES))
        try:
            metadata = unpack_release(sys.stdin.buffer, incoming)
            revision = metadata["revision"]
            candidate = RELEASES / (revision + "-" + str(time.time_ns()))
            incoming.rename(candidate)
        finally:
            if incoming.exists():
                shutil.rmtree(incoming)

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

        activate(candidate, CURRENT,
                 lambda: command("/usr/bin/systemctl", "stop", "bojin.service"),
                 lambda: command("/usr/bin/systemctl", "start", "bojin.service"), healthy, snapshot)
        print("Deployed " + revision, flush=True)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        # Backup/health failures may include private filenames. Keep details on-host.
        syslog.syslog(syslog.LOG_ERR, "lean-ritual-deploy: " + repr(error))
        print("Deployment failed; inspect the host and retained releases/backups. No automatic database restore was performed.", file=sys.stderr)
        sys.exit(1)
