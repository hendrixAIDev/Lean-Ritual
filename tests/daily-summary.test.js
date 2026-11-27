"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeSnapshotManifest(snapshotDir, createdIso, dbNames = ["bojin.db", "auth.sqlite"]) {
  const files = dbNames
    .filter((name) => fs.existsSync(path.join(snapshotDir, name)))
    .map((name) => {
      const full = path.join(snapshotDir, name);
      return { name, size: fs.statSync(full).size, sha256: sha256File(full) };
    });
  fs.writeFileSync(
    path.join(snapshotDir, "manifest.json"),
    JSON.stringify({ version: 1, created: createdIso, files }, null, 2)
  );
}

function createFixture(t, {
  nowIso = "2026-11-24T10:00:00.000Z",
  snapshotIso = "2026-11-24T04:01:15.000Z"
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-summary-"));
  const dataDir = path.join(root, "data");
  const blobsDir = path.join(dataDir, "blobs");
  const backupRoot = path.join(root, "backups");
  const deployBackupRoot = path.join(root, "backups-deploy");
  const snapshotDir = path.join(backupRoot, "snapshot-20261124T040000Z");
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.mkdirSync(deployBackupRoot, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const nowMs = Date.parse(nowIso);
  const snapMs = Date.parse(snapshotIso);
  const nowHoursAgo = (h) => new Date(nowMs - h * 3600 * 1000).toISOString();
  const nowMsHoursAgo = (h) => nowMs - h * 3600 * 1000;
  // DB record timestamps anchored to snapshotIso (dataAsOf)
  const snapHoursAgo = (h) => new Date(snapMs - h * 3600 * 1000).toISOString();
  const snapMsHoursAgo = (h) => snapMs - h * 3600 * 1000;

  // 1. Completed backup snapshot databases (DELETE journal mode, no -wal/-shm sidecars)
  const authDb = new DatabaseSync(path.join(snapshotDir, "auth.sqlite"));
  authDb.exec(`
    PRAGMA journal_mode = DELETE;
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
  // u_alpha: signed up 5 days before snapshot, verified
  insertUser.run("u_alpha_secret", "Alice SecretName", "alice.secret@example.com", 1, snapHoursAgo(120), snapHoursAgo(120));
  // u_beta: signed up 3 days before snapshot, already verified, updated 4h before snapshot (must NOT count in 24h verifiedSignups!)
  insertUser.run("u_beta_secret", "Bob SecretName", "bob.secret@example.com", 1, snapHoursAgo(72), snapHoursAgo(4));
  // u_gamma: signed up 6h before snapshot, verified 5h before snapshot (counts in 24h signups & verifiedSignups)
  insertUser.run("u_gamma_secret", "Carol SecretName", "carol.secret@example.com", 1, snapHoursAgo(6), snapHoursAgo(5));
  // u_delta: signed up 2h before snapshot, unverified
  insertUser.run("u_delta_secret", "Dave SecretName", "dave.secret@example.com", 0, snapHoursAgo(2), snapHoursAgo(2));

  const insertSession = authDb.prepare(
    `INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertSession.run("s1", snapHoursAgo(-100), "tok_secret_1", snapHoursAgo(3), snapHoursAgo(3), "10.0.0.1", "Safari", "u_beta_secret");
  insertSession.run("s2", snapHoursAgo(-20), "tok_secret_2", snapHoursAgo(80), snapHoursAgo(80), "10.0.0.2", "Chrome", "u_alpha_secret");
  authDb.close();

  const bojinDb = new DatabaseSync(path.join(snapshotDir, "bojin.db"));
  bojinDb.exec(`
    PRAGMA journal_mode = DELETE;
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
      workout: { done: true, key: "push", savedAt: snapHoursAgo(5), note: "PRIVATE_WORKOUT_NOTE" },
      meals: [
        { id: makeBase36MealId(snapMsHoursAgo(8), "aaaaa"), type: "早餐", text: "PRIVATE_MEAL_TEXT_1", est: { kcal: 500, at: snapHoursAgo(8) } },
        { id: makeBase36MealId(snapMsHoursAgo(2), "bbbbb"), type: "午餐", text: "PRIVATE_MEAL_TEXT_2", est: { kcal: 650, at: snapHoursAgo(2) } }
      ]
    }),
    snapHoursAgo(2)
  );
  putDoc.run(
    "data/users/u_alpha_secret/app/days/2026-11-21",
    "u_alpha_secret",
    "data/users/u_alpha_secret/app/days",
    JSON.stringify({
      date: "2026-11-21",
      checkin: { weight: 71.6 },
      workout: { done: true, key: "pull", savedAt: snapHoursAgo(75) },
      meals: [
        // Created 74h before snapshot (encoded in base36 id); re-estimated 1h before snapshot -> NOT a new 24h meal.
        { id: makeBase36MealId(snapMsHoursAgo(74), "ccccc"), type: "晚餐", text: "OLD_MEAL_REEST", est: { kcal: 700, at: snapHoursAgo(1) } }
      ]
    }),
    snapHoursAgo(74)
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
        { id: "custom-meal-1", type: "加餐", text: "PRIVATE_SNACK", est: { kcal: 210, at: snapHoursAgo(3) } }
      ]
    }),
    snapHoursAgo(3)
  );
  putDoc.run(
    "data/users/u_gamma_secret/app/app/profile",
    "u_gamma_secret",
    "data/users/u_gamma_secret/app/app",
    JSON.stringify({ weight: 68, height: 175 }),
    snapHoursAgo(5)
  );

  const blob1 = Buffer.alloc(10240, 0xaa);
  const blob2 = Buffer.alloc(20480, 0xbb);
  const b1Id = "1".repeat(32);
  const b2Id = "2".repeat(32);
  fs.writeFileSync(path.join(blobsDir, b1Id), blob1);
  fs.writeFileSync(path.join(blobsDir, b2Id), blob2);
  bojinDb.prepare("INSERT INTO blobs (id, uid, type, size, created) VALUES (?, ?, ?, ?, ?)").run(b1Id, "u_alpha_secret", "image/webp", blob1.length, snapHoursAgo(3));
  bojinDb.prepare("INSERT INTO blobs (id, uid, type, size, created) VALUES (?, ?, ?, ?, ?)").run(b2Id, "u_alpha_secret", "image/webp", blob2.length, snapHoursAgo(60));

  bojinDb.prepare("INSERT INTO ai_usage (uid, day, n) VALUES (?, ?, ?)").run("u_alpha_secret", "2026-11-24", 3);
  bojinDb.prepare("INSERT INTO ai_usage (uid, day, n) VALUES (?, ?, ?)").run("u_gamma_secret", "2026-11-24", 1);
  bojinDb.prepare("INSERT INTO ai_usage (uid, day, n) VALUES (?, ?, ?)").run("u_alpha_secret", "2026-11-21", 2);

  const insertFb = bojinDb.prepare(
    "INSERT INTO feedback (id, uid, type, message, screenshot_blob_id, device_info, created) VALUES (?, ?, ?, ?, ?, NULL, ?)"
  );
  const sensitiveMsg =
    "我是张三，电话 +86 138-0013-8000，邮箱 leak@example.com，链接 https://evil.test/reset?t=1 密钥 AIzaSySecretKey12345 \x1b[31mRED\x1b[0m\u202e TAIL_MARKER";
  insertFb.run("fb_rawpk000004", "u_alpha_secret", "bug", sensitiveMsg, b1Id, snapHoursAgo(1));
  insertFb.run("fb_rawpk000003", "u_alpha_secret", "idea", "希望能导出最近两周的体重和训练曲线图片", null, snapHoursAgo(10));
  insertFb.run("fb_rawpk000002", "u_beta_secret", "other", "整体很顺手，界面在手机上字号刚好！", null, snapHoursAgo(40));
  insertFb.run("fb_rawpk000001", "u_gamma_secret", "bug", "很早的反馈不应出现在最新三条", null, snapHoursAgo(90));
  bojinDb.close();

  writeSnapshotManifest(snapshotDir, snapshotIso, ["bojin.db", "auth.sqlite"]);

  // Older complete daily snapshot + deploy snapshot + bogus future snapshot (must be ignored)
  const olderDailySnap = path.join(backupRoot, "snapshot-20261123T040000Z");
  fs.mkdirSync(olderDailySnap, { recursive: true });
  fs.copyFileSync(path.join(snapshotDir, "bojin.db"), path.join(olderDailySnap, "bojin.db"));
  fs.copyFileSync(path.join(snapshotDir, "auth.sqlite"), path.join(olderDailySnap, "auth.sqlite"));
  writeSnapshotManifest(olderDailySnap, "2026-11-23T04:01:00.000Z", ["bojin.db", "auth.sqlite"]);
  fs.mkdirSync(path.join(backupRoot, "snapshot-20990101T000000Z"), { recursive: true });

  const deploySnap = path.join(deployBackupRoot, "20261123T180000Z-abcd1234");
  fs.mkdirSync(path.join(deploySnap, "snapshot"), { recursive: true });
  fs.copyFileSync(path.join(snapshotDir, "bojin.db"), path.join(deploySnap, "snapshot", "bojin.db"));
  fs.copyFileSync(path.join(snapshotDir, "auth.sqlite"), path.join(deploySnap, "snapshot", "auth.sqlite"));
  writeSnapshotManifest(path.join(deploySnap, "snapshot"), "2026-11-23T18:00:30.000Z", ["bojin.db", "auth.sqlite"]);

  // 2. Separate live DATA_DIR databases with sentinel live-only rows (must NEVER be opened!)
  const liveAuth = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  liveAuth.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE "user" (id text primary key, name text, email text, emailVerified integer, image text, createdAt date, updatedAt date);
    INSERT INTO "user" VALUES ('u_live_only', 'Live Only', 'live.only@example.com', 1, NULL, '${nowHoursAgo(1)}', '${nowHoursAgo(1)}');
  `);
  liveAuth.close();

  const liveBojin = new DatabaseSync(path.join(dataDir, "bojin.db"));
  liveBojin.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE docs (path TEXT PRIMARY KEY, uid TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
    INSERT INTO docs VALUES ('data/users/u_live_only/app/days/2026-11-24', 'u_live_only', 'data/users/u_live_only/app/days', '{"date":"2026-11-24","checkin":{"weight":99},"meals":[]}', '${nowHoursAgo(1)}');
    INSERT INTO blobs VALUES ('${b1Id}', 'u_alpha_secret', 'image/webp', ${blob1.length}, '${snapHoursAgo(3)}');
    INSERT INTO blobs VALUES ('${b2Id}', 'u_alpha_secret', 'image/webp', ${blob2.length}, '${snapHoursAgo(60)}');
  `);
  liveBojin.close();

  // 3. Live journal log file (anchored to nowIso)
  const journalFile = path.join(root, "journal.log");
  const jLines = [
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(nowMsHoursAgo(2) * 1000),
      MESSAGE: "ai provider=gemini retries=1 kind=json images=1 model=gemini-3.8-flash finish_reason=stop prompt=1000 completion=400 reasoning=0 empty=false ms=3200"
    }),
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(nowMsHoursAgo(5) * 1000),
      MESSAGE: "ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=stop prompt=2000 completion=600 reasoning=100 empty=false ms=4100"
    }),
    `${nowHoursAgo(4).replace(".000Z", "+0000")} leanritual node[4242]: ai provider=openrouter provider_fallback=true retries=2 kind=json images=1 model=google/gemini-3.8-flash finish_reason=stop prompt=1500 completion=500 reasoning=0 empty=false ms=6100`,
    `${nowHoursAgo(3).replace(".000Z", "+0000")} leanritual node[4242]: ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=error prompt=0 completion=0 reasoning=0 empty=true ms=1500`,
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(nowMsHoursAgo(70) * 1000),
      MESSAGE: "ai kind=json images=0 model=google/gemini-3.8-flash finish_reason=stop prompt=4000 completion=1000 reasoning=200 empty=false ms=5000"
    }),
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(nowMsHoursAgo(68) * 1000),
      MESSAGE: "ai provider=gemini kind=text images=0 model=gemini-3.8-flash finish_reason=stop prompt=500 completion=200 reasoning=0 empty=false ms=1200"
    }),
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(nowMsHoursAgo(3) * 1000),
      MESSAGE: `client-error auth=user page=food lang=zh rev=abc1234 ua=Safari/iOS18 source=index.html:120:5 name=TypeError ts=${nowHoursAgo(3)} msg="Cannot read properties of null or undefined"`
    }),
    `${nowHoursAgo(6).replace(".000Z", "+0000")} leanritual node[4242]: client-error auth=anon page=login lang=zh rev=abc1234 ua=Chrome/Android14 source=login.html:45:1 name=SaveError ts=${nowHoursAgo(6)} msg="Error details withheld"`,
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(nowMsHoursAgo(50) * 1000),
      MESSAGE: `client-error auth=user page=today lang=en rev=abc1234 ua=Chrome/macOS15 source=index.html:88:1 name=TypeError ts=${nowHoursAgo(50)} msg="Network request failed"`
    }),
    `${nowHoursAgo(1).replace(".000Z", "+0000")} leanritual node[4242]: 薄肌日课已启动：http://127.0.0.1:8080`
  ];
  fs.writeFileSync(journalFile, jLines.join("\n") + "\n", "utf8");

  return {
    root, dataDir, backupRoot, deployBackupRoot, snapshotDir,
    journalFile, nowMs, nowIso, snapMs, snapshotIso, nowHoursAgo, nowMsHoursAgo
  };
}

test("collectDailySummary reads counts from completed snapshot (data as of), keeps journal live, and emits zero PII", (t) => {
  const fx = createFixture(t);
  const summary = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    journalFile: fx.journalFile,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot,
    noSystemd: true,
    env: {}
  });

  // Snapshot metadata & dataAsOf
  assert.equal(summary.dataAsOf, fx.snapshotIso);
  assert.equal(summary.dbSource.status, "snapshot");
  assert.equal(summary.dbSource.snapshotName, "snapshot-20261124T040000Z");
  assert.equal(summary.dbSource.ageHours, 6.0);
  assert.equal(summary.windows.dbLast24h.to, fx.snapshotIso);
  assert.equal(summary.windows.last24h.to, fx.nowIso);

  // Accounts come strictly from snapshot (4 users; NOT the 1 live-only user in DATA_DIR!)
  assert.equal(summary.accounts.snapshotAvailable, true);
  assert.equal(summary.accounts.authDbPresent, true);
  assert.deepEqual(summary.accounts.last24h, { signups: 2, verifiedSignups: 1, emailSignups: 2, phoneSignups: 0 });
  assert.deepEqual(summary.accounts.trialToDate, { signups: 4, verified: 3, unverified: 1, emailSignups: 4, phoneSignups: 0 });

  // Active users & logs from snapshot
  assert.deepEqual(summary.activeUsers, { last24h: 3, trialToDate: 3 });
  assert.deepEqual(summary.logs.last24h, { checkins: 1, workouts: 1, meals: 3 });
  assert.deepEqual(summary.logs.trialToDate, { checkins: 2, workouts: 2, meals: 4 });

  // Live journal AI metrics: Gemini retries include the 2 pre-fallback retries (1 + 2 = 3)
  assert.equal(summary.ai.source, "journal");
  assert.equal(summary.ai.last24h.calls, 4);
  assert.equal(summary.ai.last24h.errors, 1);
  assert.equal(summary.ai.last24h.unpricedCalls, 0);
  assert.equal(summary.ai.last24h.dbCallsAsOfUtcDate, 4);
  assert.equal(summary.ai.last24h.byProvider.gemini.calls, 3);
  assert.equal(summary.ai.last24h.byProvider.gemini.retries, 3);
  assert.deepEqual(summary.ai.last24h.byProvider.gemini.models, ["gemini-3.8-flash"]);
  assert.equal(summary.ai.last24h.byProvider.gemini.estimatedCostUsd, 0.006);
  assert.equal(summary.ai.last24h.byProvider.openrouter.calls, 1);
  assert.equal(summary.ai.last24h.byProvider.openrouter.retries, 0);
  assert.equal(summary.ai.last24h.byProvider.openrouter.fallbackCalls, 1);
  assert.equal(summary.ai.last24h.byProvider.openrouter.estimatedCostUsd, 0.003);
  assert.equal(summary.ai.last24h.estimatedCostUsd, 0.009);

  // Feedback omits free text and raw feedback PKs by default
  assert.equal(summary.feedback.snapshotAvailable, true);
  assert.equal(summary.feedback.excerptsIncluded, false);
  assert.deepEqual(summary.feedback.last24h, { total: 2, byType: { bug: 1, idea: 1, other: 0 } });
  assert.deepEqual(summary.feedback.trialToDate, { total: 4, byType: { bug: 2, idea: 1, other: 1 } });
  assert.equal(summary.feedback.newest.length, 3);
  assert.equal("excerpt" in summary.feedback.newest[0], false);
  assert.equal("id" in summary.feedback.newest[0], false);
  assert.match(summary.feedback.newest[0].ref, /^fb_[0-9a-f]{8}$/);
  assert.match(summary.feedback.newest[0].user, /^u_[0-9a-f]{8}$/);
  assert.equal(summary.feedback.newest[0].hasScreenshot, true);
  assert.equal(summary.feedback.newest[0].user, summary.feedback.newest[1].user);
  assert.notEqual(summary.feedback.newest[0].user, summary.feedback.newest[2].user);

  // Client errors (live journal)
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

  // Strict PII, secret, free-text, and raw-ID leak check
  const jsonText = JSON.stringify(summary);
  const plainText = formatSummaryText(summary);
  assert.match(plainText, /数据截止 \(data as of\): 2026-11-24T04:01:15\.000Z/);
  for (const forbidden of [
    "alice.secret@example.com",
    "bob.secret@example.com",
    "carol.secret@example.com",
    "dave.secret@example.com",
    "live.only@example.com",
    "leak@example.com",
    "Alice SecretName",
    "u_alpha_secret",
    "u_live_only",
    "fb_rawpk000004",
    "tok_secret_1",
    "PRIVATE_WORKOUT_NOTE",
    "PRIVATE_MEAL_TEXT_1",
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
  assert.equal(rawControlRe.test(plainText), false);
});

test("live DATA_DIR databases are NEVER opened: active WAL/-shm stay byte-identical, chmod 0000 succeeds, and backups never conflict", async (t) => {
  const fx = createFixture(t);
  const liveBojinPath = path.join(fx.dataDir, "bojin.db");
  const liveAuthPath = path.join(fx.dataDir, "auth.sqlite");

  // 1. Open an active WAL writer with uncheckpointed transaction in DATA_DIR
  //    and verify bojin.db, bojin.db-wal, and bojin.db-shm remain byte-for-byte identical!
  const writer = new DatabaseSync(liveBojinPath);
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("INSERT INTO docs VALUES (?, ?, ?, ?, ?)").run(
    "data/users/u_active_tx/app/days/2026-11-24",
    "u_active_tx",
    "data/users/u_active_tx/app/days",
    '{"date":"2026-11-24","checkin":{"weight":88},"meals":[]}',
    fx.nowHoursAgo(0.1)
  );
  writer.exec("COMMIT");

  const walPath = `${liveBojinPath}-wal`;
  const shmPath = `${liveBojinPath}-shm`;
  assert.equal(fs.existsSync(walPath), true, "expected active -wal file");
  assert.equal(fs.existsSync(shmPath), true, "expected active -shm file");

  const beforeHashes = {
    db: sha256File(liveBojinPath),
    wal: sha256File(walPath),
    shm: sha256File(shmPath),
    auth: sha256File(liveAuthPath)
  };
  const beforeEntries = fs.readdirSync(fx.dataDir).sort();

  try {
    const s = collectDailySummary({
      dataDir: fx.dataDir,
      nowMs: fx.nowMs,
      noJournal: true,
      noSystemd: true,
      backupRoot: fx.backupRoot,
      deployBackupRoot: fx.deployBackupRoot
    });
    assert.equal(s.dbSource.status, "snapshot");
    assert.equal(s.logs.last24h.checkins, 1, "must read snapshot, not active WAL writer");

    // Prove ZERO bytes changed in live DB, -wal, or -shm, and ZERO .access/ created!
    assert.equal(sha256File(liveBojinPath), beforeHashes.db);
    assert.equal(sha256File(walPath), beforeHashes.wal);
    assert.equal(sha256File(shmPath), beforeHashes.shm, "live -shm file must remain byte-for-byte untouched");
    assert.equal(sha256File(liveAuthPath), beforeHashes.auth);
    assert.deepEqual(fs.readdirSync(fx.dataDir).sort(), beforeEntries);
    assert.equal(fs.existsSync(path.join(fx.dataDir, ".access")), false);
  } finally {
    writer.close();
  }

  // 2. Make live DATA_DIR DB files completely unreadable (0000) and snapshot dir read-only (0500/0400):
  //    proves live DBs are never opened AND snapshot archive is never mutated!
  const snapBojin = path.join(fx.snapshotDir, "bojin.db");
  const snapAuth = path.join(fx.snapshotDir, "auth.sqlite");
  const snapManifest = path.join(fx.snapshotDir, "manifest.json");
  const snapBeforeEntries = fs.readdirSync(fx.snapshotDir).sort();
  fs.chmodSync(liveBojinPath, 0o000);
  fs.chmodSync(liveAuthPath, 0o000);
  fs.chmodSync(snapBojin, 0o400);
  fs.chmodSync(snapAuth, 0o400);
  fs.chmodSync(snapManifest, 0o400);
  fs.chmodSync(fx.snapshotDir, 0o500);
  try {
    const s = collectDailySummary({
      dataDir: fx.dataDir,
      nowMs: fx.nowMs,
      noJournal: true,
      noSystemd: true,
      snapshotDir: fx.snapshotDir
    });
    assert.equal(s.dbSource.status, "snapshot");
    assert.equal(s.accounts.trialToDate.signups, 4);
    assert.deepEqual(fs.readdirSync(fx.snapshotDir).sort(), snapBeforeEntries);
  } finally {
    fs.chmodSync(fx.snapshotDir, 0o700);
    fs.chmodSync(snapBojin, 0o600);
    fs.chmodSync(snapAuth, 0o600);
    fs.chmodSync(snapManifest, 0o600);
    fs.chmodSync(liveBojinPath, 0o600);
    fs.chmodSync(liveAuthPath, 0o600);
  }

  // 3. Running while an exclusive maintenance lease is held + concurrent createSnapshot succeeds cleanly
  const releaseExclusive = dataAccess.exclusive(fx.dataDir);
  try {
    const duringMaint = collectDailySummary({
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

  const snapTarget = path.join(fx.root, "fresh-backup-snapshot");
  await createSnapshot(fx.dataDir, snapTarget);
  const manifest = verifySnapshot(snapTarget);
  assert.equal(manifest.version, 1);
  // Summary can immediately read the freshly published snapshot from createSnapshot!
  const fromFreshSnap = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: Date.now() + 1000,
    noJournal: true,
    noSystemd: true,
    snapshotDir: snapTarget
  });
  assert.equal(fromFreshSnap.dbSource.status, "snapshot");
  assert.equal(fromFreshSnap.accounts.trialToDate.signups, 1);
});

test("when no snapshot is readable, reports unavailability instead of falling back to live DATA_DIR", (t) => {
  const fx = createFixture(t);
  const emptyBackupRoot = path.join(fx.root, "empty-backups");
  fs.mkdirSync(emptyBackupRoot);

  // Make live DATA_DIR DBs unreadable (0000) to prove they are NOT opened even when no snapshot exists
  const liveBojinPath = path.join(fx.dataDir, "bojin.db");
  const liveAuthPath = path.join(fx.dataDir, "auth.sqlite");
  fs.chmodSync(liveBojinPath, 0o000);
  fs.chmodSync(liveAuthPath, 0o000);
  try {
    const s = collectDailySummary({
      dataDir: fx.dataDir,
      nowMs: fx.nowMs,
      journalFile: fx.journalFile,
      backupRoot: emptyBackupRoot,
      deployBackupRoot: emptyBackupRoot,
      noSystemd: true
    });

    assert.equal(s.dataAsOf, null);
    assert.equal(s.dbSource.status, "unavailable");
    assert.match(s.dbSource.note, /never opened/i);
    assert.equal(s.accounts.snapshotAvailable, false);
    assert.equal(s.accounts.last24h, null);
    assert.equal(s.logs.snapshotAvailable, false);
    assert.equal(s.feedback.snapshotAvailable, false);
    assert.deepEqual(s.activeUsers, { last24h: null, trialToDate: null });
    assert.equal(s.storage.photos.totalDbCount, null);
    // Live journal + live disk/blob stat metrics STILL work!
    assert.equal(s.ai.source, "journal");
    assert.equal(s.ai.last24h.calls, 4);
    assert.equal(s.clientErrors.last24h.count, 2);
    assert.equal(s.storage.photos.diskCount, 2);
    assert.equal(s.storage.photos.diskBytes, 30720);

    const text = formatSummaryText(s);
    assert.match(text, /数据截止 \(data as of\): 不可用/);
    assert.match(text, /无可读备份快照/);
  } finally {
    fs.chmodSync(liveBojinPath, 0o600);
    fs.chmodSync(liveAuthPath, 0o600);
  }
});

test("--snapshot refuses live DATA_DIR and incomplete WAL snapshots", (t) => {
  const fx = createFixture(t);
  assert.throws(
    () => collectDailySummary({ dataDir: fx.dataDir, snapshotDir: fx.dataDir, noJournal: true, noSystemd: true }),
    /outside DATA_DIR/
  );

  // Snapshot with a -wal sidecar must be rejected
  const dirtySnap = path.join(fx.root, "dirty-snapshot");
  fs.cpSync(fx.snapshotDir, dirtySnap, { recursive: true });
  fs.writeFileSync(path.join(dirtySnap, "bojin.db-wal"), "fake-wal");
  assert.throws(
    () => collectDailySummary({ dataDir: fx.dataDir, snapshotDir: dirtySnap, noJournal: true, noSystemd: true }),
    /WAL sidecars/
  );
});

test("rejects empty-DB, half-written, checksum-mismatch, and missing-table snapshots; falls back to previous complete snapshot or errors", (t) => {
  const fx = createFixture(t);

  // 1. Empty manifest (files: []) + 0-byte bojin.db (Codex reproduction) -> fails explicitly!
  const emptySnap = path.join(fx.root, "empty-staged");
  fs.mkdirSync(emptySnap, { recursive: true });
  fs.writeFileSync(path.join(emptySnap, "bojin.db"), Buffer.alloc(0));
  fs.writeFileSync(
    path.join(emptySnap, "manifest.json"),
    JSON.stringify({ version: 1, created: fx.snapshotIso, files: [] })
  );
  assert.throws(
    () => collectDailySummary({ dataDir: fx.dataDir, snapshotDir: emptySnap, noJournal: true, noSystemd: true }),
    /manifest missing bojin\.db entry/
  );
  // Also verify CLI exits non-zero (never silently reports zeros)
  const emptyCli = spawnSync(
    process.execPath,
    [SCRIPT, "--snapshot", emptySnap, "--no-journal", "--no-systemd"],
    { cwd: ROOT, env: { ...process.env, DATA_DIR: fx.dataDir }, encoding: "utf8", timeout: 10000 }
  );
  assert.equal(emptyCli.status, 1);
  assert.match(emptyCli.stderr, /manifest missing bojin\.db entry/);

  // 2. Half-written / truncated bojin.db (manifest records full size/sha256, disk file truncated)
  const halfSnap = path.join(fx.root, "half-written");
  fs.cpSync(fx.snapshotDir, halfSnap, { recursive: true });
  const origBytes = fs.readFileSync(path.join(halfSnap, "bojin.db"));
  fs.writeFileSync(path.join(halfSnap, "bojin.db"), origBytes.subarray(0, Math.floor(origBytes.length / 2)));
  assert.throws(
    () => collectDailySummary({ dataDir: fx.dataDir, snapshotDir: halfSnap, noJournal: true, noSystemd: true }),
    /size mismatch/
  );

  // 3. Checksum mismatch (exact same length, 1 flipped byte in bojin.db)
  const badShaSnap = path.join(fx.root, "checksum-mismatch");
  fs.cpSync(fx.snapshotDir, badShaSnap, { recursive: true });
  const mutated = Buffer.from(fs.readFileSync(path.join(badShaSnap, "bojin.db")));
  mutated[mutated.length - 1] ^= 0xff;
  fs.writeFileSync(path.join(badShaSnap, "bojin.db"), mutated);
  assert.throws(
    () => collectDailySummary({ dataDir: fx.dataDir, snapshotDir: badShaSnap, noJournal: true, noSystemd: true }),
    /sha256 checksum mismatch/
  );

  // 4. Valid SQLite file + matching manifest checksum, but empty schema (no docs/blobs tables)
  const noTablesSnap = path.join(fx.root, "empty-schema");
  fs.mkdirSync(noTablesSnap, { recursive: true });
  const emptySqlite = new DatabaseSync(path.join(noTablesSnap, "bojin.db"));
  emptySqlite.exec("PRAGMA journal_mode = DELETE; CREATE TABLE unrelated (x INT);");
  emptySqlite.close();
  writeSnapshotManifest(noTablesSnap, fx.snapshotIso, ["bojin.db"]);
  assert.throws(
    () => collectDailySummary({ dataDir: fx.dataDir, snapshotDir: noTablesSnap, noJournal: true, noSystemd: true }),
    /missing expected table/
  );

  // 5. Auto-discovery fallback: newest snapshot is corrupted/checksum-mismatched -> falls back to previous complete one and says so!
  const fallbackRoot = path.join(fx.root, "fallback-backups");
  fs.mkdirSync(fallbackRoot, { recursive: true });
  // Previous complete snapshot (2026-11-23T04:01:00Z)
  const goodPrev = path.join(fallbackRoot, "snapshot-20261123T040000Z");
  fs.cpSync(fx.snapshotDir, goodPrev, { recursive: true });
  writeSnapshotManifest(goodPrev, "2026-11-23T04:01:00.000Z", ["bojin.db", "auth.sqlite"]);
  // Newer corrupted snapshot (2026-11-24T04:00:00Z)
  const badNewest = path.join(fallbackRoot, "snapshot-20261124T040000Z");
  fs.cpSync(badShaSnap, badNewest, { recursive: true });

  const fallbackSummary = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    backupRoot: fallbackRoot,
    deployBackupRoot: path.join(fx.root, "none"),
    noJournal: true,
    noSystemd: true
  });
  assert.equal(fallbackSummary.dbSource.status, "snapshot");
  assert.equal(fallbackSummary.dbSource.snapshotName, "snapshot-20261123T040000Z");
  assert.equal(fallbackSummary.dataAsOf, "2026-11-23T04:01:00.000Z");
  assert.equal(fallbackSummary.dbSource.skippedInvalidSnapshots.length, 1);
  assert.equal(fallbackSummary.dbSource.skippedInvalidSnapshots[0].name, "snapshot-20261124T040000Z");
  assert.match(fallbackSummary.dbSource.skippedInvalidSnapshots[0].reason, /sha256 checksum mismatch/);
  assert.match(fallbackSummary.dbSource.note, /fell back to snapshot-20261123T040000Z/);
  assert.equal(fallbackSummary.backup.latestSnapshotName, "snapshot-20261123T040000Z");
  assert.equal(fallbackSummary.accounts.trialToDate.signups, 2); // u_alpha & u_beta existed by 2026-11-23T04:01Z
  const fallbackText = formatSummaryText(fallbackSummary);
  assert.match(fallbackText, /快照回退说明:.*snapshot-20261124T040000Z.*fell back to snapshot-20261123T040000Z/);

  // 6. Auto-discovery with ONLY invalid snapshots -> reports an error (exit 1) instead of zeros!
  const allBadRoot = path.join(fx.root, "all-bad-backups");
  fs.mkdirSync(allBadRoot, { recursive: true });
  fs.cpSync(halfSnap, path.join(allBadRoot, "snapshot-20261124T040000Z"), { recursive: true });
  assert.throws(
    () => collectDailySummary({
      dataDir: fx.dataDir,
      nowMs: fx.nowMs,
      backupRoot: allBadRoot,
      deployBackupRoot: path.join(fx.root, "none"),
      noJournal: true,
      noSystemd: true
    }),
    /No valid completed backup snapshot found/
  );
  const allBadCli = spawnSync(
    process.execPath,
    [SCRIPT, "--backup-root", allBadRoot, "--deploy-backup-root", path.join(fx.root, "none"), "--no-journal", "--no-systemd"],
    { cwd: ROOT, env: { ...process.env, DATA_DIR: fx.dataDir }, encoding: "utf8", timeout: 10000 }
  );
  assert.equal(allBadCli.status, 1);
  assert.match(allBadCli.stderr, /No valid completed backup snapshot found/);
});

test("pseudonyms use an ephemeral per-report HMAC key and are unlinkable across reports", (t) => {
  const fx = createFixture(t);
  const r1 = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    noSystemd: true,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot
  });
  const r2 = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    noSystemd: true,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot
  });

  assert.notEqual(r1.feedback.newest[0].user, r2.feedback.newest[0].user);
  assert.notEqual(r1.feedback.newest[0].ref, r2.feedback.newest[0].ref);
  assert.equal(r1.feedback.newest[0].user, r1.feedback.newest[1].user);
  assert.equal(r2.feedback.newest[0].user, r2.feedback.newest[1].user);
  assert.throws(() => createReportPseudonymizer(Buffer.alloc(8)), /at least 16 bytes/);
});

test("opt-in --include-feedback-excerpts redacts emails, URLs, phones, tokens, and long digit runs", (t) => {
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

  const s = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    noSystemd: true,
    includeFeedbackExcerpts: true,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot
  });
  assert.equal(s.feedback.excerptsIncluded, true);
  assert.ok(Array.from(s.feedback.newest[0].excerpt).length <= 80);
  assert.ok(!s.feedback.newest[0].excerpt.includes("138-0013-8000"));
  assert.ok(!s.feedback.newest[0].excerpt.includes("leak@example.com"));
  assert.ok(!s.feedback.newest[0].excerpt.includes("evil.test"));
  assert.ok(!s.feedback.newest[0].excerpt.includes("AIzaSySecretKey12345"));
});

test("journalctl fetches from earlier of trialStart and now-24h so short --since never undercounts last24h", (t) => {
  const fx = createFixture(t);
  const sixHoursAgoMs = fx.nowMsHoursAgo(6);
  const twelveHoursAgoMs = fx.nowMsHoursAgo(12);
  const twoHoursAgoMs = fx.nowMsHoursAgo(2);

  let seenJournalArgs = null;
  const mockRunner = (cmd, args) => {
    if (cmd === "journalctl") {
      seenJournalArgs = args;
      const lines = [
        JSON.stringify({
          __REALTIME_TIMESTAMP: String(twelveHoursAgoMs * 1000),
          MESSAGE: "ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=stop prompt=1000 completion=200 reasoning=0 empty=false ms=1000"
        }),
        JSON.stringify({
          __REALTIME_TIMESTAMP: String(twelveHoursAgoMs * 1000),
          MESSAGE: `client-error auth=user page=food lang=zh rev=abc1234 ua=Safari/iOS18 source=index.html:1:1 name=TypeError ts=${new Date(twelveHoursAgoMs).toISOString()} msg="Network request failed"`
        }),
        JSON.stringify({
          __REALTIME_TIMESTAMP: String(twoHoursAgoMs * 1000),
          MESSAGE: "ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=stop prompt=500 completion=100 reasoning=0 empty=false ms=800"
        })
      ];
      return { status: 0, stdout: lines.join("\n") + "\n", stderr: "", error: null };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };

  const summary = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    sinceMs: sixHoursAgoMs,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot,
    noSystemd: true,
    runCommand: mockRunner
  });

  assert.ok(seenJournalArgs);
  const sinceIdx = seenJournalArgs.indexOf("--since");
  assert.notEqual(sinceIdx, -1);
  assert.equal(seenJournalArgs[sinceIdx + 1], "2026-11-23 10:00:00 UTC");

  assert.equal(summary.ai.last24h.calls, 2);
  assert.equal(summary.ai.trialToDate.calls, 1);
  assert.equal(summary.clientErrors.last24h.count, 1);
  assert.equal(summary.clientErrors.trialToDate.count, 0);
});

test("unknown AI providers are left unpriced rather than billed at Gemini rates", (t) => {
  const fx = createFixture(t);
  const customJournal = path.join(fx.root, "unknown-provider.log");
  fs.writeFileSync(
    customJournal,
    [
      JSON.stringify({
        __REALTIME_TIMESTAMP: String(fx.nowMsHoursAgo(2) * 1000),
        MESSAGE: "ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=stop prompt=1000 completion=1000 reasoning=0 empty=false ms=900"
      }),
      JSON.stringify({
        __REALTIME_TIMESTAMP: String(fx.nowMsHoursAgo(1) * 1000),
        MESSAGE: "ai provider=customllm kind=json images=0 model=custom-v1 finish_reason=stop prompt=1000000 completion=1000000 reasoning=0 empty=false ms=1200"
      })
    ].join("\n") + "\n"
  );

  const s = collectDailySummary({
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
  assert.equal(s.ai.last24h.byProvider.other.estimatedCostUsd, null);
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
  assert.match(def.basis, /final-attempt/);

  const custom = parsePricing({
    AI_INPUT_PRICE_PER_1M: "0.5",
    AI_OUTPUT_PRICE_PER_1M: "2.0",
    AI_OPENROUTER_OUTPUT_PRICE_PER_1M: "3.0"
  });
  assert.equal(custom.gemini.inputPer1M, 0.5);
  assert.equal(custom.gemini.outputPer1M, 2.0);
  assert.equal(custom.openrouter.outputPer1M, 3.0);

  assert.throws(() => parsePricing({ AI_INPUT_PRICE_PER_1M: "-1" }), /AI_INPUT_PRICE_PER_1M/);
  assert.throws(() => parsePricing({ AI_OUTPUT_PRICE_PER_1M: "abc" }), /AI_OUTPUT_PRICE_PER_1M/);
});

test("systemd backup fallback reports completed service exits only and exposes timerLastTriggerAt separately", (t) => {
  const fx = createFixture(t);
  const missingRoot = path.join(fx.root, "no-backups-here");

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
      return { status: 0, stdout: "LoadState=loaded\nLastTriggerUSec=Tue 2026-11-24 04:00:05 UTC\n", stderr: "", error: null };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };
  const s1 = collectDailySummary({
    dataDir: fx.dataDir, nowMs: fx.nowMs, noJournal: true,
    backupRoot: missingRoot, deployBackupRoot: missingRoot, runCommand: okRunner
  });
  assert.equal(s1.backup.source, "systemd-service");
  assert.equal(s1.backup.lastBackupAt, "2026-11-24T04:05:00.000Z");
  assert.equal(s1.backup.timerLastTriggerAt, "2026-11-24T04:00:05.000Z");

  // Rebooted host: timerLastTriggerAt MUST NOT populate lastBackupAt/ageHours
  const timerOnlyRunner = (cmd, args) => {
    if (cmd === "systemctl" && args.includes("bojin-backup.service")) {
      return { status: 0, stdout: "LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=\nInactiveEnterTimestamp=\n", stderr: "", error: null };
    }
    if (cmd === "systemctl" && args.includes("bojin-backup.timer")) {
      return { status: 0, stdout: "LoadState=loaded\nLastTriggerUSec=Mon 2026-11-23 04:02:10 UTC\n", stderr: "", error: null };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };
  const s2 = collectDailySummary({
    dataDir: fx.dataDir, nowMs: fx.nowMs, noJournal: true,
    backupRoot: missingRoot, deployBackupRoot: missingRoot, runCommand: timerOnlyRunner
  });
  assert.equal(s2.backup.source, "unavailable");
  assert.equal(s2.backup.lastBackupAt, null);
  assert.equal(s2.backup.ageHours, null);
  assert.equal(s2.backup.timerLastTriggerAt, "2026-11-23T04:02:10.000Z");

  // Running backup (ActiveState=activating) must NOT look like a completed backup
  const runningRunner = (cmd, args) => {
    if (cmd === "systemctl" && args.includes("bojin-backup.service")) {
      return { status: 0, stdout: "LoadState=loaded\nActiveState=activating\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=Tue 2026-11-24 04:00:00 UTC\n", stderr: "", error: null };
    }
    if (cmd === "systemctl" && args.includes("bojin-backup.timer")) {
      return { status: 0, stdout: "LoadState=loaded\nLastTriggerUSec=Tue 2026-11-24 09:59:00 UTC\n", stderr: "", error: null };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };
  const s3 = collectDailySummary({
    dataDir: fx.dataDir, nowMs: fx.nowMs, noJournal: true,
    backupRoot: missingRoot, deployBackupRoot: missingRoot, runCommand: runningRunner
  });
  assert.equal(s3.backup.lastBackupAt, null);
  assert.equal(s3.backup.timerLastTriggerAt, "2026-11-24T09:59:00.000Z");
  assert.match(s3.backup.note, /running/i);

  // Failed backup run must NOT report a successful backup
  const failRunner = (cmd, args) => {
    if (cmd === "systemctl" && args.includes("bojin-backup.service")) {
      return { status: 0, stdout: "LoadState=loaded\nActiveState=failed\nResult=exit-code\nExecMainStatus=1\nExecMainExitTimestamp=Tue 2026-11-24 04:01:00 UTC\n", stderr: "", error: null };
    }
    if (cmd === "systemctl" && args.includes("bojin-backup.timer")) {
      return { status: 0, stdout: "LoadState=loaded\nLastTriggerUSec=Tue 2026-11-24 04:00:05 UTC\n", stderr: "", error: null };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };
  const s4 = collectDailySummary({
    dataDir: fx.dataDir, nowMs: fx.nowMs, noJournal: true,
    backupRoot: missingRoot, deployBackupRoot: missingRoot, runCommand: failRunner
  });
  assert.equal(s4.backup.lastBackupAt, null);
  assert.equal(s4.backup.serviceResult, "exit-code");
  assert.match(s4.backup.note, /failed/i);
});

test("journalctl permission denial degrades gracefully to snapshot_db_only without crashing", (t) => {
  const fx = createFixture(t);
  const permDeniedRunner = (cmd) => {
    if (cmd === "journalctl") {
      return { status: 0, stdout: "", stderr: "Hint: You are currently not seeing messages from other users and the system.\n", error: null };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };

  const summary = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot,
    noSystemd: true,
    runCommand: permDeniedRunner
  });

  assert.equal(summary.ai.source, "snapshot_db_only");
  assert.equal(summary.ai.journalStatus, "permission_denied");
  assert.equal(summary.ai.last24h.calls, null);
  assert.equal(summary.ai.last24h.dbCallsAsOfUtcDate, 4);
  assert.equal(summary.ai.trialToDate.dbCalls, 6);
  assert.equal(summary.clientErrors.source, "unavailable");
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

test("missing DATA_DIR and missing snapshots do not create files and exit cleanly", (t) => {
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
  assert.equal(parsed.dbSource.status, "unavailable");
  assert.equal(parsed.accounts.snapshotAvailable, false);
  assert.equal(parsed.activeUsers.trialToDate, null);
});

test("CLI supports plain text, --json, --snapshot, stdin journal, custom pricing, --help, and never touches live DATA_DIR", (t) => {
  const fx = createFixture(t);
  const env = {
    ...process.env,
    DATA_DIR: fx.dataDir,
    AI_INPUT_PRICE_PER_1M: "1.0",
    AI_OUTPUT_PRICE_PER_1M: "4.0"
  };
  const beforeEntries = fs.readdirSync(fx.dataDir).sort();

  const journalContent = fs.readFileSync(fx.journalFile, "utf8");
  const txtRes = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--now", fx.nowIso,
      "--snapshot", fx.snapshotDir,
      "--journal-file", "-",
      "--no-systemd"
    ],
    { cwd: ROOT, env, input: journalContent, encoding: "utf8", timeout: 10000 }
  );
  assert.equal(txtRes.status, 0, txtRes.stderr);
  assert.match(txtRes.stdout, /薄肌日课 · 每日活动摘要/);
  assert.match(txtRes.stdout, /数据截止 \(data as of\): 2026-11-24T04:01:15\.000Z/);
  assert.match(txtRes.stdout, /Gemini 输入 \$1 \/ 输出 \$4/);
  assert.ok(!txtRes.stdout.includes("alice.secret@example.com"));
  assert.ok(!txtRes.stdout.includes("张三"));
  assert.ok(!txtRes.stdout.includes("fb_rawpk000004"));
  assert.deepEqual(fs.readdirSync(fx.dataDir).sort(), beforeEntries);
  assert.equal(fs.existsSync(path.join(fx.dataDir, ".access")), false);

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
  assert.equal(parsed.dataAsOf, fx.snapshotIso);
  assert.equal(parsed.ai.last24h.byProvider.gemini.estimatedCostUsd, 0.007);
  assert.equal(parsed.ai.last24h.byProvider.openrouter.estimatedCostUsd, 0.0035);
  assert.equal(parsed.ai.last24h.estimatedCostUsd, 0.0105);

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

test("handles legacy snapshot without feedback table or auth.sqlite and ignores symlinks in blobs/", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-summary-legacy-"));
  const dataDir = path.join(root, "data");
  const blobsDir = path.join(dataDir, "blobs");
  const snapDir = path.join(root, "snap");
  const outsideFile = path.join(root, "outside.bin");
  fs.mkdirSync(blobsDir, { recursive: true });
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(outsideFile, Buffer.alloc(99999, 0x42));
  fs.symlinkSync(outsideFile, path.join(blobsDir, "f".repeat(32)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const db = new DatabaseSync(path.join(snapDir, "bojin.db"));
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE docs (path TEXT PRIMARY KEY, uid TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
  `);
  db.close();
  writeSnapshotManifest(snapDir, "2026-11-24T04:00:00.000Z", ["bojin.db"]);

  const summary = collectDailySummary({
    dataDir,
    nowMs: Date.parse("2026-11-24T10:00:00.000Z"),
    snapshotDir: snapDir,
    noJournal: true,
    noSystemd: true
  });
  assert.equal(summary.dbSource.status, "snapshot");
  assert.equal(summary.accounts.authDbPresent, false);
  assert.equal(summary.logs.appDbPresent, true);
  assert.equal(summary.feedback.trialToDate.total, 0);
  assert.equal(summary.storage.photos.diskCount, 0);
  assert.equal(summary.storage.photos.diskBytes, 0);
});

test("collectDailySummary counts phone vs email signups without leaking phone numbers", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-summary-phone-"));
  const dataDir = path.join(root, "data");
  const snapDir = path.join(root, "snap");
  fs.mkdirSync(path.join(dataDir, "blobs"), { recursive: true });
  fs.mkdirSync(snapDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const snapIso = "2026-11-25T04:00:00.000Z";
  const snapMs = Date.parse(snapIso);
  const hoursAgo = (h) => new Date(snapMs - h * 3600 * 1000).toISOString();

  const authDb = new DatabaseSync(path.join(snapDir, "auth.sqlite"));
  authDb.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE "user" (
      "id" text not null primary key,
      "name" text not null,
      "email" text not null unique,
      "emailVerified" integer not null,
      "phoneNumber" text,
      "phoneNumberVerified" integer,
      "createdAt" date not null,
      "updatedAt" date not null
    );
  `);
  const ins = authDb.prepare(
    `INSERT INTO "user" (id, name, email, emailVerified, phoneNumber, phoneNumberVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // 2 email users (1 older verified, 1 recent unverified) + 2 phone users (1 older, 1 recent)
  ins.run("u_em_1", "Email Old", "old@example.com", 1, null, 0, hoursAgo(48), hoursAgo(48));
  ins.run("u_em_2", "Email New", "new@example.com", 0, null, 0, hoursAgo(4), hoursAgo(4));
  ins.run("u_ph_1", "Phone Old", "phone-1111@phone.leanritual.invalid", 0, "+8613800138001", 0, hoursAgo(36), hoursAgo(36));
  ins.run("u_ph_2", "Phone New", "phone-2222@phone.leanritual.invalid", 0, "+8613900139002", 0, hoursAgo(2), hoursAgo(2));
  authDb.close();

  const bojinDb = new DatabaseSync(path.join(snapDir, "bojin.db"));
  bojinDb.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE docs (path TEXT PRIMARY KEY, uid TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
  `);
  bojinDb.close();
  writeSnapshotManifest(snapDir, snapIso, ["bojin.db", "auth.sqlite"]);

  const summary = collectDailySummary({
    dataDir,
    nowMs: Date.parse("2026-11-25T10:00:00.000Z"),
    snapshotDir: snapDir,
    noJournal: true,
    noSystemd: true
  });

  assert.deepEqual(summary.accounts.last24h, {
    signups: 2,
    verifiedSignups: 1,
    emailSignups: 1,
    phoneSignups: 1
  });
  assert.deepEqual(summary.accounts.trialToDate, {
    signups: 4,
    verified: 3,
    unverified: 1,
    emailSignups: 2,
    phoneSignups: 2
  });

  const text = formatSummaryText(summary);
  assert.match(text, /近24h 新增 2 \(邮箱 1, 手机 1; 已验证 1\)/);
  assert.match(text, /累计 4 \(邮箱 2, 手机 2; 已验证 3, 未验证 1\)/);
  const combined = JSON.stringify(summary) + "\n" + text;
  assert.ok(!combined.includes("13800138001"));
  assert.ok(!combined.includes("13900139002"));
});

test("daily summary tallies client-error-filtered noise separately from real client errors", (t) => {
  const fx = createFixture(t);
  const filteredLines = [
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(fx.nowMsHoursAgo(2) * 1000),
      MESSAGE: `client-error-filtered auth=user page=today lang=zh rev=1e51b8e456ad ua=Chrome/Android16 reason=script_error ts=${fx.nowHoursAgo(2)}`
    }),
    `${fx.nowHoursAgo(4).replace(".000Z", "+0000")} leanritual node[4242]: client-error-filtered auth=user page=me lang=zh rev=1e51b8e456ad ua=Chrome/Android16 reason=non_origin ts=${fx.nowHoursAgo(4)}`,
    `client-error-filtered auth=user page=login lang=zh rev=1e51b8e456ad ua=Chrome/Android16 reason=resize_observer ts=${fx.nowHoursAgo(5)}`,
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(fx.nowMsHoursAgo(40) * 1000),
      MESSAGE: `client-error-filtered auth=user page=today lang=zh rev=1e51b8e456ad ua=Safari/macOS10 reason=script_error ts=${fx.nowHoursAgo(40)}`
    })
  ];
  fs.appendFileSync(fx.journalFile, filteredLines.join("\n") + "\n", "utf8");

  const summary = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    journalFile: fx.journalFile,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot,
    noSystemd: true,
    env: {}
  });

  // Real client error counts are unchanged (2 in last 24h, 3 trial-to-date)
  assert.equal(summary.clientErrors.last24h.count, 2);
  assert.deepEqual(summary.clientErrors.last24h.byName, { TypeError: 1, SaveError: 1 });
  assert.equal(summary.clientErrors.trialToDate.count, 3);

  // Filtered noise is tracked in its own tally and breakdown
  assert.equal(summary.clientErrors.last24h.filtered, 3);
  assert.deepEqual(summary.clientErrors.last24h.filteredByReason, {
    script_error: 1,
    non_origin: 1,
    resize_observer: 1
  });
  assert.equal(summary.clientErrors.trialToDate.filtered, 4);
  assert.deepEqual(summary.clientErrors.trialToDate.filteredByReason, {
    script_error: 2,
    non_origin: 1,
    resize_observer: 1
  });

  const text = formatSummaryText(summary);
  assert.match(text, /近24h: 2 \(SaveError: 1, TypeError: 1\), 已过滤噪音 3 \(non_origin: 1, resize_observer: 1, script_error: 1\)/);
  assert.match(text, /累计:\s+3 \(TypeError: 2, SaveError: 1\), 已过滤噪音 4 \(script_error: 2, non_origin: 1, resize_observer: 1\)/);
});

test("daily summary reports invite-request counts from snapshots and handles older snapshots without invite_requests", (t) => {
  const fx = createFixture(t);

  // 1. Default fixture snapshot has no invite_requests table yet -> graceful fallback
  const legacy = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    snapshotDir: fx.snapshotDir,
    noJournal: true,
    noSystemd: true,
    env: {}
  });
  assert.equal(legacy.inviteRequests.snapshotAvailable, true);
  assert.equal(legacy.inviteRequests.tablePresent, false);
  assert.equal(legacy.inviteRequests.pendingTotal, 0);
  assert.deepEqual(legacy.inviteRequests.last24h, { new: 0, byKind: { phone: 0, email: 0 } });
  assert.deepEqual(legacy.inviteRequests.trialToDate, { new: 0, byKind: { phone: 0, email: 0 } });
  const legacyText = formatSummaryText(legacy);
  assert.match(legacyText, /\[内测申请 \/ Invite Requests\]/);
  assert.match(legacyText, /尚无 invite_requests 表/);

  // 2. Add invite_requests table to snapshot and regenerate manifest -> accurate counts, zero PII
  const snapMs = Date.parse("2026-11-24T04:01:15.000Z");
  const snapAgo = h => new Date(snapMs - h * 3600 * 1000).toISOString();
  const db = new DatabaseSync(path.join(fx.snapshotDir, "bojin.db"));
  db.exec(`
    CREATE TABLE invite_requests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact_kind TEXT NOT NULL,
      contact_value TEXT NOT NULL,
      goal TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      lang TEXT NOT NULL DEFAULT 'zh',
      status TEXT NOT NULL DEFAULT 'pending',
      status_note TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );
  `);
  const ins = db.prepare(
    "INSERT INTO invite_requests (id, name, contact_kind, contact_value, goal, note, lang, status, status_note, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)"
  );
  ins.run("req_111111111111", "SecretOne", "phone", "+8613800138999", "Secret goal 1", "wx1", "zh", "pending", snapAgo(3), snapAgo(3));
  ins.run("req_222222222222", "SecretTwo", "email", "secret2@example.com", "Secret goal 2", "", "en", "pending", snapAgo(12), snapAgo(12));
  ins.run("req_333333333333", "SecretThree", "phone", "+14155559999", "Secret goal 3", "", "en", "invited", snapAgo(48), snapAgo(20));
  ins.run("req_444444444444", "SecretFour", "email", "secret4@example.com", "Secret goal 4", "", "zh", "dismissed", snapAgo(72), snapAgo(60));
  db.close();
  writeSnapshotManifest(fx.snapshotDir, "2026-11-24T04:01:15.000Z");

  const summary = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    snapshotDir: fx.snapshotDir,
    noJournal: true,
    noSystemd: true,
    env: {}
  });
  assert.equal(summary.inviteRequests.snapshotAvailable, true);
  assert.equal(summary.inviteRequests.tablePresent, true);
  assert.equal(summary.inviteRequests.pendingTotal, 2);
  assert.deepEqual(summary.inviteRequests.byStatus, { pending: 2, invited: 1, dismissed: 1 });
  assert.deepEqual(summary.inviteRequests.last24h, { new: 2, byKind: { phone: 1, email: 1 } });
  assert.deepEqual(summary.inviteRequests.trialToDate, { new: 4, byKind: { phone: 2, email: 2 } });

  const text = formatSummaryText(summary);
  assert.match(text, /待处理 \(pending\): 2 \(累计状态: pending 2, invited 1, dismissed 1\)/);
  assert.match(text, /近24h 新增: 2 \(手机 1, 邮箱 1\)/);
  assert.match(text, /累计新增:\s+4 \(手机 2, 邮箱 2\)/);
  const combined = JSON.stringify(summary) + "\n" + text;
  for (const leak of ["SecretOne", "SecretTwo", "+8613800138999", "secret2@example.com", "Secret goal 1", "req_111111111111"]) {
    assert.ok(!combined.includes(leak), `daily-summary leaked invite request PII: ${leak}`);
  }
});
