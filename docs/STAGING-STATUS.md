# Live acceptance — November 5, 2026 (America/Los_Angeles)

当前部署与运维的统一入口：[部署与运维总手册](DEPLOYMENT-HANDBOOK.zh-CN.md)，包含另一 Agent 的交接整合、已验证部署证据及需要核对的冲突。此前的未部署/未合并状态属于历史记录，以总手册的证据日期为准。

## Source and connectivity

The new environment reports observations-current, enforced unrestricted HTTP.
Initial curl attempts lacked the tool's sandbox network grant and could not
connect to the configured proxy. With the supported network grant, both
`https://example.com` and `https://leanritual.app/login.html` returned 200 with
TLS verification enabled. The configured proxy was preserved throughout.

The carried-over checkout and GitHub main contain only initial commit `b14c1da`.
Jay supplied `lean-ritual-release.tar.gz`; its SHA-256 matches
`cf7ab52e6309bf04913b4033932b11397f1cff2446704ab7646de6ad4c8c7c51`.
The archive's login, privacy and shim bytes exactly match the deployed public
responses. This does not prove every server file matches or establish private
host configuration. Source was recovered separately before preparing a GitHub PR.

## Anonymous production checks

`python3 scripts/check-public-deployment.py https://leanritual.app`
performed anonymous GET requests only: **12/13 passed**. There were no emails,
registrations, record writes, AI calls or account deletions.

Passed: HTTP 308 to canonical HTTPS; root/index redirect to login; standard
invitation/recovery UI; health; invitation config with AI off; privacy operator and
contact; nosniff/frame/referrer headers; 401 private record/export guards;
anonymous session null; retired `/api/register` returns 410; standalone shim.
These checks do not exercise signup invitation enforcement or authenticated
cross-account access. An early probe used `/api/signup` and `/api/export`, which
are not the implemented routes; their 401 responses were excluded as route evidence.

Finding: the deployed privacy page still says the selected host has not been
deployed and omits Resend. This PR corrects those known facts while preserving
draft status and unconfirmed provider/backup details. It is not yet deployed.

## Remaining gates

- Actual service/environment/file permissions and deployed revision inventory.
- Disposable invitation, real verification/reset delivery, persistence, uploads,
  authenticated export/deletion, session invalidation and account isolation.
- Offsite backup destination, confirmed local/remote retention, independently
  recoverable latest deletion ledger and an actual-host restore drill.
- AI provider/model eligibility, funded spending controls and budgeted smoke test.
  AI remains off and does not block manual workflow acceptance.
- Mainland no-VPN carrier, QQ/163 and physical iPhone testing.
- Final privacy review and Jay's beta launch decision.

GitHub auto-deploy setup and activation are documented in GITHUB-DEPLOYMENT.md.
No remote host, DNS, firewall, backup timer or data was changed during these checks.

## Continuation — November 5, 2026 (Pacific)

The current production anonymous checker passes all 13 checks, including corrected
hosting/email disclosure. Public health and these anonymous checks do not verify
an authenticated user's data loading. A reported loading failure remains under
investigation; no server or affected-session access is available in this environment.

Local mobile Chromium passes invitation signup, file-email verification, profile
and manual-record persistence, OCR, mock AI, password change, export and deletion.
A new injected profile-read failure test verifies that the UI blocks onboarding
and that reloading after recovery restores the existing profile and meal. This is
a safety/recovery fix, not evidence that the production failure's cause is resolved.

Remaining user-owned inputs: AI provider/model and spending limit; offsite backup
location and retention decisions; representative mainland/device testers. Server
access is still needed to inspect actual backup units, runtime/helper differences
and the reported data-read failure. Actual SMTP/reset delivery and real-host
restore acceptance must be recorded before beta. Rotate any credential posted in
chat through the provider's secure credential controls; never put replacements in
this repository or issue comments.
