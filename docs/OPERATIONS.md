# Operations and recovery

当前部署与运维的统一入口：[部署与运维总手册](DEPLOYMENT-HANDBOOK.zh-CN.md)，包含另一 Agent 的交接整合、已验证部署证据及需要核对的冲突。此前的未部署/未合并状态属于历史记录，以总手册的证据日期为准。

For the current live-site evidence see STAGING-STATUS.md. GitHub auto-deployment
and its one-time server changes are documented in GITHUB-DEPLOYMENT.md. Install
the backup wrapper as `/usr/local/libexec/bojin-backup`, owned by root, rather than
executing a root service script from the replaceable application directory.

These commands are prepared, not deployed. Run as the configured service user unless a command uses systemctl. Node 24 is recommended. Protect DATA_DIR and all backup destinations with owner-only permissions. Docker runs as the unprivileged node user; bind mounts must be writable by that UID. Never expose port 8080 outside a trusted proxy when TRUST_PROXY=1. Keep the previous release's source/image and configuration separately from database snapshots.

## Consistent backup

Every supported data-writing entry point (server.js and auth-admin.js) holds a shared filesystem lease. Backup takes an exclusive lease and refuses if any writer is running. It does not pretend that independently copying SQLite files and photos during writes is consistent. The current single-server beta uses a short maintenance window.

1. Stop the service and finish admin commands. Do not edit the databases with external tools during backup.
2. With DATA_DIR set, run `node scripts/data-backup.js backup /private/backups/NEW-SNAPSHOT`.
3. Run `node scripts/data-backup.js ledger /private/backups/NEW-deletions.json` to preserve the latest deletion requests.
4. Restart the service, then copy both the snapshot directory and deletion ledger to private off-server storage over authenticated encrypted transport. Verify the copy using `node scripts/data-backup.js verify SNAPSHOT`.

The snapshot includes bojin.db, auth.sqlite if present, and every photo referenced by bojin.db. SQLite's backup API captures database state including WAL. SHA-256 and SQLite integrity checks detect incomplete/corrupt copies. Unreferenced orphan files, transient development emails, secrets and application source are intentionally excluded. Archive AUTH_SECRET and the deployment environment separately in secure credential storage; do not put them in the snapshot manifest.

`ops/backup-service.sh` and systemd service/timer provide the Ubuntu implementation. Configure `/etc/bojin-backup.env`, the SSH key/host verification and dedicated offsite destination first. The script restarts an initially running app even on backup failure, and restarts it before transferring files offsite. Install/enable the timer only after a manual backup and restore drill succeeds on the actual host. A failed rsync makes the backup service fail; inspect/alert on that failure. A local snapshot alone is not disaster recovery.

No backup is pruned automatically yet. Before accepting real users, Jay must confirm a retention period (30 days proposed), configure it for local AND remote copies, and verify expiration. This remains a deployment gate; the privacy draft must not claim backups expire before the storage policy is active. Keep the latest deletion ledger at least until every older data backup has expired. It contains random user IDs and deletion timestamps, not passwords or health records. Replicate it after deletion activity, not only on the daily backup schedule if a shorter deletion recovery window is required.

## Restore and rollback

Never restore over the live directory. Stop all writers, preserve the current directory for investigation, then restore into a new empty path:

```sh
node scripts/data-backup.js restore /private/backups/SNAPSHOT /var/lib/bojin-restored --deletions /private/backups/LATEST-deletions.json
```

The latest deletion ledger is mandatory, even if it contains no requests. Do not use the ledger from the old snapshot when a newer one exists. Restore replays the ledger so deleted accounts, records, photos and credentials are not resurrected. If the newest ledger was lost, do not reopen restored accounts until deletion requests have been reconciled. Snapshot checksums protect against accidents, not a malicious actor who can replace both files and manifest.

Reapply the recorded application release and environment, point DATA_DIR at the restored path, and test login, account isolation and a photo on a non-public staging listener before switching traffic. Verify /api/health, error logs, SMTP delivery and AI configuration. A pre-auth snapshot may have no auth.sqlite: it is a rollback to the legacy release, not a reason to expose legacy unrestricted signup. Keep legacy rollback isolated until its access controls are reviewed.

## Interrupted processes and leases

Normal SIGTERM/SIGINT shutdown releases leases. A kill/crash can leave a file under `DATA_DIR/.access/readers/`, or an empty `.access/writer` directory. Leases deliberately do not guess whether PIDs in another container are alive. If backup refuses after a crash: stop EVERY app/admin/backup process using that data volume, check service/container state, then remove the confirmed stale lease files/directory. Never remove a lease while its process might still be writing. Restart the service and repeat the drill.

## Monitoring and account operations

- Configure external HTTPS uptime checks for `/api/health`, plus alerts for service restarts, disk capacity, backup age/offsite-copy failure and provider spending. Docker has an internal healthcheck; it does not prove mainland reachability.
- Authentication failures and provider outages must not include passwords, keys, email links or record contents in logs. Do not turn on request-body logging. Backup/data paths are private.
- Issue/revoke invitations using scripts/auth-admin.js. Preserve legacy IDs with --legacy-user; verify the mapping with the owner first. After migrating, repeat the import only if needed; it fills missing records rather than overwriting.
- Account deletion queues cleanup durably before deleting credentials. Files/records are removed after auth deletion, and interrupted cleanup retries at startup/every minute. If auth deletion itself failed, access stays blocked; the user can retry the authenticated /api/auth/delete-user endpoint with their password. Investigate repeated cleanup errors before launch.

## Local evidence

Tests cover writer exclusion, checksums, refusing overwrites, snapshots with both databases/photos, pre-auth migration and rollback, and replaying a newer deletion ledger onto an older snapshot. These tests do not replace a restore drill and offsite access verification on the purchased host.
