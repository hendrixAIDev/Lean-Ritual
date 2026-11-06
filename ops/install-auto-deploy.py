#!/usr/bin/python3
"""Inspect existing native hosting; --apply enables the reviewed SSH receiver."""
import argparse
import base64
import fcntl
import importlib.util
import os
from pathlib import Path
import pwd
import shlex
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("deploy", ROOT / "deploy-release.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


def run(*arguments):
    subprocess.run(arguments, check=True, stdin=subprocess.DEVNULL)


def setting(name):
    return subprocess.check_output(["/usr/bin/systemctl", "show", "bojin.service", "--property=" + name, "--value"], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--public-key", type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0: raise ValueError("Run this preflight as root")
    if setting("User") != "bojin" or setting("WorkingDirectory") != "/opt/bojin":
        raise ValueError("Actual service differs from expected native setup; review it first")
    if setting("ActiveState") != "active": raise ValueError("App must be active before setup")
    executable = setting("ExecStart")
    if "path=/usr/bin/node" not in executable or "server.js" not in executable:
        raise ValueError("Review the actual service executable first")
    config = Path("/etc/bojin/environment") if deploy.CURRENT.is_symlink() else deploy.CURRENT / ".env"
    if not config.is_file(): raise ValueError("Expected private environment file missing")
    values = {}
    for line in config.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            tokens = shlex.split(value, comments=True)
            values[key.strip()] = tokens[0] if len(tokens) == 1 else ""
    expected = {"HOST": "127.0.0.1", "PORT": "8080", "DATA_DIR": "/var/lib/bojin",
                "AUTH_BASE_URL": "https://leanritual.app", "COOKIE_SECURE": "1", "TRUST_PROXY": "1", "MAIL_MODE": "smtp"}
    for key, value in expected.items():
        if values.get(key) != value: raise ValueError("Review configured " + key + " before setup")
    if not setting("EnvironmentFiles").startswith(str(config) + " "):
        raise ValueError("Review systemd environment file overrides first")
    if not deploy.DATA.is_dir() or not (deploy.CURRENT / "scripts/data-backup.js").is_file():
        raise ValueError("Missing existing private data or backup tool")
    if subprocess.check_output(["/usr/bin/node", "-p", "process.versions.node"], text=True).split(".")[0] != "24":
        raise ValueError("Node 24 required")
    if shutil.disk_usage("/opt").free < 1024 ** 3: raise ValueError("Need at least 1 GiB free plus snapshot capacity")
    print("Native service/configuration preflight passed; secret values were not printed")
    if not args.apply:
        print("No host changes made. Use --apply --public-key FILE after reviewing docs/GITHUB-DEPLOYMENT.md")
        return
    if not args.public_key: raise ValueError("Supply an Ed25519 public key file, never a private key")
    pieces = args.public_key.read_text().strip().split()
    if len(pieces) not in (2, 3) or pieces[0] != "ssh-ed25519": raise ValueError("Expected one plain Ed25519 public key")
    base64.b64decode(pieces[1], validate=True)
    run("/usr/bin/ssh-keygen", "-l", "-f", str(args.public_key))
    account = "bojin-deploy"
    try: user = pwd.getpwnam(account)
    except KeyError:
        run("/usr/sbin/useradd", "--system", "--create-home", "--home-dir", "/var/lib/bojin-deploy", "--shell", "/bin/sh", account)
        user = pwd.getpwnam(account)
    if user.pw_dir != "/var/lib/bojin-deploy": raise ValueError("Existing deployment account has unexpected home")
    home = Path(user.pw_dir)
    if home.is_symlink() or (home / ".ssh").is_symlink() or (home / ".ssh/authorized_keys").is_symlink():
        raise ValueError("Deployment home/key paths must not be symlinks")
    os.chown(home, 0, 0); home.chmod(0o755)
    ssh = home / ".ssh"
    ssh.mkdir(mode=0o755, exist_ok=True)
    os.chown(ssh, 0, 0); ssh.chmod(0o755)
    keys = ssh / "authorized_keys"
    key_line = 'restrict,command="sudo -n /usr/local/sbin/lean-ritual-deploy" ' + " ".join(pieces[:2]) + "\n"
    if keys.exists() and keys.read_text() != key_line:
        raise ValueError("Existing authorized_keys differs; review instead of overwriting")
    keys.write_text(key_line); os.chown(keys, 0, 0); keys.chmod(0o644)
    for source, target in [(ROOT / "deploy-release.py", Path("/usr/local/sbin/lean-ritual-deploy")),
                           (ROOT / "backup-service.sh", Path("/usr/local/libexec/bojin-backup"))]:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target); os.chown(target, 0, 0); target.chmod(0o755)
    sudoers = Path("/etc/sudoers.d/bojin-deploy")
    rule = 'bojin-deploy ALL=(root) NOPASSWD: /usr/local/sbin/lean-ritual-deploy ""\n'
    if sudoers.exists() and sudoers.read_text() != rule:
        raise ValueError("Existing deployment sudoers differs; review first")
    temporary = Path("/etc/sudoers.d/.bojin-deploy-check")
    temporary.write_text(rule); temporary.chmod(0o440)
    try:
        run("/usr/sbin/visudo", "-cf", str(temporary))
        temporary.replace(sudoers)
    finally: temporary.unlink(missing_ok=True)
    # Root-operated services execute only root-installed wrappers, never release scripts.
    shutil.copyfile(ROOT / "bojin-backup.service", "/etc/systemd/system/bojin-backup.service")
    Path("/etc/systemd/system/bojin-backup.service").chmod(0o644)
    with deploy.LOCK.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deploy.RELEASES.mkdir(mode=0o755, exist_ok=True)
        if not deploy.CURRENT.is_symlink():
            run("/usr/bin/systemctl", "stop", "bojin.service")
            try:
                deploy.snapshot(deploy.CURRENT)
                private = Path("/etc/bojin")
                private.mkdir(mode=0o750, exist_ok=True)
                os.chown(private, 0, pwd.getpwnam("bojin").pw_gid)
                target = private / "environment"
                if target.exists() and target.read_bytes() != config.read_bytes():
                    raise ValueError("Private environment destination differs; review first")
                shutil.copyfile(config, target)
                os.chown(target, 0, pwd.getpwnam("bojin").pw_gid); target.chmod(0o640)
                old = deploy.RELEASES / ("bootstrap-" + str(time.time_ns()))
                deploy.CURRENT.rename(old)
                deploy.point_current(deploy.CURRENT, old)
                dropin = Path("/etc/systemd/system/bojin.service.d")
                dropin.mkdir(mode=0o755, exist_ok=True)
                (dropin / "deployment.conf").write_text("[Service]\nEnvironmentFile=\nEnvironmentFile=/etc/bojin/environment\n")
            finally:
                run("/usr/bin/systemctl", "daemon-reload")
                run("/usr/bin/systemctl", "start", "bojin.service")
        else:
            run("/usr/bin/systemctl", "daemon-reload")
    print("Host receiver installed. No GitHub secrets, timer, firewall or retention settings were changed.")
    print("Check HTTPS health and login before enabling DEPLOY_ENABLED in GitHub.")


if __name__ == "__main__":
    try: main()
    except Exception as error:
        # Validation errors contain setting names only, never values.
        print("Setup stopped: " + str(error))
        raise SystemExit(1)
