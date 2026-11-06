#!/usr/bin/env python3
"""Package a tested Linux x64 Node 24 build without data or configuration."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile


def package(root, output, revision):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Expected a full Git commit SHA")
    runtime = json.loads(subprocess.check_output([
        "node", "-p", "JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch})"
    ]))
    if runtime["node"].split(".")[0] != "24" or (runtime["platform"], runtime["arch"]) != ("linux", "x64"):
        raise ValueError("Build on Linux x64 with Node 24")
    required = ["server.js", "package.json", "package-lock.json", "lib", "scripts", "public", "node_modules"]
    for name in required + ["public/index.html", "node_modules/sharp/package.json"]:
        if not (root / name).exists():
            raise ValueError("Missing build input: " + name)
    manifest = root / ".release.json"
    manifest.write_text(json.dumps({"revision": revision, **runtime}) + "\n")
    try:
        with tarfile.open(output, "w:gz", dereference=True) as archive:
            def checked(info):
                relative = Path(info.name)
                source = root / relative
                if not source.resolve().is_relative_to(root.resolve()):
                    raise ValueError("Build symlink escapes source directory")
                if not (info.isfile() or info.isdir()):
                    raise ValueError("Unexpected build file type")
                info.uid = info.gid = 0
                info.uname = info.gname = "root"
                info.mode = 0o755 if info.isdir() or info.mode & 0o111 else 0o644
                return info
            for name in [*required, ".release.json"]:
                archive.add(root / name, arcname=name, filter=checked)
    finally:
        manifest.unlink(missing_ok=True)


if __name__ == "__main__":
    package(Path.cwd(), Path(sys.argv[1]), sys.argv[2])
