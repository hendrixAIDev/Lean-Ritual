# Implementation checkpoint — November 5, 2026 (UTC)

Current continuation: see STAGING-STATUS.md for verified public-site checks and
GITHUB-DEPLOYMENT.md for the proposed GitHub Actions deployment. The source below
was recovered from Jay's matching release archive; its login/privacy/shim match
the live site. The historical local checkpoint does not describe current host access.

Resume here. Source changes are saved in this workspace. No production deployment, real user migration, external email or paid AI call has been performed. Tests use disposable data.

## Implemented locally

- LEA-5/8/9/10: baseline, Better Auth verified email/password and recovery, atomic single-use invitations with explicit legacy-ID mapping, independent client/backend AI and account-scoped browser storage. Users need no Claude account, subscription or API key.
- LEA-11: disposable legacy migration and rollback rehearsal preserves identity, records and photos. Actual migration remains part of deployment.
- LEA-12: offline snapshots of both SQLite databases and referenced photos, integrity checks, shared/exclusive maintenance leases, empty-directory restore and mandatory latest deletion ledger. Docker image, service/timer examples and operations runbook provided. Offsite destination, retention and real host drill still required.
- LEA-13: streaming account export, password-confirmed account deletion, durable interrupted-cleanup recovery, and deletion replay when restoring older backups. Privacy draft uses 杰瑞智能技术服务部 and hendrix.ai.dev@gmail.com. Hosting region/providers and backup retention still need confirmation; proposed 30 days has not been activated or promised as a configured policy.
- LEA-15 preparation: decoded/re-encoded images with metadata stripping, pixel/concurrency/storage/daily limits; failed-write cleanup. Independent recovery/privacy review found a partial-file cleanup issue on disk-full errors; fixed with a regression test. Staging review remains open.

## Verification

- November 5: `node --test --test-reporter=dot tests/*.test.js`: 22 passing tests, including expired email verification, reset expiry/replay, invitation transactions, real HTTP account isolation/export/deletion, migration rollback, snapshot integrity, deletion replay, upload quotas and disk-full cleanup.
- Previous session: mobile Chromium smoke passed signup, verification, login, manual recording/reload, real local OCR, upload with mock AI, password change, export and deletion. Real HEIC fixture converted successfully; zero external browser requests/page errors. Physical iPhone and mainland carrier tests remain outstanding.
- Previous session: Docker non-root runtime, volume persistence across restart, maintenance leases and backup/restore passed. November 5: current image rebuild passed; fresh container confirms UID 1000, exclusion of private source/data files, sharp loading and HTTP health.
- Previous session: production dependency audit reported zero vulnerabilities. This is a point-in-time result.
- All existing user data was left untouched. Expected SQLite trigger failure logging is a successful negative test.

## Next deployment gates and Jay-owned inputs

1. LEA-6: Jay has provisioned Aliyun US West (Silicon Valley), Ubuntu 24.04, 2 vCPU / 2 GiB / 40 GiB. Domain purchase via Cloudflare is planned; hostname and scoped deployment access remain pending. See ALIYUN-DEPLOYMENT.md.
2. LEA-7: AI provider/model permitted for intended users, billing controls, SMTP credentials and verified sender domain. Store credentials in secret configuration, never chat or Linear.
3. LEA-12/13: private offsite backup destination, confirmed retention with actual local/remote pruning, actual provider/region privacy disclosures. Activate timer and verify offsite restoration on the chosen host.
4. LEA-14/15: deploy staging, test real email/provider integration and review the deployed configuration.
5. LEA-16: mainland Mobile/Unicom/Telecom testing without VPN, QQ/163 email and physical iPhone testing.
6. LEA-17: reviewed invitation beta release. Local tests do not establish mainland availability.

Read docs/OPERATIONS.md before backup, restore or release. No automated retention pruning is currently configured. Latest deletion ledger must survive independently of an old backup so restored data does not resurrect deleted accounts.

## Coordination and budget

Authentication implementation and independent recovery/privacy review already completed in parallel. Do not repeat these tasks just because usage refreshed. Spend the next session on the concrete deployment gates above; use narrowly scoped delegation when new independent work becomes available.

## Hosting update — November 4, 2026 (America/Los_Angeles)

US West replaces the original Hong Kong assumption. README and privacy draft now reflect the selected, not-yet-deployed region. ALIYUN-DEPLOYMENT.md provides DNS-only/Caddy setup and host handoff; MAINLAND-TESTING.md provides the tester matrix. No remote server changes or DNS purchases were performed.
