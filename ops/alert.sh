#!/usr/bin/env bash
# Root-installed as /usr/local/libexec/bojin-alert.  Usage: bojin-alert MESSAGE
# Always logs to the journal; also POSTs the text to ALERT_URL when exported or
# configured in /etc/bojin-alert.env (for example an ntfy.sh HTTPS topic).
# Messages are generic status lines: never pass user data, tokens or secrets.
set -uo pipefail

LOG_TIMEOUT_SEC=${BOJIN_ALERT_LOG_TIMEOUT_SEC:-2}
if [[ ! "$LOG_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]]; then LOG_TIMEOUT_SEC=2; fi
LOGGER_STALLED=${BOJIN_ALERT_SKIP_LOGGER:-0}

log_best_effort() {
  [[ "$LOGGER_STALLED" == 1 ]] && return 0
  if command -v timeout >/dev/null 2>&1; then
    local rc=0
    timeout --foreground -s KILL "${LOG_TIMEOUT_SEC}s" logger "$@" >/dev/null 2>&1 || rc=$?
    if (( rc == 124 || rc == 137 )); then
      LOGGER_STALLED=1
    fi
  else
    logger "$@" >/dev/null 2>&1 || true
  fi
  return 0
}

trim_url() {
  local val=$1
  val=${val#"${val%%[![:space:]]*}"}
  if [[ "$val" == \#* ]]; then
    val=""
  elif [[ "$val" =~ ^(.*[^[:space:]])[[:space:]]+\#.*$ ]]; then
    val=${BASH_REMATCH[1]}
  fi
  val=${val%"${val##*[![:space:]]}"}
  if [[ "$val" == \"*\" && "$val" == *\" && ${#val} -ge 2 ]]; then
    val=${val:1:${#val}-2}
  elif [[ "$val" == \'*\' && "$val" == *\' && ${#val} -ge 2 ]]; then
    val=${val:1:${#val}-2}
  fi
  val=${val#"${val%%[![:space:]]*}"}
  val=${val%"${val##*[![:space:]]}"}
  printf '%s' "$val"
}

message="Lean Ritual: ${*:-alert}"
log_best_effort -t bojin-alert -p daemon.warning -- "$message"

env_file=${BOJIN_ALERT_ENV_FILE:-/etc/bojin-alert.env}
url=$(trim_url "${ALERT_URL:-}")
if [[ -z "$url" && -r "$env_file" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?ALERT_URL=(.*)$ ]]; then
      url=$(trim_url "${BASH_REMATCH[2]}")
    fi
  done <"$env_file"
fi

[[ -n "$url" ]] || exit 0

if [[ ! "$url" =~ ^https://[^[:space:]/]+ || "$url" =~ [[:space:]] ]]; then
  log_best_effort -t bojin-alert -p daemon.err -- "Refusing invalid or non-HTTPS ALERT_URL"
  exit 1
fi

max_time=${BOJIN_ALERT_MAX_TIME:-10}
if [[ ! "$max_time" =~ ^[1-9][0-9]*$ ]]; then max_time=10; fi
connect_timeout=5
if (( max_time < connect_timeout )); then connect_timeout=$max_time; fi

if [[ "${BOJIN_ALERT_WRAPPED:-0}" != 1 ]] && command -v timeout >/dev/null 2>&1; then
  http_code=$(timeout -k 1s "$((max_time + 1))s" curl --proto '=https' --proto-redir '=https' \
    --location --max-redirs 5 --post301 --post302 --post303 \
    --fail --silent --show-error \
    --connect-timeout "$connect_timeout" --max-time "$max_time" \
    -H "Title: Lean Ritual" -H "Tags: warning" \
    --data-binary "$message" -o /dev/null -w '%{http_code}' -- "$url")
else
  http_code=$(curl --proto '=https' --proto-redir '=https' \
    --location --max-redirs 5 --post301 --post302 --post303 \
    --fail --silent --show-error \
    --connect-timeout "$connect_timeout" --max-time "$max_time" \
    -H "Title: Lean Ritual" -H "Tags: warning" \
    --data-binary "$message" -o /dev/null -w '%{http_code}' -- "$url")
fi
curl_rc=$?
if (( curl_rc != 0 )) || [[ ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
  log_best_effort -t bojin-alert -p daemon.err -- "Could not deliver alert to ALERT_URL (curl=$curl_rc http=${http_code:-000})"
  exit 1
fi
exit 0
