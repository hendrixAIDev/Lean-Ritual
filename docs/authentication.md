# Invitation authentication

Authentication uses pinned Better Auth 1.7.15 and its maintained native `node:sqlite` adapter. Node 22.16+ is required (the adapter uses `StatementSync.columns()`); the deployment image uses Node 24. Authentication lives in `DATA_DIR/auth.sqlite`; app documents and photos keep their original IDs and database.

The server calls `await createAuth({ dataDir, baseURL, secret, cookieSecure, sendEmail, clientIP })` from `lib/auth.js`. Route `/api/auth/*` to `service.handle(req,res)` before the app's custom CSRF header check. Better Auth performs its own origin/CSRF checks. Other routes await `service.sessionUser(req)`, which returns only verified users as `{id,username,email,created,mustChange:false}`. `clientIP` must derive from the socket or a deliberately trusted reverse proxy; the handler overwrites its private rate-limit header.

Set `AUTH_BASE_URL` to the canonical HTTPS origin and a persistent random `AUTH_SECRET` of at least 32 characters. Public origins require secure cookies. Set `MAIL_MODE=smtp`, `SMTP_HOST`, `SMTP_PORT` (587 by default), `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM`. `createMailer(env,{dataDir,baseURL})` in `lib/mail.js` provides the sender. SMTP requires TLS and certificate verification. Local development can explicitly set `MAIL_MODE=file` with a localhost origin; messages go to private files under `DATA_DIR/mail`. File delivery is rejected for public origins.

Issue a seven-day, single-use, email-bound invitation:

```sh
node scripts/auth-admin.js invite person@example.com
```

The command prints a secret token; deliver it privately to that email. The login page accepts `?invite=TOKEN&email=EMAIL`, or recipients can paste the token. It is not a permanent shared signup code. Revoke a token by passing it on stdin to `node scripts/auth-admin.js revoke`. Expired or revoked invitations can be replaced with a new invitation.

To retain an existing user's app data, the operator must explicitly associate the verified email with the existing username:

```sh
node scripts/auth-admin.js invite person@example.com --legacy-user existing_username
```

This preserves the existing `u_...` ID. It does not copy passwords, accept old cookies, or infer email ownership. The user chooses a new password and verifies the invited email. Back up both databases and blobs before migration; do not issue a fresh unrelated ID to an existing account that needs its data.

The invitation claim runs inside Better Auth's signup transaction on the same connection. Failure creating the account rolls back the invitation. A database INSERT trigger also guards alternate user creation paths. Concurrent signup produces one account. Better Auth intentionally catches mail delivery failures: an account remains unverified and its invitation remains consumed. Users can resend verification from the login page; monitor server delivery errors. Email changes and public alternate identity providers are unavailable.

Passwords require 12–200 characters. Verification expires in one hour. Password reset uses Better Auth's single-use token and revokes all existing sessions; the user must sign in again. Session checks query the database without cookie caching. Changing a password from the app should pass `revokeOtherSessions:true` to `/api/auth/change-password`; logout uses `/api/auth/sign-out`.

`npm test` includes verified login, password reset/replay/revocation, invitation mismatch/reuse/expiry/revocation, concurrent signup, failed-account rollback, and internal creation bypass checks. SMTP configuration is validated locally; sending through a real provider requires deployment credentials and has not been performed here.

Account deletion requires the current password. The server wires `onDeleteRequested` and `onDeleteCompleted` callbacks into `createAuth`: a durable deletion job blocks app-data access before credentials are removed, then purges records and photos. Interrupted cleanup resumes at startup and periodically. Backup restoration requires the latest deletion ledger; see [operations](OPERATIONS.md).
