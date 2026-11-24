"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const {
  DEFAULT_AI_PRICING,
  createReportPseudonymizer,
  parsePricing,
  sanitizeFeedbackExcerpt,
  parseJournalStream,
  collectDailySummary,
  formatSummaryText
} = require("../lib/daily-summary");
const { createSnapshot, verifySnapshot } = require("../lib/snapshots");
const dataAccess = require("../lib/data-access");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "daily-summary.js");

function makeBase36MealId(ms, suffix = "ab12c") {
  return ms.toString(36) + suffix;
}

function createFixture(t, { nowIso = "2026-11-24T10:00:00.000Z" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-summary-"));
  const dataDir = path.join(root, "data");
  const blobsDir = path.join(dataDir, "blobs");
  const backupRoot = path.join(root, "backups");
  const deployBackupRoot = path.join(root, "backups-deploy");
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.mkdirSync(deployBackupRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const nowMs = Date.parse(nowIso);
  const hoursAgo = (h) => new Date(nowMs - h * 3600 * 1000).toISOString();
  const msHoursAgo = (h) => nowMs - h * 3600 * 1000;

  // 1. auth.sqlite
  const authDb = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  authDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE "user" (
      "id" text not null primary key,
      "name" text not null,
      "email" text not null unique,
      "emailVerified" integer not null,
      "image" text,
      "createdAt" date not null,
      "updatedAt" date not null
    );
    CREATE TABLE "session" (
      "id" text not null primary key,
      "expiresAt" date not null,
      "token" text not null unique,
      "createdAt" date not null,
      "updatedAt" date not null,
      "ipAddress" text,
      "userAgent" text,
      "userId" text not null
    );
  `);
  const insertUser = authDb.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, image, createdAt, updatedAt) VALUES (?, ?, ?, ?, NULL, ?, ?)`
  );
  // u_alpha: signed up 5 days ago, verified 5 days ago
  insertUser.run("u_alpha_secret", "Alice SecretName", "alice.secret@example.com", 1, hoursAgo(120), hoursAgo(120));
  // u_beta: signed up 3 days ago, already verified, user row updated 4 hours ago (must NOT inflate 24h verifiedSignups!)
  insertUser.run("u_beta_secret", "Bob SecretName", "bob.secret@example.com", 1, hoursAgo(72), hoursAgo(4));
  // u_gamma: signed up 6 hours ago, verified 5 hours ago (counts in 24h signups & verifiedSignups)
  insertUser.run("u_gamma_secret", "Carol SecretName", "carol.secret@example.com", 1, hoursAgo(6), hoursAgo(5));
  // u_delta: signed up 2 hours ago, NOT verified yet (counts in 24h signups, not verifiedSignups)
  insertUser.run("u_delta_secret", "Dave SecretName", "dave.secret@example.com", 0, hoursAgo(2), hoursAgo(2));

  const insertSession = authDb.prepare(
    `INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertSession.run("s1", hoursAgo(-100), "tok_secret_1", hoursAgo(3), hoursAgo(3), "10.0.0.1", "Safari", "u_beta_secret");
  insertSession.run("s2", hoursAgo(-20), "tok_secret_2", hoursAgo(80), hoursAgo(80), "10.0.0.2", "Chrome", "u_alpha_secret");
  authDb.close();

  // 2. bojin.db
  const bojinDb = new DatabaseSync(path.join(dataDir, "bojin.db"));
  bojinDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE docs (path TEXT PRIMARY KEY, uid TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
    CREATE TABLE ai_usage (uid TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(uid, day));
    CREATE TABLE feedback (
      id TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      screenshot_blob_id TEXT,
      device_info TEXT,
      created TEXT NOT NULL
    );
  `);

  const putDoc = bojinDb.prepare("INSERT INTO docs (path, uid, parent, data, updated) VALUES (?, ?, ?, ?, ?)");
  putDoc.run(
    "data/users/u_alpha_secret/app/days/2026-11-24",
    "u_alpha_secret",
    "data/users/u_alpha_secret/app/days",
    JSON.stringify({
      date: "2026-11-24",
      checkin: { weight: 71.2, sleep: 7.5, steps: 9200 },
      workout: { done: true, key: "push", savedAt: hoursAgo(5), note: "PRIVATE_WORKOUT_NOTE" },
      meals: [
        { id: makeBase36MealId(msHoursAgo(8), "aaaaa"), type: "早餐", text: "PRIVATE_MEAL_TEXT_1", est: { kcal: 500, at: hoursAgo(8) } },
        { id: makeBase36MealId(msHoursAgo(2), "bbbbb"), type: "午餐", text: "PRIVATE_MEAL_TEXT_2", est: { kcal: 650, at: hoursAgo(2) } }
      ]
    }),
    hoursAgo(2)
  );
  putDoc.run(
    "data/users/u_alpha_secret/app/days/2026-11-21",
    "u_alpha_secret",
    "data/users/u_alpha_secret/app/days",
    JSON.stringify({
      date: "2026-11-21",
      checkin: { weight: 71.6 },
      workout: { done: true, key: "pull", savedAt: hoursAgo(75) },
      meals: [
        // Created 74h ago (encoded in base36 id), even if re-estimated 1h ago it is NOT a new 24h meal.
        { id: makeBase36MealId(msHoursAgo(74), "ccccc"), type: "晚餐", text: "OLD_MEAL_REEST", est: { kcal: 700, at: hoursAgo(1) } }
      ]
    }),
    hoursAgo(74)
  );
  putDoc.run(
    "data/users/u_gamma_secret/app/days/2026-11-24",
    "u_gamma_secret",
    "data/users/u_gamma_secret/app/days",
    JSON.stringify({
      date: "2026-11-24",
      checkin: { weight: null, sleep: "" },
      workout: { done: false, key: "legs" },
      meals: [
        { id: "custom-meal-1", type: "加餐", text: "PRIVATE_SNACK", est: { kcal: 210, at: hoursAgo(3) } }
      ]
    }),
    hoursAgo(3)
  );
  putDoc.run(
    "data/users/u_gamma_secret/app/app/profile",
    "u_gamma_secret",
    "data/users/u_gamma_secret/app/app",
    JSON.stringify({ weight: 68, height: 175 }),
    hoursAgo(5)
  );

  const blob1 = Buffer.alloc(10240, 0xaa);
  const blob2 = Buffer.alloc(20480, 0xbb);
  const b1Id = "1".repeat(32);
  const b2Id = "2".repeat(32);
  fs.writeFileSync(path.join(blobsDir, b1Id), blob1);
  fs.writeFileSync(path.join(blobsDir, b2Id), blob2);
  bojinDb.prepare("INSERT INTO blobs (id, uid, type, size, created) VALUES (?, ?, ?, ?, ?)").run(b1Id, "u_alpha_secret", "image/webp", blob1.length, hoursAgo(3));
  bojinDb.prepare("INSERT INTO blobs (id, uid, type, size, created) VALUES (?, ?, ?, ?, ?)").run(b2Id, "u_alpha_secret", "image/webp", blob2.length, hoursAgo(60));

  bojinDb.prepare("INSERT INTO ai_usage (uid, day, n) VALUES (?, ?, ?)").run("u_alpha_secret", "2026-11-24", 3);
  bojinDb.prepare("INSERT INTO ai_usage (uid, day, n) VALUES (?, ?, ?)").run("u_gamma_secret", "2026-11-24", 1);
  bojinDb.prepare("INSERT INTO ai_usage (uid, day, n) VALUES (?, ?, ?)").run("u_alpha_secret", "2026-11-21", 2);

  // Feedback (4 entries: newest contains name, phone, URL, email, token, control chars)
  const insertFb = bojinDb.prepare(
    "INSERT INTO feedback (id, uid, type, message, screenshot_blob_id, device_info, created) VALUES (?, ?, ?, ?, ?, NULL, ?)"
  );
  const sensitiveMsg =
    "我是张三，电话 +86 138-0013-8000，邮箱 leak@example.com，链接 https://evil.test/reset?t=1 密钥 AIzaSySecretKey12345 \x1b[31mRED\x1b[0m\u202e TAIL_MARKER";
  insertFb.run("fb_rawpk000004", "u_alpha_secret", "bug", sensitiveMsg, b1Id, hoursAgo(1));
  insertFb.run("fb_rawpk000003", "u_alpha_secret", "idea", "希望能导出最近两周的体重和训练曲线图片", null, hoursAgo(10));
  insertFb.run("fb_rawpk000002", "u_beta_secret", "other", "整体很顺手，界面在手机上字号刚好！", null, hoursAgo(40));
  insertFb.run("fb_rawpk000001", "u_gamma_secret", "bug", "很早的反馈不应出现在最新三条", null, hoursAgo(90));
  bojinDb.close();

  // 3. Journal log file (mixing JSON and short-iso formats)
  const journalFile = path.join(root, "journal.log");
  const jLines = [
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(2) * 1000),
      MESSAGE: "ai provider=gemini retries=1 kind=json images=1 model=gemini-3.8-flash finish_reason=stop prompt=1000 completion=400 reasoning=0 empty=false ms=3200"
    }),
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(5) * 1000),
      MESSAGE: "ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=stop prompt=2000 completion=600 reasoning=100 empty=false ms=4100"
    }),
    // Fallback call with 2 Gemini backoff retries prior to OpenRouter fallback!
    `${hoursAgo(4).replace(".000Z", "+0000")} leanritual node[4242]: ai provider=openrouter provider_fallback=true retries=2 kind=json images=1 model=google/gemini-3.8-flash finish_reason=stop prompt=1500 completion=500 reasoning=0 empty=false ms=6100`,
    `${hoursAgo(3).replace(".000Z", "+0000")} leanritual node[4242]: ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=error prompt=0 completion=0 reasoning=0 empty=true ms=1500`,
    // Older legacy line without provider=
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(70) * 1000),
      MESSAGE: "ai kind=json images=0 model=google/gemini-3.8-flash finish_reason=stop prompt=4000 completion=1000 reasoning=200 empty=false ms=5000"
    }),
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(68) * 1000),
      MESSAGE: "ai provider=gemini kind=text images=0 model=gemini-3.8-flash finish_reason=stop prompt=500 completion=200 reasoning=0 empty=false ms=1200"
    }),
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(3) * 1000),
      MESSAGE: `client-error auth=user page=food lang=zh rev=abc1234 ua=Safari/iOS18 source=index.html:120:5 name=TypeError ts=${hoursAgo(3)} msg="Cannot read properties of null or undefined"`
    }),
    `${hoursAgo(6).replace(".000Z", "+0000")} leanritual node[4242]: client-error auth=anon page=login lang=zh rev=abc1234 ua=Chrome/Android14 source=login.html:45:1 name=SaveError ts=${hoursAgo(6)} msg="Error details withheld"`,
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(50) * 1000),
      MESSAGE: `client-error auth=user page=today lang=en rev=abc1234 ua=Chrome/macOS15 source=index.html:88:1 name=TypeError ts=${hoursAgo(50)} msg="Network request failed"`
    }),
    `${hoursAgo(1).replace(".000Z", "+0000")} leanritual node[4242]: 薄肌日课已启动：http://127.0.0.1:8080`
  ];
  fs.writeFileSync(journalFile, jLines.join("\n") + "\n", "utf8");

  // 4. Backup snapshots
  const dailySnap = path.join(backupRoot, "snapshot-20261124T040000Z");
  fs.mkdirSync(dailySnap, { recursive: true });
  fs.writeFileSync(
    path.join(dailySnap, "manifest.json"),
    JSON.stringify({ version: 1, created: "2026-11-24T04:01:15.000Z", files: [] })
  );
  const olderDailySnap = path.join(backupRoot, "snapshot-20261123T040000Z");
  fs.mkdirSync(olderDailySnap, { recursive: true });
  fs.writeFileSync(
    path.join(olderDailySnap, "manifest.json"),
    JSON.stringify({ version: 1, created: "2026-11-23T04:01:00.000Z", files: [] })
  );
  fs.mkdirSync(path.join(backupRoot, "snapshot-20990101T000000Z"), { recursive: true });

  const deploySnap = path.join(deployBackupRoot, "20261123T180000Z-abcd1234");
  fs.mkdirSync(path.join(deploySnap, "snapshot"), { recursive: true });
  fs.writeFileSync(
    path.join(deploySnap, "snapshot", "manifest.json"),
    JSON.stringify({ version: 1, created: "2026-11-23T18:00:30.000Z", files: [] })
  );

  return { root, dataDir, backupRoot, deployBackupRoot, journalFile, nowMs, nowIso, hoursAgo, msHoursAgo };
}

test("collectDailySummary computes accurate 24h and trial-to-date metrics with zero PII or free text by default", async (t) => {
  const fx = createFixture(t);
  const summary = await collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    journalFile: fx.journalFile,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot,
    noSystemd: true,
    env: {}
  });

  // Accounts: 24h cohort has 2 signups (gamma verified, delta unverified) => verifiedSignups = 1.
  // u_beta (signed up 72h ago, updatedAt 4h ago) is NOT miscounted as a 24h verification!
  assert.equal(summary.accounts.authDbPresent, true);
  assert.deepEqual(summary.accounts.last24h, { signups: 2, verifiedSignups: 1 });
  assert.deepEqual(summary.accounts.trialToDate, { signups: 4, verified: 3, unverified: 1 });

  // Active users
  assert.deepEqual(summary.activeUsers, { last24h: 3, trialToDate: 3 });

  // Logs
  assert.deepEqual(summary.logs.last24h, { checkins: 1, workouts: 1, meals: 3 });
  assert.deepEqual(summary.logs.trialToDate, { checkins: 2, workouts: 2, meals: 4 });

  // AI: Gemini retries MUST include the 2 pre-fallback retries on the OpenRouter fallback call (1 + 2 = 3)!
  assert.equal(summary.ai.source, "journal");
  assert.equal(summary.ai.last24h.calls, 4);
  assert.equal(summary.ai.last24h.errors, 1);
  assert.equal(summary.ai.last24h.unpricedCalls, 0);
  assert.equal(summary.ai.last24h.dbCallsTodayUtc, 4);
  assert.equal(summary.ai.last24h.byProvider.gemini.calls, 3);
  assert.equal(summary.ai.last24h.byProvider.gemini.retries, 3);
  assert.equal(summary.ai.last24h.byProvider.gemini.errors, 1);
  assert.deepEqual(summary.ai.last24h.byProvider.gemini.models, ["gemini-3.8-flash"]);
  assert.equal(summary.ai.last24h.byProvider.gemini.promptTokens, 3000);
  assert.equal(summary.ai.last24h.byProvider.gemini.completionTokens, 1000);
  assert.equal(summary.ai.last24h.byProvider.gemini.reasoningTokens, 100);
  assert.equal(summary.ai.last24h.byProvider.gemini.estimatedCostUsd, 0.006);

  assert.equal(summary.ai.last24h.byProvider.openrouter.calls, 1);
  assert.equal(summary.ai.last24h.byProvider.openrouter.retries, 0);
  assert.equal(summary.ai.last24h.byProvider.openrouter.fallbackCalls, 1);
  assert.equal(summary.ai.last24h.byProvider.openrouter.primaryCalls, 0);
  assert.deepEqual(summary.ai.last24h.byProvider.openrouter.models, ["google/gemini-3.8-flash"]);
  assert.equal(summary.ai.last24h.byProvider.openrouter.estimatedCostUsd, 0.003);
  assert.equal(summary.ai.last24h.estimatedCostUsd, 0.009);

  // Feedback: default mode omits free text and raw feedback PKs!
  assert.equal(summary.feedback.excerptsIncluded, false);
  assert.deepEqual(summary.feedback.last24h, { total: 2, byType: { bug: 1, idea: 1, other: 0 } });
  assert.deepEqual(summary.feedback.trialToDate, { total: 4, byType: { bug: 2, idea: 1, other: 1 } });
  assert.equal(summary.feedback.newest.length, 3);
  assert.equal("excerpt" in summary.feedback.newest[0], false);
  assert.equal("id" in summary.feedback.newest[0], false);
  assert.match(summary.feedback.newest[0].ref, /^fb_[0-9a-f]{8}$/);
  assert.match(summary.feedback.newest[0].user, /^u_[0-9a-f]{8}$/);
  assert.equal(summary.feedback.newest[0].type, "bug");
  assert.equal(summary.feedback.newest[0].hasScreenshot, true);
  assert.ok(summary.feedback.newest[0].messageChars > 50);
  // First two newest feedback items share the same author (u_alpha_secret) within this report
  assert.equal(summary.feedback.newest[0].user, summary.feedback.newest[1].user);
  assert.notEqual(summary.feedback.newest[0].user, summary.feedback.newest[2].user);

  // Client errors
  assert.equal(summary.clientErrors.source, "journal");
  assert.equal(summary.clientErrors.last24h.count, 2);
  assert.deepEqual(summary.clientErrors.last24h.byName, { TypeError: 1, SaveError: 1 });
  assert.equal(summary.clientErrors.trialToDate.count, 3);

  // Storage & photos
  assert.ok(summary.storage.disk && summary.storage.disk.totalBytes > 0);
  assert.equal(summary.storage.photos.totalDbCount, 2);
  assert.equal(summary.storage.photos.totalDbBytes, 30720);
  assert.equal(summary.storage.photos.diskCount, 2);
  assert.equal(summary.storage.photos.diskBytes, 30720);
  assert.deepEqual(summary.storage.photos.last24h, { count: 1, bytes: 10240 });

  // Backup
  assert.equal(summary.backup.source, "filesystem");
  assert.equal(summary.backup.lastBackupAt, "2026-11-24T04:01:15.000Z");
  assert.equal(summary.backup.latestSnapshotName, "snapshot-20261124T040000Z");
  assert.equal(summary.backup.timerLastTriggerAt, null);

  // Strict PII, secret, free-text, and raw-ID leak check across JSON and plain text
  const jsonText = JSON.stringify(summary);
  const plainText = formatSummaryText(summary);
  for (const forbidden of [
    "alice.secret@example.com",
    "bob.secret@example.com",
    "carol.secret@example.com",
    "dave.secret@example.com",
    "leak@example.com",
    "Alice SecretName",
    "Bob SecretName",
    "u_alpha_secret",
    "u_beta_secret",
    "u_gamma_secret",
    "u_delta_secret",
    "fb_rawpk000004",
    "fb_rawpk000003",
    "fb_rawpk000002",
    "tok_secret_1",
    "PRIVATE_WORKOUT_NOTE",
    "PRIVATE_MEAL_TEXT_1",
    "PRIVATE_SNACK",
    "张三",
    "138-0013-8000",
    "evil.test",
    "AIzaSySecretKey12345",
    "希望能导出",
    "TAIL_MARKER"
  ]) {
    assert.ok(!jsonText.includes(forbidden), `JSON must not leak ${forbidden}`);
    assert.ok(!plainText.includes(forbidden), `plain text must not leak ${forbidden}`);
  }

  const rawControlRe = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/;
  assert.equal(rawControlRe.test(plainText), false, "plain text must not contain raw control/bidi chars");
});

test("zero filesystem side effects on 0500 read-only DATA_DIR and concurrent createSnapshot succeeds", async (t) => {
  const fx = createFixture(t);

  // 1. Quiescent WAL DB inside a 0500 read-only DATA_DIR: proves ZERO files created (no .access, no -wal/-shm)
  const bojinDbPath = path.join(fx.dataDir, "bojin.db");
  const authDbPath = path.join(fx.dataDir, "auth.sqlite");
  const beforeEntries = fs.readdirSync(fx.dataDir).sort();
  assert.equal(fs.existsSync(path.join(fx.dataDir, ".access")), false);
  fs.chmodSync(bojinDbPath, 0o400);
  fs.chmodSync(authDbPath, 0o400);
  fs.chmodSync(fx.dataDir, 0o500);
  try {
    const s = await collectDailySummary({
      dataDir: fx.dataDir,
      nowMs: fx.nowMs,
      noJournal: true,
      noSystemd: true,
      backupRoot: fx.backupRoot,
      deployBackupRoot: fx.deployBackupRoot
    });
    assert.equal(s.accounts.trialToDate.signups, 4);
    assert.equal(s.logs.trialToDate.meals, 4);
    assert.deepEqual(fs.readdirSync(fx.dataDir).sort(), beforeEntries);
    assert.equal(fs.existsSync(path.join(fx.dataDir, ".access")), false);
  } finally {
    fs.chmodSync(fx.dataDir, 0o700);
    fs.chmodSync(bojinDbPath, 0o600);
    fs.chmodSync(authDbPath, 0o600);
  }

  // 2. Live WAL writer with uncheckpointed data: online backup captures WAL without writing to DATA_DIR
  const liveWriter = new DatabaseSync(bojinDbPath);
  liveWriter.prepare("INSERT INTO docs (path, uid, parent, data, updated) VALUES (?, ?, ?, ?, ?)").run(
    "data/users/u_live/app/days/2026-11-24",
    "u_live",
    "data/users/u_live/app/days",
    JSON.stringify({ date: "2026-11-24", checkin: { weight: 70.1 }, meals: [] }),
    fx.hoursAgo(1)
  );
  const beforeLive = fs.readdirSync(fx.dataDir).sort();
  try {
    const liveSummary = await collectDailySummary({
      dataDir: fx.dataDir,
      nowMs: fx.nowMs,
      noJournal: true,
      noSystemd: true,
      backupRoot: fx.backupRoot,
      deployBackupRoot: fx.deployBackupRoot
    });
    assert.equal(liveSummary.logs.last24h.checkins, 2, "must include uncheckpointed WAL row");
    assert.deepEqual(fs.readdirSync(fx.dataDir).sort(), beforeLive);
    assert.equal(fs.existsSync(path.join(fx.dataDir, ".access")), false);
  } finally {
    liveWriter.close();
  }

  // 3. Concurrent backup regression: running collectDailySummary concurrently with createSnapshot
  //    AND while an exclusive maintenance lease is held must never block or fail backup!
  const snapTarget = path.join(fx.root, "concurrent-snapshot");
  const [summaryResult] = await Promise.all([
    collectDailySummary({
      dataDir: fx.dataDir,
      nowMs: fx.nowMs,
      noJournal: true,
      noSystemd: true,
      backupRoot: fx.backupRoot,
      deployBackupRoot: fx.deployBackupRoot
    }),
    createSnapshot(fx.dataDir, snapTarget)
  ]);
  assert.equal(summaryResult.logs.last24h.checkins, 2);
  const manifest = verifySnapshot(snapTarget);
  assert.equal(manifest.version, 1);

  // Also succeeds while an exclusive maintenance lease is actively held (no reader lease taken!)
  const releaseExclusive = dataAccess.exclusive(fx.dataDir);
  try {
    const duringMaint = await collectDailySummary({
      dataDir: fx.dataDir,
      nowMs: fx.nowMs,
      noJournal: true,
      noSystemd: true,
      backupRoot: fx.backupRoot,
      deployBackupRoot: fx.deployBackupRoot
    });
    assert.equal(duringMaint.accounts.trialToDate.signups, 4);
  } finally {
    releaseExclusive();
  }
});

test("pseudonyms use an ephemeral per-report HMAC key and are unlinkable across reports", async (t) => {
  const fx = createFixture(t);
  const r1 = await collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    noSystemd: true,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot
  });
  const r2 = await collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    noSystemd: true,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot
  });

  // Across two separate reports, pseudonyms differ
  assert.notEqual(r1.feedback.newest[0].user, r2.feedback.newest[0].user);
  assert.notEqual(r1.feedback.newest[0].ref, r2.feedback.newest[0].ref);

  // Within each report, same user gets consistent pseudonym
  assert.equal(r1.feedback.newest[0].user, r1.feedback.newest[1].user);
  assert.equal(r2.feedback.newest[0].user, r2.feedback.newest[1].user);

  // Helper rejects short keys
  assert.throws(() => createReportPseudonymizer(Buffer.alloc(8)), /at least 16 bytes/);
});

test("opt-in --include-feedback-excerpts redacts emails, URLs, phones, tokens, and long digit runs", async (t) => {
  const fx = createFixture(t);
  const res = sanitizeFeedbackExcerpt(
    "Contact me@test.org or +86 138-0013-8000 at https://example.com/p?x=1 token sk-abcdefgh12345678 order 987654321"
  );
  assert.equal(res.truncated, false);
  assert.ok(!res.excerpt.includes("me@test.org"));
  assert.ok(!res.excerpt.includes("138-0013-8000"));
  assert.ok(!res.excerpt.includes("example.com"));
  assert.ok(!res.excerpt.includes("sk-abcdefgh12345678"));
  assert.ok(!res.excerpt.includes("987654321"));
  assert.match(res.excerpt, /\[email\]/);
  assert.match(res.excerpt, /\[number\]/);
  assert.match(res.excerpt, /\[url\]/);
  assert.match(res.excerpt, /\[token\]/);

  const eightyFiveZh = "薄".repeat(85);
  const resZh = sanitizeFeedbackExcerpt(eightyFiveZh);
  assert.equal(Array.from(resZh.excerpt).length, 80);
  assert.equal(resZh.truncated, true);

  // End-to-end with includeFeedbackExcerpts: true
  const s = await collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    noSystemd: true,
    includeFeedbackExcerpts: true,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot
  });
  assert.equal(s.feedback.excerptsIncluded, true);
  assert.equal(typeof s.feedback.newest[0].excerpt, "string");
  assert.ok(Array.from(s.feedback.newest[0].excerpt).length <= 80);
  assert.ok(!s.feedback.newest[0].excerpt.includes("138-0013-8000"));
  assert.ok(!s.feedback.newest[0].excerpt.includes("leak@example.com"));
  assert.ok(!s.feedback.newest[0].excerpt.includes("evil.test"));
  assert.ok(!s.feedback.newest[0].excerpt.includes("AIzaSySecretKey12345"));
});

test("journalctl fetches from earlier of trialStart and now-24h so short --since never undercounts last24h", async (t) => {
  const fx = createFixture(t);
  const sixHoursAgoMs = fx.msHoursAgo(6);
  const twelveHoursAgoMs = fx.msHoursAgo(12);
  const twoHoursAgoMs = fx.msHoursAgo(2);

  let seenJournalArgs = null;
  const mockRunner = (cmd, args) => {
    if (cmd === "journalctl") {
      seenJournalArgs = args;
      const lines = [
        // 12h ago: inside last24h, OUTSIDE 6h trialToDate
        JSON.stringify({
          __REALTIME_TIMESTAMP: String(twelveHoursAgoMs * 1000),
          MESSAGE: "ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=stop prompt=1000 completion=200 reasoning=0 empty=false ms=1000"
        }),
        JSON.stringify({
          __REALTIME_TIMESTAMP: String(twelveHoursAgoMs * 1000),
          MESSAGE: `client-error auth=user page=food lang=zh rev=abc1234 ua=Safari/iOS18 source=index.html:1:1 name=TypeError ts=${new Date(twelveHoursAgoMs).toISOString()} msg="Network request failed"`
        }),
        // 2h ago: inside BOTH last24h and 6h trialToDate
        JSON.stringify({
          __REALTIME_TIMESTAMP: String(twoHoursAgoMs * 1000),
          MESSAGE: "ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=stop prompt=500 completion=100 reasoning=0 empty=false ms=800"
        })
      ];
      return { status: 0, stdout: lines.join("\n") + "\n", stderr: "", error: null };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };

  const summary = await collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    sinceMs: sixHoursAgoMs,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot,
    noSystemd: true,
    runCommand: mockRunner
  });

  // Verify journalctl --since was 24h ago (2026-11-23 10:00:00 UTC), NOT 6h ago!
  assert.ok(seenJournalArgs, "expected journalctl invocation");
  const sinceIdx = seenJournalArgs.indexOf("--since");
  assert.notEqual(sinceIdx, -1);
  assert.equal(seenJournalArgs[sinceIdx + 1], "2026-11-23 10:00:00 UTC");

  assert.equal(summary.ai.last24h.calls, 2);
  assert.equal(summary.ai.trialToDate.calls, 1);
  assert.equal(summary.clientErrors.last24h.count, 1);
  assert.equal(summary.clientErrors.trialToDate.count, 0);
});

test("unknown AI providers are left unpriced rather than billed at Gemini rates", async (t) => {
  const fx = createFixture(t);
  const customJournal = path.join(fx.root, "unknown-provider.log");
  fs.writeFileSync(
    customJournal,
    [
      JSON.stringify({
        __REALTIME_TIMESTAMP: String(fx.msHoursAgo(2) * 1000),
        MESSAGE: "ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=stop prompt=1000 completion=1000 reasoning=0 empty=false ms=900"
      }),
      JSON.stringify({
        __REALTIME_TIMESTAMP: String(fx.msHoursAgo(1) * 1000),
        MESSAGE: "ai provider=customllm kind=json images=0 model=custom-v1 finish_reason=stop prompt=1000000 completion=1000000 reasoning=0 empty=false ms=1200"
      })
    ].join("\n") + "\n"
  );

  const s = await collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    journalFile: customJournal,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot,
    noSystemd: true,
    env: {}
  });

  assert.equal(s.ai.last24h.calls, 2);
  assert.equal(s.ai.last24h.unpricedCalls, 1);
  assert.equal(s.ai.last24h.byProvider.other.calls, 1);
  assert.equal(s.ai.last24h.byProvider.other.estimatedCostUsd, null);
  // Only the 1000p/1000c Gemini call is priced: (1000*0.75 + 1000*3.75)/1e6 = 0.0045
  assert.equal(s.ai.last24h.estimatedCostUsd, 0.0045);

  const text = formatSummaryText(s);
  assert.match(text, /其他 \(未计价\): 1 次/);
  assert.match(text, /1 次未知 provider 未计价/);
});

test("parsePricing supports gemini-3.8-flash defaults, custom env overrides, and rejects invalid values", () => {
  const def = parsePricing({});
  assert.equal(def.modelDefault, DEFAULT_AI_PRICING.model);
  assert.equal(def.gemini.inputPer1M, 0.75);
  assert.equal(def.gemini.outputPer1M, 3.75);
  assert.equal(def.openrouter.inputPer1M, 0.75);
  assert.equal(def.openrouter.outputPer1M, 3.75);
  assert.match(def.basis, /final-attempt/);

  const custom = parsePricing({
    AI_INPUT_PRICE_PER_1M: "0.5",
    AI_OUTPUT_PRICE_PER_1M: "2.0",
    AI_OPENROUTER_OUTPUT_PRICE_PER_1M: "3.0"
  });
  assert.equal(custom.gemini.inputPer1M, 0.5);
  assert.equal(custom.gemini.outputPer1M, 2.0);
  assert.equal(custom.openrouter.inputPer1M, 0.5);
  assert.equal(custom.openrouter.outputPer1M, 3.0);

  const zero = parsePricing({ AI_INPUT_PRICE_PER_1M: "0", AI_OUTPUT_PRICE_PER_1M: "0" });
  assert.equal(zero.gemini.inputPer1M, 0);
  assert.equal(zero.gemini.outputPer1M, 0);

  assert.throws(() => parsePricing({ AI_INPUT_PRICE_PER_1M: "-1" }), /AI_INPUT_PRICE_PER_1M/);
  assert.throws(() => parsePricing({ AI_OUTPUT_PRICE_PER_1M: "abc" }), /AI_OUTPUT_PRICE_PER_1M/);
  assert.throws(() => parsePricing({ AI_GEMINI_INPUT_PRICE_PER_1M: "Infinity" }), /AI_GEMINI_INPUT_PRICE_PER_1M/);
});

test("systemd backup fallback reports completed service exits only and exposes timerLastTriggerAt separately", async (t) => {
  const fx = createFixture(t);
  const missingRoot = path.join(fx.root, "no-backups-here");

  // 1. Completed bojin-backup.service success
  const okRunner = (cmd, args) => {
    if (cmd === "systemctl" && args.includes("bojin-backup.service")) {
      return {
        status: 0,
        stdout: [
          "LoadState=loaded",
          "ActiveState=inactive",
          "Result=success",
          "ExecMainStatus=0",
          "ExecMainExitTimestamp=Tue 2026-11-24 04:05:00 UTC",
          "InactiveEnterTimestamp=Tue 2026-11-24 04:05:00 UTC"
        ].join("\n"),
        stderr: "",
        error: null
      };
    }
    if (cmd === "systemctl" && args.includes("bojin-backup.timer")) {
      return {
        status: 0,
        stdout: "LoadState=loaded\nLastTriggerUSec=Tue 2026-11-24 04:00:05 UTC\n",
        stderr: "",
        error: null
      };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };
  const s1 = await collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    backupRoot: missingRoot,
    deployBackupRoot: missingRoot,
    runCommand: okRunner
  });
  assert.equal(s1.backup.source, "systemd-service");
  assert.equal(s1.backup.lastBackupAt, "2026-11-24T04:05:00.000Z");
  assert.equal(s1.backup.timerLastTriggerAt, "2026-11-24T04:00:05.000Z");
  assert.equal(s1.backup.serviceResult, "success");

  // 2. Rebooted host (empty ExecMainExitTimestamp) with timer LastTriggerUSec:
  //    MUST leave lastBackupAt/ageHours null and expose timerLastTriggerAt separately!
  const timerOnlyRunner = (cmd, args) => {
    if (cmd === "systemctl" && args.includes("bojin-backup.service")) {
      return {
        status: 0,
        stdout: "LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=\nInactiveEnterTimestamp=\n",
        stderr: "",
        error: null
      };
    }
    if (cmd === "systemctl" && args.includes("bojin-backup.timer")) {
      return {
        status: 0,
        stdout: "LoadState=loaded\nLastTriggerUSec=Mon 2026-11-23 04:02:10 UTC\n",
        stderr: "",
        error: null
      };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };
  const s2 = await collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    backupRoot: missingRoot,
    deployBackupRoot: missingRoot,
    runCommand: timerOnlyRunner
  });
  assert.equal(s2.backup.source, "unavailable");
  assert.equal(s2.backup.lastBackupAt, null);
  assert.equal(s2.backup.ageHours, null);
  assert.equal(s2.backup.timerLastTriggerAt, "2026-11-23T04:02:10.000Z");
  const text2 = formatSummaryText(s2);
  assert.match(text2, /最近成功备份: 未知/);
  assert.match(text2, /定时最近触发: 2026-11-23T04:02:10\.000Z/);

  // 3. Running backup (ActiveState=activating) must NOT look like a completed backup
  const runningRunner = (cmd, args) => {
    if (cmd === "systemctl" && args.includes("bojin-backup.service")) {
      return {
        status: 0,
        stdout: [
          "LoadState=loaded",
          "ActiveState=activating",
          "Result=success",
          "ExecMainStatus=0",
          "ExecMainExitTimestamp=Tue 2026-11-24 04:00:00 UTC"
        ].join("\n"),
        stderr: "",
        error: null
      };
    }
    if (cmd === "systemctl" && args.includes("bojin-backup.timer")) {
      return {
        status: 0,
        stdout: "LoadState=loaded\nLastTriggerUSec=Tue 2026-11-24 09:59:00 UTC\n",
        stderr: "",
        error: null
      };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };
  const s3 = await collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    backupRoot: missingRoot,
    deployBackupRoot: missingRoot,
    runCommand: runningRunner
  });
  assert.equal(s3.backup.lastBackupAt, null);
  assert.equal(s3.backup.timerLastTriggerAt, "2026-11-24T09:59:00.000Z");
  assert.match(s3.backup.note, /running/i);

  // 4. Failed backup run must NOT report a successful backup
  const failRunner = (cmd, args) => {
    if (cmd === "systemctl" && args.includes("bojin-backup.service")) {
      return {
        status: 0,
        stdout: [
          "LoadState=loaded",
          "ActiveState=failed",
          "Result=exit-code",
          "ExecMainStatus=1",
          "ExecMainExitTimestamp=Tue 2026-11-24 04:01:00 UTC"
        ].join("\n"),
        stderr: "",
        error: null
      };
    }
    if (cmd === "systemctl" && args.includes("bojin-backup.timer")) {
      return {
        status: 0,
        stdout: "LoadState=loaded\nLastTriggerUSec=Tue 2026-11-24 04:00:05 UTC\n",
        stderr: "",
        error: null
      };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };
  const s4 = await collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    backupRoot: missingRoot,
    deployBackupRoot: missingRoot,
    runCommand: failRunner
  });
  assert.equal(s4.backup.lastBackupAt, null);
  assert.equal(s4.backup.timerLastTriggerAt, "2026-11-24T04:00:05.000Z");
  assert.equal(s4.backup.serviceResult, "exit-code");
  assert.match(s4.backup.note, /failed/i);
});

test("journalctl permission denial degrades gracefully to db_only without crashing", async (t) => {
  const fx = createFixture(t);
  const permDeniedRunner = (cmd) => {
    if (cmd === "journalctl") {
      return {
        status: 0,
        stdout: "",
        stderr: "Hint: You are currently not seeing messages from other users and the system.\n",
        error: null
      };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };

  const summary = await collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot,
    noSystemd: true,
    runCommand: permDeniedRunner
  });

  assert.equal(summary.ai.source, "db_only");
  assert.equal(summary.ai.journalStatus, "permission_denied");
  assert.equal(summary.ai.last24h.calls, null);
  assert.equal(summary.ai.last24h.dbCallsTodayUtc, 4);
  assert.equal(summary.ai.trialToDate.dbCalls, 6);
  assert.equal(summary.clientErrors.source, "unavailable");

  const text = formatSummaryText(summary);
  assert.match(text, /permission_denied/);
  assert.match(text, /DB今日UTC 4/);
});

test("parseJournalStream handles -o cat client-error ts= fallback and flags untimestamped AI lines", () => {
  const raw = [
    "ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=stop prompt=100 completion=50 reasoning=0 empty=false ms=500",
    'client-error auth=user page=food lang=zh rev=abc1234 ua=Safari/iOS18 source=index.html:1:1 name=Error ts=2026-11-24T09:00:00.000Z msg="Error details withheld"'
  ].join("\n");
  const parsed = parseJournalStream(raw);
  assert.equal(parsed.aiEvents.length, 1);
  assert.equal(parsed.aiEvents[0].timestampMs, null);
  assert.equal(parsed.aiEventsWithoutTimestamp, 1);
  assert.equal(parsed.clientErrors.length, 1);
  assert.equal(parsed.clientErrors[0].timestampMs, Date.parse("2026-11-24T09:00:00.000Z"));
});

test("missing DATA_DIR does not create files and exits cleanly", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-summary-empty-"));
  const missingData = path.join(root, "does-not-exist");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const res = spawnSync(
    process.execPath,
    [SCRIPT, "--json", "--no-journal", "--no-systemd", "--backup-root", missingData, "--deploy-backup-root", missingData],
    { cwd: ROOT, env: { ...process.env, DATA_DIR: missingData }, encoding: "utf8", timeout: 10000 }
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(missingData), false, "read-only script must never create missing DATA_DIR");
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.accounts.authDbPresent, false);
  assert.equal(parsed.logs.appDbPresent, false);
  assert.equal(parsed.activeUsers.trialToDate, 0);
});

test("CLI supports plain text, --json, stdin journal, custom pricing, --help, and leaves DATA_DIR untouched", (t) => {
  const fx = createFixture(t);
  const env = {
    ...process.env,
    DATA_DIR: fx.dataDir,
    AI_INPUT_PRICE_PER_1M: "1.0",
    AI_OUTPUT_PRICE_PER_1M: "4.0"
  };
  const beforeEntries = fs.readdirSync(fx.dataDir).sort();

  // 1. Plain text via CLI + stdin journal
  const journalContent = fs.readFileSync(fx.journalFile, "utf8");
  const txtRes = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--now", fx.nowIso,
      "--journal-file", "-",
      "--backup-root", fx.backupRoot,
      "--deploy-backup-root", fx.deployBackupRoot,
      "--no-systemd"
    ],
    { cwd: ROOT, env, input: journalContent, encoding: "utf8", timeout: 10000 }
  );
  assert.equal(txtRes.status, 0, txtRes.stderr);
  assert.match(txtRes.stdout, /薄肌日课 · 每日活动摘要/);
  assert.match(txtRes.stdout, /Gemini 输入 \$1 \/ 输出 \$4/);
  assert.match(txtRes.stdout, /snapshot-20261124T040000Z/);
  assert.ok(!txtRes.stdout.includes("alice.secret@example.com"));
  assert.ok(!txtRes.stdout.includes("张三"));
  assert.ok(!txtRes.stdout.includes("fb_rawpk000004"));
  assert.deepEqual(fs.readdirSync(fx.dataDir).sort(), beforeEntries);
  assert.equal(fs.existsSync(path.join(fx.dataDir, ".access")), false);

  // 2. --json via CLI
  const jsonRes = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--json",
      "--now", fx.nowIso,
      "--journal-file", fx.journalFile,
      "--backup-root", fx.backupRoot,
      "--deploy-backup-root", fx.deployBackupRoot,
      "--no-systemd"
    ],
    { cwd: ROOT, env, encoding: "utf8", timeout: 10000 }
  );
  assert.equal(jsonRes.status, 0, jsonRes.stderr);
  const parsed = JSON.parse(jsonRes.stdout);
  assert.equal(parsed.ai.last24h.byProvider.gemini.estimatedCostUsd, 0.007);
  assert.equal(parsed.ai.last24h.byProvider.openrouter.estimatedCostUsd, 0.0035);
  assert.equal(parsed.ai.last24h.estimatedCostUsd, 0.0105);

  // 3. --help exits 0; invalid flag exits 1
  const helpRes = spawnSync(process.execPath, [SCRIPT, "--help"], {
    cwd: ROOT, env, encoding: "utf8", timeout: 10000
  });
  assert.equal(helpRes.status, 0);
  assert.match(helpRes.stdout, /Usage:/);

  const badRes = spawnSync(process.execPath, [SCRIPT, "--unknown-flag"], {
    cwd: ROOT, env, encoding: "utf8", timeout: 10000
  });
  assert.equal(badRes.status, 1);
  assert.match(badRes.stderr, /Usage:/);
});

test("handles legacy bojin.db without feedback table or auth.sqlite and ignores symlinks in blobs/", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-summary-legacy-"));
  const dataDir = path.join(root, "data");
  const blobsDir = path.join(dataDir, "blobs");
  const outsideFile = path.join(root, "outside.bin");
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.writeFileSync(outsideFile, Buffer.alloc(99999, 0x42));
  fs.symlinkSync(outsideFile, path.join(blobsDir, "f".repeat(32)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const db = new DatabaseSync(path.join(dataDir, "bojin.db"));
  db.exec(`
    CREATE TABLE docs (path TEXT PRIMARY KEY, uid TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
  `);
  db.close();

  const summary = await collectDailySummary({
    dataDir,
    nowMs: Date.parse("2026-11-24T10:00:00.000Z"),
    noJournal: true,
    noSystemd: true,
    backupRoot: path.join(root, "no-backups"),
    deployBackupRoot: path.join(root, "no-deploy")
  });
  assert.equal(summary.accounts.authDbPresent, false);
  assert.equal(summary.logs.appDbPresent, true);
  assert.equal(summary.feedback.trialToDate.total, 0);
  assert.equal(summary.storage.photos.diskCount, 0);
  assert.equal(summary.storage.photos.diskBytes, 0);
});
