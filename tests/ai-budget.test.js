"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const {
  DEFAULT_AI_PRICING,
  DEFAULT_MODEL_PRICING,
  DEFAULT_AI_BUDGETS,
  parsePricing,
  parseBudgets,
  resolveModelRate,
  splitOutputTokens,
  calcUsageCostUsd,
  usdToNanos,
  nanosToUsd,
  roundUsd,
  ensureAiBudgetSchema
} = require("../lib/ai-pricing");
const { createAIProxy } = require("../lib/ai");
const { createAccountData } = require("../lib/account-data");
const { createSnapshot, restoreSnapshot } = require("../lib/snapshots");
const { readLedger } = require("../lib/deletion-ledger");
const { collectDailySummary, formatSummaryText } = require("../lib/daily-summary");

const ROOT = path.resolve(__dirname, "..");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE ai_usage (uid TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(uid, day))");
  return db;
}

function makeOkRes(content, usage, finishReason = "stop") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content }, finish_reason: finishReason }],
      ...(usage ? { usage } : {})
    })
  };
}

test("shared ai-pricing defaults, per-model resolution, env overrides, thinking token reconciliation, and budget validation", () => {
  const def = parsePricing({});
  assert.equal(def.modelDefault, "gemini-3.8-flash");
  assert.deepEqual(resolveModelRate(def, "gemini", "gemini-3.8-flash"), {
    inputPer1M: 0.75, outputPer1M: 3.75, thinkingPer1M: 3.75
  });
  assert.deepEqual(resolveModelRate(def, "openrouter", "google/gemini-3.8-flash"), {
    inputPer1M: 0.75, outputPer1M: 3.75, thinkingPer1M: 3.75
  });
  assert.deepEqual(resolveModelRate(def, "openrouter", "google/gemini-2.5-flash"), {
    inputPer1M: 0.30, outputPer1M: 2.50, thinkingPer1M: 2.50
  });
  assert.deepEqual(resolveModelRate(def, "gemini", "gemini-2.5-flash"), {
    inputPer1M: 0.30, outputPer1M: 2.50, thinkingPer1M: 2.50
  });
  assert.equal(DEFAULT_AI_PRICING.inputPer1M, 0.75);
  assert.equal(DEFAULT_MODEL_PRICING["google/gemini-2.5-flash"].outputPer1M, 2.50);

  // Per-model JSON override takes highest precedence, including optional thinkingPer1M
  const custom = parsePricing({
    AI_MODEL_PRICES_JSON: JSON.stringify({
      "gemini-3.8-flash": { inputPer1M: 1.0, outputPer1M: 4.0, thinkingPer1M: 5.0 },
      "google/gemini-2.5-flash": { inputPer1M: 0.25, outputPer1M: 2.0 }
    })
  });
  const gRate = resolveModelRate(custom, "gemini", "gemini-3.8-flash");
  assert.deepEqual(gRate, { inputPer1M: 1.0, outputPer1M: 4.0, thinkingPer1M: 5.0 });
  assert.deepEqual(resolveModelRate(custom, "openrouter", "google/gemini-2.5-flash"), {
    inputPer1M: 0.25, outputPer1M: 2.0
  });

  // Standard completion_tokens includes reasoning_tokens (no double counting)
  assert.deepEqual(
    splitOutputTokens({ promptTokens: 1000, completionTokens: 600, reasoningTokens: 400, totalTokens: 1600 }),
    { visibleOutputTokens: 200, thinkingTokens: 400, billedOutputTokens: 600 }
  );
  // Distinct thinking rate bills visible at outputPer1M and thinking at thinkingPer1M
  const costDistinct = calcUsageCostUsd(
    { promptTokens: 1_000_000, completionTokens: 1_000_000, reasoningTokens: 600_000, totalTokens: 2_000_000 },
    gRate
  );
  // 1M * $1 + 0.4M * $4 + 0.6M * $5 = $1 + $1.6 + $3 = $5.6
  assert.equal(roundUsd(costDistinct), 5.6);

  // Separate reasoning_tokens (total_tokens >= prompt + completion + reasoning) counts both
  assert.deepEqual(
    splitOutputTokens({ promptTokens: 1000, completionTokens: 200, reasoningTokens: 500, totalTokens: 1700 }),
    { visibleOutputTokens: 200, thinkingTokens: 500, billedOutputTokens: 700 }
  );

  // Invalid pricing / budget env values rejected
  assert.throws(() => parsePricing({ AI_MODEL_PRICES_JSON: "not-json" }), /AI_MODEL_PRICES_JSON/);
  assert.throws(() => parsePricing({ AI_MODEL_PRICES_JSON: '{"m":{"inputPer1M":-1,"outputPer1M":1}}' }), /AI_MODEL_PRICES_JSON/);
  assert.deepEqual(parseBudgets({}).userMonthlyUsd, DEFAULT_AI_BUDGETS.userMonthlyUsd);
  assert.deepEqual(parseBudgets({}).globalMonthlyUsd, DEFAULT_AI_BUDGETS.globalMonthlyUsd);
  assert.equal(parseBudgets({ AI_USER_MONTHLY_USD: "0", AI_GLOBAL_MONTHLY_USD: "120.5" }).globalMonthlyUsd, 120.5);
  assert.throws(() => parseBudgets({ AI_USER_MONTHLY_USD: "-5" }), /AI_USER_MONTHLY_USD/);
  assert.throws(() => parseBudgets({ AI_GLOBAL_MONTHLY_USD: "nope" }), /AI_GLOBAL_MONTHLY_USD/);
});

test("per-user monthly cap refuses before calling model with zh/en messages, keeps daily caps, and resets on UTC month rollover", async () => {
  const db = makeDb();
  let clock = Date.parse("2026-11-30T23:59:30.000Z");
  let upstreamCalls = 0;
  // High test pricing: $1000/1M input, $1000/1M output -> 1000 tokens = $1.00
  const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
  const userLangs = { u_zh: "zh", u_en: "en" };
  const proxy = createAIProxy(db, {
    aiProvider: "gemini",
    geminiKey: "g-key",
    aiDaily: 10,
    aiGlobalDaily: 50,
    aiMaxTokens: 50, // conservative output reserve = $0.05 (+ tiny prompt reserve ~$0.07 -> ~$0.12)
    aiUserMonthlyUsd: 1.0,
    aiGlobalMonthlyUsd: 80.0,
    aiPricing: pricing,
    getUserLang: u => userLangs[u.id] || "zh",
    now: () => clock,
    log: () => {}
  }, async () => {
    upstreamCalls++;
    // First call costs 500 prompt + 350 completion (incl 200 reasoning) = 850 tokens = $0.85
    return makeOkRes("ok", {
      prompt_tokens: 500,
      completion_tokens: 350,
      completion_tokens_details: { reasoning_tokens: 200 }
    });
  });

  try {
    // Call 1 for u_zh succeeds and brings spend to $0.85 (85% -> nearCap = true, reached = false!)
    await proxy({ id: "u_zh" }, { messages: [{ content: "hi" }] });
    assert.equal(upstreamCalls, 1);
    const statusNear = proxy.getBudgetStatus("u_zh");
    assert.equal(statusNear.month, "2026-11");
    assert.equal(statusNear.usedPct, 85);
    assert.equal(statusNear.nearCap, true);
    assert.equal(statusNear.reached, false);

    // Call 2 for u_zh fits under $1.00 ($0.85 + ~$0.12 <= $1.00) and pushes actual spend to $1.70 -> reached!
    await proxy({ id: "u_zh" }, { messages: [{ content: "hi2" }] });
    assert.equal(upstreamCalls, 2);
    const statusReached = proxy.getBudgetStatus("u_zh");
    assert.equal(statusReached.reached, true);
    assert.equal(statusReached.nearCap, false);

    // Call 3 for u_zh is refused BEFORE calling model!
    await assert.rejects(
      proxy({ id: "u_zh" }, { messages: [{ content: "third" }] }),
      e => e.status === 429 && e.code === "ai_user_monthly_cap" && /手动/.test(e.message)
    );
    assert.equal(upstreamCalls, 2, "upstream must not be called after cap reached");
    // Daily ai_usage was NOT incremented by the refused call
    assert.equal(db.prepare("SELECT n FROM ai_usage WHERE uid = ?").get("u_zh").n, 2);

    // u_en gets an English refusal message mentioning manual logging
    await proxy({ id: "u_en" }, { messages: [{ content: "hello" }] });
    await proxy({ id: "u_en" }, { messages: [{ content: "hello2" }] });
    assert.equal(upstreamCalls, 4);
    await assert.rejects(
      proxy({ id: "u_en" }, { messages: [{ content: "third" }] }),
      e => e.status === 429 && e.code === "ai_user_monthly_cap" && /manually/i.test(e.message) && !/[\u3400-\u9fff]/.test(e.message)
    );
    assert.equal(upstreamCalls, 4);

    // Advance clock across UTC month rollover: 2026-12-01T00:00:00Z
    clock = Date.parse("2026-12-01T00:00:00.000Z");
    const statusDec = proxy.getBudgetStatus("u_zh");
    assert.equal(statusDec.month, "2026-12");
    assert.equal(statusDec.usedPct, 0);
    assert.equal(statusDec.nearCap, false);
    assert.equal(statusDec.reached, false);

    // Both users can call again in December!
    await proxy({ id: "u_zh" }, { messages: [{ content: "dec call" }] });
    assert.equal(upstreamCalls, 5);
    const novRow = db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?").get("u_zh", "2026-11");
    const decRow = db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?").get("u_zh", "2026-12");
    assert.equal(roundUsd(nanosToUsd(novRow.cost_nanos)), 1.7);
    assert.equal(roundUsd(nanosToUsd(decRow.cost_nanos)), 0.85);
  } finally {
    db.close();
  }
});

test("concurrency: two calls racing near the cap allow one via conservative reservation and refuse the second before calling upstream", async () => {
  const db = makeDb();
  let clock = Date.parse("2026-11-26T12:00:00.000Z");
  const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
  let upstreamCalls = 0;
  let releaseFirst;
  const firstEntered = new Promise(resolve => {
    // will resolve when first upstream call starts
    releaseFirst = resolve;
  });
  let finishFirst;
  const firstGate = new Promise(resolve => { finishFirst = resolve; });

  const proxy = createAIProxy(db, {
    aiProvider: "gemini",
    geminiKey: "g-key",
    aiDaily: 10,
    aiGlobalDaily: 50,
    aiMaxTokens: 500, // reserve ~$0.57 per call
    aiUserMonthlyUsd: 1.0, // enough for 1 reservation ($0.57), NOT 2 ($1.14)
    aiGlobalMonthlyUsd: 80.0,
    aiPricing: pricing,
    now: () => clock,
    log: () => {}
  }, async () => {
    upstreamCalls++;
    if (upstreamCalls === 1) {
      releaseFirst();
      await firstGate;
    }
    // Actual usage is tiny: 100 tokens = $0.10
    return makeOkRes("ok", { prompt_tokens: 50, completion_tokens: 50 });
  });

  try {
    const p1 = proxy({ id: "u_race" }, { messages: [{ content: "first" }] });
    await firstEntered;

    // While p1 is in-flight, 1 reservation row exists
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_budget_reservations WHERE uid = ?").get("u_race").n, 1);

    // Concurrent second call must be refused immediately BEFORE hitting upstream
    await assert.rejects(
      proxy({ id: "u_race" }, { messages: [{ content: "second" }] }),
      e => e.status === 429 && e.code === "ai_user_monthly_cap"
    );
    assert.equal(upstreamCalls, 1, "racing call must be refused before upstream");

    // Let first call finish -> reservation released and settled at actual $0.10
    finishFirst();
    await p1;
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_budget_reservations WHERE uid = ?").get("u_race").n, 0);
    const spent = db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?").get("u_race", "2026-11").cost_nanos;
    assert.equal(roundUsd(nanosToUsd(spent)), 0.1);

    // Now that actual spend is only $0.10, a subsequent call ($0.10 + ~$0.57 <= $1.00) succeeds!
    await proxy({ id: "u_race" }, { messages: [{ content: "third" }] });
    assert.equal(upstreamCalls, 2);

    // Stale reservation left by a simulated crash is pruned once expired
    db.prepare("INSERT INTO ai_budget_reservations (id, uid, month, reserved_nanos, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run("stale_1", "u_race", "2026-11", usdToNanos(0.95), clock - 1);
    await proxy({ id: "u_race" }, { messages: [{ content: "after-stale" }] });
    assert.equal(upstreamCalls, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_budget_reservations WHERE id = ?").get("stale_1").n, 0);
  } finally {
    db.close();
  }
});

test("retries and OpenRouter fallback costs are summed using each attempt's model rate including thinking tokens", async () => {
  const db = makeDb();
  let clock = Date.parse("2026-11-26T15:00:00.000Z");
  let callNum = 0;
  const logs = [];
  const proxy = createAIProxy(db, {
    aiProvider: "gemini",
    geminiKey: "g-key",
    geminiModel: "gemini-3.8-flash", // $0.75 / 1M in, $3.75 / 1M out
    orKey: "or-key",
    orModel: "google/gemini-2.5-flash", // $0.30 / 1M in, $2.50 / 1M out
    aiDaily: 10,
    aiGlobalDaily: 50,
    aiMaxTokens: 2000,
    aiUserMonthlyUsd: 5.0,
    aiGlobalMonthlyUsd: 80.0,
    geminiRetryDelays: [0], // 1 retry then fallback
    now: () => clock,
    sleep: async () => {},
    log: l => logs.push(l)
  }, async url => {
    callNum++;
    if (callNum === 1) {
      assert.match(url, /generativelanguage\.googleapis\.com/);
      // Gemini attempt 1 fails with 503 after consuming tokens
      // Cost: 100,000 * 0.75/1M + 20,000 * 3.75/1M = $0.075 + $0.075 = $0.15
      return {
        ok: false,
        status: 503,
        json: async () => ({
          error: { code: 503, status: "UNAVAILABLE", message: "overloaded" },
          usage: { prompt_tokens: 100_000, completion_tokens: 20_000, completion_tokens_details: { reasoning_tokens: 15_000 } }
        })
      };
    }
    if (callNum === 2) {
      assert.match(url, /generativelanguage\.googleapis\.com/);
      // Gemini retry fails with 503 and 0 usage
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: { code: 503, status: "UNAVAILABLE", message: "still down" } })
      };
    }
    assert.match(url, /openrouter\.ai/);
    // OpenRouter fallback succeeds with google/gemini-2.5-flash:
    // Cost: 200,000 * 0.30/1M + 40,000 * 2.50/1M = $0.06 + $0.10 = $0.16
    return makeOkRes("{\"ok\":true}", {
      prompt_tokens: 200_000,
      completion_tokens: 40_000,
      completion_tokens_details: { reasoning_tokens: 10_000 }
    });
  });

  try {
    const res = await proxy({ id: "u_fb" }, { messages: [{ content: "fallback test" }], json: true });
    assert.deepEqual(res, { text: "{\"ok\":true}", truncated: false });
    assert.equal(callNum, 3);

    const row = db.prepare("SELECT * FROM ai_monthly_usage WHERE uid = ? AND month = ?").get("u_fb", "2026-11");
    assert.equal(row.calls, 1);
    assert.equal(row.prompt_tokens, 300_000);
    assert.equal(row.completion_tokens, 60_000);
    assert.equal(row.reasoning_tokens, 25_000);
    // Total: $0.15 (Gemini attempt 1) + $0.16 (OpenRouter fallback) = $0.31
    assert.equal(roundUsd(nanosToUsd(row.cost_nanos)), 0.31);
    assert.match(logs[0], /\bcost_usd=0\.310000\b/);

    const globalRow = db.prepare("SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?").get("2026-11");
    assert.equal(roundUsd(nanosToUsd(globalRow.cost_nanos)), 0.31);
  } finally {
    db.close();
  }
});

test("whole-app monthly budget guard alerts once at 80%, pauses AI for everyone and alerts once at 100% (no spam), and resets next month", async () => {
  const db = makeDb();
  let clock = Date.parse("2026-11-26T10:00:00.000Z");
  const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
  const alerts = [];
  let upstreamCalls = 0;

  // Global cap $10, per-user cap $10, maxTokens 100 (reserve ~$0.17)
  // Each call costs $3.00 (1500 in + 1500 out)
  const proxy = createAIProxy(db, {
    aiProvider: "gemini",
    geminiKey: "g-key",
    aiDaily: 50,
    aiGlobalDaily: 50,
    aiMaxTokens: 100,
    aiUserMonthlyUsd: 20.0,
    aiGlobalMonthlyUsd: 10.0,
    aiPricing: pricing,
    alertUrl: "https://ntfy.example.com/lean-ritual-test-topic",
    alertFetcher: async (url, init) => {
      alerts.push({ url, headers: init.headers, body: init.body, redirect: init.redirect });
      return { status: 200, ok: true };
    },
    alertLog: () => {},
    now: () => clock,
    log: () => {}
  }, async () => {
    upstreamCalls++;
    return makeOkRes("ok", { prompt_tokens: 1500, completion_tokens: 1500 });
  });

  try {
    // Call 1 ($3 / $10 = 30%) -> 0 alerts
    await proxy({ id: "u_a" }, { messages: [{ content: "1" }] });
    assert.equal(alerts.length, 0);
    // Call 2 ($6 / $10 = 60%) -> 0 alerts
    await proxy({ id: "u_a" }, { messages: [{ content: "2" }] });
    assert.equal(alerts.length, 0);

    // Call 3 ($9 / $10 = 90% >= 80%) -> fires EXACTLY ONE 80% alert!
    await proxy({ id: "u_b" }, { messages: [{ content: "3" }] });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].url, "https://ntfy.example.com/lean-ritual-test-topic");
    assert.equal(alerts[0].redirect, "manual");
    assert.match(alerts[0].headers.Title, /80%/);
    assert.match(alerts[0].body, /80%.*2026-11/);
    assert.ok(!alerts[0].body.includes("u_a") && !alerts[0].body.includes("u_b"), "alert must contain zero user IDs");

    // Call 4 brings spend from $9 -> $12 (>= $10 = 100%) -> fires EXACTLY ONE 100% pause alert (NO repeat 80% alert!)
    await proxy({ id: "u_b" }, { messages: [{ content: "4" }] });
    assert.equal(alerts.length, 2);
    assert.match(alerts[1].headers.Title, /100%/);
    assert.match(alerts[1].body, /paused.*2026-11/i);
    assert.equal(upstreamCalls, 4);

    // Now even a brand-new user u_fresh with $0 spent is paused globally!
    for (const uid of ["u_a", "u_b", "u_fresh"]) {
      assert.equal(proxy.getBudgetStatus(uid).globalPaused, true);
      await assert.rejects(
        proxy({ id: uid }, { messages: [{ content: "blocked" }], lang: uid === "u_fresh" ? "en" : "zh" }),
        e => e.status === 503 && e.code === "ai_global_monthly_cap" && (uid === "u_fresh" ? /manually/i.test(e.message) : /手动/.test(e.message))
      );
    }
    assert.equal(upstreamCalls, 4, "no upstream calls while paused");
    assert.equal(alerts.length, 2, "no alert spam on subsequent blocked calls");

    // Next UTC month: automatically unpauses and alerts reset cleanly
    clock = Date.parse("2026-12-01T00:00:00.000Z");
    assert.equal(proxy.getBudgetStatus("u_fresh").globalPaused, false);
    await proxy({ id: "u_fresh" }, { messages: [{ content: "dec 1" }] });
    assert.equal(upstreamCalls, 5);
    assert.equal(alerts.length, 2);
  } finally {
    db.close();
  }
});

test("admin CLI ai-cap (email/phone raise, lower, reset, inspect) and ai-usage (top users with anonymized IDs + host identity)", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-ai-admin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = {
    ...process.env,
    DATA_DIR: dir,
    AUTH_SECRET: "admin-cli-test-secret-at-least-32-chars",
    AI_USER_MONTHLY_USD: "5",
    AI_GLOBAL_MONTHLY_USD: "80"
  };

  // Seed auth.sqlite with an email user and a phone user
  const authDb = new DatabaseSync(path.join(dir, "auth.sqlite"));
  authDb.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL,
      phoneNumber TEXT,
      phoneNumberVerified INTEGER
    );
  `);
  authDb.prepare("INSERT INTO user VALUES (?, ?, ?, 1, NULL, NULL)")
    .run("u_email_1", "Alice", "alice@example.com");
  authDb.prepare("INSERT INTO user VALUES (?, ?, ?, 0, ?, 1)")
    .run("u_phone_1", "Bob", "phone-u_phone_1@phone.leanritual.invalid", "+8613800138000");
  authDb.close();

  // Seed bojin.db with monthly usage
  const bojinDb = new DatabaseSync(path.join(dir, "bojin.db"));
  ensureAiBudgetSchema(bojinDb);
  const month = "2026-11";
  bojinDb.prepare(
    "INSERT INTO ai_monthly_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("u_email_1", month, 12, 100_000, 40_000, 10_000, usdToNanos(4.5), "2026-11-26T00:00:00.000Z");
  bojinDb.prepare(
    "INSERT INTO ai_monthly_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("u_phone_1", month, 5, 30_000, 10_000, 0, usdToNanos(1.25), "2026-11-26T00:00:00.000Z");
  bojinDb.prepare(
    "INSERT INTO ai_global_monthly_usage VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(month, 17, 130_000, 50_000, 10_000, usdToNanos(5.75), "2026-11-26T00:00:00.000Z");
  bojinDb.close();

  const runCli = args => spawnSync(process.execPath, [path.join(ROOT, "scripts/auth-admin.js"), ...args], {
    env, encoding: "utf8", timeout: 5000
  });

  // 1. Raise email user's cap to $15
  const raiseRes = runCli(["ai-cap", "--email", "ALICE@example.com", "--usd", "15", "--month", month, "--json"]);
  assert.equal(raiseRes.status, 0, raiseRes.stderr);
  const raised = JSON.parse(raiseRes.stdout);
  assert.equal(raised.email, "alice@example.com");
  assert.equal(raised.capUsd, 15);
  assert.equal(raised.capSource, "override");
  assert.equal(raised.spentUsd, 4.5);
  assert.match(raised.anonId, /^u_[0-9a-f]{8}$/);

  // 2. Lower phone user's cap to $1.00 using mainland 11-digit number
  const lowerRes = runCli(["ai-cap", "--phone", "13800138000", "--usd", "1.0", "--month", month]);
  assert.equal(lowerRes.status, 0, lowerRes.stderr);
  assert.match(lowerRes.stdout, /\+8613800138000/);
  assert.match(lowerRes.stdout, /\$1\.00 \[override\]/);
  assert.ok(!lowerRes.stdout.includes("phone.leanritual.invalid"), "synthetic phone email must not be shown");

  // 3. Verify runtime proxy enforces admin override immediately!
  const liveDb = new DatabaseSync(path.join(dir, "bojin.db"));
  const proxy = createAIProxy(liveDb, {
    aiProvider: "gemini",
    geminiKey: "g-key",
    aiDaily: 60,
    aiGlobalDaily: 300,
    aiMaxTokens: 100,
    aiUserMonthlyUsd: 5.0,
    aiGlobalMonthlyUsd: 80.0,
    now: () => Date.parse("2026-11-26T12:00:00.000Z"),
    log: () => {}
  }, async () => makeOkRes("ok", { prompt_tokens: 100, completion_tokens: 50 }));
  try {
    // u_phone_1 spent $1.25 and cap was lowered to $1.00 -> blocked!
    assert.equal(proxy.getBudgetStatus("u_phone_1").reached, true);
    // u_email_1 spent $4.50 and cap was raised to $15 -> not near cap, not reached!
    const emailStatus = proxy.getBudgetStatus("u_email_1");
    assert.equal(emailStatus.reached, false);
    assert.equal(emailStatus.nearCap, false);
    assert.equal(emailStatus.usedPct, 30);
  } finally {
    liveDb.close();
  }

  // 4. ai-usage lists top users sorted by spend with anonymized IDs + host identity
  const usageJsonRes = runCli(["ai-usage", "--month", month, "--json"]);
  assert.equal(usageJsonRes.status, 0, usageJsonRes.stderr);
  const usage = JSON.parse(usageJsonRes.stdout);
  assert.equal(usage.month, month);
  assert.equal(usage.global.spentUsd, 5.75);
  assert.equal(usage.global.budgetUsd, 80);
  assert.equal(usage.users.length, 2);
  assert.equal(usage.users[0].email, "alice@example.com");
  assert.equal(usage.users[0].spentUsd, 4.5);
  assert.equal(usage.users[0].capUsd, 15);
  assert.equal(usage.users[0].capSource, "override");
  assert.equal(usage.users[1].phone, "+8613800138000");
  assert.equal(usage.users[1].email, null);
  assert.equal(usage.users[1].spentUsd, 1.25);
  assert.equal(usage.users[1].capUsd, 1);

  const usageTextRes = runCli(["ai-usage", "--month", month]);
  assert.equal(usageTextRes.status, 0, usageTextRes.stderr);
  assert.match(usageTextRes.stdout, /App Total: \$5\.7500 \/ \$80\.00/);
  assert.match(usageTextRes.stdout, /alice@example\.com/);
  assert.match(usageTextRes.stdout, /\+8613800138000/);
  assert.ok(!usageTextRes.stdout.includes("u_email_1"), "raw DB user ID should not appear in text output");

  // 5. Reset email user's cap back to default $5
  const resetRes = runCli(["ai-cap", "--email", "alice@example.com", "--reset", "--month", month, "--json"]);
  assert.equal(resetRes.status, 0, resetRes.stderr);
  const reset = JSON.parse(resetRes.stdout);
  assert.equal(reset.capUsd, 5);
  assert.equal(reset.capSource, "default");
});

test("daily-summary reports month-to-date spend vs $80 budget and anonymized top user spend with zero PII", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-mtd-summary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const snapDir = path.join(root, "backups", "snapshot-20261126T040000Z");
  fs.mkdirSync(path.join(dataDir, "blobs"), { recursive: true });
  fs.mkdirSync(snapDir, { recursive: true });

  const bojinPath = path.join(snapDir, "bojin.db");
  const bojinDb = new DatabaseSync(bojinPath);
  bojinDb.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE docs (path TEXT PRIMARY KEY, uid TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
  `);
  ensureAiBudgetSchema(bojinDb);
  bojinDb.prepare("INSERT INTO ai_monthly_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("u_secret_top_user", "2026-11", 25, 200_000, 80_000, 15_000, usdToNanos(4.25), "2026-11-26T03:00:00.000Z");
  bojinDb.prepare("INSERT INTO ai_monthly_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("u_secret_other", "2026-11", 10, 50_000, 20_000, 0, usdToNanos(1.10), "2026-11-26T02:00:00.000Z");
  bojinDb.prepare("INSERT INTO ai_user_caps VALUES (?, ?, ?)")
    .run("u_secret_top_user", usdToNanos(10), "2026-11-25T00:00:00.000Z");
  bojinDb.prepare("INSERT INTO ai_global_monthly_usage VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("2026-11", 35, 250_000, 100_000, 15_000, usdToNanos(18.5), "2026-11-26T03:00:00.000Z");
  bojinDb.close();

  const sha = crypto.createHash("sha256").update(fs.readFileSync(bojinPath)).digest("hex");
  fs.writeFileSync(path.join(snapDir, "manifest.json"), JSON.stringify({
    version: 1,
    created: "2026-11-26T04:00:00.000Z",
    files: [{ name: "bojin.db", size: fs.statSync(bojinPath).size, sha256: sha }]
  }));

  const summary = collectDailySummary({
    dataDir,
    nowMs: Date.parse("2026-11-26T10:00:00.000Z"),
    backupRoot: path.join(root, "backups"),
    deployBackupRoot: path.join(root, "deploy-backups"),
    noJournal: true,
    noSystemd: true,
    env: { AI_GLOBAL_MONTHLY_USD: "80", AI_USER_MONTHLY_USD: "5" }
  });

  assert.equal(summary.ai.monthToDate.month, "2026-11");
  assert.equal(summary.ai.monthToDate.source, "snapshot_db");
  assert.equal(summary.ai.monthToDate.budgetUsd, 80);
  assert.equal(summary.ai.monthToDate.estimatedCostUsd, 18.5);
  assert.equal(summary.ai.monthToDate.budgetUsedPct, 23.1);
  assert.equal(summary.ai.monthToDate.calls, 35);
  assert.ok(summary.ai.monthToDate.topUser);
  assert.match(summary.ai.monthToDate.topUser.user, /^u_[0-9a-f]{8}$/);
  assert.equal(summary.ai.monthToDate.topUser.estimatedCostUsd, 4.25);
  assert.equal(summary.ai.monthToDate.topUser.capUsd, 10);
  assert.equal(summary.ai.monthToDate.topUser.calls, 25);

  const text = formatSummaryText(summary);
  assert.match(text, /本月累计 \(2026-11 UTC\): \$18\.5000 \/ \$80\.00 \(23\.1%/);
  assert.match(text, /本月最高单用户: u_[0-9a-f]{8} \$4\.2500 \/ \$10\.00 \(25 次\)/);
  assert.ok(!text.includes("u_secret_top_user") && !JSON.stringify(summary).includes("u_secret_top_user"));
});

test("migration is idempotent on pre-existing live DB; export includes AI usage; account deletion & restore replay remove per-user AI records while preserving global spend", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-ai-data-"));
  const dir = path.join(root, "data");
  fs.mkdirSync(path.join(dir, "blobs"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 1. Pre-existing live bojin.db without monthly budget tables
  const dbPath = path.join(dir, "bojin.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, created TEXT NOT NULL, mustChange INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, uid TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE docs (path TEXT PRIMARY KEY, uid TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
    CREATE TABLE ai_usage (uid TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(uid, day));
  `);
  db.prepare("INSERT INTO ai_usage VALUES (?, ?, ?)").run("u_one", "2026-11-25", 3);
  db.prepare("INSERT INTO ai_usage VALUES (?, ?, ?)").run("u_two", "2026-11-25", 2);

  // 2. Run migration via createAIProxy twice -> idempotent and preserves existing rows
  const cfg = {
    aiProvider: "gemini",
    geminiKey: "g-key",
    aiDaily: 60,
    aiGlobalDaily: 300,
    aiMaxTokens: 1000,
    now: () => Date.parse("2026-11-26T10:00:00.000Z"),
    log: () => {}
  };
  createAIProxy(db, cfg, async () => makeOkRes("ok", { prompt_tokens: 1000, completion_tokens: 500 }));
  const proxy = createAIProxy(db, cfg, async () => makeOkRes("ok", { prompt_tokens: 1000, completion_tokens: 500 }));
  assert.equal(db.prepare("SELECT n FROM ai_usage WHERE uid = ? AND day = ?").get("u_one", "2026-11-25").n, 3);

  await proxy({ id: "u_one" }, { messages: [{ content: "one" }] });
  await proxy({ id: "u_two" }, { messages: [{ content: "two" }] });
  db.prepare("INSERT INTO ai_user_caps VALUES (?, ?, ?)").run("u_one", usdToNanos(12), "2026-11-26T10:00:00.000Z");

  const accountData = createAccountData(db, dir);

  // 3. Export includes u_one's ai_usage, ai_monthly_usage, and ai_cap, isolated from u_two
  const chunksA = [];
  for await (const c of accountData.exportChunks({ id: "u_one" })) chunksA.push(c);
  const recsA = chunksA.join("").trim().split("\n").map(JSON.parse);
  assert.equal(recsA.filter(r => r.kind === "ai_usage").length, 2); // 2026-11-25 + 2026-11-26
  const monthlyA = recsA.find(r => r.kind === "ai_monthly_usage");
  assert.ok(monthlyA);
  assert.equal(monthlyA.month, "2026-11");
  assert.equal(monthlyA.calls, 1);
  assert.equal(monthlyA.promptTokens, 1000);
  assert.equal(monthlyA.completionTokens, 500);
  assert.equal(recsA.find(r => r.kind === "ai_cap")?.monthlyUsd, 12);

  const chunksB = [];
  for await (const c of accountData.exportChunks({ id: "u_two" })) chunksB.push(c);
  const recsB = chunksB.join("").trim().split("\n").map(JSON.parse);
  assert.equal(recsB.find(r => r.kind === "ai_cap"), undefined);

  // 4. Snapshot before deletion so we can test deletion-ledger replay
  const snapDir = path.join(root, "snap-before");
  await createSnapshot(dir, snapDir);

  const globalBefore = db.prepare("SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?").get("2026-11").cost_nanos;
  assert.ok(globalBefore > 0);

  // 5. Delete u_one -> per-user AI records removed, u_two untouched, global spend preserved!
  accountData.requestDeletion({ id: "u_one" });
  accountData.completeDeletion("u_one");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE uid = ?").get("u_one").n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_monthly_usage WHERE uid = ?").get("u_one").n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_user_caps WHERE uid = ?").get("u_one").n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_budget_reservations WHERE uid = ?").get("u_one").n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_monthly_usage WHERE uid = ?").get("u_two").n, 1);
  assert.equal(db.prepare("SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?").get("2026-11").cost_nanos, globalBefore);
  db.close();

  // 6. Restoring snapshot with deletion ledger also deletes u_one's per-user AI records
  const ledger = readLedger(dir);
  const restoredDir = path.join(root, "restored");
  restoreSnapshot(snapDir, restoredDir, ledger);
  const restoredDb = new DatabaseSync(path.join(restoredDir, "bojin.db"));
  try {
    assert.equal(restoredDb.prepare("SELECT COUNT(*) AS n FROM ai_monthly_usage WHERE uid = ?").get("u_one").n, 0);
    assert.equal(restoredDb.prepare("SELECT COUNT(*) AS n FROM ai_user_caps WHERE uid = ?").get("u_one").n, 0);
    assert.equal(restoredDb.prepare("SELECT COUNT(*) AS n FROM ai_monthly_usage WHERE uid = ?").get("u_two").n, 1);
  } finally {
    restoredDb.close();
  }
});

test("frontend renders gentle 80% notice and cap/pause notices in all AI areas in zh and en, and shim syncs X-Bojin-AI-Budget header", async () => {
  const htmlSrc = fs.readFileSync(path.join(ROOT, "app/index.html"), "utf8");
  const shimSrc = fs.readFileSync(path.join(ROOT, "public/shim.js"), "utf8");
  const appScript = htmlSrc.match(/<script>([\s\S]*?)<\/script>/)[1].split("/* ============ 启动 ============ */")[0];

  const runUiCheck = (lang) => {
    const ctx = vm.createContext({
      window: { ritual: { hosted: true }, location: { hostname: "leanritual.app", search: "" } },
      location: { hostname: "leanritual.app", search: "" },
      document: { documentElement: { lang: lang === "en" ? "en" : "zh-CN" }, addEventListener() {}, querySelector() { return { innerHTML: "" }; } },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      console, URL, URLSearchParams, Date, setTimeout, clearTimeout, Math, JSON, Set, Map, Array, Object, Number, String, Boolean, RegExp
    });
    vm.runInContext(appScript, ctx);
    vm.runInContext(`
      S.explicitLang = ${JSON.stringify(lang)};
      S.sample = { json: async () => ({}) };
      S.profile = { sex:"m", age:28, height:175, weight:70, steps:8000, exp:"mid", equipment:"gym", trainDays:[1,3,5], slot:"pm", injuries:[], supps:[], startDate:"2026-11-01" };
      S.days = {};
      S.feedback = [];
      S.mealMode = "ai";
      S.date = "2026-11-26";
      S.ed = { date:"2026-11-26", i:0, orig:"平板哑铃卧推", name:"平板哑铃卧推", sets:3, lo:6, hi:10, why:"", ai:[], scope:"once", rec:false };
    `, ctx);

    // Below 80%: no notice
    vm.runInContext(`S.aiBudget = { month:"2026-11", usedPct:50, nearCap:false, reached:false, globalPaused:false };`, ctx);
    assert.equal(vm.runInContext(`aiBudgetNotice()`, ctx), "");

    // Near 80%: gentle notice appears in Food, Feedback, and Exercise Editor
    vm.runInContext(`S.aiBudget = { month:"2026-11", usedPct:84, nearCap:true, reached:false, globalPaused:false };`, ctx);
    const foodHtml = vm.runInContext(`viewFood()`, ctx);
    const fbHtml = vm.runInContext(`viewFeedback()`, ctx);
    const edHtml = vm.runInContext(`editor({ orig:"平板哑铃卧推" })`, ctx);
    for (const html of [foodHtml, fbHtml, edHtml]) {
      assert.match(html, /ai-budget-notice/);
      assert.match(html, /84%/);
      if (lang === "en") {
        assert.match(html, /manually/i);
        assert.doesNotMatch(html.match(/ai-budget-notice[^>]*>([^<]+)</)[1], /[\u3400-\u9fff]/);
      } else {
        assert.match(html, /手动/);
      }
    }

    // Error messages in sampleErr for both monthly user cap and global pause
    const userErr = vm.runInContext(`sampleErr({ code: "ai_user_monthly_cap" })`, ctx);
    const globalErr = vm.runInContext(`sampleErr({ code: "ai_global_monthly_cap" })`, ctx);
    if (lang === "en") {
      assert.match(userErr, /manually/i);
      assert.match(globalErr, /paused.*manually/i);
      assert.doesNotMatch(userErr, /[\u3400-\u9fff]/);
      assert.doesNotMatch(globalErr, /[\u3400-\u9fff]/);
    } else {
      assert.match(userErr, /手动/);
      assert.match(globalErr, /暂停.*手动/);
    }
  };
  runUiCheck("zh");
  runUiCheck("en");

  // Verify shim.js propagates X-Bojin-AI-Budget header updates to listeners
  const observed = [];
  const shimCtx = vm.createContext({
    window: {},
    location: {},
    URLSearchParams,
    fetch: async (url) => {
      if (url === "/api/me") {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ id: "alice", ai: true, aiBudget: { month: "2026-11", usedPct: 40, nearCap: false, reached: false, globalPaused: false } })
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "X-Bojin-AI-Budget": JSON.stringify({ month: "2026-11", usedPct: 86, nearCap: true, reached: false, globalPaused: false }) }),
        json: async () => ({ text: '{"ok":true}', truncated: false })
      };
    }
  });
  vm.runInContext(shimSrc, shimCtx);
  const sample = await shimCtx.window.ritual.use("sample");
  assert.equal(shimCtx.window.ritual.getAiBudget().usedPct, 40);
  shimCtx.window.ritual.onAiBudget(b => observed.push(b));
  await sample.json("test");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].nearCap, true);
  assert.equal(observed[0].usedPct, 86);
});

test("HTTP end-to-end: /api/me aiBudget, /api/ai X-Bojin-AI-Budget header, per-user cap refusal, and global pause + ALERT_URL", { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-ai-budget-http-"));
  const alertsSeen = [];
  let aiHits = 0;

  const mockServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/alert") {
      alertsSeen.push({ title: req.headers.title, tags: req.headers.tags, body: bodyText });
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url === "/gemini/chat/completions") {
      aiHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
        // At $1000/1M in+out -> 450 in + 450 out = $0.90 per call
        usage: { prompt_tokens: 450, completion_tokens: 450, completion_tokens_details: { reasoning_tokens: 100 } }
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => mockServer.listen(0, "127.0.0.1", r));
  const mockPort = mockServer.address().port;

  const preloadPath = path.join(dir, "preload.cjs");
  fs.writeFileSync(preloadPath, `
    "use strict";
    const origFetch = globalThis.fetch;
    const routes = {
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions": "http://127.0.0.1:${mockPort}/gemini/chat/completions",
      "https://ntfy.example.com/budget-topic": "http://127.0.0.1:${mockPort}/alert"
    };
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input?.url;
      if (url && Object.hasOwn(routes, url)) return origFetch(routes[url], init);
      return origFetch(input, init);
    };
  `);

  const port = 18097;
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    DATA_DIR: dir,
    PORT: String(port),
    HOST: "127.0.0.1",
    AUTH_BASE_URL: base,
    AUTH_SECRET: "budget-e2e-test-secret-at-least-32-chars",
    COOKIE_SECURE: "0",
    TRUST_PROXY: "0",
    MAIL_MODE: "file",
    AI_PROVIDER: "gemini",
    GEMINI_API_KEY: "test-gemini-key",
    OPENROUTER_API_KEY: "",
    AI_MAX_OUTPUT_TOKENS: "50",
    AI_INPUT_PRICE_PER_1M: "1000",
    AI_OUTPUT_PRICE_PER_1M: "1000",
    AI_USER_MONTHLY_USD: "1.0",
    AI_GLOBAL_MONTHLY_USD: "1.5",
    ALERT_URL: "https://ntfy.example.com/budget-topic"
  };

  const issue = email => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/auth-admin.js"), "invite", email], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const invA = issue("budget-a@example.com");
  const invB = issue("budget-b@example.com");

  const child = spawn(process.execPath, ["--require", preloadPath, "server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => stdout += d);
  child.stderr.on("data", d => stderr += d);
  t.after(async () => {
    if (child.exitCode === null) {
      const stopped = new Promise(r => child.once("exit", r));
      child.kill();
      await stopped;
    }
    await new Promise(r => mockServer.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("startup timeout " + stderr)), 8000);
    const check = () => { if (stdout.includes("薄肌日课已启动")) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", check);
    child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
  });

  const req = (route, payload, cookie, method) => fetch(base + route, {
    method: method || (payload ? "POST" : "GET"),
    redirect: "manual",
    headers: { origin: base, "Content-Type": "application/json", "X-Bojin": "1", ...(cookie ? { cookie } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });

  const registerAndLogin = async inv => {
    const pw = "strong-budget-password-123";
    assert.equal((await req("/api/auth/sign-up/email", {
      email: inv.email, name: "Tester", password: pw, invitation: inv.token, callbackURL: "/login.html",
      consentTerms: true, consentSensitiveCrossBorder: true, agreedConsentVersion: "2026-11-25"
    })).status, 200);
    const mail = fs.readdirSync(path.join(dir, "mail")).map(f => JSON.parse(fs.readFileSync(path.join(dir, "mail", f), "utf8"))).find(m => m.to === inv.email && m.kind === "verify");
    assert.equal((await fetch(mail.url, { redirect: "manual" })).status, 302);
    const login = await req("/api/auth/sign-in/email", { email: inv.email, password: pw });
    assert.equal(login.status, 200);
    return login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  };

  const cookieA = await registerAndLogin(invA);
  const cookieB = await registerAndLogin(invB);

  // Set user B's profile lang to "en"
  assert.equal((await req(`/api/doc?path=data/users/${invB.userId}/app/app/profile`, { data: { lang: "en" } }, cookieB, "PUT")).status, 200);

  // /api/me includes aiBudget
  const meA0 = await (await req("/api/me", null, cookieA)).json();
  assert.equal(meA0.aiBudget.usedPct, 0);
  assert.equal(meA0.aiBudget.nearCap, false);

  // Call 1 by User A ($0.90 / $1.00 user cap; $0.90 / $1.50 = 60% global)
  const r1 = await req("/api/ai", { messages: [{ content: "meal 1" }], json: true }, cookieA);
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { text: "{\"ok\":true}", truncated: false });
  const hdr1 = JSON.parse(r1.headers.get("x-bojin-ai-budget"));
  assert.equal(hdr1.usedPct, 90);
  assert.equal(hdr1.reached, true); // $0.90 + min reserve > $1.00

  // Call 2 by User A refused with 429 ai_user_monthly_cap (zh message)
  const r2 = await req("/api/ai", { messages: [{ content: "meal 2" }] }, cookieA);
  assert.equal(r2.status, 429);
  const j2 = await r2.json();
  assert.equal(j2.error, "ai_user_monthly_cap");
  assert.match(j2.message, /手动/);
  assert.equal(aiHits, 1);

  // Call 3 by User B ($0.90 -> global total $1.80 >= $1.50 -> triggers 100% global pause alert!)
  const r3 = await req("/api/ai", { messages: [{ content: "meal 3" }] }, cookieB);
  assert.equal(r3.status, 200);
  assert.equal(aiHits, 2);
  assert.equal(alertsSeen.length, 1);
  assert.match(alertsSeen[0].title, /100%/);

  // Call 4 by User B refused with 503 ai_global_monthly_cap (en message from profile!) and NO second alert!
  const r4 = await req("/api/ai", { messages: [{ content: "meal 4" }] }, cookieB);
  assert.equal(r4.status, 503);
  const j4 = await r4.json();
  assert.equal(j4.error, "ai_global_monthly_cap");
  assert.match(j4.message, /paused.*manually/i);
  assert.equal(aiHits, 2);
  assert.equal(alertsSeen.length, 1);
});
