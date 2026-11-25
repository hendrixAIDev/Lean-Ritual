"""check-public-deployment.py against a stubbed curl: the root must be the landing page, never the app."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_public", ROOT / "scripts/check-public-deployment.py")
check_public = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_public)

LANDING = (ROOT / "public/landing.html").read_text()
NAMES = ("Anonymous root serves the landing page, not the app", "Anonymous app pages redirect to login")


def run(root=(200, {"Vary": "Cookie"}, LANDING), gated=(302, {"Location": "/login.html"}, "")):
    def curl(args, **_):
        path = args[-1].removeprefix("https://example.test")
        status, headers, body = root if path == "/" else gated if path.endswith("index.html") else (404, {}, "")
        Path(args[args.index("--dump-header") + 1]).write_text("HTTP/2 %d\n" % status + "".join("%s: %s\n" % h for h in headers.items()))
        Path(args[args.index("--output") + 1]).write_text(body)
        return subprocess.CompletedProcess(args, 0, stdout=str(status), stderr="")
    with mock.patch.object(check_public.subprocess, "run", curl), contextlib.redirect_stdout(io.StringIO()):
        return {r["check"]: r["pass"] for r in check_public.check("https://example.test")}


class PublicDeploymentTests(unittest.TestCase):
    def test_landing_at_root_and_gated_app_pass(self):
        result = run()
        for name in NAMES:
            self.assertTrue(result[name], name)

    def test_old_redirect_app_shell_or_missing_vary_fail(self):
        for root in [(302, {"Location": "/login.html"}, ""), (200, {"Vary": "Cookie"}, '<script src="/shim.js"></script>'),
                     (200, {}, LANDING), (200, {"Vary": "Cookie"}, LANDING + '<script src="/shim.js">')]:
            self.assertFalse(run(root=root)[NAMES[0]])

    def test_ungated_app_page_fails(self):
        self.assertFalse(run(gated=(200, {}, "app"))[NAMES[1]])


if __name__ == "__main__":
    unittest.main()
