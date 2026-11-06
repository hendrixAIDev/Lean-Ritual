#!/usr/bin/env python3
"""Anonymous GET-only checks. Never signs up, sends mail, or invokes AI."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlsplit


def check(origin, revision=None):
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("Supply an HTTPS origin without a path or credentials")
    origin = origin.rstrip("/")
    results = []
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        def get(path, http=False):
            url = ("http://" + parsed.netloc if http else origin) + path
            response = subprocess.run(["curl", "--silent", "--show-error", "--max-time", "30",
                "--max-filesize", "2097152", "--dump-header", str(root / "headers"), "--output", str(root / "body"),
                "--write-out", "%{http_code}", url], capture_output=True, text=True)
            if response.returncode:
                raise RuntimeError("curl failed before a usable response (exit %d)" % response.returncode)
            # curl includes the proxy's CONNECT response before origin headers.
            blocks = (root / "headers").read_text().strip().split("\n\n")
            headers = {}
            for line in blocks[-1].splitlines()[1:]:
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.lower()] = value.strip()
            return int(response.stdout), headers, (root / "body").read_text()

        def record(name, function):
            try:
                if not function(): raise ValueError("unexpected response")
                result = {"check": name, "pass": True}
            except (ValueError, RuntimeError, OSError, KeyError) as error:
                result = {"check": name, "pass": False, "detail": str(error)}
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)

        def redirect():
            status, headers, _ = get("/", http=True)
            return status in (301, 302, 307, 308) and headers.get("location") == origin + "/"
        record("HTTP redirects to canonical HTTPS", redirect)
        def protected_page():
            return all((lambda r: r[0] == 302 and r[1].get("location") == "/login.html")(get(path)) for path in ("/", "/index.html"))
        record("Anonymous app pages redirect to login", protected_page)
        def login():
            status, _, body = get("/login.html")
            return status == 200 and all(text in body for text in ("sign-in/email", "sign-up/email", "request-password-reset", "invitation"))
        record("Standard invitation/password login UI", login)
        def health():
            status, _, body = get("/api/health")
            data = json.loads(body)
            return status == 200 and data.get("ok") is True and (not revision or data.get("revision") == revision)
        record("Health and optional expected revision", health)
        def config():
            status, _, body = get("/api/config")
            data = json.loads(body)
            return status == 200 and data.get("invite") is True and isinstance(data.get("ai"), bool) and set(data) == {"allowSignup", "invite", "ai"}
        record("Public config requires invitations and exposes no credentials", config)
        def privacy():
            status, _, body = get("/privacy.html")
            return status == 200 and "杰瑞智能技术服务部" in body and "hendrix.ai.dev@gmail.com" in body
        record("Public operator/privacy contact", privacy)
        def disclosure():
            status, _, body = get("/privacy.html")
            return status == 200 and "尚未部署" not in body and "Resend" in body
        record("Hosting/email disclosure reflects current deployment", disclosure)
        def security():
            return all((lambda h: h.get("x-content-type-options") == "nosniff" and h.get("x-frame-options") == "DENY" and h.get("referrer-policy") == "same-origin")(get(path)[1]) for path in ("/login.html", "/api/health"))
        record("Basic response security headers", security)
        def guards():
            return all((lambda r: r[0] == 401 and r[1].get("cache-control") == "no-store")(get(path)) for path in (
                "/api/me", "/api/doc?path=data%2Fusers%2Facceptance-probe%2Fprofile%2Fmain",
                "/api/list?col=data%2Fusers%2Facceptance-probe%2Frecords"))
        record("Anonymous record guards", guards)
        record("Anonymous account export denied", lambda: get("/api/account/export")[0] == 401)
        def session():
            status, _, body = get("/api/auth/get-session")
            return status == 200 and json.loads(body) is None
        record("Anonymous auth session is null", session)
        record("Legacy registration endpoint retired", lambda: get("/api/register")[0] == 410)
        def shim():
            status, _, body = get("/shim.js")
            return status == 200 and "window.ritual" in body and '"/api/ai"' in body and '"/api/auth/delete-user"' in body
        record("Standalone browser adapter available", shim)
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    parser.add_argument("--expected-revision")
    args = parser.parse_args()
    result = check(args.origin, args.expected_revision)
    print("%d/%d checks passed" % (sum(r["pass"] for r in result), len(result)))
    raise SystemExit(0 if all(r["pass"] for r in result) else 1)
