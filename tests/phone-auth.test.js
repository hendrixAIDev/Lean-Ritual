"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createAuth, CONSENT_VERSION, isConsentSatisfied } = require("../lib/auth");
const { normalizePhone, isValidE164, syntheticPhoneEmail, isSyntheticPhoneEmail } = require("../lib/phone");
const { createSnapshot, restoreSnapshot } = require("../lib/snapshots");
const { readLedger } = require("../lib/deletion-ledger");

const ROOT = path.resolve(__dirname, "..");
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const AXE_PATH = path.join(ROOT, "tests/fixtures/axe-core/axe.min.js");

function loadPlaywright() {
  const candidates = ["playwright"];
  const home = os.homedir();
  for (const rel of [
    ".claude/skills/gstack/node_modules/playwright",
    ".agents/skills/gstack/node_modules/playwright",
  ]) {
    candidates.push(path.join(home, rel));
  }
  const npxDir = path.join(home, ".npm", "_npx");
  if (fs.existsSync(npxDir)) {
    for (const entry of fs.readdirSync(npxDir)) {
      candidates.push(path.join(npxDir, entry, "node_modules", "playwright"));
    }
  }
  for (const spec of candidates) {
    try {
      const pw = require(spec);
      const execPath = process.env.CHROMIUM_PATH
        || (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium"
          : fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome"
            : pw.chromium.executablePath());
      if (execPath && fs.existsSync(execPath)) {
        return { chromium: pw.chromium, executablePath: execPath };
      }
    } catch {}
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startTestServer(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-phone-srv-"));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dir,
    PORT: String(port),
    HOST: "127.0.0.1",
    AUTH_BASE_URL: base,
    AUTH_SECRET: "phone-auth-test-secret-that-is-32-chars!!",
    COOKIE_SECURE: "0",
    TRUST_PROXY: "0",
    MAIL_MODE: "file",
    OPENROUTER_API_KEY: "",
    GEMINI_API_KEY: "",
    ...extraEnv,
  };
  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", d => { stderr += d; });
  t.after(async () => {
    if (child.exitCode === null) {
      const done = new Promise(r => child.once("exit", r));
      child.kill();
      await done;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timeout " + stderr)), 8000);
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
  });
  return { dir, base, env, port, origin: base, child };
}

test("phone normalization defaults 11-digit mainland numbers to +86 and validates E.164", () => {
  assert.equal(normalizePhone("13800138000"), "+8613800138000");
  assert.equal(normalizePhone("138 0013 8000"), "+8613800138000");
  assert.equal(normalizePhone("138-0013-8000"), "+8613800138000");
  assert.equal(normalizePhone("１３８００１３８０００"), "+8613800138000");
  assert.equal(normalizePhone("＋86 138-0013-8000"), "+8613800138000");
  assert.equal(normalizePhone("008613800138000"), "+8613800138000");
  assert.equal(normalizePhone("+1 (415) 555-2671"), "+14155552671");
  assert.equal(normalizePhone("+44 7911 123456"), "+447911123456");
  assert.equal(normalizePhone("+852 9123 4567"), "+85291234567");
  assert.equal(isValidE164("+8613800138000"), true);
  assert.equal(isValidE164("13800138000"), false);

  for (const bad of ["", "   ", "abc", "12345", "12345678901", "+86138001380", "+86138001380000", "+8612000138000", "+0123456789", "+1234567890123456", null, undefined, 13800138000]) {
    assert.equal(normalizePhone(bad), null, `expected null for ${String(bad)}`);
  }

  const synth = syntheticPhoneEmail("u_AbC123");
  assert.equal(isSyntheticPhoneEmail(synth), true);
  assert.equal(isSyntheticPhoneEmail("alice@example.com"), false);
  assert.ok(!synth.includes("138"));
});

test("migration is safe and idempotent on a pre-existing live auth.sqlite and upgrades the invite trigger", { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-phone-mig-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  // 1. Build a pre-phone auth.sqlite with the legacy schema & email-only trigger
  const { getMigrations } = await import("better-auth/db/migration");
  const legacyDb = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  await (await getMigrations({
    baseURL: "http://localhost:8080", basePath: "/api/auth",
    secret: "phone-mig-test-secret-long-enough-12345", database: legacyDb,
    emailAndPassword: { enabled: true },
    user: { additionalFields: {
      consentVersion: { type: "string", required: false, input: false },
      consentedAt: { type: "string", required: false, input: false },
    } },
  })).runMigrations();
  legacyDb.exec(`
    CREATE TABLE launch_invites (
      tokenHash TEXT PRIMARY KEY, email TEXT NOT NULL, userId TEXT NOT NULL,
      expires INTEGER NOT NULL, consumed INTEGER, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TRIGGER launch_user_invitation BEFORE INSERT ON user BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM launch_invites
        WHERE userId=NEW.id AND email=lower(NEW.email) AND consumed IS NOT NULL AND revoked=0)
      THEN RAISE(ABORT, 'Invitation required') END;
    END;
  `);
  const now = new Date().toISOString();
  legacyDb.prepare("INSERT INTO launch_invites(tokenHash, email, userId, expires, consumed, revoked) VALUES(?,?,?,?,?,0)")
    .run("legacy-hash-1", "existing@example.com", "u_existing_email", Date.now() + 86400000, Date.now());
  legacyDb.prepare("INSERT INTO user(id, name, email, emailVerified, consentVersion, consentedAt, createdAt, updatedAt) VALUES(?,?,?,1,?,?,?,?)")
    .run("u_existing_email", "Existing", "existing@example.com", CONSENT_VERSION, now, now, now);
  legacyDb.close();

  // 2. Boot createAuth once -> migrates user + launch_invites + trigger without losing existing data
  const svc1 = await createAuth({
    dataDir, baseURL: "http://localhost:8080",
    secret: "phone-mig-test-secret-long-enough-12345", cookieSecure: false,
    sendEmail: async () => {},
  });
  svc1.close();

  // 3. Boot createAuth a second time -> strictly idempotent
  const mails = [];
  const svc2 = await createAuth({
    dataDir, baseURL: "http://localhost:8080",
    secret: "phone-mig-test-secret-long-enough-12345", cookieSecure: false,
    sendEmail: async m => mails.push(m),
  });
  t.after(() => svc2.close());

  const inspect = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  t.after(() => inspect.close());
  const userCols = inspect.prepare("PRAGMA table_info(user)").all().map(c => c.name);
  assert.ok(userCols.includes("phoneNumber"));
  assert.ok(userCols.includes("phoneNumberVerified"));
  const invCols = inspect.prepare("PRAGMA table_info(launch_invites)").all().map(c => c.name);
  assert.ok(invCols.includes("phone"));

  const existing = inspect.prepare("SELECT id, email, phoneNumber FROM user WHERE id=?").get("u_existing_email");
  assert.equal(existing.email, "existing@example.com");
  assert.equal(existing.phoneNumber, null);

  // 4. Phone signup works through the upgraded trigger!
  const inv = svc2.invites.issuePhone("13800138000");
  assert.equal(inv.phone, "+8613800138000");
  const res = await svc2.auth.handler(new Request("http://localhost:8080/api/auth/sign-up/phone-number", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ritual-client-ip": "192.0.2.10", origin: "http://localhost:8080" },
    body: JSON.stringify({
      phoneNumber: "138 0013 8000", name: "Migrated Phone", password: "strong-phone-password",
      invitation: inv.token, consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
    }),
  }));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(mails.length, 0);
});

test("phone invite lifecycle, signup/login, wrong password, anti-enumeration, rollback, and spoof guards", { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-phone-auth-"));
  const mails = [];
  const svc = await createAuth({
    dataDir, baseURL: "http://localhost:8080",
    secret: "phone-lifecycle-test-secret-32-chars!!", cookieSecure: false,
    sendEmail: async m => mails.push(m),
  });
  t.after(() => { svc.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const inspector = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  t.after(() => inspector.close());

  let ipN = 1;
  const req = (route, body, { cookie, origin = "http://localhost:8080", ip = `192.0.2.${ipN++}` } = {}) =>
    svc.auth.handler(new Request("http://localhost:8080/api/auth/" + route, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ritual-client-ip": ip, origin, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }));

  const pw = "phone-strong-password-1";
  const inv = svc.invites.issuePhone("13800138001");
  assert.equal(inv.phone, "+8613800138001");

  // Cross-origin rejected
  assert.equal((await req("sign-up/phone-number", { phoneNumber: inv.phone, password: pw, invitation: inv.token, consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION }, { origin: "https://evil.invalid" })).status, 403);
  assert.equal((await req("sign-in/phone-number", { phoneNumber: inv.phone, password: pw }, { origin: "https://evil.invalid" })).status, 403);

  // Phone invite cannot be claimed by email signup, and email invite cannot be claimed by phone signup
  const emailInv = svc.invites.issue("only-email@example.com");
  assert.equal((await req("sign-up/phone-number", {
    phoneNumber: "+8613800138002", name: "Wrong", password: pw, invitation: emailInv.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  })).status, 400);

  // Missing consent / stale consent / short password reject WITHOUT consuming phone invite
  assert.equal((await req("sign-up/phone-number", { phoneNumber: inv.phone, name: "A", password: pw, invitation: inv.token })).status, 400);
  assert.equal((await req("sign-up/phone-number", { phoneNumber: inv.phone, name: "A", password: pw, invitation: inv.token, consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-01-01" })).status, 409);
  assert.equal((await req("sign-up/phone-number", { phoneNumber: inv.phone, name: "A", password: "short", invitation: inv.token, consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION })).status, 400);
  assert.equal(inspector.prepare("SELECT consumed FROM launch_invites WHERE phone=?").get(inv.phone).consumed, null);

  // Failed account creation rolls back invite consumption cleanly
  inspector.exec("CREATE TRIGGER fail_phone_acct BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  const failed = await req("sign-up/phone-number", {
    phoneNumber: inv.phone, name: "Rollback", password: pw, invitation: inv.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  });
  assert.equal(failed.status, 500);
  assert.equal(inspector.prepare("SELECT COUNT(*) n FROM user").get().n, 0);
  assert.equal(inspector.prepare("SELECT consumed FROM launch_invites WHERE phone=?").get(inv.phone).consumed, null);
  inspector.exec("DROP TRIGGER fail_phone_acct");

  // Direct SQLite INSERT bypass without consumed invite is blocked by trigger
  assert.throws(
    () => inspector.exec(`INSERT INTO user (id,name,email,emailVerified,phoneNumber,phoneNumberVerified,createdAt,updatedAt) VALUES ('u_bypass_ph','Bypass','phone-x@phone.leanritual.invalid',0,'+8613800138099',0,0,0)`),
    /Invitation required/
  );

  // Valid phone signup succeeds immediately without email verification and sets session cookie
  const okSignup = await req("sign-up/phone-number", {
    phoneNumber: "138-0013-8001", name: "Grandma Lin", password: pw, invitation: inv.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  });
  assert.equal(okSignup.status, 200, await okSignup.clone().text());
  const signupBody = await okSignup.json();
  assert.equal(signupBody.user.id, inv.userId);
  assert.equal(signupBody.user.phoneNumber, "+8613800138001");
  assert.equal(signupBody.user.phoneNumberVerified, false);
  assert.equal(mails.length, 0, "phone signup must never send email");

  const signupCookie = okSignup.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const sessionUser = await svc.sessionUser({ headers: { cookie: signupCookie } });
  assert.equal(sessionUser.id, inv.userId);
  assert.equal(sessionUser.email, null);
  assert.equal(sessionUser.phoneNumber, "+8613800138001");
  assert.equal(sessionUser.consentVersion, CONSENT_VERSION);

  // Client cannot spoof phoneNumber or phoneNumberVerified via update-user
  const spoofRes = await req("update-user", { phoneNumber: "+8613900139999", phoneNumberVerified: true }, { cookie: signupCookie });
  assert.equal(spoofRes.status, 400);

  // Synthetic email cannot be used on email sign-in or password reset
  const dbRow = inspector.prepare("SELECT email FROM user WHERE id=?").get(inv.userId);
  assert.ok(isSyntheticPhoneEmail(dbRow.email));
  assert.equal((await req("sign-in/email", { email: dbRow.email, password: pw })).status, 401);
  assert.equal((await req("request-password-reset", { email: dbRow.email, redirectTo: "/login.html" })).status, 200);
  assert.equal(mails.length, 0, "synthetic email must never dispatch mail");

  // Sign out -> login with formatted mainland number succeeds
  assert.equal((await req("sign-out", {}, { cookie: signupCookie })).status, 200);
  assert.equal(await svc.sessionUser({ headers: { cookie: signupCookie } }), null);

  const loginOk = await req("sign-in/phone-number", { phoneNumber: "138 0013 8001", password: pw });
  assert.equal(loginOk.status, 200, await loginOk.clone().text());

  // Anti-enumeration on sign-in: wrong password on existing phone vs unregistered phone return IDENTICAL status & JSON
  const wrongPwRes = await req("sign-in/phone-number", { phoneNumber: "+8613800138001", password: "wrong-password-123" });
  const unknownPhRes = await req("sign-in/phone-number", { phoneNumber: "+8613800138099", password: "wrong-password-123" });
  assert.equal(wrongPwRes.status, 401);
  assert.equal(unknownPhRes.status, 401);
  assert.deepEqual(await wrongPwRes.json(), await unknownPhRes.json());

  // Anti-enumeration on sign-up: already-registered phone vs unregistered phone return IDENTICAL status & JSON
  const regExistRes = await req("sign-up/phone-number", {
    phoneNumber: "+8613800138001", name: "Probe", password: pw, invitation: "fake-invite-token",
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  });
  const regUnknownRes = await req("sign-up/phone-number", {
    phoneNumber: "+8613800138099", name: "Probe", password: pw, invitation: "fake-invite-token",
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  });
  assert.equal(regExistRes.status, 400);
  assert.equal(regUnknownRes.status, 400);
  assert.deepEqual(await regExistRes.json(), await regUnknownRes.json());

  // Expired / revoked / rotated phone invites fail; issuing for already-registered phone throws
  assert.throws(() => svc.invites.issuePhone(inv.phone), /already registered/);
  const expInv = svc.invites.issuePhone("+8613800138010");
  inspector.prepare("UPDATE launch_invites SET expires = 0 WHERE phone = ?").run(expInv.phone);
  assert.equal((await req("sign-up/phone-number", {
    phoneNumber: expInv.phone, name: "Exp", password: pw, invitation: expInv.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  })).status, 400);

  const revInv = svc.invites.issuePhone("+8613800138011");
  svc.invites.revoke(revInv.token);
  assert.equal((await req("sign-up/phone-number", {
    phoneNumber: revInv.phone, name: "Rev", password: pw, invitation: revInv.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  })).status, 400);

  const rotOld = svc.invites.issuePhone("+8613800138012");
  const rotNew = svc.invites.issuePhone("+8613800138012", { userId: rotOld.userId });
  assert.equal((await req("sign-up/phone-number", {
    phoneNumber: rotOld.phone, name: "Rot", password: pw, invitation: rotOld.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  })).status, 400);
  assert.equal((await req("sign-up/phone-number", {
    phoneNumber: rotNew.phone, name: "Rot", password: pw, invitation: rotNew.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  })).status, 200);
});

test("phone sign-in and sign-up enforce both per-IP and per-account rate limits", { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-phone-rl-"));
  const svc = await createAuth({
    dataDir, baseURL: "http://localhost:8080",
    secret: "phone-ratelimit-test-secret-32-chars!", cookieSecure: false,
    sendEmail: async () => {},
  });
  t.after(() => { svc.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const post = (route, ip, body) => svc.auth.handler(new Request("http://localhost:8080/api/auth/" + route, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ritual-client-ip": ip, origin: "http://localhost:8080" },
    body: JSON.stringify(body),
  }));

  // 1. Per-IP sign-in limit (8 per 900s across distinct phone numbers)
  for (let i = 0; i < 8; i++) {
    const r = await post("sign-in/phone-number", "198.51.100.10", { phoneNumber: `+861380013000${i}`, password: "wrong-password-1" });
    assert.equal(r.status, 401, `attempt ${i + 1} should be 401`);
  }
  assert.equal((await post("sign-in/phone-number", "198.51.100.10", { phoneNumber: "+8613800130009", password: "wrong-password-1" })).status, 429);

  // 2. Per-account sign-in limit (8 per 900s across distinct IPs, mixing 11-digit & +86 forms)
  for (let i = 0; i < 8; i++) {
    const num = i % 2 === 0 ? "13900139000" : "+86 139-0013-9000";
    const r = await post("sign-in/phone-number", `198.51.100.${20 + i}`, { phoneNumber: num, password: "wrong-password-1" });
    assert.equal(r.status, 401, `per-account attempt ${i + 1} should be 401`);
  }
  assert.equal((await post("sign-in/phone-number", "198.51.100.99", { phoneNumber: "+8613900139000", password: "wrong-password-1" })).status, 429);

  // 3. Per-IP sign-up limit (5 per 3600s across distinct phone numbers)
  for (let i = 0; i < 5; i++) {
    const r = await post("sign-up/phone-number", "203.0.113.10", {
      phoneNumber: `+861370013000${i}`, name: "RL", password: "strong-password-1", invitation: "bad-tok",
      consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
    });
    assert.equal(r.status, 400, `signup IP attempt ${i + 1} should be 400`);
  }
  assert.equal((await post("sign-up/phone-number", "203.0.113.10", {
    phoneNumber: "+8613700130009", name: "RL", password: "strong-password-1", invitation: "bad-tok",
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  })).status, 429);

  // 4. Per-account sign-up limit (5 per 3600s across distinct IPs)
  for (let i = 0; i < 5; i++) {
    const r = await post("sign-up/phone-number", `203.0.113.${20 + i}`, {
      phoneNumber: "13600136000", name: "RL", password: "strong-password-1", invitation: "bad-tok",
      consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
    });
    assert.equal(r.status, 400, `signup acct attempt ${i + 1} should be 400`);
  }
  assert.equal((await post("sign-up/phone-number", "203.0.113.99", {
    phoneNumber: "+8613600136000", name: "RL", password: "strong-password-1", invitation: "bad-tok",
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  })).status, 429);
});

test("HTTP integration: CLI phone invite, export, admin reset-password (24h one-time), deletion, and deletion ledger replay", { timeout: 45000 }, async t => {
  const srv = await startTestServer(t);
  const runAdmin = (args, stdin) => {
    const r = spawnSync(process.execPath, ["scripts/auth-admin.js", ...args], {
      cwd: ROOT, env: srv.env, encoding: "utf8", timeout: 8000, ...(stdin !== undefined ? { input: stdin } : {}),
    });
    return r;
  };
  const api = (route, body, cookie, method) => fetch(srv.base + route, {
    method: method || (body ? "POST" : "GET"),
    redirect: "manual",
    headers: { origin: srv.origin, "Content-Type": "application/json", "X-Bojin": "1", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  // Issue revoked old invite + fresh invite for user A (tests purging older reissues too) and invite for user B
  const oldA = runAdmin(["invite", "--phone", "13800138111"]);
  assert.equal(oldA.status, 0, oldA.stderr);
  const oldAParsed = JSON.parse(oldA.stdout);
  assert.equal(oldAParsed.phone, "+8613800138111");
  assert.equal(runAdmin(["revoke"], oldAParsed.token).status, 0);

  const invARes = runAdmin(["invite", "--phone", "138 0013 8111"]);
  assert.equal(invARes.status, 0, invARes.stderr);
  const invA = JSON.parse(invARes.stdout);
  assert.equal(invA.phone, "+8613800138111");
  assert.match(invA.url, /\/login\.html\?invite=.*&phone=%2B8613800138111/);

  const invBRes = runAdmin(["invite", "--phone", "+14155552671"]);
  assert.equal(invBRes.status, 0, invBRes.stderr);
  const invB = JSON.parse(invBRes.stdout);
  assert.equal(invB.phone, "+14155552671");

  const pw1 = "phone-e2e-password-1";
  const pw2 = "phone-e2e-password-2";

  // Sign up A and B
  const signA = await api("/api/auth/sign-up/phone-number", {
    phoneNumber: "13800138111", name: "Auntie Wang", password: pw1, invitation: invA.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  });
  assert.equal(signA.status, 200, await signA.clone().text());
  const cookieA1 = signA.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");

  const signB = await api("/api/auth/sign-up/phone-number", {
    phoneNumber: "+14155552671", name: "Uncle Sam", password: pw1, invitation: invB.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  });
  assert.equal(signB.status, 200, await signB.clone().text());
  const cookieB = signB.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");

  // /api/me exposes phoneNumber and null email
  const meA = await (await api("/api/me", null, cookieA1)).json();
  assert.equal(meA.id, invA.userId);
  assert.equal(meA.phoneNumber, "+8613800138111");
  assert.equal(meA.email, null);
  assert.equal(meA.consentRequired, false);

  // Save a doc and verify data export includes phoneNumber and omits synthetic email
  assert.equal((await api(`/api/doc?path=data/users/${invA.userId}/app/app/profile`, { data: { weight: 62 } }, cookieA1, "PUT")).status, 200);
  const expRes = await api("/api/account/export", null, cookieA1);
  assert.equal(expRes.status, 200);
  const expText = await expRes.text();
  assert.ok(!expText.includes("phone.leanritual.invalid"), "export must not expose synthetic internal email");
  const expLines = expText.trim().split("\n").map(JSON.parse);
  assert.equal(expLines[0].kind, "account");
  assert.equal(expLines[0].user.phoneNumber, "+8613800138111");
  assert.equal(expLines[0].user.email, null);
  assert.equal(expLines.find(x => x.kind === "document").data.weight, 62);

  // Admin reset-password --phone prints a 24h one-time reset link (never a password) + out-of-band verification reminder
  const badReset = runAdmin(["reset-password", "--phone", "+8613800138999"]);
  assert.equal(badReset.status, 1);

  const resetRes1 = runAdmin(["reset-password", "--phone", "13800138111"]);
  assert.equal(resetRes1.status, 0, resetRes1.stderr);
  assert.match(resetRes1.stderr, /out-of-band/i);
  assert.match(resetRes1.stderr, /call back the registered phone number|original inviter/i);
  assert.match(resetRes1.stderr, /Deny recovery if identity cannot be verified/i);
  const reset1 = JSON.parse(resetRes1.stdout);
  assert.equal(reset1.phone, "+8613800138111");
  assert.equal(reset1.userId, invA.userId);
  assert.equal("password" in reset1, false);
  assert.match(reset1.url, /\/login\.html\?token=.*&method=phone/);
  const ttlHours = (Date.parse(reset1.expiresAt) - Date.now()) / 3600000;
  assert.ok(ttlHours > 23.9 && ttlHours <= 24.05, `expected ~24h TTL, got ${ttlHours}h`);

  // Runbook documents mandatory out-of-band verification, delivery channel, and denial rules
  const authDoc = fs.readFileSync(path.join(ROOT, "docs/authentication.md"), "utf8");
  assert.match(authDoc, /out-of-band/i);
  assert.match(authDoc, /voice callback directly to the registered phone number/i);
  assert.match(authDoc, /When to deny recovery/i);

  // Issuing a second reset link invalidates the first one
  const resetRes2 = runAdmin(["reset-password", "--phone", "+8613800138111"]);
  assert.equal(resetRes2.status, 0, resetRes2.stderr);
  const reset2 = JSON.parse(resetRes2.stdout);
  assert.notEqual(reset2.token, reset1.token);
  assert.equal((await api("/api/auth/reset-password", { token: reset1.token, newPassword: pw2 })).status, 400);

  // Using the active reset link sets the new password, revokes existing sessions, and is single-use
  assert.equal((await api("/api/auth/reset-password", { token: reset2.token, newPassword: pw2 })).status, 200);
  assert.equal((await api("/api/me", null, cookieA1)).status, 401, "old session must be revoked on password reset");
  assert.equal((await api("/api/auth/reset-password", { token: reset2.token, newPassword: "replay-attempt-pw" })).status, 400);
  assert.equal((await api("/api/auth/sign-in/phone-number", { phoneNumber: "+8613800138111", password: pw1 })).status, 401);

  // Expired reset token is rejected
  const resetRes3 = runAdmin(["reset-password", "--phone", "+8613800138111"]);
  const reset3 = JSON.parse(resetRes3.stdout);
  const expDb = new DatabaseSync(path.join(srv.dir, "auth.sqlite"));
  expDb.prepare("UPDATE verification SET expiresAt = ? WHERE identifier = ?").run(new Date(Date.now() - 1000).toISOString(), "reset-password:" + reset3.token);
  expDb.close();
  assert.equal((await api("/api/auth/reset-password", { token: reset3.token, newPassword: "expired-pw-123" })).status, 400);

  // Sign back in with new password
  const loginA2 = await api("/api/auth/sign-in/phone-number", { phoneNumber: "138 0013 8111", password: pw2 });
  assert.equal(loginA2.status, 200, await loginA2.clone().text());
  const cookieA2 = loginA2.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");

  // Take a snapshot BEFORE deleting user A (we'll stop server temporarily? No, snapshot needs no active writers; create copy after stop or via offline copy!)
  // Instead, copy snapshot AFTER stopping server? Better: copy snapshot before deletion by creating an extra backup copy via SQLite VACUUM INTO or stop/restart.
  // Actually let's stop server, take an official createSnapshot(), restart server, delete A, then verify BOTH live DB AND restoreSnapshot + deletion ledger!
  const stopServer = async child => {
    if (child.exitCode === null) {
      const done = new Promise(r => child.once("exit", r));
      child.kill();
      await done;
    }
  };
  await stopServer(srv.child);
  const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-phone-snap-"));
  t.after(() => fs.rmSync(snapRoot, { recursive: true, force: true }));
  const snapshotDir = path.join(snapRoot, "before-delete");
  await createSnapshot(srv.dir, snapshotDir);

  // Restart server on the same DATA_DIR to delete user A
  const child2 = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: srv.env, stdio: ["ignore", "pipe", "pipe"] });
  let err2 = "";
  child2.stderr.on("data", d => { err2 += d; });
  t.after(() => stopServer(child2));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("restart timeout " + err2)), 8000);
    child2.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child2.once("exit", () => { clearTimeout(timer); reject(new Error(err2)); });
  });

  // Delete user A with password
  const delA = await api("/api/auth/delete-user", { password: pw2 }, cookieA2);
  assert.equal(delA.status, 200, await delA.clone().text());
  assert.equal((await api("/api/me", null, cookieA2)).status, 401);
  // User B must remain completely unaffected!
  const meB = await api("/api/me", null, cookieB);
  assert.equal(meB.status, 200);
  assert.equal((await meB.json()).phoneNumber, "+14155552671");

  await stopServer(child2);

  // Check live DB has ZERO trace of user A's phone number anywhere, while user B's phone & invite remain!
  const authInspect = new DatabaseSync(path.join(srv.dir, "auth.sqlite"));
  try {
    for (const { name } of authInspect.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const dump = JSON.stringify(authInspect.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
      assert.ok(!dump.includes("13800138111"), `live auth.sqlite table ${name} retained deleted phone number`);
    }
    assert.ok(authInspect.prepare("SELECT 1 FROM user WHERE phoneNumber=?").get("+14155552671"), "user B must still exist");
    assert.ok(authInspect.prepare("SELECT 1 FROM launch_invites WHERE phone=?").get("+14155552671"), "user B invite must still exist");
  } finally { authInspect.close(); }

  // Deletion ledger must NOT contain phone number, and replaying it on restored snapshot removes A's phone everywhere
  const ledger = readLedger(srv.dir);
  assert.ok(!JSON.stringify(ledger).includes("13800138111"), "deletion ledger must not contain phone numbers");
  assert.ok(ledger.users.some(u => u.uid === invA.userId));

  const restoredDir = path.join(snapRoot, "restored");
  restoreSnapshot(snapshotDir, restoredDir, ledger);
  const restoredAuth = new DatabaseSync(path.join(restoredDir, "auth.sqlite"));
  try {
    for (const { name } of restoredAuth.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const dump = JSON.stringify(restoredAuth.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
      assert.ok(!dump.includes("13800138111"), `restored auth.sqlite table ${name} resurrected deleted phone number`);
    }
    assert.ok(restoredAuth.prepare("SELECT 1 FROM user WHERE phoneNumber=?").get("+14155552671"), "restored snapshot must keep user B");
  } finally { restoredAuth.close(); }
});

test("reissuing a phone invite preserves a stable UID so deletion-ledger replay erases pre-reissue snapshots", { timeout: 45000 }, async t => {
  const srv = await startTestServer(t);
  const runAdmin = (args, stdin) => spawnSync(process.execPath, ["scripts/auth-admin.js", ...args], {
    cwd: ROOT, env: srv.env, encoding: "utf8", timeout: 8000, ...(stdin !== undefined ? { input: stdin } : {}),
  });
  const api = (route, body, cookie, method) => fetch(srv.base + route, {
    method: method || (body ? "POST" : "GET"),
    redirect: "manual",
    headers: { origin: srv.origin, "Content-Type": "application/json", "X-Bojin": "1", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const stopServer = async child => {
    if (child.exitCode === null) {
      const done = new Promise(r => child.once("exit", r));
      child.kill();
      await done;
    }
  };
  const startAgain = async () => {
    const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: srv.env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", d => { err += d; });
    t.after(() => stopServer(child));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("restart timeout " + err)), 8000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(err)); });
    });
    return child;
  };

  // 1. Issue initial phone invite (no user exists yet) and capture a pre-reissue snapshot
  const inv1Res = runAdmin(["invite", "--phone", "13800138333"]);
  assert.equal(inv1Res.status, 0, inv1Res.stderr);
  const inv1 = JSON.parse(inv1Res.stdout);

  await stopServer(srv.child);
  const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-prereissue-snap-"));
  t.after(() => fs.rmSync(snapRoot, { recursive: true, force: true }));
  const preReissueSnap = path.join(snapRoot, "pre-reissue");
  await createSnapshot(srv.dir, preReissueSnap);

  // 2. Restart server, revoke initial invite, and reissue WITHOUT --legacy-user -> UID stays stable
  const child2 = await startAgain();
  assert.equal(runAdmin(["revoke"], inv1.token).status, 0);
  const inv2Res = runAdmin(["invite", "--phone", "+86 138-0013-8333"]);
  assert.equal(inv2Res.status, 0, inv2Res.stderr);
  const inv2 = JSON.parse(inv2Res.stdout);
  assert.equal(inv2.userId, inv1.userId, "reissued phone invite must preserve the original UID");
  assert.notEqual(inv2.token, inv1.token);

  // 3. Enroll with reissued invite, then delete account
  const pw = "prereissue-strong-pass";
  const signUp = await api("/api/auth/sign-up/phone-number", {
    phoneNumber: "+8613800138333", name: "Reissued User", password: pw, invitation: inv2.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  });
  assert.equal(signUp.status, 200, await signUp.clone().text());
  const cookie = signUp.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  assert.equal((await api("/api/auth/delete-user", { password: pw }, cookie)).status, 200);
  await stopServer(child2);

  // 4. Replay deletion ledger against the OLD pre-reissue snapshot (which only had inv1, no user row!)
  const ledger = readLedger(srv.dir);
  const restoredDir = path.join(snapRoot, "restored-pre-reissue");
  restoreSnapshot(preReissueSnap, restoredDir, ledger);

  const restoredAuth = new DatabaseSync(path.join(restoredDir, "auth.sqlite"));
  try {
    for (const { name } of restoredAuth.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const dump = JSON.stringify(restoredAuth.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
      assert.ok(!dump.includes("13800138333"), `pre-reissue snapshot table ${name} retained phone after ledger replay`);
      assert.ok(!dump.includes(inv1.userId), `pre-reissue snapshot table ${name} retained UID after ledger replay`);
    }
  } finally { restoredAuth.close(); }

  // 5. Re-inviting the same phone AFTER deletion creates a brand new UID (never collides with deleted tombstone)
  const invAfterDelRes = runAdmin(["invite", "--phone", "13800138333"]);
  assert.equal(invAfterDelRes.status, 0, invAfterDelRes.stderr);
  const invAfterDel = JSON.parse(invAfterDelRes.stdout);
  assert.notEqual(invAfterDel.userId, inv1.userId);
});

test("explicit-UID / --legacy-user reissues reject conflicting UIDs and preserve stable UID across pre-reissue snapshots for both phone and email", { timeout: 45000 }, async t => {
  const srv = await startTestServer(t);
  const runAdmin = (args, stdin) => spawnSync(process.execPath, ["scripts/auth-admin.js", ...args], {
    cwd: ROOT, env: srv.env, encoding: "utf8", timeout: 8000, ...(stdin !== undefined ? { input: stdin } : {}),
  });
  const api = (route, body, cookie, method) => fetch(srv.base + route, {
    method: method || (body ? "POST" : "GET"),
    redirect: "manual",
    headers: { origin: srv.origin, "Content-Type": "application/json", "X-Bojin": "1", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const stopServer = async child => {
    if (child.exitCode === null) {
      const done = new Promise(r => child.once("exit", r));
      child.kill();
      await done;
    }
  };
  const startAgain = async () => {
    const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: srv.env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", d => { err += d; });
    t.after(() => stopServer(child));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("restart timeout " + err)), 8000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(err)); });
    });
    return child;
  };

  // Seed legacy users in bojin.db
  const legacyDb = new DatabaseSync(path.join(srv.dir, "bojin.db"));
  legacyDb.prepare("INSERT INTO users (id, username, pass, created, mustChange) VALUES (?, ?, 'x', '2025-01-01', 0)").run("u_legacy_phone", "legacy_phone");
  legacyDb.prepare("INSERT INTO users (id, username, pass, created, mustChange) VALUES (?, ?, 'x', '2025-01-01', 0)").run("u_legacy_email", "legacy_email");
  legacyDb.prepare("INSERT INTO users (id, username, pass, created, mustChange) VALUES (?, ?, 'x', '2025-01-01', 0)").run("u_legacy_other", "legacy_other");
  legacyDb.close();

  // 1. Default phone invite cannot later be reassigned to a conflicting --legacy-user UID
  const defPhoneRes = runAdmin(["invite", "--phone", "13800138666"]);
  assert.equal(defPhoneRes.status, 0, defPhoneRes.stderr);
  const conflictPhoneRes = runAdmin(["invite", "--phone", "+86 138-0013-8666", "--legacy-user", "legacy_other"]);
  assert.equal(conflictPhoneRes.status, 1);
  assert.match(conflictPhoneRes.stderr, /different user ID/);

  // 2. Legacy-bound phone and email invites -> take pre-reissue snapshot BEFORE any reissue or enrollment
  const lp1Res = runAdmin(["invite", "--phone", "13800138777", "--legacy-user", "legacy_phone"]);
  assert.equal(lp1Res.status, 0, lp1Res.stderr);
  const lp1 = JSON.parse(lp1Res.stdout);
  assert.equal(lp1.userId, "u_legacy_phone");

  const le1Res = runAdmin(["invite", "Legacy.Owner@Example.com", "--legacy-user", "legacy_email"]);
  assert.equal(le1Res.status, 0, le1Res.stderr);
  const le1 = JSON.parse(le1Res.stdout);
  assert.equal(le1.userId, "u_legacy_email");

  await stopServer(srv.child);
  const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-legacy-reissue-snap-"));
  t.after(() => fs.rmSync(snapRoot, { recursive: true, force: true }));
  const preReissueSnap = path.join(snapRoot, "pre-reissue");
  await createSnapshot(srv.dir, preReissueSnap);

  // 3. Restart server; conflicting --legacy-user fails; matching --legacy-user AND default reissue both preserve the legacy UID
  const child2 = await startAgain();
  assert.equal(runAdmin(["invite", "--phone", "13800138777", "--legacy-user", "legacy_other"]).status, 1);
  assert.equal(runAdmin(["invite", "legacy.owner@example.com", "--legacy-user", "legacy_other"]).status, 1);

  assert.equal(runAdmin(["revoke"], lp1.token).status, 0);
  const lp2Res = runAdmin(["invite", "--phone", "+86 138-0013-8777", "--legacy-user", "legacy_phone"]);
  assert.equal(lp2Res.status, 0, lp2Res.stderr);
  const lp2 = JSON.parse(lp2Res.stdout);
  assert.equal(lp2.userId, "u_legacy_phone");

  // Reissue again WITHOUT --legacy-user -> still keeps u_legacy_phone!
  const lp3Res = runAdmin(["invite", "--phone", "13800138777"]);
  assert.equal(lp3Res.status, 0, lp3Res.stderr);
  const lp3 = JSON.parse(lp3Res.stdout);
  assert.equal(lp3.userId, "u_legacy_phone");
  assert.notEqual(lp3.token, lp2.token);

  // Same for email: default reissue keeps u_legacy_email
  assert.equal(runAdmin(["revoke"], le1.token).status, 0);
  const le2Res = runAdmin(["invite", "legacy.owner@example.com"]);
  assert.equal(le2Res.status, 0, le2Res.stderr);
  const le2 = JSON.parse(le2Res.stdout);
  assert.equal(le2.userId, "u_legacy_email");

  // 4. Enroll both legacy users via their reissued invites, then delete both accounts
  const pw = "legacy-reissue-pass-1";
  const signPhone = await api("/api/auth/sign-up/phone-number", {
    phoneNumber: "+8613800138777", name: "Legacy Phone", password: pw, invitation: lp3.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  });
  assert.equal(signPhone.status, 200, await signPhone.clone().text());
  const phoneCookie = signPhone.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  assert.equal((await api("/api/auth/delete-user", { password: pw }, phoneCookie)).status, 200);

  const signEmail = await api("/api/auth/sign-up/email", {
    email: le2.email, name: "Legacy Email", password: pw, invitation: le2.token,
    callbackURL: "/login.html", consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  });
  assert.equal(signEmail.status, 200, await signEmail.clone().text());
  const vMail = fs.readdirSync(path.join(srv.dir, "mail"))
    .map(f => JSON.parse(fs.readFileSync(path.join(srv.dir, "mail", f), "utf8")))
    .find(m => m.to === le2.email && m.kind === "verify");
  await fetch(vMail.url, { redirect: "manual" });
  const loginEmail = await api("/api/auth/sign-in/email", { email: le2.email, password: pw });
  const emailCookie = loginEmail.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  assert.equal((await api("/api/auth/delete-user", { password: pw }, emailCookie)).status, 200);
  await stopServer(child2);

  // 5. Replay deletion ledger onto the pre-reissue snapshot -> BOTH legacy phone and legacy email invites are erased!
  const ledger = readLedger(srv.dir);
  const restoredDir = path.join(snapRoot, "restored-legacy-pre-reissue");
  restoreSnapshot(preReissueSnap, restoredDir, ledger);

  const restoredAuth = new DatabaseSync(path.join(restoredDir, "auth.sqlite"));
  try {
    for (const { name } of restoredAuth.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const dump = JSON.stringify(restoredAuth.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
      assert.ok(!dump.includes("13800138777"), `pre-reissue snapshot table ${name} retained legacy phone`);
      assert.ok(!dump.includes("u_legacy_phone"), `pre-reissue snapshot table ${name} retained legacy phone UID`);
      assert.ok(!dump.includes("legacy.owner@example.com"), `pre-reissue snapshot table ${name} retained legacy email`);
      assert.ok(!dump.includes("u_legacy_email"), `pre-reissue snapshot table ${name} retained legacy email UID`);
    }
    // Unrelated pending default phone invite (13800138666) was not deleted and remains intact
    assert.ok(restoredAuth.prepare("SELECT 1 FROM launch_invites WHERE phone=?").get("+8613800138666"));
  } finally { restoredAuth.close(); }
});

test("cold-start unknown phone login performs equivalent lookup and single password verification without lazy hash overhead", { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-phone-timing-"));
  const svc = await createAuth({
    dataDir, baseURL: "http://localhost:8080",
    secret: "phone-timing-test-secret-at-least-32!!", cookieSecure: false,
    sendEmail: async () => {},
  });
  t.after(() => { svc.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  const post = (route, ip, body) => svc.auth.handler(new Request("http://localhost:8080/api/auth/" + route, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ritual-client-ip": ip, origin: "http://localhost:8080" },
    body: JSON.stringify(body),
  }));

  // Enroll one real phone user
  const inv = svc.invites.issuePhone("+8613800138444");
  assert.equal((await post("sign-up/phone-number", "192.0.2.1", {
    phoneNumber: inv.phone, name: "Timing", password: "correct-password-123", invitation: inv.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION,
  })).status, 200);

  // Instrument password.hash, password.verify, and findCredentialAccount on the live Better Auth context
  const authCtx = await svc.auth.$context;
  const counts = { hash: 0, verify: 0, credLookup: 0 };
  const origHash = authCtx.password.hash.bind(authCtx.password);
  const origVerify = authCtx.password.verify.bind(authCtx.password);
  const origFindCred = authCtx.internalAdapter.findCredentialAccount.bind(authCtx.internalAdapter);
  authCtx.password.hash = async (...args) => { counts.hash++; return origHash(...args); };
  authCtx.password.verify = async (...args) => { counts.verify++; return origVerify(...args); };
  authCtx.internalAdapter.findCredentialAccount = async (...args) => { counts.credLookup++; return origFindCred(...args); };

  // First-ever unknown-number login (cold start): 0 hashes, 1 credential lookup, 1 password verify
  const unknownRes = await post("sign-in/phone-number", "192.0.2.2", { phoneNumber: "+8613800138999", password: "wrong-password-123" });
  assert.equal(unknownRes.status, 401);
  assert.deepEqual(counts, { hash: 0, verify: 1, credLookup: 1 });

  // Reset counters and compare against wrong-password login on existing account: identical work
  counts.hash = 0; counts.verify = 0; counts.credLookup = 0;
  const wrongPwRes = await post("sign-in/phone-number", "192.0.2.3", { phoneNumber: "+8613800138444", password: "wrong-password-123" });
  assert.equal(wrongPwRes.status, 401);
  assert.deepEqual(counts, { hash: 0, verify: 1, credLookup: 1 });
});

test("consent revision 2026-11-25 is required for new sign-ups and phone accounts while grandfathered 2026-11-24 email accounts stay unlocked", { timeout: 30000 }, async t => {
  assert.equal(CONSENT_VERSION, "2026-11-25");
  assert.equal(isConsentSatisfied({ consentVersion: "2026-11-25", phoneNumber: null }), true);
  assert.equal(isConsentSatisfied({ consentVersion: "2026-11-25", phoneNumber: "+8613800138000" }), true);
  assert.equal(isConsentSatisfied({ consentVersion: "2026-11-24", phoneNumber: null }), true);
  assert.equal(isConsentSatisfied({ consentVersion: "2026-11-24", phoneNumber: "+8613800138000" }), false);
  assert.equal(isConsentSatisfied({ consentVersion: null, phoneNumber: null }), false);

  const srv = await startTestServer(t);
  const runAdmin = args => {
    const r = spawnSync(process.execPath, ["scripts/auth-admin.js", ...args], {
      cwd: ROOT, env: srv.env, encoding: "utf8", timeout: 8000,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const api = (route, body, cookie) => fetch(srv.base + route, {
    method: body ? "POST" : "GET",
    redirect: "manual",
    headers: { origin: srv.origin, "Content-Type": "application/json", "X-Bojin": "1", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const emailInv = runAdmin(["invite", "grandfathered@example.com"]);
  const phoneInv = runAdmin(["invite", "--phone", "13800138555"]);
  const pw = "consent-rev-strong-pass";

  // Both new email AND new phone signups reject the previous 2026-11-24 revision (409) without consuming invites
  assert.equal((await api("/api/auth/sign-up/email", {
    email: emailInv.email, name: "GF", password: pw, invitation: emailInv.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-24",
  })).status, 409);
  assert.equal((await api("/api/auth/sign-up/phone-number", {
    phoneNumber: phoneInv.phone, name: "PH", password: pw, invitation: phoneInv.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-24",
  })).status, 409);

  // Sign up both with 2026-11-25
  assert.equal((await api("/api/auth/sign-up/email", {
    email: emailInv.email, name: "GF", password: pw, invitation: emailInv.token,
    callbackURL: "/login.html", consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-25",
  })).status, 200);
  const mail = fs.readdirSync(path.join(srv.dir, "mail"))
    .map(f => JSON.parse(fs.readFileSync(path.join(srv.dir, "mail", f), "utf8")))
    .find(m => m.to === emailInv.email && m.kind === "verify");
  await fetch(mail.url, { redirect: "manual" });
  const emailLogin = await api("/api/auth/sign-in/email", { email: emailInv.email, password: pw });
  const emailCookie = emailLogin.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");

  const phoneSign = await api("/api/auth/sign-up/phone-number", {
    phoneNumber: phoneInv.phone, name: "PH", password: pw, invitation: phoneInv.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-25",
  });
  assert.equal(phoneSign.status, 200);
  const phoneCookie = phoneSign.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");

  // Simulate both users having previously recorded 2026-11-24:
  // Email-only user stays unlocked with recorded 2026-11-24; phone user IS gated!
  const authDb = new DatabaseSync(path.join(srv.dir, "auth.sqlite"));
  authDb.prepare("UPDATE user SET consentVersion = '2026-11-24' WHERE id IN (?, ?)").run(emailInv.userId, phoneInv.userId);
  authDb.close();

  const meEmail = await (await api("/api/me", null, emailCookie)).json();
  assert.equal(meEmail.consentVersion, "2026-11-24");
  assert.equal(meEmail.consentRequired, false);
  assert.equal((await api(`/api/doc?path=data/users/${emailInv.userId}/app/app/profile`, null, emailCookie)).status, 200);

  const mePhone = await (await api("/api/me", null, phoneCookie)).json();
  assert.equal(mePhone.consentVersion, "2026-11-24");
  assert.equal(mePhone.consentRequired, true);
  assert.equal((await api(`/api/doc?path=data/users/${phoneInv.userId}/app/app/profile`, null, phoneCookie)).status, 403);
});

test("headless Chromium browser smoke: phone path in zh and en at phone width (390x844), axe-core clean", { timeout: 90000 }, async t => {
  const pw = loadPlaywright();
  if (!pw) {
    t.skip("Playwright Chromium not available in this environment");
    return;
  }

  const srv = await startTestServer(t);
  const axeSource = fs.readFileSync(AXE_PATH, "utf8");
  const shotDir = process.env.PHONE_SCREENSHOT_DIR ? path.resolve(process.env.PHONE_SCREENSHOT_DIR) : null;
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
  const snap = async (page, name) => {
    if (!shotDir) return;
    await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: true });
  };

  const runAdmin = args => {
    const r = spawnSync(process.execPath, ["scripts/auth-admin.js", ...args], {
      cwd: ROOT, env: srv.env, encoding: "utf8", timeout: 8000,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  const browser = await pw.chromium.launch({ executablePath: pw.executablePath, headless: true, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); });

  async function assertAxeClean(context, page, label) {
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Runtime.evaluate", { expression: axeSource, awaitPromise: false });
      const res = await cdp.send("Runtime.evaluate", {
        expression: `window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
          rules: { 'target-size': { enabled: true } }
        }).then(r => JSON.stringify(r.violations))`,
        awaitPromise: true,
        returnByValue: true,
      });
      assert.deepEqual(JSON.parse(res.result.value), [], `Axe violations on ${label}`);
    } finally {
      await cdp.detach();
    }
  }

  // --- ZH phone flow ---
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
    const page = await context.newPage();
    const cspViolations = [];
    const pageErrors = [];
    await page.exposeFunction("recordPhoneCspZh", v => cspViolations.push(v));
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", e => window.recordPhoneCspZh(`${e.violatedDirective}: ${e.blockedURI}`)));
    page.on("pageerror", e => pageErrors.push(e.message));

    const invZh = runAdmin(["invite", "--phone", "13800138201"]);
    const pass1 = "zh-phone-pass-1234";
    const pass2 = "zh-phone-pass-5678";

    // 1. Open phone invite link -> prefilled phone & invite, consent checkboxes unticked, resend hidden, phone-specific consent text
    await page.goto(invZh.url);
    assert.equal(await page.locator("#ph").inputValue(), "+8613800138201");
    assert.equal(await page.locator("#i").inputValue(), invZh.token);
    assert.equal(await page.locator("#resend").isVisible(), false);
    const zhPhoneConsent = await page.locator("#c-terms-post").textContent();
    assert.match(zhPhoneConsent, /2026-11-25/);
    assert.match(zhPhoneConsent, /受邀资格绑定.*独立渠道/);
    assert.ok(!zhPhoneConsent.includes("接收你的邮箱地址"), "phone signup must not show Resend email-receiving disclosure");
    await assertAxeClean(context, page, "phone-signup-zh");
    await snap(page, "phone-signup-zh");

    // 2. Complete phone signup -> goes straight into setup (no email verification!)
    await page.locator("#n").fill("王阿姨");
    await page.locator("#p").fill(pass1);
    await page.locator("#c-terms").check();
    await page.locator("#c-sensitive").check();
    await page.locator("#go").click();
    await page.locator("#setup").waitFor({ state: "visible" });

    // Complete setup and verify Me tab shows phone number
    await page.locator("#f-age").fill("62");
    await page.locator("#f-height").fill("160");
    await page.locator("#f-weight").fill("56");
    await page.locator('button[type="submit"]').click();
    await page.locator("nav#tabs").waitFor({ state: "visible" });
    await page.locator('nav#tabs [data-act="tab"][data-v="me"]').click();
    await page.getByText("+8613800138201", { exact: true }).waitFor({ state: "visible" });

    // 3. Sign out -> switch to phone tab -> test forgot password message -> wrong password -> valid login
    await page.locator('[data-act="logout"]').click();
    await page.waitForURL("**/login.html");
    await page.locator('#method-tabs [data-method="phone"]').click();
    await assertAxeClean(context, page, "phone-login-zh");
    await snap(page, "phone-login-zh");

    await page.locator("#forgot").click();
    await page.getByText("请联系邀请你的人重置密码", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#go").isVisible(), false);
    await assertAxeClean(context, page, "phone-forgot-zh");
    await snap(page, "phone-forgot-zh");

    // Back to login: wrong password shows generic message
    await page.locator('#tabs [data-m="login"]').click();
    await page.locator("#ph").fill("138 0013 8201");
    await page.locator("#p").fill("wrong-pass-999");
    await page.locator("#go").click();
    await page.getByText("手机号或密码错误。", { exact: true }).waitFor({ state: "visible" });

    // Valid login with 11-digit mainland number succeeds
    await page.locator("#p").fill(pass1);
    await page.locator("#go").click();
    await page.locator("nav#tabs").waitFor({ state: "visible" });

    // 4. Admin reset link flow in browser
    const resetLink = runAdmin(["reset-password", "--phone", "13800138201"]);
    await page.goto(resetLink.url);
    await page.locator("#p").fill(pass2);
    await page.locator("#go").click();
    await page.getByText("密码已更新，请重新登录。", { exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator("#ph").isVisible(), true, "should remain on phone login after phone password reset");
    await page.locator("#ph").fill("13800138201");
    await page.locator("#p").fill(pass2);
    await page.locator("#go").click();
    await page.locator("nav#tabs").waitFor({ state: "visible" });

    assert.deepEqual(cspViolations, []);
    assert.deepEqual(pageErrors, []);
    await context.close();
  }

  // --- EN phone flow ---
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
    const page = await context.newPage();
    const cspViolations = [];
    const pageErrors = [];
    await page.exposeFunction("recordPhoneCspEn", v => cspViolations.push(v));
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", e => window.recordPhoneCspEn(`${e.violatedDirective}: ${e.blockedURI}`)));
    page.on("pageerror", e => pageErrors.push(e.message));

    const textExcludingLangToggle = () => page.evaluate(() => {
      const clone = (document.querySelector("main") || document.body).cloneNode(true);
      clone.querySelectorAll('script, style, #lang-switch, [data-act="lang"], [hidden]').forEach(el => el.remove());
      return clone.textContent;
    });

    const invEn = runAdmin(["invite", "--phone", "+14155552699"]);
    const passEn = "en-phone-pass-1234";

    await page.goto(invEn.url);
    assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
    assert.equal(await page.locator("#ph").inputValue(), "+14155552699");
    assert.equal(await page.locator("#resend").isVisible(), false);
    const enPhoneConsent = await page.locator("#c-terms-post").textContent();
    assert.match(enPhoneConsent, /2026-11-25/);
    assert.match(enPhoneConsent, /operator-assisted one-time password recovery after out-of-band identity verification/i);
    assert.ok(!enPhoneConsent.includes("receives your email address"), "EN phone signup must not show Resend email-receiving disclosure");
    assert.doesNotMatch(await textExcludingLangToggle(), CJK_RE);
    await assertAxeClean(context, page, "phone-signup-en");
    await snap(page, "phone-signup-en");

    // Sign up in EN -> goes straight to setup
    await page.locator("#n").fill("Grandpa Lee");
    await page.locator("#p").fill(passEn);
    await page.locator("#c-terms").check();
    await page.locator("#c-sensitive").check();
    await page.locator("#go").click();
    await page.locator("#setup").waitFor({ state: "visible" });
    assert.doesNotMatch(await textExcludingLangToggle(), CJK_RE);

    // Complete setup -> sign out -> phone login & forgot password in EN
    await page.locator("#f-age").fill("68");
    await page.locator("#f-height").fill("172");
    await page.locator("#f-weight").fill("68");
    await page.locator('button[type="submit"]').click();
    await page.locator("nav#tabs").waitFor({ state: "visible" });
    await page.locator('nav#tabs [data-act="tab"][data-v="me"]').click();
    await page.getByText("+14155552699", { exact: true }).waitFor({ state: "visible" });
    assert.doesNotMatch(await textExcludingLangToggle(), CJK_RE);

    await page.locator('[data-act="logout"]').click();
    await page.waitForURL("**/login.html");
    await page.locator('#method-tabs [data-method="phone"]').click();
    assert.doesNotMatch(await textExcludingLangToggle(), CJK_RE);
    await assertAxeClean(context, page, "phone-login-en");
    await snap(page, "phone-login-en");

    await page.locator("#forgot").click();
    await page.getByText("Ask the person who invited you to reset your password", { exact: true }).waitFor({ state: "visible" });
    assert.doesNotMatch(await textExcludingLangToggle(), CJK_RE);
    await assertAxeClean(context, page, "phone-forgot-en");
    await snap(page, "phone-forgot-en");

    await page.locator('#tabs [data-m="login"]').click();
    await page.locator("#ph").fill("+1 415-555-2699");
    await page.locator("#p").fill("wrong-pass-999");
    await page.locator("#go").click();
    await page.getByText("Incorrect phone number or password.", { exact: true }).waitFor({ state: "visible" });

    await page.locator("#p").fill(passEn);
    await page.locator("#go").click();
    await page.locator("nav#tabs").waitFor({ state: "visible" });

    assert.deepEqual(cspViolations, []);
    assert.deepEqual(pageErrors, []);
    await context.close();
  }
});
