#!/usr/bin/env bash
# Root-installed as /usr/local/libexec/bojin-alert.  Usage: bojin-alert MESSAGE
# Always logs to the journal; also POSTs the text to ALERT_URL when configured
# in /etc/bojin-alert.env (for example an ntfy.sh topic for phone notifications).
# Messages are generic status lines: never pass user data, tokens or secrets.
set -uo pipefail
message="Lean Ritual: ${*:-alert}"
logger -t bojin-alert -p daemon.warning -- "$message"
url=""
if [[ -r /etc/bojin-alert.env ]]; then
  url=$(sed -n 's/^[[:space:]]*ALERT_URL=//p' /etc/bojin-alert.env | tail -n 1 | tr -d '"'"'"'[:space:]')
fi
[[ -n "$url" ]] || exit 0
if ! curl --fail --silent --show-error --max-time 15 --retry 2 \
     -H "Title: Lean Ritual" -H "Tags: warning" --data-binary "$message" -- "$url" >/dev/null; then
  logger -t bojin-alert -p daemon.err -- "Could not deliver alert to ALERT_URL"
fi
exit 0
