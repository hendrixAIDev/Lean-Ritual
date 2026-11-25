"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createInvitations, normalizeEmail } = require("./invitations");
const { normalizePhone, syntheticPhoneEmail, isSyntheticPhoneEmail } = require("./phone");

const CONSENT_VERSION = "2026-11-25";
const GRANDFATHERED_EMAIL_CONSENT_VERSIONS = new Set(["2026-11-24"]);
const CONSENT_REQUIRED_MESSAGE = "Consent to terms, privacy notice, sensitive data processing, and cross-border transfer is required";
const CONSENT_VERSION_MISMATCH_MESSAGE = "Terms or privacy notice updated; refresh the page to review and accept the latest version";
const PHONE_INVITE_INVALID_MESSAGE = "Invitation is invalid, expired, used, or belongs to another phone number";

function isConsentSatisfied(user) {
  if (!user || typeof user.consentVersion !== "string") return false;
  if (user.consentVersion === CONSENT_VERSION) return true;
  // Existing email-only accounts that accepted 2026-11-24 have unchanged processing
  // (no phone number collected or operator phone recovery), so keep their recorded
  // 2026-11-24 acceptance valid without forcing re-consent while requiring 2026-11-25
  // for all new sign-ups and phone accounts.
  const hasPhone = Boolean(typeof user.phoneNumber === "string" && user.phoneNumber.trim());
  return !hasPhone && GRANDFATHERED_EMAIL_CONSENT_VERSIONS.has(user.consentVersion);
}

function validateSignupConsent(body, APIError) {
  if (body?.consentTerms !== true || body?.consentSensitiveCrossBorder !== true) {
    throw new APIError("BAD_REQUEST", { message: CONSENT_REQUIRED_MESSAGE });
  }
  if (typeof body?.agreedConsentVersion !== "string" || body.agreedConsentVersion.trim() !== CONSENT_VERSION) {
    throw new APIError("CONFLICT", { message: CONSENT_VERSION_MISMATCH_MESSAGE });
  }
  return body.agreedConsentVersion.trim();
}

function createAccountRateLimiter(secret) {
  const store = new Map();
  const MAX_ENTRIES = 100000;
  function prune(now) {
    for (const [k, entry] of store) {
      if (now >= entry.expiresAt) store.delete(k);
    }
    if (store.size <= MAX_ENTRIES) return;
    let remove = store.size - MAX_ENTRIES;
    for (const k of store.keys()) {
      store.delete(k);
      if (--remove <= 0) break;
    }
  }
  return {
    consume(bucket, identifier, { window, max }) {
      const now = Date.now();
      prune(now);
      const windowMs = window * 1000;
      const key = crypto.createHmac("sha256", secret).update(`${bucket}:${identifier}`).digest("hex");
      const entry = store.get(key);
      if (!entry || now - entry.lastRequest >= windowMs) {
        store.set(key, { count: 1, lastRequest: now, expiresAt: now + windowMs });
        return { allowed: true };
      }
      if (entry.count >= max) {
        return { allowed: false, retryAfter: Math.ceil((entry.lastRequest + windowMs - now) / 1000) };
      }
      entry.count += 1;
      entry.lastRequest = now;
      entry.expiresAt = now + windowMs;
      return { allowed: true };
    },
  };
}

function isPhoneAccount(user) {
  return Boolean(
    user &&
    typeof user.phoneNumber === "string" &&
    user.phoneNumber.trim().length > 0 &&
    isSyntheticPhoneEmail(user.email)
  );
}

function isVerifiedSessionUser(user) {
  return Boolean(user && (user.emailVerified || isPhoneAccount(user)));
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
  const accountLimiter = createAccountRateLimiter(secret);
  const [
    { betterAuth },
    { APIError, createAuthEndpoint, createAuthMiddleware, formCsrfMiddleware },
    { setSessionCookie },
    { getMigrations },
    { toNodeHandler, fromNodeHeaders },
    { runWithTransaction },
  ] = await Promise.all([
    import("better-auth"),
    import("better-auth/api"),
    import("better-auth/cookies"),
    import("better-auth/db/migration"),
    import("better-auth/node"),
    import("@better-auth/core/context"),
  ]);

  // Precomputed before serving traffic so the first unknown-number login pays the same
  // single verification cost as an existing-account wrong-password attempt.
  let dummyPasswordHash = null;

  const SIGNUP_LIMIT = { window: 3600, max: 5 };
  const SIGNIN_LIMIT = { window: 900, max: 8 };
  const enforceAccountRateLimit = (bucket, identifier, rule) => {
    const check = accountLimiter.consume(bucket, identifier, rule);
    if (!check.allowed) {
      throw new APIError("TOO_MANY_REQUESTS", {
        code: "TOO_MANY_REQUESTS",
        message: "Too many requests. Please try again later.",
      });
    }
  };

  // Minimal phone + password plugin using Better Auth's phoneNumber/phoneNumberVerified
  // user schema so SMS OTP verification can be layered later without schema changes.
  const phonePasswordPlugin = {
    id: "phone-password",
    endpoints: {
      signUpPhoneNumber: createAuthEndpoint("/sign-up/phone-number", {
        method: "POST",
        use: [formCsrfMiddleware],
      }, async ctx => {
        const body = ctx.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new APIError("BAD_REQUEST", { code: "BODY_MUST_BE_AN_OBJECT", message: "Body must be an object" });
        }
        const phone = normalizePhone(body.phoneNumber);
        if (!phone) {
          throw new APIError("BAD_REQUEST", { code: "INVALID_PHONE_NUMBER", message: "Invalid phone number" });
        }
        const password = body.password;
        if (typeof password !== "string" || !password) {
          throw new APIError("BAD_REQUEST", { code: "INVALID_PASSWORD", message: "Invalid password" });
        }
        if (password.length < 8) {
          throw new APIError("BAD_REQUEST", { code: "PASSWORD_TOO_SHORT", message: "Password too short" });
        }
        if (password.length > 200) {
          throw new APIError("BAD_REQUEST", { code: "PASSWORD_TOO_LONG", message: "Password too long" });
        }
        if (typeof body.invitation !== "string" || !body.invitation.trim()) {
          throw new APIError("BAD_REQUEST", { message: "Invitation required" });
        }
        const rawName = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
        const name = rawName || phone.slice(-4);
        const hash = await ctx.context.password.hash(password);

        return runWithTransaction(ctx.context.adapter, async () => {
          let createdUser;
          try {
            createdUser = await ctx.context.internalAdapter.createUser({
              email: syntheticPhoneEmail("pending-" + crypto.randomBytes(8).toString("hex")),
              name,
              emailVerified: false,
              phoneNumber: phone,
              phoneNumberVerified: false,
            }, { method: "phone-number" });
            if (!createdUser) {
              throw new APIError("BAD_REQUEST", { code: "FAILED_TO_CREATE_USER", message: "Failed to create user" });
            }
          } catch (e) {
            if (e instanceof APIError || (e && typeof e === "object" && e.name === "APIError")) throw e;
            // Never reveal whether a phone number is already registered.
            if (e && /UNIQUE constraint failed.*phoneNumber/i.test(String(e.message || ""))) {
              throw new APIError("BAD_REQUEST", { code: "INVALID_INVITATION", message: PHONE_INVITE_INVALID_MESSAGE });
            }
            throw new APIError("UNPROCESSABLE_ENTITY", { code: "FAILED_TO_CREATE_USER", message: "Failed to create user" });
          }
          await ctx.context.internalAdapter.linkAccount({
            userId: createdUser.id,
            providerId: "credential",
            accountId: createdUser.id,
            password: hash,
          });
          const session = await ctx.context.internalAdapter.createSession(createdUser.id, body.rememberMe === false);
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", { code: "FAILED_TO_CREATE_SESSION", message: "Failed to create session" });
          }
          await setSessionCookie(ctx, { session, user: createdUser }, body.rememberMe === false);
          return ctx.json({
            token: session.token,
            user: {
              id: createdUser.id,
              name: createdUser.name,
              phoneNumber: createdUser.phoneNumber,
              phoneNumberVerified: Boolean(createdUser.phoneNumberVerified),
              createdAt: createdUser.createdAt,
              updatedAt: createdUser.updatedAt,
            },
          });
        });
      }),
      signInPhoneNumber: createAuthEndpoint("/sign-in/phone-number", {
        method: "POST",
        use: [formCsrfMiddleware],
      }, async ctx => {
        const body = ctx.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new APIError("BAD_REQUEST", { code: "BODY_MUST_BE_AN_OBJECT", message: "Body must be an object" });
        }
        const phone = normalizePhone(body.phoneNumber);
        if (!phone) {
          throw new APIError("BAD_REQUEST", { code: "INVALID_PHONE_NUMBER", message: "Invalid phone number" });
        }
        const password = body.password;
        if (typeof password !== "string" || !password) {
          throw new APIError("UNAUTHORIZED", { code: "INVALID_PHONE_NUMBER_OR_PASSWORD", message: "Invalid phone number or password" });
        }
        if (password.length > 200) {
          throw new APIError("BAD_REQUEST", { code: "PASSWORD_TOO_LONG", message: "Password too long" });
        }
        const user = await ctx.context.adapter.findOne({
          model: "user",
          where: [{ field: "phoneNumber", value: phone }],
        });
        // Perform equivalent credential lookup and password verification on both found and missing accounts.
        const credentialAccount = await ctx.context.internalAdapter.findCredentialAccount(user ? user.id : "u_nonexistent_lookup");
        const hashToVerify = credentialAccount?.password || dummyPasswordHash;
        const valid = await ctx.context.password.verify({ hash: hashToVerify, password });
        if (!user || !credentialAccount?.password || !valid) {
          throw new APIError("UNAUTHORIZED", { code: "INVALID_PHONE_NUMBER_OR_PASSWORD", message: "Invalid phone number or password" });
        }
        const session = await ctx.context.internalAdapter.createSession(user.id, body.rememberMe === false);
        if (!session) {
          throw new APIError("INTERNAL_SERVER_ERROR", { code: "FAILED_TO_CREATE_SESSION", message: "Failed to create session" });
        }
        await setSessionCookie(ctx, { session, user }, body.rememberMe === false);
        return ctx.json({
          token: session.token,
          user: {
            id: user.id,
            name: user.name,
            phoneNumber: user.phoneNumber,
            phoneNumberVerified: Boolean(user.phoneNumberVerified),
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
        });
      }),
    },
  };

  const options = {
    appName: "Lean Ritual", baseURL: origin.origin, basePath: "/api/auth", secret, database: db,
    trustedOrigins: [origin.origin], telemetry: { enabled: false },
    advanced: { useSecureCookies: cookieSecure, ipAddress: { ipAddressHeaders: ["x-ritual-client-ip"] } },
    plugins: [phonePasswordPlugin],
    emailAndPassword: {
      enabled: true, requireEmailVerification: true, autoSignIn: false,
      minPasswordLength: 8, maxPasswordLength: 200, revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }, request) => {
        if (isSyntheticPhoneEmail(user?.email)) return;
        return sendEmail({ to: user.email, kind: "reset", url, lang: await resolveEmailLang(user, request) });
      },
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: false, expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }, request) => {
        if (isSyntheticPhoneEmail(user?.email)) return;
        return sendEmail({ to: user.email, kind: "verify", url, lang: await resolveEmailLang(user, request) });
      },
    },
    hooks: { before: createAuthMiddleware(async ctx => {
      if (ctx.path === "/delete-user" && !ctx.body?.password) throw new APIError("BAD_REQUEST", { message: "Confirm your password to delete the account" });
      if (ctx.path === "/sign-up/email") {
        validateSignupConsent(ctx.body, APIError);
        const normEmail = normalizeEmail(ctx.body?.email);
        if (isSyntheticPhoneEmail(normEmail)) {
          throw new APIError("BAD_REQUEST", { message: "Invitation is invalid, expired, used, or belongs to another email" });
        }
        if (normEmail) enforceAccountRateLimit("sign-up/email", normEmail, SIGNUP_LIMIT);
      }
      if (ctx.path === "/sign-in/email") {
        const normEmail = normalizeEmail(ctx.body?.email);
        if (isSyntheticPhoneEmail(normEmail)) {
          throw new APIError("UNAUTHORIZED", { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });
        }
        if (normEmail) enforceAccountRateLimit("sign-in/email", normEmail, SIGNIN_LIMIT);
      }
      if (ctx.path === "/sign-up/phone-number") {
        validateSignupConsent(ctx.body, APIError);
        const normPhone = normalizePhone(ctx.body?.phoneNumber);
        if (!normPhone) {
          throw new APIError("BAD_REQUEST", { code: "INVALID_PHONE_NUMBER", message: "Invalid phone number" });
        }
        enforceAccountRateLimit("sign-up/phone-number", normPhone, SIGNUP_LIMIT);
      }
      if (ctx.path === "/sign-in/phone-number") {
        const normPhone = normalizePhone(ctx.body?.phoneNumber);
        if (!normPhone) {
          throw new APIError("BAD_REQUEST", { code: "INVALID_PHONE_NUMBER", message: "Invalid phone number" });
        }
        enforceAccountRateLimit("sign-in/phone-number", normPhone, SIGNIN_LIMIT);
      }
      if ((ctx.path === "/request-password-reset" || ctx.path === "/send-verification-email") && isSyntheticPhoneEmail(ctx.body?.email)) {
        return ctx.json({ status: true });
      }
    }) },
    user: {
      additionalFields: {
        consentVersion: { type: "string", required: false, input: false },
        consentedAt: { type: "string", required: false, input: false },
        phoneNumber: { type: "string", required: false, unique: true, input: false },
        phoneNumberVerified: { type: "boolean", required: false, input: false },
      },
      deleteUser: {enabled: typeof onDeleteRequested === "function",
        beforeDelete: async user => onDeleteRequested(user),
        afterDelete: async user => { if (onDeleteCompleted) await onDeleteCompleted(user); }
      }
    },
    session: { expiresIn: 7 * 86400, updateAge: 86400, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, window: 60, max: 30, customRules: {
      "/sign-up/email": SIGNUP_LIMIT,
      "/sign-in/email": SIGNIN_LIMIT,
      "/sign-up/phone-number": SIGNUP_LIMIT,
      "/sign-in/phone-number": SIGNIN_LIMIT,
    } },
    databaseHooks: { user: {
      create: { before: async (user, ctx) => {
        if (ctx?.path === "/sign-up/email") {
          const agreedVersion = validateSignupConsent(ctx.body, APIError);
          const uid = invites.claim(ctx.body?.invitation, user.email);
          if (!uid) throw new APIError("BAD_REQUEST", { message: "Invitation is invalid, expired, used, or belongs to another email" });
          return { data: { ...user, id: uid, phoneNumber: null, phoneNumberVerified: false, consentVersion: agreedVersion, consentedAt: new Date().toISOString() } };
        }
        if (ctx?.path === "/sign-up/phone-number") {
          const agreedVersion = validateSignupConsent(ctx.body, APIError);
          const phone = normalizePhone(ctx.body?.phoneNumber);
          if (!phone) throw new APIError("BAD_REQUEST", { code: "INVALID_PHONE_NUMBER", message: "Invalid phone number" });
          const uid = invites.claimPhone(ctx.body?.invitation, phone);
          if (!uid) throw new APIError("BAD_REQUEST", { code: "INVALID_INVITATION", message: PHONE_INVITE_INVALID_MESSAGE });
          return {
            data: {
              ...user,
              id: uid,
              email: syntheticPhoneEmail(uid),
              emailVerified: false,
              phoneNumber: phone,
              phoneNumberVerified: false,
              consentVersion: agreedVersion,
              consentedAt: new Date().toISOString(),
            },
          };
        }
        throw new APIError("BAD_REQUEST", { message: "Invitation required" });
      } },
      update: { before: async (user) => {
        // Email and phone changes need a new invitation and are intentionally unavailable.
        if (user.email !== undefined) throw new APIError("BAD_REQUEST", { message: "Email changes are unavailable" });
        if (user.phoneNumber !== undefined || user.phoneNumberVerified !== undefined) {
          throw new APIError("BAD_REQUEST", { code: "PHONE_NUMBER_CANNOT_BE_UPDATED", message: "Phone number changes are unavailable" });
        }
      } },
    } },
  };
  await (await getMigrations(options)).runMigrations();
  const auth = betterAuth(options);
  const authCtx = await auth.$context;
  dummyPasswordHash = await authCtx.password.hash(crypto.randomBytes(24).toString("base64url"));
  const readTelemetrySession = createAuthMiddleware(async ctx => {
    const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
    if (!token) return null;
    const session = await ctx.context.internalAdapter.findSession(token);
    if (!isVerifiedSessionUser(session?.user) || session.session.expiresAt <= new Date()) return null;
    return { id: session.user.id };
  });
  // Guard every INSERT path, including future plugins and internal APIs.
  // Recreate idempotently so pre-existing auth.sqlite upgrades cleanly to accept phone invites.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DROP TRIGGER IF EXISTS launch_user_invitation;
    CREATE TRIGGER launch_user_invitation BEFORE INSERT ON user BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM launch_invites
        WHERE userId=NEW.id AND consumed IS NOT NULL AND revoked=0 AND (
          (phone IS NULL AND email=lower(NEW.email)) OR
          (phone IS NOT NULL AND phone=NEW.phoneNumber)
        ))
      THEN RAISE(ABORT, 'Invitation required') END;
    END;`);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
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
      if (!isVerifiedSessionUser(session?.user)) return null;
      const u = session.user;
      const phoneOnly = isPhoneAccount(u);
      return {
        id: u.id,
        username: u.name,
        email: phoneOnly ? null : u.email,
        phoneNumber: typeof u.phoneNumber === "string" && u.phoneNumber ? u.phoneNumber : null,
        phoneNumberVerified: Boolean(u.phoneNumberVerified),
        created: u.createdAt,
        mustChange: false,
        consentVersion: typeof u.consentVersion === "string" && u.consentVersion ? u.consentVersion : null,
        consentedAt: typeof u.consentedAt === "string" && u.consentedAt ? u.consentedAt : null,
      };
    },
    recordConsent(uid, expectedVersion) {
      const agreedVersion = typeof expectedVersion === "string" ? expectedVersion.trim() : "";
      if (agreedVersion !== CONSENT_VERSION) {
        throw Object.assign(new Error("使用条款或隐私说明已更新，请刷新页面重新阅读后再同意"), { status: 409, code: "consent_version_mismatch" });
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT consentVersion, consentedAt FROM user WHERE id = ?").get(uid);
        if (!row) throw Object.assign(new Error("Account not found"), { status: 404, code: "not_found" });
        if (row.consentVersion === agreedVersion && row.consentedAt) {
          db.exec("COMMIT");
          return { consentVersion: row.consentVersion, consentedAt: row.consentedAt };
        }
        const now = new Date().toISOString();
        db.prepare("UPDATE user SET consentVersion = ?, consentedAt = ?, updatedAt = ? WHERE id = ?")
          .run(agreedVersion, now, now, uid);
        db.exec("COMMIT");
        return { consentVersion: agreedVersion, consentedAt: now };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    isUserPresent(uid) { return !!db.prepare('SELECT 1 FROM user WHERE id=?').get(uid); },
    purgeDeletedArtifacts(uid) {
      if (db.prepare('SELECT 1 FROM user WHERE id=?').get(uid)) throw new Error('Cannot purge a registered user');
      // The consumed invitation survives auth-user deletion and supplies the email or
      // phone on startup retries. Purge it and older reissues atomically so a failed
      // cleanup never loses this lookup before removing the older identities.
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM verification WHERE value=?').run(uid);
        db.prepare(`DELETE FROM launch_invites WHERE userId=?
          OR (email != '' AND email IN (SELECT email FROM launch_invites WHERE userId=? AND email != ''))
          OR (phone IS NOT NULL AND phone IN (SELECT phone FROM launch_invites WHERE userId=? AND phone IS NOT NULL))`).run(uid, uid, uid);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
module.exports = { createAuth, CONSENT_VERSION, GRANDFATHERED_EMAIL_CONSENT_VERSIONS, isConsentSatisfied, CONSENT_REQUIRED_MESSAGE, CONSENT_VERSION_MISMATCH_MESSAGE, PHONE_INVITE_INVALID_MESSAGE };
