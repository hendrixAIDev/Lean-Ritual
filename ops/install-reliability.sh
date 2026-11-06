#!/usr/bin/env bash
# One-time host setup for auto-restart, health watchdog and alerts.
# Run as root from a reviewed checkout:  sudo bash ops/install-reliability.sh
# It does not restart the app, change data, configuration secrets or Caddyfile.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo/root" >&2; exit 1; }
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for tool in curl flock logger systemctl; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
systemctl cat bojin.service >/dev/null 2>&1 || { echo "bojin.service not found; review the host first" >&2; exit 1; }

# Root-run programs live outside the replaceable release directory.
install -o root -g root -m 0755 "$here/alert.sh" /usr/local/libexec/bojin-alert
install -o root -g root -m 0755 "$here/health-watchdog.sh" /usr/local/libexec/bojin-watchdog
install -o root -g root -m 0644 "$here/bojin-alert@.service" "$here/bojin-watchdog.service" "$here/bojin-watchdog.timer" /etc/systemd/system/

install -d -o root -g root -m 0755 /etc/systemd/system/bojin.service.d
install -o root -g root -m 0644 "$here/bojin-reliability.conf" /etc/systemd/system/bojin.service.d/reliability.conf
if systemctl cat caddy.service >/dev/null 2>&1; then
  install -d -o root -g root -m 0755 /etc/systemd/system/caddy.service.d
  install -o root -g root -m 0644 "$here/caddy-reliability.conf" /etc/systemd/system/caddy.service.d/reliability.conf
fi
for unit in bojin-backup.service bojin-backup-local.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then
    install -d -o root -g root -m 0755 "/etc/systemd/system/$unit.d"
    install -o root -g root -m 0644 "$here/backup-alert.conf" "/etc/systemd/system/$unit.d/alert.conf"
    echo "Backup failure alerts enabled for $unit"
  fi
done
if [[ ! -e /etc/bojin-alert.env ]]; then
  install -o root -g root -m 0600 "$here/alert.env.example" /etc/bojin-alert.env
fi

systemctl daemon-reload
systemctl enable --now bojin-watchdog.timer
echo
systemctl show bojin.service -p Restart -p RestartUSec -p StartLimitIntervalUSec
systemctl list-timers bojin-watchdog.timer --no-pager
echo "Done. OOMScoreAdjust applies from the next app restart (e.g. the next deploy)."
echo "Optional: put ALERT_URL in /etc/bojin-alert.env, then test: sudo /usr/local/libexec/bojin-alert test"
