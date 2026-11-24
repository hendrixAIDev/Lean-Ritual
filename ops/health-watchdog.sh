#!/usr/bin/env bash
# Root-installed as /usr/local/libexec/bojin-watchdog; run by bojin-watchdog.timer.
# systemd already restarts the app when it exits. This covers the cases it cannot
# see: a process that is running but no longer answers (hung event loop, stuck
# database), a unit left in "failed", startup/activating crash loops, silent
# restarts, an unresponsive Caddy reverse proxy, and filling disks or inodes.
set -uo pipefail

WATCHDOG_START=$SECONDS
HEALTH_URL=${BOJIN_WATCHDOG_HEALTH_URL:-http://127.0.0.1:8080/api/health}
CADDY_URL=${BOJIN_WATCHDOG_CADDY_URL:-http://127.0.0.1:80/}
FAIL_LIMIT=${BOJIN_WATCHDOG_FAIL_LIMIT:-3}
ACTIVATING_LIMIT=${BOJIN_WATCHDOG_ACTIVATING_LIMIT:-3}
DISK_WARN_PERCENT=${BOJIN_WATCHDOG_DISK_WARN_PERCENT:-80}
DISK_CRIT_PERCENT=${BOJIN_WATCHDOG_DISK_CRIT_PERCENT:-90}
INODE_WARN_PERCENT=${BOJIN_WATCHDOG_INODE_WARN_PERCENT:-80}
# Keep worst-case runtime (including 1s SIGKILL grace and bounded logger) comfortably
# under TimeoutStartSec=60: up to 24s for checks, <=2s for stalled journald detection,
# leaving >=24s (22s alert budget) within a 50s total cap.
TOTAL_BUDGET_SEC=${BOJIN_WATCHDOG_TOTAL_BUDGET_SEC:-50}
CHECKS_BUDGET_SEC=${BOJIN_WATCHDOG_CHECKS_BUDGET_SEC:-24}
CMD_TIMEOUT_SEC=${BOJIN_WATCHDOG_CMD_TIMEOUT_SEC:-4}
PROBE_MAX_TIME=${BOJIN_WATCHDOG_PROBE_MAX_TIME:-4}
LOG_TIMEOUT_SEC=${BOJIN_WATCHDOG_LOG_TIMEOUT_SEC:-2}
ALERT_BUDGET_SEC=${BOJIN_WATCHDOG_ALERT_BUDGET_SEC:-22}
ALERT_MAX_TIME=${BOJIN_WATCHDOG_ALERT_MAX_TIME:-8}
STATE=${BOJIN_WATCHDOG_STATE_DIR:-/run/bojin-watchdog}
ALERT=${BOJIN_WATCHDOG_ALERT_BIN:-/usr/local/libexec/bojin-alert}
LOCK_FILE=${BOJIN_WATCHDOG_LOCK_FILE:-/run/bojin/maintenance.lock}
# Transition compatibility (one release): also check the legacy lock path after
# LOCK_FILE so an un-upgraded helper or manual command cannot race the watchdog.
# Remove in the next release once all host helpers and runbooks use LOCK_FILE.
LEGACY_LOCK_FILE=${BOJIN_WATCHDOG_LEGACY_LOCK_FILE:-/run/lock/bojin-maintenance.lock}
UPTIME_FILE=${BOJIN_WATCHDOG_UPTIME_FILE:-/proc/uptime}
HAS_TIMEOUT=0
if command -v timeout >/dev/null 2>&1; then HAS_TIMEOUT=1; fi
LOGGER_STALLED=0
if [[ -n "${BOJIN_WATCHDOG_DISK_PATHS:-}" ]]; then
  IFS=':' read -r -a DISK_PATHS <<<"$BOJIN_WATCHDOG_DISK_PATHS"
else
  DISK_PATHS=(/var/lib/bojin /var/backups /opt)
fi

install -d -m 0700 "$STATE" "$STATE/pending"

# Best-effort journal logging: runs logger directly under timeout -s KILL
# (never calling run_cmd_bounded recursively), capped by LOG_TIMEOUT_SEC and
# remaining total budget, and trips LOGGER_STALLED if journald/syslog blocks.
log_best_effort() {
  (( LOGGER_STALLED == 1 )) && return 0
  local total_rem=$(( TOTAL_BUDGET_SEC - (SECONDS - WATCHDOG_START) ))
  (( total_rem <= 0 )) && return 0
  if (( HAS_TIMEOUT == 1 )); then
    local limit=$LOG_TIMEOUT_SEC
    if (( total_rem < limit )); then
      limit=$total_rem
    fi
    (( limit < 1 )) && limit=1
    local rc=0
    timeout -s KILL "${limit}s" logger "$@" 8>&- 9>&- >/dev/null 2>&1 || rc=$?
    if (( rc == 124 || rc == 137 )); then
      LOGGER_STALLED=1
    fi
  else
    logger "$@" 8>&- 9>&- >/dev/null 2>&1 || true
  fi
  return 0
}

checks_budget_left() {
  (( CHECKS_BUDGET_SEC - (SECONDS - WATCHDOG_START) > 0 ))
}

# Run an external check/action command under both a per-command timeout and the
# overall checks deadline, accounting for the 1s SIGKILL grace on timeout -k 1s.
run_cmd_bounded() {
  local desired=$1; shift
  local remaining=$(( CHECKS_BUDGET_SEC - (SECONDS - WATCHDOG_START) ))
  if (( remaining <= 0 )); then
    log_best_effort -t bojin-watchdog -p daemon.warning -- \
      "checks deadline (${CHECKS_BUDGET_SEC}s) reached before $1; advancing to alert flush"
    return 124
  fi
  if (( HAS_TIMEOUT == 1 )); then
    if (( remaining == 1 )); then
      timeout -s KILL 1s "$@" 8>&- 9>&-
    else
      local limit=$(( remaining - 1 ))
      if (( desired < limit )); then
        limit=$desired
      fi
      (( limit < 1 )) && limit=1
      timeout -k 1s "${limit}s" "$@" 8>&- 9>&-
    fi
  else
    "$@" 8>&- 9>&-
  fi
}

now_seconds() {
  local raw int_part
  if [[ -r "$UPTIME_FILE" ]] && IFS=' ' read -r raw _ <"$UPTIME_FILE"; then
    int_part=${raw%%.*}
    if [[ "$int_part" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$int_part"
      return 0
    fi
  fi
  date +%s
}

read_uint() {
  local file=$1 default=${2:-0} val=""
  if [[ -r "$file" ]]; then
    IFS= read -r val <"$file" || true
  fi
  if [[ "$val" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$val"
  else
    printf '%s\n' "$default"
  fi
}

is_cooled_down() {
  local safe_key=$1 window=$2 stamp="$STATE/alert-$1" now last=""
  now=$(now_seconds)
  if [[ ! "$now" =~ ^[0-9]+$ ]]; then now=0; fi
  if [[ -r "$stamp" ]]; then
    IFS= read -r last <"$stamp" || true
  fi
  [[ "$last" =~ ^[0-9]+$ ]] && (( now >= last && now - last < window ))
}

# Persist pending alerts during checks so all service checks and restarts finish
# before any external webhook call can block or time out.
queue_alert() {
  local key=$1 window=$2; shift 2
  local safe_key pending_file tmp_file msg_single
  safe_key=$(printf '%s' "$key" | tr -c 'a-zA-Z0-9._-' '_')
  pending_file="$STATE/pending/$safe_key"
  if is_cooled_down "$safe_key" "$window"; then
    rm -f "$pending_file"
    return 0
  fi
  msg_single=$(printf '%s' "$*" | tr '\n' ' ')
  tmp_file="$pending_file.tmp.$$"
  printf '%s\n%s\n' "$window" "$msg_single" >"$tmp_file"
  mv -f "$tmp_file" "$pending_file"
}

# Account for the 1s SIGKILL grace so a hung alert child can never overrun the
# remaining alert/total budget.
run_alert_bounded() {
  local remaining=$1 message=$2 per_call
  if (( HAS_TIMEOUT == 1 )); then
    if (( remaining <= 1 )); then
      BOJIN_ALERT_WRAPPED=1 BOJIN_ALERT_SKIP_LOGGER="$LOGGER_STALLED" BOJIN_ALERT_LOG_TIMEOUT_SEC=1 \
        BOJIN_ALERT_MAX_TIME=1 timeout -s KILL 1s "$ALERT" "$message" 8>&- 9>&-
    else
      local max_allowed=$(( remaining - 1 ))
      per_call=$ALERT_MAX_TIME
      if (( max_allowed < per_call )); then
        per_call=$max_allowed
      fi
      (( per_call < 1 )) && per_call=1
      BOJIN_ALERT_WRAPPED=1 BOJIN_ALERT_SKIP_LOGGER="$LOGGER_STALLED" BOJIN_ALERT_LOG_TIMEOUT_SEC=1 \
        BOJIN_ALERT_MAX_TIME="$per_call" timeout -k 1s "${per_call}s" "$ALERT" "$message" 8>&- 9>&-
    fi
  else
    per_call=$ALERT_MAX_TIME
    if (( remaining < per_call )); then
      per_call=$remaining
    fi
    (( per_call < 1 )) && per_call=1
    BOJIN_ALERT_SKIP_LOGGER="$LOGGER_STALLED" BOJIN_ALERT_LOG_TIMEOUT_SEC=1 \
      BOJIN_ALERT_MAX_TIME="$per_call" "$ALERT" "$message" 8>&- 9>&-
  fi
}

# Deliver queued alerts within a bounded total time budget comfortably under
# TimeoutStartSec=60; undelivered items stay in $STATE/pending for the next tick.
flush_alerts() {
  local flush_start=$SECONDS pending_file safe_key window message alert_rem total_rem remaining now
  for pending_file in "$STATE/pending/"*; do
    [[ -f "$pending_file" ]] || continue
    safe_key=${pending_file##*/}
    [[ "$safe_key" == *.tmp.* ]] && continue
    window=""
    message=""
    {
      IFS= read -r window || true
      IFS= read -r message || true
    } <"$pending_file"
    if [[ ! "$window" =~ ^[0-9]+$ || -z "$message" ]]; then
      rm -f "$pending_file"
      continue
    fi
    if is_cooled_down "$safe_key" "$window"; then
      rm -f "$pending_file" "$STATE/pending-crashes-${safe_key#crash-}"
      continue
    fi
    alert_rem=$(( ALERT_BUDGET_SEC - (SECONDS - flush_start) ))
    total_rem=$(( TOTAL_BUDGET_SEC - (SECONDS - WATCHDOG_START) ))
    remaining=$alert_rem
    if (( total_rem < remaining )); then
      remaining=$total_rem
    fi
    if (( remaining <= 0 )); then
      log_best_effort -t bojin-watchdog -p daemon.warning -- \
        "alert delivery budget (${ALERT_BUDGET_SEC}s) exhausted; deferring remaining alerts to next check"
      break
    fi
    if run_alert_bounded "$remaining" "$message"; then
      now=$(now_seconds)
      if [[ ! "$now" =~ ^[0-9]+$ ]]; then now=0; fi
      printf '%s\n' "$now" >"$STATE/alert-$safe_key"
      rm -f "$pending_file" "$STATE/pending-crashes-${safe_key#crash-}"
    fi
  done
}

check_filesystems() {
  local path df_out df_rc df_line pcent ipcent target mount_id mount_key used iused seen_mounts=" "
  for path in "${DISK_PATHS[@]}"; do
    [[ -n "$path" ]] || continue
    checks_budget_left || break
    df_out=$(run_cmd_bounded "$CMD_TIMEOUT_SEC" df --output=pcent,ipcent,target "$path" 2>/dev/null)
    df_rc=$?
    if (( df_rc == 124 || df_rc == 137 )); then
      log_best_effort -t bojin-watchdog -p daemon.warning -- "df timed out on $path"
      continue
    fi
    (( df_rc == 0 )) || continue
    [[ "$df_out" == *$'\n'* ]] || continue
    df_line=${df_out##*$'\n'}
    read -r pcent ipcent target <<<"$df_line" || continue
    mount_id=${target:-$path}
    case "$seen_mounts" in
      *"|$mount_id|"*) continue ;;
    esac
    seen_mounts="${seen_mounts}|${mount_id}|"
    mount_key=$(printf '%s' "$mount_id" | tr -c 'a-zA-Z0-9' '_')

    used=${pcent%%%}
    if [[ "$used" =~ ^[0-9]+$ ]]; then
      if (( DISK_CRIT_PERCENT > DISK_WARN_PERCENT && used >= DISK_CRIT_PERCENT )); then
        queue_alert "disk-crit-$mount_key" 21600 \
          "CRITICAL: disk holding $path ($mount_id) is ${used}% full; free space before writes start failing"
      elif (( used >= DISK_WARN_PERCENT )); then
        queue_alert "disk-$mount_key" 21600 \
          "disk holding $path ($mount_id) is ${used}% full (warning threshold ${DISK_WARN_PERCENT}%); inspect backups, releases, and photos before disk fills"
      fi
    fi

    iused=${ipcent%%%}
    if [[ "$iused" =~ ^[0-9]+$ ]] && (( iused >= INODE_WARN_PERCENT )); then
      queue_alert "inodes-$mount_key" 21600 \
        "inodes on disk holding $path ($mount_id) are ${iused}% full; free inodes before writes start failing"
    fi
  done
}

UNIT_STATE=""
check_unit_lifecycle() {
  local unit=$1 label=$2 state state_rc host restarts_raw inv_raw restarts invocation
  local prev_file has_prev prev_restarts prev_inv raw_restarts raw_inv delta pending_crashes act_file act_count
  UNIT_STATE=""
  checks_budget_left || return 0

  state=$(run_cmd_bounded "$CMD_TIMEOUT_SEC" systemctl is-active "$unit" 2>/dev/null)
  state_rc=$?
  if (( state_rc == 124 || state_rc == 137 )); then
    log_best_effort -t bojin-watchdog -p daemon.warning -- "systemctl is-active timed out for $unit"
    state=""
  fi

  if [[ "$state" == failed ]]; then
    host=$(run_cmd_bounded 2 hostname 2>/dev/null || printf '%s' "${HOSTNAME:-localhost}")
    queue_alert "failed-$unit" 1800 "$unit was in failed state on $host; starting it again"
    run_cmd_bounded "$CMD_TIMEOUT_SEC" systemctl reset-failed "$unit" >/dev/null 2>&1 || true
    run_cmd_bounded "$CMD_TIMEOUT_SEC" systemctl start --no-block "$unit" >/dev/null 2>&1 || true
  fi

  # Track InvocationID alongside NRestarts so first-observation crashes and
  # crashes after a deploy/manual restart counter reset are never missed.
  # Only update saved state when both systemctl show queries succeed (no timeout).
  if checks_budget_left \
     && restarts_raw=$(run_cmd_bounded "$CMD_TIMEOUT_SEC" systemctl show -p NRestarts --value "$unit" 2>/dev/null) \
     && inv_raw=$(run_cmd_bounded "$CMD_TIMEOUT_SEC" systemctl show -p InvocationID --value "$unit" 2>/dev/null); then
    restarts=${restarts_raw//[[:space:]]/}
    if [[ ! "$restarts" =~ ^[0-9]+$ ]]; then restarts=0; fi
    invocation=${inv_raw//[[:space:]]/}

    prev_file="$STATE/restarts-$unit"
    has_prev=0
    prev_restarts=0
    prev_inv=""
    if [[ -r "$prev_file" ]]; then
      IFS=' ' read -r raw_restarts raw_inv <"$prev_file" || true
      if [[ "${raw_restarts:-}" =~ ^[0-9]+$ && ! "${raw_inv:-}" =~ [[:space:]] ]]; then
        has_prev=1
        prev_restarts=$raw_restarts
        prev_inv=${raw_inv:-}
      fi
    fi

    delta=0
    if (( has_prev == 0 )); then
      if (( restarts > 0 )); then
        delta=$restarts
      fi
    elif [[ -n "$invocation" && "$invocation" == "$prev_inv" ]]; then
      if (( restarts > prev_restarts )); then
        delta=$(( restarts - prev_restarts ))
      fi
    elif [[ -n "$invocation" && "$invocation" != "$prev_inv" ]]; then
      if (( restarts > prev_restarts )); then
        delta=$(( restarts - prev_restarts ))
      elif (( restarts > 0 )); then
        delta=$restarts
      fi
    else
      if (( restarts > prev_restarts )); then
        delta=$(( restarts - prev_restarts ))
      elif (( restarts > 0 && restarts < prev_restarts )); then
        delta=$restarts
      fi
    fi
    printf '%s %s\n' "$restarts" "$invocation" >"$prev_file"

    if (( delta > 0 )); then
      pending_crashes=$(( $(read_uint "$STATE/pending-crashes-$unit" 0) + delta ))
      if is_cooled_down "crash-$unit" 1800; then
        rm -f "$STATE/pending-crashes-$unit" "$STATE/pending/crash-$unit"
      else
        printf '%s\n' "$pending_crashes" >"$STATE/pending-crashes-$unit"
        queue_alert "crash-$unit" 1800 \
          "$label crashed and systemd restarted it (${pending_crashes}x since last check); see journalctl -u $unit"
      fi
    fi
  else
    log_best_effort -t bojin-watchdog -p daemon.warning -- "systemctl show timed out or skipped for $unit"
  fi

  act_file="$STATE/activating-$unit"
  if [[ "$state" == activating ]]; then
    act_count=$(( $(read_uint "$act_file" 0) + 1 ))
    printf '%s\n' "$act_count" >"$act_file"
    log_best_effort -t bojin-watchdog -p daemon.warning -- "$unit is activating ($act_count/$ACTIVATING_LIMIT)"
    if (( act_count >= ACTIVATING_LIMIT )); then
      queue_alert "activating-$unit" 1800 \
        "$unit is stuck activating or crash-looping ($act_count consecutive checks); see journalctl -u $unit"
    fi
  elif [[ -n "$state" ]]; then
    rm -f "$act_file"
  fi

  UNIT_STATE=$state
}

path_uid() {
  if stat -c '%u' / >/dev/null 2>&1; then
    stat -c '%u' -- "$1"
  else
    stat -f '%u' "$1"
  fi
}

refuse_lock() {
  log_best_effort -t bojin-watchdog -p daemon.err -- "$1"
  echo "$1" >&2
  exit 1
}

# Deploys, backups and manual restores hold this lock and stop the app on
# purpose. Never interfere with them: skip this round instead.
LOCK_DIR=$(dirname -- "$LOCK_FILE")
[[ ! -L "$LOCK_DIR" ]] || refuse_lock "Refusing symlink maintenance lock directory: $LOCK_DIR"
if [[ ! -e "$LOCK_DIR" ]]; then
  install -d -o root -g root -m 0755 "$LOCK_DIR" || refuse_lock "Failed to create maintenance lock directory: $LOCK_DIR"
fi
if [[ -L "$LOCK_DIR" || ! -d "$LOCK_DIR" ]] || [[ "$(path_uid "$LOCK_DIR" 2>/dev/null)" != 0 ]]; then
  refuse_lock "Refusing non-root or invalid maintenance lock directory: $LOCK_DIR"
fi
[[ ! -L "$LOCK_FILE" ]] || refuse_lock "Refusing symlink maintenance lock: $LOCK_FILE"
if [[ -e "$LOCK_FILE" ]]; then
  if [[ ! -f "$LOCK_FILE" ]] || [[ "$(path_uid "$LOCK_FILE" 2>/dev/null)" != 0 ]]; then
    refuse_lock "Refusing non-root or non-regular maintenance lock: $LOCK_FILE"
  fi
fi
{ exec 9>>"$LOCK_FILE"; } 2>/dev/null || refuse_lock "Failed to open maintenance lock: $LOCK_FILE"
if [[ -L "$LOCK_FILE" || ! -f "$LOCK_FILE" ]] || [[ "$(path_uid "$LOCK_FILE" 2>/dev/null)" != 0 ]]; then
  exec 9>&-
  refuse_lock "Refusing unsafe maintenance lock: $LOCK_FILE"
fi
flock -n 9 || exit 0

[[ ! -L "$LEGACY_LOCK_FILE" ]] || refuse_lock "Refusing symlink legacy maintenance lock: $LEGACY_LOCK_FILE"
if [[ -e "$LEGACY_LOCK_FILE" && ! -f "$LEGACY_LOCK_FILE" ]]; then
  refuse_lock "Refusing non-regular legacy maintenance lock: $LEGACY_LOCK_FILE"
fi
if { exec 8>>"$LEGACY_LOCK_FILE"; } 2>/dev/null; then
  if ! python3 -c 'import os, stat, sys; sys.exit(0 if stat.S_ISREG(os.fstat(8).st_mode) and not os.path.islink(sys.argv[1]) else 1)' "$LEGACY_LOCK_FILE" 9>&-; then
    exec 8>&-
    refuse_lock "Refusing unsafe legacy maintenance lock: $LEGACY_LOCK_FILE"
  fi
  flock -n 8 || exit 0
elif legacy_meta=$(python3 -c '
import errno, os, stat, sys
path = sys.argv[1]
nofollow = getattr(os, "O_NOFOLLOW", 0)
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NONBLOCK | nofollow, 0o600)
except OSError as exc:
    if exc.errno != errno.EACCES:
        sys.exit(1)
    try:
        rfd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | nofollow)
    except OSError:
        sys.exit(1)
    try:
        st = os.fstat(rfd)
        if not stat.S_ISREG(st.st_mode):
            sys.exit(1)
        print(f"{st.st_dev} {st.st_ino}")
        sys.exit(0)
    finally:
        os.close(rfd)
else:
    os.close(fd)
    sys.exit(1)
' "$LEGACY_LOCK_FILE" 8>&- 9>&-); then
  { exec 8<"$LEGACY_LOCK_FILE"; } 2>/dev/null || refuse_lock "Failed to open existing legacy maintenance lock without O_CREAT: $LEGACY_LOCK_FILE"
  read -r exp_dev exp_ino <<<"$legacy_meta"
  if ! python3 -c '
import os, stat, sys
st = os.fstat(8)
lst = os.lstat(sys.argv[1])
ok = (
    stat.S_ISREG(st.st_mode)
    and not stat.S_ISLNK(lst.st_mode)
    and (st.st_dev, st.st_ino) == (lst.st_dev, lst.st_ino) == (int(sys.argv[2]), int(sys.argv[3]))
)
sys.exit(0 if ok else 1)
' "$LEGACY_LOCK_FILE" "$exp_dev" "$exp_ino" 9>&-; then
    exec 8>&-
    refuse_lock "Refusing unsafe legacy maintenance lock fd: $LEGACY_LOCK_FILE"
  fi
  warn_msg="legacy maintenance lock $LEGACY_LOCK_FILE failed O_CREAT with EACCES (fs.protected_regular); opened existing regular file without O_CREAT for flock"
  log_best_effort -t bojin-watchdog -p daemon.warning -- "$warn_msg"
  echo "Warning: $warn_msg" >&2
  flock -n 8 || exit 0
else
  refuse_lock "Failed to open legacy maintenance lock: $LEGACY_LOCK_FILE"
fi

# Run all disk/inode checks, unit lifecycle checks, and local HTTP probes FIRST
# under CHECKS_BUDGET_SEC; deliver queued alerts afterwards with >=22s budget.
check_filesystems

check_unit_lifecycle caddy.service caddy.service
caddy_state=$UNIT_STATE
if [[ "$caddy_state" == active ]]; then
  if checks_budget_left; then
    # Local loopback probe independent of public DNS; HTTP 308 redirect is healthy.
    if run_cmd_bounded "$PROBE_MAX_TIME" curl --noproxy '*' --silent --max-time "$PROBE_MAX_TIME" -o /dev/null "$CADDY_URL"; then
      if [[ -f "$STATE/failures-caddy.service" ]]; then
        rm -f "$STATE/failures-caddy.service" "$STATE/alert-unhealthy-caddy.service"
        log_best_effort -t bojin-watchdog -- "caddy health check recovered"
      fi
    else
      caddy_failures=$(( $(read_uint "$STATE/failures-caddy.service" 0) + 1 ))
      printf '%s\n' "$caddy_failures" >"$STATE/failures-caddy.service"
      log_best_effort -t bojin-watchdog -p daemon.warning -- "caddy health check failed ($caddy_failures/$FAIL_LIMIT)"
      if (( caddy_failures >= FAIL_LIMIT )); then
        rm -f "$STATE/failures-caddy.service"
        run_cmd_bounded "$CMD_TIMEOUT_SEC" systemctl restart --no-block caddy.service >/dev/null 2>&1 || true
        queue_alert "unhealthy-caddy.service" 1800 "caddy.service stopped answering local HTTP checks; watchdog restarted it"
      fi
    fi
  fi
elif [[ -n "$caddy_state" ]]; then
  # "activating" = systemd is already restarting it; "inactive" = an operator
  # stopped it deliberately (or Caddy is not installed). Do not restart it.
  rm -f "$STATE/failures-caddy.service"
fi

check_unit_lifecycle bojin.service app
state=$UNIT_STATE
if [[ "$state" == active ]]; then
  if checks_budget_left; then
    if run_cmd_bounded "$PROBE_MAX_TIME" curl --noproxy '*' --fail --silent --max-time "$PROBE_MAX_TIME" -o /dev/null "$HEALTH_URL"; then
      if [[ -f "$STATE/failures" ]]; then
        rm -f "$STATE/failures" "$STATE/alert-unhealthy"
        log_best_effort -t bojin-watchdog -- "health check recovered"
      fi
    else
      failures=$(( $(read_uint "$STATE/failures" 0) + 1 ))
      printf '%s\n' "$failures" >"$STATE/failures"
      log_best_effort -t bojin-watchdog -p daemon.warning -- "health check failed ($failures/$FAIL_LIMIT)"
      if (( failures >= FAIL_LIMIT )); then
        rm -f "$STATE/failures"
        run_cmd_bounded "$CMD_TIMEOUT_SEC" systemctl restart --no-block bojin.service >/dev/null 2>&1 || true
        queue_alert unhealthy 1800 "app stopped answering health checks; watchdog restarted it"
      fi
    fi
  fi
elif [[ -n "$state" ]]; then
  # "activating" = systemd is already restarting it; "inactive" = an operator
  # stopped it deliberately. Either way, do not fight it.
  rm -f "$STATE/failures"
fi

flush_alerts
exit 0
