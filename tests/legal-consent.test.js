"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const { DatabaseSync } = require("node:sqlite");
const sharp = require("sharp");
const { createAuth, CONSENT_VERSION } = require("../lib/auth");

const ROOT = path.resolve(__dirname, "..");
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const AXE_PATH = path.join(ROOT, "tests/fixtures/axe-core/axe.min.js");

function loadPlaywright() {
  const candidates = ["playwright"];
  const home = os.homedir();
  for (const rel of [
    ".claude/skills/gstack/node_modules/playwright",
    ".agents/skills/gstack/node_modules/playwright"
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-legal-"));
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dir,
    PORT: String(port),
    HOST: "127.0.0.1",
    AUTH_BASE_URL: base,
    AUTH_SECRET: "legal-consent-test-secret-at-least-32-chars",
    COOKIE_SECURE: "0",
    TRUST_PROXY: "0",
    MAIL_MODE: "file",
    OPENROUTER_API_KEY: "",
    GEMINI_API_KEY: "",
    ...extraEnv
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
  return { dir, base, env, port, origin: base };
}

test("privacy.html has no draft wording, covers all current disclosures, and links to terms.html in zh and en", () => {
  const html = fs.readFileSync(path.join(ROOT, "public/privacy.html"), "utf8");
  const zh = html.match(/<article id="doc-zh">([\s\S]*?)<\/article>/)[1];
  const en = html.match(/<article id="doc-en" hidden>([\s\S]*?)<\/article>/)[1];

  for (const forbidden of [
    "上线前草稿", "尚未开放公测", "待确认", "尚待确认", "将在上线前核实补充", "尚未部署",
    "Pre-launch Draft", "not yet open for public beta", "still being confirmed",
    "will be specified before public beta", "will be verified and added before launch"
  ]) {
    assert.ok(!html.includes(forbidden), `privacy.html must not contain draft wording: ${forbidden}`);
  }

  for (const term of ["2026-11-24", "杰瑞智能技术服务部", "受邀免费试用", "阿里云美国西部", "Google Gemini API", "OpenRouter", "Resend", "意见反馈", "最小化的错误报告", "同意版本号及时间戳", "假名化标识", "不会在未提示的情况下静默清除", 'href="/terms.html"']) {
    assert.ok(zh.includes(term), `privacy.html zh missing: ${term}`);
  }
  assert.ok(!zh.includes("匿名标识"), "privacy.html zh must describe HMAC identifier as 假名化标识, not 匿名标识");
  for (const term of ["November 24, 2026", "2026-11-24", "Jierui Intelligent Technology Service Department", "invitation-only free trial", "Alibaba Cloud US West", "Google Gemini API", "OpenRouter", "Resend", "Send feedback", "minimal error reports", "consent version and timestamp", "HMAC-derived pseudonymous", "rather than discarding them silently", 'href="/terms.html"']) {
    assert.ok(en.includes(term), `privacy.html en missing: ${term}`);
  }
  assert.doesNotMatch(en, CJK_RE, "privacy.html #doc-en must have zero CJK characters");

  // Consent version constant stays synchronized across backend, login, app, privacy, and terms
  const loginHtml = fs.readFileSync(path.join(ROOT, "public/login.html"), "utf8");
  const appHtml = fs.readFileSync(path.join(ROOT, "app/index.html"), "utf8");
  const termsHtml = fs.readFileSync(path.join(ROOT, "public/terms.html"), "utf8");
  assert.equal(loginHtml.match(/const DISPLAYED_CONSENT_VERSION = "([^"]+)"/)?.[1], CONSENT_VERSION);
  assert.equal(appHtml.match(/const CONSENT_DOC_VERSION = "([^"]+)"/)?.[1], CONSENT_VERSION);
  assert.ok(html.includes(`版本：${CONSENT_VERSION}`) && html.includes(`Version: ${CONSENT_VERSION}`));
  assert.ok(termsHtml.includes(`版本：${CONSENT_VERSION}`) && termsHtml.includes(`Version: ${CONSENT_VERSION}`));

  // Sign-up and returning-user consent checkboxes accurately describe Resend (email + content + delivery metadata) and BOTH primary + backup OpenRouter routing + pseudonymous identifier
  for (const [label, src] of [["login.html", loginHtml], ["app/index.html", appHtml]]) {
    assert.match(src, /Resend 接收你的邮箱地址、验证\/重置邮件内容及必要投递信息/, `${label} zh Resend scope`);
    assert.match(src, /Resend, which receives your email address, verification\/reset email content, and necessary delivery metadata/, `${label} en Resend scope`);
    assert.match(src, /阿里云美国西部（硅谷）主机：存储与处理全部账号及应用记录/, `${label} zh host scope`);
    assert.match(src, /Alibaba Cloud US West \(Silicon Valley\) host — all account and app records/, `${label} en host scope`);
    assert.match(src, /Google Gemini API 直接处理，或经 OpenRouter（作为配置的主通道，或在 Gemini 主通道临时故障、限流或超时时作为自动备用通道）转发至底层模型供应商/, `${label} zh AI primary+backup scope`);
    assert.match(src, /directly by the Google Gemini API or via OpenRouter \(as the configured primary route or as an automatic backup if Gemini fails, times out, or hits limits\)/, `${label} en AI primary+backup scope`);
    assert.match(src, /经 HMAC 派生的假名化用户标识/, `${label} zh OpenRouter pseudonymous id`);
    assert.match(src, /HMAC-derived pseudonymous user identifier/, `${label} en OpenRouter pseudonymous id`);
    assert.ok(!src.includes("backup AI path only"), `${label} must not describe OpenRouter as backup-only`);
    assert.ok(!src.includes("仅在启用且 Gemini 主通道"), `${label} must not describe OpenRouter as backup-only in zh`);
  }
});

test("terms.html covers all required trial terms, health disclaimer, zh/en parity, language toggle, and links from login, Me, and privacy", () => {
  const termsHtml = fs.readFileSync(path.join(ROOT, "public/terms.html"), "utf8");
  const zhMatch = termsHtml.match(/<article id="doc-zh">([\s\S]*?)<\/article>/);
  const enMatch = termsHtml.match(/<article id="doc-en" hidden>([\s\S]*?)<\/article>/);
  assert.ok(zhMatch && enMatch, "terms.html must have #doc-zh and #doc-en");
  const zh = zhMatch[1], en = enMatch[1];

  const countTag = (s, tag) => (s.match(new RegExp(`<${tag}\\b`, "gi")) || []).length;
  for (const tag of ["h1", "h2", "p", "a"]) {
    assert.equal(countTag(en, tag), countTag(zh, tag), `terms.html <${tag}> parity`);
  }
  assert.doesNotMatch(en, CJK_RE, "terms.html #doc-en must have zero CJK characters");

  for (const term of ["2026-11-24", "仅限受邀的免费试用", "不收取任何费用", "年满 18 周岁", "非医疗建议", "伤病", "孕期", "进食障碍", "基础疾病", "估算值", "合理使用", "用户内容", "责任限制", "杰瑞智能技术服务部", "hendrix.ai.dev@gmail.com", 'href="/privacy.html"']) {
    assert.ok(zh.includes(term), `terms.html zh missing: ${term}`);
  }
  for (const term of ["November 24, 2026", "invitation-only free trial", "no fee", "at least 18 years old", "Not medical advice", "injuries", "pregnant", "eating disorders", "medical condition", "approximations", "Acceptable Use", "User Content", "Limitation of Liability", "Jierui Intelligent Technology Service Department", "hendrix.ai.dev@gmail.com", 'href="/privacy.html"']) {
    assert.ok(en.includes(term), `terms.html en missing: ${term}`);
  }

  // Linked from login.html, Me tab (app/index.html), and privacy.html
  const loginHtml = fs.readFileSync(path.join(ROOT, "public/login.html"), "utf8");
  const appHtml = fs.readFileSync(path.join(ROOT, "app/index.html"), "utf8");
  const privacyHtml = fs.readFileSync(path.join(ROOT, "public/privacy.html"), "utf8");
  assert.ok(loginHtml.includes('id="terms-link" href="/terms.html"'), "login.html links to /terms.html");
  assert.ok(loginHtml.includes('id="c-terms-link" href="/terms.html"'), "login.html consent links to /terms.html");
  assert.ok(appHtml.includes('<a class="btn" href="/terms.html">${esc(t("account.terms"))}</a>'), "Me tab links to /terms.html");
  assert.ok(privacyHtml.includes('href="/terms.html"'), "privacy.html links to /terms.html");

  // Runtime language resolution on terms.html
  const script = termsHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const makeStorage = init => {
    const m = new Map(Object.entries(init || {}));
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
  };
  const mount = (opts = {}) => {
    const rootChildren = [];
    const mk = id => {
      const n = { id, hidden: id === "doc-en", parentNode: null };
      rootChildren.push(n);
      n.parentNode = { removeChild(c) { const i = rootChildren.indexOf(c); if (i >= 0) rootChildren.splice(i, 1); c.parentNode = null; } };
      return n;
    };
    const zhN = mk("doc-zh"), enN = mk("doc-en");
    const root = { appendChild(c) { if (!rootChildren.includes(c)) rootChildren.push(c); c.parentNode = { removeChild(x) { const i = rootChildren.indexOf(x); if (i >= 0) rootChildren.splice(i, 1); x.parentNode = null; } }; } };
    const back = { textContent: "" };
    const lsw = { attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, onclick: null };
    const els = { "#doc-root": root, "#doc-zh": zhN, "#doc-en": enN, "#back-link": back, "#lang-switch": lsw };
    const doc = { documentElement: { lang: "zh-CN" }, title: "", querySelector: s => els[s] || null, querySelectorAll: () => [] };
    const win = {};
    vm.runInContext(script, vm.createContext({ window: win, document: doc, location: { search: opts.search || "" }, localStorage: makeStorage(opts.storage), navigator: { languages: opts.languages || [] }, Date }));
    return { doc, rootChildren, back, win };
  };
  const dEn = mount({ languages: ["en-US"] });
  assert.equal(dEn.doc.documentElement.lang, "en");
  assert.equal(dEn.doc.title, "Terms of Use · Lean Ritual");
  assert.deepEqual(dEn.rootChildren.map(n => n.id), ["doc-en"]);
  assert.doesNotMatch(dEn.back.textContent, CJK_RE);

  const dZh = mount({ search: "?lang=zh", languages: ["en-US"] });
  assert.equal(dZh.doc.documentElement.lang, "zh-CN");
  assert.equal(dZh.doc.title, "使用条款 · Lean Ritual");
  assert.deepEqual(dZh.rootChildren.map(n => n.id), ["doc-zh"]);
});

test("signup requires both separate consents without burning invite, records version + timestamp, blocks spoofing, and migrates pre-existing auth.sqlite", { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-consent-auth-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  // 1. Pre-existing auth.sqlite created before consent columns existed
  const { getMigrations } = await import("better-auth/db/migration");
  const legacyDb = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  await (await getMigrations({
    baseURL: "http://localhost:8080", basePath: "/api/auth",
    secret: "consent-migration-test-secret-32-chars!!", database: legacyDb,
    emailAndPassword: { enabled: true }
  })).runMigrations();
  const colsBefore = legacyDb.prepare("PRAGMA table_info(user)").all().map(c => c.name);
  assert.ok(!colsBefore.includes("consentVersion"));
  assert.ok(!colsBefore.includes("consentedAt"));
  const createdIso = "2026-11-01T00:00:00.000Z";
  legacyDb.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)")
    .run("u_preexisting", "Legacy User", "legacy@example.com", createdIso, createdIso);
  legacyDb.close();

  // 2. Boot createAuth -> automatically migrates user table while preserving existing user with null consent
  const mails = [];
  const svc = await createAuth({
    dataDir, baseURL: "http://localhost:8080",
    secret: "consent-migration-test-secret-32-chars!!", cookieSecure: false,
    sendEmail: async m => mails.push(m)
  });
  t.after(() => svc.close());

  const inspect = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  t.after(() => inspect.close());
  const colsAfter = inspect.prepare("PRAGMA table_info(user)").all().map(c => c.name);
  assert.ok(colsAfter.includes("consentVersion"));
  assert.ok(colsAfter.includes("consentedAt"));
  const legacyRow = inspect.prepare("SELECT id, consentVersion, consentedAt FROM user WHERE id = ?").get("u_preexisting");
  assert.equal(legacyRow.consentVersion, null);
  assert.equal(legacyRow.consentedAt, null);

  // 3. New signup rejects missing, partial, or non-boolean consents WITHOUT consuming invite
  const inv = svc.invites.issue("fresh@example.com");
  let ipIdx = 50;
  const req = (route, body, cookie) => svc.auth.handler(new Request("http://localhost:8080/api/auth/" + route, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ritual-client-ip": `192.0.2.${ipIdx++}`, origin: "http://localhost:8080", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  }));
  const baseBody = { email: inv.email, name: "Fresh", password: "fresh-strong-password", invitation: inv.token };
  for (const [badConsent, expectedStatus] of [
    [{}, 400],
    [{ consentTerms: true, agreedConsentVersion: CONSENT_VERSION }, 400],
    [{ consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION }, 400],
    [{ consentTerms: true, consentSensitiveCrossBorder: false, agreedConsentVersion: CONSENT_VERSION }, 400],
    [{ consentTerms: "true", consentSensitiveCrossBorder: "true", agreedConsentVersion: CONSENT_VERSION }, 400],
    [{ consentTerms: true, consentSensitiveCrossBorder: true }, 409],
    [{ consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-01-01" }, 409]
  ]) {
    const r = await req("sign-up/email", { ...baseBody, ...badConsent });
    assert.equal(r.status, expectedStatus, `expected ${expectedStatus} for ${JSON.stringify(badConsent)}`);
    assert.equal(inspect.prepare("SELECT consumed FROM launch_invites WHERE email = ?").get(inv.email).consumed, null, "invite must remain unconsumed");
  }

  // 4. Both true + matching displayed version succeeds and stamps CONSENT_VERSION + ISO timestamp
  const ok = await req("sign-up/email", { ...baseBody, consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION });
  assert.equal(ok.status, 200, await ok.clone().text());
  await svc.auth.handler(new Request(mails[0].url));
  const login = await req("sign-in/email", { email: inv.email, password: baseBody.password });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const sessionUser = await svc.sessionUser({ headers: { cookie } });
  assert.equal(sessionUser.consentVersion, CONSENT_VERSION);
  assert.match(sessionUser.consentedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // 5. Client cannot spoof consentVersion or consentedAt via Better Auth update-user
  const spoof = await req("update-user", { consentVersion: "spoofed", consentedAt: "2000-01-01T00:00:00.000Z" }, cookie);
  assert.equal(spoof.status, 400);
  const afterSpoof = await svc.sessionUser({ headers: { cookie } });
  assert.equal(afterSpoof.consentVersion, CONSENT_VERSION);
  assert.equal(afterSpoof.consentedAt, sessionUser.consentedAt);
});

test("HTTP consent gate: existing unconsented user is blocked from app APIs & blobs, can export & delete, and unlocks after accepting", { timeout: 30000 }, async t => {
  const srv = await startTestServer(t);
  const issue = email => {
    const r = spawnSync(process.execPath, ["scripts/auth-admin.js", "invite", email], {
      cwd: ROOT, env: srv.env, encoding: "utf8", timeout: 5000
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const invA = issue("existing-accept@example.com");
  const invB = issue("existing-delete@example.com");

  const api = (route, body, cookie, method) => fetch(srv.base + route, {
    method: method || (body ? "POST" : "GET"),
    redirect: "manual",
    headers: { origin: srv.origin, "Content-Type": "application/json", "X-Bojin": "1", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const pw = "existing-user-strong-password";
  const signupAndLogin = async inv => {
    assert.equal((await api("/api/auth/sign-up/email", {
      email: inv.email, name: "Existing", password: pw, invitation: inv.token,
      callbackURL: "/login.html", consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: CONSENT_VERSION
    })).status, 200);
    const mail = fs.readdirSync(path.join(srv.dir, "mail"))
      .map(f => JSON.parse(fs.readFileSync(path.join(srv.dir, "mail", f), "utf8")))
      .find(m => m.to === inv.email && m.kind === "verify");
    const vUrl = new URL(mail.url);
    assert.equal((await fetch(`${srv.base}${vUrl.pathname}${vUrl.search}`, { redirect: "manual" })).status, 302);
    const login = await api("/api/auth/sign-in/email", { email: inv.email, password: pw });
    assert.equal(login.status, 200);
    return login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  };

  const cookieA = await signupAndLogin(invA);
  const cookieB = await signupAndLogin(invB);

  // Seed existing data + photo for both users before simulating pre-consent existing state
  const docA = `/api/doc?path=data/users/${invA.userId}/app/app/profile`;
  assert.equal((await api(docA, { data: { weight: 71, startDate: "2026-11-01" } }, cookieA, "PUT")).status, 200);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } }).png().toBuffer();
  const upA = await fetch(srv.base + "/api/assets", {
    method: "POST", headers: { cookie: cookieA, "X-Bojin": "1", "Content-Type": "image/png" }, body: png
  });
  assert.equal(upA.status, 200);
  const blobA = await upA.json();

  const docB = `/api/doc?path=data/users/${invB.userId}/app/app/profile`;
  assert.equal((await api(docB, { data: { weight: 65 } }, cookieB, "PUT")).status, 200);

  // Simulate pre-existing users who registered before consent rollout (consentVersion=NULL, consentedAt=NULL)
  const authDb = new DatabaseSync(path.join(srv.dir, "auth.sqlite"));
  authDb.prepare("UPDATE user SET consentVersion = NULL, consentedAt = NULL WHERE id IN (?, ?)").run(invA.userId, invB.userId);
  authDb.close();

  // 1. /api/me reports consentRequired: true
  const meBefore = await (await api("/api/me", null, cookieA)).json();
  assert.equal(meBefore.consentRequired, true);
  assert.equal(meBefore.consentVersion, null);
  assert.equal(meBefore.consentedAt, null);
  assert.equal(meBefore.requiredConsentVersion, CONSENT_VERSION);

  // 2. All app APIs & /_blob/:id are blocked with 403 consent_required
  for (const [label, res] of [
    ["GET /api/doc", await api(docA, null, cookieA)],
    ["PUT /api/doc", await api(docA, { data: { weight: 99 } }, cookieA, "PUT")],
    ["POST /api/doc-commit", await api("/api/doc-commit", { changes: [] }, cookieA)],
    ["GET /api/list", await api(`/api/list?col=data/users/${invA.userId}/app/days`, null, cookieA)],
    ["POST /api/assets", await fetch(srv.base + "/api/assets", { method: "POST", headers: { cookie: cookieA, "X-Bojin": "1", "Content-Type": "image/png" }, body: png })],
    ["POST /api/ai", await api("/api/ai", { messages: [{ content: "hi" }] }, cookieA)],
    ["POST /api/feedback", await api("/api/feedback", { type: "bug", message: "test" }, cookieA)],
    ["GET /_blob/:id", await api(blobA.url, null, cookieA)]
  ]) {
    assert.equal(res.status, 403, `${label} should be blocked with 403 before consent`);
    assert.equal((await res.json()).error, "consent_required", `${label} error code`);
  }

  // 3. Export STILL works before consenting and includes null consent fields + docs + photo
  const expBeforeRes = await api("/api/account/export", null, cookieA);
  assert.equal(expBeforeRes.status, 200);
  const expBefore = (await expBeforeRes.text()).trim().split("\n").map(JSON.parse);
  assert.equal(expBefore[0].kind, "account");
  assert.equal(expBefore[0].user.consentVersion, null);
  assert.equal(expBefore[0].user.consentedAt, null);
  assert.equal(expBefore.find(x => x.kind === "document").data.weight, 71);
  assert.ok(expBefore.some(x => x.kind === "photo" && x.id === blobA.id));

  // 4. POST /api/account/consent rejects partial consent (400) and missing/stale revision (409), then accepts matching revision (idempotently)
  assert.equal((await api("/api/account/consent", { consentTerms: true, consentVersion: CONSENT_VERSION }, cookieA)).status, 400);
  assert.equal((await api("/api/account/consent", { consentSensitiveCrossBorder: true, consentVersion: CONSENT_VERSION }, cookieA)).status, 400);
  const missingVerRes = await api("/api/account/consent", { consentTerms: true, consentSensitiveCrossBorder: true }, cookieA);
  assert.equal(missingVerRes.status, 409);
  assert.equal((await missingVerRes.json()).error, "consent_version_mismatch");
  const staleVerRes = await api("/api/account/consent", { consentTerms: true, consentSensitiveCrossBorder: true, consentVersion: "2026-01-01" }, cookieA);
  assert.equal(staleVerRes.status, 409);
  const staleVerBody = await staleVerRes.json();
  assert.equal(staleVerBody.error, "consent_version_mismatch");
  assert.equal(staleVerBody.requiredConsentVersion, CONSENT_VERSION);
  // Still gated after rejected stale revision
  assert.equal((await api(docA, null, cookieA)).status, 403);

  const acceptRes = await api("/api/account/consent", { consentTerms: true, consentSensitiveCrossBorder: true, consentVersion: CONSENT_VERSION }, cookieA);
  assert.equal(acceptRes.status, 200);
  const accepted = await acceptRes.json();
  assert.equal(accepted.ok, true);
  assert.equal(accepted.consentVersion, CONSENT_VERSION);
  assert.match(accepted.consentedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  // Repeat call preserves original consentedAt timestamp
  const repeat = await (await api("/api/account/consent", { consentTerms: true, consentSensitiveCrossBorder: true, consentVersion: CONSENT_VERSION }, cookieA)).json();
  assert.equal(repeat.consentedAt, accepted.consentedAt);

  // 5. After consenting, /api/me unlocks, app APIs & blobs work, and export includes consent version + timestamp
  const meAfter = await (await api("/api/me", null, cookieA)).json();
  assert.equal(meAfter.consentRequired, false);
  assert.equal(meAfter.consentVersion, CONSENT_VERSION);
  assert.equal(meAfter.consentedAt, accepted.consentedAt);
  assert.equal((await api(docA, null, cookieA)).status, 200);
  assert.equal((await api(blobA.url, null, cookieA)).status, 200);

  const expAfter = (await (await api("/api/account/export", null, cookieA)).text()).trim().split("\n").map(JSON.parse);
  assert.equal(expAfter[0].user.consentVersion, CONSENT_VERSION);
  assert.equal(expAfter[0].user.consentedAt, accepted.consentedAt);

  // 6. User B (still unconsented) can delete account without ever consenting
  const delB = await api("/api/auth/delete-user", { password: pw }, cookieB);
  assert.equal(delB.status, 200, await delB.clone().text());
  assert.equal((await api("/api/me", null, cookieB)).status, 401);
  const bojinDb = new DatabaseSync(path.join(srv.dir, "bojin.db"));
  assert.equal(bojinDb.prepare("SELECT COUNT(*) n FROM docs WHERE uid = ?").get(invB.userId).n, 0);
  bojinDb.close();
});

test("headless Chromium: sign-up checkboxes, setup health disclaimer, AI disclaimer note, existing-user consent gate (accept, export, delete), and axe-core clean", { timeout: 90000 }, async t => {
  const pw = loadPlaywright();
  if (!pw) {
    t.skip("Playwright Chromium not available in this environment");
    return;
  }

  const srv = await startTestServer(t);
  const axeSource = fs.readFileSync(AXE_PATH, "utf8");
  const issue = email => {
    const r = spawnSync(process.execPath, ["scripts/auth-admin.js", "invite", email], {
      cwd: ROOT, env: srv.env, encoding: "utf8", timeout: 5000
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const inv1 = issue("e2e-consent@example.com");
  const inv2 = issue("e2e-decline-del@example.com");
  const pass = "browser-consent-strong-password";

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
        returnByValue: true
      });
      assert.deepEqual(JSON.parse(res.result.value), [], `Axe violations on ${label}`);
    } finally {
      await cdp.detach();
    }
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const page = await context.newPage();
  const cspViolations = [];
  const pageErrors = [];
  await page.exposeFunction("recordLegalCsp", v => cspViolations.push(v));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", e => window.recordLegalCsp(`${e.violatedDirective}: ${e.blockedURI}`)));
  page.on("pageerror", e => pageErrors.push(e.message));

  // 1. Sign-up consent checkboxes start unticked and block submission until both are checked
  let signupCalls = 0;
  page.on("request", r => { if (new URL(r.url()).pathname === "/api/auth/sign-up/email") signupCalls++; });
  await page.goto(`${srv.base}/login.html?invite=${encodeURIComponent(inv1.token)}&email=${encodeURIComponent(inv1.email)}`);
  assert.equal(await page.locator("#c-terms").isChecked(), false);
  assert.equal(await page.locator("#c-sensitive").isChecked(), false);
  await page.locator("#n").fill("Consent E2E");
  await page.locator("#p").fill(pass);
  await page.locator("#go").click();
  assert.equal(signupCalls, 0);
  assert.match(await page.locator("#err").textContent(), /请先勾选同意/);

  // Only first checkbox ticked still blocks
  await page.locator("#c-terms").check();
  await page.locator("#go").click();
  assert.equal(signupCalls, 0);

  const textExcludingLangToggle = () => page.evaluate(() => {
    const clone = (document.querySelector("main") || document.body).cloneNode(true);
    clone.querySelectorAll('script, style, #lang-switch, [data-act="lang"], [hidden]').forEach(el => el.remove());
    return clone.textContent;
  });

  // Switch to EN and verify error & labels have zero Chinese
  await page.locator('#lang-switch [data-lang="en"]').click();
  assert.doesNotMatch(await textExcludingLangToggle(), CJK_RE);

  // Stale-tab sign-up: simulate an older tab submitting a previous revision -> server returns 409 without burning invite, UI prompts reload
  let rewriteStaleSignup = true;
  await page.route("**/api/auth/sign-up/email", async route => {
    if (!rewriteStaleSignup) return route.continue();
    rewriteStaleSignup = false;
    const orig = JSON.parse(route.request().postData() || "{}");
    assert.equal(orig.agreedConsentVersion, CONSENT_VERSION, "sign-up sends displayed agreedConsentVersion");
    await route.continue({ postData: JSON.stringify({ ...orig, agreedConsentVersion: "2026-01-01" }) });
  });
  await page.locator("#c-sensitive").check();
  await page.locator("#go").click();
  await page.locator("#reload-policy").waitFor({ state: "visible" });
  assert.match(await page.locator("#err").textContent(), /updated.*reload/i);

  // Submitting again with current displayed revision succeeds (proving invite was not burned by 409)
  await page.locator("#go").click();
  await page.getByText("Check your email and verify your address before signing in.", { exact: true }).waitFor();
  assert.equal(signupCalls, 2);
  await page.unroute("**/api/auth/sign-up/email");

  // Verify email & sign in -> lands on setup flow with health disclaimer visible before targets
  const mail1 = fs.readdirSync(path.join(srv.dir, "mail"))
    .map(f => JSON.parse(fs.readFileSync(path.join(srv.dir, "mail", f), "utf8")))
    .find(m => m.to === inv1.email && m.kind === "verify");
  const u1 = new URL(mail1.url);
  await page.goto(`${srv.base}${u1.pathname}${u1.search}`);
  await page.locator("#e").fill(inv1.email);
  await page.locator("#p").fill(pass);
  await page.locator("#go").click();
  await page.locator("#setup").waitFor({ state: "visible" });
  assert.equal(await page.locator("#setup-disclaimer").isVisible(), true);
  assert.match(await page.locator("#setup-disclaimer").textContent(), /not medical advice/i);
  assert.match(await page.locator("#setup-disclaimer").textContent(), /injuries.*pregnant.*eating disorders.*medical condition/i);
  assert.match(await page.locator("#setup-disclaimer").textContent(), /estimates/i);
  assert.doesNotMatch(await textExcludingLangToggle(), CJK_RE);
  await assertAxeClean(context, page, "setup-en");

  // Switch to zh on setup and check disclaimer + axe
  await page.locator('[data-act="lang"][data-v="zh"]').click();
  assert.match(await page.locator("#setup-disclaimer").textContent(), /不构成医疗建议/);
  assert.match(await page.locator("#setup-disclaimer").textContent(), /估算值/);
  await assertAxeClean(context, page, "setup-zh");

  // Complete setup -> Me tab has Terms of Use link; Feedback tab AI card has one-line disclaimer
  await page.locator("#f-age").fill("28");
  await page.locator("#f-height").fill("175");
  await page.locator("#f-weight").fill("70");
  await page.locator('button[type="submit"]').click();
  await page.locator("nav#tabs").waitFor({ state: "visible" });

  await page.locator('nav#tabs [data-act="tab"][data-v="me"]').click();
  assert.equal(await page.locator('a[href="/terms.html"]').isVisible(), true);
  assert.equal(await page.locator('a[href="/privacy.html"]').isVisible(), true);

  // Check one-line AI disclaimer on Feedback tab when AI feedback exists
  await page.locator('nav#tabs [data-act="tab"][data-v="fb"]').click();
  await page.evaluate(() => {
    S.sample = { json: async () => ({}) };
    S.feedback = [{ id: "f1", createdAt: "2026-11-24T00:00:00Z", summary: "Keep going." }];
    render();
  });
  assert.ok((await page.locator(".ai-disclaimer").count()) >= 2);
  assert.match(await page.locator(".ai-disclaimer").first().textContent(), /不构成医疗建议/);

  // 2. Simulate existing unconsented user WITH a preloaded unsynced local workout draft on next load
  const draftDate = "2026-11-23";
  await page.evaluate(({ uid, draftDate }) => {
    const drafts = {
      [`${draftDate}|push`]: {
        key: "push",
        exercises: [{ name: "上斜杠铃卧推", sets: [{ w: "62.5", r: "6" }] }],
        feel: "3", pain: "none", painArea: "", note: "Offline pre-rollout workout"
      }
    };
    localStorage.setItem(`bj-user:${uid}:bj-drafts`, JSON.stringify(drafts));
  }, { uid: inv1.userId, draftDate });

  const authDb = new DatabaseSync(path.join(srv.dir, "auth.sqlite"));
  authDb.prepare("UPDATE user SET consentVersion = NULL, consentedAt = NULL WHERE id = ?").run(inv1.userId);
  authDb.close();

  await page.reload();
  await page.locator("#consent-gate").waitFor({ state: "visible" });
  assert.equal(await page.locator("nav#tabs").isVisible(), false);
  assert.equal(await page.locator("#cg-terms").isChecked(), false);
  assert.equal(await page.locator("#cg-sensitive").isChecked(), false);
  await assertAxeClean(context, page, "consent-gate-zh");

  // Gated sign-out with unsynced local draft MUST warn and preserve draft if user cancels
  let gatedPromptMsg = "";
  page.once("dialog", async dialog => {
    gatedPromptMsg = dialog.message();
    await dialog.dismiss();
  });
  await page.locator('#consent-gate [data-act="logout"]').click();
  await page.waitForTimeout(150);
  assert.match(gatedPromptMsg, /未同步.*训练草稿/);
  assert.equal(await page.locator("#consent-gate").isVisible(), true, "cancelling gated sign-out stays on consent gate");
  const preservedDraft = await page.evaluate(uid => localStorage.getItem(`bj-user:${uid}:bj-drafts`), inv1.userId);
  assert.ok(preservedDraft && preservedDraft.includes("Offline pre-rollout workout"), "local draft must be preserved when gated sign-out is cancelled");

  // Switch consent gate to English & verify zero Chinese + axe clean
  await page.locator('[data-act="lang"][data-v="en"]').click();
  assert.doesNotMatch(await textExcludingLangToggle(), CJK_RE);
  await assertAxeClean(context, page, "consent-gate-en");

  // Export works right from the consent gate
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.locator('#consent-gate a[href="/api/account/export"]').click()
  ]);
  const exportedLines = fs.readFileSync(await dl.path(), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(exportedLines[0].user.id, inv1.userId);
  assert.equal(exportedLines[0].user.consentVersion, null);

  // Clicking accept without both checked shows error
  await page.locator("#cg-terms").check();
  await page.locator('[data-act="consent-accept"]').click();
  await page.locator("#consent-err").waitFor({ state: "visible" });

  // Stale-tab returning-user consent gate: intercept to send old revision -> server returns 409, UI prompts reload
  let rewriteStaleGate = true;
  await page.route("**/api/account/consent", async route => {
    if (!rewriteStaleGate) return route.continue();
    rewriteStaleGate = false;
    const orig = JSON.parse(route.request().postData() || "{}");
    assert.equal(orig.consentVersion, CONSENT_VERSION, "consent gate sends displayed consentVersion");
    await route.continue({ postData: JSON.stringify({ ...orig, consentVersion: "2026-01-01" }) });
  });
  await page.locator("#cg-sensitive").check();
  await page.locator('[data-act="consent-accept"]').click();
  await page.locator('#consent-gate [data-act="reload-data"]').waitFor({ state: "visible" });
  assert.match(await page.locator("#consent-err").textContent(), /updated.*reload/i);
  await page.unroute("**/api/account/consent");

  // Reload after stale-tab warning -> local draft still intact -> accept latest revision -> unlocks app and rescues draft
  await page.reload();
  await page.locator("#consent-gate").waitFor({ state: "visible" });
  await page.locator("#cg-terms").check();
  await page.locator("#cg-sensitive").check();
  const rescuedP = page.waitForResponse(r => (
    (new URL(r.url()).pathname === "/api/doc-commit" && r.request().method() === "POST" && (r.request().postData() || "").includes(draftDate)) ||
    (new URL(r.url()).pathname === "/api/doc" && r.request().method() === "PUT" && r.url().includes(draftDate))
  ) && r.status() === 200);
  await page.locator('[data-act="consent-accept"]').click();
  await page.locator("nav#tabs").waitFor({ state: "visible" });
  await rescuedP;
  const bojinCheck = new DatabaseSync(path.join(srv.dir, "bojin.db"));
  const rescuedRow = bojinCheck.prepare("SELECT data FROM docs WHERE path = ?").get(`data/users/${inv1.userId}/app/days/${draftDate}`);
  bojinCheck.close();
  assert.ok(rescuedRow && rescuedRow.data.includes("Offline pre-rollout workout"), "rescued draft must be persisted on server after accepting consent");
  await page.reload();
  await page.locator("nav#tabs").waitFor({ state: "visible" });
  assert.equal(await page.locator("#consent-gate").count(), 0);

  // 3. Second existing unconsented user deletes account directly from consent gate
  await page.locator('nav#tabs [data-act="tab"][data-v="me"]').click();
  await page.locator('[data-act="logout"]').click();
  await page.waitForURL("**/login.html");

  await page.goto(`${srv.base}/login.html?invite=${encodeURIComponent(inv2.token)}&email=${encodeURIComponent(inv2.email)}`);
  await page.locator("#n").fill("Decline User");
  await page.locator("#p").fill(pass);
  await page.locator("#c-terms").check();
  await page.locator("#c-sensitive").check();
  await page.locator("#go").click();
  await page.getByText("Check your email and verify your address before signing in.", { exact: true }).waitFor();
  const mail2 = fs.readdirSync(path.join(srv.dir, "mail"))
    .map(f => JSON.parse(fs.readFileSync(path.join(srv.dir, "mail", f), "utf8")))
    .find(m => m.to === inv2.email && m.kind === "verify");
  const u2 = new URL(mail2.url);
  await page.goto(`${srv.base}${u2.pathname}${u2.search}`);

  // Reset user 2 consent to null to simulate existing unconsented user
  const authDb2 = new DatabaseSync(path.join(srv.dir, "auth.sqlite"));
  authDb2.prepare("UPDATE user SET consentVersion = NULL, consentedAt = NULL WHERE id = ?").run(inv2.userId);
  authDb2.close();

  await page.locator("#e").fill(inv2.email);
  await page.locator("#p").fill(pass);
  await page.locator("#go").click();
  await page.locator("#consent-gate").waitFor({ state: "visible" });
  // Confirming gated sign-out with a preloaded local draft warns, then clears local draft and signs out
  await page.evaluate(uid => {
    localStorage.setItem(`bj-user:${uid}:bj-drafts`, JSON.stringify({
      "2026-11-23|pull": { key: "pull", exercises: [{ name: "引体向上", sets: [{ w: "0", r: "8" }] }], feel: "", pain: "none", painArea: "", note: "Will discard on confirm" }
    }));
  }, inv2.userId);
  let confirmMsg = "";
  page.once("dialog", async dialog => { confirmMsg = dialog.message(); await dialog.accept(); });
  await page.locator('#consent-gate [data-act="logout"]').click();
  await page.waitForURL("**/login.html");
  assert.match(confirmMsg, /unsynced workout drafts/i);
  assert.equal(await page.evaluate(uid => localStorage.getItem(`bj-user:${uid}:bj-drafts`), inv2.userId), null);

  // Sign back in as unconsented user 2 and delete account directly from consent gate
  await page.locator("#e").fill(inv2.email);
  await page.locator("#p").fill(pass);
  await page.locator("#go").click();
  await page.locator("#consent-gate").waitFor({ state: "visible" });
  await page.locator("#consent-gate summary").click();
  await page.locator("#delete-password").fill(pass);
  await page.locator("#delete-confirm").check();
  await page.locator('[data-act="delete-account"]').click();
  await page.waitForURL("**/login.html?deleted=1");

  assert.deepEqual(cspViolations, []);
  assert.deepEqual(pageErrors, []);
});
