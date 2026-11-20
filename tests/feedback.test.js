"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const vm = require("node:vm");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const sharp = require("sharp");

const {
  MAX_MESSAGE_LEN,
  createFeedback,
  sendFeedbackAlert,
  formatAlertBody,
  parseAlertUrl
} = require("../lib/feedback");
const { createUploads } = require("../lib/uploads");
const { createAccountData } = require("../lib/account-data");
const { createSnapshot, restoreSnapshot } = require("../lib/snapshots");
const { readLedger } = require("../lib/deletion-ledger");

const ROOT = path.resolve(__dirname, "..");

function makeFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(err => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

async function tinyPngBase64(color = "red") {
  const buf = await sharp({ create: { width: 4, height: 4, channels: 3, background: color } }).png().toBuffer();
  return buf.toString("base64");
}

function makeDbFixture(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-fb-unit-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "blobs"), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "bojin.db"));
  db.exec(`
    CREATE TABLE docs (path TEXT PRIMARY KEY, uid TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
    CREATE TABLE ai_usage (uid TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(uid, day));
    CREATE TABLE sessions (token TEXT PRIMARY KEY, uid TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY);
  `);
  const accountData = createAccountData(db, dataDir);
  const uploads = createUploads(db, dataDir, opts.uploads || {});
  const feedback = createFeedback(db, dataDir, {
    uploads,
    accountData,
    releaseRevision: "0123456789abcdef0123456789abcdef01234567",
    ...(opts.feedback || {})
  });
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, db, accountData, uploads, feedback };
}

test("feedback validation, strict device info allowlist, and opt-out", async t => {
  const { db, feedback } = makeDbFixture(t);
  const user = { id: "u_tester1" };

  await assert.rejects(() => feedback.submit(user, { type: "invalid", message: "hi" }), e => e.status === 400);
  await assert.rejects(() => feedback.submit(user, { type: "bug", message: "   \n  " }), e => e.status === 400);
  await assert.rejects(
    () => feedback.submit(user, { type: "bug", message: "a".repeat(MAX_MESSAGE_LEN + 1) }),
    e => e.status === 400 && e.code === "message_too_long"
  );

  const resOn = await feedback.submit(user, {
    type: "bug",
    message: "Button stuck on Meals tab\r\nsecond line",
    includeDeviceInfo: true,
    deviceInfo: {
      revision: "deadbeef12345678",
      page: "me",
      userAgent: "Mozilla/5.0 (iPhone)\nInjected",
      screen: "390x844 (390x700, dpr 3.00)",
      lang: "en",
      online: true,
      clientTime: "2026-11-20T12:00:00.000Z",
      weight: 72.5,
      meals: ["secret"],
      profile: { age: 30 }
    }
  });
  assert.equal(resOn.ok, true);
  assert.match(resOn.id, /^fb_[0-9a-f]{12}$/);
  assert.equal(resOn.hasScreenshot, false);

  const rowOn = db.prepare("SELECT * FROM feedback WHERE id = ?").get(resOn.id);
  assert.equal(rowOn.uid, "u_tester1");
  assert.equal(rowOn.type, "bug");
  assert.equal(rowOn.message, "Button stuck on Meals tab\nsecond line");
  const info = JSON.parse(rowOn.device_info);
  assert.deepEqual(Object.keys(info).sort(), ["clientTime", "lang", "online", "page", "revision", "screen", "userAgent"]);
  assert.equal(info.revision, "deadbeef1234");
  assert.equal(info.page, "me");
  assert.equal(info.lang, "en");
  assert.equal(info.online, true);
  assert.equal(info.userAgent.includes("\n"), false);
  assert.equal(info.weight, undefined);
  assert.equal(info.meals, undefined);
  assert.equal(info.profile, undefined);

  // Opt-out: deviceInfo must be stored as NULL even if client sent fields.
  const resOff = await feedback.submit(user, {
    type: "idea",
    message: "Add dark mode toggle",
    includeDeviceInfo: false,
    deviceInfo: { page: "me", userAgent: "should-be-dropped" }
  });
  const rowOff = db.prepare("SELECT * FROM feedback WHERE id = ?").get(resOff.id);
  assert.equal(rowOff.device_info, null);
});

test("feedback screenshot reuses upload validation, quotas, and leaves zero orphan blobs on failure", async t => {
  const pngB64 = await tinyPngBase64("green");
  const { dataDir, db, feedback } = makeDbFixture(t, {
    uploads: { daily: 2, userBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024 },
    feedback: { daily: 10, globalDaily: 10 }
  });
  const user = { id: "u_img" };

  // Non-image content-type or payload rejected with 415
  await assert.rejects(
    () => feedback.submit(user, {
      type: "bug",
      message: "bad svg",
      screenshot: { contentType: "image/svg+xml", dataBase64: Buffer.from("<svg/>").toString("base64") }
    }),
    e => e.status === 415 && e.code === "bad_type"
  );
  await assert.rejects(
    () => feedback.submit(user, {
      type: "bug",
      message: "fake png bytes",
      screenshot: { contentType: "image/png", dataBase64: Buffer.from("not-really-a-png").toString("base64") }
    }),
    e => e.status === 415 && e.code === "bad_type"
  );
  assert.equal(fs.readdirSync(path.join(dataDir, "blobs")).length, 0);

  // Valid PNG succeeds and stores normalized WebP in blobs
  const ok = await feedback.submit(user, {
    type: "bug",
    message: "screenshot attached",
    screenshot: { contentType: "image/png", dataBase64: pngB64 }
  });
  assert.equal(ok.hasScreenshot, true);
  const row = db.prepare("SELECT screenshot_blob_id FROM feedback WHERE id = ?").get(ok.id);
  assert.match(row.screenshot_blob_id, /^[0-9a-f]{32}$/);
  const blob = db.prepare("SELECT uid, type, size FROM blobs WHERE id = ?").get(row.screenshot_blob_id);
  assert.equal(blob.uid, "u_img");
  assert.equal(blob.type, "image/webp");
  assert.ok(fs.existsSync(path.join(dataDir, "blobs", row.screenshot_blob_id)));
});

test("feedback per-user and global daily rate limits enforce 429 and reset on next UTC day", async t => {
  let clock = Date.parse("2026-11-20T10:00:00Z");
  const { feedback } = makeDbFixture(t, {
    feedback: { daily: 2, globalDaily: 3, now: () => clock }
  });

  await feedback.submit({ id: "u_a" }, { type: "bug", message: "a1" });
  await feedback.submit({ id: "u_a" }, { type: "bug", message: "a2" });
  await assert.rejects(
    () => feedback.submit({ id: "u_a" }, { type: "bug", message: "a3" }),
    e => e.status === 429 && e.code === "feedback_rate_limited"
  );

  // User B can submit 1 (reaches globalDaily = 3), then blocked globally
  await feedback.submit({ id: "u_b" }, { type: "idea", message: "b1" });
  await assert.rejects(
    () => feedback.submit({ id: "u_b" }, { type: "idea", message: "b2" }),
    e => e.status === 429 && e.code === "feedback_rate_limited"
  );

  // Next UTC day resets limits
  clock = Date.parse("2026-11-21T00:01:00Z");
  const nextDay = await feedback.submit({ id: "u_a" }, { type: "other", message: "next day" });
  assert.equal(nextDay.ok, true);
});

test("feedback alerts: silent skip when unset, HTTPS-only, minimal privacy-safe payload, never fails submission", async t => {
  assert.equal(parseAlertUrl(""), null);
  assert.deepEqual(parseAlertUrl("http://ntfy.sh/secret"), { invalid: true });
  assert.deepEqual(parseAlertUrl("https://ntfy.sh/with space"), { invalid: true });

  // Silent skip when ALERT_URL is empty
  let calls = 0;
  const skipped = await sendFeedbackAlert({
    alertUrl: "",
    record: { id: "fb_111111111111", uid: "u_1", type: "bug", message: "hello" },
    fetcher: async () => { calls++; return { status: 200 }; }
  });
  assert.equal(skipped.skipped, true);
  assert.equal(calls, 0);

  // Long message truncated to ~100 chars, single-line, contains type + id + uid only
  const longMsg = "第一行\n" + "测试反馈内容".repeat(30);
  const body = formatAlertBody({
    id: "fb_abcdef012345",
    uid: "u_privacy",
    type: "bug",
    message: longMsg,
    screenshotBlobId: "a".repeat(32)
  });
  assert.ok(!body.includes("\n"));
  assert.ok(body.startsWith("[bug] #fb_abcdef012345 (u_privacy) [+img]: "));
  assert.ok(body.endsWith("…"));
  const excerpt = body.split(": ").slice(1).join(": ");
  assert.equal(Array.from(excerpt).length, 101); // 100 chars + ellipsis

  // Successful HTTPS POST through createFeedback
  const sent = [];
  const { feedback } = makeDbFixture(t, {
    feedback: {
      alertUrl: "https://alerts.example.test/super-secret-topic",
      fetcher: async (url, init) => {
        sent.push({ url, init });
        return { status: 200 };
      }
    }
  });
  const res = await feedback.submit(
    { id: "u_alert_user", email: "private@example.com", username: "RealName" },
    { type: "idea", message: "Add timer sound", includeDeviceInfo: true, deviceInfo: { userAgent: "SecretUA/1.0" } }
  );
  assert.equal(res.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://alerts.example.test/super-secret-topic");
  assert.equal(sent[0].init.method, "POST");
  assert.equal(sent[0].init.headers.Tags, "bulb");
  assert.ok(sent[0].init.body.includes(res.id));
  assert.ok(sent[0].init.body.includes("u_alert_user"));
  assert.ok(sent[0].init.body.includes("[idea]"));
  assert.ok(sent[0].init.body.includes("Add timer sound"));
  assert.ok(!sent[0].init.body.includes("private@example.com"));
  assert.ok(!sent[0].init.body.includes("RealName"));
  assert.ok(!sent[0].init.body.includes("SecretUA"));

  // Alert network failure must NOT fail submission and must NOT log the secret URL
  const logs = [];
  const { feedback: failingAlertFb } = makeDbFixture(t, {
    feedback: {
      alertUrl: "https://alerts.example.test/very-secret-token-xyz",
      fetcher: async () => { throw new Error("network down"); },
      log: msg => logs.push(String(msg))
    }
  });
  const res2 = await failingAlertFb.submit({ id: "u_ok" }, { type: "other", message: "Still saved" });
  assert.equal(res2.ok, true);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("very-secret-token-xyz"));
  assert.ok(!logs[0].includes("Still saved"));

  // Non-HTTPS redirect must be refused
  const redirLogs = [];
  const redirRes = await sendFeedbackAlert({
    alertUrl: "https://alerts.example.test/topic",
    record: { id: "fb_222222222222", uid: "u_2", type: "bug", message: "hi" },
    fetcher: async () => ({ status: 302, headers: new Headers({ location: "http://evil.invalid/steal" }) }),
    log: msg => redirLogs.push(String(msg))
  });
  assert.equal(redirRes.sent, false);
  assert.equal(redirRes.reason, "non_https_redirect");
});

test("HTTP integration: POST /api/feedback, export, CLI reader, deletion, and backup ledger replay", { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-fb-http-"));
  const dir = path.join(root, "data");
  fs.mkdirSync(dir, { recursive: true });
  const port = await makeFreePort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dir,
    PORT: String(port),
    HOST: "127.0.0.1",
    AUTH_BASE_URL: base,
    AUTH_SECRET: "disposable-test-secret-at-least-32-characters",
    COOKIE_SECURE: "0",
    TRUST_PROXY: "0",
    MAIL_MODE: "file",
    OPENROUTER_API_KEY: "",
    ALERT_URL: "",
    FEEDBACK_DAILY_LIMIT: "2",
    FEEDBACK_GLOBAL_DAILY_LIMIT: "5"
  };

  const issue = email => {
    const r = spawnSync(process.execPath, ["scripts/auth-admin.js", "invite", email], {
      cwd: ROOT, env, encoding: "utf8", timeout: 5000
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const invA = issue("alice-fb@example.com");
  const invB = issue("bob-fb@example.com");

  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", d => (stderr += d));
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = new Promise(r => child.once("exit", r));
      child.kill();
      await stopped;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timeout " + stderr)), 8000);
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
  });

  const req = (route, body, cookie, method, headers = {}) =>
    fetch(base + route, {
      method: method || (body ? "POST" : "GET"),
      redirect: "manual",
      headers: {
        origin: base,
        "Content-Type": "application/json",
        "X-Bojin": "1",
        ...(cookie ? { cookie } : {}),
        ...headers
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

  const pw = "temporary strong test password";
  const register = async inv => {
    const r = await req("/api/auth/sign-up/email", {
      email: inv.email, name: "Tester", password: pw, invitation: inv.token, callbackURL: "/login.html"
    });
    assert.equal(r.status, 200, await r.clone().text());
    const mails = fs.readdirSync(path.join(dir, "mail")).map(f => JSON.parse(fs.readFileSync(path.join(dir, "mail", f), "utf8")));
    const mail = mails.find(m => m.to === inv.email && m.kind === "verify");
    assert.ok(mail);
    assert.equal((await fetch(mail.url, { redirect: "manual" })).status, 302);
    const login = await req("/api/auth/sign-in/email", { email: inv.email, password: pw });
    assert.equal(login.status, 200);
    return login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  };

  const cookieA = await register(invA);
  const cookieB = await register(invB);
  const meA = await (await req("/api/me", null, cookieA)).json();
  const meB = await (await req("/api/me", null, cookieB)).json();

  // Auth & CSRF guards
  assert.equal((await req("/api/feedback", { type: "bug", message: "anon" })).status, 401);
  assert.equal((await fetch(base + "/api/feedback", {
    method: "POST",
    headers: { cookie: cookieA, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "bug", message: "no csrf" })
  })).status, 403);

  // Submit without screenshot
  const fb1Res = await req("/api/feedback", {
    type: "idea",
    message: "Would love a rest timer!",
    includeDeviceInfo: false,
    deviceInfo: null,
    screenshot: null
  }, cookieA);
  assert.equal(fb1Res.status, 201, await fb1Res.clone().text());
  const fb1 = await fb1Res.json();
  assert.equal(fb1.ok, true);
  assert.equal(fb1.hasScreenshot, false);

  // Submit with PNG screenshot
  const pngB64 = await tinyPngBase64("blue");
  const fb2Res = await req("/api/feedback", {
    type: "bug",
    message: "Layout overlapped on iPhone SE",
    includeDeviceInfo: true,
    deviceInfo: {
      page: "me",
      userAgent: "Safari/iOS",
      screen: "375x667 (375x550, dpr 2.00)",
      lang: "zh",
      online: true,
      clientTime: "2026-11-20T12:34:56.000Z"
    },
    screenshot: { contentType: "image/png", dataBase64: pngB64 }
  }, cookieA);
  assert.equal(fb2Res.status, 201, await fb2Res.clone().text());
  const fb2 = await fb2Res.json();
  assert.equal(fb2.hasScreenshot, true);

  // Per-user limit (FEEDBACK_DAILY_LIMIT=2) triggers 429 on 3rd submission
  const fb3Res = await req("/api/feedback", { type: "other", message: "third" }, cookieA);
  assert.equal(fb3Res.status, 429);

  // User B submits one
  const fbBRes = await req("/api/feedback", {
    type: "other",
    message: "Bob's feedback",
    includeDeviceInfo: true,
    deviceInfo: { page: "me", lang: "en", online: true }
  }, cookieB);
  assert.equal(fbBRes.status, 201);
  const fbB = await fbBRes.json();

  // Export includes feedback + screenshot blob for user A, isolated from user B
  const expA = (await (await req("/api/account/export", null, cookieA)).text()).trim().split("\n").map(JSON.parse);
  const expFbA = expA.filter(x => x.kind === "feedback");
  assert.equal(expFbA.length, 2);
  const withShot = expFbA.find(x => x.id === fb2.id);
  assert.ok(withShot.screenshotBlobId);
  assert.equal(withShot.deviceInfo.page, "me");
  assert.ok(expA.some(x => x.kind === "photo" && x.id === withShot.screenshotBlobId));

  const expB = (await (await req("/api/account/export", null, cookieB)).text()).trim().split("\n").map(JSON.parse);
  const expFbB = expB.filter(x => x.kind === "feedback");
  assert.equal(expFbB.length, 1);
  assert.equal(expFbB[0].id, fbB.id);

  // Host CLI script reads feedback cleanly (list, --type, --json, show)
  const cliList = spawnSync(process.execPath, ["scripts/feedback-admin.js", "list", "--limit", "10"], {
    cwd: ROOT, env, encoding: "utf8", timeout: 5000
  });
  assert.equal(cliList.status, 0, cliList.stderr);
  assert.ok(cliList.stdout.includes(fb1.id));
  assert.ok(cliList.stdout.includes(fb2.id));
  assert.ok(cliList.stdout.includes(fbB.id));

  const cliBugs = spawnSync(process.execPath, ["scripts/feedback-admin.js", "list", "--type", "bug", "--json"], {
    cwd: ROOT, env, encoding: "utf8", timeout: 5000
  });
  assert.equal(cliBugs.status, 0, cliBugs.stderr);
  const bugItems = JSON.parse(cliBugs.stdout);
  assert.equal(bugItems.length, 1);
  assert.equal(bugItems[0].id, fb2.id);
  assert.ok(fs.existsSync(bugItems[0].screenshotPath));

  const cliShow = spawnSync(process.execPath, ["scripts/feedback-admin.js", "show", fb2.id], {
    cwd: ROOT, env, encoding: "utf8", timeout: 5000
  });
  assert.equal(cliShow.status, 0, cliShow.stderr);
  assert.ok(cliShow.stdout.includes("Layout overlapped on iPhone SE"));
  assert.ok(cliShow.stdout.includes(withShot.screenshotBlobId));

  // Stop server before taking pre-deletion snapshot so we can test deletion-ledger replay
  const stopped1 = new Promise(r => child.once("exit", r));
  child.kill();
  await stopped1;

  const snapDir = path.join(root, "snap-before-delete");
  await createSnapshot(dir, snapDir);

  // Restart server and delete user A
  const child2 = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child2.exitCode === null) {
      const s = new Promise(r => child2.once("exit", r));
      child2.kill();
      await s;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("restart timeout")), 8000);
    child2.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    child2.once("error", reject);
  });

  const delRes = await req("/api/auth/delete-user", { password: pw }, cookieA);
  assert.equal(delRes.status, 200, await delRes.clone().text());

  const stopped2 = new Promise(r => child2.once("exit", r));
  child2.kill();
  await stopped2;

  // Verify user A's feedback, usage, and screenshot blob are gone, while user B's remains
  const inspect = new DatabaseSync(path.join(dir, "bojin.db"), { readOnly: true });
  try {
    assert.equal(inspect.prepare("SELECT COUNT(*) n FROM feedback WHERE uid = ?").get(meA.id).n, 0);
    assert.equal(inspect.prepare("SELECT COUNT(*) n FROM feedback_usage WHERE uid = ?").get(meA.id).n, 0);
    assert.equal(inspect.prepare("SELECT COUNT(*) n FROM feedback WHERE uid = ?").get(meB.id).n, 1);
  } finally {
    inspect.close();
  }
  assert.equal(fs.existsSync(path.join(dir, "blobs", withShot.screenshotBlobId)), false);

  // Restore pre-deletion snapshot with latest ledger -> user A's feedback must stay deleted!
  const ledger = readLedger(dir);
  const restored = path.join(root, "restored");
  restoreSnapshot(snapDir, restored, ledger);
  const restoredDb = new DatabaseSync(path.join(restored, "bojin.db"), { readOnly: true });
  try {
    assert.equal(restoredDb.prepare("SELECT COUNT(*) n FROM feedback WHERE uid = ?").get(meA.id).n, 0);
    assert.equal(restoredDb.prepare("SELECT COUNT(*) n FROM feedback_usage WHERE uid = ?").get(meA.id).n, 0);
    assert.equal(restoredDb.prepare("SELECT COUNT(*) n FROM feedback WHERE uid = ?").get(meB.id).n, 1);
  } finally {
    restoredDb.close();
  }
  assert.equal(fs.existsSync(path.join(restored, "blobs", withShot.screenshotBlobId)), false);
});

test("UI: Me tab feedback form (zh/en), offline guard, privacy isolation, login mailto, privacy page, and tester docs", async () => {
  const appHtml = fs.readFileSync(path.join(ROOT, "app/index.html"), "utf8");
  const script = appHtml.match(/<script>([\s\S]*?)<\/script>/)[1].split("/* ============ 启动 ============ */")[0];

  function createUiEnv(lang, online = true) {
    const sent = [];
    const toasts = [];
    const listeners = {};
    const appEl = { innerHTML: "", contains: () => false };
    const tabsEl = { innerHTML: "", hidden: true };
    const toastEl = { innerHTML: "", textContent: "", hidden: true };
    const msgEl = { id: "ufb-msg", value: "", focus() {} };
    const countEl = { id: "ufb-count", textContent: "" };
    const openBtn = { dataset: { act: "ufb-open" }, focused: false, focus() { this.focused = true; } };
    const document = {
      documentElement: { lang: lang === "en" ? "en" : "zh-CN" },
      title: "",
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      querySelector(sel) {
        if (sel === "#app") return appEl;
        if (sel === "#tabs") return tabsEl;
        if (sel === "#toast") return toastEl;
        if (sel === "#ufb-msg") return appEl.innerHTML.includes('id="ufb-msg"') ? msgEl : null;
        if (sel === "#ufb-count") return countEl;
        if (sel === '[data-act="ufb-open"]') return openBtn;
        return null;
      },
      querySelectorAll: () => []
    };
    const nav = { userAgent: "TestAgent/1.0", onLine: online, languages: [lang === "en" ? "en-US" : "zh-CN"] };
    const window = {
      innerWidth: 390,
      innerHeight: 844,
      devicePixelRatio: 3,
      screen: { width: 390, height: 844 },
      scrollTo() {},
      ritualErrorReporter: { configure() {}, getRevision: () => "abcdef123456" },
      ritual: {
        hosted: true,
        async sendFeedback(payload) {
          sent.push(payload);
          return { ok: true, id: "fb_1234567890ab" };
        }
      }
    };
    const ctx = vm.createContext({
      window,
      document,
      navigator: nav,
      localStorage: { getItem: k => (k === "bj-lang" ? lang : null), setItem() {}, removeItem() {} },
      location: { hostname: "leanritual.app", search: "", pathname: "/", href: "https://leanritual.app/" },
      console,
      URL,
      Date,
      setTimeout,
      clearTimeout
    });
    vm.runInContext(script, ctx);
    vm.runInContext(`
      S.ready = true;
      S.tab = "me";
      S.profile = { sex: "m", age: 29, height: 176, weight: 71.5, trainDays: [1,3,5], slot: "pm", stage: "maintain", exp: "mid", equipment: "gym", startDate: "2026-11-01", injuries: ["shoulder"], injNote: "PRIVATE_INJURY", supps: [] };
      S.days["2026-11-20"] = { date: "2026-11-20", checkin: { weight: 71.2 }, meals: [{ id: "m1", text: "PRIVATE_MEAL" }] };
      const _origToast = toast;
      toast = (m, ms) => { __toasts.push(m); _origToast(m, ms); };
      render();
    `, Object.assign(ctx, { __toasts: toasts }));
    return { ctx, appEl, msgEl, openBtn, sent, toasts, listeners, nav };
  }

  // Chinese flow: open, offline error keeps message, then go online and submit
  const zh = createUiEnv("zh", false);
  assert.match(zh.appEl.innerHTML, /data-act="ufb-open"/);
  assert.match(zh.appEl.innerHTML, /发反馈/);
  await zh.listeners.click[0]({ target: { closest: () => ({ dataset: { act: "ufb-open" } }) } });
  assert.match(zh.appEl.innerHTML, /id="ufb-msg"/);
  assert.match(zh.appEl.innerHTML, /id="ufb-device"[^>]*checked/);

  zh.msgEl.value = "离线时写的反馈";
  await zh.listeners.click[0]({ target: { closest: () => ({ dataset: { act: "ufb-submit" } }) } });
  assert.equal(zh.sent.length, 0);
  assert.match(zh.appEl.innerHTML, /离线/);
  assert.match(zh.appEl.innerHTML, /离线时写的反馈/);

  // Reconnect and submit
  zh.nav.onLine = true;
  await zh.listeners.click[0]({ target: { closest: () => ({ dataset: { act: "ufb-submit" } }) } });
  assert.equal(zh.sent.length, 1);
  assert.equal(zh.sent[0].type, "bug");
  assert.equal(zh.sent[0].message, "离线时写的反馈");
  assert.equal(zh.sent[0].includeDeviceInfo, true);
  assert.equal(zh.sent[0].deviceInfo.revision, "abcdef123456");
  assert.equal(zh.sent[0].deviceInfo.page, "me");
  assert.equal(zh.sent[0].deviceInfo.lang, "zh");
  assert.equal(zh.sent[0].deviceInfo.online, true);
  assert.match(zh.sent[0].deviceInfo.screen, /^390x844/);
  const serialized = JSON.stringify(zh.sent[0]);
  assert.ok(!serialized.includes("PRIVATE_INJURY"));
  assert.ok(!serialized.includes("PRIVATE_MEAL"));
  assert.ok(!serialized.includes("71.5"));
  assert.ok(zh.toasts.some(x => x.includes("已收到你的反馈")));
  assert.equal(zh.openBtn.focused, true);

  // English flow with device info unchecked + Escape dismiss
  const en = createUiEnv("en", true);
  assert.match(en.appEl.innerHTML, /Send feedback/);
  await en.listeners.click[0]({ target: { closest: () => ({ dataset: { act: "ufb-open" } }) } });
  assert.match(en.appEl.innerHTML, /Include device info/);
  en.listeners.keydown[0]({ key: "Escape", preventDefault() {} });
  assert.doesNotMatch(en.appEl.innerHTML, /id="ufb-msg"/);
  assert.equal(en.openBtn.focused, true);

  await en.listeners.click[0]({ target: { closest: () => ({ dataset: { act: "ufb-open" } }) } });
  await en.listeners.change[0]({ target: { name: "ufb-type", value: "idea" } });
  await en.listeners.change[0]({ target: { id: "ufb-device", checked: false } });
  en.msgEl.value = "Great app!";
  await en.listeners.click[0]({ target: { closest: () => ({ dataset: { act: "ufb-submit" } }) } });
  assert.equal(en.sent.length, 1);
  assert.equal(en.sent[0].type, "idea");
  assert.equal(en.sent[0].includeDeviceInfo, false);
  assert.equal(en.sent[0].deviceInfo, null);
  assert.ok(en.toasts.some(x => x.includes("Feedback sent")));

  // Login page mailto link (zh/en)
  const loginHtml = fs.readFileSync(path.join(ROOT, "public/login.html"), "utf8");
  assert.match(loginHtml, /id="help-link"[^>]*href="mailto:hendrix\.ai\.dev@gmail\.com/);
  assert.match(loginHtml, /Can't sign in\? Email feedback/);

  // Privacy page mentions feedback storage, alert summary, export, deletion, retention in zh & en
  const privacyHtml = fs.readFileSync(path.join(ROOT, "public/privacy.html"), "utf8");
  assert.match(privacyHtml, /应用内反馈/);
  assert.match(privacyHtml, /附带设备信息/);
  assert.match(privacyHtml, /in-app feedback/i);
  assert.match(privacyHtml, /Include device info/);

  // Tester docs point testers to the in-app feedback entry
  for (const [file, pattern] of [
    ["docs/TESTER-GUIDE.zh-CN.md", /「我的」→「反馈」/],
    ["docs/TESTER-GUIDE.en.md", /Me → Send feedback/],
    ["docs/TESTER-QUICKSTART.zh-CN.md", /「我的」→「反馈」/],
    ["docs/TESTER-QUICKSTART.en.md", /Me → Send feedback/]
  ]) {
    const content = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(content, pattern, `${file} should point to in-app feedback`);
  }
});
