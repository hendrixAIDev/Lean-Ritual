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
import unittest

ROOT = Path(__file__).resolve().parents[1]
WATCHDOG_SH = ROOT / "ops/health-watchdog.sh"
ALERT_SH = ROOT / "ops/alert.sh"
INSTALL_SH = ROOT / "ops/install-reliability.sh"
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
        self.alert_env_file = self.mock_dir / "bojin-alert.env"
        self.lock_file = self.mock_dir / "bojin-maintenance.lock"
        self.uptime_file = self.mock_dir / "uptime"

        self.alert_env_file.write_text("ALERT_URL=https://ntfy.sh/test-secret-topic\n", encoding="utf-8")
        self.set_uptime(1000.0)
        self.config = {
            "units": {
                "bojin.service": {"active": "active", "nrestarts": 0},
                "caddy.service": {"active": "active", "nrestarts": 0},
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
args = sys.argv[1:]
record("systemctl", args=args)
if len(args) >= 2 and args[0] == "is-active":
    unit = args[-1]
    state = CFG["units"].get(unit, {}).get("active", "inactive")
    if "--quiet" not in args:
        print(state)
    sys.exit(0 if state == "active" else 3)
if len(args) >= 4 and args[0] == "show" and "-p" in args and "NRestarts" in args:
    unit = args[-1]
    val = CFG["units"].get(unit, {}).get("nrestarts", 0)
    print(val)
    sys.exit(0)
sys.exit(0)
""",
        )

        write_executable(
            self.bin_dir / "df",
            stub_prelude
            + """
args = sys.argv[1:]
record("df", args=args)
path = args[-1]
info = CFG["df"].get(path)
if info is None:
    sys.exit(1)
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
args = sys.argv[1:]
url = args[-1]
record("curl", args=args, url=url)
rc = CFG["curl"].get(url, 0)
if rc != 0:
    sys.stderr.write(f"curl: ({rc}) simulated failure\\n")
sys.exit(rc)
""",
        )

        write_executable(
            self.bin_dir / "logger",
            stub_prelude
            + """
record("logger", args=sys.argv[1:])
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
            self.bin_dir / "flock",
            """#!/usr/bin/env python3
import fcntl, sys
args = sys.argv[1:]
nonblock = "-n" in args
fd = int(args[-1])
flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblock else 0)
try:
    fcntl.flock(fd, flags)
except BlockingIOError:
    sys.exit(1)
sys.exit(0)
""",
        )

    def base_env(self, extra: dict | None = None) -> dict:
        env = os.environ.copy()
        env.pop("ALERT_URL", None)
        env["PATH"] = f"{self.bin_dir}:{env.get('PATH', '/usr/bin:/bin')}"
        env["OPS_TEST_CONFIG"] = str(self.config_file)
        env["OPS_TEST_EVENTS"] = str(self.events_file)
        env["BOJIN_ALERT_ENV_FILE"] = str(self.alert_env_file)
        env["BOJIN_WATCHDOG_STATE_DIR"] = str(self.state_dir)
        env["BOJIN_WATCHDOG_ALERT_BIN"] = str(ALERT_SH)
        env["BOJIN_WATCHDOG_LOCK_FILE"] = str(self.lock_file)
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

    def run_watchdog(self, env_extra: dict | None = None) -> subprocess.CompletedProcess:
        self._save_config()
        return subprocess.run(
            ["bash", str(WATCHDOG_SH)],
            env=self.base_env(env_extra),
            capture_output=True,
            text=True,
            timeout=10,
        )


class OpsScriptsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.h = OpsHarness(Path(self._tmp.name))

    def test_bash_syntax_all_ops_scripts(self) -> None:
        for script in (WATCHDOG_SH, ALERT_SH, INSTALL_SH):
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
                    if e["kind"] == "systemctl" and e["args"] == ["restart", "caddy.service"]
                ]
                self.assertEqual(caddy_restarts, [])

        caddy_restarts = [
            e for e in self.h.events()
            if e["kind"] == "systemctl" and e["args"] == ["restart", "caddy.service"]
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
        self.assertIn(["restart", "bojin.service"], sctl)

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


if __name__ == "__main__":
    unittest.main()
