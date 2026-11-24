"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createMailer, renderEmail, resolveReplyTo, extractDomain, DEFAULT_REPLY_TO } = require("../lib/mail");
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

  // HTML escaping and protocol safety
  const xssAttempt = 'https://leanritual.app/api/auth/verify-email?token=1" onclick="alert(1)&x=<script>';
  const safeRendered = renderEmail({ kind: "verify", url: xssAttempt, lang: "en" });
  assert.doesNotMatch(safeRendered.html, /<script>/i);
  assert.doesNotMatch(safeRendered.html, /" onclick="/i);

  const jsProto = renderEmail({ kind: "verify", url: "javascript:alert(1)", lang: "en" });
  assert.doesNotMatch(jsProto.html, /href="javascript:/i);
});

test("SMTP mailer sends multipart/alternative with Reply-To, unchanged From, domain Message-ID, and no List-Unsubscribe", async () => {
  const nodemailer = require("nodemailer");
  const baseEnv = {
    MAIL_MODE: "smtp",
    SMTP_HOST: "smtp.resend.com",
    SMTP_PORT: "465",
    SMTP_USER: "resend",
    SMTP_PASS: "re_test_key",
    MAIL_FROM: "Lean Ritual <noreply@leanritual.app>",
  };

  // Default Reply-To falls back to privacy contact email
  const logsDefault = [];
  const streamTransport1 = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const sendDefault = createMailer(baseEnv, {
    baseURL: "https://leanritual.app",
    transport: streamTransport1,
    log: line => logsDefault.push(line),
  });
  const verifyUrl = "https://leanritual.app/api/auth/verify-email?token=tok_secret_999&callbackURL=%2Flogin.html%3Fverified%3D1";
  const info1 = await sendDefault({ to: "tester@163.com", kind: "verify", url: verifyUrl, lang: "zh" });
  const raw1 = info1.message.toString("utf8");

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
  });
  const resetUrl = "https://leanritual.app/api/auth/reset-password/rst_secret_888?callbackURL=%2Flogin.html";
  const info2 = await sendCustom({ to: "member@qq.com", kind: "reset", url: resetUrl, lang: "en" });
  const raw2 = info2.message.toString("utf8");

  assert.match(raw2, /^From: Lean Ritual <noreply@leanritual\.app>\r?$/m);
  assert.match(raw2, /^Reply-To: Lean Ritual Support <support@leanritual\.app>\r?$/m);
  assert.match(raw2, /^Message-ID: <[0-9a-f-]+@leanritual\.app>\r?$/m);
  assert.ok(raw2.includes("support@leanritual.app"));
  assert.doesNotMatch(raw2, /^List-Unsubscribe:/im);

  // Whitespace-only MAIL_REPLY_TO uses default; invalid or CR/LF MAIL_REPLY_TO fails closed
  assert.equal(resolveReplyTo({}), DEFAULT_REPLY_TO);
  assert.equal(resolveReplyTo({ MAIL_REPLY_TO: "   " }), DEFAULT_REPLY_TO);
  assert.throws(() => resolveReplyTo({ MAIL_REPLY_TO: "not-an-email" }), /MAIL_REPLY_TO/);
  assert.throws(() => resolveReplyTo({ MAIL_REPLY_TO: "ok@leanritual.app\r\nBcc: evil@example.com" }), /MAIL_REPLY_TO/);
  assert.throws(() => createMailer({ ...baseEnv, MAIL_REPLY_TO: "bad" }, { baseURL: "https://leanritual.app" }), /MAIL_REPLY_TO/);
});

test("SMTP logging records only metadata (type, recipient domain, messageId, SMTP code) and redacts addresses, tokens, and URLs", async () => {
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

  // 1. Successful send with noisy SMTP response echoing sensitive strings
  const logs = [];
  const capturedOptions = [];
  const mockTransport = {
    async sendMail(options) {
      capturedOptions.push(options);
      return {
        messageId: "<resend-id-42@leanritual.app>",
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
  assert.equal(logs[0], "mail status=sent type=verify recipient_domain=163.com message_id=<resend-id-42@leanritual.app> smtp_code=250");
  assert.ok(!logs[0].includes("alice.private"));
  assert.ok(!logs[0].includes(secretEmail));
  assert.ok(!logs[0].includes(secretToken));
  assert.ok(!logs[0].includes(secretUrl));
  assert.ok(!logs[0].includes("https://"));

  // 2. Poisoned messageId containing recipient address or URL gets redacted
  const poisonedLogs = [];
  const sendPoisoned = createMailer(smtpEnv, {
    baseURL: "https://leanritual.app",
    transport: {
      async sendMail() {
        return {
          messageId: `<${secretEmail}>`,
          response: "250 OK",
        };
      },
    },
    log: line => poisonedLogs.push(line),
  });
  await sendPoisoned({ to: secretEmail, kind: "reset", url: secretUrl, lang: "en" });
  assert.equal(poisonedLogs.length, 1);
  assert.equal(poisonedLogs[0], "mail status=sent type=reset recipient_domain=163.com message_id=redacted smtp_code=250");
  assert.ok(!poisonedLogs[0].includes(secretEmail));

  // 3. Failed SMTP send logs metadata + SMTP error code only, never err.message / address / token / URL, and rethrows
  const errLogs = [];
  const sendFailing = createMailer(smtpEnv, {
    baseURL: "https://leanritual.app",
    transport: {
      async sendMail() {
        const err = new Error(`550 Mailbox rejected for ${secretEmail} with ${secretUrl}`);
        err.code = "EENVELOPE";
        err.responseCode = 550;
        err.response = `550 5.1.1 User unknown ${secretEmail} ${secretToken}`;
        throw err;
      },
    },
    log: line => errLogs.push(line),
  });
  await assert.rejects(
    () => sendFailing({ to: secretEmail, kind: "reset", url: secretUrl, lang: "zh" }),
    /Mailbox rejected/
  );
  assert.equal(errLogs.length, 1);
  assert.match(errLogs[0], /^mail status=error type=reset recipient_domain=163\.com message_id=<[0-9a-f-]+@leanritual\.app> smtp_code=550 error_code=EENVELOPE$/);
  assert.ok(!errLogs[0].includes("alice.private"));
  assert.ok(!errLogs[0].includes(secretEmail));
  assert.ok(!errLogs[0].includes(secretToken));
  assert.ok(!errLogs[0].includes(secretUrl));

  // 4. Domain extraction handles CFWS, IDN, quoted display names, and malformed inputs safely
  assert.equal(extractDomain("user@sub.(comment)example.com"), "sub.example.com");
  assert.equal(extractDomain("user@fa\u1e9e.de"), "xn--fa-hia.de");
  assert.equal(extractDomain('"fake@evil.com" <real@163.com>'), "163.com");
  assert.equal(extractDomain("not-an-email"), "unknown");
  assert.equal(extractDomain("user@163.com\r\nX-Inject: 1"), "unknown");
});
