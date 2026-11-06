#!/usr/bin/env bash
# Root-installed as /usr/local/libexec/bojin-watchdog; run by bojin-watchdog.timer.
# systemd already restarts the app when it exits. This covers the cases it cannot
# see: a process that is running but no longer answers (hung event loop, stuck
# database), a unit left in "failed", silent crash loops and a filling disk.
set -uo pipefail
HEALTH_URL=http://127.0.0.1:8080/api/health
FAIL_LIMIT=3                       # consecutive failures (30 s apart) before a restart
DISK_WARN_PERCENT=90
DATA_PATH=/var/lib/bojin
STATE=/run/bojin-watchdog
ALERT=/usr/local/libexec/bojin-alert
install -d -m 0700 "$STATE"

# Send each kind of alert at most once per window, so a crash loop is one message.
alert_once() {
  local key=$1 window=$2; shift 2
  local stamp="$STATE/alert-$key" now; now=$(date +%s)
  if [[ -f "$stamp" ]] && (( now - $(cat "$stamp") < window )); then return 0; fi
  echo "$now" >"$stamp"
  "$ALERT" "$@"
}

# Deploys, backups and manual restores hold this lock and stop the app on
# purpose. Never interfere with them: skip this round instead.
exec 9>>/run/lock/bojin-maintenance.lock
flock -n 9 || exit 0

for unit in caddy.service bojin.service; do
  if [[ $(systemctl is-active "$unit") == failed ]]; then
    alert_once "failed-$unit" 1800 "$unit was in failed state on $(hostname); starting it again"
    systemctl reset-failed "$unit"
    systemctl start --no-block "$unit"
  fi
done

state=$(systemctl is-active bojin.service)
if [[ "$state" != active ]]; then
  # "activating" = systemd is already restarting it; "inactive" = an operator
  # stopped it deliberately. Either way, do not fight it.
  rm -f "$STATE/failures"
  exit 0
fi

# Automatic restarts done by systemd itself mean the app crashed.
restarts=$(systemctl show -p NRestarts --value bojin.service 2>/dev/null || echo 0)
previous=$(cat "$STATE/restarts" 2>/dev/null || echo "$restarts")
echo "$restarts" >"$STATE/restarts"
if [[ "$restarts" =~ ^[0-9]+$ && "$previous" =~ ^[0-9]+$ ]] && (( restarts > previous )); then
  alert_once crash 1800 "app crashed and systemd restarted it ($((restarts - previous))x since last check); see journalctl -u bojin"
fi

if curl --noproxy '*' --fail --silent --max-time 5 -o /dev/null "$HEALTH_URL"; then
  if [[ -f "$STATE/failures" ]]; then
    rm -f "$STATE/failures" "$STATE/alert-unhealthy"
    logger -t bojin-watchdog -- "health check recovered"
  fi
else
  failures=$(( $(cat "$STATE/failures" 2>/dev/null || echo 0) + 1 ))
  echo "$failures" >"$STATE/failures"
  logger -t bojin-watchdog -p daemon.warning -- "health check failed ($failures/$FAIL_LIMIT)"
  if (( failures >= FAIL_LIMIT )); then
    rm -f "$STATE/failures"
    systemctl restart bojin.service
    alert_once unhealthy 1800 "app stopped answering health checks; watchdog restarted it"
  fi
fi

used=$(df --output=pcent "$DATA_PATH" 2>/dev/null | tail -n 1 | tr -dc '0-9')
if [[ -n "$used" ]] && (( used >= DISK_WARN_PERCENT )); then
  alert_once disk 21600 "disk holding $DATA_PATH is ${used}% full; free space before writes start failing"
fi
exit 0
