"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createInvitations } = require("./invitations");

const CONSENT_VERSION = "2026-11-24";
const CONSENT_REQUIRED_MESSAGE = "Consent to terms, privacy notice, sensitive data processing, and cross-border transfer is required";

function hasBothConsents(body) {
  return body?.consentTerms === true && body?.consentSensitiveCrossBorder === true;
}

function validLang(value) {
  if (typeof value !== "string") return null;
  const norm = value.trim().toLowerCase();
  return norm === "zh" || norm === "en" ? norm : null;
}

function getHeader(request, name) {
  if (!request?.headers) return null;
  if (typeof request.headers.get === "function") return request.headers.get(name);
  const v = request.headers[name] ?? request.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : (v ?? null);
}

function requestLang(request) {
  const explicit = getHeader(request, "x-ritual-lang");
  if (explicit !== null && explicit !== undefined) return validLang(explicit) || "zh";
  const accept = getHeader(request, "accept-language");
  if (typeof accept !== "string" || !accept.trim()) return "zh";
  const tags = accept.split(",")
    .map(part => part.split(";")[0].trim().toLowerCase())
    .filter(tag => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(tag));
  if (!tags.length) return "zh";
  return tags.some(tag => tag === "zh" || tag.startsWith("zh-")) ? "zh" : "en";
}

async function createAuth({ dataDir, baseURL, secret, cookieSecure = true, sendEmail, getUserLang, onDeleteRequested, onDeleteCompleted, clientIP = req => req.socket?.remoteAddress || "127.0.0.1" }) {
  async function resolveEmailLang(user, request) {
    if (typeof getUserLang === "function" && user?.id) {
      try {
        const profileLang = validLang(await getUserLang(user));
        if (profileLang) return profileLang;
      } catch {}
    }
    return requestLang(request);
  }
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters");
  const origin = new URL(baseURL);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("AUTH_BASE_URL must be an origin");
  if (origin.protocol !== "https:" && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error("Public authentication requires HTTPS");
  if (!cookieSecure && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error("Public authentication requires secure cookies");
  if (typeof sendEmail !== "function") throw new Error("An email delivery adapter is required");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const invites = createInvitations(db);
  const [{ betterAuth }, { APIError, createAuthMiddleware }, { getMigrations }, { toNodeHandler, fromNodeHeaders }] = await Promise.all([
    import("better-auth"), import("better-auth/api"), import("better-auth/db/migration"), import("better-auth/node"),
  ]);
  const options = {
    appName: "Lean Ritual", baseURL: origin.origin, basePath: "/api/auth", secret, database: db,
    trustedOrigins: [origin.origin], telemetry: { enabled: false },
    advanced: { useSecureCookies: cookieSecure, ipAddress: { ipAddressHeaders: ["x-ritual-client-ip"] } },
    emailAndPassword: {
      enabled: true, requireEmailVerification: true, autoSignIn: false,
      minPasswordLength: 8, maxPasswordLength: 200, revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }, request) => sendEmail({ to: user.email, kind: "reset", url, lang: await resolveEmailLang(user, request) }),
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: false, expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }, request) => sendEmail({ to: user.email, kind: "verify", url, lang: await resolveEmailLang(user, request) }),
    },
    hooks: { before: createAuthMiddleware(async ctx => {
      if (ctx.path === "/delete-user" && !ctx.body?.password) throw new APIError("BAD_REQUEST", {message:"Confirm your password to delete the account"});
      if (ctx.path === "/sign-up/email" && !hasBothConsents(ctx.body)) {
        throw new APIError("BAD_REQUEST", { message: CONSENT_REQUIRED_MESSAGE });
      }
    }) },
    user: {
      additionalFields: {
        consentVersion: { type: "string", required: false, input: false },
        consentedAt: { type: "string", required: false, input: false },
      },
      deleteUser: {enabled: typeof onDeleteRequested === "function",
        beforeDelete: async user => onDeleteRequested(user),
        afterDelete: async user => { if (onDeleteCompleted) await onDeleteCompleted(user); }
      }
    },
    session: { expiresIn: 7 * 86400, updateAge: 86400, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, window: 60, max: 30, customRules: {
      "/sign-up/email": { window: 3600, max: 5 },
      "/sign-in/email": { window: 900, max: 8 },
    } },
    databaseHooks: { user: {
      create: { before: async (user, ctx) => {
        if (ctx?.path !== "/sign-up/email") throw new APIError("BAD_REQUEST", { message: "Invitation required" });
        if (!hasBothConsents(ctx.body)) throw new APIError("BAD_REQUEST", { message: CONSENT_REQUIRED_MESSAGE });
        const uid = invites.claim(ctx.body?.invitation, user.email);
        if (!uid) throw new APIError("BAD_REQUEST", { message: "Invitation is invalid, expired, used, or belongs to another email" });
        return { data: { ...user, id: uid, consentVersion: CONSENT_VERSION, consentedAt: new Date().toISOString() } };
      } },
      update: { before: async (user) => {
        // Email changes need a new invitation and are intentionally unavailable.
        if (user.email !== undefined) throw new APIError("BAD_REQUEST", { message: "Email changes are unavailable" });
      } },
    } },
  };
  await (await getMigrations(options)).runMigrations();
  const auth = betterAuth(options);
  const readTelemetrySession = createAuthMiddleware(async ctx => {
    const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
    if (!token) return null;
    const session = await ctx.context.internalAdapter.findSession(token);
    if (!session?.user.emailVerified || session.session.expiresAt <= new Date()) return null;
    return { id: session.user.id };
  });
  // Guard every INSERT path, including future plugins and internal APIs.
  db.exec(`CREATE TRIGGER IF NOT EXISTS launch_user_invitation BEFORE INSERT ON user BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM launch_invites
      WHERE userId=NEW.id AND email=lower(NEW.email) AND consumed IS NOT NULL AND revoked=0)
    THEN RAISE(ABORT, 'Invitation required') END;
  END;`);
  return {
    auth, invites,
    handle(req, res) {
      req.headers["x-ritual-client-ip"] = clientIP(req);
      return toNodeHandler(auth)(req, res);
    },
    async telemetryUser(req) {
      return readTelemetrySession({ context: await auth.$context, headers: fromNodeHeaders(req.headers) });
    },
    async sessionUser(req) {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session?.user.emailVerified) return null;
      const u = session.user;
      return {
        id: u.id,
        username: u.name,
        email: u.email,
        created: u.createdAt,
        mustChange: false,
        consentVersion: typeof u.consentVersion === "string" && u.consentVersion ? u.consentVersion : null,
        consentedAt: typeof u.consentedAt === "string" && u.consentedAt ? u.consentedAt : null,
      };
    },
    recordConsent(uid) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT consentVersion, consentedAt FROM user WHERE id = ?").get(uid);
        if (!row) throw Object.assign(new Error("Account not found"), { status: 404, code: "not_found" });
        if (row.consentVersion === CONSENT_VERSION && row.consentedAt) {
          db.exec("COMMIT");
          return { consentVersion: row.consentVersion, consentedAt: row.consentedAt };
        }
        const now = new Date().toISOString();
        db.prepare("UPDATE user SET consentVersion = ?, consentedAt = ?, updatedAt = ? WHERE id = ?")
          .run(CONSENT_VERSION, now, now, uid);
        db.exec("COMMIT");
        return { consentVersion: CONSENT_VERSION, consentedAt: now };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    isUserPresent(uid) { return !!db.prepare('SELECT 1 FROM user WHERE id=?').get(uid); },
    purgeDeletedArtifacts(uid) {
      if (db.prepare('SELECT 1 FROM user WHERE id=?').get(uid)) throw new Error('Cannot purge a registered user');
      // The consumed invitation survives auth-user deletion and supplies the email
      // on startup retries. Purge it and older reissues atomically so a failed
      // cleanup never loses this lookup before removing the older identities.
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM verification WHERE value=?').run(uid);
        db.prepare(`DELETE FROM launch_invites WHERE userId=? OR email IN
          (SELECT email FROM launch_invites WHERE userId=?)`).run(uid, uid);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
module.exports = { createAuth, CONSENT_VERSION, CONSENT_REQUIRED_MESSAGE };
