# Operations and recovery

当前部署与运维的统一入口：[部署与运维总手册](DEPLOYMENT-HANDBOOK.zh-CN.md)，包含另一 Agent 的交接整合、已验证部署证据及需要核对的冲突。此前的未部署/未合并状态属于历史记录，以总手册的证据日期为准。

For the current live-site evidence see STAGING-STATUS.md. GitHub auto-deployment
and its one-time server changes are documented in GITHUB-DEPLOYMENT.md. Install
the backup wrapper as `/usr/local/libexec/bojin-backup`, owned by root, rather than
executing a root service script from the replaceable application directory.

These commands are prepared, not deployed. Run as the configured service user unless a command uses systemctl. Node 24 is recommended. Protect DATA_DIR and all backup destinations with owner-only permissions. Docker runs as the unprivileged node user; bind mounts must be writable by that UID. Never expose port 8080 outside a trusted proxy when TRUST_PROXY=1. Keep the previous release's source/image and configuration separately from database snapshots.

## Consistent backup

Every supported data-writing entry point (server.js and auth-admin.js) holds a shared filesystem lease. Backup takes an exclusive lease and refuses if any writer is running. It does not pretend that independently copying SQLite files and photos during writes is consistent. The current single-server beta uses a short maintenance window.

1. Coordinate under the root-owned maintenance lock (`sudo flock /run/bojin/maintenance.lock ...`), stop the service, and finish admin commands. Never run `flock` without `sudo` or against world-writable `/run/lock`. Do not edit the databases with external tools during backup.
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

Upgrade the receiver and `systemd-tmpfiles` directory rule together under the maintenance lock:
`sudo install -d -o root -g root -m 0755 /etc/tmpfiles.d && sudo install -o root -g root -m 0644 ops/bojin-tmpfiles.conf /etc/tmpfiles.d/bojin.conf && sudo systemd-tmpfiles --create /etc/tmpfiles.d/bojin.conf && sudo flock /run/bojin/maintenance.lock install -o root -g root -m 0755 ops/deploy-release.py /usr/local/sbin/lean-ritual-deploy`
(during the one-release upgrade from `/run/lock/bojin-maintenance.lock`, chain `flock /run/lock/bojin-maintenance.lock` after `/run/bojin/maintenance.lock` when replacing host helpers; `ops/install-auto-deploy.py` also installs `/etc/tmpfiles.d/bojin.conf`).
Install from a trusted checkout as root with `sudo bash ops/install-backup.sh` (which also installs `/etc/tmpfiles.d/bojin.conf` and ensures `/run/bojin` is `0755 root:root`).
This preserves existing environment configuration, disables the old local timer,
and enables the single daily bojin-backup.timer without restarting the app.
Verify with `systemctl list-timers bojin-backup.timer` and
`journalctl -u bojin-backup.service`. Run a manual backup and restore drill.
An empty OFFSITE_DEST logs "offsite disabled"; configured rsync retains bounded
timeouts and failures fail the unit. Offsite backup remains a known gap:
loss of the host can lose all server data.

### Shared maintenance lock (`/run/bojin/maintenance.lock`) and transition removal

Deploys (`/usr/local/sbin/lean-ritual-deploy`), scheduled backups (`/usr/local/libexec/bojin-backup`), the health watchdog (`/usr/local/libexec/bojin-watchdog`), and manual host maintenance coordinate through `/run/bojin/maintenance.lock` inside `root:root` `0755` `/run/bojin` (recreated across reboots via `/etc/tmpfiles.d/bojin.conf` from `ops/bojin-tmpfiles.conf`, and created defensively with `install -d -o root -g root -m 0755 /run/bojin` if missing). Every root helper refuses to use the lock if `/run/bojin` or `/run/bojin/maintenance.lock` is a symlink or not root-owned. Manual maintenance (including helper replacement, manual rollback, and data restore staging) must always use `sudo flock /run/bojin/maintenance.lock ...`.

For one transition release, each updated root script acquires `/run/bojin/maintenance.lock` first and then `/run/lock/bojin-maintenance.lock` (using the same blocking or non-blocking mode) so an un-upgraded helper cannot overlap an upgraded one; if opening `/run/lock/bojin-maintenance.lock` fails specifically with `EACCES` under Ubuntu 24.04 `fs.protected_regular=2`, the script logs a warning and continues holding `/run/bojin/maintenance.lock`. Legacy `/run/lock/bojin-maintenance.lock` compatibility can be removed in the next release once `/etc/tmpfiles.d/bojin.conf`, `/usr/local/sbin/lean-ritual-deploy`, `/usr/local/libexec/bojin-backup`, and `/usr/local/libexec/bojin-watchdog` are all upgraded and hash-verified on the production host, operators exclusively use `sudo flock /run/bojin/maintenance.lock ...`, and any leftover `/run/lock/bojin-maintenance.lock` file has been removed (`sudo rm -f /run/lock/bojin-maintenance.lock`).

## Restore and rollback

Never restore over the live directory. Under `sudo flock /run/bojin/maintenance.lock ...`, stop all writers, preserve the current directory for investigation, then restore into a new empty path:

```sh
node scripts/data-backup.js restore /private/backups/SNAPSHOT /var/lib/bojin-restored --deletions /private/backups/LATEST-deletions.json
```

The latest deletion ledger is mandatory, even if it contains no requests. Do not use the ledger from the old snapshot when a newer one exists. Restore replays the ledger so deleted accounts, records, photos and credentials are not resurrected. If the newest ledger was lost, do not reopen restored accounts until deletion requests have been reconciled. Because published local snapshots and ledgers are owned `root:root` (`0700`/`0600`), copy the selected snapshot and latest ledger as root into a temporary `root:bojin` staging directory (`0750` dirs, `0640` files) and create an empty `bojin:bojin` (`0700`) target directory before running `data-backup.js` via `runuser -u bojin`, then delete the staging copy afterward without altering `/var/backups` ownership. Snapshot checksums protect against accidents, not a malicious actor who can replace both files and manifest.

Reapply the recorded application release and environment, point DATA_DIR at the restored path, and test login, account isolation and a photo on a non-public staging listener before switching traffic. Verify /api/health, error logs, SMTP delivery and AI configuration. A pre-auth snapshot may have no auth.sqlite: it is a rollback to the legacy release, not a reason to expose legacy unrestricted signup. Keep legacy rollback isolated until its access controls are reviewed.

## Interrupted processes and leases

Normal SIGTERM/SIGINT shutdown and uncaught-exception exits release leases. A SIGKILL/OOM kill can leave a file under `DATA_DIR/.access/readers/`, or a `.access/writer` directory. Leases record hostname, kernel boot ID, PID namespace and process start time; backup and app start remove a leftover only when it provably belongs to a dead process on this same kernel (or a previous boot of this host). Leases from another container/host, or in the older format without that evidence, still fail closed. If backup still refuses after a crash: stop EVERY app/admin/backup process using that data volume, check service/container state, then remove the confirmed stale lease files/directory. Never remove a lease while its process might still be writing. Restart the service and repeat the drill.

## Monitoring and account operations

- Configure external HTTPS uptime checks for `/api/health`, plus alerts for service restarts, disk capacity, backup age/offsite-copy failure and provider spending. Docker has an internal healthcheck; it does not prove mainland reachability.
- Authentication failures and provider outages must not include passwords, keys, email links or record contents in logs. Do not turn on request-body logging. Backup/data paths are private.
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
