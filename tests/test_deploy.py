"""Deployment security boundaries and recovery, without touching a real host."""
from collections import namedtuple
from contextlib import ExitStack
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("deploy", ROOT / "ops/deploy-release.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)

DiskUsage = namedtuple("DiskUsage", ["total", "used", "free"])


def bundle(extra=None, metadata=None):
    files = {name: b"test" for name in ["server.js", "package.json", "package-lock.json", "public/index.html",
        "scripts/data-backup.js", "lib/snapshots.js", "node_modules/sharp/package.json"]}
    files[".release.json"] = json.dumps(metadata or {
        "revision": "a" * 40, "node": "24.19.0", "platform": "linux", "arch": "x64"
    }).encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, content in files.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
        if extra:
            entry, content = extra
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
    output.seek(0)
    return output


class DeploymentTests(unittest.TestCase):
    def test_previous_pointer_tracks_successful_activation_after_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old, broken, fixed = [root / name for name in ("manual", "broken", "fixed")]
            for p in (old, broken, fixed):
                p.mkdir()
            current = root / "bojin"
            current.symlink_to(old)
            previous = root / "bojin-previous"
            previous.symlink_to(broken)
            deploy.activate(fixed, current, lambda: None, lambda: None,
                            lambda **kwargs: True, lambda p: None)
            self.assertEqual(previous.resolve(), old.resolve())
            with self.assertRaises(RuntimeError):
                deploy.activate(broken, current, lambda: None, lambda: None,
                                lambda rollback=False: rollback, lambda p: None)
            self.assertEqual(previous.resolve(), old.resolve())
            self.assertEqual(current.resolve(), fixed.resolve())

    def test_deploy_backup_leaf_symlink_does_not_mutate_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.mkdir(mode=0o700)
            backups = root / "backups"
            backups.symlink_to(target)
            with patch.object(deploy, "BACKUPS", backups), patch.object(deploy.os, "chown") as chown:
                with self.assertRaisesRegex(ValueError, "Refusing symlink"):
                    deploy.snapshot(root)
                chown.assert_not_called()
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)

    def test_safe_bundle_and_service_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            self.assertEqual(deploy.unpack_release(bundle(), target)["revision"], "a" * 40)
            self.assertEqual((target / "lib").stat().st_mode & 0o777, 0o755)
            self.assertEqual((target / "server.js").stat().st_mode & 0o777, 0o644)

    def test_rejects_escape_secret_and_duplicate(self):
        for name in ("../escape", "/etc/passwd", "public/../../escape", ".env", "data/bojin.db", "server.js", "lib/./x", "public\\evil"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    deploy.unpack_release(bundle((tarfile.TarInfo(name), b"x")), Path(directory))

    def test_rejects_links_devices_and_oversized_archive(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                entry = tarfile.TarInfo("public/evil")
                entry.type = kind
                entry.linkname = "/etc/passwd"
                with self.assertRaises(ValueError):
                    deploy.unpack_release(bundle((entry, b"")), Path(directory))
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, "MAX_BYTES", 1):
            with self.assertRaises(ValueError):
                deploy.unpack_release(bundle(), Path(directory))

    def test_rejects_wrong_runtime(self):
        for field, value in [("revision", "main"), ("node", "22.1.0"), ("platform", "darwin"), ("arch", "arm64")]:
            metadata = {"revision": "a" * 40, "node": "24.19.0", "platform": "linux", "arch": "x64", field: value}
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    deploy.unpack_release(bundle(metadata=metadata), Path(directory))

    def rollout(self, failure=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            old, new, current = root / "old", root / "new", root / "current"
            old.mkdir(); new.mkdir(); current.symlink_to(old)
            events = []
            def stop(): events.append("stop")
            def start():
                events.append("start:" + current.resolve().name)
                if failure == "start" and current.resolve() == new:
                    raise RuntimeError("start failed")
            def backup(previous):
                self.assertEqual(previous, old)
                events.append("backup")
                if failure == "backup": raise RuntimeError("disk full")
            def healthy(rollback=False): return rollback or failure != "health"
            if failure:
                with self.assertRaises(RuntimeError):
                    deploy.activate(new, current, stop, start, healthy, backup)
                self.assertEqual(current.resolve(), old)
                self.assertEqual(events[-1], "start:old")
            else:
                deploy.activate(new, current, stop, start, healthy, backup)
                self.assertEqual(current.resolve(), new)
                self.assertEqual(events, ["stop", "backup", "start:new"])

    def test_backup_precedes_switch(self): self.rollout()
    def test_failed_backup_restarts_old_release(self): self.rollout("backup")
    def test_failed_start_rolls_back_code(self): self.rollout("start")
    def test_failed_health_rolls_back_code(self): self.rollout("health")

    def test_rollback_failure_invokes_alert_helper(self):
        for rollback_failure in ("unhealthy", "start_error"):
            with self.subTest(kind=rollback_failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                old, new, current = root / "old", root / "new", root / "current"
                old.mkdir(); new.mkdir(); current.symlink_to(old)
                alert_log = root / "alert.log"
                alert_bin = root / "bojin-alert"
                alert_bin.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{alert_log}'\n")
                alert_bin.chmod(0o755)

                def stop(): pass
                def start():
                    if rollback_failure == "start_error" and current.resolve() == old:
                        raise RuntimeError("rollback start failed")
                def backup(previous): return None
                def healthy(rollback=False): return False

                with patch.object(deploy, "ALERT", alert_bin):
                    with self.assertRaisesRegex(RuntimeError, "did not recover"):
                        deploy.activate(new, current, stop, start, healthy, backup)
                self.assertEqual(current.resolve(), old)
                self.assertTrue(alert_log.is_file())
                self.assertIn("rollback", alert_log.read_text())

    def test_stage_release_enforces_timeout_without_leaking_dirs(self):
        class SlowStream:
            def read(self, size=-1):
                time.sleep(2)
                return b""

        with tempfile.TemporaryDirectory() as directory:
            releases = Path(directory).resolve()
            with self.assertRaises(TimeoutError):
                deploy.stage_release(SlowStream(), releases, timeout=1)
            self.assertEqual(list(releases.iterdir()), [])

    def test_preflight_requires_data_size_plus_headroom_and_cleans_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            data, releases, backups = root / "data", root / "releases", root / "backups"
            data.mkdir(); releases.mkdir()
            payload_size = 4 * 1024 * 1024
            (data / "bojin.db").write_bytes(b"x" * payload_size)
            exact_boundary = payload_size + (3 * 1024 ** 3) // 2
            with patch("shutil.disk_usage", return_value=DiskUsage(exact_boundary * 2, exact_boundary, exact_boundary)):
                with self.assertRaises(ValueError):
                    deploy.check_free_space(data, releases, backups)
            with patch("shutil.disk_usage", return_value=DiskUsage(exact_boundary * 2, exact_boundary, exact_boundary + 1)):
                deploy.check_free_space(data, releases, backups)

    def test_snapshot_chowns_root_and_cleans_up_on_failure(self):
        FakePw = namedtuple("FakePw", ["pw_uid", "pw_gid"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            previous, backups, data = root / "prev", root / "backups", root / "data"
            (previous / "scripts").mkdir(parents=True)
            data.mkdir()
            chown_calls = []

            def fake_chown(path, uid, gid, follow_symlinks=True):
                chown_calls.append((Path(path), uid, gid, follow_symlinks))

            def fake_command(*args):
                action, destination = args[-2], Path(args[-1])
                if action == "backup":
                    (destination / "blobs").mkdir(parents=True)
                    (destination / "bojin.db").write_bytes(b"db")
                    (destination / "manifest.json").write_text("{}")
                elif action == "ledger":
                    destination.write_text('{"version":1,"users":[]}')

            with patch.object(deploy, "BACKUPS", backups), patch.object(deploy, "DATA", data), \
                 patch("pwd.getpwnam", return_value=FakePw(1001, 1001)), \
                 patch("os.chown", side_effect=fake_chown), \
                 patch.object(deploy, "command", side_effect=fake_command):
                published = deploy.snapshot(previous)
                self.assertTrue((published / "snapshot/bojin.db").is_file())
                self.assertTrue((published / "deletions.json").is_file())
                root_owned = [p.name for p, uid, gid, follow in chown_calls if (uid, gid) == (0, 0) and follow is False]
                self.assertIn("snapshot", root_owned)
                self.assertIn("bojin.db", root_owned)
                self.assertIn("deletions.json", root_owned)

            def failing_ledger(*args):
                if args[-2] == "backup":
                    Path(args[-1]).mkdir(parents=True)
                else:
                    raise RuntimeError("ledger failed")

            existing = set(backups.iterdir())
            with patch.object(deploy, "BACKUPS", backups), patch.object(deploy, "DATA", data), \
                 patch("pwd.getpwnam", return_value=FakePw(1001, 1001)), \
                 patch("os.chown"), \
                 patch.object(deploy, "command", side_effect=failing_ledger):
                with self.assertRaises(RuntimeError):
                    deploy.snapshot(previous)
            self.assertEqual(set(backups.iterdir()), existing)

    def run_mock_deploy(self, root, service_state="active", pre_lock_state=None,
                        stopped_flag_mode=None, stopped_flag_uid=0, stopped_flag_symlink=False,
                        new_healthy=True, rollback_healthy=True):
        releases, backups, data = root / "releases", root / "backups", root / "data"
        old = releases / "old-release"
        current = root / "current"
        env_file = root / "environment"
        lock_dir = root / "run-bojin"
        lock_file = lock_dir / "maintenance.lock"
        legacy_lock_dir = root / "run-lock"
        legacy_lock_file = legacy_lock_dir / "bojin-maintenance.lock"
        stopped_flag = root / "allow-deploy-when-stopped"
        alert_bin = root / "bojin-alert"
        alert_log = root / "alert.log"
        old.mkdir(parents=True, exist_ok=True); data.mkdir(exist_ok=True); backups.mkdir(exist_ok=True)
        legacy_lock_dir.mkdir(exist_ok=True)
        if not current.is_symlink():
            current.symlink_to(old)
        env_file.write_text("PORT=8080\n")
        alert_bin.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{alert_log}'\n")
        alert_bin.chmod(0o755)
        if stopped_flag_symlink:
            target = root / "real-flag"
            target.write_text("")
            target.chmod(0o600)
            if stopped_flag.exists() or stopped_flag.is_symlink():
                stopped_flag.unlink()
            stopped_flag.symlink_to(target)
        elif stopped_flag_mode is not None:
            if stopped_flag.exists() or stopped_flag.is_symlink():
                stopped_flag.unlink()
            stopped_flag.write_text("")
            stopped_flag.chmod(stopped_flag_mode)
        events = []
        lock_held = [False]
        syslog_messages = []
        flag_lstat_calls = [0]

        orig_unpack = deploy.unpack_release
        def tracked_unpack(stream, destination):
            events.append("unpack")
            return orig_unpack(stream, destination)

        orig_fstat = os.fstat
        def tracked_flock(fd, op):
            raw_fd = fd if isinstance(fd, int) else fd.fileno()
            if op == deploy.fcntl.LOCK_EX:
                lock_held[0] = True
                events.append("flock")
                st = orig_fstat(raw_fd)
                if lock_file.exists() and not lock_file.is_symlink() and st.st_ino == orig_os_lstat(lock_file).st_ino:
                    events.append("flock:new")
                elif legacy_lock_file.exists() and not legacy_lock_file.is_symlink() and st.st_ino == orig_os_lstat(legacy_lock_file).st_ino:
                    events.append("flock:legacy")

        def fake_check_output(cmd, **kwargs):
            if cmd[:2] == ["/usr/bin/node", "-p"]:
                return "24.19.0\n"
            if cmd[:3] == ["/usr/bin/systemctl", "show", "bojin.service"]:
                state = service_state if (lock_held[0] or pre_lock_state is None) else pre_lock_state
                events.append(f"show:{state}:locked={lock_held[0]}")
                return f"LoadState=loaded\nActiveState={state}\n"
            raise AssertionError(f"Unexpected check_output: {cmd}")

        orig_run = subprocess.run
        def fake_run(cmd, **kwargs):
            if cmd and Path(cmd[0]) == alert_bin:
                return orig_run(cmd, **kwargs)
            if list(cmd[:7]) == ["/usr/bin/install", "-d", "-o", "root", "-g", "root", "-m"]:
                events.append("install_lock_dir:" + " ".join(cmd))
                target_dir = Path(cmd[-1])
                target_dir.mkdir(mode=int(cmd[7], 8), parents=True, exist_ok=True)
                return subprocess.CompletedProcess(cmd, 0)
            if cmd[:2] in (["/usr/bin/systemctl", "stop"], ["/usr/bin/systemctl", "start"]):
                events.append(cmd[1])
            return subprocess.CompletedProcess(cmd, 0)

        def fake_snapshot(previous):
            events.append("snapshot")
            snap_dir = backups / f"20261116T000000Z-{len(list(backups.iterdir()))}"
            (snap_dir / "snapshot").mkdir(parents=True)
            (snap_dir / "snapshot/bojin.db").write_bytes(b"sqlite-backup")
            (snap_dir / "snapshot/manifest.json").write_text('{"version":1,"files":[]}')
            (snap_dir / "deletions.json").write_text('{"version":1,"users":[]}')
            return snap_dir

        class HealthOpener:
            def open(self, url, timeout=2):
                on_old = current.resolve() == old
                if on_old:
                    payload = {"ok": bool(rollback_healthy), "revision": "b" * 40}
                else:
                    payload = {"ok": bool(new_healthy), "revision": "a" * 40 if new_healthy else "wrong"}
                return type("Resp", (io.BytesIO,), {
                    "__enter__": lambda s: s, "__exit__": lambda s, *a: None
                })(json.dumps(payload).encode())

        orig_os_lstat = os.lstat
        def fake_os_lstat(path, *args, **kwargs):
            st = orig_os_lstat(path, *args, **kwargs)
            p = Path(path)
            if p == stopped_flag:
                flag_lstat_calls[0] += 1
                return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink,
                                       stopped_flag_uid, st.st_gid, st.st_size,
                                       st.st_atime, st.st_mtime, st.st_ctime))
            if p in (lock_dir, lock_file):
                return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink,
                                       0, st.st_gid, st.st_size,
                                       st.st_atime, st.st_mtime, st.st_ctime))
            return st

        def fake_os_fstat(fd):
            st = orig_fstat(fd)
            if lock_file.exists() and not lock_file.is_symlink() and st.st_ino == orig_os_lstat(lock_file).st_ino:
                return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink,
                                       0, st.st_gid, st.st_size,
                                       st.st_atime, st.st_mtime, st.st_ctime))
            return st

        orig_unlink = Path.unlink
        def tracked_unlink(path_self, *args, **kwargs):
            if path_self == stopped_flag:
                events.append(f"unlink_flag:locked={lock_held[0]}")
            return orig_unlink(path_self, *args, **kwargs)

        def fake_syslog(*args):
            syslog_messages.append(args[-1])

        plenty = DiskUsage(20 * 1024 ** 3, 2 * 1024 ** 3, 18 * 1024 ** 3)
        with ExitStack() as stack:
            for attr, val in [("RELEASES", releases), ("CURRENT", current), ("DATA", data),
                              ("BACKUPS", backups), ("LOCK", lock_file), ("ENV_FILE", env_file),
                              ("ALERT", alert_bin), ("STOPPED_DEPLOY_FLAG", stopped_flag)]:
                stack.enter_context(patch.object(deploy, attr, val))
            if hasattr(deploy, "LEGACY_LOCK"):
                stack.enter_context(patch.object(deploy, "LEGACY_LOCK", legacy_lock_file))
            stack.enter_context(patch.object(deploy, "unpack_release", side_effect=tracked_unpack))
            stack.enter_context(patch.object(deploy, "snapshot", side_effect=fake_snapshot))
            stack.enter_context(patch("os.lstat", side_effect=fake_os_lstat))
            stack.enter_context(patch("os.fstat", side_effect=fake_os_fstat))
            stack.enter_context(patch.object(Path, "unlink", tracked_unlink))
            stack.enter_context(patch("syslog.syslog", side_effect=fake_syslog))
            stack.enter_context(patch("os.geteuid", return_value=0))
            stack.enter_context(patch.object(deploy.sys, "argv", ["deploy"]))
            stack.enter_context(patch.object(deploy.sys, "stdin", type("FakeStdin", (), {"buffer": bundle()})()))
            stack.enter_context(patch("platform.system", return_value="Linux"))
            stack.enter_context(patch("platform.machine", return_value="x86_64"))
            stack.enter_context(patch("fcntl.flock", side_effect=tracked_flock))
            stack.enter_context(patch("time.sleep"))
            stack.enter_context(patch("shutil.disk_usage", return_value=plenty))
            stack.enter_context(patch("subprocess.check_output", side_effect=fake_check_output))
            stack.enter_context(patch("subprocess.run", side_effect=fake_run))
            stack.enter_context(patch("urllib.request.build_opener", return_value=HealthOpener()))
            deploy.main()
        return events, releases, backups, current, old, alert_log, syslog_messages, flag_lstat_calls[0]

    def test_service_states_evaluated_under_lock_and_stopped_gate(self):
        # active, failed, activating, reloading are allowed without flag; unpack precedes flock.
        for state in ("active", "failed", "activating", "reloading"):
            with self.subTest(allowed=state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                events, _, _, current, old, _, _, _ = self.run_mock_deploy(root, service_state=state)
                self.assertLess(events.index("flock"), events.index("unpack"))
                self.assertNotEqual(current.resolve(), old)

        # Transient inactive before lock (e.g. during backup-service.sh) becoming active under lock must succeed.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            events, _, _, current, old, _, _, _ = self.run_mock_deploy(
                root, service_state="active", pre_lock_state="inactive"
            )
            self.assertNotEqual(current.resolve(), old)

        # inactive and deactivating under lock are rejected without root authorization flag,
        # without starting the service or leaking the candidate release directory.
        for state in ("inactive", "deactivating"):
            with self.subTest(rejected=state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                with self.assertRaisesRegex(ValueError, "stopped|inactive|deactivating|allow-deploy-when-stopped"):
                    self.run_mock_deploy(root, service_state=state)
                self.assertEqual(list((root / "releases").iterdir()), [root / "releases/old-release"])
                self.assertEqual(list((root / "backups").iterdir()), [])

        # Explicit root-owned 0600 regular file authorizes deploying once over inactive/deactivating,
        # validates with a single os.lstat, unlinks under LOCK_EX, logs consumption, and rejects the next stopped deploy.
        for state in ("inactive", "deactivating"):
            with self.subTest(authorized=state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                events, _, _, current, old, _, syslogs, lstats = self.run_mock_deploy(
                    root, service_state=state, stopped_flag_mode=0o600, stopped_flag_uid=0
                )
                self.assertNotEqual(current.resolve(), old)
                self.assertEqual(lstats, 1)
                self.assertFalse((root / "allow-deploy-when-stopped").exists())
                self.assertIn("unlink_flag:locked=True", events)
                self.assertTrue(any("allow-deploy-when-stopped" in m and "consumed" in m.lower() for m in syslogs), syslogs)
                # Second deploy when service is stopped again must be rejected because flag was consumed.
                with self.assertRaisesRegex(ValueError, "allow-deploy-when-stopped"):
                    self.run_mock_deploy(root, service_state=state)

        # Reject 0644, 0664, non-root uid, and symlinks.
        for bad_mode, bad_uid in [(0o644, 0), (0o664, 0), (0o600, 1001)]:
            with self.subTest(bad_flag=(bad_mode, bad_uid)), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                with self.assertRaises(ValueError):
                    self.run_mock_deploy(
                        root, service_state="inactive", stopped_flag_mode=bad_mode, stopped_flag_uid=bad_uid
                    )

        with self.subTest(bad_flag="symlink"), tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with self.assertRaises(ValueError):
                self.run_mock_deploy(
                    root, service_state="inactive", stopped_flag_uid=0, stopped_flag_symlink=True
                )

        # Missing systemd unit must be rejected.
        with patch("subprocess.check_output", return_value="LoadState=not-found\nActiveState=inactive\n"):
            with self.assertRaises(ValueError):
                deploy.verify_service_unit()

    def test_failed_activation_and_failed_rollback_preserve_published_snapshot(self):
        for rollback_ok in (True, False):
            with self.subTest(rollback_ok=rollback_ok), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                with self.assertRaises(RuntimeError):
                    self.run_mock_deploy(
                        root, service_state="active", new_healthy=False, rollback_healthy=rollback_ok
                    )
                old = root / "releases/old-release"
                self.assertEqual((root / "current").resolve(), old)
                # Failed candidate release dir must be cleaned up, leaving only old-release.
                self.assertEqual(list((root / "releases").iterdir()), [old])
                # Published pre-deploy snapshot and deletion ledger MUST remain intact!
                published = root / "backups/20261116T000000Z-0"
                self.assertTrue((published / "snapshot/bojin.db").is_file())
                self.assertTrue((published / "snapshot/manifest.json").is_file())
                self.assertTrue((published / "deletions.json").is_file())
                if not rollback_ok:
                    self.assertTrue((root / "alert.log").is_file())

    def test_systemd_timeout_and_workflow_health_retry(self):
        unit = (ROOT / "ops/bojin-backup.service").read_text()
        self.assertIn("TimeoutStartSec=1800", unit)
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        for flag in ("--retry 3", "--retry-delay 2", "--retry-all-errors"):
            self.assertIn(flag, workflow)

    def test_maintenance_lock_path_validation_transition_and_eacces(self):
        # 1. Production paths use /run/bojin/maintenance.lock + transition /run/lock/bojin-maintenance.lock.
        self.assertEqual(deploy.LOCK, Path("/run/bojin/maintenance.lock"))
        self.assertEqual(deploy.LEGACY_LOCK, Path("/run/lock/bojin-maintenance.lock"))
        auto_deploy = (ROOT / "ops/install-auto-deploy.py").read_text()
        self.assertIn("maintenance_lock()", auto_deploy)
        self.assertIn("bojin-tmpfiles.conf", auto_deploy)

        # 2. Missing lock directory is created defensively via install -d -o root -g root -m 0755,
        #    and both locks are acquired in exact order: new first, then legacy.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            events, _, _, _, _, _, _, _ = self.run_mock_deploy(root)
            install_events = [e for e in events if e.startswith("install_lock_dir:")]
            self.assertEqual(len(install_events), 1)
            self.assertIn("-o root -g root -m 0755", install_events[0])
            flock_order = [e for e in events if e in ("flock:new", "flock:legacy")]
            self.assertEqual(flock_order, ["flock:new", "flock:legacy"])

        # 3. Symlinked lock directory (pointing to real dir or dangling) is refused without mutating target.
        for dangling in (False, True):
            with self.subTest(symlink_dir_dangling=dangling), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                target = root / "real-target"
                if not dangling:
                    target.mkdir(mode=0o700)
                (root / "run-bojin").symlink_to(target)
                with self.assertRaisesRegex(ValueError, "symlink|lock"):
                    self.run_mock_deploy(root)
                if not dangling:
                    self.assertEqual(target.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(list(target.iterdir()), [])

        # 4. Symlinked lock file (pointing to real file or dangling) is refused without touching target.
        for dangling in (False, True):
            with self.subTest(symlink_file_dangling=dangling), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                (root / "run-bojin").mkdir(mode=0o755)
                target = root / "target-file"
                if not dangling:
                    target.write_text("untouched")
                (root / "run-bojin/maintenance.lock").symlink_to(target)
                with self.assertRaisesRegex(ValueError, "symlink|lock"):
                    self.run_mock_deploy(root)
                if not dangling:
                    self.assertEqual(target.read_text(), "untouched")

        # 5. Non-root lock directory and non-root lock file are refused.
        for bad_kind in ("dir", "file"):
            with self.subTest(non_root=bad_kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                lock_dir = root / "run-bojin"
                lock_dir.mkdir(mode=0o755)
                lock_file = lock_dir / "maintenance.lock"
                legacy_dir = root / "run-lock"
                legacy_dir.mkdir(mode=0o755)
                legacy_file = legacy_dir / "bojin-maintenance.lock"
                if bad_kind == "file":
                    lock_file.write_text("")
                orig_lstat = os.lstat
                orig_fstat = os.fstat

                def custom_lstat(path, *a, **kw):
                    st = orig_lstat(path, *a, **kw)
                    p = Path(path)
                    uid = 1001 if ((bad_kind == "dir" and p == lock_dir) or (bad_kind == "file" and p == lock_file)) else (0 if p in (lock_dir, lock_file) else st.st_uid)
                    return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, uid, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime))

                def custom_fstat(fd):
                    st = orig_fstat(fd)
                    uid = 1001 if bad_kind == "file" else 0
                    return os.stat_result((st.st_mode, st.st_ino, st.st_dev, st.st_nlink, uid, st.st_gid, st.st_size, st.st_atime, st.st_mtime, st.st_ctime))

                with patch.object(deploy, "LOCK", lock_file), patch.object(deploy, "LEGACY_LOCK", legacy_file), \
                     patch("os.lstat", side_effect=custom_lstat), patch("os.fstat", side_effect=custom_fstat):
                    with self.assertRaisesRegex(ValueError, "non-root|unsafe|lock"):
                        with deploy.maintenance_lock():
                            pass

        # 6. Old-path EACCES (fs.protected_regular=2) logs a warning and continues holding the new lock,
        #    while symlink on old path still fails closed.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            legacy_dir = root / "run-lock"
            legacy_dir.mkdir(mode=0o755)
            legacy_file = legacy_dir / "bojin-maintenance.lock"
            legacy_file.write_text("")
            legacy_file.chmod(0o000)
            try:
                events, _, _, current, old, _, syslogs, _ = self.run_mock_deploy(root)
                self.assertNotEqual(current.resolve(), old)
                self.assertEqual([e for e in events if e in ("flock:new", "flock:legacy")], ["flock:new"])
                self.assertTrue(any("EACCES" in m or "legacy" in m.lower() for m in syslogs), syslogs)
            finally:
                legacy_file.chmod(0o600)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            legacy_dir = root / "run-lock"
            legacy_dir.mkdir(mode=0o755)
            target = root / "real-legacy"
            target.write_text("")
            (legacy_dir / "bojin-maintenance.lock").symlink_to(target)
            with self.assertRaises((OSError, ValueError)):
                self.run_mock_deploy(root)


if __name__ == "__main__":
    unittest.main()
