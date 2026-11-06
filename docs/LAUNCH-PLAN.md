# Invitation-only public launch

Linear project: https://linear.app/lean-ritual/project/invitation-only-public-launch-5cdc7d1f391a

Current implementation and remaining release gates: [checkpoint](CHECKPOINT.md). Local completion does not imply deployed readiness.

## Baseline verified 2026-11-03 (LEA-5)

Plain CommonJS Node server, node:sqlite WAL database, private blobs on disk, static HTML with build-time shim. Existing account code used custom scrypt hashes, sessions and shared invitation code; there was no email verification/recovery. Default signup was unrestricted when the invitation code was blank. Existing IDs are part of document paths and photo ownership and must be preserved.

Disposable HTTP baseline passed: two accounts can login, own-document write works, cross-account read returns 403, authenticated standalone HTML loads, and an unconfigured AI provider returns 503 without preventing record storage. Existing data directory was not opened, migrated or modified by these tests. Default sandbox prevents subprocess execution (spawnSync can return EPERM with status 0); test subprocesses with the permitted network-enabled execution profile and check error as well as status.

The original frontend used a locally implemented window.claude shim. Remaining artifact-only pathways included browser OpenRouter keys, comments/vision queues, shared-root migrations and local storage fallback. Local drafts/workout backups were shared between accounts on the same browser. Required OCR files are tracked. public/vendor/heic2any.min.js was present but untracked before this work; it was verified byte-identical to heic2any 0.0.4 and is now reproduced with its license by build.js from the integrity-locked npm dependency.

## Decisions and ownership

Better Auth 1.7.15 was verified by package inspection to support native node:sqlite; use separate auth.sqlite because legacy users/sessions conflict with its schema. Keep bojin.db as the app-data store. Authentication subagent owns lib/auth.js, invitation/mail modules, login UI, auth tests and dependency manifests. Lead owns server.js integration, app/index.html, shim, AI quota module, deployment and documentation. Do not edit the same files concurrently.

Auth interface: async createAuth(config), handle(req,res) for /api/auth/*, async sessionUser(req) returning stable {id,username,email,created}, close(). Only verified accounts obtain application data access. Route Better Auth before the legacy X-Bojin API guard; library handles its own origin/CSRF validation. No legacy auth route may remain as a bypass. Invitations and user creation must commit/rollback together. Preserve legacy IDs through an explicit administrator mapping to verified email; never infer ownership from a matching email or display name.

All app AI calls go through the authenticated backend. Per-user and global request reservations are atomic; failed requests count because an upstream timeout may still be billable. Request/output-token caps are not dollar limits: operator must also configure provider billing controls.

## Parallel work and release gates

- LEA-5 baseline/interfaces: lead; evidence above.
- LEA-6 domain/server and LEA-7 provider/email setup: Jay, parallel to coding.
- LEA-8 auth and LEA-9 invitations: subagent; lead integration review required.
- LEA-10 standalone frontend and AI: lead, parallel to auth.
- LEA-11 migration, LEA-12 backups/operations, LEA-13 export/deletion/privacy remain explicit tasks.
- LEA-14 staging follows integration and Jay's account setup.
- LEA-15 integrated security tests and LEA-16 mainland carrier/email tests must pass before LEA-17 beta.

No production deployment, real invitation email, or paid API calls during local development. Jay provides credentials through secret configuration, chooses recipients and approves the reviewed beta release. Do not mark staging/mainland reachability complete based on local tests.
