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

    def test_main_unpacks_before_lock_supports_non_active_states_and_cleans_failed_deploy(self):
        for service_state in ("active", "failed", "activating", "inactive"):
            with self.subTest(state=service_state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                releases, backups, data = root / "releases", root / "backups", root / "data"
                old = releases / "old-release"
                current = root / "current"
                env_file = root / "environment"
                lock_file = root / "maintenance.lock"
                alert_bin = root / "missing-alert"
                old.mkdir(parents=True); data.mkdir(); backups.mkdir()
                current.symlink_to(old)
                env_file.write_text("PORT=8080\n")
                events = []

                orig_unpack = deploy.unpack_release
                def tracked_unpack(stream, destination):
                    events.append("unpack")
                    return orig_unpack(stream, destination)

                def tracked_flock(fd, op):
                    events.append("flock")

                def fake_check_output(cmd, **kwargs):
                    if cmd[:2] == ["/usr/bin/node", "-p"]:
                        return "24.19.0\n"
                    if cmd[:3] == ["/usr/bin/systemctl", "show", "bojin.service"]:
                        return f"LoadState=loaded\nActiveState={service_state}\n"
                    raise AssertionError(f"Unexpected check_output: {cmd}")

                def fake_run(cmd, **kwargs):
                    if cmd[:2] == ["/usr/bin/systemctl", "is-active"]:
                        return subprocess.CompletedProcess(cmd, 0)
                    return subprocess.CompletedProcess(cmd, 0)

                def fake_snapshot(previous):
                    events.append("snapshot")
                    snap_dir = backups / "snap-1"
                    snap_dir.mkdir()
                    return snap_dir

                class FakeResponse(io.BytesIO):
                    def __enter__(self): return self
                    def __exit__(self, *args): pass

                class FakeOpener:
                    def open(self, url, timeout=2):
                        return FakeResponse(json.dumps({"ok": True, "revision": "a" * 40}).encode())

                fake_stdin = type("FakeStdin", (), {"buffer": bundle()})()
                plenty = DiskUsage(20 * 1024 ** 3, 2 * 1024 ** 3, 18 * 1024 ** 3)
                with ExitStack() as stack:
                    for attr, val in [("RELEASES", releases), ("CURRENT", current), ("DATA", data),
                                      ("BACKUPS", backups), ("LOCK", lock_file), ("ENV_FILE", env_file),
                                      ("ALERT", alert_bin)]:
                        stack.enter_context(patch.object(deploy, attr, val))
                    stack.enter_context(patch.object(deploy, "unpack_release", side_effect=tracked_unpack))
                    stack.enter_context(patch.object(deploy, "snapshot", side_effect=fake_snapshot))
                    stack.enter_context(patch("os.geteuid", return_value=0))
                    stack.enter_context(patch.object(deploy.sys, "argv", ["deploy"]))
                    stack.enter_context(patch.object(deploy.sys, "stdin", fake_stdin))
                    stack.enter_context(patch("platform.system", return_value="Linux"))
                    stack.enter_context(patch("platform.machine", return_value="x86_64"))
                    stack.enter_context(patch("fcntl.flock", side_effect=tracked_flock))
                    stack.enter_context(patch("shutil.disk_usage", return_value=plenty))
                    stack.enter_context(patch("subprocess.check_output", side_effect=fake_check_output))
                    stack.enter_context(patch("subprocess.run", side_effect=fake_run))
                    stack.enter_context(patch("urllib.request.build_opener", return_value=FakeOpener()))
                    deploy.main()
                self.assertLess(events.index("unpack"), events.index("flock"))
                self.assertNotEqual(current.resolve(), old)

        # Missing systemd unit must be rejected before deployment.
        with patch("subprocess.check_output", return_value="LoadState=not-found\nActiveState=inactive\n"):
            with self.assertRaises(ValueError):
                deploy.verify_service_unit()

        # Verify a failed health check cleans up both candidate release and deploy backup dir.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            releases, backups, data = root / "releases", root / "backups", root / "data"
            old = releases / "old-release"
            current = root / "current"
            env_file = root / "environment"
            lock_file = root / "maintenance.lock"
            old.mkdir(parents=True); data.mkdir(); backups.mkdir()
            current.symlink_to(old)
            env_file.write_text("PORT=8080\n")

            def fake_check_output_loaded(cmd, **kwargs):
                if cmd[:2] == ["/usr/bin/node", "-p"]:
                    return "24.19.0\n"
                return "LoadState=loaded\nActiveState=active\n"

            def fake_snapshot(previous):
                snap_dir = backups / "snap-failed"
                snap_dir.mkdir()
                return snap_dir

            class UnhealthyNewOpener:
                def open(self, url, timeout=2):
                    rev = "old" if current.resolve() == old else "wrong"
                    return type("Resp", (io.BytesIO,), {
                        "__enter__": lambda s: s, "__exit__": lambda s, *a: None
                    })(json.dumps({"ok": True, "revision": rev}).encode())

            plenty = DiskUsage(20 * 1024 ** 3, 2 * 1024 ** 3, 18 * 1024 ** 3)
            with ExitStack() as stack:
                for attr, val in [("RELEASES", releases), ("CURRENT", current), ("DATA", data),
                                  ("BACKUPS", backups), ("LOCK", lock_file), ("ENV_FILE", env_file),
                                  ("ALERT", root / "no-alert")]:
                    stack.enter_context(patch.object(deploy, attr, val))
                stack.enter_context(patch.object(deploy, "snapshot", side_effect=fake_snapshot))
                stack.enter_context(patch("os.geteuid", return_value=0))
                stack.enter_context(patch.object(deploy.sys, "argv", ["deploy"]))
                stack.enter_context(patch.object(deploy.sys, "stdin", type("FakeStdin", (), {"buffer": bundle()})()))
                stack.enter_context(patch("platform.system", return_value="Linux"))
                stack.enter_context(patch("platform.machine", return_value="x86_64"))
                stack.enter_context(patch("fcntl.flock"))
                stack.enter_context(patch("time.sleep"))
                stack.enter_context(patch("shutil.disk_usage", return_value=plenty))
                stack.enter_context(patch("subprocess.check_output", side_effect=fake_check_output_loaded))
                stack.enter_context(patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0)))
                stack.enter_context(patch("urllib.request.build_opener", return_value=UnhealthyNewOpener()))
                with self.assertRaises(RuntimeError):
                    deploy.main()
            self.assertEqual(current.resolve(), old)
            self.assertEqual(list(releases.iterdir()), [old])
            self.assertEqual(list(backups.iterdir()), [])

    def test_systemd_timeout_and_workflow_health_retry(self):
        unit = (ROOT / "ops/bojin-backup.service").read_text()
        self.assertIn("TimeoutStartSec=1800", unit)
        workflow = (ROOT / ".github/workflows/release.yml").read_text()
        for flag in ("--retry 3", "--retry-delay 2", "--retry-all-errors"):
            self.assertIn(flag, workflow)


if __name__ == "__main__":
    unittest.main()
