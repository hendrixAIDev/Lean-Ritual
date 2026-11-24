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
  anonymizeUid,
  parsePricing,
  sanitizeFeedbackExcerpt,
  parseJournalStream,
  collectDailySummary,
  formatSummaryText
} = require("../lib/daily-summary");
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
  // u_beta: signed up 3 days ago, verified 4 hours ago (verified in last 24h!)
  insertUser.run("u_beta_secret", "Bob SecretName", "bob.secret@example.com", 1, hoursAgo(72), hoursAgo(4));
  // u_gamma: signed up 6 hours ago, verified 5 hours ago (both signup & verified in last 24h)
  insertUser.run("u_gamma_secret", "Carol SecretName", "carol.secret@example.com", 1, hoursAgo(6), hoursAgo(5));
  // u_delta: signed up 2 hours ago, NOT verified yet
  insertUser.run("u_delta_secret", "Dave SecretName", "dave.secret@example.com", 0, hoursAgo(2), hoursAgo(2));

  const insertSession = authDb.prepare(
    `INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // u_beta logged in 3h ago (active in 24h even without docs)
  insertSession.run("s1", hoursAgo(-100), "tok_secret_1", hoursAgo(3), hoursAgo(3), "10.0.0.1", "Safari", "u_beta_secret");
  // u_alpha had an old session 80h ago
  insertSession.run("s2", hoursAgo(-20), "tok_secret_2", hoursAgo(80), hoursAgo(80), "10.0.0.2", "Chrome", "u_alpha_secret");
  authDb.close();

  // 2. bojin.db
  const bojinDb = new DatabaseSync(path.join(dataDir, "bojin.db"));
  bojinDb.exec(`
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
  // u_alpha day 2026-11-24 (recent: checkin + done workout + 2 recent meals + 1 old meal re-estimated)
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
  // u_alpha older day 2026-11-21 (older than 24h: checkin + done workout + 1 meal)
  putDoc.run(
    "data/users/u_alpha_secret/app/days/2026-11-21",
    "u_alpha_secret",
    "data/users/u_alpha_secret/app/days",
    JSON.stringify({
      date: "2026-11-21",
      checkin: { weight: 71.6 },
      workout: { done: true, key: "pull", savedAt: hoursAgo(75) },
      meals: [
        // Created 74h ago (encoded in base36 id), even if re-estimated 1h ago it's NOT a new 24h meal!
        { id: makeBase36MealId(msHoursAgo(74), "ccccc"), type: "晚餐", text: "OLD_MEAL_REEST", est: { kcal: 700, at: hoursAgo(1) } }
      ]
    }),
    hoursAgo(74)
  );
  // u_gamma day 2026-11-24 (recent: empty checkin ignored, incomplete workout draft ignored, 1 meal via est.at)
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
  // u_gamma profile doc (non-day doc; should not count as checkin/workout/meal)
  putDoc.run(
    "data/users/u_gamma_secret/app/app/profile",
    "u_gamma_secret",
    "data/users/u_gamma_secret/app/app",
    JSON.stringify({ weight: 68, height: 175 }),
    hoursAgo(5)
  );

  // Blobs (photos)
  const blob1 = Buffer.alloc(10240, 0xaa); // 10 KiB, 3h ago
  const blob2 = Buffer.alloc(20480, 0xbb); // 20 KiB, 60h ago
  const b1Id = "1".repeat(32);
  const b2Id = "2".repeat(32);
  fs.writeFileSync(path.join(blobsDir, b1Id), blob1);
  fs.writeFileSync(path.join(blobsDir, b2Id), blob2);
  bojinDb.prepare("INSERT INTO blobs (id, uid, type, size, created) VALUES (?, ?, ?, ?, ?)").run(b1Id, "u_alpha_secret", "image/webp", blob1.length, hoursAgo(3));
  bojinDb.prepare("INSERT INTO blobs (id, uid, type, size, created) VALUES (?, ?, ?, ?, ?)").run(b2Id, "u_alpha_secret", "image/webp", blob2.length, hoursAgo(60));

  // AI usage in DB
  bojinDb.prepare("INSERT INTO ai_usage (uid, day, n) VALUES (?, ?, ?)").run("u_alpha_secret", "2026-11-24", 3);
  bojinDb.prepare("INSERT INTO ai_usage (uid, day, n) VALUES (?, ?, ?)").run("u_gamma_secret", "2026-11-24", 1);
  bojinDb.prepare("INSERT INTO ai_usage (uid, day, n) VALUES (?, ?, ?)").run("u_alpha_secret", "2026-11-21", 2);

  // Feedback (4 entries: 2 in last 24h, 2 older; newest includes hostile terminal chars, email, and >80 chars)
  const insertFb = bojinDb.prepare(
    "INSERT INTO feedback (id, uid, type, message, screenshot_blob_id, device_info, created) VALUES (?, ?, ?, ?, NULL, NULL, ?)"
  );
  const longMsg = "拍照识别晚饭时如果切到后台再回来会一直转圈，希望可以手动取消或者重试，我的邮箱是 leak@example.com 还有\x1b[31mRED\x1b[0m\u202e后面的字应该被截断掉不要出现在前八十字里TAIL_MARKER";
  insertFb.run("fb_000000000004", "u_alpha_secret", "bug", longMsg, hoursAgo(1));
  insertFb.run("fb_000000000003", "u_gamma_secret", "idea", "希望能导出最近两周的体重和训练曲线图片", hoursAgo(10));
  insertFb.run("fb_000000000002", "u_beta_secret", "other", "整体很顺手，界面在手机上字号刚好！", hoursAgo(40));
  insertFb.run("fb_000000000001", "u_alpha_secret", "bug", "这是一条很早的反馈不应出现在最新三条", hoursAgo(90));
  bojinDb.close();

  // 3. Journal log file (mixing JSON and short-iso formats)
  const journalFile = path.join(root, "journal.log");
  const jLines = [
    // 24h: Gemini direct call (with 1 retry)
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(2) * 1000),
      MESSAGE: "ai provider=gemini retries=1 kind=json images=1 model=gemini-3.8-flash finish_reason=stop prompt=1000 completion=400 reasoning=0 empty=false ms=3200"
    }),
    // 24h: Gemini direct call
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(5) * 1000),
      MESSAGE: "ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=stop prompt=2000 completion=600 reasoning=100 empty=false ms=4100"
    }),
    // 24h: OpenRouter fallback call (short-iso format)
    `${hoursAgo(4).replace(".000Z", "+0000")} leanritual node[4242]: ai provider=openrouter provider_fallback=true retries=2 kind=json images=1 model=google/gemini-3.8-flash finish_reason=stop prompt=1500 completion=500 reasoning=0 empty=false ms=6100`,
    // 24h: Failed Gemini call
    `${hoursAgo(3).replace(".000Z", "+0000")} leanritual node[4242]: ai provider=gemini kind=json images=0 model=gemini-3.8-flash finish_reason=error prompt=0 completion=0 reasoning=0 empty=true ms=1500`,
    // Older (70h ago): OpenRouter primary (legacy line without provider=)
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(70) * 1000),
      MESSAGE: "ai kind=json images=0 model=google/gemini-3.8-flash finish_reason=stop prompt=4000 completion=1000 reasoning=200 empty=false ms=5000"
    }),
    // Older (68h ago): Gemini call
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(68) * 1000),
      MESSAGE: "ai provider=gemini kind=text images=0 model=gemini-3.8-flash finish_reason=stop prompt=500 completion=200 reasoning=0 empty=false ms=1200"
    }),
    // 24h: Client error (JSON)
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(3) * 1000),
      MESSAGE: `client-error auth=user page=food lang=zh rev=abc1234 ua=Safari/iOS18 source=index.html:120:5 name=TypeError ts=${hoursAgo(3)} msg="Cannot read properties of null or undefined"`
    }),
    // 24h: Client error (short-iso)
    `${hoursAgo(6).replace(".000Z", "+0000")} leanritual node[4242]: client-error auth=anon page=login lang=zh rev=abc1234 ua=Chrome/Android14 source=login.html:45:1 name=SaveError ts=${hoursAgo(6)} msg="Error details withheld"`,
    // Older (50h ago): Client error
    JSON.stringify({
      __REALTIME_TIMESTAMP: String(msHoursAgo(50) * 1000),
      MESSAGE: `client-error auth=user page=today lang=en rev=abc1234 ua=Chrome/macOS15 source=index.html:88:1 name=TypeError ts=${hoursAgo(50)} msg="Network request failed"`
    }),
    // Unrelated log line (must be ignored)
    `${hoursAgo(1).replace(".000Z", "+0000")} leanritual node[4242]: 薄肌日课已启动：http://127.0.0.1:8080`
  ];
  fs.writeFileSync(journalFile, jLines.join("\n") + "\n", "utf8");

  // 4. Backup snapshots (daily + deploy + ignored future snapshot)
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
  // Bogus future snapshot should be ignored
  fs.mkdirSync(path.join(backupRoot, "snapshot-20990101T000000Z"), { recursive: true });

  const deploySnap = path.join(deployBackupRoot, "20261123T180000Z-abcd1234");
  fs.mkdirSync(path.join(deploySnap, "snapshot"), { recursive: true });
  fs.writeFileSync(
    path.join(deploySnap, "snapshot", "manifest.json"),
    JSON.stringify({ version: 1, created: "2026-11-23T18:00:30.000Z", files: [] })
  );

  return { root, dataDir, backupRoot, deployBackupRoot, journalFile, nowMs, nowIso };
}

test("collectDailySummary computes accurate 24h and trial-to-date metrics without PII", (t) => {
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

  // Accounts: 4 total (3 verified, 1 unverified); 24h: 2 signups (gamma, delta), 2 verified (beta verified 4h ago + gamma verified 5h ago)
  assert.equal(summary.accounts.authDbPresent, true);
  assert.deepEqual(summary.accounts.last24h, { signups: 2, verified: 2 });
  assert.deepEqual(summary.accounts.trialToDate, { signups: 4, verified: 3, unverified: 1 });

  // Active users: 24h = alpha (doc/blob/fb/ai), beta (session), gamma (doc/fb/ai) = 3; trial = same 3 (delta never logged in or wrote docs)
  assert.deepEqual(summary.activeUsers, { last24h: 3, trialToDate: 3 });

  // Logs:
  // 24h: 1 checkin (alpha 11-24; gamma empty ignored), 1 workout (alpha 11-24; gamma done:false ignored), 3 meals (alpha x2 + gamma x1; old re-estimated meal excluded!)
  // trial: 2 checkins, 2 workouts, 4 meals
  assert.deepEqual(summary.logs.last24h, { checkins: 1, workouts: 1, meals: 3 });
  assert.deepEqual(summary.logs.trialToDate, { checkins: 2, workouts: 2, meals: 4 });

  // AI calls & cost (defaults: $0.75/1M input, $3.75/1M output):
  // 24h:
  //   gemini: 3 calls (1 error, 1 retry), prompt=3000, completion=1000, reasoning=100 -> 3000*0.75/1e6 + 1000*3.75/1e6 = 0.00225 + 0.00375 = 0.006
  //   openrouter: 1 call (fallbackCalls=1, primaryCalls=0, retries=2), prompt=1500, completion=500 -> 0.001125 + 0.001875 = 0.003
  assert.equal(summary.ai.source, "journal");
  assert.equal(summary.ai.last24h.calls, 4);
  assert.equal(summary.ai.last24h.errors, 1);
  assert.equal(summary.ai.last24h.dbCallsTodayUtc, 4);
  assert.equal(summary.ai.last24h.byProvider.gemini.calls, 3);
  assert.equal(summary.ai.last24h.byProvider.gemini.retries, 1);
  assert.equal(summary.ai.last24h.byProvider.gemini.errors, 1);
  assert.equal(summary.ai.last24h.byProvider.gemini.promptTokens, 3000);
  assert.equal(summary.ai.last24h.byProvider.gemini.completionTokens, 1000);
  assert.equal(summary.ai.last24h.byProvider.gemini.reasoningTokens, 100);
  assert.equal(summary.ai.last24h.byProvider.gemini.estimatedCostUsd, 0.006);
  assert.equal(summary.ai.last24h.byProvider.openrouter.calls, 1);
  assert.equal(summary.ai.last24h.byProvider.openrouter.fallbackCalls, 1);
  assert.equal(summary.ai.last24h.byProvider.openrouter.primaryCalls, 0);
  assert.equal(summary.ai.last24h.byProvider.openrouter.estimatedCostUsd, 0.003);
  assert.equal(summary.ai.last24h.estimatedCostUsd, 0.009);

  // trialToDate AI:
  //   gemini: +1 call (500p / 200c) -> 4 calls, 3500p, 1200c
  //   openrouter: +1 legacy primary call (4000p / 1000c / 200r) -> 2 calls (1 fallback, 1 primary), 5500p, 1500c, 200r
  assert.equal(summary.ai.trialToDate.calls, 6);
  assert.equal(summary.ai.trialToDate.dbCalls, 6);
  assert.equal(summary.ai.trialToDate.byProvider.gemini.calls, 4);
  assert.equal(summary.ai.trialToDate.byProvider.openrouter.calls, 2);
  assert.equal(summary.ai.trialToDate.byProvider.openrouter.fallbackCalls, 1);
  assert.equal(summary.ai.trialToDate.byProvider.openrouter.primaryCalls, 1);
  assert.equal(summary.ai.trialToDate.promptTokens, 9000);
  assert.equal(summary.ai.trialToDate.completionTokens, 2700);
  assert.equal(summary.ai.trialToDate.reasoningTokens, 300);

  // Feedback: 24h=2 (bug 1, idea 1, other 0), trial=4 (bug 2, idea 1, other 1), newest=3
  assert.deepEqual(summary.feedback.last24h, { total: 2, byType: { bug: 1, idea: 1, other: 0 } });
  assert.deepEqual(summary.feedback.trialToDate, { total: 4, byType: { bug: 2, idea: 1, other: 1 } });
  assert.equal(summary.feedback.newest.length, 3);
  assert.equal(summary.feedback.newest[0].id, "fb_000000000004");
  assert.equal(summary.feedback.newest[0].type, "bug");
  assert.equal(summary.feedback.newest[0].user, anonymizeUid("u_alpha_secret"));
  assert.equal(summary.feedback.newest[0].truncated, true);
  assert.ok(Array.from(summary.feedback.newest[0].excerpt).length <= 80);
  assert.ok(!summary.feedback.newest[0].excerpt.includes("leak@example.com"));
  assert.ok(!summary.feedback.newest[0].excerpt.includes("TAIL_MARKER"));

  // Client errors: 24h=2, trial=3
  assert.equal(summary.clientErrors.source, "journal");
  assert.equal(summary.clientErrors.last24h.count, 2);
  assert.deepEqual(summary.clientErrors.last24h.byName, { TypeError: 1, SaveError: 1 });
  assert.equal(summary.clientErrors.trialToDate.count, 3);
  assert.deepEqual(summary.clientErrors.trialToDate.byName, { TypeError: 2, SaveError: 1 });

  // Storage & photos
  assert.ok(summary.storage.disk && summary.storage.disk.totalBytes > 0);
  assert.equal(summary.storage.photos.totalDbCount, 2);
  assert.equal(summary.storage.photos.totalDbBytes, 30720);
  assert.equal(summary.storage.photos.diskCount, 2);
  assert.equal(summary.storage.photos.diskBytes, 30720);
  assert.deepEqual(summary.storage.photos.last24h, { count: 1, bytes: 10240 });

  // Backup: daily snapshot is newer than deploy snapshot; future 2099 ignored
  assert.equal(summary.backup.source, "filesystem");
  assert.equal(summary.backup.lastBackupAt, "2026-11-24T04:01:15.000Z");
  assert.equal(summary.backup.latestSnapshotName, "snapshot-20261124T040000Z");
  assert.equal(summary.backup.dailySnapshotCount, 2);
  assert.equal(summary.backup.deploySnapshotCount, 1);

  // Strict PII & secret check on both JSON and plain text
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
    "tok_secret_1",
    "PRIVATE_WORKOUT_NOTE",
    "PRIVATE_MEAL_TEXT_1",
    "PRIVATE_SNACK",
    "TAIL_MARKER"
  ]) {
    assert.ok(!jsonText.includes(forbidden), `JSON must not leak ${forbidden}`);
    assert.ok(!plainText.includes(forbidden), `plain text must not leak ${forbidden}`);
  }

  // Zero raw terminal control/bidi chars in plain text
  const rawControlRe = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/;
  assert.equal(rawControlRe.test(plainText), false, "plain text must not contain raw control/bidi chars");
});

test("parsePricing supports gemini-3.8-flash defaults, custom env overrides, and rejects invalid values", () => {
  const def = parsePricing({});
  assert.equal(def.modelDefault, DEFAULT_AI_PRICING.model);
  assert.equal(def.gemini.inputPer1M, 0.75);
  assert.equal(def.gemini.outputPer1M, 3.75);
  assert.equal(def.openrouter.inputPer1M, 0.75);
  assert.equal(def.openrouter.outputPer1M, 3.75);

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

test("sanitizeFeedbackExcerpt truncates by Unicode code points and redacts emails", () => {
  const eightyFiveZh = "薄".repeat(85);
  const res = sanitizeFeedbackExcerpt(eightyFiveZh);
  assert.equal(Array.from(res.excerpt).length, 80);
  assert.equal(res.truncated, true);

  const withEmail = "请联系 me.tester+1@sub.domain.org 反馈\n第二行";
  const res2 = sanitizeFeedbackExcerpt(withEmail);
  assert.equal(res2.truncated, false);
  assert.equal(res2.excerpt, "请联系 [redacted] 反馈 第二行");
});

test("--since filters trial-to-date metrics cleanly", (t) => {
  const fx = createFixture(t);
  const sinceMs = Date.parse("2026-11-23T00:00:00.000Z");
  const summary = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    sinceMs,
    journalFile: fx.journalFile,
    backupRoot: fx.backupRoot,
    deployBackupRoot: fx.deployBackupRoot,
    noSystemd: true,
    env: {}
  });

  // Only gamma & delta signed up since 2026-11-23
  assert.equal(summary.accounts.trialToDate.signups, 2);
  assert.equal(summary.accounts.trialToDate.verified, 1);
  // Only 2026-11-24 docs/meals since 2026-11-23
  assert.deepEqual(summary.logs.trialToDate, { checkins: 1, workouts: 1, meals: 3 });
  // Only 24h AI & error events occurred since 2026-11-23
  assert.equal(summary.ai.trialToDate.calls, 4);
  assert.equal(summary.clientErrors.trialToDate.count, 2);
  // Only 2 feedbacks since 2026-11-23
  assert.equal(summary.feedback.trialToDate.total, 2);
  assert.equal(summary.feedback.newest.length, 2);
});

test("systemd backup fallback handles service success, timer fallback after reboot, and refuses failed runs", (t) => {
  const fx = createFixture(t);
  const missingRoot = path.join(fx.root, "no-backups-here");

  // 1. bojin-backup.service succeeded
  const okRunner = (cmd, args) => {
    if (cmd === "systemctl" && args.includes("bojin-backup.service")) {
      return {
        status: 0,
        stdout: [
          "LoadState=loaded",
          "Result=success",
          "ExecMainStatus=0",
          "ExecMainExitTimestamp=Tue 2026-11-24 04:05:00 UTC",
          "InactiveEnterTimestamp=Tue 2026-11-24 04:05:00 UTC"
        ].join("\n"),
        stderr: "",
        error: null
      };
    }
    return { status: 1, stdout: "", stderr: "", error: null };
  };
  const s1 = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    backupRoot: missingRoot,
    deployBackupRoot: missingRoot,
    runCommand: okRunner
  });
  assert.equal(s1.backup.source, "systemd-service");
  assert.equal(s1.backup.lastBackupAt, "2026-11-24T04:05:00.000Z");
  assert.equal(s1.backup.serviceResult, "success");

  // 2. Rebooted host (empty ExecMainExitTimestamp) -> falls back to bojin-backup.timer LastTriggerUSec
  const timerRunner = (cmd, args) => {
    if (cmd === "systemctl" && args.includes("bojin-backup.service")) {
      return {
        status: 0,
        stdout: "LoadState=loaded\nResult=success\nExecMainStatus=0\nExecMainExitTimestamp=\nInactiveEnterTimestamp=\n",
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
  const s2 = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    backupRoot: missingRoot,
    deployBackupRoot: missingRoot,
    runCommand: timerRunner
  });
  assert.equal(s2.backup.source, "systemd-timer");
  assert.equal(s2.backup.lastBackupAt, "2026-11-23T04:02:10.000Z");

  // 3. Failed backup run must NOT report timer LastTriggerUSec as a successful backup
  const failRunner = (cmd, args) => {
    if (cmd === "systemctl" && args.includes("bojin-backup.service")) {
      return {
        status: 0,
        stdout: [
          "LoadState=loaded",
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
  const s3 = collectDailySummary({
    dataDir: fx.dataDir,
    nowMs: fx.nowMs,
    noJournal: true,
    backupRoot: missingRoot,
    deployBackupRoot: missingRoot,
    runCommand: failRunner
  });
  assert.equal(s3.backup.lastBackupAt, null);
  assert.equal(s3.backup.serviceResult, "exit-code");
  assert.match(s3.backup.note, /failed/i);
});

test("journalctl permission denial degrades gracefully to db_only without crashing", (t) => {
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

  const summary = collectDailySummary({
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
  assert.equal(summary.clientErrors.journalStatus, "permission_denied");

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

test("CLI respects exclusive maintenance lock, releases reader lease, and supports plain text, --json, and stdin", (t) => {
  const fx = createFixture(t);
  const env = {
    ...process.env,
    DATA_DIR: fx.dataDir,
    AI_INPUT_PRICE_PER_1M: "1.0",
    AI_OUTPUT_PRICE_PER_1M: "4.0"
  };

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

  // Verify reader lease was cleaned up
  const readersDir = path.join(fx.dataDir, ".access", "readers");
  assert.deepEqual(fs.readdirSync(readersDir), []);

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
  // Custom pricing: 24h gemini (3000*1 + 1000*4)/1e6 = 0.007; openrouter (1500*1 + 500*4)/1e6 = 0.0035
  assert.equal(parsed.ai.last24h.byProvider.gemini.estimatedCostUsd, 0.007);
  assert.equal(parsed.ai.last24h.byProvider.openrouter.estimatedCostUsd, 0.0035);
  assert.equal(parsed.ai.last24h.estimatedCostUsd, 0.0105);

  // 3. Respects exclusive maintenance lock (fails closed)
  const releaseExclusive = dataAccess.exclusive(fx.dataDir);
  try {
    const lockedRes = spawnSync(
      process.execPath,
      [SCRIPT, "--no-journal", "--no-systemd"],
      { cwd: ROOT, env, encoding: "utf8", timeout: 10000 }
    );
    assert.equal(lockedRes.status, 1);
    assert.match(lockedRes.stderr, /maintenance in progress/i);
  } finally {
    releaseExclusive();
  }

  // 4. Invalid CLI flag exits non-zero; --help exits 0
  const helpRes = spawnSync(process.execPath, [SCRIPT, "--help"], {
    cwd: ROOT, env, encoding: "utf8", timeout: 10000
  });
  assert.equal(helpRes.status, 0);
  assert.match(helpRes.stdout, /Usage:/);

  const badRes = spawnSync(
    process.execPath,
    [SCRIPT, "--unknown-flag"],
    { cwd: ROOT, env, encoding: "utf8", timeout: 10000 }
  );
  assert.equal(badRes.status, 1);
  assert.match(badRes.stderr, /Usage:/);
});

test("handles legacy bojin.db without feedback table or auth.sqlite and ignores symlinks in blobs/", (t) => {
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

  const summary = collectDailySummary({
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
