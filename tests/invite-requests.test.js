"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const {
  MAX_BODY_BYTES,
  MAX_NAME_LEN,
  MAX_GOAL_LEN,
  MAX_NOTE_LEN,
  redactGoalForAlert,
  formatAlertBody,
  sendInviteRequestAlert,
  createInviteRequests
} = require("../lib/invite-requests");
const { createSnapshot } = require("../lib/snapshots");
const { collectDailySummary, formatSummaryText } = require("../lib/daily-summary");

const ROOT = path.resolve(__dirname, "..");
const AXE = fs.readFileSync(path.join(ROOT, "tests/fixtures/axe-core/axe.min.js"), "utf8");

function loadPlaywright() {
  try {
    const pw = require("playwright");
    if (pw?.chromium) return { chromium: pw.chromium, executablePath: process.env.CHROMIUM_PATH || undefined };
  } catch {}
  try {
    const { resolvePlaywright } = require("../tools/demo-video/playwright-loader");
    return resolvePlaywright();
  } catch {
    return null;
  }
}

const PW = loadPlaywright();

function openMemoryDb() {
  const db = new DatabaseSync(":memory:");
  return db;
}

test("unit: validation, normalization, honeypot, dedup, hashed-IP rate limits, and zero-PII alerts", async () => {
  const db = openMemoryDb();
  let nowMs = Date.parse("2026-11-27T10:00:00.000Z");
  const alerts = [];
  const logs = [];
  const fetcher = async (url, init) => {
    alerts.push({ url, headers: init.headers, body: init.body, redirect: init.redirect });
    return { status: 200 };
  };

  const svc = createInviteRequests(db, {
    ipHourly: 3,
    ipDaily: 5,
    globalDaily: 7,
    alertUrl: "https://ntfy.example.com/secret-topic",
    ipHashSecret: "unit-test-secret-key-at-least-32-chars",
    fetcher,
    now: () => nowMs,
    log: msg => logs.push(String(msg))
  });

  // 1. Valid mainland China phone normalization (+86)
  const r1 = await svc.submit({
    name: "  小\u200E明\t测试  ",
    contactKind: "phone",
    contactValue: "138 0013 8000",
    goal: "减脂 5kg，保持每周 3 练\r\n联系我 13800138000 或 foo@bar.com https://evil.test 小明 测试",
    note: "微信号：xiaoming_wx",
    lang: "zh"
  }, { ip: "203.0.113.10" });

  assert.equal(r1.ok, true);
  assert.equal(r1.honeypot, false);
  assert.equal(r1.deduplicated, false);
  assert.match(r1.id, /^req_[0-9a-f]{12}$/);

  const row1 = db.prepare("SELECT * FROM invite_requests WHERE id = ?").get(r1.id);
  assert.equal(row1.name, "小明 测试");
  assert.equal(row1.contact_kind, "phone");
  assert.equal(row1.contact_value, "+8613800138000");
  assert.equal(row1.note, "微信号：xiaoming_wx");
  assert.equal(row1.status, "pending");

  // Alert payload contains ZERO PII (no email, phone, applicant name, or URL)
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].redirect, "manual");
  assert.match(alerts[0].body, new RegExp(`^\\[invite-request\\] #${r1.id} \\(phone\\): `));
  for (const leak of ["13800138000", "+8613800138000", "foo@bar.com", "evil.test", "小明 测试", "xiaoming_wx"]) {
    assert.ok(!alerts[0].body.includes(leak), `alert leaked ${leak}: ${alerts[0].body}`);
  }

  // Rate-limit table never stores raw IP
  const rlRows = db.prepare("SELECT bucket, window, n FROM invite_request_rate_limits").all();
  assert.ok(rlRows.some(r => r.bucket.startsWith("ip:") && !r.bucket.includes("203.0.113.10")));
  assert.ok(rlRows.every(r => !JSON.stringify(r).includes("203.0.113.10")));

  // 2. Idempotent pending deduplication: same normalized phone updates in place without duplicate row or duplicate alert
  nowMs += 60 * 1000;
  const r1Dup = await svc.submit({
    name: "小明改名",
    contactKind: "phone",
    contactValue: "+86-138-0013-8000",
    goal: "更新后的目标：增肌塑形",
    note: "更新备注",
    lang: "zh"
  }, { ip: "203.0.113.10" });

  assert.equal(r1Dup.ok, true);
  assert.equal(r1Dup.deduplicated, true);
  assert.equal(r1Dup.id, r1.id);
  assert.equal(alerts.length, 1, "no duplicate alert for pending update");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM invite_requests").get().n, 1);
  const updatedRow1 = db.prepare("SELECT * FROM invite_requests WHERE id = ?").get(r1.id);
  assert.equal(updatedRow1.name, "小明改名");
  assert.equal(updatedRow1.goal, "更新后的目标：增肌塑形");
  assert.equal(updatedRow1.note, "更新备注");
  assert.notEqual(updatedRow1.updated, updatedRow1.created);

  // 3. Valid +1 US phone & email normalization
  const r2 = await svc.submit({
    name: "Alex",
    contactKind: "phone",
    contactValue: "+1 (415) 555-2671",
    goal: "Build strength over 12 weeks",
    lang: "en"
  }, { ip: "203.0.113.10" });
  assert.equal(r2.ok, true);
  assert.equal(db.prepare("SELECT contact_value FROM invite_requests WHERE id = ?").get(r2.id).contact_value, "+14155552671");
  assert.equal(alerts.length, 2);

  // 4. Honeypot silent drop: returns ok without storing, alerting, or burning rate-limit quota
  const hp = await svc.submit({
    name: "SpamBot",
    contactKind: "email",
    contactValue: "bot@spam.example",
    goal: "Buy cheap stuff",
    website: "https://spam.example"
  }, { ip: "203.0.113.10" });
  assert.equal(hp.ok, true);
  assert.equal(hp.honeypot, true);
  assert.equal(alerts.length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM invite_requests").get().n, 2);

  // 5. Per-IP hourly limit (3/hr reached for 203.0.113.10)
  await assert.rejects(
    () => svc.submit({
      name: "Fourth",
      contactKind: "email",
      contactValue: "fourth@example.com",
      goal: "Get leaner"
    }, { ip: "203.0.113.10" }),
    err => err.status === 429 && err.code === "rate_limited"
  );

  // Advance 1 hour -> hourly bucket resets, daily bucket still tracks 3/5
  nowMs += 60 * 60 * 1000;
  const r3 = await svc.submit({
    name: "EmailUser",
    contactKind: "email",
    contactValue: "  Alice@Example.COM ",
    goal: "Stay consistent",
    lang: "en"
  }, { ip: "203.0.113.10" });
  assert.equal(db.prepare("SELECT contact_value FROM invite_requests WHERE id = ?").get(r3.id).contact_value, "alice@example.com");

  await svc.submit({
    name: "Fifth",
    contactKind: "email",
    contactValue: "fifth@example.com",
    goal: "Cut weight"
  }, { ip: "203.0.113.10" });

  // 6. Per-IP daily limit (5/day reached for 203.0.113.10 even after advancing another hour)
  nowMs += 60 * 60 * 1000;
  await assert.rejects(
    () => svc.submit({
      name: "Sixth",
      contactKind: "email",
      contactValue: "sixth@example.com",
      goal: "Cut weight"
    }, { ip: "203.0.113.10" }),
    err => err.status === 429 && err.code === "rate_limited"
  );

  // 7. Global daily limit (7/day across IPs: 5 used by .10, 2 more from .20, then 8th blocked)
  await svc.submit({ name: "G1", contactKind: "email", contactValue: "g1@example.com", goal: "Goal 1" }, { ip: "203.0.113.20" });
  await svc.submit({ name: "G2", contactKind: "email", contactValue: "g2@example.com", goal: "Goal 2" }, { ip: "203.0.113.20" });
  await assert.rejects(
    () => svc.submit({ name: "G3", contactKind: "email", contactValue: "g3@example.com", goal: "Goal 3" }, { ip: "203.0.113.30" }),
    err => err.status === 429 && err.code === "rate_limited"
  );

  // 8. Validation rejections (advance to next UTC day)
  nowMs += 24 * 60 * 60 * 1000;
  await assert.rejects(() => svc.submit({ name: " ", contactKind: "email", contactValue: "a@b.com", goal: "x" }), e => e.code === "name_required");
  await assert.rejects(() => svc.submit({ name: "a".repeat(MAX_NAME_LEN + 1), contactKind: "email", contactValue: "a@b.com", goal: "x" }), e => e.code === "name_too_long");
  await assert.rejects(() => svc.submit({ name: "A\x00B", contactKind: "email", contactValue: "a@b.com", goal: "x" }), e => e.code === "bad_request");
  await assert.rejects(() => svc.submit({ name: "A", contactKind: "fax", contactValue: "123", goal: "x" }), e => e.code === "invalid_contact_kind");
  await assert.rejects(() => svc.submit({ name: "A", contactKind: "email", contactValue: "not-an-email", goal: "x" }), e => e.code === "invalid_email");
  await assert.rejects(() => svc.submit({ name: "A", contactKind: "email", contactValue: "phone-123@phone.leanritual.invalid", goal: "x" }), e => e.code === "invalid_email");
  await assert.rejects(() => svc.submit({ name: "A", contactKind: "phone", contactValue: "12345", goal: "x" }), e => e.code === "invalid_phone");
  await assert.rejects(() => svc.submit({ name: "A", contactKind: "email", contactValue: "a@b.com", goal: "" }), e => e.code === "goal_required");
  await assert.rejects(() => svc.submit({ name: "A", contactKind: "email", contactValue: "a@b.com", goal: "g".repeat(MAX_GOAL_LEN + 1) }), e => e.code === "goal_too_long");
  await assert.rejects(() => svc.submit({ name: "A", contactKind: "email", contactValue: "a@b.com", goal: "ok", note: "n".repeat(MAX_NOTE_LEN + 1) }), e => e.code === "note_too_long");

  // 9. Alert truncation (<=80 chars + ellipsis) & failure handling never leaks ALERT_URL
  const longGoal = "A".repeat(120);
  const preview = redactGoalForAlert(longGoal);
  assert.equal(Array.from(preview).length, 81);
  assert.ok(preview.endsWith("…"));
  const body = formatAlertBody({ id: "req_1234567890ab", name: "Bob", contactKind: "email", contactValue: "bob@example.com", goal: "Bob wants fit" });
  assert.equal(body, "[invite-request] #req_1234567890ab (email): [redacted] wants fit");

  const failLogs = [];
  const resErr = await sendInviteRequestAlert({
    alertUrl: "https://ntfy.example.com/ultra-secret-topic-xyz",
    record: { id: "req_1", contactKind: "email", goal: "hello" },
    fetcher: async () => { throw new Error("network down"); },
    log: msg => failLogs.push(String(msg))
  });
  assert.equal(resErr.sent, false);
  assert.ok(failLogs.length >= 1);
  assert.ok(failLogs.every(l => !l.includes("ultra-secret-topic-xyz")), "never logs ALERT_URL");

  db.close();
});

test("HTTP integration + invite-requests-admin CLI + daily-summary snapshot reporting", { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-invite-req-"));
  const dataDir = path.join(dir, "data");
  const port = 18112;
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(port),
    HOST: "127.0.0.1",
    AUTH_BASE_URL: base,
    AUTH_SECRET: "invite-requests-http-test-secret-32-chars",
    COOKIE_SECURE: "0",
    TRUST_PROXY: "1",
    MAIL_MODE: "file",
    OPENROUTER_API_KEY: "",
    GEMINI_API_KEY: "",
    INVITE_REQUEST_IP_HOURLY_LIMIT: "3",
    INVITE_REQUEST_IP_DAILY_LIMIT: "5",
    INVITE_REQUEST_GLOBAL_DAILY_LIMIT: "6",
    ALERT_URL: ""
  };

  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = new Promise(r => child.once("exit", r));
      child.kill();
      await stopped;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timeout: " + stderr)), 8000);
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
  });

  const post = (body, { csrf = true, ip = "198.51.100.1", lang = "zh", rawBody = null } = {}) =>
    fetch(base + "/api/invite-requests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(csrf ? { "X-Bojin": "1" } : {}),
        "X-Forwarded-For": ip,
        "X-Ritual-Lang": lang
      },
      body: rawBody !== null ? rawBody : JSON.stringify(body)
    });

  // CSRF required
  const noCsrf = await post({ name: "A", contactKind: "email", contactValue: "a@example.com", goal: "fit" }, { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error, "csrf");

  // GET rejected with 405
  assert.equal((await fetch(base + "/api/invite-requests")).status, 405);

  // Oversized body rejected with 413
  const tooBig = await post(null, { rawBody: JSON.stringify({ name: "A", contactKind: "email", contactValue: "a@example.com", goal: "x".repeat(MAX_BODY_BYTES + 100) }) });
  assert.equal(tooBig.status, 413);

  // Valid phone (+86) submission
  const pRes = await post({
    name: "张三私密昵称",
    contactKind: "phone",
    contactValue: "139 0013 9000",
    goal: "减脂增肌",
    note: "微信 zhangsan_secret",
    lang: "zh"
  }, { ip: "198.51.100.1" });
  assert.equal(pRes.status, 200);
  assert.deepEqual(await pRes.json(), { ok: true });

  // Duplicate pending phone updates in place
  const pDup = await post({
    name: "张三私密昵称",
    contactKind: "phone",
    contactValue: "+8613900139000",
    goal: "减脂增肌（更新）",
    note: "微信 zhangsan_secret_2",
    lang: "zh"
  }, { ip: "198.51.100.1" });
  assert.equal(pDup.status, 200);
  assert.deepEqual(await pDup.json(), { ok: true });

  // Valid email submission
  const eRes = await post({
    name: "Jane SecretName",
    contactKind: "email",
    contactValue: "Jane.Secret@Example.COM",
    goal: "Build strength and track protein",
    lang: "en"
  }, { ip: "198.51.100.1", lang: "en" });
  assert.equal(eRes.status, 200);
  assert.deepEqual(await eRes.json(), { ok: true });

  // Honeypot silent drop
  const hpRes = await post({
    name: "Bot",
    contactKind: "email",
    contactValue: "bot@example.com",
    goal: "Spam",
    website: "http://spam.test"
  }, { ip: "198.51.100.1" });
  assert.equal(hpRes.status, 200);
  assert.deepEqual(await hpRes.json(), { ok: true });

  // 4th real request from same IP hits per-IP hourly limit (3)
  const limited = await post({
    name: "Over",
    contactKind: "email",
    contactValue: "over@example.com",
    goal: "Goal"
  }, { ip: "198.51.100.1" });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "rate_limited");

  // Zero PII in server logs
  const combinedLogs = stdout + "\n" + stderr;
  for (const secret of ["13900139000", "jane.secret@example.com", "Jane.Secret@Example.COM", "张三私密昵称", "Jane SecretName", "zhangsan_secret"]) {
    assert.ok(!combinedLogs.includes(secret), `server log leaked PII: ${secret}`);
  }
  assert.match(combinedLogs, /invite-request.*"contactKind":"phone"/);
  assert.match(combinedLogs, /invite-request.*"contactKind":"email"/);

  // Admin CLI: list, show, mark (while server is running, sharing data-access lease)
  const runAdmin = args => spawnSync(process.execPath, ["scripts/invite-requests-admin.js", ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 5000
  });

  const listAll = runAdmin(["list", "--json"]);
  assert.equal(listAll.status, 0, listAll.stderr);
  const items = JSON.parse(listAll.stdout);
  assert.equal(items.length, 2, "honeypot dropped and duplicate pending deduplicated");
  const phoneItem = items.find(i => i.contactKind === "phone");
  const emailItem = items.find(i => i.contactKind === "email");
  assert.equal(phoneItem.contactValue, "+8613900139000");
  assert.equal(phoneItem.goal, "减脂增肌（更新）");
  assert.equal(emailItem.contactValue, "jane.secret@example.com");

  const shown = runAdmin(["show", phoneItem.id, "--json"]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).id, phoneItem.id);

  const shownText = runAdmin(["show", phoneItem.id]);
  assert.equal(shownText.status, 0, shownText.stderr);
  assert.match(shownText.stdout, /Status:\s+pending/);
  assert.match(shownText.stdout, /\+8613900139000/);

  const marked = runAdmin(["mark", phoneItem.id, "--status", "invited", "--note", "sent via WeChat", "--json"]);
  assert.equal(marked.status, 0, marked.stderr);
  const markedObj = JSON.parse(marked.stdout);
  assert.equal(markedObj.status, "invited");
  assert.equal(markedObj.statusNote, "sent via WeChat");

  const listPending = runAdmin(["list", "--status", "pending", "--json"]);
  assert.equal(listPending.status, 0, listPending.stderr);
  assert.deepEqual(JSON.parse(listPending.stdout).map(i => i.id), [emailItem.id]);

  const listInvited = runAdmin(["list", "--status", "invited", "--json"]);
  assert.equal(listInvited.status, 0, listInvited.stderr);
  assert.deepEqual(JSON.parse(listInvited.stdout).map(i => i.id), [phoneItem.id]);

  const badStatus = runAdmin(["mark", emailItem.id, "--status", "all"]);
  assert.notEqual(badStatus.status, 0);
  const missingId = runAdmin(["show", "req_nonexistent"]);
  assert.notEqual(missingId.status, 0);

  // Stop server and create a verified backup snapshot to test daily-summary.js
  const stopped = new Promise(r => child.once("exit", r));
  child.kill();
  await stopped;

  const snapDir = path.join(dir, "backups", "snapshot-20261127T120000Z");
  await createSnapshot(dataDir, snapDir);

  const summary = collectDailySummary({
    dataDir,
    snapshotDir: snapDir,
    noJournal: true,
    noSystemd: true
  });
  assert.equal(summary.inviteRequests.snapshotAvailable, true);
  assert.equal(summary.inviteRequests.tablePresent, true);
  assert.equal(summary.inviteRequests.pendingTotal, 1);
  assert.deepEqual(summary.inviteRequests.byStatus, { pending: 1, invited: 1, dismissed: 0 });
  assert.deepEqual(summary.inviteRequests.last24h, { new: 2, byKind: { phone: 1, email: 1 } });
  assert.deepEqual(summary.inviteRequests.trialToDate, { new: 2, byKind: { phone: 1, email: 1 } });

  const reportText = formatSummaryText(summary);
  assert.match(reportText, /\[内测申请 \/ Invite Requests\]/);
  assert.match(reportText, /待处理 \(pending\): 1/);
  // Zero PII in daily-summary output (JSON or text)
  const summaryBlob = JSON.stringify(summary) + "\n" + reportText;
  for (const secret of ["13900139000", "jane.secret@example.com", "张三私密昵称", "Jane SecretName", "减脂增肌"]) {
    assert.ok(!summaryBlob.includes(secret), `daily-summary leaked PII: ${secret}`);
  }
});

test("Playwright Chromium: landing invite-request form (zh/en, 375px & desktop, a11y, CSP, phone/email submit)", {
  skip: PW ? false : "Playwright is not installed",
  timeout: 120000
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-invite-browser-"));
  const dataDir = path.join(dir, "data");
  const port = 18113;
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(port),
    HOST: "127.0.0.1",
    AUTH_BASE_URL: base,
    AUTH_SECRET: "invite-browser-test-secret-at-least-32-chars",
    COOKIE_SECURE: "0",
    TRUST_PROXY: "0",
    MAIL_MODE: "file",
    OPENROUTER_API_KEY: "",
    GEMINI_API_KEY: "",
    INVITE_REQUEST_IP_HOURLY_LIMIT: "20",
    INVITE_REQUEST_IP_DAILY_LIMIT: "30",
    INVITE_REQUEST_GLOBAL_DAILY_LIMIT: "50",
    ALERT_URL: ""
  };

  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", d => { stderr += d; });
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = new Promise(r => child.once("exit", r));
      child.kill();
      await stopped;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timeout: " + stderr)), 8000);
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
  });

  const browser = await PW.chromium.launch({
    executablePath: PW.executablePath || undefined,
    args: ["--no-sandbox"]
  });
  t.after(() => browser.close());

  async function openWatched(options) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    const log = { errors: [], csp: [], external: [] };
    await page.exposeFunction("__recordCSP", v => log.csp.push(v));
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", e => window.__recordCSP(e.violatedDirective + " " + e.blockedURI)));
    page.on("console", m => { if (m.type() === "error") log.errors.push(m.text()); });
    page.on("pageerror", e => log.errors.push(e.message));
    page.on("request", r => {
      const u = r.url();
      if (/^https?:/.test(u) && !u.startsWith(base)) log.external.push(u);
    });
    return { context, page, log };
  }

  async function runAxe(page) {
    await page.evaluate(AXE);
    return page.evaluate(async () => {
      const res = await window.axe.run(document, { resultTypes: ["violations"] });
      return res.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`);
    });
  }

  // 1. Mobile 375x667 zh flow: CTA labels, tap targets, >=16px inputs, Escape focus restore, language toggle preserves input, +86 phone submit, axe-core clean
  {
    const { context, page, log } = await openWatched({ viewport: { width: 375, height: 667 }, locale: "zh-CN", reducedMotion: "reduce" });
    await page.goto(base + "/?lang=zh");
    const triggers = page.locator('[data-open-apply][data-i="cta.ask"]');
    assert.equal(await triggers.count(), 2);
    assert.equal(await triggers.nth(0).textContent(), "申请内测");
    assert.equal(await triggers.nth(1).textContent(), "申请内测");
    assert.match(await page.locator('footer a[data-i="foot.contact"]').getAttribute("href"), /^mailto:hendrix\.ai\.dev@gmail\.com/);

    // Open modal from hero button
    await triggers.nth(0).click();
    await page.locator("#apply-modal").waitFor({ state: "visible" });
    assert.equal(await page.locator("#apply-cc").inputValue(), "CN");
    assert.equal(await page.locator('#apply-method button[data-kind="phone"]').getAttribute("aria-pressed"), "true");

    // Check font-size >= 16px, tap targets >= 44px, and zero horizontal overflow on 375x667
    const metrics = await page.evaluate(() => {
      const controls = [...document.querySelectorAll("#apply-modal input:not(#apply-website), #apply-modal select, #apply-modal textarea")];
      const fontSizes = controls.map(el => ({ id: el.id, fs: parseFloat(getComputedStyle(el).fontSize) }));
      const closeBox = document.getElementById("apply-close").getBoundingClientRect();
      const submitBox = document.getElementById("apply-submit").getBoundingClientRect();
      const methodBoxes = [...document.querySelectorAll("#apply-method button")].map(b => b.getBoundingClientRect());
      return {
        fontSizes,
        closeW: closeBox.width, closeH: closeBox.height,
        submitH: submitBox.height,
        methodMinH: Math.min(...methodBoxes.map(b => b.height)),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        dialogOverflow: document.querySelector(".apply-dialog").scrollWidth - document.querySelector(".apply-dialog").clientWidth
      };
    });
    for (const item of metrics.fontSizes) {
      assert.ok(item.fs >= 16, `${item.id} font-size ${item.fs} < 16px`);
    }
    assert.ok(metrics.closeW >= 44 && metrics.closeH >= 44, `close tap target ${metrics.closeW}x${metrics.closeH}`);
    assert.ok(metrics.submitH >= 44, `submit height ${metrics.submitH}`);
    assert.ok(metrics.methodMinH >= 44, `method toggle height ${metrics.methodMinH}`);
    assert.equal(metrics.overflow, 0, "no page horizontal overflow on 375px");
    assert.equal(metrics.dialogOverflow, 0, "no modal horizontal overflow on 375px");

    // axe-core clean with modal OPEN (zh, 375x667)
    assert.deepEqual(await runAxe(page), [], "axe violations in zh 375px modal");

    // Escape closes modal and restores focus to trigger
    await page.keyboard.press("Escape");
    await page.locator("#apply-modal").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.matches('.hero [data-open-apply]')), true, "focus restored to hero trigger");

    // Re-open, type draft input, trigger validation error, toggle language to EN and back to ZH without losing input
    await triggers.nth(0).click();
    await page.fill("#apply-name", "林小满");
    await page.fill("#apply-phone", "138 0013 8888");
    await page.click("#apply-submit"); // missing goal -> localized zh error
    assert.equal(await page.locator("#apply-err").textContent(), "请填写你想达成的目标");

    // Close via backdrop click? No — test toggling language via header while keeping typed draft:
    // Close first (draft preserved), toggle EN, re-open -> draft & error translated cleanly!
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "EN" }).click();
    assert.equal(await triggers.nth(0).textContent(), "Request an invite");
    assert.equal(await triggers.nth(1).textContent(), "Request an invite");
    await triggers.nth(0).click();
    assert.equal(await page.locator("#apply-name").inputValue(), "林小满");
    assert.equal(await page.locator("#apply-phone").inputValue(), "138 0013 8888");
    assert.equal(await page.locator("#apply-err").textContent(), "Please tell us your goal.");
    assert.equal(await page.locator('#apply-method button[data-kind="phone"]').getAttribute("aria-pressed"), "true");

    // Switch back to ZH, fill goal & note, submit -> confirmation shown
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "中" }).click();
    await triggers.nth(0).click();
    await page.fill("#apply-goal", "3 个月减脂 4 公斤并规律力量训练");
    await page.fill("#apply-note", "微信号 lin_test");
    await page.click("#apply-submit");
    await page.locator("#apply-done").waitFor({ state: "visible" });
    assert.equal(
      await page.locator(".apply-done-msg").textContent(),
      "已收到你的内测申请！我们会尽快把专属邀请链接发到你留下的联系方式。"
    );

    assert.deepEqual([log.errors, log.csp, log.external], [[], [], []]);
    await context.close();
  }

  // 2. Desktop 1440x900 en flow: auto-open via ?apply=1, email submit, #apply hash auto-open, +1 phone submit, axe-core clean
  {
    const { context, page, log } = await openWatched({ viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
    await page.goto(base + "/?lang=en&apply=1");
    await page.locator("#apply-modal").waitFor({ state: "visible" });
    assert.equal(await page.locator('#apply-method button[data-kind="email"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('.apply-privacy a[href="/privacy.html"]').textContent(), "Privacy Notice");

    // axe-core clean with modal OPEN (en, 1440x900)
    assert.deepEqual(await runAxe(page), [], "axe violations in en 1440px modal");

    // Submit email request and verify button disabled while in-flight
    let sawDisabled = false;
    await page.route("**/api/invite-requests", async route => {
      sawDisabled = await page.locator("#apply-submit").isDisabled();
      await route.continue();
    });
    await page.fill("#apply-name", "Taylor");
    await page.fill("#apply-email", "taylor@example.com");
    await page.fill("#apply-goal", "Lean out and track protein");
    await page.click("#apply-submit");
    await page.locator("#apply-done").waitFor({ state: "visible" });
    assert.equal(sawDisabled, true, "submit button disabled while in-flight");
    assert.equal(
      await page.locator(".apply-done-msg").textContent(),
      "Request received! We'll send your personal invite link to the contact you provided soon."
    );
    await page.unroute("**/api/invite-requests");

    // Close Done and test #apply auto-open + US +1 phone submission
    await page.goto(base + "/?lang=en#apply");
    await page.locator("#apply-modal").waitFor({ state: "visible" });
    await page.click('#apply-method button[data-kind="phone"]');
    assert.equal(await page.locator("#apply-cc").inputValue(), "US");
    await page.fill("#apply-name", "Jordan");
    await page.fill("#apply-phone", "(415) 555-2671");
    await page.fill("#apply-goal", "Consistent 4x/week lifting");
    await page.click("#apply-submit");
    await page.locator("#apply-done").waitFor({ state: "visible" });

    assert.deepEqual([log.errors, log.csp, log.external], [[], [], []]);
    await context.close();
  }

  // Verify all 3 browser submissions stored in bojin.db with normalized contacts
  const db = new DatabaseSync(path.join(dataDir, "bojin.db"), { readOnly: true });
  const saved = db.prepare("SELECT name, contact_kind, contact_value, lang, status FROM invite_requests ORDER BY created ASC").all().map(r => ({ ...r }));
  db.close();
  assert.deepEqual(saved, [
    { name: "林小满", contact_kind: "phone", contact_value: "+8613800138888", lang: "zh", status: "pending" },
    { name: "Taylor", contact_kind: "email", contact_value: "taylor@example.com", lang: "en", status: "pending" },
    { name: "Jordan", contact_kind: "phone", contact_value: "+14155552671", lang: "en", status: "pending" }
  ]);
});

test("privacy.html covers landing-page invite-request storage, hashed IP rate limiting, redacted alerts, and retention in zh & en", () => {
  const html = fs.readFileSync(path.join(ROOT, "public/privacy.html"), "utf8");
  const zh = html.match(/<article id="doc-zh">([\s\S]*?)<\/article>/)[1];
  const en = html.match(/<article id="doc-en" hidden>([\s\S]*?)<\/article>/)[1];

  for (const term of ["申请内测", "加盐哈希后的 IP 桶", "目标前 80 字预览", "内测申请记录", "更正或删除已提交的内测申请信息"]) {
    assert.ok(zh.includes(term), `privacy.html zh missing invite-request term: ${term}`);
  }
  for (const term of ["Request an invite", "salted HMAC-hashed IP buckets", "first 80 characters of your goal", "invite requests", "correction or deletion of an invite request"]) {
    assert.ok(en.includes(term), `privacy.html en missing invite-request term: ${term}`);
  }
});
