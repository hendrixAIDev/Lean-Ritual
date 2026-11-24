"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createMailer, renderEmail } = require("../lib/mail");
const { createAuth } = require("../lib/auth");

const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;

function readMailFiles(dataDir) {
  const dir = path.join(dataDir, "mail");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

test("mail fails closed and development messages stay in private files", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-mail-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const local = { dataDir, baseURL: "http://localhost:8080" };
  assert.throws(() => createMailer({}, local), /MAIL_MODE/);
  assert.throws(() => createMailer({ MAIL_MODE: "smtp" }, local), /SMTP_HOST/);
  assert.throws(() => createMailer({ MAIL_MODE: "file" }, { dataDir, baseURL: "https://ritual.example" }), /localhost/);
  const send = createMailer({ MAIL_MODE: "file" }, local);
  const message = { to: "private@example.com", kind: "verify", url: "http://localhost:8080/secret" };
  await send(message);
  const file = path.join(dataDir, "mail", fs.readdirSync(path.join(dataDir, "mail"))[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), message);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("nodemailer envelope parsing preserves CFWS domains and UTS-46 IDN mapping", async () => {
  const nodemailer = require("nodemailer");
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const cfws = await transport.sendMail({
    from: "noreply@leanritual.app",
    to: "user@sub.(comment)example.com",
    subject: "Verify",
    text: "body",
  });
  assert.deepEqual(cfws.envelope.to, ["user@sub.example.com"]);

  const idn = await transport.sendMail({
    from: "noreply@leanritual.app",
    to: "user@fa\u1e9e.de",
    subject: "Verify",
    text: "body",
  });
  assert.deepEqual(idn.envelope.to, ["user@xn--fa-hia.de"]);
});

test("renderEmail formats zh and en verification/reset emails while keeping URLs intact and defaulting to zh", () => {
  const verifyUrl = "http://localhost:8080/api/auth/verify-email?token=tok_123&callbackURL=%2Flogin.html%3Fverified%3D1";
  const resetUrl = "http://localhost:8080/api/auth/reset-password/rst_456?callbackURL=%2Flogin.html";

  const enVerify = renderEmail({ kind: "verify", url: verifyUrl, lang: "en" });
  assert.equal(enVerify.lang, "en");
  assert.equal(enVerify.subject, "Lean Ritual · Verify your email");
  assert.ok(enVerify.text.includes(verifyUrl));
  assert.doesNotMatch(enVerify.subject, CJK_RE);
  assert.doesNotMatch(enVerify.text, CJK_RE);

  const enReset = renderEmail({ kind: "reset", url: resetUrl, lang: "EN" });
  assert.equal(enReset.lang, "en");
  assert.equal(enReset.subject, "Lean Ritual · Reset your password");
  assert.ok(enReset.text.includes(resetUrl));
  assert.doesNotMatch(enReset.subject, CJK_RE);
  assert.doesNotMatch(enReset.text, CJK_RE);

  for (const fallback of [undefined, null, "", "zh", "fr", "<script>"]) {
    const zhVerify = renderEmail({ kind: "verify", url: verifyUrl, lang: fallback });
    assert.equal(zhVerify.lang, "zh");
    assert.equal(zhVerify.subject, "Lean Ritual · 验证邮箱");
    assert.ok(zhVerify.text.includes(verifyUrl));
    assert.match(zhVerify.text, /请点击链接验证邮箱/);

    const zhReset = renderEmail({ kind: "reset", url: resetUrl, lang: fallback });
    assert.equal(zhReset.lang, "zh");
    assert.equal(zhReset.subject, "Lean Ritual · 重置密码");
    assert.ok(zhReset.text.includes(resetUrl));
    assert.match(zhReset.text, /请点击链接重置密码/);
  }
});

test("Better Auth email hooks with MAIL_MODE=file honor profile.lang > request UI lang > zh default and preserve links", { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-mail-lang-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const baseURL = "http://localhost:8080";
  const profileLangByUid = new Map();
  const sendEmail = createMailer({ MAIL_MODE: "file" }, { dataDir, baseURL });
  const service = await createAuth({
    dataDir,
    baseURL,
    secret: "mail-lang-test-secret-long-enough-123456789",
    cookieSecure: false,
    sendEmail,
    getUserLang: user => profileLangByUid.get(user.id) ?? null,
  });
  t.after(() => service.close());

  let ipSeq = 1;
  const authReq = (route, body, extraHeaders = {}) => service.auth.handler(new Request(`${baseURL}/api/auth/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseURL,
      "x-ritual-client-ip": `198.51.100.${ipSeq++}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  }));

  const password = "strong-mail-lang-password";

  // 1. Sign-up before profile exists with X-Ritual-Lang: en -> English verification email, link works
  const invEn = service.invites.issue("en-signup@example.com");
  const rEn = await authReq("sign-up/email", {
    email: invEn.email, name: "Alex", password, invitation: invEn.token, callbackURL: "/login.html?verified=1",
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-24"
  }, { "x-ritual-lang": "en" });
  assert.equal(rEn.status, 200);
  let mail = readMailFiles(dataDir).find(m => m.to === invEn.email && m.kind === "verify");
  assert.ok(mail);
  assert.equal(mail.lang, "en");
  assert.equal(mail.subject, "Lean Ritual · Verify your email");
  assert.doesNotMatch(mail.text, CJK_RE);
  assert.ok(mail.text.includes(mail.url));

  // Resend verification in zh before profile exists -> Chinese verification email
  const rResendZh = await authReq("send-verification-email", {
    email: invEn.email, callbackURL: "/login.html?verified=1"
  }, { "x-ritual-lang": "zh" });
  assert.equal(rResendZh.status, 200);
  const resendMail = readMailFiles(dataDir).filter(m => m.to === invEn.email && m.kind === "verify").at(-1);
  assert.equal(resendMail.lang, "zh");
  assert.equal(resendMail.subject, "Lean Ritual · 验证邮箱");

  // Verify account using the original English email link (tokens/links unchanged)
  assert.equal((await service.auth.handler(new Request(mail.url))).status, 302);

  // 2. Once profile.lang = 'en' exists, password reset uses 'en' even if request header says 'zh' or is omitted
  profileLangByUid.set(invEn.userId, "en");
  assert.equal((await authReq("request-password-reset", { email: invEn.email, redirectTo: "/login.html" }, { "x-ritual-lang": "zh" })).status, 200);
  const resetEn = readMailFiles(dataDir).filter(m => m.to === invEn.email && m.kind === "reset").at(-1);
  assert.equal(resetEn.lang, "en");
  assert.equal(resetEn.subject, "Lean Ritual · Reset your password");
  assert.doesNotMatch(resetEn.text, CJK_RE);
  const resetToken = new URL(resetEn.url).pathname.split("/").pop();
  const newPassword = "updated-strong-mail-password";
  assert.equal((await authReq("reset-password", { token: resetToken, newPassword })).status, 200);

  // 3. When profile.lang = 'zh', password reset uses 'zh' even if request header says 'en'
  profileLangByUid.set(invEn.userId, "zh");
  assert.equal((await authReq("request-password-reset", { email: invEn.email, redirectTo: "/login.html" }, { "x-ritual-lang": "en" })).status, 200);
  const resetZh = readMailFiles(dataDir).filter(m => m.to === invEn.email && m.kind === "reset").at(-1);
  assert.equal(resetZh.lang, "zh");
  assert.equal(resetZh.subject, "Lean Ritual · 重置密码");

  // 4. Browser Accept-Language fallback (when X-Ritual-Lang is absent) and invalid X-Ritual-Lang validation -> 'zh'
  const invAccept = service.invites.issue("accept-en@example.com");
  assert.equal((await authReq("sign-up/email", {
    email: invAccept.email, name: "Taylor", password, invitation: invAccept.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-24"
  }, { "accept-language": "en-US,en;q=0.9" })).status, 200);
  assert.equal(readMailFiles(dataDir).find(m => m.to === invAccept.email).lang, "en");

  const invInvalid = service.invites.issue("invalid-lang@example.com");
  assert.equal((await authReq("sign-up/email", {
    email: invInvalid.email, name: "Jordan", password, invitation: invInvalid.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-24"
  }, { "x-ritual-lang": "fr", "accept-language": "en-US" })).status, 200);
  const invalidMail = readMailFiles(dataDir).find(m => m.to === invInvalid.email);
  assert.equal(invalidMail.lang, "zh");
  assert.equal(invalidMail.subject, "Lean Ritual · 验证邮箱");
});

test("server.js end-to-end email language uses request UI lang on sign-up and stored profile.lang on password reset", { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-srv-mail-"));
  const root = path.resolve(__dirname, "..");
  const env = {
    ...process.env,
    DATA_DIR: dir,
    PORT: "0",
    HOST: "127.0.0.1",
    AUTH_BASE_URL: "http://127.0.0.1:8080",
    AUTH_SECRET: "server-mail-lang-test-secret-at-least-32-chars",
    COOKIE_SECURE: "0",
    TRUST_PROXY: "0",
    MAIL_MODE: "file",
    OPENROUTER_API_KEY: "",
  };
  const issued = spawnSync(process.execPath, ["scripts/auth-admin.js", "invite", "e2e-en@example.com"], {
    cwd: root, env, encoding: "utf8", timeout: 5000,
  });
  assert.equal(issued.status, 0, issued.stderr);
  const invite = JSON.parse(issued.stdout);

  const child = spawn(process.execPath, ["server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timeout " + stderr)), 8000);
    child.stdout.once("data", d => { clearTimeout(timer); resolve(d.toString()); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
  });
  const port = started.match(/:(\d+)/)[1];
  const liveBase = `http://127.0.0.1:${port}`;
  const originHeader = "http://127.0.0.1:8080";
  const password = "server-e2e-strong-password";

  const signupRes = await fetch(`${liveBase}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: originHeader, "Content-Type": "application/json", "X-Ritual-Lang": "en" },
    body: JSON.stringify({ email: invite.email, name: "Alex", password, invitation: invite.token, callbackURL: "/login.html?verified=1", consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-24" }),
  });
  assert.equal(signupRes.status, 200);
  const verifyMail = readMailFiles(dir).find(m => m.to === invite.email && m.kind === "verify");
  assert.equal(verifyMail.lang, "en");
  assert.equal(verifyMail.subject, "Lean Ritual · Verify your email");

  const verifyUrl = new URL(verifyMail.url);
  const verifyRes = await fetch(`${liveBase}${verifyUrl.pathname}${verifyUrl.search}`, { redirect: "manual" });
  assert.equal(verifyRes.status, 302);

  const loginRes = await fetch(`${liveBase}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: originHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ email: invite.email, password }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");

  const putRes = await fetch(`${liveBase}/api/doc?path=${encodeURIComponent(`data/users/${invite.userId}/app/app/profile`)}`, {
    method: "PUT",
    headers: { origin: originHeader, cookie, "X-Bojin": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ data: { weight: 72, lang: "en" } }),
  });
  assert.equal(putRes.status, 200);

  // Request password reset WITHOUT X-Ritual-Lang -> server looks up profile.lang === 'en'
  const resetReq = await fetch(`${liveBase}/api/auth/request-password-reset`, {
    method: "POST",
    headers: { origin: originHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ email: invite.email, redirectTo: "/login.html" }),
  });
  assert.equal(resetReq.status, 200);
  const resetMail = readMailFiles(dir).find(m => m.to === invite.email && m.kind === "reset");
  assert.equal(resetMail.lang, "en");
  assert.equal(resetMail.subject, "Lean Ritual · Reset your password");
  assert.doesNotMatch(resetMail.text, CJK_RE);
});
