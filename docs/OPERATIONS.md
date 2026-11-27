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
2. With DATA_DIR set, run `node scripts/data-backup.js backup /private/backups/NEW-SNAPSHOT` (optionally pass `--link-dest /private/backups/PREV-SNAPSHOT` one or more times to hardlink unchanged photo blobs on the same filesystem).
3. Run `node scripts/data-backup.js ledger /private/backups/NEW-deletions.json` to preserve the latest deletion requests.
4. Restart the service, then copy both the snapshot directory and deletion ledger to private off-server storage over authenticated encrypted transport. Verify the copy using `node scripts/data-backup.js verify SNAPSHOT`.

The snapshot includes bojin.db, auth.sqlite if present, and every photo referenced by bojin.db. SQLite's backup API captures database state including WAL. SHA-256 and SQLite integrity checks detect incomplete/corrupt copies. Unreferenced orphan files, transient development emails, secrets and application source are intentionally excluded. Archive AUTH_SECRET and the deployment environment separately in secure credential storage; do not put them in the snapshot manifest.

### Snapshot photo deduplication and disk-usage guard

Unchanged photo blobs under `blobs/` are deduplicated across snapshots via same-filesystem hardlinks (SQLite databases `bojin.db` and `auth.sqlite` are always copied fresh, and snapshots never share inodes with live `DATA_DIR`):

- **Automated daily and pre-deploy backups (`/usr/local/libexec/bojin-backup` and `/usr/local/sbin/lean-ritual-deploy`):** Before stopping the app, root indexes existing committed `root:root` snapshots across both `/var/backups/bojin` and `/var/backups/bojin-deploy` on the same filesystem, links and SHA-256-verifies eligible blobs into a root-only (`0700`) prelink stage, and checks peak free space per filesystem. Root writes the `--defer-blobs` index inside a root-controlled directory before granting read-only traversal to `bojin`; `data-backup.js` runs unprivileged as `bojin` and copies only the databases plus new/changed photo blobs. Root immediately moves `bojin`'s staging directory under its root-only custody parent, validates every directory/file without following symlinks (requiring regular files, `st_nlink == 1`, and expected `bojin` ownership), and copies every app-produced file into fresh root-owned `0600` inodes (`O_CREAT|O_EXCL`) so no process under the app UID can retain a writable descriptor to published data. Root then moves the prelinked verified blobs into the snapshot, verifies every file's size, SHA-256, and SQLite integrity (re-checking the `1.5 GiB` free-space reserve before any late fallback copy and aborting cleanly if space is tight), fsyncs all new files, directories, and the backup root (propagating directory `fsync` failures), and commits daily snapshot+ledger pairs with a durable `.publishing-<stamp>` barrier so interrupted publications never displace complete recovery points during retention.
- **Self-contained snapshots after pruning:** Each snapshot directory contains ordinary regular-file entries for every referenced blob. Pruning older snapshots only decrements hardlink counts (`st_nlink`); every surviving snapshot remains complete and independently restorable.
- **Dedup-aware peak free-space preflight:** Backup and deploy preflight checks require free space strictly greater than `peak_snapshot_bytes + 1.5 GiB` on every involved filesystem — discounting only blobs whose hardlinks are already secured and SHA-256-verified in root-only staging (so same-length corruption, cross-device mounts, `EMLINK`, or `fs.protected_hardlinks` fallbacks are always counted at full size), and including both the temporary root custody copy-to-fresh-inode peak and the temporary verification copy of the SQLite databases (`db_bytes + new_blob_bytes + max(db_bytes, max_staged_file_bytes) + 1.5 GiB` when temp and backup share a filesystem). During a transition before `--defer-blobs`-capable app code is deployed, preflight conservatively falls back to full `size(DATA_DIR)` (+ peak copy/verification headroom) + `1.5 GiB` and deduplicates after copy.
- **80% disk-usage guard (`ALERT_URL`) with shared cooldowns:** `ops/health-watchdog.sh`, `ops/backup-service.sh` (`BACKUP_DISK_WARN_PERCENT=80`, `BACKUP_DISK_CRIT_PERCENT=90`), and `ops/deploy-release.py` all share per-filesystem, per-severity 6-hour cooldown stamps under `/run/bojin-watchdog` (using `/proc/uptime`) and deliver alerts via `/usr/local/libexec/bojin-alert` (which passes `ALERT_URL` to `curl` via stdin `--config -`, never in process argv). Warnings fire at **80%** (and are suppressed while a 90% critical cooldown is active); **90%** critical usage (or a low-space blocked deploy) escalates immediately on its own cooldown key.
- **Host helper upgrade note:** Merging application code updates `lib/snapshots.js` and `scripts/data-backup.js`, but host-side dedup, dedup-aware preflight, and 80% disk alerts require installing the updated root helpers (`ops/deploy-release.py`, `ops/install-backup.sh`, `ops/install-reliability.sh`) under `sudo /usr/local/sbin/bojin-maintenance-lock -- ...`.

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

Never restore over the live `/var/lib/bojin` directory. Each deduplicated snapshot is completely self-contained and restorable on its own even after all older snapshots have been pruned. **Never run `chmod` or `chown` in-place inside `/var/backups/bojin` or `/var/backups/bojin-deploy`** (deduplicated snapshots share hardlinked photo inodes, so mutating permissions in place would affect every snapshot sharing that inode). Always copy the chosen snapshot out with `cp -rP` (which creates independent files in the staging directory without hardlinking back to `/var/backups`) before adjusting staging ownership/permissions for `bojin`. For an actual production recovery or cutover, acquire `sudo /usr/local/sbin/bojin-maintenance-lock -- ...` (until all legacy lock participants are retired), stop all writers (`bojin.service` and any admin CLI), preserve the current `/var/lib/bojin` directory for investigation, and restore into a new empty `bojin:bojin` (`0700`) directory after staging read-only copies (`root:bojin`, `0750` dirs, `0640` files) so `/var/backups` ownership is never altered:

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
- `OPENROUTER_API_KEY=` and `GEMINI_API_KEY=` (empty so verification cannot spend live AI quota under either provider)

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
    GEMINI_API_KEY= \
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
    GEMINI_API_KEY= \
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

## Landing-page media

Anonymous visitors to `/` see `public/landing.html`; signed-in users still get the app. **The intro video is off by default.** The video section appears only while `MEDIA_DIR` is set and all four MP4s below are readable, non-empty regular files in it. Otherwise the page has no video section and every `/media/` URL, posters included, returns 404.

**Do not install the v10 cuts.** They claim "AI 持续调整 / tuned by AI", "几秒出结果 / results in seconds" and "随时撤销 / undo anytime", which the app does not do. The server cannot judge content: putting four files in this folder is the approval, so install only cuts the owner has approved.

| URL | File in `MEDIA_DIR` |
|---|---|
| `/media/intro-zh-9x16.mp4` | phone, Chinese |
| `/media/intro-zh-16x9.mp4` | desktop, Chinese |
| `/media/intro-en-9x16.mp4` | phone, English |
| `/media/intro-en-16x9.mp4` | desktop, English |
| `/media/intro-<lang>-<shape>.jpg` | matching poster in `MEDIA_DIR` (no bundled fallback) |

Both the MP4s and their posters stay out of Git, release bundles and `DATA_DIR` snapshots. Only these eight names are served; symlinks are refused, so install real files. Responses support Range (206) on GET, `ETag`/`Last-Modified` and `Cache-Control: public, max-age=604800`. A browser downloads a video only after the visitor presses play.

Once approved cuts exist (as root, from the folder holding them):

```bash
install -d -o root -g bojin -m 0750 /var/lib/bojin-media
for f in intro-zh-9x16 intro-zh-16x9 intro-en-9x16 intro-en-16x9; do
  install -o root -g bojin -m 0640 "$f.mp4" "/var/lib/bojin-media/$f.mp4"
  install -o root -g bojin -m 0640 "$f.jpg" "/var/lib/bojin-media/$f.jpg"
done
grep -q '^MEDIA_DIR=' /etc/bojin/environment || echo 'MEDIA_DIR=/var/lib/bojin-media' >> /etc/bojin/environment
sudo /usr/local/sbin/bojin-maintenance-lock -- systemctl restart bojin.service
# Must be a GET: Range is ignored on HEAD, so `curl -I` would report 200.
curl -s -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-1' https://leanritual.app/media/intro-zh-9x16.mp4   # expect 206
```

Availability checks are cached in memory (single-flight coalesced) for `MEDIA_CHECK_TTL_MS` milliseconds — **30000 ms (30 s) by default**, configurable in `/etc/bojin/environment` as an integer from `1` to `300000` (up to 300 s; out-of-range or non-integer values fail startup, and changing the value requires restarting `bojin.service`). The configured window applies in both directions:

- **Turning on without a restart:** If the server previously cached `false` while files were incomplete, adding the fourth MP4 takes effect once the cached entry expires (up to `MEDIA_CHECK_TTL_MS`, 30 s by default).
- **Turning off without a restart:** Removing or renaming any one of the four MP4s hides the section once the cached entry expires (up to `MEDIA_CHECK_TTL_MS`, 30 s by default), or immediately as soon as a qualifying `GET`/`HEAD` request hits that missing/invalid MP4 (a confirmed miss invalidates any active or in-flight positive result). Until expiry or such a miss, fresh landing-page responses can still include the player and load its poster.

To publish a new cut, replace the same file name with `install` (it writes a new file, so viewers mid-stream keep the old one; don't `cp` over it in place). Because the `/media/` URLs stay the same, browsers with a cached copy of an old MP4 or poster may keep it for up to 7 days.

## Monitoring and account operations

- Configure external HTTPS uptime checks for `/api/health`, plus alerts for service restarts, disk capacity, backup age/offsite-copy failure and provider spending. Docker has an internal healthcheck; it does not prove mainland reachability.
- Authentication failures and provider outages must not include passwords, keys, email links or record contents in logs. Do not turn on request-body logging. Backup/data paths are private. Each `/api/ai` call logs one metadata-only diagnostic line (`provider` in `gemini|openrouter`, optional `provider_fallback=true`, optional `retries=<n>` for transient Gemini backoff retries, `kind`, `images`, configured `model`, allowlisted `finish_reason` in `stop|length|content_filter|tool_calls|error|other`, numeric `prompt`/`completion`/`reasoning` token counts, `empty`, optional `fallback=true` for JSON-mode retry, numeric `ms`) and never logs provider-returned free text, prompts, responses, keys, or user IDs.
- Client runtime error reports (`POST /api/client-error`): accepts JSON bodies up to 2 KiB from authenticated sessions or `/login.html` (with `X-Bojin: 1` and same-origin `Origin`/`Sec-Fetch-Site`/`Referer` checks), validates allowlisted fields and uses fixed messages (ignoring extras), enforces per-user (20/hour) and per-IP (40/hour authenticated; 5/hour anonymous login-page) rate limits, plus a 300/hour process-wide cap (dropping over-limit reports silently with `204`), writes nothing to SQLite, and logs one sanitized single-line entry prefixed `client-error` to journald. Cross-origin `"Script error."`, browser-extension or non-origin script URLs, and benign `ResizeObserver` loop events are filtered client-side and tallied separately under `client-error-filtered` (within the same aggregate rate limits, reserving at least half of each bucket for ordinary app errors so noise never crowds them out). View recent client errors on the host:

```sh
# Last 24 hours of client errors
journalctl -u bojin.service --since -24h -o cat | grep '^client-error '

# Last 24 hours of filtered browser/extension noise
journalctl -u bojin.service --since -24h -o cat | grep '^client-error-filtered '

# Follow live during beta testing
journalctl -u bojin.service -f -o cat | grep --line-buffered '^client-error '

# Group by error name and source location (last 24h)
journalctl -u bojin.service --since -24h --no-pager -o cat | grep '^client-error ' | sed -n 's/.*source=\([^ ]*\) name=\([^ ]*\).*/\2 \1/p' | sort | uniq -c | sort -rn
```
- Optional reasoning effort (`AI_REASONING_EFFORT`): unset or empty by default (no reasoning effort parameter sent). When set to `low`, `medium`, or `high`, `/api/ai` sends `reasoning_effort: "<value>"` to the direct Gemini API (`AI_PROVIDER=gemini`) and `reasoning: {"effort": "<value>"}` to OpenRouter (`AI_PROVIDER=openrouter` or fallback); any other value fails startup naming `AI_REASONING_EFFORT`.
- Issue/revoke invitations using scripts/auth-admin.js. Preserve legacy IDs with --legacy-user; verify the mapping with the owner first. After migrating, repeat the import only if needed; it fills missing records rather than overwriting.
- Account deletion queues cleanup durably before deleting credentials. Files/records are removed after auth deletion, and interrupted cleanup retries at startup/every minute. If auth deletion itself failed, access stays blocked; the user can retry the authenticated /api/auth/delete-user endpoint with their password. Investigate repeated cleanup errors before launch.

### AI provider switching and rollback

`/api/ai` supports two providers selected via `AI_PROVIDER` in `/etc/bojin/environment` (any other non-empty value fails startup naming `AI_PROVIDER`):

- `AI_PROVIDER=openrouter` (default when unset/empty): calls OpenRouter (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL` defaulting to `google/gemini-3.8-flash` — `google/gemini-2.5-flash` is scheduled for OpenRouter retirement on 2026-12-01; keep `OPENROUTER_MODEL=google/gemini-3.8-flash` pinned in `/etc/bojin/environment` so backup behavior and thinking limits match direct Gemini, and `OPENROUTER_BASE` locked to `https://openrouter.ai`).
- `AI_PROVIDER=gemini`: calls Google Gemini API directly via its OpenAI-compatible endpoint (`GEMINI_API_KEY`, `GEMINI_MODEL` defaulting to `gemini-3.8-flash`, `GEMINI_BASE` locked to `https://generativelanguage.googleapis.com`).
- **Origin & redirect pinning:** `GEMINI_BASE` only accepts exact HTTPS origin `https://generativelanguage.googleapis.com` and `OPENROUTER_BASE` only accepts `https://openrouter.ai` (non-matching hosts, loopback URLs, non-HTTPS URLs, credentials, or query/fragment strings always fail startup), and upstream requests set `redirect: "manual"` so credentials and payloads are never forwarded across origins.
- **Bounded retries & fallback:** Transient Gemini `5xx`/`UNAVAILABLE` and `429` responses run up to two short backoff retries (`400 ms`, `1000 ms`, skipped once 15 s have elapsed). When `OPENROUTER_API_KEY` is also set, remaining Gemini transient/quota/timeout failures (`5xx`/`UNAVAILABLE`, `429`, or network/read timeouts — never user-input `400`, permanent `401`/`402`/`403`, redirects, safety blocks, or truncation) retry once via OpenRouter within a hard 120 s total deadline (reserving 30 s for fallback; Gemini attempts cap at 90 s), counting as a single request against per-user and global daily caps.

Never print, log, or commit `GEMINI_API_KEY` or `OPENROUTER_API_KEY`. Keep `/etc/bojin/environment` owned by `root:bojin` (`0640`).

**Switch host from OpenRouter to direct Gemini API (keep OpenRouter as backup):**

1. Edit `/etc/bojin/environment` (e.g. `sudo editor /etc/bojin/environment`) to add `GEMINI_API_KEY=<AI Studio key>` and optionally pin `GEMINI_MODEL=gemini-3.8-flash` (the default), while leaving `AI_PROVIDER=openrouter` (or unset) for now. Confirm `OPENROUTER_API_KEY`, `OPENROUTER_MODEL=google/gemini-3.8-flash`, `AI_REASONING_EFFORT=low`, `AI_MAX_OUTPUT_TOKENS=2000`, and daily caps remain set.
2. **Pre-cutover direct Gemini smoke test (before flipping `AI_PROVIDER`):** Run one scripted synthetic call on the host directly against `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` exercising structured JSON (`response_format`), a verified 16×16 solid-red PNG `image_url` (checking an image-derived answer rather than a dictated literal), `reasoning_effort` (`AI_REASONING_EFFORT`), and `max_tokens` (`AI_MAX_OUTPUT_TOKENS`) without printing keys or response text:
   ```sh
   sudo -u bojin /usr/bin/node --env-file=/etc/bojin/environment -e '
   (async () => {
     const key = (process.env.GEMINI_API_KEY || "").trim();
     const model = (process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();
     const maxTokens = Number(process.env.AI_MAX_OUTPUT_TOKENS || 2000);
     const effort = (process.env.AI_REASONING_EFFORT || "").trim();
     if (!key) throw new Error("GEMINI_API_KEY is empty");
     const red16x16 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFklEQVQoz2P4z8BAEmIY1TCqYfhqAACQ+f8BV5AUGAAAAABJRU5ErkJggg==";
     const payload = {
       model,
       max_tokens: maxTokens,
       response_format: { type: "json_object" },
       ...(effort ? { reasoning_effort: effort } : {}),
       messages: [{ role: "user", content: [
         { type: "text", text: "Identify the single dominant color of the attached image from red, blue, or green. Reply ONLY with a JSON object: {\"color\":\"red|blue|green\"}" },
         { type: "image_url", image_url: { url: red16x16 } }
       ] }]
     };
     const t0 = Date.now();
     const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
       method: "POST",
       redirect: "manual",
       headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
       body: JSON.stringify(payload),
       signal: AbortSignal.timeout(30000)
     });
     const data = await res.json().catch(() => null);
     const choice = data?.choices?.[0];
     const text = choice?.message?.content;
     let parsed = null, validJson = false;
     try { parsed = JSON.parse(String(text || "")); validJson = !!parsed && typeof parsed === "object" && !Array.isArray(parsed); } catch {}
     const imageVerified = validJson && String(parsed.color || "").trim().toLowerCase() === "red";
     const u = data?.usage || {};
     const completionTokens = u.completion_tokens || 0;
     console.log(JSON.stringify({
       status: res.status,
       model,
       finish_reason: choice?.finish_reason || "error",
       valid_json: validJson,
       image_verified: imageVerified,
       prompt_tokens: u.prompt_tokens || 0,
       completion_tokens: completionTokens,
       reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0,
       ms: Date.now() - t0
     }));
     if (!res.ok || !validJson || !imageVerified || choice?.finish_reason !== "stop" || completionTokens >= maxTokens) process.exit(1);
   })().catch(e => { console.error(e.message); process.exit(1); });
   '
   ```
   Proceed only when this exits `0` with `status: 200`, `valid_json: true`, `image_verified: true`, `finish_reason: "stop"`, and `completion_tokens` well below `AI_MAX_OUTPUT_TOKENS`.
3. Set `AI_PROVIDER=gemini` in `/etc/bojin/environment` and restart the service under the maintenance lock:
   ```sh
   sudo /usr/local/sbin/bojin-maintenance-lock -- systemctl restart bojin.service
   ```
4. **Post-cutover verification:** Verify `/api/health`, startup line (`已配置 gemini/gemini-3.8-flash，备用 openrouter/google/gemini-3.8-flash`), AND trigger one authenticated synthetic `/api/ai` request (e.g., a test-account meal-with-photo estimate or swap) and confirm the resulting `journalctl` `^ai ` line shows `provider=gemini`, **no** `provider_fallback=true`, `kind=json`, `finish_reason=stop`, and `empty=false`:
   ```sh
   curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8080/api/health
   journalctl -u bojin.service -n 20 --no-pager -o cat | grep '薄肌日课已启动'
   # After running one authenticated synthetic /api/ai request:
   journalctl -u bojin.service --since -10m --no-pager -o cat | grep '^ai ' | tail -n 5
   ```

**Roll back to OpenRouter (one env edit + restart):**

1. In `/etc/bojin/environment`, change `AI_PROVIDER=gemini` to `AI_PROVIDER=openrouter` (or delete the `AI_PROVIDER` line; `GEMINI_API_KEY` may remain or be removed).
2. Restart the service under the maintenance lock:
   ```sh
   sudo /usr/local/sbin/bojin-maintenance-lock -- systemctl restart bojin.service
   ```
3. Verify `/api/health`, the startup line (`已配置 openrouter/google/gemini-3.8-flash`), and trigger one authenticated synthetic `/api/ai` request confirming `journalctl` logs `provider=openrouter` (without `provider_fallback=true`), `finish_reason=stop`, and `empty=false`.

**Check which provider is serving:**

```sh
# 1. Configured primary (and backup) at last service start
journalctl -u bojin.service -n 50 --no-pager -o cat | grep '薄肌日课已启动' | tail -n 1

# 2. Recent /api/ai calls (metadata only: provider=gemini|openrouter, optional provider_fallback=true)
journalctl -u bojin.service --since -24h --no-pager -o cat | grep '^ai '

# 3. Count calls served by each provider and fallback activations over the last 24h
journalctl -u bojin.service --since -24h --no-pager -o cat | grep '^ai ' | sed -n 's/.*provider=\([^ ]*\).*/\1/p' | sort | uniq -c
journalctl -u bojin.service --since -24h --no-pager -o cat | grep -c '^ai .*provider_fallback=true' || true
```

### External uptime monitoring

`.github/workflows/uptime.yml` watches `https://leanritual.app` from outside the Aliyun host so whole-host or network outages still alert:

- **What is checked:** `GET https://leanritual.app/api/health` (HTTP 200 with JSON `"ok":true`), `GET https://leanritual.app/login.html` (HTTP 200 with a `Content-Security-Policy` header), and TLS certificate validity (`> 14` days remaining via `openssl s_client` + `x509 -enddate`), with 15 s timeouts and 2 retries per probe.
- **Cadence:** Scheduled every 10 minutes (`*/10 * * * *`), plus manual `workflow_dispatch` (accepts an optional `target` HTTPS base URL, defaulting to `https://leanritual.app`, for safe failure/recovery testing).
- **Where alerts go:** On failure, sends one HTTPS POST to the repository secret `ALERT_URL` (the owner's ntfy topic, synced from `/etc/bojin-alert.env` without ever printing the URL) and opens a GitHub issue labelled `uptime`. While an `uptime` issue remains open, follow-up comments and ntfy alerts are rate-limited to at most once per hour. When checks pass again, the workflow comments `recovered`, closes the issue, and sends one ntfy recovery notification.
- **How to disable:** `gh workflow disable uptime.yml` (re-enable with `gh workflow enable uptime.yml`).

### Tester feedback & reading submissions

Authenticated testers can submit bugs, ideas, or general notes from **Me → Send feedback** (`我的 → 意见反馈`, `POST /api/feedback`). Intake is concurrency-bounded (max 2 in-flight globally, 1 per user) and daily rate-limited (`FEEDBACK_DAILY_LIMIT=10` per user and `FEEDBACK_GLOBAL_DAILY_LIMIT=100` globally per UTC day), checked before buffering request bodies as well as transactionally on write. Submissions are stored in `bojin.db` (`feedback` table), optional screenshots reuse `lib/uploads.js` limits and `blobs/`, and both are included in user exports and purged on account deletion (and deletion-ledger replay).

- **Owner notifications:** If `ALERT_URL` (an HTTPS ntfy topic URL, same format as `/etc/bojin-alert.env`) is set in `/etc/bojin/environment`, `server.js` sends a metadata-only plain-text HTTPS POST (redirects rejected) containing only the feedback type, feedback ID, submission timestamp, and whether a screenshot is attached — no message text, user ID, email, display name, screenshot, or device info. If `ALERT_URL` is empty or unreachable, notifications silently skip/log without failing the submission.
- **Reading feedback on the host** (read-only, respects the data-access lease):

```sh
# List the 20 most recent submissions (optional: --limit N, --type bug|idea|other, --json)
sudo -u bojin env DATA_DIR=/var/lib/bojin /usr/bin/node /opt/bojin/scripts/feedback-admin.js list --limit 20

# Inspect one submission in full (including device info and screenshot blob path)
sudo -u bojin env DATA_DIR=/var/lib/bojin /usr/bin/node /opt/bojin/scripts/feedback-admin.js show <feedback-id>
```

### AI monthly USD budget caps & admin overrides

In addition to daily request count limits (`AI_DAILY_LIMIT=60`, `AI_GLOBAL_DAILY_LIMIT=300`), `lib/ai.js` enforces UTC calendar-month estimated USD caps using the shared pricing table in `lib/ai-pricing.js`. Before every single provider dispatch (initial attempt, JSON-mode retry, Gemini transient retries, and OpenRouter fallback), the outbound payload is serialized first, an atomic conservative upper-bound reservation is persisted in SQLite for that dispatch's UTC month, and the UTC month and effective pricing rate are re-verified immediately before the network send (releasing and re-admitting if either changed). Reservations survive crashes/restarts (finalizing conservatively on expiry instead of refunding) and are replaced only by authoritative usage or confirmed non-billable HTTP rejections (`400/401/403/404/422/429` without usage).

- **Concurrency limits & remaining bounded overshoot:** AI calls are bounded to **1 in-flight call per user** and **`AI_MAX_CONCURRENT` (default `4`) in-flight calls globally**; excess concurrent requests immediately receive HTTP `429` (`ai_busy`) with a friendly zh/en "busy, try again" message without touching the provider. Every enabled route must also have a recognized model ceiling (`gemini-3.8-flash`, `google/gemini-3.8-flash`, `gemini-2.5-flash`, and `google/gemini-2.5-flash` are built in at `maxOutputTokens=65536`; custom models require `AI_MODEL_PRICES_JSON[model].maxBilledOutputTokens` / `maxOutputTokens`+thinking config or `AI_MAX_BILLED_OUTPUT_TOKENS`), and unknown routes fail closed (AI paused). Because upstream providers do not strictly guarantee `max_tokens` as a hard billing cap (e.g. small stop-boundary overruns or thinking-level conversions), an already-in-flight call can still settle above its reservation; when that happens, the full billed amount is debited immediately and all further calls are blocked until back under cap. Worst-case overshoot above a cap is therefore bounded by **in-flight calls × the largest single-call cost** (at most **1 in-flight call** for a user cap, and at most **`AI_MAX_CONCURRENT` (default `4`) in-flight calls** for the whole-app cap).
- **Per-user monthly cap (`AI_USER_MONTHLY_USD`, default `5`):** users near 80% see a gentle notice in the AI areas; users at/above their cap are refused before calling upstream with a friendly zh/en message reminding them they can still log manually.
- **Whole-app monthly budget guard (`AI_GLOBAL_MONTHLY_USD`, default `80`):** evaluates 80% and 100% independently, sends one phone alert via `ALERT_URL` at 80% and one at app-wide pause (100%) with separate pending/delivered delivery state, stable `X-Idempotency-Key` dedupe key, and bounded retries (up to 3 attempts). Alert webhook delivery runs asynchronously off the admission/dispatch path. Resets automatically on the 1st of the next UTC month.
- **Per-model pricing defaults (USD / 1M tokens; reasoning billed as output):** `gemini-3.8-flash` / `google/gemini-3.8-flash` defaults to introductory `$0.75` input / `$3.75` output through `2026-12-31 UTC` and automatically steps to standard undiscounted `$1.50` input / `$7.50` output starting `2027-01-01 UTC` (verify applicable Google AI Studio billing rates before deploying and override via `AI_MODEL_PRICES_JSON` or `AI_*_PRICE_PER_1M` if different). `OPENROUTER_MODEL` defaults to `google/gemini-3.8-flash` (`google/gemini-2.5-flash` is scheduled for OpenRouter retirement on `2026-12-01`).
- **Host rollout checklist (stage pause before auto-deploy / verify before normal use):**
  1. **Stage pause before deploy/merge if auto-deploy is enabled:** keep AI paused with `AI_GLOBAL_MONTHLY_USD=0` in `/etc/bojin/environment` until pre-rollout spend and config are verified on the installed release.
  2. **Seed pre-rollout spend for the current UTC month:** once the release is installed, check accrued Google AI Studio and OpenRouter spend for the current UTC month (and check shared Google credit separately), then seed it with `sudo -u bojin env DATA_DIR=/var/lib/bojin /usr/bin/node --env-file=/etc/bojin/environment /opt/bojin/scripts/auth-admin.js ai-seed --month "$(date -u +%Y-%m)" --usd AMOUNT` (idempotent), or use a temporary `AI_GLOBAL_MONTHLY_USD` set to verified remaining headroom.
  3. **Inspect `OPENROUTER_MODEL` in `/etc/bojin/environment`:** keep an existing `google/gemini-3.8-flash` pin, replace or remove a `google/gemini-2.5-flash` pin before OpenRouter's `2026-12-01` retirement, or leave the variable unset to default to `google/gemini-3.8-flash`.
  4. **Confirm `ALERT_URL` and provider rates:** confirm `ALERT_URL` is configured in `/etc/bojin/environment` for 80%/100% phone alerts, and verify applicable provider rates including the `2027-01-01 UTC` `$0.75/$3.75` → `$1.50/$7.50` step-up (override via `AI_MODEL_PRICES_JSON` / `AI_*_PRICE_PER_1M` if your billing tier differs).
  5. **Enable verified rollout cap, restart under maintenance lock, and verify:** set the verified rollout `AI_GLOBAL_MONTHLY_USD`, restart with `sudo /usr/local/sbin/bojin-maintenance-lock -- systemctl restart bojin.service`, and run `auth-admin.js ai-usage` against the production database to confirm seeded baseline and cap state before normal use.

```sh
# Mid-month rollout: seed already-accrued provider spend for the current UTC month (idempotent)
sudo -u bojin env DATA_DIR=/var/lib/bojin /usr/bin/node --env-file=/etc/bojin/environment /opt/bojin/scripts/auth-admin.js ai-seed --month 2026-11 --usd 18.50 --note "pre-rollout Google AI Studio spend"

# List this month's top users by AI spend (pseudonymous by default; add --show-identity on host for phone/email)
sudo -u bojin env DATA_DIR=/var/lib/bojin /usr/bin/node --env-file=/etc/bojin/environment /opt/bojin/scripts/auth-admin.js ai-usage
sudo -u bojin env DATA_DIR=/var/lib/bojin /usr/bin/node --env-file=/etc/bojin/environment /opt/bojin/scripts/auth-admin.js ai-usage --show-identity

# Inspect a user first to obtain their resolved anonId, then pass --confirm-id <anonId> to modify or reset their cap
sudo -u bojin env DATA_DIR=/var/lib/bojin /usr/bin/node --env-file=/etc/bojin/environment /opt/bojin/scripts/auth-admin.js ai-cap --phone 13800138000
sudo -u bojin env DATA_DIR=/var/lib/bojin /usr/bin/node --env-file=/etc/bojin/environment /opt/bojin/scripts/auth-admin.js ai-cap --phone 13800138000 --confirm-id <anonId> --usd 15
sudo -u bojin env DATA_DIR=/var/lib/bojin /usr/bin/node --env-file=/etc/bojin/environment /opt/bojin/scripts/auth-admin.js ai-cap --email tester@example.com --confirm-id <anonId> --reset
```

### Daily trial activity summary

`scripts/daily-summary.js` prints a read-only activity summary covering both the **last 24 hours** and **trial to date** (all records by default, or filtered with `--since <YYYY-MM-DD|ISO>` / `TRIAL_START`):

- **Metrics included:** new sign-ups and verified sign-up cohorts (`auth.sqlite`), active users (deduplicated across sessions, docs, photos, AI usage, and feedback), check-ins / workouts / meals logged (`bojin.db`), AI calls split by provider (`gemini` vs `openrouter`, distinguishing `provider_fallback=true` fallbacks and attributing pre-fallback retries back to Gemini) with observed models, prompt/completion/reasoning token totals, and estimated USD cost (labeled as final-attempt journal tokens at flat provider rates; unknown providers are left unpriced), feedback counts by type (`bug`, `idea`, `other`) plus metadata for the 3 newest entries, client error counts (`client-error` journal entries), filesystem disk usage and photo bytes, and the last completed backup/snapshot time.
- **Snapshot-only DB reads (zero live coordination):** `scripts/daily-summary.js` **never opens live SQLite databases in `DATA_DIR`** (`bojin.db` / `auth.sqlite`) and takes **no** `lib/data-access.js` lease, so it cannot block backups, delay WAL checkpoints, or mutate live `-shm`/`-wal` files. `DATA_DIR` is inspected with stat-only filesystem/directory size checks. Database counts are read strictly from a completed published backup snapshot: the script rejects any path inside `DATA_DIR` or any snapshot containing WAL sidecars, requires `manifest.json` version 1 with explicit `bojin.db` (and `auth.sqlite`, when present) size and SHA-256 entries, copies the snapshot DBs to a private `0700` temp directory, and verifies exact byte size, SHA-256 checksum, SQLite `PRAGMA quick_check = ok`, and expected core tables on the private copies before querying. During automatic discovery, an incomplete/corrupt newest snapshot is skipped in favor of the previous complete snapshot (noting the fallback); if only invalid snapshots exist or an explicit `--snapshot` fails verification, the script exits non-zero with an error instead of silently reporting zeros. When backup directories are root-only (`0710`) or empty, the script reports that no readable snapshot was found instead of falling back to live `DATA_DIR`.
- **Freshness (`data as of`):** database metrics reflect the snapshot's creation timestamp (`data as of`, up to ~24 hours behind live writes under the daily 04:00 UTC backup schedule), with database "last 24h" counts measured over the 24 hours ending at `data as of`. Journal-based AI and client error counts stay live as of run time, fetching from the earlier of `--since` and `now - 24h` so short trial windows never truncate the 24h rolling window.
- **Host permissions & staging a read-only snapshot:** on the production host, `/var/backups/bojin` is `0710 root:bojin` with `0700 root:root` snapshots. Running `daily-summary.js` directly as `bojin` without `--snapshot` reports live journal AI/error counts, live disk/photo disk bytes, and systemd backup status (`systemctl show` on `bojin-backup.service` requiring a completed, non-running `Result=success` with `ExecMainStatus=0`; `bojin-backup.timer`'s `LastTriggerUSec` is shown separately and never treated as a completed backup), and notes that no readable snapshot was found. To include database counts while keeping Node unprivileged as `bojin`, stage a temporary read-only `root:bojin` (`0750`/`0640`) copy of the newest snapshot (same non-disruptive pattern as the restore drill) and pass `--snapshot <staged-copy>`. If `bojin` cannot read the system journal directly, pipe `journalctl -u bojin.service -o short-iso --no-pager` via `--journal-file -`.
- **Privacy defaults:** never queries or outputs emails, usernames, raw user IDs, raw feedback primary keys, secrets, or meal/workout contents. Within a single report, `ref` and `user` IDs use an ephemeral per-report 256-bit HMAC key (unmatchable offline and unlinkable across reports). Feedback free text is **omitted by default** (showing only type, timestamp, character length, screenshot flag, and report-scoped pseudonyms); use `scripts/feedback-admin.js` on the host to read full messages. An explicit `--include-feedback-excerpts` opt-in adds best-effort redacted 80-char previews (redacting URLs, emails, tokens, phone numbers, long digit runs, and terminal escapes), which can still contain identifying free text such as names or addresses.
- **Configurable AI pricing (USD per 1M tokens):** defaults to `gemini-3.8-flash` rates (`$0.75` prompt / `$3.75` completion, where completion includes reasoning tokens). Override with `AI_INPUT_PRICE_PER_1M`, `AI_OUTPUT_PRICE_PER_1M`, or per-provider `AI_GEMINI_INPUT_PRICE_PER_1M`, `AI_GEMINI_OUTPUT_PRICE_PER_1M`, `AI_OPENROUTER_INPUT_PRICE_PER_1M`, `AI_OPENROUTER_OUTPUT_PRICE_PER_1M`.

```sh
# 1. Stage a read-only copy of the newest daily snapshot (same pattern as the restore drill)
SNAPSHOT=$(sudo python3 -c '
import glob, os, sys
snaps = sorted(p for p in glob.glob("/var/backups/bojin/snapshot-*")
               if not os.path.islink(p) and os.path.isdir(p) and os.path.isfile(os.path.join(p, "manifest.json")))
if not snaps: sys.exit("No valid snapshot found")
print(snaps[-1])
')
STAGE="/var/tmp/summary-stage-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -o root -g bojin -m 0750 "$STAGE"
sudo cp -rP -- "$SNAPSHOT" "$STAGE/snapshot"
sudo chown -RP root:bojin -- "$STAGE/snapshot"
sudo find "$STAGE/snapshot" -type d -exec chmod 0750 -- {} +
sudo find "$STAGE/snapshot" -type f -exec chmod 0640 -- {} +

# 2. Run the summary as the unprivileged service user (plain text or --json; pipe journalctl if needed)
journalctl -u bojin.service -o short-iso --no-pager \
  | sudo -u bojin env DATA_DIR=/var/lib/bojin /usr/bin/node /opt/bojin/scripts/daily-summary.js \
      --snapshot "$STAGE/snapshot" --journal-file -

# JSON output + optional trial start filter and price overrides
journalctl -u bojin.service -o short-iso --no-pager \
  | sudo -u bojin env DATA_DIR=/var/lib/bojin TRIAL_START=2026-11-18 \
      AI_INPUT_PRICE_PER_1M=0.75 AI_OUTPUT_PRICE_PER_1M=3.75 \
      /usr/bin/node /opt/bojin/scripts/daily-summary.js \
      --snapshot "$STAGE/snapshot" --journal-file - --json

# 3. Clean up the exact staging directory path
sudo rm -rf -- "$STAGE"
```

## Local evidence

Tests cover writer exclusion, checksums, refusing overwrites, snapshots with both databases/photos, pre-auth migration and rollback, and replaying a newer deletion ledger onto an older snapshot. These tests do not replace a restore drill and offsite access verification on the purchased host.

文档保护：`DOC_USER_BYTES` 默认 52428800（50 MiB，按 UTF-8 字节计算），`DOC_USER_COUNT` 默认 20000；覆盖按新旧大小差计算，删除释放额度。超过额度返回 413 / `doc_quota`。`DOC_WRITE_PER_MIN` 默认 240，每账号固定 60 秒窗口限制写入（含删除与失败尝试），超限返回 429 和 `Retry-After`；读取不限流，重启清空窗口。配置均须为正整数。默认值为日常记录保留充足空间，同时限制单账号滥用。

超额账号可覆盖为不增加字节数的现有文档，以便删减内容恢复额度；`node server.js import` 同样执行文档额度检查。客户端对 429 最多重试两次，遵循 `Retry-After`（1–65 秒，缺省 5 秒）；413 立即提示错误并保留待保存输入。

Deploys reject an intentionally stopped service unless authorized once via
`sudo install -m 0600 -o root -g root /dev/null /etc/bojin/allow-deploy-when-stopped`; the deploy consumes this authorization under the maintenance lock.
Backup and deploy require free space greater than `new_snapshot_bytes + 1.5 GiB` before stopping the app (accounting for hardlink-deduplicated photo blobs on the same filesystem, falling back to full `size(DATA_DIR) + 1.5 GiB` before dedup-capable code is live). Watchdog, backup, and deploy all alert via `ALERT_URL` (`/usr/local/libexec/bojin-alert`) before disk usage passes 80% (with immediate critical escalation at 90%). Backup releases the maintenance lock before bounded offsite rsync.
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
