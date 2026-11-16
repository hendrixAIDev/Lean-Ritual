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
STATE=${BOJIN_WATCHDOG_STATE_DIR:-/run/bojin-watchdog}
ALERT=${BOJIN_WATCHDOG_ALERT_BIN:-/usr/local/libexec/bojin-alert}
LOCK_FILE=${BOJIN_WATCHDOG_LOCK_FILE:-/run/lock/bojin-maintenance.lock}
UPTIME_FILE=${BOJIN_WATCHDOG_UPTIME_FILE:-/proc/uptime}
if [[ -n "${BOJIN_WATCHDOG_DISK_PATHS:-}" ]]; then
  IFS=':' read -r -a DISK_PATHS <<<"$BOJIN_WATCHDOG_DISK_PATHS"
else
  DISK_PATHS=(/var/lib/bojin /var/backups /opt)
fi

install -d -m 0700 "$STATE"

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

# Send each kind of alert at most once per window, so a crash loop is one message.
# Stamp is written only after successful delivery so transient errors retry next tick.
alert_once() {
  local key=$1 window=$2; shift 2
  local stamp="$STATE/alert-$key" now last=""
  now=$(now_seconds)
  if [[ ! "$now" =~ ^[0-9]+$ ]]; then now=0; fi
  if [[ -r "$stamp" ]]; then
    IFS= read -r last <"$stamp" || true
  fi
  if [[ "$last" =~ ^[0-9]+$ ]] && (( now >= last && now - last < window )); then
    return 0
  fi
  if "$ALERT" "$@"; then
    printf '%s\n' "$now" >"$stamp"
    return 0
  fi
  return 1
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
      alert_once "disk-$mount_key" 21600 \
        "disk holding $path ($mount_id) is ${used}% full; free space before writes start failing" || true
    fi

    iused=${ipcent%%%}
    if [[ "$iused" =~ ^[0-9]+$ ]] && (( iused >= INODE_WARN_PERCENT )); then
      alert_once "inodes-$mount_key" 21600 \
        "inodes on disk holding $path ($mount_id) are ${iused}% full; free inodes before writes start failing" || true
    fi
  done
}

UNIT_STATE=""
check_unit_lifecycle() {
  local unit=$1 label=$2 state restarts prev_file previous act_file act_count
  state=$(systemctl is-active "$unit" 2>/dev/null || true)

  if [[ "$state" == failed ]]; then
    alert_once "failed-$unit" 1800 "$unit was in failed state on $(hostname); starting it again" || true
    systemctl reset-failed "$unit"
    systemctl start --no-block "$unit"
  fi

  # Automatic restarts done by systemd itself mean the unit crashed, even when
  # Restart=always + StartLimitIntervalSec=0 keeps it in "activating".
  restarts=$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || echo 0)
  if [[ ! "$restarts" =~ ^[0-9]+$ ]]; then restarts=0; fi
  prev_file="$STATE/restarts-$unit"
  if [[ -r "$prev_file" ]]; then
    previous=$(read_uint "$prev_file" "$restarts")
  else
    previous=$restarts
  fi
  if (( restarts > previous )); then
    if alert_once "crash-$unit" 1800 \
      "$label crashed and systemd restarted it ($((restarts - previous))x since last check); see journalctl -u $unit"; then
      printf '%s\n' "$restarts" >"$prev_file"
    fi
  else
    printf '%s\n' "$restarts" >"$prev_file"
  fi

  act_file="$STATE/activating-$unit"
  if [[ "$state" == activating ]]; then
    act_count=$(( $(read_uint "$act_file" 0) + 1 ))
    printf '%s\n' "$act_count" >"$act_file"
    logger -t bojin-watchdog -p daemon.warning -- "$unit is activating ($act_count/$ACTIVATING_LIMIT)"
    if (( act_count >= ACTIVATING_LIMIT )); then
      alert_once "activating-$unit" 1800 \
        "$unit is stuck activating or crash-looping ($act_count consecutive checks); see journalctl -u $unit" || true
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

# Always check disks/inodes and unit crash counters BEFORE any early exit so a
# full disk or startup crash loop cannot hide behind a non-active unit state.
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
      alert_once "unhealthy-caddy.service" 1800 "caddy.service stopped answering local HTTP checks; watchdog restarted it" || true
    fi
  fi
else
  # "activating" = systemd is already restarting it; "inactive" = an operator
  # stopped it deliberately (or Caddy is not installed). Do not restart it.
  rm -f "$STATE/failures-caddy.service"
fi

check_unit_lifecycle bojin.service app
state=$UNIT_STATE
if [[ "$state" != active ]]; then
  # "activating" = systemd is already restarting it; "inactive" = an operator
  # stopped it deliberately. Either way, do not fight it.
  rm -f "$STATE/failures"
  exit 0
fi

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
    alert_once unhealthy 1800 "app stopped answering health checks; watchdog restarted it" || true
  fi
fi
exit 0
