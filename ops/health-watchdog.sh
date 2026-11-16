#!/usr/bin/env bash
# Root-installed as /usr/local/libexec/bojin-watchdog; run by bojin-watchdog.timer.
# systemd already restarts the app when it exits. This covers the cases it cannot
# see: a process that is running but no longer answers (hung event loop, stuck
# database), a unit left in "failed", startup/activating crash loops, silent
# restarts, an unresponsive Caddy reverse proxy, and filling disks or inodes.
set -uo pipefail

HEALTH_URL=${BOJIN_WATCHDOG_HEALTH_URL:-http://127.0.0.1:8080/api/health}
CADDY_URL=${BOJIN_WATCHDOG_CADDY_URL:-http://127.0.0.1:80/}
FAIL_LIMIT=${BOJIN_WATCHDOG_FAIL_LIMIT:-3}
ACTIVATING_LIMIT=${BOJIN_WATCHDOG_ACTIVATING_LIMIT:-3}
DISK_WARN_PERCENT=${BOJIN_WATCHDOG_DISK_WARN_PERCENT:-90}
INODE_WARN_PERCENT=${BOJIN_WATCHDOG_INODE_WARN_PERCENT:-90}
ALERT_BUDGET_SEC=${BOJIN_WATCHDOG_ALERT_BUDGET_SEC:-20}
ALERT_MAX_TIME=${BOJIN_WATCHDOG_ALERT_MAX_TIME:-8}
STATE=${BOJIN_WATCHDOG_STATE_DIR:-/run/bojin-watchdog}
ALERT=${BOJIN_WATCHDOG_ALERT_BIN:-/usr/local/libexec/bojin-alert}
LOCK_FILE=${BOJIN_WATCHDOG_LOCK_FILE:-/run/lock/bojin-maintenance.lock}
UPTIME_FILE=${BOJIN_WATCHDOG_UPTIME_FILE:-/proc/uptime}
if [[ -n "${BOJIN_WATCHDOG_DISK_PATHS:-}" ]]; then
  IFS=':' read -r -a DISK_PATHS <<<"$BOJIN_WATCHDOG_DISK_PATHS"
else
  DISK_PATHS=(/var/lib/bojin /var/backups /opt)
fi

install -d -m 0700 "$STATE" "$STATE/pending"

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

run_alert_bounded() {
  local limit=$1 message=$2
  if command -v timeout >/dev/null 2>&1; then
    BOJIN_ALERT_MAX_TIME="$limit" timeout -k 2 "${limit}s" "$ALERT" "$message" 9>&-
  else
    BOJIN_ALERT_MAX_TIME="$limit" "$ALERT" "$message" 9>&-
  fi
}

# Deliver queued alerts within a bounded total time budget well under
# TimeoutStartSec=60; undelivered items stay in $STATE/pending for the next tick.
flush_alerts() {
  local start_sec=$SECONDS pending_file safe_key window message elapsed remaining per_call now
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
    elapsed=$(( SECONDS - start_sec ))
    if (( elapsed >= ALERT_BUDGET_SEC )); then
      logger -t bojin-watchdog -p daemon.warning -- \
        "alert delivery budget (${ALERT_BUDGET_SEC}s) exhausted; deferring remaining alerts to next check"
      break
    fi
    remaining=$(( ALERT_BUDGET_SEC - elapsed ))
    per_call=$ALERT_MAX_TIME
    if (( remaining < per_call )); then
      per_call=$remaining
    fi
    (( per_call < 1 )) && per_call=1
    if run_alert_bounded "$per_call" "$message"; then
      now=$(now_seconds)
      if [[ ! "$now" =~ ^[0-9]+$ ]]; then now=0; fi
      printf '%s\n' "$now" >"$STATE/alert-$safe_key"
      rm -f "$pending_file" "$STATE/pending-crashes-${safe_key#crash-}"
    fi
  done
}

check_filesystems() {
  local path df_out df_line pcent ipcent target mount_id mount_key used iused seen_mounts=" "
  for path in "${DISK_PATHS[@]}"; do
    [[ -n "$path" ]] || continue
    df_out=$(df --output=pcent,ipcent,target "$path" 2>/dev/null) || continue
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
    if [[ "$used" =~ ^[0-9]+$ ]] && (( used >= DISK_WARN_PERCENT )); then
      queue_alert "disk-$mount_key" 21600 \
        "disk holding $path ($mount_id) is ${used}% full; free space before writes start failing"
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
  local unit=$1 label=$2 state restarts invocation prev_file has_prev prev_restarts prev_inv
  local raw_restarts raw_inv delta pending_crashes act_file act_count
  state=$(systemctl is-active "$unit" 2>/dev/null || true)

  if [[ "$state" == failed ]]; then
    queue_alert "failed-$unit" 1800 "$unit was in failed state on $(hostname); starting it again"
    systemctl reset-failed "$unit"
    systemctl start --no-block "$unit"
  fi

  # Track InvocationID alongside NRestarts so first-observation crashes and
  # crashes after a deploy/manual restart counter reset are never missed.
  restarts=$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || echo 0)
  if [[ ! "$restarts" =~ ^[0-9]+$ ]]; then restarts=0; fi
  invocation=$(systemctl show -p InvocationID --value "$unit" 2>/dev/null || true)
  invocation=${invocation//[[:space:]]/}

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

  act_file="$STATE/activating-$unit"
  if [[ "$state" == activating ]]; then
    act_count=$(( $(read_uint "$act_file" 0) + 1 ))
    printf '%s\n' "$act_count" >"$act_file"
    logger -t bojin-watchdog -p daemon.warning -- "$unit is activating ($act_count/$ACTIVATING_LIMIT)"
    if (( act_count >= ACTIVATING_LIMIT )); then
      queue_alert "activating-$unit" 1800 \
        "$unit is stuck activating or crash-looping ($act_count consecutive checks); see journalctl -u $unit"
    fi
  else
    rm -f "$act_file"
  fi

  UNIT_STATE=$state
}

# Deploys, backups and manual restores hold this lock and stop the app on
# purpose. Never interfere with them: skip this round instead.
exec 9>>"$LOCK_FILE"
flock -n 9 || exit 0

# Run all disk/inode checks, unit lifecycle checks, and local HTTP probes FIRST;
# deliver queued alerts afterwards within a bounded time budget.
check_filesystems

check_unit_lifecycle caddy.service caddy.service
caddy_state=$UNIT_STATE
if [[ "$caddy_state" == active ]]; then
  # Local loopback probe independent of public DNS; HTTP 308 redirect is healthy.
  if curl --noproxy '*' --silent --max-time 5 -o /dev/null "$CADDY_URL"; then
    if [[ -f "$STATE/failures-caddy.service" ]]; then
      rm -f "$STATE/failures-caddy.service" "$STATE/alert-unhealthy-caddy.service"
      logger -t bojin-watchdog -- "caddy health check recovered"
    fi
  else
    caddy_failures=$(( $(read_uint "$STATE/failures-caddy.service" 0) + 1 ))
    printf '%s\n' "$caddy_failures" >"$STATE/failures-caddy.service"
    logger -t bojin-watchdog -p daemon.warning -- "caddy health check failed ($caddy_failures/$FAIL_LIMIT)"
    if (( caddy_failures >= FAIL_LIMIT )); then
      rm -f "$STATE/failures-caddy.service"
      systemctl restart caddy.service
      queue_alert "unhealthy-caddy.service" 1800 "caddy.service stopped answering local HTTP checks; watchdog restarted it"
    fi
  fi
else
  # "activating" = systemd is already restarting it; "inactive" = an operator
  # stopped it deliberately (or Caddy is not installed). Do not restart it.
  rm -f "$STATE/failures-caddy.service"
fi

check_unit_lifecycle bojin.service app
state=$UNIT_STATE
if [[ "$state" == active ]]; then
  if curl --noproxy '*' --fail --silent --max-time 5 -o /dev/null "$HEALTH_URL"; then
    if [[ -f "$STATE/failures" ]]; then
      rm -f "$STATE/failures" "$STATE/alert-unhealthy"
      logger -t bojin-watchdog -- "health check recovered"
    fi
  else
    failures=$(( $(read_uint "$STATE/failures" 0) + 1 ))
    printf '%s\n' "$failures" >"$STATE/failures"
    logger -t bojin-watchdog -p daemon.warning -- "health check failed ($failures/$FAIL_LIMIT)"
    if (( failures >= FAIL_LIMIT )); then
      rm -f "$STATE/failures"
      systemctl restart bojin.service
      queue_alert unhealthy 1800 "app stopped answering health checks; watchdog restarted it"
    fi
  fi
else
  # "activating" = systemd is already restarting it; "inactive" = an operator
  # stopped it deliberately. Either way, do not fight it.
  rm -f "$STATE/failures"
fi

flush_alerts
exit 0
