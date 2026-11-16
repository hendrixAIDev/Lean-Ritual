#!/usr/bin/env bash
# Root-installed as /usr/local/libexec/bojin-alert.  Usage: bojin-alert MESSAGE
# Always logs to the journal; also POSTs the text to ALERT_URL when exported or
# configured in /etc/bojin-alert.env (for example an ntfy.sh HTTPS topic).
# Messages are generic status lines: never pass user data, tokens or secrets.
set -uo pipefail

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
logger -t bojin-alert -p daemon.warning -- "$message"

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
  logger -t bojin-alert -p daemon.err -- "Refusing invalid or non-HTTPS ALERT_URL"
  exit 1
fi

if ! curl --proto '=https' --proto-redir '=https' --fail --silent --show-error \
     --max-time 15 --retry 2 \
     -H "Title: Lean Ritual" -H "Tags: warning" \
     --data-binary "$message" -- "$url" >/dev/null; then
  logger -t bojin-alert -p daemon.err -- "Could not deliver alert to ALERT_URL"
  exit 1
fi
exit 0
