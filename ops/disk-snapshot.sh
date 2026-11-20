#!/usr/bin/env bash
# Daily Aliyun Simple Application Server (swas-open) system disk snapshot automation.
# Never enable `set -x`; never print or log AccessKey values.
set -euo pipefail
umask 077

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

LR_REGION="${LR_REGION:-}"
LR_INSTANCE_ID="${LR_INSTANCE_ID:-}"
LR_DISK_ID="${LR_DISK_ID:-}"
LR_SNAPSHOT_DATE="${LR_SNAPSHOT_DATE:-$(date -u +%Y%m%d)}"
LR_POLL_INTERVAL_SECONDS="${LR_POLL_INTERVAL_SECONDS:-15}"
LR_POLL_TIMEOUT_SECONDS="${LR_POLL_TIMEOUT_SECONDS:-1200}"
LR_MAX_SNAPSHOTS="${LR_MAX_SNAPSHOTS:-3}"
LR_KEEP_AUTO="${LR_KEEP_AUTO:-2}"

[[ "$LR_REGION" =~ ^[a-z0-9-]+$ ]] || die "LR_REGION must be set to a valid Aliyun region (e.g. us-west-1)"
[[ "$LR_INSTANCE_ID" =~ ^[A-Za-z0-9_-]+$ ]] || die "LR_INSTANCE_ID must be set to a valid SWAS instance ID"
[[ "$LR_DISK_ID" =~ ^[A-Za-z0-9_-]+$ ]] || die "LR_DISK_ID must be set to a valid SWAS system disk ID"
[[ "$LR_SNAPSHOT_DATE" =~ ^[0-9]{8}$ ]] || die "LR_SNAPSHOT_DATE must be YYYYMMDD"
[[ "$LR_POLL_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || die "LR_POLL_INTERVAL_SECONDS must be a non-negative integer"
[[ "$LR_POLL_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "LR_POLL_TIMEOUT_SECONDS must be a positive integer"
[[ "$LR_MAX_SNAPSHOTS" =~ ^[1-9][0-9]*$ ]] || die "LR_MAX_SNAPSHOTS must be a positive integer"
[[ "$LR_KEEP_AUTO" =~ ^[1-9][0-9]*$ ]] || die "LR_KEEP_AUTO must be a positive integer"

command -v aliyun >/dev/null 2>&1 || die "aliyun CLI not found in PATH"
command -v python3 >/dev/null 2>&1 || die "python3 not found in PATH"

TMP_DIR=""
cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

ALIYUN_AUTH_ARGS=()
if [[ -n "${ALIYUN_SNAPSHOT_AK_ID:-}" || -n "${ALIYUN_SNAPSHOT_AK_SECRET:-}" ]]; then
  [[ -n "${ALIYUN_SNAPSHOT_AK_ID:-}" && -n "${ALIYUN_SNAPSHOT_AK_SECRET:-}" ]] || \
    die "Both ALIYUN_SNAPSHOT_AK_ID and ALIYUN_SNAPSHOT_AK_SECRET must be set together"

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lr-snapshot-aliyun.XXXXXX")"
  chmod 700 "$TMP_DIR"
  CFG_FILE="$TMP_DIR/config.json"
  LR_CFG_FILE="$CFG_FILE" python3 -c '
import json, os

cfg_file = os.environ["LR_CFG_FILE"]
ak_id = os.environ["ALIYUN_SNAPSHOT_AK_ID"].strip()
ak_secret = os.environ["ALIYUN_SNAPSHOT_AK_SECRET"].strip()
region = os.environ["LR_REGION"].strip()
if not ak_id or not ak_secret:
    raise SystemExit("Empty Aliyun AccessKey credentials")

payload = {
    "current": "lr-snapshot-ci",
    "profiles": [
        {
            "name": "lr-snapshot-ci",
            "mode": "AK",
            "access_key_id": ak_id,
            "access_key_secret": ak_secret,
            "region_id": region,
            "output_format": "json",
            "language": "en",
            "site": "china",
        }
    ],
    "meta_path": "",
}
fd = os.open(cfg_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
os.chmod(cfg_file, 0o600)
'
  unset ALIYUN_SNAPSHOT_AK_ID ALIYUN_SNAPSHOT_AK_SECRET
  ALIYUN_AUTH_ARGS=(--config-path "$CFG_FILE" --profile lr-snapshot-ci)
elif [[ -n "${ALIYUN_PROFILE:-}" ]]; then
  [[ "${ALIYUN_PROFILE}" =~ ^[A-Za-z0-9._-]+$ ]] || die "Invalid ALIYUN_PROFILE name"
  if [[ -n "${ALIYUN_CONFIG_PATH:-}" ]]; then
    ALIYUN_AUTH_ARGS=(--config-path "$ALIYUN_CONFIG_PATH" --profile "$ALIYUN_PROFILE")
  else
    ALIYUN_AUTH_ARGS=(--profile "$ALIYUN_PROFILE")
  fi
else
  die "Provide ALIYUN_SNAPSHOT_AK_ID + ALIYUN_SNAPSHOT_AK_SECRET (CI) or ALIYUN_PROFILE (local)"
fi

run_aliyun() {
  local out rc=0
  out="$(aliyun "${ALIYUN_AUTH_ARGS[@]}" "$@" 2>&1)" || rc=$?
  if (( rc != 0 )); then
    # Redact any accidental LTAI* token before logging failure output.
    printf '%s\n' "$out" | sed -E 's/LTAI[A-Za-z0-9]{12,32}/<REDACTED_AK_ID>/g' >&2
    die "aliyun $1 $2 failed with exit code $rc"
  fi
  printf '%s\n' "$out"
}

TARGET_NAME="lr-auto-${LR_SNAPSHOT_DATE}"
log "Starting SWAS disk snapshot check (region=$LR_REGION instance=$LR_INSTANCE_ID disk=$LR_DISK_ID target=$TARGET_NAME)"

# 1. Verify the configured disk belongs to this instance and is a system disk.
DISK_JSON="$(run_aliyun swas-open ListDisks \
  --RegionId "$LR_REGION" \
  --InstanceId "$LR_INSTANCE_ID" \
  --DiskIds "[\"$LR_DISK_ID\"]")"

LR_DISK_JSON="$DISK_JSON" python3 -c '
import json, os, sys

data = json.loads(os.environ["LR_DISK_JSON"])
raw = data.get("Disks", [])
disks = raw.get("Disk", []) if isinstance(raw, dict) else (raw or [])
target_disk = os.environ["LR_DISK_ID"]
target_inst = os.environ["LR_INSTANCE_ID"]

matched = [d for d in disks if d.get("DiskId") == target_disk]
if not matched:
    sys.stderr.write(f"ERROR: Disk {target_disk} not found on instance {target_inst}\n")
    sys.exit(1)
disk = matched[0]
inst_id = disk.get("InstanceId") or ""
if inst_id and inst_id != target_inst:
    sys.stderr.write(f"ERROR: Disk {target_disk} belongs to instance {inst_id}, expected {target_inst}\n")
    sys.exit(1)
raw_dtype = disk.get("DiskType")
disk_type = (raw_dtype or "").lower()
if disk_type != "system":
    sys.stderr.write(f"ERROR: Disk {target_disk} has DiskType={raw_dtype!r}, expected system disk\n")
    sys.exit(1)
'

list_instance_snapshots() {
  run_aliyun swas-open ListSnapshots \
    --RegionId "$LR_REGION" \
    --InstanceId "$LR_INSTANCE_ID" \
    --PageSize 100
}

delete_auto_snapshot() {
  local snap_id="$1"
  local snap_name="$2"
  local active_id="${3:-}"
  if [[ "$snap_name" != lr-auto-* ]]; then
    die "FATAL safety check: refusing to delete non-auto snapshot '$snap_name' ($snap_id)"
  fi
  if [[ -n "$active_id" && "$snap_id" == "$active_id" ]]; then
    die "FATAL safety check: refusing to delete today's active snapshot '$snap_name' ($snap_id)"
  fi
  log "Deleting old auto snapshot: name=$snap_name id=$snap_id"
  run_aliyun swas-open DeleteSnapshot \
    --RegionId "$LR_REGION" \
    --SnapshotId "$snap_id" >/dev/null
}

# 2. Inspect existing snapshots before creating today's snapshot.
INITIAL_SNAPS_JSON="$(list_instance_snapshots)"

PLAN_OUTPUT="$(
  LR_SNAPS_JSON="$INITIAL_SNAPS_JSON" \
  LR_TARGET_NAME="$TARGET_NAME" \
  LR_MAX="$LR_MAX_SNAPSHOTS" \
  python3 -c '
import json, os, sys

data = json.loads(os.environ["LR_SNAPS_JSON"])
raw = data.get("Snapshots", [])
snaps = raw.get("Snapshot", []) if isinstance(raw, dict) else (raw or [])
total_count = data.get("TotalCount", len(snaps))
if isinstance(total_count, int) and total_count > len(snaps):
    sys.stderr.write(f"ERROR: Snapshot list truncated ({len(snaps)} of {total_count})\n")
    sys.exit(1)

target_name = os.environ["LR_TARGET_NAME"]
target_disk = os.environ["LR_DISK_ID"]
max_snaps = int(os.environ["LR_MAX"])

for s in sorted(snaps, key=lambda x: (x.get("CreationTime") or "", x.get("SnapshotName") or "", x.get("SnapshotId") or "")):
    sys.stderr.write(
        "Existing snapshot: id={} name={} status={} created={} disk={}\n".format(
            s.get("SnapshotId"),
            s.get("SnapshotName"),
            s.get("Status"),
            s.get("CreationTime"),
            s.get("SourceDiskId"),
        )
    )

same_name = [
    s for s in snaps
    if s.get("SnapshotName") == target_name and (not s.get("SourceDiskId") or s.get("SourceDiskId") == target_disk)
]
if same_name:
    same_name.sort(key=lambda x: (x.get("CreationTime") or "", x.get("SnapshotId") or ""))
    chosen = same_name[-1]
    raw_chosen_st = chosen.get("Status")
    st = (raw_chosen_st or "").lower()
    sid = chosen.get("SnapshotId") or ""
    if not sid:
        sys.stderr.write(f"ERROR: Existing snapshot {target_name} has empty SnapshotId\n")
        sys.exit(1)
    if st == "accomplished":
        print(f"SKIP_ACCOMPLISHED|{sid}|{target_name}")
        sys.exit(0)
    if st == "progressing":
        print(f"POLL_EXISTING|{sid}|{target_name}")
        sys.exit(0)
    sys.stderr.write(f"ERROR: Existing snapshot {target_name} ({sid}) is in unhealthy status {raw_chosen_st!r}\n")
    sys.exit(1)

auto_snaps = [
    s for s in snaps
    if (s.get("SnapshotName") or "").startswith("lr-auto-")
    and (not s.get("SourceDiskId") or s.get("SourceDiskId") == target_disk)
]
auto_snaps.sort(key=lambda x: (x.get("CreationTime") or "", x.get("SnapshotName") or "", x.get("SnapshotId") or ""))
manual_snaps = [s for s in snaps if not (s.get("SnapshotName") or "").startswith("lr-auto-")]

total = len(snaps)
if total >= max_snaps:
    if total - 1 >= max_snaps:
        sys.stderr.write(
            f"ERROR: Instance has {total} snapshots (limit {max_snaps}); deleting 1 auto snapshot is insufficient.\n"
        )
        sys.exit(1)
    if len(auto_snaps) < 2:
        sys.stderr.write(
            f"ERROR: Instance is at the {max_snaps}-snapshot limit ({total} total: {len(manual_snaps)} non-auto, "
            f"{len(auto_snaps)} lr-auto-*). Refusing to delete manual snapshots or leave <1 auto snapshot.\n"
        )
        sys.exit(1)
    oldest = auto_snaps[0]
    oldest_name = oldest.get("SnapshotName")
    remaining = auto_snaps[1:]
    accomplished_remaining = [s for s in remaining if (s.get("Status") or "").lower() == "accomplished"]
    if len(accomplished_remaining) < 1:
        sys.stderr.write(
            f"ERROR: Instance is at the {max_snaps}-snapshot limit, and remaining auto snapshots after deleting "
            f"{oldest_name} would include 0 Accomplished snapshots.\n"
        )
        sys.exit(1)
    oid = oldest.get("SnapshotId") or ""
    oname = oldest.get("SnapshotName") or ""
    if not oid or not oname.startswith("lr-auto-"):
        sys.stderr.write("ERROR: Invalid oldest auto snapshot metadata\n")
        sys.exit(1)
    print(f"DELETE_OLDEST_THEN_CREATE|{oid}|{oname}")
else:
    print("CREATE_DIRECT||")
'
)"

IFS='|' read -r ACTION SNAP_ARG1 SNAP_ARG2 <<<"$PLAN_OUTPUT"

ACTIVE_SNAP_ID=""
NEEDS_POLL="false"

case "$ACTION" in
  SKIP_ACCOMPLISHED)
    ACTIVE_SNAP_ID="$SNAP_ARG1"
    log "Today's snapshot $TARGET_NAME ($ACTIVE_SNAP_ID) already exists and is Accomplished; skipping CreateSnapshot."
    ;;
  POLL_EXISTING)
    ACTIVE_SNAP_ID="$SNAP_ARG1"
    NEEDS_POLL="true"
    log "Today's snapshot $TARGET_NAME ($ACTIVE_SNAP_ID) already exists in Progressing state; waiting until Accomplished."
    ;;
  DELETE_OLDEST_THEN_CREATE)
    log "At ${LR_MAX_SNAPSHOTS}-snapshot server limit; deleting oldest auto snapshot first while keeping >=1 Accomplished auto snapshot."
    delete_auto_snapshot "$SNAP_ARG1" "$SNAP_ARG2"
    CREATE_JSON="$(run_aliyun swas-open CreateSnapshot \
      --RegionId "$LR_REGION" \
      --DiskId "$LR_DISK_ID" \
      --SnapshotName "$TARGET_NAME")"
    ACTIVE_SNAP_ID="$(LR_CREATE_JSON="$CREATE_JSON" python3 -c '
import json, os, sys
sid = (json.loads(os.environ["LR_CREATE_JSON"]).get("SnapshotId") or "").strip()
if not sid:
    sys.stderr.write("ERROR: CreateSnapshot returned empty SnapshotId\n")
    sys.exit(1)
print(sid)
')"
    NEEDS_POLL="true"
    log "Created snapshot $TARGET_NAME (id=$ACTIVE_SNAP_ID); polling until Accomplished."
    ;;
  CREATE_DIRECT)
    CREATE_JSON="$(run_aliyun swas-open CreateSnapshot \
      --RegionId "$LR_REGION" \
      --DiskId "$LR_DISK_ID" \
      --SnapshotName "$TARGET_NAME")"
    ACTIVE_SNAP_ID="$(LR_CREATE_JSON="$CREATE_JSON" python3 -c '
import json, os, sys
sid = (json.loads(os.environ["LR_CREATE_JSON"]).get("SnapshotId") or "").strip()
if not sid:
    sys.stderr.write("ERROR: CreateSnapshot returned empty SnapshotId\n")
    sys.exit(1)
print(sid)
')"
    NEEDS_POLL="true"
    log "Created snapshot $TARGET_NAME (id=$ACTIVE_SNAP_ID); polling until Accomplished."
    ;;
  *)
    die "Unexpected snapshot plan action: $ACTION"
    ;;
esac

# 3. Poll until the snapshot reaches Accomplished (bounded timeout).
if [[ "$NEEDS_POLL" == "true" ]]; then
  SECONDS=0
  while true; do
    POLL_JSON="$(run_aliyun swas-open ListSnapshots \
      --RegionId "$LR_REGION" \
      --InstanceId "$LR_INSTANCE_ID" \
      --SnapshotIds "[\"$ACTIVE_SNAP_ID\"]" \
      --PageSize 100)"
    POLL_STATE="$(
      LR_POLL_JSON="$POLL_JSON" \
      LR_ACTIVE_ID="$ACTIVE_SNAP_ID" \
      python3 -c '
import json, os

data = json.loads(os.environ["LR_POLL_JSON"])
raw = data.get("Snapshots", [])
snaps = raw.get("Snapshot", []) if isinstance(raw, dict) else (raw or [])
sid = os.environ["LR_ACTIVE_ID"]
matched = [s for s in snaps if s.get("SnapshotId") == sid]
if not matched:
    print("MISSING|-|-")
else:
    s = matched[0]
    st = (s.get("Status") or "unknown").strip()
    prog = (s.get("Progress") or "-").strip()
    print(f"{st.lower()}|{st}|{prog}")
'
    )"
    IFS='|' read -r NORM_STATUS RAW_STATUS PROGRESS <<<"$POLL_STATE"
    case "$NORM_STATUS" in
      accomplished)
        log "Snapshot $TARGET_NAME ($ACTIVE_SNAP_ID) reached Accomplished (progress=$PROGRESS, elapsed=${SECONDS}s)."
        break
        ;;
      progressing)
        log "Snapshot $TARGET_NAME ($ACTIVE_SNAP_ID) status=$RAW_STATUS progress=$PROGRESS elapsed=${SECONDS}s"
        ;;
      MISSING)
        if (( SECONDS >= 30 )); then
          die "Snapshot $TARGET_NAME ($ACTIVE_SNAP_ID) not found in ListSnapshots after ${SECONDS}s"
        fi
        log "Waiting for newly created snapshot $TARGET_NAME ($ACTIVE_SNAP_ID) to appear (elapsed=${SECONDS}s)..."
        ;;
      *)
        die "Snapshot $TARGET_NAME ($ACTIVE_SNAP_ID) entered unexpected/failed status '$RAW_STATUS' (progress=$PROGRESS)"
        ;;
    esac

    if (( SECONDS >= LR_POLL_TIMEOUT_SECONDS )); then
      die "Timed out after ${SECONDS}s waiting for snapshot $TARGET_NAME ($ACTIVE_SNAP_ID) to reach Accomplished (last status=$RAW_STATUS progress=$PROGRESS)"
    fi
    if (( LR_POLL_INTERVAL_SECONDS > 0 )); then
      sleep "$LR_POLL_INTERVAL_SECONDS"
    fi
  done
fi

# 4. Prune ONLY `lr-auto-*` snapshots, keeping the newest $LR_KEEP_AUTO Accomplished auto snapshots.
AFTER_SNAPS_JSON="$(list_instance_snapshots)"
PRUNE_LINES="$(
  LR_SNAPS_JSON="$AFTER_SNAPS_JSON" \
  LR_ACTIVE_ID="$ACTIVE_SNAP_ID" \
  LR_KEEP="$LR_KEEP_AUTO" \
  python3 -c '
import json, os, sys

data = json.loads(os.environ["LR_SNAPS_JSON"])
raw = data.get("Snapshots", [])
snaps = raw.get("Snapshot", []) if isinstance(raw, dict) else (raw or [])
active_id = os.environ["LR_ACTIVE_ID"]
target_disk = os.environ["LR_DISK_ID"]
keep_count = int(os.environ["LR_KEEP"])

active_matches = [s for s in snaps if s.get("SnapshotId") == active_id]
if not active_matches or (active_matches[0].get("Status") or "").lower() != "accomplished":
    sys.stderr.write(f"ERROR: Active snapshot {active_id} is not Accomplished in post-check\n")
    sys.exit(1)

auto_snaps = [
    s for s in snaps
    if (s.get("SnapshotName") or "").startswith("lr-auto-")
    and (not s.get("SourceDiskId") or s.get("SourceDiskId") == target_disk)
]
auto_snaps.sort(key=lambda x: (x.get("CreationTime") or "", x.get("SnapshotName") or "", x.get("SnapshotId") or ""))

accomplished_auto = [s for s in auto_snaps if (s.get("Status") or "").lower() == "accomplished"]
keep_ids = {s.get("SnapshotId") for s in accomplished_auto[-keep_count:]}
keep_ids.add(active_id)

for s in auto_snaps:
    sid = s.get("SnapshotId") or ""
    sname = s.get("SnapshotName") or ""
    if sid and sid not in keep_ids:
        if not sname.startswith("lr-auto-"):
            sys.stderr.write(f"FATAL: Non-auto snapshot selected: {sname}\n")
            sys.exit(1)
        print(f"{sid}|{sname}")
'
)"

if [[ -n "$PRUNE_LINES" ]]; then
  while IFS='|' read -r DEL_ID DEL_NAME; do
    [[ -z "$DEL_ID" ]] && continue
    delete_auto_snapshot "$DEL_ID" "$DEL_NAME" "$ACTIVE_SNAP_ID"
  done <<<"$PRUNE_LINES"
fi

# 5. Final inventory verification (names, IDs, dates, statuses only).
FINAL_SNAPS_JSON="$(list_instance_snapshots)"
LR_SNAPS_JSON="$FINAL_SNAPS_JSON" python3 -c '
import json, os

data = json.loads(os.environ["LR_SNAPS_JSON"])
raw = data.get("Snapshots", [])
snaps = raw.get("Snapshot", []) if isinstance(raw, dict) else (raw or [])
snaps.sort(key=lambda x: (x.get("CreationTime") or "", x.get("SnapshotName") or "", x.get("SnapshotId") or ""))
print(f"Final snapshot inventory ({len(snaps)} total):")
for s in snaps:
    kind = "auto" if (s.get("SnapshotName") or "").startswith("lr-auto-") else "manual/other"
    print(
        "  - {} (id={}, status={}, created={}, kind={})".format(
            s.get("SnapshotName"),
            s.get("SnapshotId"),
            s.get("Status"),
            s.get("CreationTime"),
            kind,
        )
    )
'

log "Disk snapshot automation completed successfully."
