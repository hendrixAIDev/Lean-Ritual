"""Exercise a real packaged Node runtime, persistent SQLite and offline backup."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import textwrap
import time
import unittest
import urllib.request

ROOT = Path(__file__).parents[1].resolve()
NODE_BIN = shutil.which("node")


def is_linux_x64_node24():
    if not NODE_BIN:
        return False
    try:
        runtime = json.loads(subprocess.check_output(
            [NODE_BIN, "-p", "JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch})"],
            text=True,
        ))
    except (OSError, subprocess.SubprocessError, ValueError):
        return False
    return runtime.get("node", "").split(".")[0] == "24" and (runtime.get("platform"), runtime.get("arch")) == ("linux", "x64")


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / ("ops/" + name + "-release.py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class RuntimeDeploymentTest(unittest.TestCase):
    @unittest.skipUnless(is_linux_x64_node24(), "Packaged runtime build requires Linux x64 with Node 24")
    def test_packaged_runtime_persistence_and_backup(self):
        deploy, package = module("deploy"), module("package")
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory).resolve()
            archive, candidate = temporary / "runtime.tar.gz", temporary / "release"
            candidate.mkdir()
            revision = "c" * 40
            package.package(ROOT, archive, revision)
            with archive.open("rb") as source:
                self.assertEqual(deploy.unpack_release(source, candidate)["revision"], revision)
            # Loading the packaged native library catches incompatible/missing optional dependencies.
            subprocess.run(["node", "-e", "require('sharp')"], cwd=candidate, check=True)
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            data = temporary / "data"
            env = {**os.environ, "DATA_DIR": str(data), "PORT": str(port), "HOST": "127.0.0.1",
                   "AUTH_BASE_URL": "http://127.0.0.1:" + str(port), "COOKIE_SECURE": "0", "TRUST_PROXY": "0",
                   "AUTH_SECRET": "disposable-deployment-test-secret-at-least-32-characters", "MAIL_MODE": "file", "OPENROUTER_API_KEY": ""}
            client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

            def start_and_check():
                with (temporary / "server.log").open("ab") as log:
                    process = subprocess.Popen(["node", "server.js"], cwd=candidate, env=env, stdout=log, stderr=log)
                try:
                    for _ in range(100):
                        if process.poll() is not None: self.fail("Packaged runtime failed to start")
                        try:
                            with client.open(env["AUTH_BASE_URL"] + "/api/health", timeout=1) as response:
                                self.assertEqual(json.load(response), {"ok": True, "revision": revision})
                            return
                        except OSError: time.sleep(0.05)
                    self.fail("Packaged runtime health timed out")
                finally:
                    process.terminate()
                    try: process.wait(timeout=10)
                    except subprocess.TimeoutExpired: process.kill(); process.wait()

            start_and_check()
            with sqlite3.connect(data / "bojin.db") as db:
                db.execute("INSERT INTO docs(path,uid,parent,data,updated) VALUES(?,?,?,?,?)",
                           ("disposable-deploy-marker", "test", "test", '{"test":true}', "2026-01-01"))
            subprocess.run(["node", "scripts/data-backup.js", "backup", str(temporary / "snapshot")], cwd=candidate, env=env, check=True, capture_output=True)
            subprocess.run(["node", "scripts/data-backup.js", "ledger", str(temporary / "deletions.json")], cwd=candidate, env=env, check=True, capture_output=True)
            start_and_check()
            with sqlite3.connect(data / "bojin.db") as db:
                self.assertEqual(db.execute("SELECT data FROM docs WHERE path='disposable-deploy-marker'").fetchone()[0], '{"test":true}')
            self.assertTrue((temporary / "snapshot/auth.sqlite").is_file())
            self.assertTrue((temporary / "snapshot/bojin.db").is_file())
            self.assertEqual(json.loads((temporary / "deletions.json").read_text())["version"], 1)


class BackupServiceRuntimeTest(unittest.TestCase):
    def run_backup_script(self, root, active_state="active", free_bytes=None, fail_backup=False, fail_start=False):
        bindir = root / "bin"
        bindir.mkdir(exist_ok=True)
        events = root / "events.log"
        lock_state = root / "lock.state"
        lock_file = root / "maintenance.lock"
        data_dir = root / "data"
        backup_root = root / "backups"
        offsite_dir = root / "offsite"
        app_dir = root / "app"
        data_dir.mkdir(exist_ok=True)
        offsite_dir.mkdir(exist_ok=True)
        if not app_dir.exists():
            app_dir.mkdir()
            (app_dir / "scripts").symlink_to(ROOT / "scripts")
            (app_dir / "lib").symlink_to(ROOT / "lib")

        if not (data_dir / "bojin.db").exists() and not fail_backup:
            with sqlite3.connect(data_dir / "bojin.db") as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE docs(path TEXT PRIMARY KEY, uid TEXT, parent TEXT, data TEXT, updated TEXT)")
                db.execute("CREATE TABLE blobs(id TEXT PRIMARY KEY, uid TEXT, mime TEXT, size INT, created TEXT)")
                db.execute("INSERT INTO docs VALUES('p1','u_1','p','{\"ok\":1}','2026-01-01')")

        def write_stub(name, body):
            target = bindir / name
            target.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + textwrap.dedent(body))
            target.chmod(0o755)

        write_stub("flock", f"""
            if [[ "${{1:-}}" == "-x" ]]; then
              echo "locked" > "{lock_state}"
              echo "flock:lock" >> "{events}"
            elif [[ "${{1:-}}" == "-u" ]]; then
              echo "unlocked" > "{lock_state}"
              echo "flock:unlock" >> "{events}"
            fi
        """)
        start_exit = "exit 1" if fail_start else ":"
        write_stub("systemctl", f"""
            if [[ "${{1:-}}" == "show" ]]; then
              echo "{active_state}"
            elif [[ "${{1:-}}" == "is-active" ]]; then
              [[ "{active_state}" == "active" ]]
            else
              echo "systemctl:$*" >> "{events}"
              if [[ "${{1:-}}" == "start" ]]; then
                {start_exit}
              fi
            fi
        """)
        write_stub("chown", f"""
            echo "chown:$*" >> "{events}"
        """)
        write_stub("runuser", f"""
            shift 3 # -u bojin --
            exec "$@"
        """)
        write_stub("rsync", f"""
            if ( : >&9 ) 2>/dev/null; then
              fd9="open"
            else
              fd9="closed"
            fi
            state=$(cat "{lock_state}" 2>/dev/null || echo "none")
            echo "rsync:lock=$state:fd9=$fd9:$*" >> "{events}"
        """)

        if free_bytes is not None:
            real_py = shutil.which("python3")
            write_stub("python3", f"""
                exec "{real_py}" -c '
import shutil, sys
from collections import namedtuple
U = namedtuple("U", ["total", "used", "free"])
shutil.disk_usage = lambda p: U({free_bytes} * 2, {free_bytes}, {free_bytes})
code = sys.stdin.read()
sys.argv = sys.argv[1:]
exec(compile(code, "<stdin>", "exec"))
' "$@"
            """)

        script_text = (ROOT / "ops/backup-service.sh").read_text()
        script_text = script_text.replace("/run/lock/bojin-maintenance.lock", str(lock_file))
        script_text = script_text.replace("/var/backups/bojin-deploy", str(app_dir / "deploy-backups"))
        script_text = script_text.replace("/opt/bojin", str(app_dir))
        script_text = script_text.replace("PATH=/usr/bin:/bin", f"PATH={Path(NODE_BIN).parent}:/usr/bin:/bin")
        script_text = script_text.replace("/usr/bin/node", NODE_BIN)
        harness = root / "backup-harness.sh"
        harness.write_text(script_text)
        harness.chmod(0o755)

        env = {
            **os.environ,
            "PATH": f"{bindir}:{os.environ.get('PATH', '')}",
            "DATA_DIR": str(data_dir),
            "BACKUP_ROOT": str(backup_root),
            "OFFSITE_DEST": f"backup@host:{offsite_dir}",
        }
        result = subprocess.run(["bash", str(harness)], env=env, text=True, capture_output=True)
        log = events.read_text().splitlines() if events.exists() else []
        return result, log, backup_root

    def test_releases_lock_before_rsync_chowns_root_and_handles_active_states(self):
        for state, expect_restart in [("active", True), ("activating", True), ("reloading", True), ("inactive", False)]:
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                result, log, backup_root = self.run_backup_script(root, active_state=state)
                self.assertEqual(result.returncode, 0, result.stderr)
                rsync_lines = [line for line in log if line.startswith("rsync:")]
                self.assertEqual(len(rsync_lines), 1)
                self.assertIn("rsync:lock=unlocked:fd9=closed:", rsync_lines[0])
                self.assertIn("--timeout=120", rsync_lines[0])
                self.assertIn("BatchMode=yes", rsync_lines[0])
                self.assertIn("ConnectTimeout=15", rsync_lines[0])
                self.assertIn("ServerAliveInterval=15", rsync_lines[0])
                self.assertIn("ServerAliveCountMax=3", rsync_lines[0])
                chown_root = [line for line in log if line.startswith("chown:") and "root:root" in line]
                self.assertTrue(chown_root, f"Expected root:root chown before publish, got {log}")
                starts = [line for line in log if line == "systemctl:start bojin.service"]
                if expect_restart:
                    self.assertEqual(len(starts), 1)
                    self.assertLess(log.index("systemctl:start bojin.service"), log.index(rsync_lines[0]))
                else:
                    self.assertEqual(starts, [])
                leftovers = [p.name for p in backup_root.iterdir() if p.name.startswith(".run-")]
                self.assertEqual(leftovers, [])

    def test_preflight_blocks_low_disk_before_stopping_service(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            result, log, _ = self.run_backup_script(root, active_state="active", free_bytes=1024 ** 3)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("systemctl:stop bojin.service", log)

    def test_failure_cleans_work_dir_and_restarts_activating_service(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            result, log, backup_root = self.run_backup_script(root, active_state="activating", fail_backup=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("systemctl:start bojin.service", log)
            leftovers = [p.name for p in backup_root.iterdir() if p.name.startswith(".run-")]
            self.assertEqual(leftovers, [])

    def test_backup_failure_plus_restart_failure_still_exits_nonzero(self):
        for fail_backup, fail_start in [(True, True), (False, True)]:
            with self.subTest(fail_backup=fail_backup, fail_start=fail_start), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                result, log, backup_root = self.run_backup_script(
                    root, active_state="activating", fail_backup=fail_backup, fail_start=fail_start
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("systemctl:start bojin.service", log)
                leftovers = [p.name for p in backup_root.iterdir() if p.name.startswith(".run-")]
                self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
