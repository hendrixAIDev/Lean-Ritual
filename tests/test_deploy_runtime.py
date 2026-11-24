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
    def run_backup_script(self, root, active_state="active", free_bytes=None, fail_backup=False, fail_start=False,
                          non_root_paths=None, disk_usage=None, extra_env=None, py_prelude=None, runuser_post_cmd=None):
        bindir = root / "bin"
        bindir.mkdir(exist_ok=True)
        events = root / "events.log"
        lock_state = root / "lock.state"
        lock_dir = root / "run-bojin"
        lock_file = lock_dir / "maintenance.lock"
        legacy_lock_dir = root / "run-lock"
        legacy_lock_dir.mkdir(exist_ok=True)
        legacy_lock_file = legacy_lock_dir / "bojin-maintenance.lock"
        non_root_json = json.dumps([str(p) for p in (non_root_paths or [])])
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

        real_py = shutil.which("python3")
        real_install = shutil.which("install") or "/usr/bin/install"
        write_stub("install", f"""
            echo "install:$*" >> "{events}"
            args=()
            while (($#)); do
              if [[ "$1" == "-o" || "$1" == "-g" ]]; then
                shift 2
              else
                args+=("$1")
                shift
              fi
            done
            exec "{real_install}" "${{args[@]}}"
        """)
        stat_stub = bindir / "stat"
        stat_stub.write_text(
            f"#!{real_py}\n"
            "import json, os, sys\n"
            f"NON_ROOT = set({non_root_json!r} and json.loads({non_root_json!r}))\n"
            "args = sys.argv[1:]\n"
            "if args[:2] == ['-c', '%u']:\n"
            "    target = args[-1]\n"
            "    os.lstat(target)\n"
            "    print(1001 if target in NON_ROOT else 0)\n"
            "    sys.exit(0)\n"
            "sys.exit(1)\n"
        )
        stat_stub.chmod(0o755)

        flock_stub = bindir / "flock"
        flock_stub.write_text(
            f"#!{real_py}\n"
            "import fcntl, pathlib, sys\n"
            "mode, fd = sys.argv[1], int(sys.argv[2])\n"
            f"events = pathlib.Path({str(events)!r})\n"
            f"state = pathlib.Path({str(lock_state)!r})\n"
            "if mode == '-x':\n"
            "    fcntl.flock(fd, fcntl.LOCK_EX)\n"
            "    state.write_text('locked\\n')\n"
            "    with events.open('a') as fh: fh.write(f'flock:lock:{fd}\\n')\n"
            "elif mode == '-n':\n"
            "    try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
            "    except BlockingIOError: sys.exit(1)\n"
            "    state.write_text('locked\\n')\n"
            "    with events.open('a') as fh: fh.write(f'flock:lock:{fd}\\n')\n"
            "elif mode == '-u':\n"
            "    fcntl.flock(fd, fcntl.LOCK_UN)\n"
            "    state.write_text('unlocked\\n')\n"
            "    with events.open('a') as fh: fh.write(f'flock:unlock:{fd}\\n')\n"
        )
        flock_stub.chmod(0o755)
        write_stub("logger", f"""
            echo "logger:$*" >> "{events}"
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
        post_hook = f'\n            "{runuser_post_cmd}" "$@"' if runuser_post_cmd else ""
        write_stub("runuser", f"""
            echo "runuser:$*" >> "{events}"
            shift 3 # -u bojin --
            "$@"{post_hook}
        """)
        write_stub("rsync", f"""
            if ( : >&9 ) 2>/dev/null; then
              fd9="open"
            else
              fd9="closed"
            fi
            if ( : >&8 ) 2>/dev/null; then
              fd8="open"
            else
              fd8="closed"
            fi
            state=$(cat "{lock_state}" 2>/dev/null || echo "none")
            echo "rsync:lock=$state:fd9=$fd9:fd8=$fd8:$*" >> "{events}"
        """)

        if disk_usage is not None or free_bytes is not None or py_prelude:
            du_line = ""
            if disk_usage is not None:
                total_b, used_b, free_b = disk_usage
                du_line = f'shutil.disk_usage = lambda p: U({total_b}, {used_b}, {free_b})\n'
            elif free_bytes is not None:
                du_line = f'shutil.disk_usage = lambda p: U({free_bytes} * 2, {free_bytes}, {free_bytes})\n'
            prelude_file = root / "py-prelude.py"
            prelude_file.write_text(
                "import shutil\nfrom collections import namedtuple\n"
                'U = namedtuple("U", ["total", "used", "free"])\n'
                + du_line
                + (py_prelude or ""),
                encoding="utf-8",
            )
            write_stub("python3", f"""
                if [[ "${{1:-}}" == "-c" ]]; then exec "{real_py}" "$@"; fi
                exec "{real_py}" -c '
import pathlib, sys
exec(compile(pathlib.Path({json.dumps(str(prelude_file))}).read_text(), "<prelude>", "exec"))
code = sys.stdin.read()
sys.argv = sys.argv[1:]
exec(compile(code, "<stdin>", "exec"))
' "$@"
            """)

        script_text = (ROOT / "ops/backup-service.sh").read_text()
        script_text = script_text.replace("/run/bojin/maintenance.lock", str(lock_file))
        script_text = script_text.replace("/run/bojin", str(lock_dir))
        script_text = script_text.replace("/run/lock/bojin-maintenance.lock", str(legacy_lock_file))
        script_text = script_text.replace("/var/backups/bojin-deploy", str(app_dir / "deploy-backups"))
        script_text = script_text.replace("/opt/bojin-releases", str(app_dir / "releases"))
        script_text = script_text.replace("/opt/bojin-previous", str(app_dir / "previous"))
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
            "BOJIN_WATCHDOG_STATE_DIR": str(root / "watchdog-state"),
            **(extra_env or {}),
        }
        result = subprocess.run(["bash", str(harness)], env=env, text=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=20)
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
                self.assertIn("rsync:lock=unlocked:fd9=closed:fd8=closed:", rsync_lines[0])
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

    def test_leaf_backup_symlink_rejected_before_permissions_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / "target"
            target.mkdir(mode=0o700)
            (root / "backups").symlink_to(target)
            result, log, _ = self.run_backup_script(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Refusing symlink BACKUP_ROOT", result.stderr)
            self.assertFalse(any(line.startswith("chown:") for line in log))
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)

    def test_preflight_blocks_low_disk_before_stopping_service(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            result, log, _ = self.run_backup_script(root, active_state="active", free_bytes=1024 ** 3)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Insufficient free space", result.stderr)
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

    def test_backup_lock_path_creation_symlink_ownership_transition_and_eacces(self):
        script_src = (ROOT / "ops/backup-service.sh").read_text()
        self.assertIn("/run/bojin/maintenance.lock", script_src)
        self.assertIn("/run/lock/bojin-maintenance.lock", script_src)

        # 1. Missing /run/bojin directory is created via install -d -o root -g root -m 0755,
        #    and both locks are acquired in order (new fd 9 first, then legacy fd 8) and both released before rsync.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            result, log, _ = self.run_backup_script(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            install_lines = [line for line in log if line.startswith("install:")]
            self.assertTrue(any("-d -o root -g root -m 0755" in line for line in install_lines), install_lines)
            self.assertTrue((root / "run-bojin/maintenance.lock").is_file())
            self.assertTrue((root / "run-lock/bojin-maintenance.lock").is_file())
            flock_locks = [line for line in log if line.startswith("flock:lock:")]
            self.assertEqual(flock_locks, ["flock:lock:9", "flock:lock:8"])
            flock_unlocks = [line for line in log if line.startswith("flock:unlock:")]
            self.assertEqual(set(flock_unlocks), {"flock:unlock:9", "flock:unlock:8"})

        # 2. Symlinked lock dir or symlinked lock file is refused before stopping service.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            real_dir = root / "real-dir"
            real_dir.mkdir(mode=0o700)
            (root / "run-bojin").symlink_to(real_dir)
            result, log, _ = self.run_backup_script(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr.lower())
            self.assertNotIn("systemctl:stop bojin.service", log)
            self.assertEqual(real_dir.stat().st_mode & 0o777, 0o700)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "run-bojin").mkdir(mode=0o755)
            target_file = root / "target-file"
            target_file.write_text("keep")
            (root / "run-bojin/maintenance.lock").symlink_to(target_file)
            result, log, _ = self.run_backup_script(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr.lower())
            self.assertNotIn("systemctl:stop bojin.service", log)
            self.assertEqual(target_file.read_text(), "keep")

        # 3. Non-root lock dir or non-root lock file is refused.
        for bad_rel in ("run-bojin", "run-bojin/maintenance.lock"):
            with self.subTest(non_root=bad_rel), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                (root / "run-bojin").mkdir(mode=0o755)
                if bad_rel.endswith(".lock"):
                    (root / bad_rel).write_text("")
                result, log, _ = self.run_backup_script(root, non_root_paths=[root / bad_rel])
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("systemctl:stop bojin.service", log)

        # 4a. Unreadable legacy path where retry without O_CREAT also fails (0000) MUST fail closed.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            legacy_dir = root / "run-lock"
            legacy_dir.mkdir(mode=0o755)
            legacy_file = legacy_dir / "bojin-maintenance.lock"
            legacy_file.write_text("")
            legacy_file.chmod(0o000)
            try:
                result, log, _ = self.run_backup_script(root)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("systemctl:stop bojin.service", log)
            finally:
                legacy_file.chmod(0o600)

        # 4b. Held legacy inode + EACCES on O_CREAT (0444 read-only file locked by legacy participant):
        #     backup-service.sh must retry without O_CREAT, block on REAL flock until legacy holder releases,
        #     and only THEN stop bojin.service.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            legacy_dir = root / "run-lock"
            legacy_dir.mkdir(mode=0o755)
            legacy_file = legacy_dir / "bojin-maintenance.lock"
            events_file = root / "events.log"
            holder = subprocess.Popen(
                [
                    shutil.which("python3"),
                    "-c",
                    f"""
import fcntl, os, pathlib, time
p = pathlib.Path({str(legacy_file)!r})
ev = pathlib.Path({str(events_file)!r})
fd = os.open(p, os.O_RDWR | os.O_CREAT, 0o644)
fcntl.flock(fd, fcntl.LOCK_EX)
os.chmod(p, 0o444)
with ev.open("a") as fh: fh.write("legacy_holder:held\\n")
print("READY", flush=True)
time.sleep(1.5)
with ev.open("a") as fh: fh.write("legacy_holder:releasing\\n")
os.chmod(p, 0o644)
os.close(fd)
""",
                ],
                stdout=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertEqual(holder.stdout.readline().strip(), "READY")
                started = time.monotonic()
                result, log, _ = self.run_backup_script(root)
                elapsed = time.monotonic() - started
                holder.wait(timeout=5)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertGreaterEqual(elapsed, 0.8, f"Expected backup to wait on held legacy flock, got {elapsed:.2f}s")
                self.assertIn("eacces", result.stderr.lower())
                self.assertEqual([line for line in log if line.startswith("flock:lock:")], ["flock:lock:9", "flock:lock:8"])
                self.assertLess(log.index("legacy_holder:releasing"), log.index("systemctl:stop bojin.service"))
            finally:
                if holder.stdout is not None:
                    holder.stdout.close()
                if holder.poll() is None:
                    holder.kill()
                    holder.wait()

    def test_daily_backup_deduplicates_blobs_preflights_new_bytes_and_restores_after_prune(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            data_dir = root / "data"
            (data_dir / "blobs").mkdir(parents=True)
            id_a, id_b = "a" * 32, "b" * 32
            blob_a_bytes = b"A" * (4 * 1024 * 1024)
            (data_dir / "blobs" / id_a).write_bytes(blob_a_bytes)
            (data_dir / "blobs" / id_a).chmod(0o600)
            with sqlite3.connect(data_dir / "bojin.db") as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE docs(path TEXT PRIMARY KEY, uid TEXT, parent TEXT, data TEXT, updated TEXT)")
                db.execute("CREATE TABLE blobs(id TEXT PRIMARY KEY, uid TEXT, mime TEXT, size INT, created TEXT)")
                db.execute("INSERT INTO docs VALUES('p1','u_1','p','{\"day\":1}','2026-11-20')")
                db.execute("INSERT INTO blobs VALUES(?,?,?,?,?)", (id_a, "u_1", "image/webp", len(blob_a_bytes), "2026-11-20"))

            # First backup stores blob A.
            res1, _, backup_root = self.run_backup_script(root)
            self.assertEqual(res1.returncode, 0, res1.stderr)
            snaps1 = sorted(backup_root.glob("snapshot-*"))
            self.assertEqual(len(snaps1), 1)
            snap1 = backup_root / "snapshot-20261120T040000Z"
            snaps1[0].rename(snap1)
            for ldg in backup_root.glob("deletions-*.json"):
                ldg.rename(backup_root / "deletions-20261120T040000Z.json")

            # Add a small new blob B (64 KiB) and update docs.
            blob_b_bytes = b"B" * (64 * 1024)
            (data_dir / "blobs" / id_b).write_bytes(blob_b_bytes)
            (data_dir / "blobs" / id_b).chmod(0o600)
            with sqlite3.connect(data_dir / "bojin.db") as db:
                db.execute("UPDATE docs SET data='{\"day\":2}' WHERE path='p1'")
                db.execute("INSERT INTO blobs VALUES(?,?,?,?,?)", (id_b, "u_1", "image/webp", len(blob_b_bytes), "2026-11-21"))

            # Free space is LESS than full DATA_DIR (~4.1 MiB) + 1.5 GiB,
            # but GREATER than new bytes (~100 KiB) + 1.5 GiB -> dedup-aware preflight must succeed!
            tight_free = (3 * 1024 ** 3) // 2 + 1 * 1024 * 1024
            res2, _, _ = self.run_backup_script(root, free_bytes=tight_free)
            self.assertEqual(res2.returncode, 0, res2.stderr)

            snaps2 = [p for p in sorted(backup_root.glob("snapshot-*")) if p != snap1]
            self.assertEqual(len(snaps2), 1)
            snap2 = snaps2[0]
            ledgers2 = [p for p in sorted(backup_root.glob("deletions-*.json")) if p.name != "deletions-20261120T040000Z.json"]
            self.assertEqual(len(ledgers2), 1)

            st1_a = (snap1 / "blobs" / id_a).lstat()
            st2_a = (snap2 / "blobs" / id_a).lstat()
            live_a = (data_dir / "blobs" / id_a).lstat()
            self.assertEqual((st2_a.st_dev, st2_a.st_ino), (st1_a.st_dev, st1_a.st_ino))
            self.assertEqual(st2_a.st_nlink, 2)
            self.assertNotEqual(st2_a.st_ino, live_a.st_ino)
            self.assertEqual((snap2 / "blobs" / id_b).lstat().st_nlink, 1)

            # Prune snap1 completely, then verify & restore snap2!
            shutil.rmtree(snap1)
            self.assertEqual((snap2 / "blobs" / id_a).lstat().st_nlink, 1)
            restored = root / "restored"
            restored.mkdir(mode=0o700)
            env = {**os.environ, "DATA_DIR": str(restored)}
            subprocess.run([NODE_BIN, str(ROOT / "scripts/data-backup.js"), "verify", str(snap2)], env=env, check=True)
            subprocess.run([
                NODE_BIN, str(ROOT / "scripts/data-backup.js"), "restore",
                str(snap2), str(restored), "--deletions", str(ledgers2[0]),
            ], env=env, check=True)
            self.assertEqual((restored / "blobs" / id_a).read_bytes(), blob_a_bytes)
            self.assertEqual((restored / "blobs" / id_b).read_bytes(), blob_b_bytes)
            with sqlite3.connect(restored / "bojin.db") as db:
                self.assertEqual(db.execute("SELECT data FROM docs WHERE path='p1'").fetchone()[0], '{"day":2}')

    def test_post_backup_disk_usage_guard_alerts_at_80_percent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            alert_log = root / "alert.log"
            alert_bin = root / "bojin-alert"
            alert_bin.write_text(f"#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> '{alert_log}'\n")
            alert_bin.chmod(0o755)
            gib = 1024 ** 3

            # 75% full (30 GiB used, 10 GiB free) -> succeeds without alert.
            res_ok, _, backup_root = self.run_backup_script(
                root,
                disk_usage=(40 * gib, 30 * gib, 10 * gib),
                extra_env={"BOJIN_ALERT_BIN": str(alert_bin)},
            )
            self.assertEqual(res_ok.returncode, 0, res_ok.stderr)
            self.assertFalse(alert_log.exists())

            # Rename snapshot to avoid same-second stamp collision.
            for p in list(backup_root.glob("snapshot-*")):
                p.rename(backup_root / "snapshot-20261120T040000Z")
            for p in list(backup_root.glob("deletions-*.json")):
                p.rename(backup_root / "deletions-20261120T040000Z.json")

            state_dir = root / "watchdog-state"
            uptime_file = root / "uptime"
            uptime_file.write_text("1000.00 9999.00\n", encoding="utf-8")
            shared_env = {
                "BOJIN_ALERT_BIN": str(alert_bin),
                "BOJIN_WATCHDOG_STATE_DIR": str(state_dir),
                "BOJIN_WATCHDOG_UPTIME_FILE": str(uptime_file),
            }

            # 80% full (32 GiB used, 8 GiB free on 40 GiB disk) -> succeeds AND alerts via BOJIN_ALERT_BIN.
            res_warn, _, _ = self.run_backup_script(
                root,
                disk_usage=(40 * gib, 32 * gib, 8 * gib),
                extra_env=shared_env,
            )
            self.assertEqual(res_warn.returncode, 0, res_warn.stderr)
            self.assertTrue(alert_log.is_file())
            self.assertIn("80%", alert_log.read_text())
            self.assertEqual(len(alert_log.read_text().splitlines()), 1)

            # Second run at 82% within 6h cooldown -> throttled (no duplicate warning).
            for p in list(backup_root.glob("snapshot-*")):
                if p.name != "snapshot-20261120T040000Z":
                    p.rename(backup_root / "snapshot-20261121T040000Z")
            for p in list(backup_root.glob("deletions-*.json")):
                if p.name != "deletions-20261120T040000Z.json":
                    p.rename(backup_root / "deletions-20261121T040000Z.json")
            uptime_file.write_text("1100.00 9999.00\n", encoding="utf-8")
            res_dup, _, _ = self.run_backup_script(
                root,
                disk_usage=(40 * gib, 33 * gib, 7 * gib),
                extra_env=shared_env,
            )
            self.assertEqual(res_dup.returncode, 0, res_dup.stderr)
            self.assertEqual(len(alert_log.read_text().splitlines()), 1)

            # Escalation to 90% -> immediately fires CRITICAL alert.
            for p in list(backup_root.glob("snapshot-*")):
                if p.name not in ("snapshot-20261120T040000Z", "snapshot-20261121T040000Z"):
                    p.rename(backup_root / "snapshot-20261122T040000Z")
            for p in list(backup_root.glob("deletions-*.json")):
                if p.name not in ("deletions-20261120T040000Z.json", "deletions-20261121T040000Z.json"):
                    p.rename(backup_root / "deletions-20261122T040000Z.json")
            uptime_file.write_text("1200.00 9999.00\n", encoding="utf-8")
            res_crit, _, _ = self.run_backup_script(
                root,
                disk_usage=(40 * gib, 36 * gib, 4 * gib),
                extra_env=shared_env,
            )
            self.assertEqual(res_crit.returncode, 0, res_crit.stderr)
            lines = alert_log.read_text().splitlines()
            self.assertEqual(len(lines), 2)
            self.assertIn("CRITICAL", lines[1])

            # Dropping back to 85% while 90% critical cooldown is active -> warning suppressed.
            for p in list(state_dir.glob("alert-disk-*")):
                if not p.name.startswith("alert-disk-crit-"):
                    p.unlink()
            for p in list(backup_root.glob("snapshot-*")):
                if p.name not in ("snapshot-20261120T040000Z", "snapshot-20261121T040000Z", "snapshot-20261122T040000Z"):
                    p.rename(backup_root / "snapshot-20261123T040000Z")
            for p in list(backup_root.glob("deletions-*.json")):
                if p.name not in ("deletions-20261120T040000Z.json", "deletions-20261121T040000Z.json", "deletions-20261122T040000Z.json"):
                    p.rename(backup_root / "deletions-20261123T040000Z.json")
            uptime_file.write_text("1300.00 9999.00\n", encoding="utf-8")
            res_sup, _, _ = self.run_backup_script(
                root,
                disk_usage=(40 * gib, 34 * gib, 6 * gib),
                extra_env=shared_env,
            )
            self.assertEqual(res_sup.returncode, 0, res_sup.stderr)
            self.assertEqual(len(alert_log.read_text().splitlines()), 2)

    def test_daily_preflight_blocks_on_corrupt_history_or_link_failure_and_fsyncs_before_prune(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            data_dir = root / "data"
            (data_dir / "blobs").mkdir(parents=True)
            id_a = "a" * 32
            blob_a_bytes = b"A" * (4 * 1024 * 1024)
            (data_dir / "blobs" / id_a).write_bytes(blob_a_bytes)
            (data_dir / "blobs" / id_a).chmod(0o600)
            with sqlite3.connect(data_dir / "bojin.db") as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE docs(path TEXT PRIMARY KEY, uid TEXT, parent TEXT, data TEXT, updated TEXT)")
                db.execute("CREATE TABLE blobs(id TEXT PRIMARY KEY, uid TEXT, mime TEXT, size INT, created TEXT)")
                db.execute("INSERT INTO docs VALUES('p1','u_1','p','{\"day\":1}','2026-11-20')")
                db.execute("INSERT INTO blobs VALUES(?,?,?,?,?)", (id_a, "u_1", "image/webp", len(blob_a_bytes), "2026-11-20"))

            # Seed an initial backup and age it into 3 old snapshots so retention will prune the oldest one.
            res1, _, backup_root = self.run_backup_script(root)
            self.assertEqual(res1.returncode, 0, res1.stderr)
            orig_snap = next(backup_root.glob("snapshot-*"))
            orig_ldg = next(backup_root.glob("deletions-*.json"))
            snap_old1 = backup_root / "snapshot-20000101T000000Z"
            snap_old2 = backup_root / "snapshot-20000102T000000Z"
            snap_old3 = backup_root / "snapshot-20000103T000000Z"
            orig_snap.rename(snap_old3)
            orig_ldg.rename(backup_root / "deletions-20000103T000000Z.json")
            for old_s, old_l in [
                (snap_old1, backup_root / "deletions-20000101T000000Z.json"),
                (snap_old2, backup_root / "deletions-20000102T000000Z.json"),
            ]:
                shutil.copytree(snap_old3, old_s)
                old_l.write_text('{"version":1,"users":[]}', encoding="utf-8")
            for p in list(backup_root.iterdir()):
                os.utime(p, (1, 1))

            # 1. Simulated os.link EMLINK failure with tight space (< full 4 MiB + 1.5 GiB) must block BEFORE stopping service!
            (root / "events.log").unlink(missing_ok=True)
            tight_free = (3 * 1024 ** 3) // 2 + 1 * 1024 * 1024
            emlink_prelude = (
                "import errno, os\n"
                "def _fail_link(*a, **kw): raise OSError(errno.EMLINK, 'too many links')\n"
                "os.link = _fail_link\n"
            )
            res_emlink, log_emlink, _ = self.run_backup_script(root, free_bytes=tight_free, py_prelude=emlink_prelude)
            self.assertNotEqual(res_emlink.returncode, 0)
            self.assertIn("Insufficient free space", res_emlink.stderr)
            self.assertNotIn("systemctl:stop bojin.service", log_emlink)

            # 2. Same-length corruption across all historical copies with tight space must ALSO block BEFORE stopping service!
            (root / "events.log").unlink(missing_ok=True)
            for s in (snap_old1, snap_old2, snap_old3):
                (s / "blobs" / id_a).write_bytes(b"X" * len(blob_a_bytes))
            res_corrupt, log_corrupt, _ = self.run_backup_script(root, free_bytes=tight_free)
            self.assertNotEqual(res_corrupt.returncode, 0)
            self.assertIn("Insufficient free space", res_corrupt.stderr)
            self.assertNotIn("systemctl:stop bojin.service", log_corrupt)

            # Restore healthy blob in snap_old3 and verify fsync occurs BEFORE retention prunes snap_old1!
            (snap_old3 / "blobs" / id_a).write_bytes(blob_a_bytes)
            trace_file = root / "durability-trace.log"
            trace_prelude = (
                f"import os, shutil\n"
                f"_trace = {str(trace_file)!r}\n"
                f"_orig_fsync = os.fsync\n"
                f"_orig_rmtree = shutil.rmtree\n"
                f"def _t_fsync(fd):\n"
                f"    st = os.fstat(fd)\n"
                f"    with open(_trace, 'a') as fh: fh.write(f'fsync:{{st.st_dev}}:{{st.st_ino}}\\n')\n"
                f"    return _orig_fsync(fd)\n"
                f"def _t_rmtree(p, *a, **kw):\n"
                f"    with open(_trace, 'a') as fh: fh.write(f'prune:{{p}}\\n')\n"
                f"    return _orig_rmtree(p, *a, **kw)\n"
                f"os.fsync = _t_fsync\n"
                f"shutil.rmtree = _t_rmtree\n"
            )
            res_dur, _, _ = self.run_backup_script(root, free_bytes=tight_free, py_prelude=trace_prelude)
            self.assertEqual(res_dur.returncode, 0, res_dur.stderr)
            self.assertFalse(snap_old1.exists(), "Oldest snapshot should have been pruned")
            trace_lines = trace_file.read_text(encoding="utf-8").splitlines()
            prune_indices = [i for i, line in enumerate(trace_lines) if line.startswith("prune:") and "snapshot-20000101T000000Z" in line]
            self.assertTrue(prune_indices, f"Expected prune event in {trace_lines}")
            first_prune = prune_indices[0]
            backup_root_st = backup_root.lstat()
            backup_root_sync = f"fsync:{backup_root_st.st_dev}:{backup_root_st.st_ino}"
            sync_indices = [i for i, line in enumerate(trace_lines) if line == backup_root_sync]
            self.assertTrue(sync_indices, f"Expected BACKUP_ROOT fsync in {trace_lines}")
            self.assertLess(sync_indices[0], first_prune, "BACKUP_ROOT must be fsynced BEFORE retention prunes old snapshots")

    def test_daily_custody_fresh_inodes_root_index_strict_fsync_and_late_fallback_reserve(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            data_dir = root / "data"
            (data_dir / "blobs").mkdir(parents=True)
            id_a = "a" * 32
            id_b = "b" * 32
            blob_a_bytes = b"A" * (4 * 1024 * 1024)
            blob_b_bytes = b"B" * (64 * 1024)
            (data_dir / "blobs" / id_a).write_bytes(blob_a_bytes)
            (data_dir / "blobs" / id_a).chmod(0o600)
            with sqlite3.connect(data_dir / "bojin.db") as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE docs(path TEXT PRIMARY KEY, uid TEXT, parent TEXT, data TEXT, updated TEXT)")
                db.execute("CREATE TABLE blobs(id TEXT PRIMARY KEY, uid TEXT, mime TEXT, size INT, created TEXT)")
                db.execute("INSERT INTO docs VALUES('p1','u_1','p','{\"day\":1}','2026-11-20')")
                db.execute("INSERT INTO blobs VALUES(?,?,?,?,?)", (id_a, "u_1", "image/webp", len(blob_a_bytes), "2026-11-20"))

            # Seed initial backup with blob A.
            res1, _, backup_root = self.run_backup_script(root)
            self.assertEqual(res1.returncode, 0, res1.stderr)
            snap1 = backup_root / "snapshot-20000101T000000Z"
            ldg1 = backup_root / "deletions-20000101T000000Z.json"
            next(backup_root.glob("snapshot-*")).rename(snap1)
            next(backup_root.glob("deletions-*.json")).rename(ldg1)
            os.utime(snap1, (1, 1))
            os.utime(ldg1, (1, 1))

            # Add new blob B so run 2 stages a fresh blob alongside deferred blob A.
            (data_dir / "blobs" / id_b).write_bytes(blob_b_bytes)
            (data_dir / "blobs" / id_b).chmod(0o600)
            with sqlite3.connect(data_dir / "bojin.db") as db:
                db.execute("UPDATE docs SET data='{\"day\":2}' WHERE path='p1'")
                db.execute("INSERT INTO blobs VALUES(?,?,?,?,?)", (id_b, "u_1", "image/webp", len(blob_b_bytes), "2026-11-21"))

            # 1. Custody fresh-inode isolation + root-controlled dedup index:
            #    Spawn a lingering writer (simulating compromised bojin) holding O_RDWR fds to
            #    staged bojin.db, blobs/id_b, and deletions.json across backup publication, then
            #    overwrite via those fds after publication!
            staged_meta = root / "staged-inodes.json"
            corrupt_trigger = root / "trigger-corrupt"
            corrupt_done = root / "corrupt-done"
            holder_pid_file = root / "holder.pid"
            hook_script = root / "runuser-hook.py"
            real_py = shutil.which("python3")
            hook_script.write_text(
                f"#!{real_py}\n"
                "import json, os, pathlib, subprocess, sys\n"
                "args = sys.argv[1:]\n"
                "if 'backup' in args:\n"
                "    i = args.index('backup')\n"
                "    snap = pathlib.Path(args[i + 1])\n"
                f"    meta_p = pathlib.Path({str(staged_meta)!r})\n"
                f"    trig_p = pathlib.Path({str(corrupt_trigger)!r})\n"
                f"    done_p = pathlib.Path({str(corrupt_done)!r})\n"
                f"    pid_p = pathlib.Path({str(holder_pid_file)!r})\n"
                f"    targets = [str(snap / 'bojin.db'), str(snap / 'manifest.json'), str(snap / 'blobs' / {id_b!r})]\n"
                "    info = {'work_dir': str(snap.parent), 'inodes': {}}\n"
                "    if '--defer-blobs' in args:\n"
                "        info['defer_index'] = args[args.index('--defer-blobs') + 1]\n"
                "    for t in targets:\n"
                "        st = os.lstat(t)\n"
                "        info['inodes'][os.path.relpath(t, snap)] = [st.st_dev, st.st_ino]\n"
                "    meta_p.write_text(json.dumps(info))\n"
                "    worker = (\n"
                "        'import os, pathlib, sys, time\\n'\n"
                "        'fds = [os.open(p, os.O_RDWR) for p in sys.argv[3:]]\\n'\n"
                "        'trig, done = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])\\n'\n"
                "        'deadline = time.time() + 15\\n'\n"
                "        'while not trig.exists() and time.time() < deadline: time.sleep(0.05)\\n'\n"
                "        'for fd in fds:\\n'\n"
                "        '    os.lseek(fd, 0, os.SEEK_SET)\\n'\n"
                "        '    os.write(fd, b\"CORRUPTED-BY-APP-FD\")\\n'\n"
                "        '    os.close(fd)\\n'\n"
                "        'done.write_text(\"done\")\\n'\n"
                "    )\n"
                f"    p = subprocess.Popen([{real_py!r}, '-c', worker, str(trig_p), str(done_p), *targets], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
                "    pid_p.write_text(str(p.pid))\n"
                "    # Wait briefly until worker opens the fds.\n"
                "    import time; time.sleep(0.15)\n",
                encoding="utf-8",
            )
            hook_script.chmod(0o755)
            (root / "events.log").unlink(missing_ok=True)
            res2, _, _ = self.run_backup_script(root, runuser_post_cmd=str(hook_script))
            try:
                self.assertEqual(res2.returncode, 0, res2.stderr)
                corrupt_trigger.write_text("go")
                deadline = time.time() + 10
                while not corrupt_done.exists() and time.time() < deadline:
                    time.sleep(0.05)
                self.assertTrue(corrupt_done.exists(), "Lingering app writer did not finish")
            finally:
                if holder_pid_file.exists():
                    try:
                        os.kill(int(holder_pid_file.read_text().strip()), 9)
                    except OSError:
                        pass

            info = json.loads(staged_meta.read_text(encoding="utf-8"))
            work_dir = Path(info["work_dir"]).resolve()
            defer_idx = Path(info["defer_index"]).resolve()
            # Dedup index MUST live under a root-controlled parent OUTSIDE app-owned work_dir!
            self.assertFalse(defer_idx.is_relative_to(work_dir), f"dedup index {defer_idx} must not live inside {work_dir}")
            self.assertIn(".stage-", str(defer_idx))

            snap2 = next(p for p in backup_root.glob("snapshot-*") if p != snap1)
            # Every app-produced file MUST have a brand-new inode (different from staged work inode) and remain uncorrupted!
            for rel, old_inode in info["inodes"].items():
                new_st = (snap2 / rel).lstat()
                self.assertNotEqual([new_st.st_dev, new_st.st_ino], old_inode, f"{rel} reused app-writable inode")
            self.assertEqual((snap2 / "blobs" / id_b).read_bytes(), blob_b_bytes)
            subprocess.run([NODE_BIN, str(ROOT / "scripts/data-backup.js"), "verify", str(snap2)], check=True)
            # Prelinked blob A still shares immutable root-owned inode with snap1!
            self.assertEqual((snap2 / "blobs" / id_a).lstat().st_ino, (snap1 / "blobs" / id_a).lstat().st_ino)

            # Rename snap2 to an old date so we can verify retention is NOT triggered on publication fsync error.
            snap2_aged = backup_root / "snapshot-20000102T000000Z"
            ldg2_aged = backup_root / "deletions-20000102T000000Z.json"
            snap2.rename(snap2_aged)
            next(p for p in backup_root.glob("deletions-*.json") if p != ldg1).rename(ldg2_aged)
            os.utime(snap2_aged, (1, 1))
            os.utime(ldg2_aged, (1, 1))

            # 2. Directory fsync failure (EINVAL) at BACKUP_ROOT publication barrier MUST fail closed,
            #    leave existing snapshots intact, leave no .publishing-/.stage- leftovers, and restart bojin!
            (root / "events.log").unlink(missing_ok=True)
            bst = backup_root.lstat()
            dir_fsync_fail_prelude = (
                "import errno, os, stat\n"
                "_orig_fsync = os.fsync\n"
                f"_target = ({bst.st_dev}, {bst.st_ino})\n"
                "def _fail_backup_root_fsync(fd):\n"
                "    st = os.fstat(fd)\n"
                "    if stat.S_ISDIR(st.st_mode) and (st.st_dev, st.st_ino) == _target:\n"
                "        raise OSError(errno.EINVAL, 'simulated dir fsync EINVAL')\n"
                "    return _orig_fsync(fd)\n"
                "os.fsync = _fail_backup_root_fsync\n"
            )
            res_fsync, log_fsync, _ = self.run_backup_script(root, py_prelude=dir_fsync_fail_prelude)
            self.assertNotEqual(res_fsync.returncode, 0)
            self.assertIn("simulated dir fsync EINVAL", res_fsync.stderr)
            self.assertIn("systemctl:start bojin.service", log_fsync)
            self.assertTrue(snap1.is_dir(), "Existing snapshot must not be pruned when publication fsync fails")
            self.assertTrue(snap2_aged.is_dir())
            self.assertEqual(sorted(p.name for p in backup_root.iterdir()), sorted([
                snap1.name, ldg1.name, snap2_aged.name, ldg2_aged.name
            ]))

            # 3. Late fallback copy AFTER prelink succeeds must re-check free space against 1.5 GiB reserve!
            #    Let prelink (PY) succeed so preflight passes with tight space (1.5 GiB + 1 MiB),
            #    then fail os.replace & os.link inside PYMAT so it falls back to copying 4 MiB blob A!
            (root / "events.log").unlink(missing_ok=True)
            tight_free = (3 * 1024 ** 3) // 2 + 1 * 1024 * 1024
            post_prelink_fault_prelude = (
                "import errno, os, sys\n"
                "_orig_replace = os.replace\n"
                "_orig_link = os.link\n"
                f"_blob_a = {id_a!r}\n"
                "def _is_pymat():\n"
                "    return len(sys.argv) >= 2 and sys.argv[1].endswith('/pub')\n"
                "def _fault_replace(src, dst):\n"
                "    if _is_pymat() and str(dst).endswith('/' + _blob_a):\n"
                "        raise OSError(errno.EIO, 'injected post-prelink replace failure')\n"
                "    return _orig_replace(src, dst)\n"
                "def _fault_link(src, dst):\n"
                "    if _is_pymat() and str(dst).endswith('/' + _blob_a):\n"
                "        raise OSError(errno.EMLINK, 'injected post-prelink link failure')\n"
                "    return _orig_link(src, dst)\n"
                "os.replace = _fault_replace\n"
                "os.link = _fault_link\n"
            )
            res_late, log_late, _ = self.run_backup_script(
                root, free_bytes=tight_free, py_prelude=post_prelink_fault_prelude
            )
            self.assertNotEqual(res_late.returncode, 0)
            self.assertIn("Insufficient free space", res_late.stderr)
            self.assertIn("systemctl:start bojin.service", log_late)
            # Existing snapshots untouched and all staging dirs cleaned up!
            self.assertEqual(sorted(p.name for p in backup_root.iterdir()), sorted([
                snap1.name, ldg1.name, snap2_aged.name, ldg2_aged.name
            ]))


if __name__ == "__main__":
    unittest.main()
