"""Behavioral and configuration tests for Aliyun SWAS daily disk snapshots."""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_SH = ROOT / "ops/disk-snapshot.sh"
WORKFLOW_YML = ROOT / ".github/workflows/disk-snapshot.yml"
DOC_ZH = ROOT / "docs/DISK-SNAPSHOTS.zh-CN.md"


class MockAliyunHarness:
    """Isolated sandbox with a stateful stub `aliyun` CLI."""

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.bin_dir = self.root / "bin"
        self.tmp_dir = self.root / "tmp"
        self.state_file = self.root / "state.json"
        self.calls_file = self.root / "calls.jsonl"
        self.bin_dir.mkdir()
        self.tmp_dir.mkdir(mode=0o700)

        self.state = {
            "instance_id": "inst-prod-001",
            "disk_id": "d-sys-001",
            "disk_type": "system",
            "wrap_nested": False,
            "max_snapshots": 3,
            "create_polls_before_done": 1,
            "create_final_status": "Accomplished",
            "fail_api": None,
            "next_snap_seq": 1,
            "snapshots": [],
        }
        self.save_state()
        self._install_aliyun_stub()

    def save_state(self) -> None:
        self.state_file.write_text(json.dumps(self.state), encoding="utf-8")

    def load_state(self) -> dict:
        return json.loads(self.state_file.read_text(encoding="utf-8"))

    def calls(self) -> list[dict]:
        if not self.calls_file.exists():
            return []
        return [
            json.loads(line)
            for line in self.calls_file.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def _install_aliyun_stub(self) -> None:
        stub = self.bin_dir / "aliyun"
        stub.write_text(
            """#!/usr/bin/env python3
import json, os, stat, sys
from pathlib import Path

state_path = Path(os.environ["MOCK_ALIYUN_STATE"])
calls_path = Path(os.environ["MOCK_ALIYUN_CALLS"])
state = json.loads(state_path.read_text(encoding="utf-8"))

args = sys.argv[1:]
cfg_path = None
profile = None
rest = []
i = 0
while i < len(args):
    if args[i] == "--config-path":
        cfg_path = args[i + 1]
        i += 2
    elif args[i] in ("--profile", "-p"):
        profile = args[i + 1]
        i += 2
    else:
        rest.append(args[i])
        i += 1

# Verify credentials file permissions if --config-path was passed, and ensure AKs were scrubbed from env.
env_leaked = bool(os.environ.get("ALIYUN_SNAPSHOT_AK_ID") or os.environ.get("ALIYUN_SNAPSHOT_AK_SECRET"))
cfg_mode = None
if cfg_path:
    st = os.stat(cfg_path)
    cfg_mode = st.st_mode & 0o777
    cfg_data = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
    prof = [p for p in cfg_data.get("profiles", []) if p.get("name") == profile]
    if not prof or not prof[0].get("access_key_id") or not prof[0].get("access_key_secret"):
        sys.stderr.write("ERROR: Invalid config profile\\n")
        sys.exit(1)

service = rest[0] if len(rest) > 0 else ""
action = rest[1] if len(rest) > 1 else ""
params = {}
j = 2
while j < len(rest):
    if rest[j].startswith("--") and j + 1 < len(rest):
        params[rest[j][2:]] = rest[j + 1]
        j += 2
    else:
        j += 1

with calls_path.open("a", encoding="utf-8") as handle:
    handle.write(json.dumps({
        "service": service,
        "action": action,
        "params": params,
        "profile": profile,
        "cfg_mode": cfg_mode,
        "env_leaked": env_leaked,
    }) + "\\n")

if state.get("fail_api") == action:
    mock_tok = "LTAI" + ("0" * 20)
    sys.stderr.write(f"ERROR: SDK.ServerError ErrorCode: NoPermission token={mock_tok}\\n")
    sys.exit(1)

if service != "swas-open":
    sys.stderr.write(f"Unexpected service {service}\\n")
    sys.exit(1)

if action == "ListDisks":
    disks = [{
        "DiskId": state["disk_id"],
        "InstanceId": state["instance_id"],
        "DiskType": state["disk_type"],
        "RegionId": params.get("RegionId", "us-west-1"),
    }]
    out = {"Disks": {"Disk": disks} if state.get("wrap_nested") else disks, "TotalCount": len(disks)}
    print(json.dumps(out))
elif action == "ListSnapshots":
    snaps = state["snapshots"]
    # Advance poll counter on any progressing snapshot if queried during polling.
    if "SnapshotIds" in params:
        queried_ids = set(json.loads(params["SnapshotIds"]))
        for s in snaps:
            if s["SnapshotId"] in queried_ids and s["Status"].lower() == "progressing":
                rem = s.get("_polls_remaining", 0)
                if rem <= 0:
                    s["Status"] = state.get("create_final_status", "Accomplished")
                    s["Progress"] = "100%" if s["Status"].lower() == "accomplished" else "50%"
                else:
                    s["_polls_remaining"] = rem - 1
                    s["Progress"] = "60%"
        state_path.write_text(json.dumps(state), encoding="utf-8")
        visible = [
            {k: v for k, v in s.items() if not k.startswith("_")}
            for s in snaps if s["SnapshotId"] in queried_ids
        ]
    else:
        visible = [{k: v for k, v in s.items() if not k.startswith("_")} for s in snaps]
    out = {
        "Snapshots": {"Snapshot": visible} if state.get("wrap_nested") else visible,
        "TotalCount": len(visible),
    }
    print(json.dumps(out))
elif action == "CreateSnapshot":
    if len(state["snapshots"]) >= state["max_snapshots"]:
        sys.stderr.write("ERROR: SDK.ServerError ErrorCode: SnapshotLimitExceeded\\n")
        sys.exit(1)
    seq = state["next_snap_seq"]
    state["next_snap_seq"] = seq + 1
    sid = f"s-auto-{seq:04d}"
    polls = state.get("create_polls_before_done", 1)
    new_snap = {
        "SnapshotId": sid,
        "SnapshotName": params["SnapshotName"],
        "SourceDiskId": params["DiskId"],
        "SourceDiskType": "System",
        "InstanceId": state["instance_id"],
        "Status": "Progressing" if polls > 0 else state.get("create_final_status", "Accomplished"),
        "Progress": "25%" if polls > 0 else "100%",
        "CreationTime": f"2026-11-18T05:00:{seq:02d}Z",
        "_polls_remaining": max(0, polls - 1),
    }
    state["snapshots"].append(new_snap)
    state_path.write_text(json.dumps(state), encoding="utf-8")
    print(json.dumps({"RequestId": f"req-{seq}", "SnapshotId": sid}))
elif action == "DeleteSnapshot":
    sid = params["SnapshotId"]
    before = len(state["snapshots"])
    state["snapshots"] = [s for s in state["snapshots"] if s["SnapshotId"] != sid]
    if len(state["snapshots"]) == before:
        sys.stderr.write(f"ERROR: Snapshot {sid} not found\\n")
        sys.exit(1)
    state_path.write_text(json.dumps(state), encoding="utf-8")
    print(json.dumps({"RequestId": "req-del"}))
else:
    sys.stderr.write(f"Unknown action {action}\\n")
    sys.exit(1)
""",
            encoding="utf-8",
        )
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    def run_script(self, date_str: str = "20261118", extra_env: dict | None = None) -> subprocess.CompletedProcess:
        env = {
            "PATH": f"{self.bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "TMPDIR": str(self.tmp_dir),
            "MOCK_ALIYUN_STATE": str(self.state_file),
            "MOCK_ALIYUN_CALLS": str(self.calls_file),
            "ALIYUN_SNAPSHOT_AK_ID": "LTAI" + ("9" * 20),
            "ALIYUN_SNAPSHOT_AK_SECRET": "test_placeholder_not_a_secret_0000",
            "LR_REGION": "us-west-1",
            "LR_INSTANCE_ID": "inst-prod-001",
            "LR_DISK_ID": "d-sys-001",
            "LR_SNAPSHOT_DATE": date_str,
            "LR_POLL_INTERVAL_SECONDS": "0",
            "LR_POLL_TIMEOUT_SECONDS": "5",
        }
        if extra_env:
            env.update(extra_env)
        return subprocess.run(
            ["bash", str(SNAPSHOT_SH)],
            env=env,
            text=True,
            capture_output=True,
            timeout=15,
        )


class DiskSnapshotTests(unittest.TestCase):
    def test_workflow_docs_and_policy_contract(self):
        self.assertTrue(SNAPSHOT_SH.is_file())
        self.assertTrue(WORKFLOW_YML.is_file())
        self.assertTrue(DOC_ZH.is_file())

        wf = WORKFLOW_YML.read_text(encoding="utf-8")
        self.assertIn("cron: '0 5 * * *'", wf)
        self.assertIn("workflow_dispatch:", wf)
        self.assertIn("contents: read", wf)
        self.assertIn("ALIYUN_CLI_VERSION: '3.5.3'", wf)
        self.assertIn("sha256sum --check --strict", wf)
        for ref in (
            "secrets.ALIYUN_SNAPSHOT_AK_ID",
            "secrets.ALIYUN_SNAPSHOT_AK_SECRET",
            "vars.LR_INSTANCE_ID",
            "vars.LR_DISK_ID",
            "vars.LR_REGION",
        ):
            self.assertIn(ref, wf)

        doc = DOC_ZH.read_text(encoding="utf-8")
        for required_phrase in (
            "UTC 05:00",
            "lr-auto-",
            "3 份",
            "回滚磁盘",
            "lr-snapshot-bot",
            "gh workflow disable disk-snapshot.yml",
        ):
            self.assertIn(required_phrase, doc)

        match = re.search(r"```json\s*(\{.*?\})\s*```", doc, flags=re.DOTALL)
        self.assertIsNotNone(match, "Expected JSON RAM policy block in docs/DISK-SNAPSHOTS.zh-CN.md")
        policy = json.loads(match.group(1))
        self.assertEqual(policy.get("Version"), "1")
        allowed_actions = set()
        for stmt in policy.get("Statement", []):
            self.assertEqual(stmt.get("Effect"), "Allow")
            allowed_actions.update(stmt.get("Action", []))
            for res in stmt.get("Resource", []):
                self.assertTrue(res.startswith("acs:swas-open:us-west-1:"), res)
        self.assertEqual(
            allowed_actions,
            {
                "swas-open:ListInstances",
                "swas-open:ListDisks",
                "swas-open:ListSnapshots",
                "swas-open:CreateSnapshot",
                "swas-open:DeleteSnapshot",
            },
        )

    def test_three_day_lifecycle_preserves_manual_and_rotates_auto_at_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            h = MockAliyunHarness(Path(directory))
            # Owner created 1 manual snapshot today — must NEVER be deleted.
            h.state["snapshots"] = [
                {
                    "SnapshotId": "s-manual-owner",
                    "SnapshotName": "manual-before-upgrade",
                    "SourceDiskId": "d-sys-001",
                    "SourceDiskType": "System",
                    "InstanceId": "inst-prod-001",
                    "Status": "Accomplished",
                    "Progress": "100%",
                    "CreationTime": "2026-11-18T01:00:00Z",
                }
            ]
            h.save_state()

            # Day 1: 1 manual -> creates lr-auto-20261118 (total 2).
            res1 = h.run_script("20261118")
            self.assertEqual(res1.returncode, 0, res1.stderr)
            snaps1 = h.load_state()["snapshots"]
            self.assertEqual([s["SnapshotName"] for s in snaps1], ["manual-before-upgrade", "lr-auto-20261118"])

            # Re-run on Day 1: skips creation cleanly.
            before_calls = len(h.calls())
            res1_dup = h.run_script("20261118")
            self.assertEqual(res1_dup.returncode, 0, res1_dup.stderr)
            dup_actions = [c["action"] for c in h.calls()[before_calls:]]
            self.assertNotIn("CreateSnapshot", dup_actions)
            self.assertNotIn("DeleteSnapshot", dup_actions)

            # Day 2: 1 manual + 1 auto -> creates lr-auto-20261119 (total 3 = at limit).
            h.state = h.load_state()
            res2 = h.run_script("20261119")
            self.assertEqual(res2.returncode, 0, res2.stderr)
            snaps2 = h.load_state()["snapshots"]
            self.assertEqual(
                [s["SnapshotName"] for s in snaps2],
                ["manual-before-upgrade", "lr-auto-20261118", "lr-auto-20261119"],
            )

            # Day 3: at 3-snapshot limit (1 manual + 2 auto) -> deletes oldest auto (20261118) BEFORE creating 20261120,
            # leaving 20261119 intact during creation, and NEVER touches manual-before-upgrade.
            before_day3 = len(h.calls())
            res3 = h.run_script("20261120")
            self.assertEqual(res3.returncode, 0, res3.stderr)
            day3_calls = h.calls()[before_day3:]
            day3_actions = [c["action"] for c in day3_calls]
            self.assertLess(day3_actions.index("DeleteSnapshot"), day3_actions.index("CreateSnapshot"))
            deleted_ids = [c["params"]["SnapshotId"] for c in day3_calls if c["action"] == "DeleteSnapshot"]
            self.assertEqual(deleted_ids, ["s-auto-0001"])

            snaps3 = h.load_state()["snapshots"]
            self.assertEqual(
                [s["SnapshotName"] for s in snaps3],
                ["manual-before-upgrade", "lr-auto-20261119", "lr-auto-20261120"],
            )

            # Verify temporary config was mode 0600, AK env vars were unset before calling aliyun, and temp dir cleaned up.
            for call in h.calls():
                self.assertEqual(call["cfg_mode"], 0o600)
                self.assertFalse(call["env_leaked"])
            self.assertEqual(list(h.tmp_dir.iterdir()), [])
            for secret in ("LTAI" + ("9" * 20), "test_placeholder_not_a_secret_0000"):
                self.assertNotIn(secret, res3.stdout + res3.stderr)

    def test_post_create_prunes_to_two_auto_when_no_manual_snapshots(self):
        with tempfile.TemporaryDirectory() as directory:
            h = MockAliyunHarness(Path(directory))
            h.state["wrap_nested"] = True  # Also verify nested {"Snapshot": [...]} response shape.
            h.state["snapshots"] = [
                {
                    "SnapshotId": "s-auto-old1",
                    "SnapshotName": "lr-auto-20261116",
                    "SourceDiskId": "d-sys-001",
                    "SourceDiskType": "System",
                    "InstanceId": "inst-prod-001",
                    "Status": "accomplished",
                    "Progress": "100%",
                    "CreationTime": "2026-11-16T05:00:00Z",
                },
                {
                    "SnapshotId": "s-auto-old2",
                    "SnapshotName": "lr-auto-20261117",
                    "SourceDiskId": "d-sys-001",
                    "SourceDiskType": "System",
                    "InstanceId": "inst-prod-001",
                    "Status": "Accomplished",
                    "Progress": "100%",
                    "CreationTime": "2026-11-17T05:00:00Z",
                },
            ]
            h.save_state()

            res = h.run_script("20261118")
            self.assertEqual(res.returncode, 0, res.stderr)
            names = [s["SnapshotName"] for s in h.load_state()["snapshots"]]
            self.assertEqual(names, ["lr-auto-20261117", "lr-auto-20261118"])

    def test_fails_loudly_at_limit_when_two_manual_snapshots_leave_no_auto_buffer(self):
        with tempfile.TemporaryDirectory() as directory:
            h = MockAliyunHarness(Path(directory))
            h.state["snapshots"] = [
                {
                    "SnapshotId": "s-man-1",
                    "SnapshotName": "owner-manual-1",
                    "SourceDiskId": "d-sys-001",
                    "SourceDiskType": "System",
                    "InstanceId": "inst-prod-001",
                    "Status": "Accomplished",
                    "Progress": "100%",
                    "CreationTime": "2026-11-16T01:00:00Z",
                },
                {
                    "SnapshotId": "s-man-2",
                    "SnapshotName": "owner-manual-2",
                    "SourceDiskId": "d-sys-001",
                    "SourceDiskType": "System",
                    "InstanceId": "inst-prod-001",
                    "Status": "Accomplished",
                    "Progress": "100%",
                    "CreationTime": "2026-11-17T01:00:00Z",
                },
                {
                    "SnapshotId": "s-auto-only",
                    "SnapshotName": "lr-auto-20261117",
                    "SourceDiskId": "d-sys-001",
                    "SourceDiskType": "System",
                    "InstanceId": "inst-prod-001",
                    "Status": "Accomplished",
                    "Progress": "100%",
                    "CreationTime": "2026-11-17T05:00:00Z",
                },
            ]
            h.save_state()

            res = h.run_script("20261118")
            self.assertNotEqual(res.returncode, 0)
            self.assertIn("Refusing to delete manual snapshots or leave <1 auto snapshot", res.stderr)
            actions = [c["action"] for c in h.calls()]
            self.assertNotIn("DeleteSnapshot", actions)
            self.assertNotIn("CreateSnapshot", actions)
            self.assertEqual(len(h.load_state()["snapshots"]), 3)

    def test_api_error_and_failed_snapshot_status_fail_job_and_redact_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            h = MockAliyunHarness(Path(directory))
            h.state["fail_api"] = "ListSnapshots"
            h.save_state()

            res = h.run_script("20261118")
            self.assertNotEqual(res.returncode, 0)
            self.assertNotIn("LTAI" + ("0" * 20), res.stdout + res.stderr)
            self.assertIn("<REDACTED_AK_ID>", res.stderr)
            self.assertEqual(list(h.tmp_dir.iterdir()), [])

        with tempfile.TemporaryDirectory() as directory:
            h2 = MockAliyunHarness(Path(directory))
            h2.state["create_polls_before_done"] = 1
            h2.state["create_final_status"] = "Failed"
            h2.save_state()

            res2 = h2.run_script("20261118")
            self.assertNotEqual(res2.returncode, 0)
            self.assertIn("unexpected/failed status 'Failed'", res2.stderr)


if __name__ == "__main__":
    unittest.main()
