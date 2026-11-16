import pathlib
import subprocess
import tempfile
import unittest


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
                (daily / ("snapshot-" + stamp)).mkdir()
                (daily / ("deletions-" + stamp + ".json")).touch()
                (deploy / (stamp + "-abcdefgh")).mkdir()
            unknown = daily / "unrelated"
            unknown.mkdir()
            (daily / "snapshot-19990101T000000Z").symlink_to(unknown, target_is_directory=True)
            for number in range(1, 11):
                (releases / ("a" * 40 + f"-{number}-1")).mkdir()
            active = root / "active"
            active.symlink_to(releases / ("a" * 40 + "-2-1"))
            code = code.replace('"/var/backups/bojin-deploy"', repr(str(deploy)))
            code = code.replace('"/opt/bojin-releases"', repr(str(releases)))
            code = code.replace('"/opt/bojin"', repr(str(active)))
            subprocess.run(["python3", "-c", code, str(daily), "7",
                            str(daily / "snapshot-20000104T000000Z")], check=True)
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
        self.assertLess(script.index('publishing=0\nrmdir'), script.index("<<'PYRET'"))
        self.assertLess(script.index("<<'PYRET'"), script.index('flock -u 9'))
        result = subprocess.run(["bash", "-c",
            script[script.index('if [[ -z "${OFFSITE_DEST:-}" ]]'):]],
            env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("offsite disabled", result.stdout)

    def test_installer_preserves_existing_environment(self):
        script = pathlib.Path("ops/install-backup.sh").read_text()
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            for name in ("backup-service.sh", "bojin-backup.service", "bojin-backup.timer"):
                (root / name).write_text("fixture")
            env = root / "env"
            env.write_text("BACKUP_RETENTION_DAYS=11\n")
            script = script.replace('[[ $EUID == 0 ]]', '[[ 1 == 1 ]]')
            script = script.replace("/etc/bojin-backup.env", str(env))
            script = script.replace("/usr/local/libexec", str(root / "libexec"))
            (root / "units").mkdir()
            script = script.replace("/etc/systemd/system", str(root / "units"))
            script = script.replace("install -o root -g root", "install")
            script = script.replace("systemctl ", "true ")
            installer = root / "installer"
            installer.write_text(script)
            for _ in range(2):
                subprocess.run(["bash", str(installer)], check=True)
            self.assertEqual(env.read_text(), "BACKUP_RETENTION_DAYS=11\n")

    def test_pruning_failure_preserves_new_snapshot(self):
        script = pathlib.Path("ops/backup-service.sh").read_text()
        code = script.split("<<'PYRET'\n", 1)[1].split("\nPYRET", 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            new = root / "snapshot-20000103T000000Z"
            for name in ("snapshot-20000101T000000Z", "snapshot-20000102T000000Z", new.name):
                (root / name).mkdir()
            code = code.replace('root = pathlib.Path(sys.argv[1])',
                'root = pathlib.Path(sys.argv[1])\ndef fail(*args): raise OSError("injected pruning failure")\nshutil.rmtree = fail')
            result = subprocess.run(["python3", "-c", code, str(root), "7", str(new)],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(new.is_dir())
