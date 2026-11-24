"""Behavioral tests for ops/health-watchdog.sh, ops/alert.sh, and systemd units."""
from __future__ import annotations
from configparser import ConfigParser
import fcntl
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
WATCHDOG_SH = ROOT / "ops/health-watchdog.sh"
ALERT_SH = ROOT / "ops/alert.sh"
INSTALL_SH = ROOT / "ops/install-reliability.sh"
BACKUP_SH = ROOT / "ops/backup-service.sh"
INSTALL_BACKUP_SH = ROOT / "ops/install-backup.sh"
MAINT_LOCK_SH = ROOT / "ops/maintenance-lock.sh"
TMPFILES_CONF = ROOT / "ops/bojin-tmpfiles.conf"
WATCHDOG_SERVICE = ROOT / "ops/bojin-watchdog.service"
WATCHDOG_TIMER = ROOT / "ops/bojin-watchdog.timer"
ALERT_SERVICE = ROOT / "ops/bojin-alert@.service"


def write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class OpsHarness:
    """Isolated sandbox with stubbed systemctl, df, curl, flock, logger, hostname."""

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.bin_dir = self.root / "bin"
        self.state_dir = self.root / "state"
        self.mock_dir = self.root / "mock"
        self.bin_dir.mkdir()
        self.mock_dir.mkdir()

        self.config_file = self.mock_dir / "config.json"
        self.events_file = self.mock_dir / "events.jsonl"
        self.install_file = self.mock_dir / "install.jsonl"
        self.flock_file = self.mock_dir / "flock.jsonl"
        self.alert_env_file = self.mock_dir / "bojin-alert.env"
        self.lock_dir = self.mock_dir / "run-bojin"
        self.lock_dir.mkdir(mode=0o755)
        self.lock_file = self.lock_dir / "maintenance.lock"
        self.legacy_lock_dir = self.mock_dir / "run-lock"
        self.legacy_lock_dir.mkdir(mode=0o755)
        self.legacy_lock_file = self.legacy_lock_dir / "bojin-maintenance.lock"
        self.uptime_file = self.mock_dir / "uptime"

        self.alert_env_file.write_text("ALERT_URL=https://ntfy.sh/test-secret-topic\n", encoding="utf-8")
        self.set_uptime(1000.0)
        self.config = {
            "units": {
                "bojin.service": {"active": "active", "nrestarts": 0, "invocation": "inv-bojin-0"},
                "caddy.service": {"active": "active", "nrestarts": 0, "invocation": "inv-caddy-0"},
            },
            "df": {
                "/var/lib/bojin": {"pcent": "42%", "ipcent": "10%", "target": "/"},
                "/var/backups": {"pcent": "42%", "ipcent": "10%", "target": "/"},
                "/opt": {"pcent": "42%", "ipcent": "10%", "target": "/"},
            },
            "curl": {
                "http://127.0.0.1:8080/api/health": 0,
                "http://127.0.0.1:80/": 0,
                "https://ntfy.sh/test-secret-topic": 0,
            },
            "systemctl_delays": {},
            "non_root_paths": [],
            "hostname": "bojin-prod",
        }
        self._save_config()
        self._install_stubs()

    def _save_config(self) -> None:
        self.config_file.write_text(json.dumps(self.config), encoding="utf-8")

    def set_uptime(self, seconds: float) -> None:
        self.uptime_file.write_text(f"{seconds:.2f} 9999.00\n", encoding="utf-8")

    def update(self) -> None:
        self._save_config()

    def events(self) -> list[dict]:
        if not self.events_file.exists():
            return []
        return [
            json.loads(line)
            for line in self.events_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def clear_events(self) -> None:
        self.events_file.unlink(missing_ok=True)
        self.install_file.unlink(missing_ok=True)
        self.flock_file.unlink(missing_ok=True)

    def install_calls(self) -> list[list[str]]:
        if not self.install_file.exists():
            return []
        return [json.loads(line)["args"] for line in self.install_file.read_text(encoding="utf-8").splitlines() if line.strip()]

    def flock_calls(self) -> list[dict]:
        if not self.flock_file.exists():
            return []
        return [json.loads(line) for line in self.flock_file.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _install_stubs(self) -> None:
        stub_prelude = (
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "CFG = json.load(open(os.environ['OPS_TEST_CONFIG'], encoding='utf-8'))\n"
            "def record(kind, **kw):\n"
            "    with open(os.environ['OPS_TEST_EVENTS'], 'a', encoding='utf-8') as fh:\n"
            "        fh.write(json.dumps({'kind': kind, **kw}) + '\\n')\n"
        )

        write_executable(
            self.bin_dir / "systemctl",
            stub_prelude
            + """
import time
args = sys.argv[1:]
record("systemctl", args=args)
delays = CFG.get("systemctl_delays", {})
if args:
    cmd = args[0]
    unit = args[-1]
    if cmd in ("restart", "start") and "--no-block" not in args:
        blocking_delay = float(delays.get("blocking_job", 0.0))
        if blocking_delay > 0:
            time.sleep(blocking_delay)
    specific_delay = float(delays.get(f"{cmd}:{unit}", delays.get(cmd, 0.0)))
    if specific_delay > 0:
        time.sleep(specific_delay)
if len(args) >= 2 and args[0] == "is-active":
    unit = args[-1]
    state = CFG["units"].get(unit, {}).get("active", "inactive")
    if "--quiet" not in args:
        print(state)
    sys.exit(0 if state == "active" else 3)
if len(args) >= 4 and args[0] == "show" and "-p" in args:
    prop = args[args.index("-p") + 1]
    unit = args[-1]
    unit_cfg = CFG["units"].get(unit, {})
    if prop == "NRestarts":
        print(unit_cfg.get("nrestarts", 0))
    elif prop == "InvocationID":
        print(unit_cfg.get("invocation", ""))
    sys.exit(0)
sys.exit(0)
""",
        )

        write_executable(
            self.bin_dir / "df",
            stub_prelude
            + """
import time
args = sys.argv[1:]
record("df", args=args)
path = args[-1]
info = CFG["df"].get(path)
if info is None:
    sys.exit(1)
delay = float(info.get("delay", 0.0))
if delay > 0:
    time.sleep(delay)
out_arg = next((a for a in args if a.startswith("--output=")), "--output=pcent")
cols = out_arg.split("=", 1)[1].split(",")
headers = {"pcent": "Use%", "ipcent": "IUse%", "target": "Mounted on"}
print(" ".join(headers.get(c, c) for c in cols))
print(" ".join(str(info.get(c, "-")) for c in cols))
sys.exit(0)
""",
        )

        write_executable(
            self.bin_dir / "curl",
            stub_prelude
            + """
import time
args = sys.argv[1:]
url = args[-1]
record("curl", args=args, url=url)

max_time = None
if "--max-time" in args:
    max_time = float(args[args.index("--max-time") + 1])
retries = 0
if "--retry" in args:
    retries = int(args[args.index("--retry") + 1])
follow = "-L" in args or "--location" in args
proto_redir_https = "--proto-redir" in args and args[args.index("--proto-redir") + 1] == "=https"

def resolve_spec(u):
    raw = CFG["curl"].get(u, 0)
    if isinstance(raw, int):
        return {"rc": raw, "http_code": "200" if raw == 0 else "000", "delay": 0.0, "ignore_sigterm": False}
    return {
        "rc": int(raw.get("rc", 0)),
        "http_code": str(raw.get("http_code", "200" if raw.get("rc", 0) == 0 else "000")),
        "delay": float(raw.get("delay", 0.0)),
        "redirect_to": raw.get("redirect_to"),
        "ignore_sigterm": bool(raw.get("ignore_sigterm", False)),
    }

spec = resolve_spec(url)
if spec["ignore_sigterm"]:
    import signal
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
attempts = 1 + (retries if spec["rc"] != 0 or spec["delay"] > (max_time or 9999) else 0)
for _ in range(attempts):
    delay = spec["delay"]
    if delay > 0:
        if max_time is not None and delay > max_time and not spec["ignore_sigterm"]:
            time.sleep(max_time)
            spec = {"rc": 28, "http_code": "000", "delay": 0.0, "ignore_sigterm": False}
        else:
            time.sleep(delay)

if spec["rc"] == 0 and spec.get("redirect_to") and follow:
    target = spec["redirect_to"]
    code = spec["http_code"]
    if proto_redir_https and not target.startswith("https://"):
        spec = {"rc": 1, "http_code": code, "delay": 0.0}
    else:
        post_preserved = (
            code in ("307", "308")
            or (code == "301" and "--post301" in args)
            or (code == "302" and "--post302" in args)
            or (code == "303" and "--post303" in args)
        )
        record("curl_redirect", from_url=url, to_url=target, status=code, post_preserved=post_preserved)
        spec = resolve_spec(target)
        if not post_preserved and CFG["curl"].get(target, {}).get("require_post"):
            spec = {"rc": 22, "http_code": "405", "delay": 0.0}

if "-w" in args:
    fmt = args[args.index("-w") + 1]
    sys.stdout.write(fmt.replace("%{http_code}", spec["http_code"]))

if spec["rc"] != 0:
    sys.stderr.write(f"curl: ({spec['rc']}) simulated failure\\n")
sys.exit(spec["rc"])
""",
        )

        write_executable(
            self.bin_dir / "timeout",
            """#!/usr/bin/env python3
import os, signal, subprocess, sys, time
args = sys.argv[1:]
kill_after = None
sig = signal.SIGTERM
foreground = False
while args and args[0].startswith("-"):
    flag = args.pop(0)
    if flag == "-k":
        kill_after = float(args.pop(0).rstrip("s"))
    elif flag == "-s":
        s_val = args.pop(0).upper()
        sig = signal.SIGKILL if s_val in ("KILL", "SIGKILL", "9") else signal.SIGTERM
    elif flag == "--foreground":
        foreground = True
limit = float(args.pop(0).rstrip("s"))
proc = subprocess.Popen(args, start_new_session=not foreground)
pgid = proc.pid
try:
    sys.exit(proc.wait(timeout=limit))
except subprocess.TimeoutExpired:
    if foreground:
        proc.send_signal(sig)
        if sig != signal.SIGKILL:
            try:
                proc.wait(timeout=kill_after if kill_after is not None else 0.5)
            except subprocess.TimeoutExpired:
                proc.kill()
        proc.wait()
        sys.exit(137 if sig == signal.SIGKILL else 124)
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass
    if sig != signal.SIGKILL:
        deadline = time.monotonic() + (kill_after if kill_after is not None else 0.5)
        while time.monotonic() < deadline:
            proc.poll()
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    proc.wait()
    sys.exit(137 if sig == signal.SIGKILL else 124)
""",
        )

        write_executable(
            self.bin_dir / "logger",
            stub_prelude
            + """
import time
record("logger", args=sys.argv[1:])
delay = float(CFG.get("logger_delay", 0.0))
if delay > 0:
    time.sleep(delay)
sys.exit(0)
""",
        )

        write_executable(
            self.bin_dir / "hostname",
            stub_prelude
            + """
print(CFG.get("hostname", "test-host"))
sys.exit(0)
""",
        )

        write_executable(
            self.bin_dir / "install",
            """#!/usr/bin/env python3
import json, os, shutil, subprocess, sys
args = sys.argv[1:]
log_path = os.environ.get("OPS_TEST_INSTALL_LOG")
if log_path:
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"args": args}) + "\\n")
filtered = []
i = 0
while i < len(args):
    if args[i] in ("-o", "-g"):
        i += 2
    else:
        filtered.append(args[i])
        i += 1
real_install = "/usr/bin/install"
sys.exit(subprocess.call([real_install, *filtered]))
""",
        )

        write_executable(
            self.bin_dir / "stat",
            stub_prelude
            + """
args = sys.argv[1:]
if args[:2] == ["-c", "%u"]:
    target = args[-1]
    os.lstat(target)
    non_root = set(CFG.get("non_root_paths", []))
    print(1001 if target in non_root else 0)
    sys.exit(0)
sys.exit(1)
""",
        )

        write_executable(
            self.bin_dir / "flock",
            """#!/usr/bin/env python3
import fcntl, json, os, sys
args = sys.argv[1:]
nonblock = "-n" in args
fd = int(args[-1])
flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblock else 0)
ino = os.fstat(fd).st_ino
log_path = os.environ.get("OPS_TEST_FLOCK_LOG")
try:
    fcntl.flock(fd, flags)
except BlockingIOError:
    if log_path:
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"fd": fd, "ino": ino, "nonblock": nonblock, "acquired": False}) + "\\n")
    sys.exit(1)
if log_path:
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"fd": fd, "ino": ino, "nonblock": nonblock, "acquired": True}) + "\\n")
sys.exit(0)
""",
        )

    def base_env(self, extra: dict | None = None) -> dict:
        env = os.environ.copy()
        env.pop("ALERT_URL", None)
        env["PATH"] = f"{self.bin_dir}:{env.get('PATH', '/usr/bin:/bin')}"
        env["OPS_TEST_CONFIG"] = str(self.config_file)
        env["OPS_TEST_EVENTS"] = str(self.events_file)
        env["OPS_TEST_INSTALL_LOG"] = str(self.install_file)
        env["OPS_TEST_FLOCK_LOG"] = str(self.flock_file)
        env["BOJIN_ALERT_ENV_FILE"] = str(self.alert_env_file)
        env["BOJIN_WATCHDOG_STATE_DIR"] = str(self.state_dir)
        env["BOJIN_WATCHDOG_ALERT_BIN"] = str(ALERT_SH)
        env["BOJIN_WATCHDOG_LOCK_FILE"] = str(self.lock_file)
        env["BOJIN_WATCHDOG_LEGACY_LOCK_FILE"] = str(self.legacy_lock_file)
        env["BOJIN_WATCHDOG_UPTIME_FILE"] = str(self.uptime_file)
        if extra:
            for k, v in extra.items():
                if v is None:
                    env.pop(k, None)
                else:
                    env[k] = v
        return env

    def run_alert(self, *args: str, env_extra: dict | None = None) -> subprocess.CompletedProcess:
        self._save_config()
        return subprocess.run(
            ["bash", str(ALERT_SH), *args],
            env=self.base_env(env_extra),
            capture_output=True,
            text=True,
            timeout=10,
        )

    def run_watchdog(self, env_extra: dict | None = None, timeout: int = 10) -> subprocess.CompletedProcess:
        self._save_config()
        return subprocess.run(
            ["bash", str(WATCHDOG_SH)],
            env=self.base_env(env_extra),
            capture_output=True,
            text=True,
            timeout=timeout,
        )


class OpsScriptsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.h = OpsHarness(Path(self._tmp.name))

    def test_bash_syntax_all_ops_scripts(self) -> None:
        for script in (WATCHDOG_SH, ALERT_SH, INSTALL_SH, BACKUP_SH, INSTALL_BACKUP_SH, MAINT_LOCK_SH):
            with self.subTest(script=script.name):
                res = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True, timeout=5)
                self.assertEqual(res.returncode, 0, res.stderr)

    def test_systemd_units_timer_and_timeouts(self) -> None:
        timer = ConfigParser(interpolation=None)
        timer.optionxform = str
        timer.read(WATCHDOG_TIMER, encoding="utf-8")
        self.assertEqual(timer.get("Timer", "OnCalendar", fallback=None), "*:*:0/30")
        self.assertFalse(timer.has_option("Timer", "OnUnitActiveSec"))
        self.assertFalse(timer.has_option("Timer", "OnBootSec"))
        self.assertTrue(timer.has_option("Timer", "AccuracySec"))

        for unit_path in (WATCHDOG_SERVICE, ALERT_SERVICE):
            with self.subTest(unit=unit_path.name):
                unit = ConfigParser(interpolation=None)
                unit.optionxform = str
                unit.read(unit_path, encoding="utf-8")
                timeout = unit.get("Service", "TimeoutStartSec", fallback=None)
                self.assertIsNotNone(timeout, f"{unit_path.name} missing TimeoutStartSec=")
                self.assertGreater(int(timeout.rstrip("s")), 0)

    def test_alert_https_enforcement_export_precedence_and_nonzero_exit(self) -> None:
        # 1. Empty ALERT_URL in env file and no exported ALERT_URL -> journal only, exit 0.
        self.h.alert_env_file.write_text("ALERT_URL=\n", encoding="utf-8")
        res = self.h.run_alert("test journal only")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual([e for e in self.h.events() if e["kind"] == "curl"], [])

        # 2. Exported ALERT_URL is honored even when /etc/bojin-alert.env has empty ALERT_URL=.
        self.h.clear_events()
        exported_url = "https://ntfy.sh/exported-topic"
        self.h.config["curl"][exported_url] = 0
        res = self.h.run_alert("disk warning", env_extra={"ALERT_URL": exported_url})
        self.assertEqual(res.returncode, 0, res.stderr)
        curls = [e for e in self.h.events() if e["kind"] == "curl"]
        self.assertEqual(len(curls), 1)
        self.assertEqual(curls[0]["url"], exported_url)
        self.assertIn("--proto", curls[0]["args"])
        proto_idx = curls[0]["args"].index("--proto")
        self.assertEqual(curls[0]["args"][proto_idx + 1], "=https")

        # 3. Typo http:// URL is rejected with non-zero exit and never sent via curl.
        self.h.clear_events()
        res_env = self.h.run_alert("secret check", env_extra={"ALERT_URL": "http://ntfy.sh/leaked-topic"})
        self.assertNotEqual(res_env.returncode, 0)
        self.assertEqual([e for e in self.h.events() if e["kind"] == "curl"], [])

        self.h.alert_env_file.write_text("ALERT_URL=http://ntfy.sh/leaked-file-topic\n", encoding="utf-8")
        res_file = self.h.run_alert("secret file check")
        self.assertNotEqual(res_file.returncode, 0)
        self.assertEqual([e for e in self.h.events() if e["kind"] == "curl"], [])

        # 4. Transient curl delivery failure exits non-zero so systemd/watchdog detect failure.
        self.h.alert_env_file.write_text("ALERT_URL=https://ntfy.sh/test-secret-topic\n", encoding="utf-8")
        self.h.config["curl"]["https://ntfy.sh/test-secret-topic"] = 28
        res_fail = self.h.run_alert("delivery failed")
        self.assertNotEqual(res_fail.returncode, 0)

    def test_cooldown_stamp_written_only_after_delivery_and_uses_monotonic_uptime(self) -> None:
        self.h.config["df"]["/var/lib/bojin"]["pcent"] = "95%"
        # First attempt: curl fails -> no cooldown stamp may be persisted.
        self.h.config["curl"]["https://ntfy.sh/test-secret-topic"] = 7
        self.h.set_uptime(500.75)
        res1 = self.h.run_watchdog()
        self.assertEqual(res1.returncode, 0, res1.stderr)
        alert_curls = [e for e in self.h.events() if e["kind"] == "curl" and "ntfy.sh" in e["url"]]
        self.assertEqual(len(alert_curls), 1)
        stamps = list(self.h.state_dir.glob("alert-disk*"))
        self.assertEqual(stamps, [], "Failed delivery must not write cooldown stamp")

        # Second attempt 30s later: curl succeeds -> alert is retried and stamp stores monotonic seconds.
        self.h.clear_events()
        self.h.config["curl"]["https://ntfy.sh/test-secret-topic"] = 0
        self.h.set_uptime(530.25)
        res2 = self.h.run_watchdog()
        self.assertEqual(res2.returncode, 0, res2.stderr)
        alert_curls = [e for e in self.h.events() if e["kind"] == "curl" and "ntfy.sh" in e["url"]]
        self.assertEqual(len(alert_curls), 1)
        stamps = list(self.h.state_dir.glob("alert-disk*"))
        self.assertEqual(len(stamps), 1)
        self.assertEqual(stamps[0].read_text(encoding="utf-8").strip(), "530")

        # Third attempt within 6h monotonic window: suppressed.
        self.h.clear_events()
        self.h.set_uptime(1000.00)
        self.h.run_watchdog()
        alert_curls = [e for e in self.h.events() if e["kind"] == "curl" and "ntfy.sh" in e["url"]]
        self.assertEqual(len(alert_curls), 0)

        # Fourth attempt after 21600s monotonic window: fires again.
        self.h.clear_events()
        self.h.set_uptime(22200.00)
        self.h.run_watchdog()
        alert_curls = [e for e in self.h.events() if e["kind"] == "curl" and "ntfy.sh" in e["url"]]
        self.assertEqual(len(alert_curls), 1)

    def test_zero_byte_and_corrupt_state_files_do_not_break_arithmetic(self) -> None:
        self.h.state_dir.mkdir(parents=True, exist_ok=True)
        for name, content in [
            ("alert-disk-_", ""),
            ("alert-unhealthy", ""),
            ("failures", ""),
            ("failures-caddy.service", "corrupt\n"),
            ("restarts-bojin.service", ""),
            ("activating-bojin.service", "not-a-number"),
        ]:
            (self.h.state_dir / name).write_text(content, encoding="utf-8")

        self.h.config["df"]["/var/lib/bojin"]["pcent"] = "96%"
        self.h.config["curl"]["http://127.0.0.1:8080/api/health"] = 7
        res = self.h.run_watchdog()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertNotIn("syntax error", res.stderr.lower())
        alert_curls = [e for e in self.h.events() if e["kind"] == "curl" and "ntfy.sh" in e["url"]]
        self.assertEqual(len(alert_curls), 1)

    def test_activating_crash_loop_runs_disk_and_nrestarts_and_sustained_activating_alerts(self) -> None:
        # Baseline run while healthy so NRestarts=0 is recorded.
        self.h.run_watchdog()
        self.h.clear_events()

        # App enters a fast startup crash loop because disk filled up:
        # systemctl is-active reports "activating" (Restart=always + StartLimitIntervalSec=0),
        # NRestarts climbs, and /var/lib/bojin is 98% full.
        self.h.config["units"]["bojin.service"] = {"active": "activating", "nrestarts": 6}
        self.h.config["df"]["/var/lib/bojin"]["pcent"] = "98%"
        self.h.set_uptime(1030.0)
        res1 = self.h.run_watchdog()
        self.assertEqual(res1.returncode, 0, res1.stderr)

        delivered = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertTrue(any("98%" in m for m in delivered), f"Expected disk alert in {delivered}")
        self.assertTrue(any("crashed and systemd restarted it" in m for m in delivered), f"Expected crash alert in {delivered}")

        # Must not manually restart bojin.service while systemd is already activating it.
        restarts = [
            e for e in self.h.events()
            if e["kind"] == "systemctl" and e["args"][:2] == ["restart", "bojin.service"]
        ]
        self.assertEqual(restarts, [])

        # Continue staying in "activating" for 2 more checks (total 3 consecutive checks) -> sustained activating alert.
        self.h.clear_events()
        self.h.set_uptime(1060.0)
        self.h.run_watchdog()
        self.h.set_uptime(1090.0)
        self.h.run_watchdog()
        delivered_sustained = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertTrue(
            any("activating" in m and "bojin.service" in m for m in delivered_sustained),
            f"Expected sustained activating alert in {delivered_sustained}",
        )

    def test_inactive_bojin_is_not_restarted_but_all_disks_and_inodes_are_checked(self) -> None:
        self.h.config["units"]["bojin.service"] = {"active": "inactive", "nrestarts": 0}
        self.h.config["df"] = {
            "/var/lib/bojin": {"pcent": "50%", "ipcent": "-", "target": "/mnt/data"},
            "/var/backups": {"pcent": "92%", "ipcent": "15%", "target": "/mnt/backups"},
            "/opt": {"pcent": "60%", "ipcent": "94%", "target": "/"},
        }
        res = self.h.run_watchdog()
        self.assertEqual(res.returncode, 0, res.stderr)

        delivered = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertTrue(any("/var/backups" in m and "92%" in m for m in delivered), delivered)
        self.assertTrue(any("/opt" in m and "inodes" in m and "94%" in m for m in delivered), delivered)

        bojin_starts = [
            e for e in self.h.events()
            if e["kind"] == "systemctl" and e["args"][0] in ("start", "restart") and "bojin.service" in e["args"]
        ]
        self.assertEqual(bojin_starts, [], "Inactive bojin.service must not be started/restarted")

    def test_caddy_nrestarts_and_local_liveness_probe(self) -> None:
        # Baseline run records caddy NRestarts=0.
        self.h.run_watchdog()
        self.h.clear_events()

        # Caddy crashes once (NRestarts 0 -> 2) and then hangs on local HTTP probe (127.0.0.1:80),
        # even when bojin.service is inactive.
        self.h.config["units"]["bojin.service"] = {"active": "inactive", "nrestarts": 0}
        self.h.config["units"]["caddy.service"] = {"active": "active", "nrestarts": 2}
        self.h.config["curl"]["http://127.0.0.1:80/"] = 28

        for step, uptime in enumerate((1030.0, 1060.0, 1090.0), start=1):
            self.h.set_uptime(uptime)
            res = self.h.run_watchdog()
            self.assertEqual(res.returncode, 0, res.stderr)
            if step < 3:
                caddy_restarts = [
                    e for e in self.h.events()
                    if e["kind"] == "systemctl" and e["args"][0] == "restart" and "caddy.service" in e["args"]
                ]
                self.assertEqual(caddy_restarts, [])

        caddy_restarts = [
            e for e in self.h.events()
            if e["kind"] == "systemctl" and e["args"] == ["restart", "--no-block", "caddy.service"]
        ]
        self.assertEqual(len(caddy_restarts), 1)

        caddy_probes = [
            e for e in self.h.events()
            if e["kind"] == "curl" and e["url"] == "http://127.0.0.1:80/"
        ]
        self.assertEqual(len(caddy_probes), 3)
        self.assertNotIn("--fail", caddy_probes[0]["args"])
        self.assertIn("--noproxy", caddy_probes[0]["args"])

        delivered = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertTrue(any("caddy.service crashed" in m for m in delivered), delivered)
        self.assertTrue(any("caddy.service stopped answering" in m for m in delivered), delivered)

    def test_maintenance_lock_skips_watchdog_round(self) -> None:
        self.h.config["df"]["/var/lib/bojin"]["pcent"] = "99%"
        with open(self.h.lock_file, "a+", encoding="utf-8") as lock_fh:
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                res = self.h.run_watchdog()
            finally:
                fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(self.h.events(), [])

    def test_failed_units_recover_and_bojin_unhealthy_restarts_after_limit(self) -> None:
        self.h.config["units"]["caddy.service"] = {"active": "failed", "nrestarts": 0}
        self.h.config["units"]["bojin.service"] = {"active": "failed", "nrestarts": 0}
        res = self.h.run_watchdog()
        self.assertEqual(res.returncode, 0, res.stderr)
        sctl = [e["args"] for e in self.h.events() if e["kind"] == "systemctl"]
        self.assertIn(["reset-failed", "caddy.service"], sctl)
        self.assertIn(["start", "--no-block", "caddy.service"], sctl)
        self.assertIn(["reset-failed", "bojin.service"], sctl)
        self.assertIn(["start", "--no-block", "bojin.service"], sctl)

        # Active bojin failing /api/health twice then recovering does not restart; 3 consecutive failures restarts.
        self.h.clear_events()
        self.h.config["units"]["caddy.service"] = {"active": "active", "nrestarts": 0}
        self.h.config["units"]["bojin.service"] = {"active": "active", "nrestarts": 0}
        self.h.config["curl"]["http://127.0.0.1:8080/api/health"] = 22
        self.h.run_watchdog()
        self.h.run_watchdog()
        self.h.config["curl"]["http://127.0.0.1:8080/api/health"] = 0
        self.h.run_watchdog()
        self.assertFalse((self.h.state_dir / "failures").exists())

        self.h.clear_events()
        self.h.config["curl"]["http://127.0.0.1:8080/api/health"] = 22
        for uptime in (2000.0, 2030.0, 2060.0):
            self.h.set_uptime(uptime)
            self.h.run_watchdog()
        sctl = [e["args"] for e in self.h.events() if e["kind"] == "systemctl"]
        self.assertIn(["restart", "--no-block", "bojin.service"], sctl)

    def test_nrestarts_crash_alert_retries_after_transient_failure_and_deduplicates_same_mount(self) -> None:
        self.h.run_watchdog()
        self.h.clear_events()

        # All 3 paths share mount "/" at 95%, and bojin crashed once, while ntfy fails transiently.
        for p in ("/var/lib/bojin", "/var/backups", "/opt"):
            self.h.config["df"][p] = {"pcent": "95%", "ipcent": "10%", "target": "/"}
        self.h.config["units"]["bojin.service"] = {"active": "active", "nrestarts": 1}
        self.h.config["curl"]["https://ntfy.sh/test-secret-topic"] = 28
        self.h.set_uptime(1030.0)
        self.h.run_watchdog()

        # On next tick ntfy recovers and NRestarts stays 1: crash alert must still fire and mount "/" alerts once.
        self.h.clear_events()
        self.h.config["curl"]["https://ntfy.sh/test-secret-topic"] = 0
        self.h.set_uptime(1060.0)
        self.h.run_watchdog()
        delivered = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        disk_msgs = [m for m in delivered if "disk holding" in m]
        crash_msgs = [m for m in delivered if "app crashed and systemd restarted it" in m]
        self.assertEqual(len(disk_msgs), 1, delivered)
        self.assertEqual(len(crash_msgs), 1, delivered)

    def test_watchdog_checks_and_restarts_are_not_starved_by_hanging_alerts(self) -> None:
        # Three distinct full mountpoints + both services at their 3rd consecutive probe failure,
        # while ntfy.sh hangs (10s per attempt). Lifecycle checks and restarts MUST happen first
        # and total alert delivery must stay within the bounded budget.
        self.h.state_dir.mkdir(parents=True, exist_ok=True)
        (self.h.state_dir / "failures-caddy.service").write_text("2\n", encoding="utf-8")
        (self.h.state_dir / "failures").write_text("2\n", encoding="utf-8")
        self.h.config["df"] = {
            "/var/lib/bojin": {"pcent": "95%", "ipcent": "10%", "target": "/mnt/data"},
            "/var/backups": {"pcent": "96%", "ipcent": "10%", "target": "/mnt/backups"},
            "/opt": {"pcent": "97%", "ipcent": "10%", "target": "/"},
        }
        self.h.config["curl"]["http://127.0.0.1:80/"] = 28
        self.h.config["curl"]["http://127.0.0.1:8080/api/health"] = 28
        self.h.config["curl"]["https://ntfy.sh/test-secret-topic"] = {"rc": 0, "delay": 10.0}

        started = time.monotonic()
        res = self.h.run_watchdog(
            env_extra={
                "BOJIN_WATCHDOG_ALERT_BUDGET_SEC": "2",
                "BOJIN_WATCHDOG_ALERT_MAX_TIME": "1",
            }
        )
        elapsed = time.monotonic() - started
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertLess(elapsed, 8.0, f"Watchdog exceeded alert budget ({elapsed:.2f}s)")

        events = self.h.events()
        restart_indices = [
            idx for idx, e in enumerate(events)
            if e["kind"] == "systemctl"
            and e["args"] in (["restart", "--no-block", "caddy.service"], ["restart", "--no-block", "bojin.service"])
        ]
        alert_indices = [
            idx for idx, e in enumerate(events)
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertEqual(len(restart_indices), 2, f"Expected both restarts in {events}")
        self.assertTrue(alert_indices, "Expected at least one bounded alert delivery attempt")
        self.assertLess(max(restart_indices), min(alert_indices), "Service restarts must run BEFORE external alert webhooks")

        # Next tick: services recovered and ntfy is fast again -> all queued alerts flush cleanly.
        self.h.clear_events()
        self.h.config["df"] = {
            "/var/lib/bojin": {"pcent": "40%", "ipcent": "10%", "target": "/mnt/data"},
            "/var/backups": {"pcent": "40%", "ipcent": "10%", "target": "/mnt/backups"},
            "/opt": {"pcent": "40%", "ipcent": "10%", "target": "/"},
        }
        self.h.config["curl"]["http://127.0.0.1:80/"] = 0
        self.h.config["curl"]["http://127.0.0.1:8080/api/health"] = 0
        self.h.config["curl"]["https://ntfy.sh/test-secret-topic"] = 0
        self.h.set_uptime(1030.0)
        res2 = self.h.run_watchdog()
        self.assertEqual(res2.returncode, 0, res2.stderr)
        flushed = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertEqual(len(flushed), 5, f"Expected 3 disk + 2 unhealthy deferred alerts, got {flushed}")

    def test_nrestarts_tracks_invocation_id_on_first_observation_and_counter_reset(self) -> None:
        # 1. First observation when unit already crashed (NRestarts=2) must alert, not silently baseline.
        self.h.config["units"]["bojin.service"] = {
            "active": "active",
            "nrestarts": 2,
            "invocation": "inv-initial-crash",
        }
        res1 = self.h.run_watchdog()
        self.assertEqual(res1.returncode, 0, res1.stderr)
        delivered1 = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertTrue(any("app crashed and systemd restarted it (2x" in m for m in delivered1), delivered1)

        # 2. Sample at NRestarts=10 (after cooldown), followed by deploy/manual restart + 1 crash (current=1 < previous=10).
        self.h.set_uptime(3000.0)
        self.h.config["units"]["bojin.service"] = {
            "active": "active",
            "nrestarts": 10,
            "invocation": "inv-before-deploy",
        }
        self.h.run_watchdog()
        self.h.clear_events()

        # Clean deploy (NRestarts=0, new InvocationID) -> must NOT alert.
        self.h.set_uptime(5000.0)
        self.h.config["units"]["bojin.service"] = {
            "active": "active",
            "nrestarts": 0,
            "invocation": "inv-clean-deploy",
        }
        self.h.run_watchdog()
        self.assertEqual([e for e in self.h.events() if e["kind"] == "curl" and "ntfy.sh" in e["url"]], [])

        # Re-establish NRestarts=10, then reset between samples + 1 crash before next tick (current=1 < 10).
        self.h.set_uptime(7000.0)
        self.h.config["units"]["bojin.service"] = {
            "active": "active",
            "nrestarts": 10,
            "invocation": "inv-ten",
        }
        self.h.run_watchdog()
        self.h.clear_events()

        self.h.set_uptime(9000.0)
        self.h.config["units"]["bojin.service"] = {
            "active": "active",
            "nrestarts": 1,
            "invocation": "inv-reset-then-crash",
        }
        res_reset = self.h.run_watchdog()
        self.assertEqual(res_reset.returncode, 0, res_reset.stderr)
        delivered_reset = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertTrue(
            any("app crashed and systemd restarted it (1x" in m for m in delivered_reset),
            f"Expected crash alert after counter reset (10 -> 0 -> 1), got {delivered_reset}",
        )

        # 3. Equal nonzero NRestarts (1 -> 0 -> 1) across a new InvocationID must also alert.
        self.h.clear_events()
        self.h.set_uptime(11000.0)
        self.h.config["units"]["bojin.service"] = {
            "active": "active",
            "nrestarts": 1,
            "invocation": "inv-second-reset-crash",
        }
        self.h.run_watchdog()
        delivered_equal = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertTrue(
            any("app crashed and systemd restarted it (1x" in m for m in delivered_equal),
            f"Expected crash alert on new InvocationID with NRestarts=1, got {delivered_equal}",
        )

    def test_alert_follows_https_post_redirects_and_rejects_unfollowed_3xx(self) -> None:
        # 1. Bare 302 (no Location / non-2xx final response) must fail and NOT write a cooldown stamp.
        self.h.config["df"]["/var/lib/bojin"]["pcent"] = "95%"
        self.h.config["curl"]["https://ntfy.sh/test-secret-topic"] = {"rc": 0, "http_code": "302"}
        res_bare_302 = self.h.run_alert("bare redirect")
        self.assertNotEqual(res_bare_302.returncode, 0, "Unfollowed 302 must not succeed")

        self.h.run_watchdog()
        self.assertEqual(list(self.h.state_dir.glob("alert-disk*")), [], "302 without 2xx delivery must not write stamp")

        # 2. HTTPS 301/302 redirect to an HTTPS endpoint that requires POST succeeds when followed safely.
        self.h.clear_events()
        target_url = "https://ntfy2.example.com/test-secret-topic"
        self.h.config["curl"]["https://ntfy.sh/test-secret-topic"] = {
            "rc": 0,
            "http_code": "301",
            "redirect_to": target_url,
        }
        self.h.config["curl"][target_url] = {"rc": 0, "http_code": "200", "require_post": True}
        res_ok = self.h.run_watchdog()
        self.assertEqual(res_ok.returncode, 0, res_ok.stderr)
        redirects = [e for e in self.h.events() if e["kind"] == "curl_redirect"]
        self.assertEqual(len(redirects), 1)
        self.assertTrue(redirects[0]["post_preserved"])
        self.assertEqual(len(list(self.h.state_dir.glob("alert-disk*"))), 1)

        # 3. Redirect from HTTPS to HTTP downgrade must be rejected.
        self.h.config["curl"]["https://ntfy.sh/test-secret-topic"] = {
            "rc": 0,
            "http_code": "302",
            "redirect_to": "http://ntfy2.example.com/leaked",
        }
        res_downgrade = self.h.run_alert("downgrade redirect")
        self.assertNotEqual(res_downgrade.returncode, 0)

    def test_hanging_systemctl_restart_uses_no_block_and_finishes_within_budget(self) -> None:
        # Simulate BOTH:
        # 1) any blocking systemctl start/restart without --no-block hangs 65s, AND
        # 2) systemctl restart --no-block caddy.service itself hangs 15s (e.g. D-Bus stall).
        # Watchdog must pass --no-block, time out the hung caddy restart, still check/restart
        # bojin.service, and still flush alerts within budget.
        self.h.state_dir.mkdir(parents=True, exist_ok=True)
        (self.h.state_dir / "failures-caddy.service").write_text("2\n", encoding="utf-8")
        (self.h.state_dir / "failures").write_text("2\n", encoding="utf-8")
        self.h.config["df"]["/opt"] = {"pcent": "95%", "ipcent": "10%", "target": "/mnt/opt"}
        self.h.config["curl"]["http://127.0.0.1:80/"] = 28
        self.h.config["curl"]["http://127.0.0.1:8080/api/health"] = 28
        self.h.config["systemctl_delays"] = {
            "blocking_job": 65.0,
            "restart:caddy.service": 15.0,
        }

        started = time.monotonic()
        res = self.h.run_watchdog(
            env_extra={
                "BOJIN_WATCHDOG_CMD_TIMEOUT_SEC": "1",
                "BOJIN_WATCHDOG_CHECKS_BUDGET_SEC": "6",
                "BOJIN_WATCHDOG_ALERT_BUDGET_SEC": "4",
                "BOJIN_WATCHDOG_TOTAL_BUDGET_SEC": "12",
            }
        )
        elapsed = time.monotonic() - started
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertLess(elapsed, 8.0, f"Hanging systemctl restart exceeded budget ({elapsed:.2f}s)")

        sctl = [e["args"] for e in self.h.events() if e["kind"] == "systemctl"]
        self.assertIn(["restart", "--no-block", "caddy.service"], sctl)
        self.assertIn(["restart", "--no-block", "bojin.service"], sctl)

        delivered = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertEqual(len(delivered), 3, f"Expected disk + caddy + bojin alerts flushed, got {delivered}")

    def test_hanging_df_times_out_and_runs_later_checks_and_flushes_alerts(self) -> None:
        # /var/lib/bojin df hangs 15s, while /opt is 94% full and bojin.service crashed once.
        self.h.config["df"] = {
            "/var/lib/bojin": {"pcent": "50%", "ipcent": "10%", "target": "/mnt/hung", "delay": 15.0},
            "/var/backups": {"pcent": "40%", "ipcent": "10%", "target": "/mnt/backups"},
            "/opt": {"pcent": "94%", "ipcent": "10%", "target": "/"},
        }
        self.h.config["units"]["bojin.service"] = {
            "active": "active",
            "nrestarts": 1,
            "invocation": "inv-after-hung-df",
        }

        started = time.monotonic()
        res = self.h.run_watchdog(
            env_extra={
                "BOJIN_WATCHDOG_CMD_TIMEOUT_SEC": "1",
                "BOJIN_WATCHDOG_CHECKS_BUDGET_SEC": "6",
                "BOJIN_WATCHDOG_ALERT_BUDGET_SEC": "4",
                "BOJIN_WATCHDOG_TOTAL_BUDGET_SEC": "12",
            }
        )
        elapsed = time.monotonic() - started
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertLess(elapsed, 8.0, f"Hanging df exceeded budget ({elapsed:.2f}s)")

        delivered = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertTrue(any("/opt" in m and "94%" in m for m in delivered), delivered)
        self.assertTrue(any("app crashed and systemd restarted it (1x" in m for m in delivered), delivered)

    def test_hanging_systemctl_show_preserves_state_and_runs_later_checks_and_alerts(self) -> None:
        # Seed caddy restarts baseline, then make systemctl show hang on caddy.service while
        # bojin.service crashes and /var/backups fills up.
        self.h.config["units"]["caddy.service"] = {
            "active": "active",
            "nrestarts": 3,
            "invocation": "inv-caddy-seed",
        }
        self.h.run_watchdog()
        self.h.clear_events()
        self.h.set_uptime(3000.0)

        self.h.config["systemctl_delays"] = {"show:caddy.service": 15.0}
        self.h.config["df"]["/var/backups"] = {"pcent": "93%", "ipcent": "10%", "target": "/mnt/backups"}
        self.h.config["units"]["bojin.service"] = {
            "active": "active",
            "nrestarts": 2,
            "invocation": "inv-bojin-crash",
        }

        started = time.monotonic()
        res = self.h.run_watchdog(
            env_extra={
                "BOJIN_WATCHDOG_CMD_TIMEOUT_SEC": "1",
                "BOJIN_WATCHDOG_CHECKS_BUDGET_SEC": "6",
                "BOJIN_WATCHDOG_ALERT_BUDGET_SEC": "4",
                "BOJIN_WATCHDOG_TOTAL_BUDGET_SEC": "12",
            }
        )
        elapsed = time.monotonic() - started
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertLess(elapsed, 8.0, f"Hanging systemctl show exceeded budget ({elapsed:.2f}s)")

        # Caddy restart baseline must not be wiped to 0 by a timed-out systemctl show.
        caddy_prev = (self.h.state_dir / "restarts-caddy.service").read_text(encoding="utf-8").strip()
        self.assertEqual(caddy_prev, "3 inv-caddy-seed")

        delivered = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertTrue(any("/var/backups" in m and "93%" in m for m in delivered), delivered)
        self.assertTrue(any("app crashed and systemd restarted it (2x" in m for m in delivered), delivered)

    def test_checks_deadline_reserves_alert_budget_and_accounts_for_kill_grace(self) -> None:
        # 1. Verify production default budgets leave >=22s for alert delivery and stay well under 60s.
        script_text = WATCHDOG_SH.read_text(encoding="utf-8")
        import re
        defaults = {
            m.group(1): int(m.group(2))
            for m in re.finditer(r"(TOTAL_BUDGET_SEC|CHECKS_BUDGET_SEC|ALERT_BUDGET_SEC)=\$\{[^:]+:-([0-9]+)\}", script_text)
        }
        self.assertLessEqual(defaults["TOTAL_BUDGET_SEC"], 52)
        self.assertGreaterEqual(defaults["TOTAL_BUDGET_SEC"] - defaults["CHECKS_BUDGET_SEC"], 22)
        self.assertGreaterEqual(defaults["ALERT_BUDGET_SEC"], 22)

        # 2. When hanging df calls exhaust CHECKS_BUDGET_SEC, pre-queued alerts still flush and
        #    skipped HTTP probes do NOT falsely increment failure counters.
        pending_dir = self.h.state_dir / "pending"
        pending_dir.mkdir(parents=True, exist_ok=True)
        (pending_dir / "crash-bojin.service").write_text("1800\nqueued crash from prior tick\n", encoding="utf-8")
        for p in ("/var/lib/bojin", "/var/backups", "/opt"):
            self.h.config["df"][p] = {"pcent": "50%", "ipcent": "10%", "target": p, "delay": 10.0}

        started = time.monotonic()
        res = self.h.run_watchdog(
            env_extra={
                "BOJIN_WATCHDOG_CMD_TIMEOUT_SEC": "1",
                "BOJIN_WATCHDOG_CHECKS_BUDGET_SEC": "2",
                "BOJIN_WATCHDOG_ALERT_BUDGET_SEC": "3",
                "BOJIN_WATCHDOG_TOTAL_BUDGET_SEC": "6",
            }
        )
        elapsed = time.monotonic() - started
        self.assertEqual(res.returncode, 0, res.stderr)
        # Allow interpreter startup jitter, but remain below a single 10s hung command.
        self.assertLess(elapsed, 8.0)
        self.assertFalse((self.h.state_dir / "failures").exists())
        delivered = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertEqual(delivered, ["Lean Ritual: queued crash from prior tick"])

        # 3. Even when curl ignores SIGTERM and --max-time, -k 1s grace accounting prevents budget overrun.
        self.h.clear_events()
        for idx in range(3):
            (pending_dir / f"custom-{idx}").write_text(f"1800\nmsg {idx}\n", encoding="utf-8")
        for p in ("/var/lib/bojin", "/var/backups", "/opt"):
            self.h.config["df"][p] = {"pcent": "50%", "ipcent": "10%", "target": "/"}
        self.h.config["curl"]["https://ntfy.sh/test-secret-topic"] = {
            "rc": 0,
            "delay": 10.0,
            "ignore_sigterm": True,
        }
        started = time.monotonic()
        res_grace = self.h.run_watchdog(
            env_extra={
                "BOJIN_WATCHDOG_ALERT_BUDGET_SEC": "3",
                "BOJIN_WATCHDOG_ALERT_MAX_TIME": "2",
                "BOJIN_WATCHDOG_TOTAL_BUDGET_SEC": "8",
            }
        )
        elapsed_grace = time.monotonic() - started
        self.assertEqual(res_grace.returncode, 0, res_grace.stderr)
        self.assertLess(elapsed_grace, 8.0, f"Kill grace overran alert budget ({elapsed_grace:.2f}s)")

    def test_hanging_logger_does_not_block_checks_restarts_or_alert_delivery(self) -> None:
        # Simulate a stalled journald/syslog socket (logger hangs 15s on every call) while multiple
        # code paths attempt to log (df timeout, caddy activating, bojin 3rd probe failure + restart,
        # and disk full alert delivery via alert.sh).
        self.h.state_dir.mkdir(parents=True, exist_ok=True)
        (self.h.state_dir / "failures").write_text("2\n", encoding="utf-8")
        self.h.config["logger_delay"] = 15.0
        self.h.config["df"] = {
            "/var/lib/bojin": {"pcent": "50%", "ipcent": "10%", "target": "/mnt/hung", "delay": 5.0},
            "/var/backups": {"pcent": "40%", "ipcent": "10%", "target": "/mnt/backups"},
            "/opt": {"pcent": "96%", "ipcent": "10%", "target": "/"},
        }
        self.h.config["units"]["caddy.service"] = {
            "active": "activating",
            "nrestarts": 0,
            "invocation": "inv-caddy-act",
        }
        self.h.config["curl"]["http://127.0.0.1:8080/api/health"] = 28

        started = time.monotonic()
        res = self.h.run_watchdog(
            env_extra={
                "BOJIN_WATCHDOG_CMD_TIMEOUT_SEC": "1",
                "BOJIN_WATCHDOG_LOG_TIMEOUT_SEC": "1",
                "BOJIN_WATCHDOG_CHECKS_BUDGET_SEC": "6",
                "BOJIN_WATCHDOG_ALERT_BUDGET_SEC": "5",
                "BOJIN_WATCHDOG_TOTAL_BUDGET_SEC": "10",
            },
            timeout=12,
        )
        elapsed = time.monotonic() - started
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertLess(elapsed, 10.0, f"Hanging logger stalled watchdog ({elapsed:.2f}s)")

        sctl = [e["args"] for e in self.h.events() if e["kind"] == "systemctl"]
        self.assertIn(["restart", "--no-block", "bojin.service"], sctl)

        delivered = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertTrue(any("/opt" in m and "96%" in m for m in delivered), delivered)
        self.assertTrue(any("app stopped answering health checks" in m for m in delivered), delivered)

    def test_watchdog_lock_path_creation_symlink_ownership_transition_and_eacces(self) -> None:
        script_text = WATCHDOG_SH.read_text(encoding="utf-8")
        self.assertIn("LOCK_FILE=${BOJIN_WATCHDOG_LOCK_FILE:-/run/bojin/maintenance.lock}", script_text)
        self.assertIn("LEGACY_LOCK_FILE=${BOJIN_WATCHDOG_LEGACY_LOCK_FILE:-/run/lock/bojin-maintenance.lock}", script_text)

        # 1. Missing lock directory is created via install -d -o root -g root -m 0755,
        #    and both locks are acquired non-blocking in exact order: new first, then legacy.
        missing_dir = self.h.root / "missing-run-bojin"
        missing_lock = missing_dir / "maintenance.lock"
        self.h.clear_events()
        res = self.h.run_watchdog(env_extra={"BOJIN_WATCHDOG_LOCK_FILE": str(missing_lock)})
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertTrue(missing_dir.is_dir())
        self.assertTrue(missing_lock.is_file())
        self.assertTrue(self.h.legacy_lock_file.is_file())
        lock_install = [
            args for args in self.h.install_calls()
            if args == ["-d", "-o", "root", "-g", "root", "-m", "0755", str(missing_dir)]
        ]
        self.assertEqual(len(lock_install), 1, self.h.install_calls())
        flocks = self.h.flock_calls()
        self.assertEqual(len(flocks), 2, flocks)
        self.assertTrue(all(f["nonblock"] and f["acquired"] for f in flocks), flocks)
        self.assertEqual(
            [f["ino"] for f in flocks],
            [missing_lock.lstat().st_ino, self.h.legacy_lock_file.lstat().st_ino],
        )

        # 2. Watchdog skips round when EITHER new lock OR legacy lock is held.
        self.h.config["df"]["/var/lib/bojin"]["pcent"] = "99%"
        for label, held_path in [("new", self.h.lock_file), ("legacy", self.h.legacy_lock_file)]:
            with self.subTest(held=label):
                self.h.clear_events()
                with open(held_path, "a+", encoding="utf-8") as fh:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    try:
                        res_skip = self.h.run_watchdog()
                    finally:
                        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
                self.assertEqual(res_skip.returncode, 0, res_skip.stderr)
                self.assertEqual(self.h.events(), [])

        # 3. Symlinked lock dir or symlinked lock file is refused (non-zero exit, target untouched).
        sym_target_dir = self.h.root / "sym-target-dir"
        sym_target_dir.mkdir(mode=0o700)
        sym_dir = self.h.root / "sym-run-bojin"
        sym_dir.symlink_to(sym_target_dir)
        self.h.clear_events()
        res_sym_dir = self.h.run_watchdog(env_extra={"BOJIN_WATCHDOG_LOCK_FILE": str(sym_dir / "maintenance.lock")})
        self.assertNotEqual(res_sym_dir.returncode, 0)
        self.assertEqual(sym_target_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual([e for e in self.h.events() if e["kind"] in ("df", "systemctl", "curl")], [])

        sym_target_file = self.h.root / "sym-target-file"
        sym_target_file.write_text("untouched", encoding="utf-8")
        sym_file = self.h.lock_dir / "sym-maintenance.lock"
        sym_file.symlink_to(sym_target_file)
        self.h.clear_events()
        res_sym_file = self.h.run_watchdog(env_extra={"BOJIN_WATCHDOG_LOCK_FILE": str(sym_file)})
        self.assertNotEqual(res_sym_file.returncode, 0)
        self.assertEqual(sym_target_file.read_text(encoding="utf-8"), "untouched")
        self.assertEqual([e for e in self.h.events() if e["kind"] in ("df", "systemctl", "curl")], [])

        # 4. Non-root lock dir and non-root lock file are refused.
        for bad_path in (self.h.lock_dir, self.h.lock_file):
            with self.subTest(non_root=bad_path.name):
                self.h.lock_file.touch()
                self.h.config["non_root_paths"] = [str(bad_path)]
                self.h.clear_events()
                res_non_root = self.h.run_watchdog()
                self.assertNotEqual(res_non_root.returncode, 0)
                self.assertEqual([e for e in self.h.events() if e["kind"] in ("df", "systemctl", "curl")], [])
        self.h.config["non_root_paths"] = []

        # 5a. If O_CREAT fails with EACCES AND retry without O_CREAT also fails (0000), watchdog MUST fail closed.
        self.h.legacy_lock_file.write_text("", encoding="utf-8")
        self.h.legacy_lock_file.chmod(0o000)
        try:
            self.h.clear_events()
            res_unreadable = self.h.run_watchdog()
            self.assertNotEqual(res_unreadable.returncode, 0)
            self.assertEqual([e for e in self.h.events() if e["kind"] in ("df", "systemctl", "curl")], [])
        finally:
            self.h.legacy_lock_file.chmod(0o600)

        # 5b. Held legacy inode + EACCES on O_CREAT (0444 read-only file locked by legacy participant):
        #     watchdog must retry without O_CREAT, see the held flock, and SKIP the round (not run checks!).
        holder_fd = os.open(self.h.legacy_lock_file, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            fcntl.flock(holder_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.h.legacy_lock_file.chmod(0o444)
            self.h.clear_events()
            self.h.set_uptime(3000.0)
            res_held_eacces = self.h.run_watchdog()
            self.assertEqual(res_held_eacces.returncode, 0, res_held_eacces.stderr)
            self.assertEqual([e for e in self.h.events() if e["kind"] in ("df", "systemctl", "curl")], [])
            flocks_held = self.h.flock_calls()
            self.assertEqual(len(flocks_held), 2, flocks_held)
            self.assertTrue(flocks_held[0]["acquired"] and not flocks_held[1]["acquired"], flocks_held)

            # Once legacy holder releases flock (still 0444 so O_CREAT gets EACCES), watchdog acquires
            # both locks via read-only retry and runs checks normally!
            fcntl.flock(holder_fd, fcntl.LOCK_UN)
            self.h.clear_events()
            self.h.set_uptime(3030.0)
            res_free_eacces = self.h.run_watchdog()
            self.assertEqual(res_free_eacces.returncode, 0, res_free_eacces.stderr)
            self.assertIn("eacces", res_free_eacces.stderr.lower())
            flocks_free = self.h.flock_calls()
            self.assertEqual(len(flocks_free), 2, flocks_free)
            self.assertTrue(all(f["acquired"] for f in flocks_free), flocks_free)
            alert_curls = [e for e in self.h.events() if e["kind"] == "curl" and "ntfy.sh" in e["url"]]
            self.assertEqual(len(alert_curls), 1)
        finally:
            self.h.legacy_lock_file.chmod(0o600)
            os.close(holder_fd)

    def test_maintenance_lock_wrapper_blocks_against_legacy_and_new_holders(self) -> None:
        self.assertTrue(MAINT_LOCK_SH.is_file())
        self.assertTrue(os.access(MAINT_LOCK_SH, os.X_OK), "ops/maintenance-lock.sh must be executable")
        wrapper_env = self.h.base_env({
            "BOJIN_LOCK_TEST_MODE": "1",
            "BOJIN_MAINTENANCE_LOCK_FILE": str(self.h.lock_file),
            "BOJIN_MAINTENANCE_LEGACY_LOCK_FILE": str(self.h.legacy_lock_file),
        })

        # 1. Contrast new-only manual flock vs transition wrapper while an old participant holds ONLY
        #    the legacy lock (and legacy file is 0444 causing EACCES on O_CREAT):
        #    - New-only flock runs immediately (demonstrating the bug without the wrapper);
        #    - ops/maintenance-lock.sh -n fails immediately without running the command;
        #    - ops/maintenance-lock.sh -- <cmd> BLOCKS until the old participant releases the legacy lock!
        timeline = self.h.root / "manual-timeline.log"
        old_holder = subprocess.Popen(
            [
                os.environ.get("PYTHON", "python3"),
                "-c",
                f"""
import fcntl, os, pathlib, time
p = pathlib.Path({str(self.h.legacy_lock_file)!r})
tl = pathlib.Path({str(timeline)!r})
fd = os.open(p, os.O_RDWR | os.O_CREAT, 0o644)
fcntl.flock(fd, fcntl.LOCK_EX)
os.chmod(p, 0o444)
with tl.open("a") as fh: fh.write("OLD_PARTICIPANT_HELD\\n")
print("READY", flush=True)
time.sleep(1.5)
with tl.open("a") as fh: fh.write("OLD_PARTICIPANT_RELEASED\\n")
os.chmod(p, 0o644)
os.close(fd)
""",
            ],
            stdout=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(old_holder.stdout.readline().strip(), "READY")
            # New-only flock acquires immediately even while old_holder is inside maintenance (the bug without wrapper):
            with open(self.h.lock_file, "a+", encoding="utf-8") as new_only_fh:
                fcntl.flock(new_only_fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(new_only_fh.fileno(), fcntl.LOCK_UN)

            # Non-blocking wrapper must refuse to run while old participant holds legacy lock.
            marker_nb = self.h.root / "ran-nb"
            res_nb = subprocess.run(
                [str(MAINT_LOCK_SH), "-n", "--", "touch", str(marker_nb)],
                env=wrapper_env,
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertNotEqual(res_nb.returncode, 0)
            self.assertFalse(marker_nb.exists())

            # Blocking wrapper must wait for old participant to release legacy lock before running manual cmd.
            started = time.monotonic()
            res_blk = subprocess.run(
                [str(MAINT_LOCK_SH), "--", "bash", "-c", f'echo MANUAL_MAINT_RAN >> "{timeline}"'],
                env=wrapper_env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            elapsed = time.monotonic() - started
            old_holder.wait(timeout=5)
            self.assertEqual(res_blk.returncode, 0, res_blk.stderr)
            self.assertIn("eacces", res_blk.stderr.lower())
            self.assertGreaterEqual(elapsed, 0.5, f"Wrapper did not wait for old participant ({elapsed:.2f}s)")
            self.assertEqual(
                timeline.read_text(encoding="utf-8").splitlines(),
                ["OLD_PARTICIPANT_HELD", "OLD_PARTICIPANT_RELEASED", "MANUAL_MAINT_RAN"],
            )
        finally:
            if old_holder.stdout is not None:
                old_holder.stdout.close()
            if old_holder.poll() is None:
                old_holder.kill()
                old_holder.wait()

        # 2. Wrapper creates missing lock dir, closes lock fds in child, preserves child exit code,
        #    and refuses symlink/non-root/unreadable locks.
        missing_lock = self.h.root / "wrapper-missing-dir/maintenance.lock"
        env_missing = self.h.base_env({
            "BOJIN_LOCK_TEST_MODE": "1",
            "BOJIN_MAINTENANCE_LOCK_FILE": str(missing_lock),
            "BOJIN_MAINTENANCE_LEGACY_LOCK_FILE": str(self.h.legacy_lock_file),
        })
        res_exit = subprocess.run(
            [str(MAINT_LOCK_SH), "--", "python3", "-c", "import os, sys; assert len(os.listdir('/dev/fd')) < 10; sys.exit(17)"],
            env=env_missing,
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(res_exit.returncode, 17, res_exit.stderr)
        self.assertTrue(missing_lock.parent.is_dir())

        # Symlink lock dir refused
        sym_dir = self.h.root / "wrapper-sym-dir"
        sym_dir.symlink_to(self.h.state_dir)
        res_sym = subprocess.run(
            [str(MAINT_LOCK_SH), "--", "true"],
            env=self.h.base_env({
                "BOJIN_LOCK_TEST_MODE": "1",
                "BOJIN_MAINTENANCE_LOCK_FILE": str(sym_dir / "maintenance.lock"),
                "BOJIN_MAINTENANCE_LEGACY_LOCK_FILE": str(self.h.legacy_lock_file),
            }),
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertNotEqual(res_sym.returncode, 0)

        # Unreadable 0000 legacy lock fails closed
        self.h.legacy_lock_file.chmod(0o000)
        try:
            res_000 = subprocess.run(
                [str(MAINT_LOCK_SH), "--", "true"],
                env=wrapper_env,
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertNotEqual(res_000.returncode, 0)
        finally:
            self.h.legacy_lock_file.chmod(0o600)

    def test_install_reliability_installs_tmpfiles_and_refuses_symlink(self) -> None:
        self.assertTrue(TMPFILES_CONF.is_file())
        self.assertEqual(TMPFILES_CONF.read_text(encoding="utf-8").strip(), "d /run/bojin 0755 root root -")
        root = self.h.root / "rel-install"
        src = root / "src"
        src.mkdir(parents=True)
        for asset in (
            "alert.sh", "health-watchdog.sh", "maintenance-lock.sh", "bojin-alert@.service",
            "bojin-watchdog.service", "bojin-watchdog.timer",
            "bojin-reliability.conf", "caddy-reliability.conf",
            "backup-alert.conf", "alert.env.example", "bojin-tmpfiles.conf",
        ):
            (src / asset).write_text((ROOT / "ops" / asset).read_text(encoding="utf-8"), encoding="utf-8")

        write_executable(self.h.bin_dir / "systemd-tmpfiles", "#!/usr/bin/env bash\nexit 0\n")
        script = INSTALL_SH.read_text(encoding="utf-8")
        script = script.replace("[[ $EUID -eq 0 ]]", "[[ 1 -eq 1 ]]")
        script = script.replace("/usr/local/libexec", str(root / "libexec"))
        script = script.replace("/usr/local/sbin", str(root / "sbin"))
        script = script.replace("/etc/systemd/system", str(root / "systemd"))
        script = script.replace("/etc/tmpfiles.d", str(root / "tmpfiles.d"))
        script = script.replace("/etc/bojin-alert.env", str(root / "bojin-alert.env"))
        script = script.replace("/run/bojin", str(root / "run-bojin"))
        (root / "libexec").mkdir(parents=True)
        (root / "sbin").mkdir(parents=True)
        (root / "systemd").mkdir(parents=True)
        harness = src / "install-reliability.sh"
        harness.write_text(script, encoding="utf-8")

        res = subprocess.run(["bash", str(harness)], env=self.h.base_env(), capture_output=True, text=True, timeout=10)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual((root / "tmpfiles.d/bojin.conf").read_text(encoding="utf-8").strip(), "d /run/bojin 0755 root root -")
        self.assertTrue((root / "run-bojin").is_dir())
        self.assertTrue((root / "sbin/bojin-maintenance-lock").is_file())

        # Refuse symlinked /run/bojin
        (root / "run-bojin").rmdir()
        (root / "run-bojin").symlink_to(root / "systemd")
        res_sym = subprocess.run(["bash", str(harness)], env=self.h.base_env(), capture_output=True, text=True, timeout=10)
        self.assertNotEqual(res_sym.returncode, 0)

    def test_disk_usage_guard_warns_at_80_and_escalates_immediately_at_90(self) -> None:
        # 1. 79% disk / 79% inodes -> silent.
        for p in ("/var/lib/bojin", "/var/backups", "/opt"):
            self.h.config["df"][p] = {"pcent": "79%", "ipcent": "79%", "target": "/"}
        self.h.set_uptime(1000.0)
        res79 = self.h.run_watchdog()
        self.assertEqual(res79.returncode, 0, res79.stderr)
        self.assertEqual([e for e in self.h.events() if e["kind"] == "curl" and "ntfy.sh" in e["url"]], [])

        # 2. 80% disk -> fires warning alert via ALERT_URL before disk passes 80%.
        self.h.clear_events()
        for p in ("/var/lib/bojin", "/var/backups", "/opt"):
            self.h.config["df"][p] = {"pcent": "80%", "ipcent": "50%", "target": "/"}
        self.h.set_uptime(1030.0)
        res80 = self.h.run_watchdog()
        self.assertEqual(res80.returncode, 0, res80.stderr)
        delivered80 = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertEqual(len(delivered80), 1, delivered80)
        self.assertIn("80%", delivered80[0])
        self.assertIn("warning threshold 80%", delivered80[0])

        # 3. 83% disk 30s later -> suppressed by 6h warning cooldown.
        self.h.clear_events()
        for p in ("/var/lib/bojin", "/var/backups", "/opt"):
            self.h.config["df"][p] = {"pcent": "83%", "ipcent": "50%", "target": "/"}
        self.h.set_uptime(1060.0)
        self.h.run_watchdog()
        self.assertEqual([e for e in self.h.events() if e["kind"] == "curl" and "ntfy.sh" in e["url"]], [])

        # 4. 90% disk 60s later -> escalates IMMEDIATELY via separate critical key (not blocked by 80% cooldown).
        self.h.clear_events()
        for p in ("/var/lib/bojin", "/var/backups", "/opt"):
            self.h.config["df"][p] = {"pcent": "90%", "ipcent": "50%", "target": "/"}
        self.h.set_uptime(1090.0)
        res90 = self.h.run_watchdog()
        self.assertEqual(res90.returncode, 0, res90.stderr)
        delivered90 = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertEqual(len(delivered90), 1, delivered90)
        self.assertIn("CRITICAL", delivered90[0])
        self.assertIn("90%", delivered90[0])

        # 5. 80% inodes -> warns at 80% threshold.
        self.h.clear_events()
        for p in ("/var/lib/bojin", "/var/backups", "/opt"):
            self.h.config["df"][p] = {"pcent": "50%", "ipcent": "80%", "target": "/"}
        self.h.set_uptime(1120.0)
        res_inodes = self.h.run_watchdog()
        self.assertEqual(res_inodes.returncode, 0, res_inodes.stderr)
        delivered_inodes = [
            e["args"][e["args"].index("--data-binary") + 1]
            for e in self.h.events()
            if e["kind"] == "curl" and "ntfy.sh" in e["url"]
        ]
        self.assertEqual(len(delivered_inodes), 1, delivered_inodes)
        self.assertIn("inodes", delivered_inodes[0])
        self.assertIn("80%", delivered_inodes[0])


if __name__ == "__main__":
    unittest.main()
