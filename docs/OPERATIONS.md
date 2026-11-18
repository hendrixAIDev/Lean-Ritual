# Operations and recovery

当前部署与运维的统一入口：[部署与运维总手册](DEPLOYMENT-HANDBOOK.zh-CN.md)，包含另一 Agent 的交接整合、已验证部署证据及需要核对的冲突。此前的未部署/未合并状态属于历史记录，以总手册的证据日期为准。

For the current live-site evidence see STAGING-STATUS.md. GitHub auto-deployment
and its one-time server changes are documented in GITHUB-DEPLOYMENT.md. Install
the backup wrapper as `/usr/local/libexec/bojin-backup`, owned by root, rather than
executing a root service script from the replaceable application directory.

These commands are prepared, not deployed. Run as the configured service user unless a command uses systemctl. Node 24 is recommended. Protect DATA_DIR and all backup destinations with owner-only permissions. Docker runs as the unprivileged node user; bind mounts must be writable by that UID. Never expose port 8080 outside a trusted proxy when TRUST_PROXY=1. Keep the previous release's source/image and configuration separately from database snapshots.

## Consistent backup

Every supported data-writing entry point (server.js and auth-admin.js) holds a shared filesystem lease. Backup takes an exclusive lease and refuses if any writer is running. It does not pretend that independently copying SQLite files and photos during writes is consistent. The current single-server beta uses a short maintenance window.

1. Coordinate under the root-owned transition maintenance wrapper (`sudo /usr/local/sbin/bojin-maintenance-lock -- ...`, installed from `ops/maintenance-lock.sh`), stop the service, and finish admin commands. Never run `flock` without `sudo`, against world-writable `/run/lock`, or on `/run/bojin/maintenance.lock` alone until all legacy lock participants are retired. Do not edit the databases with external tools during backup.
2. With DATA_DIR set, run `node scripts/data-backup.js backup /private/backups/NEW-SNAPSHOT`.
3. Run `node scripts/data-backup.js ledger /private/backups/NEW-deletions.json` to preserve the latest deletion requests.
4. Restart the service, then copy both the snapshot directory and deletion ledger to private off-server storage over authenticated encrypted transport. Verify the copy using `node scripts/data-backup.js verify SNAPSHOT`.

The snapshot includes bojin.db, auth.sqlite if present, and every photo referenced by bojin.db. SQLite's backup API captures database state including WAL. SHA-256 and SQLite integrity checks detect incomplete/corrupt copies. Unreferenced orphan files, transient development emails, secrets and application source are intentionally excluded. Archive AUTH_SECRET and the deployment environment separately in secure credential storage; do not put them in the snapshot manifest.

Daily backups and pre-deploy snapshots stay on the server for approximately 7 days
(owner decision 2026-11-16). BACKUP_RETENTION_DAYS in /etc/bojin-backup.env defaults
to 7. The newest two of each snapshot type and newest deletion ledger are always
kept regardless of age. Releases retain the active release, the persisted /opt/bojin-previous as
rollback target, and newest five others. Pruning runs after successful publication
under the maintenance lock; failures fail the backup unit without removing the new
snapshot. Only recognized names are pruned, never symlink entries.

Upgrade the `systemd-tmpfiles` directory rule, transition lock wrapper, and receiver together under the dual-lock wrapper:
`sudo install -d -o root -g root -m 0755 /etc/tmpfiles.d /usr/local/sbin && sudo install -o root -g root -m 0644 ops/bojin-tmpfiles.conf /etc/tmpfiles.d/bojin.conf && sudo systemd-tmpfiles --create /etc/tmpfiles.d/bojin.conf && sudo install -o root -g root -m 0755 ops/maintenance-lock.sh /usr/local/sbin/bojin-maintenance-lock && sudo /usr/local/sbin/bojin-maintenance-lock -- install -o root -g root -m 0755 ops/deploy-release.py /usr/local/sbin/lean-ritual-deploy`
(`ops/install-auto-deploy.py` also installs `/etc/tmpfiles.d/bojin.conf` and `/usr/local/sbin/bojin-maintenance-lock`).
Install from a trusted checkout as root with `sudo /usr/local/sbin/bojin-maintenance-lock -- bash ops/install-backup.sh` (which also installs `/etc/tmpfiles.d/bojin.conf` and `/usr/local/sbin/bojin-maintenance-lock`, and ensures `/run/bojin` is `0755 root:root`).
This preserves existing environment configuration, disables the old local timer,
and enables the single daily bojin-backup.timer without restarting the app.
Verify with `systemctl list-timers bojin-backup.timer` and
`journalctl -u bojin-backup.service`. Run a manual backup and restore drill.
An empty OFFSITE_DEST logs "offsite disabled"; configured rsync retains bounded
timeouts and failures fail the unit. Offsite backup remains a known gap:
loss of the host can lose all server data.

### Shared maintenance lock (`/run/bojin/maintenance.lock`) and transition removal

Deploys (`/usr/local/sbin/lean-ritual-deploy`), scheduled backups (`/usr/local/libexec/bojin-backup`), the health watchdog (`/usr/local/libexec/bojin-watchdog`), and manual host maintenance coordinate through `/run/bojin/maintenance.lock` inside `root:root` `0755` `/run/bojin` (recreated across reboots via `/etc/tmpfiles.d/bojin.conf` from `ops/bojin-tmpfiles.conf`, and created defensively with `install -d -o root -g root -m 0755 /run/bojin` if missing). Every root helper refuses to use the lock if `/run/bojin` or `/run/bojin/maintenance.lock` is a symlink or not root-owned.

For one transition release, each updated root helper — and the manual operator wrapper `/usr/local/sbin/bojin-maintenance-lock` (`ops/maintenance-lock.sh -- <command>`) — acquires `/run/bojin/maintenance.lock` first and then `/run/lock/bojin-maintenance.lock` (using the same blocking or non-blocking mode) so no upgraded helper or manual operation can overlap an un-upgraded participant. All manual maintenance (helper replacement, manual backup, manual code rollback, and data restore) MUST use `sudo /usr/local/sbin/bojin-maintenance-lock -- <command>` (or `sudo bash ops/maintenance-lock.sh -- <command>` from a reviewed checkout) until all legacy participants are retired; taking only `/run/bojin/maintenance.lock` during the mixed-version window would miss an old process holding `/run/lock/bojin-maintenance.lock`. If `open(..., O_CREAT)` on `/run/lock/bojin-maintenance.lock` fails with `EACCES` under Ubuntu 24.04 `fs.protected_regular=2`, each script logs a warning and retries opening the existing legacy file **without `O_CREAT`** (`O_NOFOLLOW` + `fstat` regular-file validation) and acquires `flock` on that existing inode, failing closed if the retry also fails. Never `rm` `/run/lock/bojin-maintenance.lock` while any process might hold or open it (unlinking a held `flock` file lets new openers lock a fresh inode concurrently). Legacy `/run/lock/bojin-maintenance.lock` compatibility can be removed in the next release once `/etc/tmpfiles.d/bojin.conf`, `/usr/local/sbin/bojin-maintenance-lock`, `/usr/local/sbin/lean-ritual-deploy`, `/usr/local/libexec/bojin-backup`, and `/usr/local/libexec/bojin-watchdog` are all upgraded and hash-verified on the production host; only after deploying that post-transition release (quiescing all legacy entrants) and confirming no active process holds `/run/lock/bojin-maintenance.lock` (`sudo fuser -v /run/lock/bojin-maintenance.lock` / `sudo lsof /run/lock/bojin-maintenance.lock`, draining any running maintenance first) may `/run/lock/bojin-maintenance.lock` be unlinked, after which operators may use `sudo /usr/local/sbin/bojin-maintenance-lock -- ...` or `sudo flock /run/bojin/maintenance.lock ...` directly.

## Restore and rollback

Never restore over the live `/var/lib/bojin` directory. For an actual production recovery or cutover, acquire `sudo /usr/local/sbin/bojin-maintenance-lock -- ...` (until all legacy lock participants are retired), stop all writers (`bojin.service` and any admin CLI), preserve the current `/var/lib/bojin` directory for investigation, and restore into a new empty `bojin:bojin` (`0700`) directory after staging read-only copies (`root:bojin`, `0750` dirs, `0640` files) so `/var/backups` ownership is never altered:

```sh
sudo -u bojin env -i PATH=/usr/bin:/bin HOME=/var/tmp DATA_DIR=/var/lib/bojin-restored \
  /usr/bin/node /opt/bojin/scripts/data-backup.js verify /var/tmp/bojin-restore-stage/snapshot

sudo -u bojin env -i PATH=/usr/bin:/bin HOME=/var/tmp DATA_DIR=/var/lib/bojin-restored \
  /usr/bin/node /opt/bojin/scripts/data-backup.js restore \
  /var/tmp/bojin-restore-stage/snapshot /var/lib/bojin-restored \
  --deletions /var/tmp/bojin-restore-stage/deletions.json
```

`scripts/data-backup.js` does not read `/etc/bojin/environment`; pass only the minimal environment above via `sudo -u bojin` (or `runuser -u bojin`) and remove the staging copy afterward. Snapshot checksums protect against accidents, not a malicious actor who can replace both files and manifest.

### Finding the true newest deletion ledger

The latest deletion ledger is mandatory, even if `users` is empty (`[]`). Never assume the ledger paired with the selected snapshot — or even the newest file in `/var/backups/bojin/` alone — is the newest ledger on the host:

- Daily scheduled backups write `/var/backups/bojin/deletions-<UTC>.json`.
- Pre-deploy backups write `/var/backups/bojin-deploy/<UTC>-<id>/deletions.json`.

If a deploy ran after the last daily backup and a user deleted their account in between, restoring with `/var/backups/bojin/deletions-*.json` uses a stale ledger and **can resurrect deleted accounts** (along with their records, photos, and credentials). If the newest ledger was lost, do not reopen restored accounts until deletion requests have been reconciled. Because `/var/backups/bojin` and `/var/backups/bojin-deploy` are `0710 root:bojin` with `0700`/`0600` `root:root` entries, unquoted globs in `admin`'s shell fail before `sudo`; discover the newest ledger by `exportedAt` inside `sudo python3`:

```sh
LATEST_LEDGER=$(sudo python3 -c '
import datetime, glob, json, os, sys
candidates = []
for pattern in ("/var/backups/bojin/deletions-*.json", "/var/backups/bojin-deploy/*/deletions.json"):
    for p in glob.glob(pattern):
        if os.path.islink(p) or os.path.islink(os.path.dirname(p)) or not os.path.isfile(p):
            continue
        with open(p, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("version") == 1 and isinstance(data.get("users"), list) and isinstance(data.get("exportedAt"), str):
            ts = datetime.datetime.fromisoformat(data["exportedAt"].replace("Z", "+00:00"))
            candidates.append((ts, p, data["exportedAt"], len(data["users"])))
if not candidates:
    sys.exit("No valid deletion ledger found")
candidates.sort()
for _, p, exported, count in candidates[-5:]:
    print(f"{exported}  entries={count}  {p}", file=sys.stderr)
print(candidates[-1][1])
')
echo "Newest ledger: $LATEST_LEDGER"
```

### Throwaway / staging instance verification (`systemd-run` override safety)

> [!WARNING]
> **SAFETY — `EnvironmentFile=` overrides `-p Environment=` in `systemd-run`:** On systemd, `-p EnvironmentFile=/etc/bojin/environment` is applied **after** `-p Environment=DATA_DIR=...` for every key defined in `/etc/bojin/environment`, silently resetting `DATA_DIR` back to `/var/lib/bojin` (**LIVE production data**), `PORT` to `8080`, and `MAIL_MODE` to `smtp`. Every command that needs a `DATA_DIR` different from production (restore verification, restore drills, or throwaway instances) **must** pass overrides in `ExecStart` via `/usr/bin/env DATA_DIR=... PORT=... /usr/bin/node ...`.

When starting a non-public throwaway or staging instance against a restored directory, `MAIL_MODE=file` refuses any public `AUTH_BASE_URL` (`File mail is only available for localhost development` in `lib/mail.js`), and `COOKIE_SECURE=0` likewise requires a localhost origin (`lib/auth.js`). Always override all of:

- `DATA_DIR=<restored_path>` (never `/var/lib/bojin`)
- `HOST=127.0.0.1` and an unused `PORT` (for example `18099`)
- `MAIL_MODE=file` and `AUTH_BASE_URL=http://127.0.0.1:<port>`
- `COOKIE_SECURE=0` and `TRUST_PROXY=0`
- `OPENROUTER_API_KEY=` (empty so verification cannot spend live AI quota)

```sh
sudo systemd-run --unit=bojin-restore-check --uid=bojin --gid=bojin \
  -p WorkingDirectory=/opt/bojin \
  -p EnvironmentFile=/etc/bojin/environment \
  --collect \
  /usr/bin/env \
    DATA_DIR=/var/lib/bojin-restored \
    HOST=127.0.0.1 \
    PORT=18099 \
    MAIL_MODE=file \
    AUTH_BASE_URL=http://127.0.0.1:18099 \
    COOKIE_SECURE=0 \
    TRUST_PROXY=0 \
    OPENROUTER_API_KEY= \
    /usr/bin/node --disable-warning=ExperimentalWarning /opt/bojin/server.js
```

Reapply the recorded application release and environment, test `/api/health`, login, account isolation, and a photo on the loopback listener, and stop `bojin-restore-check.service` before switching production traffic under `sudo /usr/local/sbin/bojin-maintenance-lock -- ...`. After cutover, verify live `/api/health`, error logs, SMTP delivery, and AI configuration. A pre-auth snapshot may have no `auth.sqlite`: it is a rollback to the legacy release, not a reason to expose legacy unrestricted signup. Keep legacy rollback isolated until its access controls are reviewed.

### Restore drill procedure (non-disruptive)

Last drill record: `last drill: 2026-11-18, snapshot-20261118T052524Z, OK`

`bojin-maintenance-lock` is **not** needed for read-only staging in a restore drill: published `snapshot-*` directories and `deletions*.json` files are immutable (published via atomic rename), and the drill never stops `bojin.service` or touches `/var/lib/bojin` (acquiring the maintenance lock unnecessarily would block scheduled backups, deploys, or the watchdog). Record only counts, byte sizes, and timestamps — never inspect or log emails, usernames, tokens, secrets, or document contents.

```sh
# 1. Select the newest daily snapshot and the newest deletion ledger across BOTH backup roots
SNAPSHOT=$(sudo python3 -c '
import glob, os, sys
snaps = sorted(
    p for p in glob.glob("/var/backups/bojin/snapshot-*")
    if not os.path.islink(p) and os.path.isdir(p) and os.path.isfile(os.path.join(p, "manifest.json"))
)
if not snaps:
    sys.exit("No valid snapshot found in /var/backups/bojin")
print(snaps[-1])
')
LATEST_LEDGER=$(sudo python3 -c '
import datetime, glob, json, os, sys
candidates = []
for pattern in ("/var/backups/bojin/deletions-*.json", "/var/backups/bojin-deploy/*/deletions.json"):
    for p in glob.glob(pattern):
        if os.path.islink(p) or os.path.islink(os.path.dirname(p)) or not os.path.isfile(p):
            continue
        with open(p, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("version") == 1 and isinstance(data.get("users"), list) and isinstance(data.get("exportedAt"), str):
            ts = datetime.datetime.fromisoformat(data["exportedAt"].replace("Z", "+00:00"))
            candidates.append((ts, p, data["exportedAt"], len(data["users"])))
if not candidates:
    sys.exit("No valid deletion ledger found")
candidates.sort()
print(candidates[-1][1])
')
echo "Snapshot:      $SNAPSHOT"
echo "Newest ledger: $LATEST_LEDGER"

# 2. Stage read-only copies for bojin inside a 0700 /var/tmp/restore-drill-<UTC> workspace
DRILL="/var/tmp/restore-drill-$(date -u +%Y%m%dT%H%M%SZ)"
echo "Drill dir:     $DRILL"
sudo mkdir -m 0700 -- "$DRILL"
sudo install -d -o root -g bojin -m 0750 "$DRILL/stage"
sudo install -d -o bojin -g bojin -m 0700 "$DRILL/data"
sudo cp -rP -- "$SNAPSHOT" "$DRILL/stage/snapshot"
sudo cp -P -- "$LATEST_LEDGER" "$DRILL/stage/deletions.json"
sudo chown -RP root:bojin -- "$DRILL/stage"
sudo find "$DRILL/stage" -type d -exec chmod 0750 -- {} +
sudo find "$DRILL/stage" -type f -exec chmod 0640 -- {} +
sudo chown bojin:bojin -- "$DRILL"

# 3. Verify and restore as bojin with --deletions
sudo -u bojin env -i PATH=/usr/bin:/bin HOME=/var/tmp DATA_DIR="$DRILL/data" \
  /usr/bin/node /opt/bojin/scripts/data-backup.js verify "$DRILL/stage/snapshot"

sudo -u bojin env -i PATH=/usr/bin:/bin HOME=/var/tmp DATA_DIR="$DRILL/data" \
  /usr/bin/node /opt/bojin/scripts/data-backup.js restore \
  "$DRILL/stage/snapshot" "$DRILL/data" --deletions "$DRILL/stage/deletions.json"

# 4. Read-only SQLite integrity, table counts, blob byte checks, and ledger-replay verification
sudo -u bojin python3 - "$DRILL/data" "$DRILL/stage/deletions.json" <<'PY'
import json, pathlib, sqlite3, stat, sys

data_dir = pathlib.Path(sys.argv[1])
ledger = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
deleted_uids = [u["uid"] for u in ledger.get("users", [])]

def ro_db(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)

def has_table(conn, name):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None

app = ro_db(data_dir / "bojin.db")
try:
    assert app.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "bojin.db integrity_check failed"
    blob_rows = app.execute("SELECT id, size FROM blobs").fetchall() if has_table(app, "blobs") else []
    blobs_dir = data_dir / "blobs"
    disk_files = {p.name: p for p in blobs_dir.iterdir()} if blobs_dir.exists() else {}
    assert set(disk_files) == {r[0] for r in blob_rows}, "blob file set mismatch"
    total_blob_bytes = 0
    for blob_id, size in blob_rows:
        st = disk_files[blob_id].lstat()
        assert stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o600 and st.st_size == size
        total_blob_bytes += size
    for uid in deleted_uids:
        for tbl in ("docs", "blobs"):
            if has_table(app, tbl):
                assert app.execute(f"SELECT COUNT(*) FROM {tbl} WHERE uid=?", (uid,)).fetchone()[0] == 0
    counts = {t: app.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("docs", "blobs", "ai_usage", "deletion_jobs") if has_table(app, t)}
    print("bojin.db integrity=ok counts=", counts, "blob_bytes=", total_blob_bytes)
finally:
    app.close()

auth_path = data_dir / "auth.sqlite"
if auth_path.exists():
    auth = ro_db(auth_path)
    try:
        assert auth.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "auth.sqlite integrity_check failed"
        for uid in deleted_uids:
            if has_table(auth, "user"):
                assert auth.execute("SELECT COUNT(*) FROM user WHERE id=?", (uid,)).fetchone()[0] == 0
        acounts = {t: auth.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                   for t in ("user", "account", "launch_invites", "session", "verification") if has_table(auth, t)}
        print("auth.sqlite integrity=ok counts=", acounts)
    finally:
        auth.close()
print("ledger_replayed_entries=", len(deleted_uids), "ALL_CHECKS_OK")
PY

# 5. Optional: smoke-test an isolated throwaway instance on loopback (overrides MUST use /usr/bin/env)
test -z "$(sudo ss -Htlpn 'sport = :18099')"
sudo systemd-run --unit=bojin-restore-drill --uid=bojin --gid=bojin \
  -p WorkingDirectory=/opt/bojin \
  -p EnvironmentFile=/etc/bojin/environment \
  --collect \
  /usr/bin/env \
    DATA_DIR="$DRILL/data" \
    HOST=127.0.0.1 \
    PORT=18099 \
    MAIL_MODE=file \
    AUTH_BASE_URL=http://127.0.0.1:18099 \
    COOKIE_SECURE=0 \
    TRUST_PROXY=0 \
    OPENROUTER_API_KEY= \
    /usr/bin/node --disable-warning=ExperimentalWarning /opt/bojin/server.js

for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl --fail --silent --show-error --max-time 2 http://127.0.0.1:18099/api/health && break
  sleep 0.5
done
echo
sudo ss -Htlpn 'sport = :18099'
sudo systemctl stop bojin-restore-drill.service
test -z "$(sudo ss -Htlpn 'sport = :18099')"

# 6. Cleanup using the exact drill directory path (NEVER a /var/tmp/restore-drill-* wildcard)
[[ "$DRILL" =~ ^/var/tmp/restore-drill-[0-9]{8}T[0-9]{6}Z$ ]]
sudo rm -rf -- "$DRILL"
sudo test ! -e "$DRILL"
systemctl is-active bojin.service
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8080/api/health
echo
```

If running cleanup in a separate shell where `$DRILL` is not set, pass the literal directory path printed in Step 2 (for example `sudo rm -rf -- /var/tmp/restore-drill-20261118T083600Z`), never a glob.

## Interrupted processes and leases

Normal SIGTERM/SIGINT shutdown and uncaught-exception exits release leases. A SIGKILL/OOM kill can leave a file under `DATA_DIR/.access/readers/`, or a `.access/writer` directory. Leases record hostname, kernel boot ID, PID namespace and process start time; backup and app start remove a leftover only when it provably belongs to a dead process on this same kernel (or a previous boot of this host). Leases from another container/host, or in the older format without that evidence, still fail closed. If backup still refuses after a crash: stop EVERY app/admin/backup process using that data volume, check service/container state, then remove the confirmed stale lease files/directory. Never remove a lease while its process might still be writing. Restart the service and repeat the drill.

## Monitoring and account operations

- Configure external HTTPS uptime checks for `/api/health`, plus alerts for service restarts, disk capacity, backup age/offsite-copy failure and provider spending. Docker has an internal healthcheck; it does not prove mainland reachability.
- Authentication failures and provider outages must not include passwords, keys, email links or record contents in logs. Do not turn on request-body logging. Backup/data paths are private. Each `/api/ai` call logs one metadata-only diagnostic line (`kind`, `images`, configured `model`, allowlisted `finish_reason` in `stop|length|content_filter|tool_calls|error|other`, numeric `prompt`/`completion`/`reasoning` token counts, `empty`, numeric `ms`) and never logs provider-returned free text, prompts, responses, or user IDs.
- Optional reasoning effort (`AI_REASONING_EFFORT`): unset or empty by default (no `reasoning` parameter sent). When set to `low`, `medium`, or `high`, `/api/ai` sends `reasoning: {"effort": "<value>"}` to OpenRouter; any other value fails startup naming `AI_REASONING_EFFORT`.
- Issue/revoke invitations using scripts/auth-admin.js. Preserve legacy IDs with --legacy-user; verify the mapping with the owner first. After migrating, repeat the import only if needed; it fills missing records rather than overwriting.
- Account deletion queues cleanup durably before deleting credentials. Files/records are removed after auth deletion, and interrupted cleanup retries at startup/every minute. If auth deletion itself failed, access stays blocked; the user can retry the authenticated /api/auth/delete-user endpoint with their password. Investigate repeated cleanup errors before launch.

## Local evidence

Tests cover writer exclusion, checksums, refusing overwrites, snapshots with both databases/photos, pre-auth migration and rollback, and replaying a newer deletion ledger onto an older snapshot. These tests do not replace a restore drill and offsite access verification on the purchased host.

文档保护：`DOC_USER_BYTES` 默认 52428800（50 MiB，按 UTF-8 字节计算），`DOC_USER_COUNT` 默认 20000；覆盖按新旧大小差计算，删除释放额度。超过额度返回 413 / `doc_quota`。`DOC_WRITE_PER_MIN` 默认 240，每账号固定 60 秒窗口限制写入（含删除与失败尝试），超限返回 429 和 `Retry-After`；读取不限流，重启清空窗口。配置均须为正整数。默认值为日常记录保留充足空间，同时限制单账号滥用。

超额账号可覆盖为不增加字节数的现有文档，以便删减内容恢复额度；`node server.js import` 同样执行文档额度检查。客户端对 429 最多重试两次，遵循 `Retry-After`（1–65 秒，缺省 5 秒）；413 立即提示错误并保留待保存输入。

Deploys reject an intentionally stopped service unless authorized once via
`sudo install -m 0600 -o root -g root /dev/null /etc/bojin/allow-deploy-when-stopped`; the deploy consumes this authorization under the maintenance lock.
Backup and deploy require free space greater than size(DATA_DIR) + 1.5 GiB before stopping the app. Backup releases the maintenance lock before bounded offsite rsync.
Release pruning skips entirely until the upgraded deploy helper has recorded /opt/bojin-previous after a successful deploy; active and previous pointers must resolve. Releases younger than the retention window are also kept.

### Browser security headers

All responses carry COOP `same-origin`, Permissions-Policy
`camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()`
and enforced CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' <SHA-256 hashes>; worker-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`.
Hashes are computed at build time from the exact built HTML and static pages;
deploy public/csp-hashes.json with the assets and restart after replacing HTML. Build before starting the server. No inline script
or event-handler allowance is required; inline styles remain supported.
Wasm compilation and blob workers support local Tesseract OCR.
HSTS is `max-age=15552000; includeSubDomains` only with `COOKIE_SECURE=1`
or trusted proxy requests with `X-Forwarded-Proto: https`.
Only enable `TRUST_PROXY` behind a proxy that overwrites forwarded headers.
Camera file capture does not use getUserMedia.

Run the extended browser check with Playwright available:
`CHROMIUM_PATH=/path/to/chromium node tests/security-browser.cjs`.
It checks CSP events across public pages and authenticated photo/OCR flows.

HEIC conversion uses the build-extracted /vendor/heic2any-worker.js.
Only that worker response receives CSP `default-src 'none'; script-src 'unsafe-eval'`;
HTML retains its hashed script policy without unsafe-eval. Conversion errors
or a 20-second timeout preserve meal text and show the photo decode error.
Startup checks the manifest against all four served HTML pages and refuses
stale/missing hashes with a rebuild message; CLI import does not require a build.
Release packaging and unpacking require the generated hash manifest.
The committed HEIC fixture is a synthetic 8×8 red image generated with sips.
