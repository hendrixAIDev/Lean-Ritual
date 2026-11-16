#!/usr/bin/env bash
set -uo pipefail
if (( EUID != 0 )); then echo 'FAIL Run with sudo (root required)'; exit 1; fi
R=${AUDIT_ROOT:-}; fails=0; warns=0
report() { echo "$1 $2"; case $1 in FAIL) ((fails+=1));; WARN) ((warns+=1));; esac; }
p() { printf '%s%s' "$R" "$1"; }
# Unstructured service output is deliberately suppressed: journal messages and
# command arguments can contain arbitrary credentials without recognizable keys.
safe_lines() { sed -E '/[Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss]|[Tt][Oo][Kk][Ee][Nn]|[Tt][Oo][Pp][Ii][Cc]|https?:\/\//c\[REDACTED sensitive line]' ; }
echo 'Runtime'
nodebin=$(p /usr/bin/node); v=$($nodebin --version 2>/dev/null || true)
[[ $v == v24.* ]] && report PASS "node $v" || report FAIL 'node expected v24.x'
[[ $(uname -m) == x86_64 ]] && report PASS 'architecture x86_64' || report WARN 'architecture differs'
sed -n '/^PRETTY_NAME=/p' "$(p /etc/os-release)" 2>/dev/null | safe_lines
release=$(readlink -f "$(p /opt/bojin)" 2>/dev/null || true)
echo "Release: $release" | safe_lines
python3 - "$release/.release.json" <<'PY'
import json,sys,re
try:
 r=json.load(open(sys.argv[1])).get('revision','unknown'); print('Revision:',r if re.fullmatch('[a-fA-F0-9]{7,64}',str(r)) else '[unavailable]')
except Exception: print('WARN release metadata unavailable')
PY
curl -s --max-time 5 http://127.0.0.1:8080/api/health | python3 -c 'import sys,json,re
try:
 d=json.load(sys.stdin); r=str(d.get("revision","")); print("Health ok:",d.get("ok") is True,"revision:",r if re.fullmatch("[a-fA-F0-9]{7,64}",r) else "[unavailable]")
except Exception: print("WARN health unavailable")'
echo 'Helper integrity'
for pair in 'sbin/lean-ritual-deploy:deploy-release.py' 'libexec/bojin-backup:backup-service.sh' 'libexec/bojin-watchdog:health-watchdog.sh' 'libexec/bojin-alert:alert.sh'; do
 installed=$(p "/usr/local/${pair%%:*}"); src="$release/ops/${pair#*:}"
 [[ -f $src ]] || src="$(dirname "$0")/../ops/${pair#*:}"
 if [[ ! -f $installed ]]; then report WARN "MISSING $installed"; continue; fi
 h=$(sha256sum "$installed" | cut -d' ' -f1)
 if [[ -f $src ]]; then other=$(sha256sum "$src" | cut -d' ' -f1); [[ $h == "$other" ]] && report PASS "MATCH $installed $h" || report FAIL "DIFFERENT $installed installed=$h source=$other"; else report WARN "reference MISSING $installed hash=$h"; fi
done
echo 'systemd'
for unit in bojin.service caddy.service bojin-backup.service bojin-backup.timer bojin-backup-local.service bojin-backup-local.timer bojin-watchdog.service bojin-watchdog.timer; do
 echo "$unit"
 systemctl show "$unit" -p LoadState -p ActiveState -p SubState -p Result -p NRestarts -p ExecMainStatus -p User -p EnvironmentFiles | safe_lines
 execspec=$(systemctl show "$unit" -p ExecStart --value 2>/dev/null || true)
 while IFS= read -r path; do [[ -z $path ]] && continue; echo "ExecStart path=$path" | safe_lines; [[ -e $(p "$path") ]] || report FAIL "ExecStart missing: $path"; done < <(printf '%s' "$execspec" | grep -oE 'path=[^ ;}]+' | cut -d= -f2)
 [[ $unit == *.timer ]] && systemctl list-timers "$unit" --no-pager | safe_lines
done
for unit in bojin-backup-local.service bojin-backup.service; do
 echo "Journal $unit (20 lines; message text withheld to guarantee no credentials)"
 journalctl -u "$unit" -n 20 --no-pager 2>/dev/null | awk '{print "[journal entry withheld]"}'
done
systemctl cat bojin.service 2>/dev/null | grep -E '^(Restart|StartLimit[^=]*|EnvironmentFile|User|WorkingDirectory)=' | safe_lines
echo 'Permissions and capacity'
for path in /etc/bojin/environment /var/lib/bojin /var/lib/bojin/bojin.db /var/lib/bojin/auth.sqlite /run/lock/bojin-maintenance.lock; do
 stat -c '%U:%G %a %n' "$(p "$path")" 2>/dev/null | safe_lines
 if [[ $path == /run/lock/* && -e $(p "$path") && $(stat -c %U "$(p "$path")") != root ]]; then report WARN 'maintenance lock not root owned'; fi
done
for path in "$(p /var/backups)"/bojin*; do stat -c '%U:%G %a %n' "$path" 2>/dev/null | safe_lines; done
sysctl fs.protected_regular 2>/dev/null
for path in / /var/lib/bojin /var/backups /opt; do df -h "$(p "$path")"; df -i "$(p "$path")"; done
for path in /var/lib/bojin /var/backups/bojin /var/backups/bojin-deploy /opt/bojin-releases; do du -sh "$(p "$path")" 2>/dev/null; echo "$path entries=$(find "$(p "$path")" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)"; done
free -m; swapon --show
while IFS= read -r file; do report FAIL "leftover environment file: $file"; done < <(find "$(p /opt)" -path '*/bojin*' -type f \( -name .env -o -name '.env.*' \) 2>/dev/null)
echo 'Lease state'
find "$(p /var/lib/bojin/.access)" -maxdepth 1 -type f -printf '%f %s bytes %TY-%Tm-%Td %TH:%TM\n' 2>/dev/null | safe_lines
[[ -n $(find "$(p /var/lib/bojin/.access)" -type f -empty -print -quit 2>/dev/null) ]] && report WARN 'zero-byte lease file found'
echo 'Configuration (values withheld)'
python3 - "$R" <<'PY'
import sys,pathlib
for name,expected in [('bojin/environment','AUTH_SECRET AUTH_BASE_URL SMTP_HOST SMTP_USER SMTP_PASS MAIL_FROM OPENROUTER_API_KEY OPENROUTER_MODEL COOKIE_SECURE TRUST_PROXY DATA_DIR'),('bojin-backup.env','OFFSITE_DEST'),('bojin-alert.env','')]:
 p=pathlib.Path(sys.argv[1]+'/etc/'+name); print(name, 'present' if p.exists() else 'MISSING'); d={}
 if p.exists():
  for line in p.read_text().splitlines():
   if '=' in line and not line.lstrip().startswith('#'):
    k,v=line.split('=',1); d[k.strip()]=v.strip().strip('\"\'')
 for k in expected.split():
  v=d.get(k,''); print(k, 'present' if v else 'empty/missing')
  if k=='AUTH_SECRET': print('AUTH_SECRET length',len(v),'PASS' if len(v)>=32 else 'WARN')
  if k in ('COOKIE_SECURE','TRUST_PROXY'): print(k, v if v in ('true','false','0','1') else '[invalid/empty]')
 print('additional key count',len(set(d)-set(expected.split())))
PY
caddy version
caddy validate --config "$(p /etc/caddy/Caddyfile)" >/dev/null 2>&1 && report PASS 'Caddy validation' || report FAIL 'Caddy validation'
for directive in lb_try_duration handle_errors; do grep -q "$directive" "$(p /etc/caddy/Caddyfile)" 2>/dev/null && report PASS "Caddy $directive present" || report WARN "Caddy $directive absent"; done
timeout 10 openssl s_client -connect 127.0.0.1:443 -servername leanritual.app </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | safe_lines
echo "Summary: FAIL=$fails WARN=$warns"
exit 0
