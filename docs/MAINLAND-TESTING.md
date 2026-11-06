# Mainland invitation-beta acceptance checklist

Run after staging deployment with disposable accounts and non-sensitive photos. Jay coordinates testers; Codex diagnoses failures. No VPN, proxy acceleration or corporate tunnel during a mainland test. Also collect one overseas control result.

## Coverage and result format

Cover China Mobile, China Unicom and China Telecom where available, once in local evening peak and once off-peak. Include an actual iPhone with a HEIC photo, Android, and desktop browser. Record missing coverage explicitly.

| Date/time + timezone | City | Carrier / Wi-Fi or cellular | Device/browser | DNS-only or proxied | Step | Pass/fail | Elapsed seconds / error |
| --- | --- | --- | --- | --- | --- | --- | --- |

Do not record invitation/reset tokens, passwords, private IP addresses, health records or personal photos. Redact query strings and account details in screenshots. Measure from the user's action until usable content appears; report repeated timeout/failure patterns rather than one successful page load.

## Each tester

1. Open the canonical HTTPS hostname in a fresh/private browser. Confirm no certificate warning and that the login page finishes loading.
2. Open your private invitation, sign up, and receive verification email. Check QQ/163 and an international inbox across the group; record arrival time and whether it landed in spam. A second use of the same invitation must not create another account.
3. Verify, sign in, create a manual meal, reload, and confirm it persists. No Claude account, Claude subscription or personal provider key should be requested.
4. Upload a non-sensitive food photo; on an iPhone use an actual HEIC image. Test local nutrition-label OCR, then one agreed AI request after the operator enables the provider budget. Record each result separately.
5. Sign out, request password reset, receive the email and reset the password. Confirm the old password fails and the new one works.
6. Download the account export and verify your disposable entries/photos. Delete the disposable account using its password; old sessions must no longer access its records. Do not delete an account holding real data for this test.

## Diagnose and decide

For failures, capture the failed step, timestamp, carrier and visible error first. Codex checks DNS/HTTPS and server logs using that timestamp. Separate route failure, email delay and AI-provider failure; a successful homepage does not establish usable recovery or uploads. Retest fixes on the affected network. Compare DNS-only and proxy mode in controlled test windows with recorded DNS propagation; don't change both hosting and proxy at once.

Beta release requires core flows to work on representative mainland networks, delivery/recovery results, and explicitly accepted remaining coverage gaps. No mainland result is claimed from cloud-container or overseas browser tests.
