"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const {
  MAX_BODY_BYTES,
  MAX_NAME_LEN,
  MAX_GOAL_LEN,
  MAX_NOTE_LEN,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  inviteRequestOptions,
  pruneInviteRequestData,
  formatAlertBody,
  sendInviteRequestAlert,
  createInviteRequests
} = require("../lib/invite-requests");
const { createSnapshot, restoreSnapshot } = require("../lib/snapshots");
const { readLedger, validateLedger } = require("../lib/deletion-ledger");
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
  return new DatabaseSync(":memory:");
}

function rowObj(row) {
  return row ? { ...row } : null;
}

test("unit: validation, strict no-op pending dedup, decoupled metadata-only alerts, hashed-IP limits & retention prune", async () => {
  const db = openMemoryDb();
  let nowMs = Date.parse("2026-11-27T10:00:00.000Z");
  const alerts = [];
  const logs = [];
  let alertDelayMs = 0;
  const fetcher = async (url, init) => {
    if (alertDelayMs > 0) await new Promise(r => setTimeout(r, alertDelayMs));
    alerts.push({ url, headers: init.headers, body: init.body, redirect: init.redirect });
    return { status: 200 };
  };

  const svc = createInviteRequests(db, {
    ipHourly: 4,
    ipDaily: 6,
    globalDaily: 8,
    retentionDays: 90,
    alertUrl: "https://ntfy.example.com/secret-topic",
    ipHashSecret: "unit-test-secret-key-at-least-32-chars",
    fetcher,
    now: () => nowMs,
    log: msg => logs.push(String(msg))
  });

  // 1. Valid mainland China phone normalization (+86) + decoupled non-blocking webhook timing
  alertDelayMs = 300;
  const t0 = Date.now();
  const r1 = await svc.submit({
    name: "  小\u200E明\t测试  ",
    contactKind: "phone",
    contactValue: "138 0013 8000",
    goal: "减脂 5kg，我有哮喘和膝伤，微信号 secret_wx_123",
    note: "私密补充说明",
    lang: "zh"
  }, { ip: "203.0.113.10" });
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 150, `submit must not await external webhook latency (took ${elapsedMs}ms)`);
  assert.equal(r1.ok, true);
  assert.equal(r1.honeypot, false);
  assert.equal(r1.deduplicated, false);
  assert.match(r1.id, /^req_[0-9a-f]{12}$/);
  assert.equal(alerts.length, 0, "slow webhook still in flight right after submit returns");
  await svc.flushPendingAlerts();
  alertDelayMs = 0;

  const origPhoneRow = rowObj(db.prepare("SELECT * FROM invite_requests WHERE id = ?").get(r1.id));
  assert.equal(origPhoneRow.name, "小明 测试");
  assert.equal(origPhoneRow.contact_kind, "phone");
  assert.equal(origPhoneRow.contact_value, "+8613800138000");
  assert.equal(origPhoneRow.note, "私密补充说明");
  assert.equal(origPhoneRow.status, "pending");

  // Alert payload is strictly metadata only: ZERO free text (no name, contact, goal, or note)
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].redirect, "manual");
  assert.equal(alerts[0].body, `[invite-request] #${r1.id} (phone, zh)`);
  for (const leak of ["13800138000", "+8613800138000", "小明", "哮喘", "膝伤", "secret_wx_123", "私密补充说明", "减脂"]) {
    assert.ok(!alerts[0].body.includes(leak), `alert leaked ${leak}: ${alerts[0].body}`);
  }

  // Rate-limit table never stores raw IP
  const rlRows = db.prepare("SELECT bucket, window, n FROM invite_request_rate_limits").all();
  assert.ok(rlRows.some(r => r.bucket.startsWith("ip:") && !r.bucket.includes("203.0.113.10")));
  assert.ok(rlRows.every(r => !JSON.stringify(r).includes("203.0.113.10")));

  // 2. Strict no-op pending deduplication for normalized PHONE:
  // Every column of the original row must stay 100% unchanged and no second alert fires.
  nowMs += 60 * 1000;
  const r1Dup = await svc.submit({
    name: "恶意覆盖者",
    contactKind: "phone",
    contactValue: "+86-138-0013-8000",
    goal: "被替换的目标",
    note: "被替换的备注",
    lang: "en"
  }, { ip: "203.0.113.10" });
  await svc.flushPendingAlerts();

  assert.equal(r1Dup.ok, true);
  assert.equal(r1Dup.deduplicated, true);
  assert.equal(r1Dup.id, r1.id);
  assert.equal(alerts.length, 1, "no duplicate alert for pending phone duplicate");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM invite_requests").get().n, 1);
  assert.deepEqual(
    rowObj(db.prepare("SELECT * FROM invite_requests WHERE id = ?").get(r1.id)),
    origPhoneRow,
    "every column of the original pending phone row must remain untouched"
  );

  // 3. Valid email submission + strict no-op pending deduplication for normalized EMAIL
  const rEmail = await svc.submit({
    name: "A", // single-character name: still never in metadata-only alert
    contactKind: "email",
    contactValue: "  Alice@Example.COM ",
    goal: "Stay consistent with lifting",
    note: "Private note",
    lang: "en"
  }, { ip: "203.0.113.10" });
  await svc.flushPendingAlerts();
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].body, `[invite-request] #${rEmail.id} (email, en)`);
  const origEmailRow = rowObj(db.prepare("SELECT * FROM invite_requests WHERE id = ?").get(rEmail.id));
  assert.equal(origEmailRow.contact_value, "alice@example.com");

  nowMs += 60 * 1000;
  const rEmailDup = await svc.submit({
    name: "Attacker Overwrite",
    contactKind: "email",
    contactValue: "alice@example.com",
    goal: "Overwritten goal",
    note: "Overwritten note",
    lang: "zh"
  }, { ip: "203.0.113.10" });
  await svc.flushPendingAlerts();
  assert.equal(rEmailDup.ok, true);
  assert.equal(rEmailDup.deduplicated, true);
  assert.equal(alerts.length, 2, "no duplicate alert for pending email duplicate");
  assert.deepEqual(
    rowObj(db.prepare("SELECT * FROM invite_requests WHERE id = ?").get(rEmail.id)),
    origEmailRow,
    "every column of the original pending email row must remain untouched"
  );

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

  // 5. Per-IP hourly limit (4/hr reached for 203.0.113.10)
  await assert.rejects(
    () => svc.submit({
      name: "Fifth",
      contactKind: "email",
      contactValue: "fifth@example.com",
      goal: "Get leaner"
    }, { ip: "203.0.113.10" }),
    err => err.status === 429 && err.code === "rate_limited"
  );

  // Advance 1 hour -> hourly bucket resets, daily bucket still tracks 4/6
  nowMs += 60 * 60 * 1000;
  const rUs = await svc.submit({
    name: "Alex",
    contactKind: "phone",
    contactValue: "+1 (415) 555-2671",
    goal: "Build strength",
    lang: "en"
  }, { ip: "203.0.113.10" });
  assert.equal(db.prepare("SELECT contact_value FROM invite_requests WHERE id = ?").get(rUs.id).contact_value, "+14155552671");

  await svc.submit({ name: "Sixth", contactKind: "email", contactValue: "sixth@example.com", goal: "Cut weight" }, { ip: "203.0.113.10" });

  // 6. Per-IP daily limit (6/day reached even after another hour)
  nowMs += 60 * 60 * 1000;
  await assert.rejects(
    () => svc.submit({ name: "Seventh", contactKind: "email", contactValue: "seventh@example.com", goal: "Cut weight" }, { ip: "203.0.113.10" }),
    err => err.status === 429 && err.code === "rate_limited"
  );

  // 7. Global daily limit (8/day across IPs)
  await svc.submit({ name: "G1", contactKind: "email", contactValue: "g1@example.com", goal: "Goal 1" }, { ip: "203.0.113.20" });
  await svc.submit({ name: "G2", contactKind: "email", contactValue: "g2@example.com", goal: "Goal 2" }, { ip: "203.0.113.20" });
  await assert.rejects(
    () => svc.submit({ name: "G3", contactKind: "email", contactValue: "g3@example.com", goal: "Goal 3" }, { ip: "203.0.113.30" }),
    err => err.status === 429 && err.code === "rate_limited"
  );
  await svc.flushPendingAlerts();

  // 8. Validation rejections (advance 1 day)
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

  // 9. Retention max cap clamping (<= 90 days) & deterministic retention/rate-limit pruning
  assert.equal(DEFAULT_RETENTION_DAYS, 90);
  assert.equal(MAX_RETENTION_DAYS, 90);
  assert.equal(inviteRequestOptions({}).retentionDays, 90);
  assert.equal(inviteRequestOptions({ INVITE_REQUEST_RETENTION_DAYS: "30" }).retentionDays, 30);
  assert.equal(inviteRequestOptions({ INVITE_REQUEST_RETENTION_DAYS: "91" }).retentionDays, 90);
  assert.equal(inviteRequestOptions({ INVITE_REQUEST_RETENTION_DAYS: "3650" }).retentionDays, 90);
  assert.throws(() => inviteRequestOptions({ INVITE_REQUEST_RETENTION_DAYS: "0" }));
  assert.throws(() => inviteRequestOptions({ INVITE_REQUEST_RETENTION_DAYS: "-5" }));
  assert.throws(() => inviteRequestOptions({ INVITE_REQUEST_RETENTION_DAYS: "abc" }));

  // Even when a caller passes retentionDays > 90 directly to pruneInviteRequestData, it clamps to 90 days
  nowMs += 95 * 24 * 60 * 60 * 1000; // 95 days later -> all prior requests & rate-limit buckets expired
  const fresh = await svc.submit({ name: "Fresh", contactKind: "email", contactValue: "fresh@example.com", goal: "Keep me" }, { ip: "203.0.113.99" });
  await svc.flushPendingAlerts();
  // Insert an old rate-limit bucket explicitly to prove deterministic prune clears it independently of submit()
  db.prepare("INSERT OR REPLACE INTO invite_request_rate_limits (bucket, window, n) VALUES ('ip:oldbucket', 'd:2026-01-01', 3)").run();
  const pruned = pruneInviteRequestData(db, { nowMs, retentionDays: 365 });
  assert.ok(pruned.deletedRequests >= 6, `expected expired requests pruned under 90-day clamp, got ${pruned.deletedRequests}`);
  assert.ok(pruned.deletedRateLimits >= 1, `expected expired rate-limit buckets pruned, got ${pruned.deletedRateLimits}`);
  assert.deepEqual(
    db.prepare("SELECT id FROM invite_requests").all().map(r => r.id),
    [fresh.id],
    "only fresh request remains after 90-day clamped retention prune"
  );
  // Expired requests get tombstones in invite_request_deletions (zero PII)
  assert.ok(db.prepare("SELECT 1 FROM invite_request_deletions WHERE id = ?").get(r1.id));
  assert.ok(db.prepare("SELECT 1 FROM invite_request_deletions WHERE id = ?").get(rEmail.id));
  assert.equal(db.prepare("SELECT 1 FROM invite_request_rate_limits WHERE bucket = 'ip:oldbucket'").get(), undefined);

  // 10. Alert formatting & failure handling never leaks ALERT_URL
  assert.equal(formatAlertBody({ id: "req_1234567890ab", contactKind: "email", lang: "en" }), "[invite-request] #req_1234567890ab (email, en)");
  const failLogs = [];
  const resErr = await sendInviteRequestAlert({
    alertUrl: "https://ntfy.example.com/ultra-secret-topic-xyz",
    record: { id: "req_1234567890ab", contactKind: "email", lang: "zh" },
    fetcher: async () => { throw new Error("network down"); },
    log: msg => failLogs.push(String(msg))
  });
  assert.equal(resErr.sent, false);
  assert.ok(failLogs.length >= 1);
  assert.ok(failLogs.every(l => !l.includes("ultra-secret-topic-xyz")), "never logs ALERT_URL");

  db.close();
});

test("HTTP integration + body timeout + admin CLI (list/show/mark/delete/prune) + deletion-ledger restore replay + daily-summary", { timeout: 30000 }, async t => {
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
    INVITE_REQUEST_GLOBAL_DAILY_LIMIT: "8",
    INVITE_REQUEST_BODY_TIMEOUT_MS: "250",
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

  // Slow-drip chunked upload hits route-level body deadline (408 request_timeout) promptly
  const slowStart = Date.now();
  const slowResult = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/api/invite-requests",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
        "X-Bojin": "1",
        "X-Forwarded-For": "198.51.100.99"
      }
    }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", c => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: data, elapsedMs: Date.now() - slowStart }));
    });
    req.on("error", err => {
      // Ignore ECONNRESET/EPIPE after server closes timed-out socket
      if (!["ECONNRESET", "EPIPE"].includes(err.code)) reject(err);
    });
    req.write('{"name":"slow-drip'); // deliberately never call req.end()
  });
  assert.equal(slowResult.status, 408);
  assert.equal(JSON.parse(slowResult.body).error, "request_timeout");
  assert.ok(slowResult.elapsedMs < 2000, `slow body should abort promptly (took ${slowResult.elapsedMs}ms)`);

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

  // Duplicate pending phone is a strict no-op (original fields preserved intact)
  const pDup = await post({
    name: "恶意替换名称",
    contactKind: "phone",
    contactValue: "+8613900139000",
    goal: "恶意替换目标",
    note: "恶意替换备注",
    lang: "en"
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

  // Second email from another IP (for delete --contact test)
  const e2Res = await post({
    name: "RemoveMe",
    contactKind: "email",
    contactValue: "remove.me@example.com",
    goal: "Test deletion by contact",
    lang: "en"
  }, { ip: "198.51.100.2", lang: "en" });
  assert.equal(e2Res.status, 200);

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

  // 4th real request from 198.51.100.1 hits per-IP hourly limit (3)
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
  for (const secret of ["13900139000", "jane.secret@example.com", "Jane.Secret@Example.COM", "张三私密昵称", "Jane SecretName", "zhangsan_secret", "恶意替换名称"]) {
    assert.ok(!combinedLogs.includes(secret), `server log leaked PII: ${secret}`);
  }
  assert.match(combinedLogs, /invite-request.*"contactKind":"phone".*"status":"created"/);
  assert.match(combinedLogs, /invite-request.*"contactKind":"phone".*"status":"duplicate"/);
  assert.match(combinedLogs, /invite-request.*"contactKind":"email".*"status":"created"/);

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
  assert.equal(items.length, 3, "honeypot dropped and duplicate pending did not duplicate");
  const phoneItem = items.find(i => i.contactKind === "phone");
  const emailItem = items.find(i => i.contactValue === "jane.secret@example.com");
  const removeItem = items.find(i => i.contactValue === "remove.me@example.com");
  assert.equal(phoneItem.contactValue, "+8613900139000");
  assert.equal(phoneItem.name, "张三私密昵称", "pending duplicate did not overwrite name");
  assert.equal(phoneItem.goal, "减脂增肌", "pending duplicate did not overwrite goal");
  assert.equal(phoneItem.note, "微信 zhangsan_secret", "pending duplicate did not overwrite note");
  assert.equal(phoneItem.lang, "zh", "pending duplicate did not overwrite lang");
  assert.equal(phoneItem.created, phoneItem.updated, "pending duplicate did not bump updated");

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
  assert.deepEqual(JSON.parse(listPending.stdout).map(i => i.id).sort(), [emailItem.id, removeItem.id].sort());

  const listInvited = runAdmin(["list", "--status", "invited", "--json"]);
  assert.equal(listInvited.status, 0, listInvited.stderr);
  assert.deepEqual(JSON.parse(listInvited.stdout).map(i => i.id), [phoneItem.id]);

  const badStatus = runAdmin(["mark", emailItem.id, "--status", "all"]);
  assert.notEqual(badStatus.status, 0);
  const missingId = runAdmin(["show", "req_nonexistent"]);
  assert.notEqual(missingId.status, 0);

  // Stop server, take snapshot BEFORE deletions, then delete by ID and by --contact,
  // and verify deletion-ledger replay prevents resurrection on restore!
  const stopped = new Promise(r => child.once("exit", r));
  child.kill();
  await stopped;

  const snapBeforeDelete = path.join(dir, "backups", "snapshot-20261127T120000Z");
  await createSnapshot(dataDir, snapBeforeDelete);

  // Daily summary on snapshot before deletions
  const summary = collectDailySummary({
    dataDir,
    snapshotDir: snapBeforeDelete,
    noJournal: true,
    noSystemd: true
  });
  assert.equal(summary.inviteRequests.snapshotAvailable, true);
  assert.equal(summary.inviteRequests.tablePresent, true);
  assert.equal(summary.inviteRequests.pendingTotal, 2);
  assert.deepEqual(summary.inviteRequests.byStatus, { pending: 2, invited: 1, dismissed: 0 });
  assert.deepEqual(summary.inviteRequests.last24h, { new: 3, byKind: { phone: 1, email: 2 } });
  assert.deepEqual(summary.inviteRequests.trialToDate, { new: 3, byKind: { phone: 1, email: 2 } });

  const reportText = formatSummaryText(summary);
  assert.match(reportText, /\[内测申请 \/ Invite Requests\]/);
  assert.match(reportText, /待处理 \(pending\): 2/);
  const summaryBlob = JSON.stringify(summary) + "\n" + reportText;
  for (const secret of ["13900139000", "jane.secret@example.com", "张三私密昵称", "Jane SecretName", "减脂增肌"]) {
    assert.ok(!summaryBlob.includes(secret), `daily-summary leaked PII: ${secret}`);
  }

  // Delete by ID (phoneItem) and by --contact (removeItem, case-insensitive email)
  const delById = runAdmin(["delete", phoneItem.id, "--json"]);
  assert.equal(delById.status, 0, delById.stderr);
  assert.deepEqual(JSON.parse(delById.stdout).deletedIds, [phoneItem.id]);

  const delByContact = runAdmin(["delete", "--contact", "REMOVE.ME@EXAMPLE.COM", "--json"]);
  assert.equal(delByContact.status, 0, delByContact.stderr);
  assert.deepEqual(JSON.parse(delByContact.stdout).deletedIds, [removeItem.id]);

  // Verify deletion ledger contains ONLY random req_* IDs + timestamps (zero PII)
  const ledger = readLedger(dataDir);
  assert.equal(ledger.version, 1);
  assert.deepEqual(ledger.inviteRequests.map(r => r.id).sort(), [phoneItem.id, removeItem.id].sort());
  const ledgerStr = JSON.stringify(ledger);
  for (const secret of ["13900139000", "remove.me@example.com", "张三私密昵称", "RemoveMe"]) {
    assert.ok(!ledgerStr.includes(secret), `deletion ledger leaked PII: ${secret}`);
  }
  // Backward compatibility & validation of validateLedger
  assert.ok(validateLedger({ version: 1, exportedAt: new Date().toISOString(), users: [] }));
  assert.throws(() => validateLedger({ version: 1, exportedAt: new Date().toISOString(), users: [], inviteRequests: [{ id: "bad_id", deleted: "2026-11-27T00:00:00Z" }] }));

  // Restore older pre-delete snapshot with latest deletion ledger -> deleted requests MUST stay gone!
  const restoredDir = path.join(dir, "restored");
  restoreSnapshot(snapBeforeDelete, restoredDir, ledger);
  const restoredDb = new DatabaseSync(path.join(restoredDir, "bojin.db"), { readOnly: true });
  try {
    const remaining = restoredDb.prepare("SELECT id FROM invite_requests ORDER BY id").all().map(r => r.id);
    assert.deepEqual(remaining, [emailItem.id], "restore replay must erase deleted invite requests and keep others");
    const tombstones = restoredDb.prepare("SELECT id FROM invite_request_deletions ORDER BY id").all().map(r => r.id);
    assert.deepEqual(tombstones, [phoneItem.id, removeItem.id].sort(), "restore replay preserves tombstones");
  } finally {
    restoredDb.close();
  }

  // Admin CLI prune command runs cleanly and rejects --days > 90
  const pruneOut = runAdmin(["prune", "--days", "90", "--json"]);
  assert.equal(pruneOut.status, 0, pruneOut.stderr);
  assert.equal(JSON.parse(pruneOut.stdout).ok, true);
  const pruneTooHigh = runAdmin(["prune", "--days", "91"]);
  assert.notEqual(pruneTooHigh.status, 0, "prune --days must reject values above 90");
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

  // 1. Mobile 375x667 zh flow
  {
    const { context, page, log } = await openWatched({ viewport: { width: 375, height: 667 }, locale: "zh-CN", reducedMotion: "reduce" });
    await page.goto(base + "/?lang=zh");
    const triggers = page.locator('[data-open-apply][data-i="cta.ask"]');
    assert.equal(await triggers.count(), 2);
    assert.equal(await triggers.nth(0).textContent(), "申请内测");
    assert.equal(await triggers.nth(1).textContent(), "申请内测");
    assert.match(await page.locator('footer a[data-i="foot.contact"]').getAttribute("href"), /^mailto:hendrix\.ai\.dev@gmail\.com/);

    await triggers.nth(0).click();
    await page.locator("#apply-modal").waitFor({ state: "visible" });
    assert.equal(await page.locator("#apply-cc").inputValue(), "CN");
    assert.equal(await page.locator('#apply-method button[data-kind="phone"]').getAttribute("aria-pressed"), "true");

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

    assert.deepEqual(await runAxe(page), [], "axe violations in zh 375px modal");

    await page.keyboard.press("Escape");
    await page.locator("#apply-modal").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.matches('.hero [data-open-apply]')), true, "focus restored to hero trigger");

    await triggers.nth(0).click();
    await page.fill("#apply-name", "林小满");
    await page.fill("#apply-phone", "138 0013 8888");
    await page.click("#apply-submit");
    assert.equal(await page.locator("#apply-err").textContent(), "请填写你想达成的目标");

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "EN" }).click();
    assert.equal(await triggers.nth(0).textContent(), "Request an invite");
    assert.equal(await triggers.nth(1).textContent(), "Request an invite");
    await triggers.nth(0).click();
    assert.equal(await page.locator("#apply-name").inputValue(), "林小满");
    assert.equal(await page.locator("#apply-phone").inputValue(), "138 0013 8888");
    assert.equal(await page.locator("#apply-err").textContent(), "Please tell us your goal.");
    assert.equal(await page.locator('#apply-method button[data-kind="phone"]').getAttribute("aria-pressed"), "true");

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

  // 2. Desktop 1440x900 en flow
  {
    const { context, page, log } = await openWatched({ viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
    await page.goto(base + "/?lang=en&apply=1");
    await page.locator("#apply-modal").waitFor({ state: "visible" });
    assert.equal(await page.locator('#apply-method button[data-kind="email"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('.apply-privacy a[href="/privacy.html"]').textContent(), "Privacy Notice");

    assert.deepEqual(await runAxe(page), [], "axe violations in en 1440px modal");

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

  const db = new DatabaseSync(path.join(dataDir, "bojin.db"), { readOnly: true });
  const saved = db.prepare("SELECT name, contact_kind, contact_value, lang, status FROM invite_requests ORDER BY created ASC").all().map(r => ({ ...r }));
  db.close();
  assert.deepEqual(saved, [
    { name: "林小满", contact_kind: "phone", contact_value: "+8613800138888", lang: "zh", status: "pending" },
    { name: "Taylor", contact_kind: "email", contact_value: "taylor@example.com", lang: "en", status: "pending" },
    { name: "Jordan", contact_kind: "phone", contact_value: "+14155552671", lang: "en", status: "pending" }
  ]);
});

test("privacy.html and docs/OPERATIONS.md accurately cover metadata-only alerts, status note, 90-day live-DB vs backup retention, and ledger-conditional restore replay", () => {
  const html = fs.readFileSync(path.join(ROOT, "public/privacy.html"), "utf8");
  const zh = html.match(/<article id="doc-zh">([\s\S]*?)<\/article>/)[1];
  const en = html.match(/<article id="doc-en" hidden>([\s\S]*?)<\/article>/)[1];
  const ops = fs.readFileSync(path.join(ROOT, "docs/OPERATIONS.md"), "utf8");

  for (const term of [
    "申请内测",
    "审核/处理状态备注",
    "加盐哈希后的 IP 桶",
    "2 天后自动清理",
    "仅含元数据的纯文本提醒",
    "不包含你的称呼、手机号、邮箱地址、目标正文、补充说明或状态备注",
    "实时主机数据库中默认并最多保留 90 天",
    "服务启动时及每小时会自动清理超期记录",
    "服务器备份快照按下方独立的备份保留策略留存副本",
    "恢复时可用的最新删除清单",
    "随机申请编号与删除时间"
  ]) {
    assert.ok(zh.includes(term), `privacy.html zh missing term: ${term}`);
  }
  for (const term of [
    "Request an invite",
    "operator status note",
    "salted HMAC-hashed IP buckets",
    "pruned after 2 days",
    "metadata-only plain-text notification",
    "never your name, phone number, email address, goal text, optional note, or status note",
    "In the live host database",
    "capped at 90 days maximum",
    "swept automatically at server startup and hourly",
    "Server backup snapshots retain copies under their own separate backup retention schedule",
    "latest available deletion ledger is replayed on restore",
    "random request ID and deletion timestamp only"
  ]) {
    assert.ok(en.includes(term), `privacy.html en missing term: ${term}`);
  }
  assert.ok(!zh.includes("目标前 80 字预览"), "zh privacy notice must not claim goal previews are sent to alerts");
  assert.ok(!en.includes("first 80 characters of your goal"), "en privacy notice must not claim goal previews are sent to alerts");

  for (const term of [
    "INVITE_REQUEST_BODY_TIMEOUT_MS=5000",
    "INVITE_REQUEST_RETENTION_DAYS",
    "values above `90` are clamped to `90`",
    "[invite-request] #id (phone|email, zh|en)",
    "invite_request_deletions",
    "invite-requests-admin.js delete",
    "invite-requests-admin.js prune",
    "deletions-live.json",
    "When the outgoing `DATA_DIR` is unavailable",
    "deleted_req_ids"
  ]) {
    assert.ok(ops.includes(term), `docs/OPERATIONS.md missing term: ${term}`);
  }
});
