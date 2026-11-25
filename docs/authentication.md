# Invitation authentication

Authentication uses pinned Better Auth 1.7.15 and its maintained native `node:sqlite` adapter. Local development requires Node >=22.16 (the adapter uses `StatementSync.columns()`). Production and auto-deploy require Node 24 on Linux x64; the package minimum is not the deployment requirement. Authentication lives in `DATA_DIR/auth.sqlite`; app documents and photos keep their original IDs and database.

The server calls `await createAuth({ dataDir, baseURL, secret, cookieSecure, sendEmail, clientIP })` from `lib/auth.js`. Route `/api/auth/*` to `service.handle(req,res)` before the app's custom CSRF header check. Better Auth performs its own origin/CSRF checks. Other routes await `service.sessionUser(req)`, which returns only verified users as `{id,username,email,created,mustChange:false}`. `clientIP` must derive from the socket or a deliberately trusted reverse proxy; the handler overwrites its private rate-limit header.

Set `AUTH_BASE_URL` to the canonical HTTPS origin and a persistent random `AUTH_SECRET` of at least 32 characters. Public origins require secure cookies. Set `MAIL_MODE=smtp`, `SMTP_HOST`, `SMTP_PORT` (587 by default), `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` (optional single-mailbox `MAIL_REPLY_TO` defaults to `hendrix.ai.dev@gmail.com`; malformed values log a startup warning and fall back to the default). `createMailer(env,{dataDir,baseURL})` in `lib/mail.js` provides the sender, validating each action URL against the configured `AUTH_BASE_URL` origin before rendering `multipart/alternative` (plain text + HTML) with a domain `Message-ID`, metadata-only delivery logs (type, recipient domain, locally generated messageId, and SMTP response code; never addresses, tokens, or URLs), and sanitized errors on failure. SMTP requires TLS and certificate verification. Local development can explicitly set `MAIL_MODE=file` with a localhost origin; messages go to private files under `DATA_DIR/mail`. File delivery is rejected for public origins.

Issue a seven-day, single-use, email- or phone-bound invitation:

```sh
node scripts/auth-admin.js invite person@example.com
node scripts/auth-admin.js invite --phone +8613800138000
node scripts/auth-admin.js invite --phone 13800138000
```

Phone numbers are normalized to E.164 (11-digit mainland China mobile numbers default to `+86`). The command prints a secret token (and full invite URL when `AUTH_BASE_URL` is set); deliver it privately to the invited recipient. The login page accepts `?invite=TOKEN&email=EMAIL` or `?invite=TOKEN&phone=PHONE`, or recipients can paste the token. It is not a permanent shared signup code. Revoke a token by passing it on stdin to `node scripts/auth-admin.js revoke`. Expired or revoked invitations can be replaced with a new invitation.

Phone accounts do not use email verification or self-service password reset (SMS verification is planned for later). To issue a single-use password reset link (valid for 24 hours; never sets or prints a password) for a phone account:

```sh
node scripts/auth-admin.js reset-password --phone +8613800138000
```

#### Phone password recovery verification procedure (mandatory)

Because SMS ownership verification is not enabled yet and the reset link is a bearer credential that replaces the password and revokes all active sessions, operators **must** authenticate every phone recovery request out-of-band before issuing or delivering a link:

1. **Verify requester identity out-of-band**: Knowing the registered phone number or sending a message from an unfamiliar/new chat account is **never** sufficient proof of identity. Before running `reset-password --phone`, confirm the requester is the original invitee via an independently established channel:
   - Place a **voice callback directly to the registered phone number** and confirm with the account holder that they requested the reset, **or**
   - Confirm **in person or via a previously established private channel with the original inviter** who personally knows the invitee and vouches for the request.
2. **Delivery channel**: Send the one-time reset link **only** through a pre-established, trusted private channel directly to the verified invitee (e.g., their existing known WeChat/messaging conversation with the inviter, or handed directly in person). Never deliver a reset link to an unfamiliar/unverified account, a group chat, or an unverified third party, and remind the user never to forward the link.
3. **When to deny recovery**: Refuse the request (do not issue a link, and do not share one if already generated) whenever out-of-band verification fails—for example, if the registered number cannot be reached or the speaker is not recognized, the original inviter cannot confirm the request, the requester asks for delivery to a new/unverified account, or there is any doubt about ownership or coercion.

To retain an existing user's app data, the operator must explicitly associate the verified email with the existing username:

```sh
node scripts/auth-admin.js invite person@example.com --legacy-user existing_username
```

This preserves the existing `u_...` ID. It does not copy passwords, accept old cookies, or infer email ownership. The user chooses a new password and verifies the invited email. Back up both databases and blobs before migration; do not issue a fresh unrelated ID to an existing account that needs its data.

The invitation claim runs inside Better Auth's signup transaction on the same connection. Failure creating the account rolls back the invitation. A database INSERT trigger also guards alternate user creation paths. Concurrent signup produces one account. Better Auth intentionally catches mail delivery failures: an account remains unverified and its invitation remains consumed. Users can resend verification from the login page; monitor server delivery errors. Email changes and public alternate identity providers are unavailable.

Passwords require 8–200 characters. Verification expires in one hour. Password reset uses Better Auth's single-use token and revokes all existing sessions; the user must sign in again. Session checks query the database without cookie caching. Changing a password from the app should pass `revokeOtherSessions:true` to `/api/auth/change-password`; logout uses `/api/auth/sign-out`.

`npm test` includes verified login, password reset/replay/revocation, invitation mismatch/reuse/expiry/revocation, concurrent signup, failed-account rollback, and internal creation bypass checks. SMTP configuration is validated locally; sending through a real provider requires deployment credentials and has not been performed here.

Account deletion requires the current password. The server wires `onDeleteRequested` and `onDeleteCompleted` callbacks into `createAuth`: a durable deletion job blocks app-data access before credentials are removed, then purges records and photos. Interrupted cleanup resumes at startup and periodically. Backup restoration requires the latest deletion ledger; see [operations](OPERATIONS.md).
