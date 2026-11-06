"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createInvitations } = require("./invitations");

async function createAuth({ dataDir, baseURL, secret, cookieSecure = true, sendEmail, onDeleteRequested, onDeleteCompleted, clientIP = req => req.socket?.remoteAddress || "127.0.0.1" }) {
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
      minPasswordLength: 12, maxPasswordLength: 200, revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => sendEmail({ to: user.email, kind: "reset", url }),
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: false, expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) => sendEmail({ to: user.email, kind: "verify", url }),
    },
    hooks: { before: createAuthMiddleware(async ctx => {
      if (ctx.path === "/delete-user" && !ctx.body?.password) throw new APIError("BAD_REQUEST", {message:"Confirm your password to delete the account"});
    }) },
    user: {deleteUser: {enabled: typeof onDeleteRequested === "function",
      beforeDelete: async user => onDeleteRequested(user),
      afterDelete: async user => { if (onDeleteCompleted) await onDeleteCompleted(user); }
    }},
    session: { expiresIn: 7 * 86400, updateAge: 86400, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, window: 60, max: 30, customRules: {
      "/sign-up/email": { window: 3600, max: 5 },
      "/sign-in/email": { window: 900, max: 8 },
    } },
    databaseHooks: { user: {
      create: { before: async (user, ctx) => {
        if (ctx?.path !== "/sign-up/email") throw new APIError("BAD_REQUEST", { message: "Invitation required" });
        const uid = invites.claim(ctx.body?.invitation, user.email);
        if (!uid) throw new APIError("BAD_REQUEST", { message: "Invitation is invalid, expired, used, or belongs to another email" });
        return { data: { ...user, id: uid } };
      } },
      update: { before: async (user) => {
        // Email changes need a new invitation and are intentionally unavailable.
        if (user.email !== undefined) throw new APIError("BAD_REQUEST", { message: "Email changes are unavailable" });
      } },
    } },
  };
  await (await getMigrations(options)).runMigrations();
  const auth = betterAuth(options);
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
    async sessionUser(req) {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session?.user.emailVerified) return null;
      const u = session.user;
      return { id: u.id, username: u.name, email: u.email, created: u.createdAt, mustChange: false };
    },
    isUserPresent(uid) { return !!db.prepare('SELECT 1 FROM user WHERE id=?').get(uid); },
    purgeDeletedArtifacts(uid) {
      if (db.prepare('SELECT 1 FROM user WHERE id=?').get(uid)) throw new Error('Cannot purge a registered user');
      db.prepare('DELETE FROM launch_invites WHERE userId=?').run(uid);
      db.prepare('DELETE FROM verification WHERE value=?').run(uid);
    },
    close() { db.close(); },
  };
}
module.exports = { createAuth };
