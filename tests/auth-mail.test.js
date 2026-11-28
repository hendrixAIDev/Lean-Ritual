"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createMailer, renderEmail, parseSingleMailbox, resolveReplyTo, validateActionUrl, extractDomain, DEFAULT_REPLY_TO } = require("../lib/mail");
const { createAuth } = require("../lib/auth");

const CJK_RE = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;

function extractHttpUrls(str) {
  return [...String(str).matchAll(/https?:\/\/[^\s"'<>]+/gi)].map(m => m[0].replace(/&amp;/g, "&"));
}

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
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-25"
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
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-25"
  }, { "accept-language": "en-US,en;q=0.9" })).status, 200);
  assert.equal(readMailFiles(dataDir).find(m => m.to === invAccept.email).lang, "en");

  const invInvalid = service.invites.issue("invalid-lang@example.com");
  assert.equal((await authReq("sign-up/email", {
    email: invInvalid.email, name: "Jordan", password, invitation: invInvalid.token,
    consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-25"
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
    body: JSON.stringify({ email: invite.email, name: "Alex", password, invitation: invite.token, callbackURL: "/login.html?verified=1", consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-25" }),
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
  assert.doesNotMatch(resetMail.html, CJK_RE);
  assert.equal(resetMail.replyTo, DEFAULT_REPLY_TO);
});

test("renderEmail produces clean HTML and plain-text parts with branded header, single button, plain-text link, reason, footer, and no images or external links", () => {
  const verifyUrl = "https://leanritual.app/api/auth/verify-email?token=tok_abc123&callbackURL=%2Flogin.html%3Fverified%3D1";
  const resetUrl = "https://leanritual.app/api/auth/reset-password/rst_xyz789?callbackURL=%2Flogin.html";

  const cases = [
    { kind: "verify", lang: "zh", url: verifyUrl, header: "Lean Ritual · 薄肌日课", button: "验证邮箱", operator: "杰瑞智能技术服务部", reasonRe: /你收到这封邮件/ },
    { kind: "reset", lang: "zh", url: resetUrl, header: "Lean Ritual · 薄肌日课", button: "重置密码", operator: "杰瑞智能技术服务部", reasonRe: /你收到这封邮件/ },
    { kind: "verify", lang: "en", url: verifyUrl, header: "Lean Ritual", button: "Verify email", operator: "Jierui Intelligent Technology Service Department", reasonRe: /You received this email/ },
    { kind: "reset", lang: "en", url: resetUrl, header: "Lean Ritual", button: "Reset password", operator: "Jierui Intelligent Technology Service Department", reasonRe: /You received this email/ },
  ];

  for (const c of cases) {
    const rendered = renderEmail({ kind: c.kind, url: c.url, lang: c.lang });
    const escapedUrl = c.url.replace(/&/g, "&amp;");

    // Plain-text part
    assert.ok(rendered.text.includes(c.url), `${c.lang}/${c.kind} text should include exact URL`);
    assert.ok(rendered.text.includes(c.operator), `${c.lang}/${c.kind} text should include operator`);
    assert.ok(rendered.text.includes(DEFAULT_REPLY_TO), `${c.lang}/${c.kind} text should include contact email`);
    assert.match(rendered.text, c.reasonRe);

    // HTML part structure and content
    assert.match(rendered.html, /^<!doctype html>/i);
    assert.ok(rendered.html.includes(c.header), `${c.lang}/${c.kind} html should include branded header`);
    assert.ok(rendered.html.includes(`>${c.button}</a>`), `${c.lang}/${c.kind} html should include clear button`);
    assert.ok(rendered.html.includes(`href="${escapedUrl}"`), `${c.lang}/${c.kind} html button should link to escaped URL`);
    assert.ok(rendered.html.includes(`>${escapedUrl}</p>`), `${c.lang}/${c.kind} html should also show the same URL as plain text`);
    assert.ok(rendered.html.includes(c.operator), `${c.lang}/${c.kind} html footer should include operator`);
    assert.ok(rendered.html.includes(`mailto:${DEFAULT_REPLY_TO}`), `${c.lang}/${c.kind} html footer should include contact email`);
    assert.match(rendered.html, c.reasonRe);

    // No images, SVGs, scripts, iframes, tracking pixels, or external HTTP links
    assert.doesNotMatch(rendered.html, /<(img|svg|script|iframe|form|style)\b/i);
    const httpAnchors = [...rendered.html.matchAll(/<a\b[^>]*\bhref="https?:\/\/[^"]*"/gi)];
    assert.equal(httpAnchors.length, 1, `${c.lang}/${c.kind} should have exactly one HTTP(S) button link`);
    for (const foundUrl of [...extractHttpUrls(rendered.text), ...extractHttpUrls(rendered.html)]) {
      assert.equal(new URL(foundUrl).hostname, "leanritual.app", `all HTTP links must stay on leanritual.app, found ${foundUrl}`);
    }

    if (c.lang === "en") {
      assert.doesNotMatch(rendered.subject, CJK_RE);
      assert.doesNotMatch(rendered.text, CJK_RE);
      assert.doesNotMatch(rendered.html, CJK_RE);
    }
  }

  // HTML escaping on validated same-origin URLs; whitespace and non-HTTP(S) schemes are refused before rendering
  const querySpecials = 'https://leanritual.app/api/auth/verify-email?token=1"&x=<script>';
  const safeRendered = renderEmail({ kind: "verify", url: querySpecials, lang: "en" });
  assert.doesNotMatch(safeRendered.html, /<script>/i);
  assert.ok(safeRendered.text.includes("https://leanritual.app/api/auth/verify-email?token=1%22&x=%3Cscript%3E"));
  assert.ok(safeRendered.html.includes("https://leanritual.app/api/auth/verify-email?token=1%22&amp;x=%3Cscript%3E"));

  for (const badUrl of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/api/auth/verify-email?token=abc",
    "",
    "   ",
    "http://leanritual.app/api/auth/verify-email?token=abc",
    "https://evil.example/api/auth/verify-email?token=abc",
    "https://leanritual.app.evil.example/api/auth/verify-email?token=abc",
    "https://leanritual.app@evil.example/api/auth/verify-email?token=abc",
    "https://user:pass@leanritual.app/api/auth/verify-email?token=abc",
    "https://leanritual.app:8443/api/auth/verify-email?token=abc",
    "https://leanritual.app/api/auth/verify-email?token=abc\r\nX-Inject: 1",
    'https://leanritual.app/api/auth/verify-email?token=1" onclick="alert(1)',
  ]) {
    assert.throws(() => validateActionUrl(badUrl, "https://leanritual.app"), /Invalid email action URL/, `should reject ${badUrl}`);
    assert.throws(() => renderEmail({ kind: "verify", url: badUrl, lang: "en" }), /Invalid email action URL/, `renderEmail should reject ${badUrl}`);
  }
});

test("send boundary enforces trusted origin in both SMTP and file modes while preserving localhost dev", async t => {
  const smtpEnv = {
    MAIL_MODE: "smtp",
    SMTP_HOST: "smtp.resend.com",
    SMTP_PORT: "465",
    SMTP_USER: "resend",
    SMTP_PASS: "re_test_key",
    MAIL_FROM: "Lean Ritual <noreply@leanritual.app>",
  };

  // Non-HTTPS public baseURL is refused at mailer creation
  assert.throws(() => createMailer(smtpEnv, { baseURL: "http://leanritual.app" }), /HTTPS origin/);

  let sendCalled = 0;
  const logs = [];
  const sendProd = createMailer(smtpEnv, {
    baseURL: "https://leanritual.app",
    transport: { async sendMail() { sendCalled++; return { response: "250 OK" }; } },
    log: line => logs.push(line),
  });
  const badUrl = "https://evil.example/api/auth/verify-email?token=tok_phish_123";
  const recipient = "victim.secret@163.com";
  await assert.rejects(
    () => sendProd({ to: recipient, kind: "verify", url: badUrl, lang: "zh" }),
    err => {
      assert.equal(err.code, "INVALID_ACTION_URL");
      assert.ok(!err.message.includes(badUrl));
      assert.ok(!err.message.includes(recipient));
      assert.equal(err.cause, undefined);
      return true;
    }
  );
  assert.equal(sendCalled, 0, "transport.sendMail must not be called for disallowed origin");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^mail status=error type=verify recipient_domain=163\.com message_id=<[0-9a-f-]+@leanritual\.app> smtp_code=none error_code=INVALID_ACTION_URL$/);
  assert.ok(!logs[0].includes("evil.example"));
  assert.ok(!logs[0].includes("victim.secret"));
  assert.ok(!logs[0].includes("tok_phish_123"));

  // Explicit localhost development origin still works, and rejects mismatched localhost ports or external hosts
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-mail-origin-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const sendFile = createMailer({ MAIL_MODE: "file" }, { dataDir, baseURL: "http://127.0.0.1:18080" });
  await sendFile({ to: "dev@example.com", kind: "verify", url: "http://127.0.0.1:18080/api/auth/verify-email?token=dev_ok", lang: "en" });
  assert.equal(readMailFiles(dataDir).length, 1);
  await assert.rejects(
    () => sendFile({ to: "dev@example.com", kind: "verify", url: "http://127.0.0.1:19999/api/auth/verify-email?token=wrong_port", lang: "en" }),
    /Invalid email action URL/
  );
  await assert.rejects(
    () => sendFile({ to: "dev@example.com", kind: "verify", url: "https://evil.example/phish", lang: "en" }),
    /Invalid email action URL/
  );
  assert.equal(readMailFiles(dataDir).length, 1);
});

test("SMTP mailer sends multipart/alternative with strict single-mailbox Reply-To, unchanged From, domain Message-ID, and no List-Unsubscribe", async () => {
  const nodemailer = require("nodemailer");
  const baseEnv = {
    MAIL_MODE: "smtp",
    SMTP_HOST: "smtp.resend.com",
    SMTP_PORT: "465",
    SMTP_USER: "resend",
    SMTP_PASS: "re_test_key",
    MAIL_FROM: "Lean Ritual <noreply@leanritual.app>",
  };

  // Default Reply-To falls back silently to privacy contact email
  const logsDefault = [];
  const warnsDefault = [];
  const streamTransport1 = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const sendDefault = createMailer(baseEnv, {
    baseURL: "https://leanritual.app",
    transport: streamTransport1,
    log: line => logsDefault.push(line),
    warn: line => warnsDefault.push(line),
  });
  const verifyUrl = "https://leanritual.app/api/auth/verify-email?token=tok_secret_999&callbackURL=%2Flogin.html%3Fverified%3D1";
  const info1 = await sendDefault({ to: "tester@163.com", kind: "verify", url: verifyUrl, lang: "zh" });
  const raw1 = info1.message.toString("utf8");

  assert.equal(warnsDefault.length, 0);
  assert.match(raw1, /^From: Lean Ritual <noreply@leanritual\.app>\r?$/m);
  assert.match(raw1, /^Reply-To: hendrix\.ai\.dev@gmail\.com\r?$/m);
  assert.match(raw1, /^Message-ID: <[0-9a-f-]+@leanritual\.app>\r?$/m);
  assert.match(raw1, /^Content-Type: multipart\/alternative;/m);
  assert.match(raw1, /^Content-Type: text\/plain; charset=utf-8\r?$/m);
  assert.match(raw1, /^Content-Type: text\/html; charset=utf-8\r?$/m);
  assert.doesNotMatch(raw1, /^List-Unsubscribe:/im);
  assert.doesNotMatch(raw1, /<img\b/i);
  assert.equal(logsDefault.length, 1);

  // Custom MAIL_REPLY_TO overrides default and updates footer contact while keeping From unchanged
  const streamTransport2 = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const sendCustom = createMailer({
    ...baseEnv,
    MAIL_REPLY_TO: "Lean Ritual Support <support@leanritual.app>",
  }, {
    baseURL: "https://leanritual.app",
    transport: streamTransport2,
    log: () => {},
    warn: () => { throw new Error("valid MAIL_REPLY_TO should not warn"); },
  });
  const resetUrl = "https://leanritual.app/api/auth/reset-password/rst_secret_888?callbackURL=%2Flogin.html";
  const info2 = await sendCustom({ to: "member@qq.com", kind: "reset", url: resetUrl, lang: "en" });
  const raw2 = info2.message.toString("utf8");

  assert.match(raw2, /^From: Lean Ritual <noreply@leanritual\.app>\r?$/m);
  assert.match(raw2, /^Reply-To: Lean Ritual Support <support@leanritual\.app>\r?$/m);
  assert.match(raw2, /^Message-ID: <[0-9a-f-]+@leanritual\.app>\r?$/m);
  assert.ok(raw2.includes("support@leanritual.app"));
  assert.doesNotMatch(raw2, /^List-Unsubscribe:/im);

  // Clean serialization of valid single mailboxes
  assert.deepEqual(parseSingleMailbox("hendrix.ai.dev@gmail.com"), {
    name: "", address: "hendrix.ai.dev@gmail.com", header: "hendrix.ai.dev@gmail.com",
  });
  assert.deepEqual(parseSingleMailbox("<support@LEANRITUAL.APP>"), {
    name: "", address: "support@leanritual.app", header: "support@leanritual.app",
  });
  assert.deepEqual(parseSingleMailbox('"Lean Ritual, Support" <support@leanritual.app>'), {
    name: "Lean Ritual, Support",
    address: "support@leanritual.app",
    header: '"Lean Ritual, Support" <support@leanritual.app>',
  });

  // Unset or whitespace-only MAIL_REPLY_TO uses default without warning
  const silentWarns = [];
  assert.equal(resolveReplyTo({}, { warn: w => silentWarns.push(w) }), DEFAULT_REPLY_TO);
  assert.equal(resolveReplyTo({ MAIL_REPLY_TO: "   " }, { warn: w => silentWarns.push(w) }), DEFAULT_REPLY_TO);
  assert.equal(silentWarns.length, 0);

  // Malformed, multi-address, group, comment, or CR/LF MAIL_REPLY_TO falls back to default with a redacted startup warning
  for (const invalidReplyTo of [
    "a@@example.com",
    "person..name@example.com",
    ".leading@example.com",
    "trailing.@example.com",
    "a@example.com, b@example.com",
    "a@example.com,",
    "Group: a@example.com;",
    "a@b.com <c@d.com>",
    "support@leanritual.app (comment)",
    "ok@leanritual.app\r\nBcc: evil@example.com",
    "user@localhost",
    "not-an-email",
  ]) {
    assert.equal(parseSingleMailbox(invalidReplyTo), null, `should reject ${JSON.stringify(invalidReplyTo)}`);
    const warns = [];
    assert.equal(resolveReplyTo({ MAIL_REPLY_TO: invalidReplyTo }, { warn: w => warns.push(w) }), DEFAULT_REPLY_TO);
    assert.equal(warns.length, 1, `should emit one startup warning for ${JSON.stringify(invalidReplyTo)}`);
    assert.match(warns[0], /invalid MAIL_REPLY_TO.*default Reply-To/i);
    assert.ok(!warns[0].includes(invalidReplyTo), "startup warning must not echo raw malformed MAIL_REPLY_TO");
  }

  // createMailer with malformed MAIL_REPLY_TO warns at startup and sends with default Reply-To
  const fallbackWarns = [];
  const streamTransport3 = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const sendFallback = createMailer({
    ...baseEnv,
    MAIL_REPLY_TO: "person..name@example.com",
  }, {
    baseURL: "https://leanritual.app",
    transport: streamTransport3,
    log: () => {},
    warn: w => fallbackWarns.push(w),
  });
  assert.equal(fallbackWarns.length, 1);
  const info3 = await sendFallback({ to: "tester@163.com", kind: "verify", url: verifyUrl, lang: "zh" });
  assert.match(info3.message.toString("utf8"), /^Reply-To: hendrix\.ai\.dev@gmail\.com\r?$/m);
});

test("SMTP logging records only local Message-ID and metadata, redacts addresses/tokens/URLs, and rethrows sanitized errors without leaking into Better Auth logs", async t => {
  const smtpEnv = {
    MAIL_MODE: "smtp",
    SMTP_HOST: "smtp.resend.com",
    SMTP_PORT: "465",
    SMTP_USER: "resend",
    SMTP_PASS: "re_test_key",
    MAIL_FROM: "Lean Ritual <noreply@leanritual.app>",
  };
  const secretEmail = "alice.private+beta@163.com";
  const secretToken = "tok_ultra_secret_value_777";
  const secretUrl = `https://leanritual.app/api/auth/verify-email?token=${secretToken}&callbackURL=%2Flogin.html`;

  // 1. Successful send logs locally generated Message-ID even if transport returns a poisoned/token-like messageId
  const logs = [];
  const capturedOptions = [];
  const mockTransport = {
    async sendMail(options) {
      capturedOptions.push(options);
      return {
        messageId: `<other.person@example.com>`,
        response: `250 2.0.0 OK accepted for ${secretEmail} link ${secretUrl}`,
      };
    },
  };
  const send = createMailer(smtpEnv, {
    baseURL: "https://leanritual.app",
    transport: mockTransport,
    log: line => logs.push(line),
  });
  await send({ to: `Alice <${secretEmail}>`, kind: "verify", url: secretUrl, lang: "zh" });

  assert.equal(capturedOptions.length, 1);
  assert.equal(capturedOptions[0].from, smtpEnv.MAIL_FROM);
  assert.equal(capturedOptions[0].replyTo, DEFAULT_REPLY_TO);
  assert.match(capturedOptions[0].messageId, /^<[0-9a-f-]+@leanritual\.app>$/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0], `mail status=sent type=verify recipient_domain=163.com message_id=${capturedOptions[0].messageId} smtp_code=250`);
  assert.ok(!logs[0].includes("other.person@example.com"));
  assert.ok(!logs[0].includes("alice.private"));
  assert.ok(!logs[0].includes(secretEmail));
  assert.ok(!logs[0].includes(secretToken));
  assert.ok(!logs[0].includes(secretUrl));
  assert.ok(!logs[0].includes("https://"));

  // 2. Failed SMTP send logs metadata + SMTP error code only and throws a sanitized error (no raw message, response, or cause)
  const errLogs = [];
  const sendFailing = createMailer(smtpEnv, {
    baseURL: "https://leanritual.app",
    transport: {
      async sendMail() {
        const err = new Error(`550 Mailbox rejected for ${secretEmail} with ${secretUrl}`);
        err.code = "EENVELOPE";
        err.responseCode = 550;
        err.response = `550 5.1.1 User unknown ${secretEmail} ${secretToken}`;
        err.rejected = [secretEmail];
        throw err;
      },
    },
    log: line => errLogs.push(line),
  });
  await assert.rejects(
    () => sendFailing({ to: secretEmail, kind: "reset", url: secretUrl, lang: "zh" }),
    err => {
      assert.equal(err.message, "Mail delivery failed (EENVELOPE, smtp=550)");
      assert.equal(err.code, "EENVELOPE");
      assert.equal(err.responseCode, 550);
      assert.equal(err.cause, undefined);
      assert.equal(err.response, undefined);
      assert.equal(err.rejected, undefined);
      assert.ok(!err.message.includes("Mailbox rejected"));
      assert.ok(!err.message.includes("alice.private"));
      assert.ok(!err.message.includes(secretEmail));
      assert.ok(!err.message.includes(secretToken));
      assert.ok(!err.message.includes(secretUrl));
      return true;
    }
  );
  assert.equal(errLogs.length, 1);
  assert.match(errLogs[0], /^mail status=error type=reset recipient_domain=163\.com message_id=<[0-9a-f-]+@leanritual\.app> smtp_code=550 error_code=EENVELOPE$/);
  assert.ok(!errLogs[0].includes("alice.private"));
  assert.ok(!errLogs[0].includes(secretEmail));
  assert.ok(!errLogs[0].includes(secretToken));
  assert.ok(!errLogs[0].includes(secretUrl));

  // 3. Rejected SMTP send invoked through Better Auth never leaks recipient address, raw SMTP error, token, or URL into Better Auth's logger
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-auth-smtp-err-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const authBaseURL = "https://leanritual.app";
  const authMailerLogs = [];
  const authSendEmail = createMailer(smtpEnv, {
    baseURL: authBaseURL,
    transport: {
      async sendMail(options) {
        const rawErr = new Error(`550 5.1.1 <${options.to}> rejected with link ${options.text}`);
        rawErr.code = "EENVELOPE";
        rawErr.responseCode = 550;
        rawErr.response = `550 5.1.1 <${options.to}>: Recipient address rejected`;
        rawErr.rejected = [options.to];
        throw rawErr;
      },
    },
    log: line => authMailerLogs.push(line),
  });
  const service = await createAuth({
    dataDir,
    baseURL: authBaseURL,
    secret: "auth-smtp-failure-redaction-secret-123456789",
    cookieSecure: true,
    sendEmail: authSendEmail,
  });
  t.after(() => service.close());

  const inv = service.invites.issue("auth.secret.user@163.com");
  const capturedConsoleErrors = [];
  const origConsoleError = console.error;
  console.error = (...args) => {
    capturedConsoleErrors.push(args.map(a => (a instanceof Error ? `${a.message} ${JSON.stringify(a)} ${a.stack || ""}` : String(a))).join(" "));
  };
  let signupRes;
  try {
    signupRes = await service.auth.handler(new Request(`${authBaseURL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: authBaseURL,
        "x-ritual-client-ip": "198.51.100.42",
      },
      body: JSON.stringify({
        email: inv.email,
        name: "SecretTester",
        password: "strong-auth-error-test-password",
        invitation: inv.token,
        callbackURL: "/login.html?verified=1",
        consentTerms: true,
        consentSensitiveCrossBorder: true,
        agreedConsentVersion: "2026-11-25",
      }),
    }));
  } finally {
    console.error = origConsoleError;
  }

  assert.equal(signupRes.status, 200);
  assert.equal(authMailerLogs.length, 1);
  assert.match(authMailerLogs[0], /^mail status=error type=verify recipient_domain=163\.com message_id=<[0-9a-f-]+@leanritual\.app> smtp_code=550 error_code=EENVELOPE$/);
  assert.ok(capturedConsoleErrors.length >= 1, "Better Auth should log the sanitized send failure");
  const combinedLogs = [...authMailerLogs, ...capturedConsoleErrors].join("\n");
  assert.ok(combinedLogs.includes("Mail delivery failed (EENVELOPE, smtp=550)"));
  assert.ok(!combinedLogs.includes("auth.secret.user"));
  assert.ok(!combinedLogs.includes(inv.email));
  assert.ok(!combinedLogs.includes("Recipient address rejected"));
  assert.ok(!combinedLogs.includes("verify-email?token="));
  assert.ok(!combinedLogs.includes("https://leanritual.app"));

  // 4. Domain extraction handles CFWS, IDN, quoted display names, and malformed inputs safely
  assert.equal(extractDomain("user@sub.(comment)example.com"), "sub.example.com");
  assert.equal(extractDomain("user@fa\u1e9e.de"), "xn--fa-hia.de");
  assert.equal(extractDomain('"fake@evil.com" <real@163.com>'), "163.com");
  assert.equal(extractDomain("not-an-email"), "unknown");
  assert.equal(extractDomain("user@163.com\r\nX-Inject: 1"), "unknown");
});

test("createMailer.sendInvitationEmail sends exact zh/en beta invite copy with sanitized {name} greeting, empty fallback, origin guard, Reply-To, and metadata-only logs", async t => {
  const nodemailer = require("nodemailer");
  const smtpEnv = {
    MAIL_MODE: "smtp",
    SMTP_HOST: "smtp.resend.com",
    SMTP_PORT: "465",
    SMTP_USER: "resend",
    SMTP_PASS: "re_test_key",
    MAIL_FROM: "Lean Ritual <noreply@leanritual.app>",
    MAIL_REPLY_TO: "Lean Ritual Support <support@leanritual.app>",
  };
  const secretToken = "inv_tok_super_secret_9876543210";
  const secretEmail = "beta.applicant@163.com";
  const inviteUrl = `https://leanritual.app/login.html?invite=${secretToken}&email=${encodeURIComponent(secretEmail)}`;

  // 1a. Exact [zh] copy with {name}
  const zhRendered = renderEmail({ kind: "invite", url: inviteUrl, lang: "zh", name: "小明", replyTo: smtpEnv.MAIL_REPLY_TO });
  assert.equal(zhRendered.lang, "zh");
  assert.equal(zhRendered.subject, "你的薄肌日课内测邀请");
  assert.equal(zhRendered.text, [
    "你好 小明，",
    "感谢申请薄肌日课内测！这是你的专属邀请链接（7 天内有效，只能使用一次）：",
    inviteUrl,
    "打开链接即可注册。用的时候遇到问题或有想要的功能，App 里可以直接反馈，每条我们都会看。",
    "温馨提示：计划和 AI 建议仅供参考，不是医疗建议；有伤病或慢性病请先咨询医生。",
    "祝训练顺利！",
    "Jay · 薄肌日课",
  ].join("\n"));
  assert.ok(zhRendered.html.includes("你好 小明，"));
  assert.ok(zhRendered.html.includes("Jay · 薄肌日课"));
  assert.doesNotMatch(zhRendered.html, /<(img|svg|script|iframe|form|style)\b/i);
  assert.equal([...zhRendered.html.matchAll(/<a\b[^>]*\bhref="https?:\/\/[^"]*"/gi)].length, 1);

  // 1b. [zh] empty / control-only name fallback uses "你好，" (no stray space)
  for (const emptyName of [undefined, null, "", "   ", "\r\n\t\x00\u202E"]) {
    const zhEmpty = renderEmail({ kind: "invite", url: inviteUrl, lang: "zh", name: emptyName, replyTo: smtpEnv.MAIL_REPLY_TO });
    assert.equal(zhEmpty.text.split("\n")[0], "你好，");
    assert.ok(zhEmpty.html.includes(">你好，</h1>"));
  }

  // 1c. Exact [en] copy with {name}, zero CJK, and empty-name fallback ("Hi,")
  const enRendered = renderEmail({ kind: "invite", url: inviteUrl, lang: "en", name: "Alex", replyTo: smtpEnv.MAIL_REPLY_TO });
  assert.equal(enRendered.lang, "en");
  assert.equal(enRendered.subject, "Your Lean Ritual beta invite");
  assert.equal(enRendered.text, [
    "Hi Alex,",
    "Thanks for requesting an invite to the Lean Ritual beta! Here's your personal invite link (valid for 7 days, single use):",
    inviteUrl,
    "Open it to sign up. If anything breaks or you'd like a feature, send feedback right in the app; we read every message.",
    "Plans and AI suggestions are for reference only, not medical advice. If you have an injury or a medical condition, check with your doctor first.",
    "Happy training!",
    "Jay · Lean Ritual",
  ].join("\n"));
  assert.doesNotMatch(enRendered.subject, CJK_RE);
  assert.doesNotMatch(enRendered.text, CJK_RE);
  assert.doesNotMatch(enRendered.html, CJK_RE);
  assert.doesNotMatch(enRendered.html, /<(img|svg|script|iframe|form|style)\b/i);
  assert.equal([...enRendered.html.matchAll(/<a\b[^>]*\bhref="https?:\/\/[^"]*"/gi)].length, 1);
  for (const foundUrl of [...extractHttpUrls(enRendered.text), ...extractHttpUrls(enRendered.html)]) {
    assert.equal(new URL(foundUrl).hostname, "leanritual.app");
  }
  const enEmpty = renderEmail({ kind: "invite", url: inviteUrl, lang: "en", name: "   ", replyTo: smtpEnv.MAIL_REPLY_TO });
  assert.equal(enEmpty.text.split("\n")[0], "Hi,");
  assert.ok(enEmpty.html.includes(">Hi,</h1>"));

  // 1d. HTML-special, newline, bidi, and overly long names are sanitized and HTML-escaped
  const hostileName = '  <b>Alex</b>\r\nBcc:evil@x.com\u202E & "Friends"  ';
  const enHostile = renderEmail({ kind: "invite", url: inviteUrl, lang: "en", name: hostileName, replyTo: smtpEnv.MAIL_REPLY_TO });
  assert.equal(enHostile.text.split("\n")[0], 'Hi <b>Alex</b> Bcc:evil@x.com & "Friends",');
  assert.ok(!enHostile.text.includes("\u202E"));
  assert.ok(enHostile.html.includes("&lt;b&gt;Alex&lt;/b&gt; Bcc:evil@x.com &amp; &quot;Friends&quot;,"));
  assert.ok(!enHostile.html.includes("<b>Alex</b>"));

  const longName = "A".repeat(120);
  const enLong = renderEmail({ kind: "invite", url: inviteUrl, lang: "en", name: longName, replyTo: smtpEnv.MAIL_REPLY_TO });
  assert.equal(enLong.text.split("\n")[0], `Hi ${"A".repeat(60)},`);

  // 2. SMTP stream transport verifies multipart/alternative MIME headers, Reply-To, Message-ID, and metadata-only log
  const logs = [];
  const streamTransport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const mailer = createMailer(smtpEnv, {
    baseURL: "https://leanritual.app",
    transport: streamTransport,
    log: line => logs.push(line),
  });
  const info = await mailer.sendInvitationEmail({ to: secretEmail, url: inviteUrl, lang: "zh", name: "SecretApplicantName" });
  const raw = info.message.toString("utf8");
  assert.match(raw, /^From: Lean Ritual <noreply@leanritual\.app>\r?$/m);
  assert.match(raw, /^Reply-To: Lean Ritual Support <support@leanritual\.app>\r?$/m);
  assert.match(raw, /^Message-ID: <[0-9a-f-]+@leanritual\.app>\r?$/m);
  assert.match(raw, /^Content-Type: multipart\/alternative;/m);
  assert.match(raw, /^Content-Type: text\/plain; charset=utf-8\r?$/m);
  assert.match(raw, /^Content-Type: text\/html; charset=utf-8\r?$/m);
  assert.doesNotMatch(raw, /^List-Unsubscribe:/im);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^mail status=sent type=invite recipient_domain=163\.com message_id=<[0-9a-f-]+@leanritual\.app> smtp_code=none$/);
  assert.ok(!logs[0].includes("SecretApplicantName"));
  assert.ok(!logs[0].includes("beta.applicant"));
  assert.ok(!logs[0].includes(secretEmail));
  assert.ok(!logs[0].includes(secretToken));
  assert.ok(!logs[0].includes("https://"));

  // 3. Origin validation & invalid recipient fail closed without invoking transport and without leaking secrets
  let sendCalls = 0;
  const errLogs = [];
  const guardedMailer = createMailer(smtpEnv, {
    baseURL: "https://leanritual.app",
    transport: { async sendMail() { sendCalls++; return { response: "250 OK" }; } },
    log: line => errLogs.push(line),
  });
  await assert.rejects(
    () => guardedMailer.sendInvitationEmail({ to: secretEmail, url: "https://evil.example/login.html?invite=abc", lang: "en", name: "Alex" }),
    err => err.code === "INVALID_ACTION_URL" && !err.message.includes("evil.example") && !err.message.includes(secretEmail)
  );
  await assert.rejects(
    () => guardedMailer.sendInvitationEmail({ to: "not-an-email", url: inviteUrl, lang: "en", name: "Alex" }),
    err => err.code === "INVALID_RECIPIENT" && !err.message.includes("not-an-email")
  );
  assert.equal(sendCalls, 0);
  assert.equal(errLogs.length, 2);
  assert.match(errLogs[0], /^mail status=error type=invite recipient_domain=163\.com message_id=<[0-9a-f-]+@leanritual\.app> smtp_code=none error_code=INVALID_ACTION_URL$/);
  assert.match(errLogs[1], /^mail status=error type=invite recipient_domain=unknown message_id=<[0-9a-f-]+@leanritual\.app> smtp_code=none error_code=INVALID_RECIPIENT$/);

  // 4. File mode (localhost dev) writes private 0600 JSON with rendered invite content and sanitized name
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-invite-mail-file-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const fileMailer = createMailer({ MAIL_MODE: "file" }, { dataDir, baseURL: "http://127.0.0.1:8080" });
  const localInviteUrl = "http://127.0.0.1:8080/login.html?invite=local_tok_1&email=dev%40example.com";
  await fileMailer.sendInvitationEmail({ to: "dev@example.com", url: localInviteUrl, lang: "en", name: "Dev\nUser" });
  const files = readMailFiles(dataDir);
  assert.equal(files.length, 1);
  assert.equal(files[0].kind, "invite");
  assert.equal(files[0].lang, "en");
  assert.equal(files[0].url, localInviteUrl);
  assert.equal(files[0].subject, "Your Lean Ritual beta invite");
  assert.equal(files[0].text.split("\n")[0], "Hi Dev User,");
  assert.ok(files[0].html.includes("Hi Dev User,"));
});
