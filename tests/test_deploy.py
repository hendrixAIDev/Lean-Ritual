"""Deployment security boundaries and recovery, without touching a real host."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("deploy", Path(__file__).parents[1] / "ops/deploy-release.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


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
            root = Path(directory)
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


if __name__ == "__main__":
    unittest.main()
