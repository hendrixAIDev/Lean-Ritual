"""Exercise a real packaged Node runtime, persistent SQLite and offline backup."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
import urllib.request

ROOT = Path(__file__).parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / ("ops/" + name + "-release.py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class RuntimeDeploymentTest(unittest.TestCase):
    def test_packaged_runtime_persistence_and_backup(self):
        deploy, package = module("deploy"), module("package")
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
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


if __name__ == "__main__":
    unittest.main()
