import os
import time
import pathlib
import subprocess
import tempfile
import unittest


def complete(path):
    path.mkdir(parents=True, exist_ok=True)
    (path / "manifest.json").write_text("{}")
    (path / "bojin.db").write_bytes(b"SQLite format 3\0" + b"0" * 4096)


class RetentionTests(unittest.TestCase):
    def test_old_snapshots_ledgers_releases_and_symlinks(self):
        script = pathlib.Path("ops/backup-service.sh").read_text()
        code = script.split("<<'PYRET'\n", 1)[1].split("\nPYRET", 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            daily = root / "daily"
            deploy = root / "deploy"
            releases = root / "releases"
            for directory in (daily, deploy, releases):
                directory.mkdir()
            for day in range(1, 5):
                stamp = f"2000010{day}T000000Z"
                complete(daily / ("snapshot-" + stamp))
                (daily / ("deletions-" + stamp + ".json")).write_text("[]")
                complete(deploy / (stamp + "-abcdefgh") / "snapshot")
                (deploy / (stamp + "-abcdefgh") / "deletions.json").write_text("[]")
            unknown = daily / "unrelated"
            unknown.mkdir()
            (daily / "snapshot-19990101T000000Z").symlink_to(unknown, target_is_directory=True)
            for number in range(1, 11):
                (releases / ("a" * 40 + f"-{number}-1")).mkdir()
            previous = root / "previous"
            previous.symlink_to(releases / ("a" * 40 + "-1-1"))
            active = root / "active"
            active.symlink_to(releases / ("a" * 40 + "-2-1"))
            code = code.replace('"/var/backups/bojin-deploy"', repr(str(deploy)))
            code = code.replace('"/opt/bojin-releases"', repr(str(releases)))
            code = code.replace('"/opt/bojin-previous"', repr(str(previous)))
            code = code.replace('"/opt/bojin"', repr(str(active)))
            for base in (daily, deploy, releases):
                for item in base.iterdir():
                    if not item.is_symlink(): os.utime(item, (1, 1))
            code = code.replace("max(st.st_mtime, st.st_ctime)", "st.st_mtime")
            subprocess.run(["python3", "-c", code, str(daily), "7",
                            str(daily / "snapshot-20000104T000000Z"),
                            str(daily / "deletions-20000104T000000Z.json"), str(int(time.time()))], check=True)
            self.assertTrue(unknown.exists())
            self.assertTrue((daily / "snapshot-19990101T000000Z").is_symlink())
            self.assertEqual(len(list(deploy.iterdir())), 2)
            self.assertTrue((daily / "deletions-20000104T000000Z.json").exists())
            self.assertFalse((daily / "snapshot-20000101T000000Z").exists())
            self.assertTrue(active.resolve().exists())
            self.assertTrue((releases / ("a" * 40 + "-1-1")).exists())
            self.assertEqual(len(list(releases.iterdir())), 7)

    def test_optional_offsite_and_publication_before_pruning(self):
        script = pathlib.Path("ops/backup-service.sh").read_text()
        self.assertIn('if [[ -z "${OFFSITE_DEST:-}" ]]', script)
        self.assertIn('/run/bojin/maintenance.lock', script)
        self.assertLess(script.index('/run/bojin/maintenance.lock'), script.index('/run/lock/bojin-maintenance.lock'))
        self.assertLess(script.index('publishing=0\nrmdir'), script.index("<<'PYRET'"))
        self.assertLess(script.index("<<'PYRET'"), script.index('flock -u 9'))
        result = subprocess.run(["bash", "-c",
            script[script.index('if [[ -z "${OFFSITE_DEST:-}" ]]'):]],
            env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("offsite disabled", result.stdout)

    def test_installer_preserves_existing_environment(self):
        tmpfiles_src = pathlib.Path("ops/bojin-tmpfiles.conf")
        self.assertTrue(tmpfiles_src.is_file())
        self.assertEqual(tmpfiles_src.read_text().strip(), "d /run/bojin 0755 root root -")
        script = pathlib.Path("ops/install-backup.sh").read_text()
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            for name in ("backup-service.sh", "bojin-backup.service", "bojin-backup.timer", "maintenance-lock.sh"):
                (root / name).write_text("fixture")
            (root / "bojin-tmpfiles.conf").write_text(tmpfiles_src.read_text())
            bindir = root / "bin"
            bindir.mkdir()
            stat_stub = bindir / "stat"
            stat_stub.write_text("#!/usr/bin/env python3\nimport os,sys\nif sys.argv[1:3]==['-c','%u']:\n os.lstat(sys.argv[-1]); print(0); sys.exit(0)\nsys.exit(1)\n")
            stat_stub.chmod(0o755)
            tmpfiles_stub = bindir / "systemd-tmpfiles"
            tmpfiles_stub.write_text("#!/usr/bin/env bash\nexit 0\n")
            tmpfiles_stub.chmod(0o755)
            run_env = {**os.environ, "PATH": f"{bindir}:{os.environ.get('PATH', '/usr/bin:/bin')}"}
            env = root / "env"
            env.write_text("BACKUP_RETENTION_DAYS=11\n")
            script = script.replace('[[ $EUID == 0 ]]', '[[ 1 == 1 ]]')
            script = script.replace("/etc/bojin-backup.env", str(env))
            script = script.replace("/etc/tmpfiles.d", str(root / "tmpfiles.d"))
            script = script.replace("/run/bojin", str(root / "run-bojin"))
            script = script.replace("/usr/local/libexec", str(root / "libexec"))
            script = script.replace("/usr/local/sbin", str(root / "sbin"))
            (root / "units").mkdir()
            script = script.replace("/etc/systemd/system", str(root / "units"))
            script = script.replace("install -o root -g root", "install")
            script = script.replace("chown root:root", "true")
            script = script.replace("systemctl is-active", "false")
            script = script.replace("systemctl ", "true ")
            installer = root / "installer"
            installer.write_text(script)
            for _ in range(2):
                subprocess.run(["bash", str(installer)], env=run_env, check=True)
            self.assertEqual(env.read_text(), "BACKUP_RETENTION_DAYS=11\n")
            self.assertEqual(env.stat().st_mode & 0o777, 0o600)
            self.assertEqual((root / "libexec/bojin-backup").stat().st_mode & 0o777, 0o755)
            self.assertEqual((root / "sbin/bojin-maintenance-lock").stat().st_mode & 0o777, 0o755)
            self.assertEqual((root / "tmpfiles.d/bojin.conf").read_text().strip(), "d /run/bojin 0755 root root -")
            self.assertEqual((root / "tmpfiles.d/bojin.conf").stat().st_mode & 0o777, 0o644)
            self.assertTrue((root / "run-bojin").is_dir())
            self.assertEqual((root / "run-bojin").stat().st_mode & 0o777, 0o755)
            env.unlink()
            subprocess.run(["bash", str(installer)], env=run_env, check=True)
            self.assertIn("BACKUP_RETENTION_DAYS=7", env.read_text())
            # Refuse symlinked /run/bojin
            (root / "run-bojin").rmdir()
            (root / "run-bojin").symlink_to(root / "units")
            self.assertNotEqual(subprocess.run(["bash", str(installer)], env=run_env,
                                capture_output=True).returncode, 0)
            (root / "run-bojin").unlink()
            env.unlink()
            env.symlink_to(root / "missing")
            self.assertNotEqual(subprocess.run(["bash", str(installer)], env=run_env,
                                capture_output=True).returncode, 0)
            env.unlink()
            env.touch()
            installer.write_text(script.replace("false --quiet bojin-backup-local.service",
                                                "true --quiet bojin-backup-local.service"))
            self.assertNotEqual(subprocess.run(["bash", str(installer)], env=run_env,
                                capture_output=True).returncode, 0)

    def test_pruning_failure_preserves_new_snapshot(self):
        script = pathlib.Path("ops/backup-service.sh").read_text()
        code = script.split("<<'PYRET'\n", 1)[1].split("\nPYRET", 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            new = root / "snapshot-20000103T000000Z"
            for name in ("snapshot-20000101T000000Z", "snapshot-20000102T000000Z", new.name):
                (root / name).mkdir()
            (root / "ledger").touch()
            for item in root.iterdir(): os.utime(item, (1, 1))
            code = code.replace('root = pathlib.Path(sys.argv[1])',
                'root = pathlib.Path(sys.argv[1])\ndef fail(*args): raise OSError("injected pruning failure")\nshutil.rmtree = fail')
            result = subprocess.run(["python3", "-c", code, str(root), "7", str(new), str(root / "ledger"), str(int(time.time()))],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(new.is_dir())

    def test_adversarial_names_clock_and_release_pointers(self):
        import datetime
        script = pathlib.Path("ops/backup-service.sh").read_text()
        original = script.split("<<'PYRET'\n", 1)[1].split("\nPYRET", 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            real = root / "real"
            real.mkdir()
            opt = root / "opt"
            opt.symlink_to(real, target_is_directory=True)
            releases = real / "bojin-releases"
            releases.mkdir()
            daily = root / "daily"
            daily.mkdir()
            names = ["snapshot-2000010%dT000000Z" % n for n in range(1, 5)]
            names += ["snapshot-99999999T999999Z", "snapshot-29990101T000000Z",
                      "snapshot-20260229T000000Z"]
            recent = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            names.append("snapshot-" + recent)
            deploy_dir = root / "deploy"
            deploy_dir.mkdir()
            for suffix in ("aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd"):
                (deploy_dir / (recent + "-" + suffix)).mkdir()
            for name in names:
                complete(daily / name)
                os.utime(daily / name, (1, 1))
                if name in names[:4] or name == ("snapshot-" + recent):
                    paired = daily / ("deletions-" + name[9:] + ".json")
                    paired.write_text("[]")
                    os.utime(paired, (1, 1))
            ledger = daily / "deletions-19990101T000000Z.json"
            ledger.touch()
            os.utime(ledger, (1, 1))
            new = daily / names[0]
            for n in range(1, 12):
                p = releases / ("a" * 40 + "-%d-1" % n)
                p.mkdir()
                os.utime(p, (1, 1))
            active = real / "bojin"
            active.symlink_to(releases / ("a" * 40 + "-2-1"))
            previous = real / "bojin-previous"
            code = original.replace('"/var/backups/bojin-deploy"', repr(str(root / "deploy")))
            code = code.replace('"/opt/bojin-releases"', repr(str(opt / "bojin-releases")))
            code = code.replace('"/opt/bojin-previous"', repr(str(opt / "bojin-previous")))
            code = code.replace('"/opt/bojin"', repr(str(opt / "bojin")))
            code = code.replace("max(st.st_mtime, st.st_ctime)", "st.st_mtime")
            args = ["python3", "-c", code, str(daily), "7", str(new), str(ledger), str(int(time.time()))]
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(list(releases.iterdir())), 11)  # Missing pointer fails closed.
            self.assertEqual(len(list(deploy_dir.iterdir())), 4)
            previous.touch()
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(len(list(releases.iterdir())), 11)
            previous.unlink()
            previous.symlink_to(real)
            subprocess.run(args, capture_output=True)
            self.assertEqual(len(list(releases.iterdir())), 11)
            previous.unlink()
            previous.symlink_to(releases / ("a" * 40 + "-1-1"))
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(active.resolve(strict=True).is_dir())
            self.assertTrue(previous.resolve(strict=True).is_dir())
            self.assertTrue(new.is_dir())
            self.assertTrue(ledger.exists())
            self.assertTrue((daily / "snapshot-20000104T000000Z").is_dir())
            self.assertTrue((daily / ("snapshot-" + recent)).is_dir())
            for name in names[4:7]:
                self.assertTrue((daily / name).exists())
            self.assertIn("invalid timestamp", result.stderr)
            self.assertIn("future timestamp", result.stderr)
            # Recent staged releases survive even outside the five newest.
            staged = releases / ("b" * 40 + "-0-1")
            staged.mkdir()
            subprocess.run(args, check=True, capture_output=True)
            self.assertTrue(staged.exists())
            active.unlink()
            manual = real / "manual_rollback"
            manual.mkdir()
            active.symlink_to(manual)
            subprocess.run(args, check=True, capture_output=True)
            self.assertTrue(manual.is_dir())
            active.unlink()
            active.symlink_to(real / "missing")
            result = subprocess.run(args, capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_incomplete_snapshots_do_not_displace_complete_backups(self):
        script = pathlib.Path("ops/backup-service.sh").read_text()
        code = script.split("<<'PYRET'\n", 1)[1].split("\nPYRET", 1)[0]
        code = code.split('rel_base =', 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            daily = root / "daily"
            deploy = root / "deploy"
            daily.mkdir()
            deploy.mkdir()
            for n in range(1, 5):
                snap = daily / ("snapshot-2000010%dT000000Z" % n)
                snap.mkdir()
                ds = deploy / ("2000010%dT000000Z-abcdefgh" % n)
                ds.mkdir()
                if n < 3:
                    complete(snap)
                    paired = daily / ("deletions-2000010%dT000000Z.json" % n)
                    paired.write_text("[]")
                    os.utime(paired, (1, 1))
                    complete(ds / "snapshot")
                    (ds / "deletions.json").write_text("[]")
                elif n == 3:
                    (snap / "manifest.json").write_text("{}")
                os.utime(snap, (1, 1))
                os.utime(ds, (1, 1))
            new = daily / "snapshot-20000105T000000Z"
            complete(new)
            ledger = daily / "deletions-20000105T000000Z.json"
            ledger.write_text("[]")
            # Run start predates the new snapshot: it cannot take a keep slot.
            code = code.replace('"/var/backups/bojin-deploy"', repr(str(deploy)))
            result = subprocess.run(["python3", "-c", code, str(daily), "7", str(new),
                                     str(ledger), str(int(time.time()))],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for n in (1, 2):
                self.assertTrue((deploy / ("2000010%dT000000Z-abcdefgh" % n)).exists())
            self.assertTrue((daily / "snapshot-20000102T000000Z").exists())
            self.assertTrue((daily / "deletions-20000102T000000Z.json").exists())
            self.assertFalse((daily / "snapshot-20000104T000000Z").exists())
            self.assertIn("incomplete", result.stderr)

    def test_interrupted_daily_publication_does_not_displace_complete_recovery_points(self):
        import datetime
        script = pathlib.Path("ops/backup-service.sh").read_text()
        code = script.split("<<'PYRET'\n", 1)[1].split("\nPYRET", 1)[0]
        code = code.split('rel_base =', 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            daily = root / "daily"
            deploy = root / "deploy"
            daily.mkdir()
            deploy.mkdir()

            # 1. Two older complete daily recovery points (snapshot + paired ledger).
            for day in (1, 2):
                stamp = f"2000010{day}T000000Z"
                snap = daily / f"snapshot-{stamp}"
                ldg = daily / f"deletions-{stamp}.json"
                complete(snap)
                ldg.write_text('{"version":1,"users":[]}')
                os.utime(snap, (1, 1))
                os.utime(ldg, (1, 1))

            # 2. Snapshot-only entry (crash between snapshot rename and ledger rename).
            snap_only = daily / "snapshot-20000103T000000Z"
            complete(snap_only)
            os.utime(snap_only, (1, 1))

            # 3. Uncommitted entry with .publishing- marker (crash before commit barrier,
            #    even though both snapshot and ledger exist on disk).
            uncommitted_stamp = "20000104T000000Z"
            uncommitted_snap = daily / f"snapshot-{uncommitted_stamp}"
            uncommitted_ldg = daily / f"deletions-{uncommitted_stamp}.json"
            uncommitted_marker = daily / f".publishing-{uncommitted_stamp}"
            complete(uncommitted_snap)
            uncommitted_ldg.write_text('{"version":1,"users":[]}')
            uncommitted_marker.write_text("publishing\n")
            for p in (uncommitted_snap, uncommitted_ldg, uncommitted_marker):
                os.utime(p, (1, 1))

            # 4. Recent interrupted snapshot-only entry (newer than retention cutoff):
            #    must NOT take one of the 2 complete keep slots either!
            recent_stamp = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1)).strftime("%Y%m%dT%H%M%SZ")
            recent_incomplete = daily / f"snapshot-{recent_stamp}"
            complete(recent_incomplete)

            # 5. Newly committed complete recovery point.
            new_stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            if new_stamp == recent_stamp:
                new_stamp = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=2)).strftime("%Y%m%dT%H%M%SZ")
            new_snap = daily / f"snapshot-{new_stamp}"
            new_ldg = daily / f"deletions-{new_stamp}.json"
            complete(new_snap)
            new_ldg.write_text('{"version":1,"users":[]}')

            run_code = code.replace('"/var/backups/bojin-deploy"', repr(str(deploy)))
            result = subprocess.run(
                ["python3", "-c", run_code, str(daily), "7", str(new_snap), str(new_ldg), str(int(time.time()))],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

            # Both newest complete recovery points (new_snap + 20000102) and their paired ledgers MUST survive!
            self.assertTrue(new_snap.is_dir())
            self.assertTrue(new_ldg.is_file())
            self.assertTrue((daily / "snapshot-20000102T000000Z").is_dir())
            self.assertTrue((daily / "deletions-20000102T000000Z.json").is_file())

            # Old incomplete entries, uncommitted marker, and 3rd oldest complete backup are pruned.
            self.assertFalse(snap_only.exists())
            self.assertFalse(uncommitted_snap.exists())
            self.assertFalse(uncommitted_ldg.exists())
            self.assertFalse(uncommitted_marker.exists())
            self.assertFalse((daily / "snapshot-20000101T000000Z").exists())
            self.assertFalse((daily / "deletions-20000101T000000Z.json").exists())
            # Recent incomplete entry is still within retention window, yet did not displace 20000102.
            self.assertTrue(recent_incomplete.is_dir())
            self.assertIn("incomplete backup snapshot-20000103T000000Z", result.stderr)
            self.assertIn("incomplete backup snapshot-20000104T000000Z", result.stderr)
