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
  GEMINI_38_STANDARD_EFFECTIVE_MS,
  parsePricing,
  parseBudgets,
  resolveModelRate,
  resolveRouteBillingCeiling,
  splitOutputTokens,
  estimateOutputUpperBoundTokens,
  calcUsageCostUsd,
  usdToNanos,
  nanosToUsd,
  roundUsd,
  ensureAiBudgetSchema
} = require("../lib/ai-pricing");
const { createAIProxy, DEFAULT_OR_MODEL } = require("../lib/ai");
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

test("shared ai-pricing defaults, Jan 1 2027 standard rate transition, env overrides, thinking reconciliation, and default OpenRouter model", () => {
  assert.equal(DEFAULT_OR_MODEL, "google/gemini-3.8-flash");
  const def = parsePricing({});
  assert.equal(def.modelDefault, "gemini-3.8-flash");

  const nov2026 = Date.UTC(2026, 10, 26, 12, 0, 0);
  const dec31 = Date.UTC(2026, 11, 31, 23, 59, 59);
  const jan1_2027 = GEMINI_38_STANDARD_EFFECTIVE_MS;

  // Introductory rates through 2026-12-31 UTC
  assert.deepEqual(resolveModelRate(def, "gemini", "gemini-3.8-flash", nov2026), {
    inputPer1M: 0.75, outputPer1M: 3.75, thinkingPer1M: 3.75
  });
  assert.deepEqual(resolveModelRate(def, "openrouter", "google/gemini-3.8-flash", dec31), {
    inputPer1M: 0.75, outputPer1M: 3.75, thinkingPer1M: 3.75
  });
  // Standard undiscounted rates ($1.50/$7.50) starting 2027-01-01 UTC
  assert.deepEqual(resolveModelRate(def, "gemini", "gemini-3.8-flash", jan1_2027), {
    inputPer1M: 1.50, outputPer1M: 7.50, thinkingPer1M: 7.50
  });
  assert.deepEqual(resolveModelRate(def, "openrouter", "google/gemini-3.8-flash", jan1_2027), {
    inputPer1M: 1.50, outputPer1M: 7.50, thinkingPer1M: 7.50
  });
  // Legacy/retiring gemini-2.5-flash rates still accurate for historical logs or explicit config
  assert.deepEqual(resolveModelRate(def, "openrouter", "google/gemini-2.5-flash", nov2026), {
    inputPer1M: 0.30, outputPer1M: 2.50, thinkingPer1M: 2.50
  });
  assert.equal(DEFAULT_AI_PRICING.inputPer1M, 0.75);
  assert.equal(DEFAULT_MODEL_PRICING["google/gemini-2.5-flash"].outputPer1M, 2.50);

  // Per-model JSON override takes highest precedence (even after Jan 1, 2027), including optional thinkingPer1M
  const custom = parsePricing({
    AI_MODEL_PRICES_JSON: JSON.stringify({
      "gemini-3.8-flash": { inputPer1M: 1.0, outputPer1M: 4.0, thinkingPer1M: 5.0 },
      "google/gemini-2.5-flash": { inputPer1M: 0.25, outputPer1M: 2.0 }
    })
  });
  const gRate = resolveModelRate(custom, "gemini", "gemini-3.8-flash", jan1_2027);
  assert.deepEqual(gRate, { inputPer1M: 1.0, outputPer1M: 4.0, thinkingPer1M: 5.0 });
  assert.deepEqual(resolveModelRate(custom, "openrouter", "google/gemini-2.5-flash", nov2026), {
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

test("Finding 1: per-attempt reservation prevents retries and OpenRouter fallback from exceeding tight user cap OR tight global cap", async () => {
  // 1A. Tight user cap ($0.01) with Codex's exact reproduction:
  // Gemini attempt 1 fails with 503 after consuming 2,000 output tokens ($0.0075).
  // OpenRouter fallback MUST be refused BEFORE dispatch so total spend stays <= $0.01!
  {
    const db = makeDb();
    let clock = Date.parse("2026-11-26T12:00:00.000Z");
    const dispatched = [];
    const proxy = createAIProxy(db, {
      aiProvider: "gemini",
      geminiKey: "g-key",
      geminiModel: "gemini-3.8-flash", // $0.75/1M in, $3.75/1M out -> 2000 maxTokens (low) reserve ~$0.0096
      orKey: "or-key",
      orModel: "google/gemini-2.5-flash", // $0.30/1M in, $2.50/1M out -> 2000 maxTokens (low) reserve ~$0.0063
      aiDaily: 10,
      aiGlobalDaily: 50,
      aiMaxTokens: 2000,
      aiReasoningEffort: "low",
      aiUserMonthlyUsd: 0.01,
      aiGlobalMonthlyUsd: 80.0,
      geminiRetryDelays: [0],
      now: () => clock,
      sleep: async () => {},
      log: () => {}
    }, async url => {
      dispatched.push(url);
      // Gemini attempt 1 fails with 503 after generating 2,000 output tokens ($0.0075 + $0.000075 = $0.007575)
      return {
        ok: false,
        status: 503,
        json: async () => ({
          error: { code: 503, status: "UNAVAILABLE", message: "overloaded" },
          usage: { prompt_tokens: 100, completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 1500 } }
        })
      };
    });

    try {
      await assert.rejects(
        proxy({ id: "u_tight" }, { messages: [{ content: "hi" }] }),
        e => e.status === 429 && e.code === "ai_user_monthly_cap"
      );
      assert.equal(dispatched.length, 1, "retry and fallback must be blocked before dispatch when cap would be exceeded");
      const spent = db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?").get("u_tight", "2026-11").cost_nanos;
      assert.ok(nanosToUsd(spent) <= 0.01, `user spend ${nanosToUsd(spent)} exceeded $0.01 cap`);
    } finally {
      db.close();
    }
  }

  // 1B. Tight global cap ($0.01) independently (user cap is $5.00):
  // Two concurrent users race AND the admitted call hits a 503 retry/fallback -> global spend stays <= $0.01!
  {
    const db = makeDb();
    let clock = Date.parse("2026-11-26T12:00:00.000Z");
    const dispatched = [];
    let firstStarted;
    const startedP = new Promise(r => { firstStarted = r; });
    let releaseFirst;
    const gateP = new Promise(r => { releaseFirst = r; });

    const proxy = createAIProxy(db, {
      aiProvider: "gemini",
      geminiKey: "g-key",
      geminiModel: "gemini-3.8-flash",
      orKey: "or-key",
      orModel: "google/gemini-3.8-flash",
      aiDaily: 10,
      aiGlobalDaily: 50,
      aiMaxTokens: 2000,
      aiReasoningEffort: "low",
      aiUserMonthlyUsd: 5.0,
      aiGlobalMonthlyUsd: 0.01,
      geminiRetryDelays: [0],
      now: () => clock,
      sleep: async () => {},
      log: () => {}
    }, async url => {
      dispatched.push(url);
      if (dispatched.length === 1) {
        firstStarted();
        await gateP;
      }
      return {
        ok: false,
        status: 503,
        json: async () => ({
          error: { code: 503, status: "UNAVAILABLE", message: "overloaded" },
          usage: { prompt_tokens: 100, completion_tokens: 2000 }
        })
      };
    });

    try {
      const p1 = proxy({ id: "u_g1" }, { messages: [{ content: "hi" }] });
      await startedP;

      // Second concurrent user must be refused immediately on global cap
      await assert.rejects(
        proxy({ id: "u_g2" }, { messages: [{ content: "hi" }] }),
        e => e.status === 503 && e.code === "ai_global_monthly_cap"
      );
      assert.equal(dispatched.length, 1);

      // Release first call -> Gemini fails with $0.007575, retry/fallback blocked by global cap!
      releaseFirst();
      await assert.rejects(p1, e => e.status === 503 && e.code === "ai_global_monthly_cap");
      assert.equal(dispatched.length, 1, "neither retry nor fallback may dispatch past global cap");
      const gSpent = db.prepare("SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?").get("2026-11").cost_nanos;
      assert.ok(nanosToUsd(gSpent) <= 0.01, `global spend ${nanosToUsd(gSpent)} exceeded $0.01 cap`);
    } finally {
      db.close();
    }
  }
});

test("Finding 2: crash & restart preserve spend headroom (before and after expiry), and ambiguous responses keep full conservative debit", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-ai-crash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "bojin.db");

  let clock = Date.parse("2026-11-26T12:00:00.000Z");
  const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
  const makeCfg = () => ({
    aiProvider: "gemini",
    geminiKey: "g-key",
    aiDaily: 50,
    aiGlobalDaily: 50,
    aiMaxTokens: 500, // low effort reserve ~$0.92 per call (256+32+bytes + 500+128 output)
    aiReasoningEffort: "low",
    aiUserMonthlyUsd: 1.0,
    aiGlobalMonthlyUsd: 1.0,
    aiPricing: pricing,
    now: () => clock,
    log: () => {}
  });

  // 1. Simulate crash mid-provider-call: reservation is persisted BEFORE upstream responds, then DB closes (process killed)
  {
    const db1 = new DatabaseSync(dbPath);
    let providerAccepted;
    const acceptedP = new Promise(r => { providerAccepted = r; });
    const proxy1 = createAIProxy(db1, makeCfg(), async () => {
      providerAccepted();
      // Never resolves (simulates process crash / SIGKILL while upstream holds request)
      await new Promise(() => {});
    });
    // Start call (do not await forever)
    const inflight = proxy1({ id: "u_crash" }, { messages: [{ content: "hello" }] });
    inflight.catch(() => {});
    await acceptedP;

    // Verify reservation is durably persisted in SQLite
    const resRows = db1.prepare("SELECT * FROM ai_budget_reservations WHERE uid = ?").all("u_crash");
    assert.equal(resRows.length, 1);
    assert.ok(nanosToUsd(resRows[0].reserved_nanos) > 0.7);
    db1.close();
  }

  // 2. Restart BEFORE reservation expires -> persisted reservation STILL blocks a second call!
  {
    const db2 = new DatabaseSync(dbPath);
    let calls = 0;
    const proxy2 = createAIProxy(db2, makeCfg(), async () => {
      calls++;
      return makeOkRes("ok", { prompt_tokens: 10, completion_tokens: 10 });
    });
    try {
      await assert.rejects(
        proxy2({ id: "u_crash" }, { messages: [{ content: "retry after crash" }] }),
        e => (e.status === 503 && e.code === "ai_global_monthly_cap") || (e.status === 429 && e.code === "ai_user_monthly_cap")
      );
      assert.equal(calls, 0, "restart must not restore headroom before reservation expires");
    } finally {
      db2.close();
    }
  }

  // 3. Advance clock PAST reservation TTL (5 min later) and restart -> expired reservation is FINALIZED as spend (NEVER refunded!)
  {
    clock += 5 * 60 * 1000;
    const db3 = new DatabaseSync(dbPath);
    let calls = 0;
    const proxy3 = createAIProxy(db3, makeCfg(), async () => {
      calls++;
      return makeOkRes("ok", { prompt_tokens: 10, completion_tokens: 10 });
    });
    try {
      // Startup reconciliation finalized the expired row into permanent monthly spend
      assert.equal(db3.prepare("SELECT COUNT(*) AS n FROM ai_budget_reservations").get().n, 0);
      const userSpent = db3.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?").get("u_crash", "2026-11").cost_nanos;
      const globalSpent = db3.prepare("SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?").get("2026-11").cost_nanos;
      assert.ok(nanosToUsd(userSpent) > 0.7, "expired crash reservation must finalize into user monthly spend");
      assert.equal(globalSpent, userSpent, "expired crash reservation must finalize into global monthly spend");

      // Headroom is STILL blocked permanently!
      await assert.rejects(
        proxy3({ id: "u_crash" }, { messages: [{ content: "after ttl" }] }),
        e => e.code === "ai_global_monthly_cap" || e.code === "ai_user_monthly_cap"
      );
      assert.equal(calls, 0);
    } finally {
      db3.close();
    }
  }

  // 4. Ambiguous outcomes (timeout/network error, 502 without usage, HTTP 200 without usage) debit full conservative upper bound;
  //    confirmed non-billable HTTP 429 without usage debits $0.
  {
    const db = makeDb();
    let step = 0;
    const proxy = createAIProxy(db, {
      aiProvider: "openrouter",
      orKey: "or-key",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 500,
      aiUserMonthlyUsd: 50,
      aiGlobalMonthlyUsd: 50,
      aiPricing: pricing,
      now: () => clock,
      log: () => {}
    }, async () => {
      step++;
      if (step === 1) throw new Error("socket hang up"); // ambiguous network error
      if (step === 2) return { ok: false, status: 502, json: async () => ({ error: { message: "bad gateway" } }) }; // ambiguous 5xx without usage
      if (step === 3) return makeOkRes("ok", null); // HTTP 200 without authoritative usage
      return { ok: false, status: 429, json: async () => ({ error: { code: 429, message: "rate limit" } }) }; // confirmed non-billable
    });
    try {
      const expectedReserve = proxy.estimateAttemptReserveNanos("openrouter", [{ role: "user", content: "hi" }], [], clock).reserveNanos;
      await assert.rejects(proxy({ id: "u1" }, { messages: [{ content: "hi" }] }), e => e.code === "ai_failed");
      assert.equal(db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ?").get("u1").cost_nanos, expectedReserve);

      await assert.rejects(proxy({ id: "u2" }, { messages: [{ content: "hi" }] }), e => e.code === "ai_failed");
      assert.equal(db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ?").get("u2").cost_nanos, expectedReserve);

      await proxy({ id: "u3" }, { messages: [{ content: "hi" }] });
      assert.equal(db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ?").get("u3").cost_nanos, expectedReserve);

      await assert.rejects(proxy({ id: "u4" }, { messages: [{ content: "hi" }] }), e => e.code === "rate_limited");
      assert.equal(db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ?").get("u4").cost_nanos, 0);
    } finally {
      db.close();
    }
  }
});

test("Finding 3: account deletion during an in-flight AI call preserves global exposure, blocks competing spend, never recreates deleted user rows, and exports active reservations", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-ai-del-race-"));
  const dir = path.join(root, "data");
  fs.mkdirSync(path.join(dir, "blobs"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const db = new DatabaseSync(path.join(dir, "bojin.db"));
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, created TEXT NOT NULL, mustChange INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, uid TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE docs (path TEXT PRIMARY KEY, uid TEXT NOT NULL, parent TEXT NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
    CREATE TABLE ai_usage (uid TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(uid, day));
  `);
  const accountData = createAccountData(db, dir);

  let clock = Date.parse("2026-11-26T12:00:00.000Z");
  const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
  let entered;
  const enteredP = new Promise(r => { entered = r; });
  let release;
  const releaseP = new Promise(r => { release = r; });
  let calls = 0;

  const proxy = createAIProxy(db, {
    aiProvider: "gemini",
    geminiKey: "g-key",
    aiDaily: 50,
    aiGlobalDaily: 50,
    aiMaxTokens: 500, // low effort reserve ~$0.92
    aiReasoningEffort: "low",
    aiUserMonthlyUsd: 5.0,
    aiGlobalMonthlyUsd: 1.0, // only room for 1 in-flight call!
    aiPricing: pricing,
    now: () => clock,
    log: () => {}
  }, async () => {
    calls++;
    entered();
    await releaseP;
    return makeOkRes("ok", { prompt_tokens: 200, completion_tokens: 300 }); // $0.50 actual
  });

  try {
    // 1. Start in-flight call for u_del
    const inflight = proxy({ id: "u_del" }, { messages: [{ content: "hi" }] });
    await enteredP;

    // 2. Export BEFORE deletion includes the active ai_budget_reservation row!
    const expChunks = [];
    for await (const c of accountData.exportChunks({ id: "u_del" })) expChunks.push(c);
    const expRecs = expChunks.join("").trim().split("\n").map(JSON.parse);
    const resExport = expRecs.find(r => r.kind === "ai_budget_reservation");
    assert.ok(resExport, "export must include active per-user ai_budget_reservation");
    assert.equal(resExport.month, "2026-11");
    assert.ok(resExport.reservedUsd > 0.7);

    // 3. Delete u_del WHILE provider call is still in-flight!
    accountData.requestDeletion({ id: "u_del" });
    accountData.completeDeletion("u_del");

    // Reservation row must have uid = NULL (no PII), yet still exist to hold global exposure!
    const resRow = db.prepare("SELECT uid, reserved_nanos FROM ai_budget_reservations").get();
    assert.ok(resRow, "reservation row must remain for global exposure until settlement");
    assert.equal(resRow.uid, null, "uid must be scrubbed on deletion");

    // 4. Competing user u_other MUST still be refused while u_del's provider call is in-flight!
    await assert.rejects(
      proxy({ id: "u_other" }, { messages: [{ content: "steal headroom" }] }),
      e => e.status === 503 && e.code === "ai_global_monthly_cap"
    );
    assert.equal(calls, 1, "competing user must not spend global headroom released early by deletion");

    // 5. In-flight provider call finishes -> settles global spend ($0.50), NEVER recreates u_del's monthly row!
    release();
    await inflight;
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_budget_reservations").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_monthly_usage WHERE uid = ?").get("u_del").n, 0, "settlement must NEVER recreate deleted user's ai_monthly_usage row");
    assert.equal(roundUsd(nanosToUsd(db.prepare("SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?").get("2026-11").cost_nanos)), 0.5);
  } finally {
    db.close();
  }
});

test("Finding 6: oversized request does not claim 100% alert, jump across 80%->100% fires both, and alert retries on outage with stable dedupe key", async () => {
  // 6A. Oversized request refused without triggering 100% alert when smaller requests still fit
  {
    const db = makeDb();
    let clock = Date.parse("2026-11-26T12:00:00.000Z");
    const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
    const alerts = [];
    const proxy = createAIProxy(db, {
      aiProvider: "gemini",
      geminiKey: "g-key",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 100, // small call reserve ~$0.39
      aiUserMonthlyUsd: 20,
      aiGlobalMonthlyUsd: 2.0, // small call fits ($0.39 <= $2), huge 4-image call ($16+) does NOT fit!
      aiPricing: pricing,
      alertUrl: "https://ntfy.example.com/test",
      alertFetcher: async (url, init) => { alerts.push({ url, headers: init.headers, body: init.body }); return { status: 200, ok: true }; },
      alertLog: () => {},
      now: () => clock,
      log: () => {}
    }, async () => makeOkRes("ok", { prompt_tokens: 10, completion_tokens: 10 }));

    try {
      await assert.rejects(
        proxy({ id: "u1" }, { messages: [{ content: "x".repeat(5000) }] }),
        e => e.status === 503 && e.code === "ai_global_monthly_cap"
      );
      assert.equal(alerts.length, 0, "oversized request must NOT claim 100% app-wide pause alert");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_budget_alerts").get().n, 0);

      // Smaller request still succeeds cleanly!
      await proxy({ id: "u1" }, { messages: [{ content: "small" }] });
      assert.equal(alerts.length, 0);
    } finally {
      db.close();
    }
  }

  // 6B. Single call jumping from 0% straight to >=100% enqueues & delivers BOTH 80% and 100%,
  //     and transient webhook outage retries up to MAX_ALERT_ATTEMPTS with stable X-Idempotency-Key!
  {
    const db = makeDb();
    let clock = Date.parse("2026-11-26T12:00:00.000Z");
    const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
    const deliveries = [];
    let webhookHealthy = false;

    const proxy = createAIProxy(db, {
      aiProvider: "gemini",
      geminiKey: "g-key",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 100,
      aiUserMonthlyUsd: 50,
      aiGlobalMonthlyUsd: 1.0,
      aiPricing: pricing,
      alertUrl: "https://ntfy.example.com/retry-test",
      alertRetryDelayMs: 10000,
      alertFetcher: async (url, init) => {
        deliveries.push({
          title: init.headers.Title,
          key: init.headers["X-Idempotency-Key"],
          redirect: init.redirect,
          healthy: webhookHealthy
        });
        return { status: webhookHealthy ? 200 : 503, ok: webhookHealthy };
      },
      alertLog: () => {},
      now: () => clock,
      log: () => {}
    }, async () => makeOkRes("ok", { prompt_tokens: 600, completion_tokens: 600 })); // $1.20 jumps 0% -> 120%!

    try {
      // Attempt 1 of delivery is scheduled asynchronously off the request path and fails with 503
      // -> drain via flushAlerts(); BOTH 80% and 100% attempted and remain status='pending'
      await proxy({ id: "u1" }, { messages: [{ content: "jump" }] });
      await proxy.flushAlerts();
      assert.equal(deliveries.length, 2);
      assert.deepEqual(deliveries.map(d => d.key), ["ai-budget:2026-11:80", "ai-budget:2026-11:100"]);
      const rowsPending = db.prepare("SELECT threshold, status, attempts FROM ai_budget_alerts ORDER BY threshold").all().map(r => ({ ...r }));
      assert.deepEqual(rowsPending, [
        { threshold: 80, status: "pending", attempts: 1 },
        { threshold: 100, status: "pending", attempts: 1 }
      ]);

      // Before retry backoff elapses, flushAlerts does NOT spam
      await proxy.flushAlerts();
      assert.equal(deliveries.length, 2);

      // Webhook recovers, advance past backoff -> attempt 2 delivers BOTH with the SAME stable dedupe keys!
      webhookHealthy = true;
      clock += 15000;
      await proxy.flushAlerts();
      assert.equal(deliveries.length, 4);
      assert.deepEqual(deliveries.slice(2).map(d => d.key), ["ai-budget:2026-11:80", "ai-budget:2026-11:100"]);
      const rowsDelivered = db.prepare("SELECT threshold, status, attempts FROM ai_budget_alerts ORDER BY threshold").all().map(r => ({ ...r }));
      assert.deepEqual(rowsDelivered, [
        { threshold: 80, status: "delivered", attempts: 2 },
        { threshold: 100, status: "delivered", attempts: 2 }
      ]);

      // Further flushes or blocked requests never re-send
      clock += 120000;
      await proxy.flushAlerts();
      assert.equal(deliveries.length, 4);
    } finally {
      db.close();
    }
  }

  // 6C. Permanent webhook outage stops after 3 bounded attempts (status='failed')
  {
    const db = makeDb();
    let clock = Date.parse("2026-11-26T12:00:00.000Z");
    const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
    let alertPosts = 0;
    const proxy = createAIProxy(db, {
      aiProvider: "gemini",
      geminiKey: "g-key",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 100,
      aiUserMonthlyUsd: 50,
      aiGlobalMonthlyUsd: 5.0,
      aiPricing: pricing,
      alertUrl: "https://ntfy.example.com/down",
      alertRetryDelayMs: 5000,
      alertFetcher: async () => { alertPosts++; return { status: 503, ok: false }; },
      alertLog: () => {},
      now: () => clock,
      log: () => {}
    }, async () => makeOkRes("ok", { prompt_tokens: 2050, completion_tokens: 2000 })); // $4.05 / $5.00 = 81% (only 80% alert; $0.95 remaining >= $0.90 min reserve)

    try {
      await proxy({ id: "u1" }, { messages: [{ content: "x" }] });
      await proxy.flushAlerts();
      assert.equal(alertPosts, 1);
      clock += 6000;
      await proxy.flushAlerts();
      assert.equal(alertPosts, 2);
      clock += 6000;
      await proxy.flushAlerts();
      assert.equal(alertPosts, 3);
      const row = db.prepare("SELECT status, attempts FROM ai_budget_alerts WHERE month = ? AND threshold = 80").get("2026-11");
      assert.equal(row.status, "failed");
      assert.equal(row.attempts, 3);
      // Bounded: never retries a 4th time
      clock += 60000;
      await proxy.flushAlerts();
      assert.equal(alertPosts, 3);
    } finally {
      db.close();
    }
  }
});

test("Finding 7: retry or fallback dispatched after UTC midnight settles against the new month's budget", async () => {
  const db = makeDb();
  let clock = Date.parse("2026-11-30T23:59:59.500Z");
  const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
  let callNum = 0;

  const proxy = createAIProxy(db, {
    aiProvider: "gemini",
    geminiKey: "g-key",
    orKey: "or-key",
    aiDaily: 50,
    aiGlobalDaily: 50,
    aiMaxTokens: 100,
    aiUserMonthlyUsd: 5.0,
    aiGlobalMonthlyUsd: 80.0,
    aiPricing: pricing,
    geminiRetryDelays: [1000], // 1s backoff crosses UTC midnight into 2026-12!
    now: () => clock,
    sleep: async ms => { clock += ms; },
    log: () => {}
  }, async () => {
    callNum++;
    if (callNum === 1) {
      // Dispatched in 2026-11: consumes 300 tokens = $0.30
      return {
        ok: false,
        status: 503,
        json: async () => ({
          error: { code: 503, status: "UNAVAILABLE" },
          usage: { prompt_tokens: 200, completion_tokens: 100 }
        })
      };
    }
    // Retry dispatched at 2026-12-01T00:00:00.500Z: consumes 400 tokens = $0.40
    return makeOkRes("december ok", { prompt_tokens: 200, completion_tokens: 200 });
  });

  try {
    const res = await proxy({ id: "u_mid" }, { messages: [{ content: "midnight" }] });
    assert.deepEqual(res, { text: "december ok", truncated: false });
    assert.equal(callNum, 2);

    const nov = db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?").get("u_mid", "2026-11");
    const dec = db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?").get("u_mid", "2026-12");
    assert.equal(roundUsd(nanosToUsd(nov.cost_nanos)), 0.3);
    assert.equal(roundUsd(nanosToUsd(dec.cost_nanos)), 0.4);
  } finally {
    db.close();
  }
});

test("per-user monthly cap refuses before calling model with zh/en messages, keeps daily caps, and resets on UTC month rollover", async () => {
  const db = makeDb();
  let clock = Date.parse("2026-11-30T23:59:30.000Z");
  let upstreamCalls = 0;
  const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
  const userLangs = { u_zh: "zh", u_en: "en" };
  const proxy = createAIProxy(db, {
    aiProvider: "gemini",
    geminiKey: "g-key",
    aiDaily: 10,
    aiGlobalDaily: 50,
    aiMaxTokens: 50, // reserve ~$0.34 (256+32+bytes+50)
    aiUserMonthlyUsd: 1.5,
    aiGlobalMonthlyUsd: 80.0,
    aiPricing: pricing,
    getUserLang: u => userLangs[u.id] || "zh",
    now: () => clock,
    log: () => {}
  }, async () => {
    upstreamCalls++;
    return makeOkRes("ok", {
      prompt_tokens: 600,
      completion_tokens: 650,
      completion_tokens_details: { reasoning_tokens: 200 }
    }); // $1.25 -> 83% of $1.50
  });

  try {
    await proxy({ id: "u_zh" }, { messages: [{ content: "hi" }] });
    assert.equal(upstreamCalls, 1);
    const statusNear = proxy.getBudgetStatus("u_zh");
    assert.equal(statusNear.month, "2026-11");
    assert.equal(statusNear.usedPct, 83);
    // $1.25 + ~$0.34 reserve > $1.50 -> reached = true, next call blocked before upstream!
    assert.equal(statusNear.reached, true);

    await assert.rejects(
      proxy({ id: "u_zh" }, { messages: [{ content: "second" }] }),
      e => e.status === 429 && e.code === "ai_user_monthly_cap" && /手动/.test(e.message)
    );
    assert.equal(upstreamCalls, 1);
    assert.equal(db.prepare("SELECT n FROM ai_usage WHERE uid = ?").get("u_zh").n, 1);

    await proxy({ id: "u_en" }, { messages: [{ content: "hello" }] });
    assert.equal(upstreamCalls, 2);
    await assert.rejects(
      proxy({ id: "u_en" }, { messages: [{ content: "second" }] }),
      e => e.status === 429 && e.code === "ai_user_monthly_cap" && /manually/i.test(e.message) && !/[\u3400-\u9fff]/.test(e.message)
    );
    assert.equal(upstreamCalls, 2);

    // Rollover to 2026-12-01T00:00:00Z
    clock = Date.parse("2026-12-01T00:00:00.000Z");
    const statusDec = proxy.getBudgetStatus("u_zh");
    assert.equal(statusDec.month, "2026-12");
    assert.equal(statusDec.usedPct, 0);
    assert.equal(statusDec.reached, false);
    await proxy({ id: "u_zh" }, { messages: [{ content: "dec call" }] });
    assert.equal(upstreamCalls, 3);
  } finally {
    db.close();
  }
});

test("Findings 4 & 5: admin CLI defaults to pseudonymous output, guards mutations with --confirm-id, supports --show-identity, and seeds mid-month rollout spend via ai-seed", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-ai-admin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const env = {
    ...process.env,
    DATA_DIR: dir,
    AUTH_SECRET: "admin-cli-test-secret-at-least-32-chars",
    AI_USER_MONTHLY_USD: "5",
    AI_GLOBAL_MONTHLY_USD: "80"
  };

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

  const bojinDb = new DatabaseSync(path.join(dir, "bojin.db"));
  ensureAiBudgetSchema(bojinDb);
  const month = "2026-11";
  bojinDb.prepare("INSERT INTO ai_monthly_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("u_email_1", month, 12, 100_000, 40_000, 10_000, usdToNanos(4.5), "2026-11-26T00:00:00.000Z");
  bojinDb.prepare("INSERT INTO ai_monthly_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("u_phone_1", month, 5, 30_000, 10_000, 0, usdToNanos(1.25), "2026-11-26T00:00:00.000Z");
  bojinDb.prepare("INSERT INTO ai_global_monthly_usage VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(month, 17, 130_000, 50_000, 10_000, usdToNanos(5.75), "2026-11-26T00:00:00.000Z");
  bojinDb.close();

  const runCli = args => spawnSync(process.execPath, [path.join(ROOT, "scripts/auth-admin.js"), ...args], {
    env, encoding: "utf8", timeout: 5000
  });

  // 1. Default ai-usage output is strictly pseudonymous (no email/phone in text OR json!)
  const defaultUsageText = runCli(["ai-usage", "--month", month]);
  assert.equal(defaultUsageText.status, 0, defaultUsageText.stderr);
  assert.ok(!defaultUsageText.stdout.includes("alice@example.com"), "default ai-usage text must hide email");
  assert.ok(!defaultUsageText.stdout.includes("13800138000"), "default ai-usage text must hide phone");
  assert.ok(!defaultUsageText.stdout.includes("u_email_1"), "default ai-usage text must hide raw DB uid");

  const defaultUsageJson = JSON.parse(runCli(["ai-usage", "--month", month, "--json"]).stdout);
  assert.equal(defaultUsageJson.identitiesIncluded, false);
  assert.equal("email" in defaultUsageJson.users[0], false);
  assert.equal("phone" in defaultUsageJson.users[1], false);
  const aliceAnonId = defaultUsageJson.users[0].anonId;
  const bobAnonId = defaultUsageJson.users[1].anonId;

  // 2. Opt-in --show-identity reveals host-only email/phone (never synthetic phone email)
  const idUsageJson = JSON.parse(runCli(["ai-usage", "--month", month, "--show-identity", "--json"]).stdout);
  assert.equal(idUsageJson.identitiesIncluded, true);
  assert.equal(idUsageJson.users[0].email, "alice@example.com");
  assert.equal(idUsageJson.users[1].phone, "+8613800138000");
  assert.equal(idUsageJson.users[1].email, null);

  // 3. Mutation guard: ai-cap --usd WITHOUT --confirm-id or with WRONG --confirm-id MUST fail without mutating!
  const noConfirm = runCli(["ai-cap", "--email", "alice@example.com", "--usd", "15", "--month", month]);
  assert.notEqual(noConfirm.status, 0);
  assert.match(noConfirm.stderr, new RegExp(aliceAnonId));

  const wrongConfirm = runCli(["ai-cap", "--email", "alice@example.com", "--confirm-id", bobAnonId, "--usd", "15", "--month", month]);
  assert.notEqual(wrongConfirm.status, 0);
  assert.match(wrongConfirm.stderr, /does not match/);

  // Inspect confirms cap was NOT modified
  const inspectDefault = JSON.parse(runCli(["ai-cap", "--email", "alice@example.com", "--month", month, "--json"]).stdout);
  assert.equal(inspectDefault.capUsd, 5);
  assert.equal(inspectDefault.capSource, "default");
  assert.equal("email" in inspectDefault, false, "default ai-cap JSON must omit email");

  // 4. With matching --confirm-id, raise Alice's cap to $15 and lower Bob's cap to $1.00
  const raiseRes = runCli(["ai-cap", "--email", "ALICE@example.com", "--confirm-id", aliceAnonId, "--usd", "15", "--month", month, "--json"]);
  assert.equal(raiseRes.status, 0, raiseRes.stderr);
  assert.equal(JSON.parse(raiseRes.stdout).capUsd, 15);

  const lowerRes = runCli(["ai-cap", "--phone", "13800138000", "--confirm-id", bobAnonId, "--usd", "1.0", "--show-identity", "--month", month]);
  assert.equal(lowerRes.status, 0, lowerRes.stderr);
  assert.match(lowerRes.stdout, /\+8613800138000/);
  assert.match(lowerRes.stdout, /\$1\.00 \[override\]/);

  // 5. Mid-month rollout seeding via ai-seed is idempotent and enforces remaining headroom immediately!
  const seed1 = runCli(["ai-seed", "--month", month, "--usd", "74.5", "--note", "pre-rollout AI Studio spend", "--json"]);
  assert.equal(seed1.status, 0, seed1.stderr);
  const seeded = JSON.parse(seed1.stdout);
  assert.equal(seeded.baselineUsd, 74.5);
  assert.equal(seeded.liveUsd, 5.75);
  assert.equal(seeded.totalUsd, 80.25); // exceeds $80 global budget!

  // Runtime proxy immediately enforces the seeded global spend (paused at $80.25 / $80.00)!
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
    assert.equal(proxy.getBudgetStatus("u_email_1").globalPaused, true);
  } finally {
    liveDb.close();
  }

  // Re-running ai-seed with lower baseline updates idempotently (does NOT double-count)
  const seed2 = JSON.parse(runCli(["ai-seed", "--month", month, "--usd", "20", "--json"]).stdout);
  assert.equal(seed2.baselineUsd, 20);
  assert.equal(seed2.totalUsd, 25.75);

  // Reset Alice's cap back to default $5 with --confirm-id
  const resetRes = JSON.parse(runCli(["ai-cap", "--email", "alice@example.com", "--confirm-id", aliceAnonId, "--reset", "--month", month, "--json"]).stdout);
  assert.equal(resetRes.capUsd, 5);
  assert.equal(resetRes.capSource, "default");
});

test("daily-summary reports month-to-date spend (including rollout baseline) vs $80 budget and anonymized top user spend with zero PII", t => {
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
  bojinDb.prepare("INSERT INTO ai_user_caps VALUES (?, ?, ?)")
    .run("u_secret_top_user", usdToNanos(10), "2026-11-25T00:00:00.000Z");
  bojinDb.prepare("INSERT INTO ai_global_monthly_usage VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("2026-11", 35, 250_000, 100_000, 15_000, usdToNanos(18.5), "2026-11-26T03:00:00.000Z");
  bojinDb.prepare("INSERT INTO ai_global_monthly_baseline VALUES (?, ?, ?, ?)")
    .run("2026-11", usdToNanos(10.0), "rollout seed", "2026-11-25T00:00:00.000Z");
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
  // $18.50 live + $10.00 rollout baseline = $28.50
  assert.equal(summary.ai.monthToDate.estimatedCostUsd, 28.5);
  assert.equal(summary.ai.monthToDate.budgetUsedPct, 35.6);
  assert.equal(summary.ai.monthToDate.calls, 35);
  assert.match(summary.ai.monthToDate.topUser.user, /^u_[0-9a-f]{8}$/);
  assert.equal(summary.ai.monthToDate.topUser.estimatedCostUsd, 4.25);
  assert.equal(summary.ai.monthToDate.topUser.capUsd, 10);

  const text = formatSummaryText(summary);
  assert.match(text, /本月累计 \(2026-11 UTC\): \$28\.5000 \/ \$80\.00 \(35\.6%/);
  assert.match(text, /本月最高单用户: u_[0-9a-f]{8} \$4\.2500 \/ \$10\.00 \(25 次\)/);
  assert.ok(!text.includes("u_secret_top_user") && !JSON.stringify(summary).includes("u_secret_top_user"));
});

test("migration is idempotent on pre-existing live DB; export includes AI usage; deletion & restore replay scrub user records while preserving global spend", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-ai-data-"));
  const dir = path.join(root, "data");
  fs.mkdirSync(path.join(dir, "blobs"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

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

  const chunksA = [];
  for await (const c of accountData.exportChunks({ id: "u_one" })) chunksA.push(c);
  const recsA = chunksA.join("").trim().split("\n").map(JSON.parse);
  assert.equal(recsA.filter(r => r.kind === "ai_usage").length, 2);
  assert.equal(recsA.find(r => r.kind === "ai_monthly_usage")?.calls, 1);
  assert.equal(recsA.find(r => r.kind === "ai_cap")?.monthlyUsd, 12);

  const snapDir = path.join(root, "snap-before");
  await createSnapshot(dir, snapDir);

  const globalBefore = db.prepare("SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?").get("2026-11").cost_nanos;
  accountData.requestDeletion({ id: "u_one" });
  accountData.completeDeletion("u_one");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_usage WHERE uid = ?").get("u_one").n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_monthly_usage WHERE uid = ?").get("u_one").n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_user_caps WHERE uid = ?").get("u_one").n, 0);
  assert.equal(db.prepare("SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?").get("2026-11").cost_nanos, globalBefore);
  db.close();

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

    vm.runInContext(`S.aiBudget = { month:"2026-11", usedPct:50, nearCap:false, reached:false, globalPaused:false };`, ctx);
    assert.equal(vm.runInContext(`aiBudgetNotice()`, ctx), "");

    vm.runInContext(`S.aiBudget = { month:"2026-11", usedPct:84, nearCap:true, reached:false, globalPaused:false };`, ctx);
    for (const html of [vm.runInContext(`viewFood()`, ctx), vm.runInContext(`viewFeedback()`, ctx), vm.runInContext(`editor({ orig:"平板哑铃卧推" })`, ctx)]) {
      assert.match(html, /ai-budget-notice/);
      assert.match(html, /84%/);
      if (lang === "en") {
        assert.match(html, /manually/i);
        assert.doesNotMatch(html.match(/ai-budget-notice[^>]*>([^<]+)</)[1], /[\u3400-\u9fff]/);
      } else {
        assert.match(html, /手动/);
      }
    }

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

test("HTTP end-to-end: connected & disconnected clients settle upstream cost, /api/me aiBudget, X-Bojin-AI-Budget header, per-user cap, and global pause alerts", { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-ai-budget-http-"));
  const alertsSeen = [];
  let aiHits = 0;
  let slowNext = false;

  const mockServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/alert") {
      alertsSeen.push({ title: req.headers.title, key: req.headers["x-idempotency-key"], body: bodyText });
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url === "/gemini/chat/completions") {
      aiHits++;
      if (slowNext) {
        slowNext = false;
        await new Promise(r => setTimeout(r, 250));
      }
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

  const port = 18098;
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
    AI_REASONING_EFFORT: "low",
    AI_INPUT_PRICE_PER_1M: "1000",
    AI_OUTPUT_PRICE_PER_1M: "1000",
    AI_USER_MONTHLY_USD: "1.5",
    AI_GLOBAL_MONTHLY_USD: "2.5",
    ALERT_URL: "https://ntfy.example.com/budget-topic"
  };

  const issue = email => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/auth-admin.js"), "invite", email], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const invA = issue("budget-a@example.com");
  const invB = issue("budget-b@example.com");
  const invC = issue("budget-c@example.com");

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

  const req = (route, payload, cookie, method, signal) => fetch(base + route, {
    method: method || (payload ? "POST" : "GET"),
    redirect: "manual",
    signal,
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
  const cookieC = await registerAndLogin(invC);
  assert.equal((await req(`/api/doc?path=data/users/${invB.userId}/app/app/profile`, { data: { lang: "en" } }, cookieB, "PUT")).status, 200);

  // 1. Disconnected client still settles upstream spend!
  slowNext = true;
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 50);
  await assert.rejects(req("/api/ai", { messages: [{ content: "aborted client" }] }, cookieA, "POST", ctl.signal));
  // Wait for upstream mock (250ms) + settlement to complete
  await new Promise(r => setTimeout(r, 400));
  const meA = await (await req("/api/me", null, cookieA)).json();
  assert.equal(meA.aiBudget.usedPct, 60, "disconnected client call must still settle $0.90 / $1.50 = 60%");

  // 2. Call 2 by User B ($0.90 -> global $1.80 / $2.50 = 72%, no alert yet)
  const r2 = await req("/api/ai", { messages: [{ content: "meal 2" }], json: true }, cookieB);
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { text: "{\"ok\":true}", truncated: false });
  assert.equal(JSON.parse(r2.headers.get("x-bojin-ai-budget")).usedPct, 60);
  assert.equal(alertsSeen.length, 0);

  // 3. Call 3 by User C ($0.90 -> global $2.70 / $2.50 = 108% -> fires BOTH 80% AND 100% alerts asynchronously!)
  const r3 = await req("/api/ai", { messages: [{ content: "meal 3" }] }, cookieC);
  assert.equal(r3.status, 200);
  for (let i = 0; i < 100 && alertsSeen.length < 2; i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(alertsSeen.length, 2);
  assert.match(alertsSeen[0].title, /80%/);
  assert.match(alertsSeen[1].title, /100%/);

  // 4. Call 4 by User B refused with 503 ai_global_monthly_cap (English from profile) and zero extra alerts
  const r4 = await req("/api/ai", { messages: [{ content: "meal 4" }] }, cookieB);
  assert.equal(r4.status, 503);
  const j4 = await r4.json();
  assert.equal(j4.error, "ai_global_monthly_cap");
  assert.match(j4.message, /paused.*manually/i);
  assert.equal(aiHits, 3);
  assert.equal(alertsSeen.length, 2);
});

test("Re-review Finding 1: established per-route billing ceilings clamp max_tokens, fail closed on unknown routes, hold caps strictly under overrun/concurrency, and bound contract-violating overbills", async () => {
  // 1A. Established per-route ceilings & max_tokens clamping
  const defaultPricing = parsePricing({});
  assert.deepEqual(
    resolveRouteBillingCeiling(defaultPricing, "openrouter", "google/gemini-3.8-flash", 300),
    { known: true, clampedMaxTokens: 300, billedOutputCeilingTokens: 364, maxOutputTokens: 65536, source: "established_route" }
  );
  assert.deepEqual(
    resolveRouteBillingCeiling(defaultPricing, "gemini", "gemini-3.8-flash", 100000),
    { known: true, clampedMaxTokens: 65536, billedOutputCeilingTokens: 65536, maxOutputTokens: 65536, source: "established_route" }
  );
  assert.equal(estimateOutputUpperBoundTokens(300, { model: "google/gemini-3.8-flash" }), 364);
  assert.equal(estimateOutputUpperBoundTokens(300, { model: "custom/unknown-model" }), null);
  assert.equal(resolveRouteBillingCeiling(defaultPricing, "openrouter", "custom/unknown-model", 300).known, false);

  // Verify outbound max_tokens is actually clamped to the route's ceiling on the request payload
  {
    const db = makeDb();
    const clock = Date.parse("2026-11-26T12:00:00.000Z");
    let sentPayload = null;
    const customPricing = parsePricing({
      AI_MODEL_PRICES_JSON: JSON.stringify({
        "custom/bounded-flash": { inputPer1M: 0.5, outputPer1M: 2.0, maxOutputTokens: 250, thinkingIncludedInMaxTokens: true, providerOverrunTokens: 16 }
      })
    });
    const proxy = createAIProxy(db, {
      aiProvider: "openrouter",
      orKey: "or-key",
      orModel: "custom/bounded-flash",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 2000, // exceeds route ceiling of 250 -> must clamp to 250!
      aiUserMonthlyUsd: 5.0,
      aiGlobalMonthlyUsd: 80.0,
      aiPricing: customPricing,
      now: () => clock,
      log: () => {}
    }, async (url, init) => {
      sentPayload = JSON.parse(init.body);
      return makeOkRes("clamped ok", { prompt_tokens: 50, completion_tokens: 250 });
    });
    try {
      assert.equal(proxy.routeCeilingKnown, true);
      await proxy({ id: "u_clamp" }, { messages: [{ content: "clamp" }] });
      assert.equal(sentPayload.max_tokens, 250, "outbound max_tokens must be clamped to route maxOutputTokens");
    } finally {
      db.close();
    }
  }

  // 1B. Unknown route ceiling fails closed (AI paused) without calling upstream or emitting a false 100% budget alert;
  //     explicit AI_MAX_BILLED_OUTPUT_TOKENS enables it with that exact clamped ceiling.
  {
    const db = makeDb();
    const clock = Date.parse("2026-11-26T12:00:00.000Z");
    let calls = 0;
    const warnings = [];
    const alerts = [];
    const proxyUnknown = createAIProxy(db, {
      aiProvider: "openrouter",
      orKey: "or-key",
      orModel: "custom/unverified-reasoning-model",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 300,
      aiUserMonthlyUsd: 5.0,
      aiGlobalMonthlyUsd: 80.0,
      alertUrl: "https://ntfy.example.com/unknown-route",
      alertFetcher: async () => { alerts.push("alert"); return { status: 200, ok: true }; },
      alertLog: m => warnings.push(m),
      now: () => clock,
      log: () => {}
    }, async () => {
      calls++;
      return makeOkRes("should never run", { prompt_tokens: 10, completion_tokens: 10 });
    });
    try {
      assert.equal(proxyUnknown.routeCeilingKnown, false);
      assert.equal(proxyUnknown.getBudgetStatus("u_unk").globalPaused, true);
      assert.ok(warnings.some(w => /billed-token ceiling/i.test(w)));
      await assert.rejects(
        proxyUnknown({ id: "u_unk" }, { messages: [{ content: "hi" }] }),
        e => e.status === 503 && e.code === "ai_global_monthly_cap"
      );
      await proxyUnknown.flushAlerts();
      assert.equal(calls, 0, "unknown route ceiling must refuse before calling upstream");
      assert.equal(alerts.length, 0, "unknown route ceiling pause must not emit a false $0/$80 budget-exhausted alert");

      // Established Gemini primary with an unknown OpenRouter fallback: Gemini runs, fallback fails closed before calling OpenRouter!
      const dispatchedTargets = [];
      const proxyMixed = createAIProxy(db, {
        aiProvider: "gemini",
        geminiKey: "g-key",
        geminiModel: "gemini-3.8-flash",
        orKey: "or-key",
        orModel: "custom/unverified-fallback",
        aiDaily: 50,
        aiGlobalDaily: 50,
        aiMaxTokens: 300,
        aiUserMonthlyUsd: 5.0,
        aiGlobalMonthlyUsd: 80.0,
        geminiRetryDelays: [],
        now: () => clock,
        log: () => {}
      }, async url => {
        dispatchedTargets.push(url);
        return { ok: false, status: 503, json: async () => ({ error: { code: 503, status: "UNAVAILABLE" } }) };
      });
      await assert.rejects(
        proxyMixed({ id: "u_mix" }, { messages: [{ content: "hi" }] }),
        e => e.status === 503 && e.code === "ai_global_monthly_cap"
      );
      assert.equal(dispatchedTargets.length, 1);
      assert.match(dispatchedTargets[0], /generativelanguage\.googleapis\.com/);

      // Providing an explicit AI_MAX_BILLED_OUTPUT_TOKENS enables the custom model and clamps outbound max_tokens to that ceiling!
      let explicitSent = null;
      const envCeilingPricing = parsePricing({ AI_MAX_BILLED_OUTPUT_TOKENS: "350" });
      const proxyExplicit = createAIProxy(db, {
        aiProvider: "openrouter",
        orKey: "or-key",
        orModel: "custom/explicit-ceiling-model",
        aiDaily: 50,
        aiGlobalDaily: 50,
        aiMaxTokens: 2000,
        aiUserMonthlyUsd: 5.0,
        aiGlobalMonthlyUsd: 80.0,
        aiPricing: envCeilingPricing,
        now: () => clock,
        log: () => {}
      }, async (url, init) => {
        explicitSent = JSON.parse(init.body);
        return makeOkRes("explicit ok", { prompt_tokens: 50, completion_tokens: 350 });
      });
      assert.equal(proxyExplicit.routeCeilingKnown, true);
      await proxyExplicit({ id: "u_exp" }, { messages: [{ content: "hi" }] });
      assert.equal(explicitSent.max_tokens, 350);
    } finally {
      db.close();
    }
  }

  // 1C. Codex exact 300 -> 302 (301 reasoning) repro:
  //     At $0.001344 simultaneous caps, admission is refused before calling upstream; at the established ceiling cap,
  //     302 completion / 301 reasoning settles strictly <= cap, and concurrent calls never exceed either cap!
  for (const reasoningEffort of ["low", undefined]) {
    const db = makeDb();
    const clock = Date.parse("2026-11-26T12:00:00.000Z");
    let calls = 0;
    const proxy = createAIProxy(db, {
      aiProvider: "openrouter",
      orKey: "or-key",
      orModel: "google/gemini-3.8-flash",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 300,
      aiReasoningEffort: reasoningEffort,
      aiUserMonthlyUsd: 0.001344,
      aiGlobalMonthlyUsd: 0.001344,
      now: () => clock,
      log: () => {}
    }, async () => {
      calls++;
      return makeOkRes("ok", {
        prompt_tokens: 292,
        completion_tokens: 302,
        completion_tokens_details: { reasoning_tokens: 301 }
      });
    });
    try {
      await assert.rejects(
        proxy({ id: "u_overrun" }, { messages: [{ content: "test" }] }),
        e => e.status === 503 && e.code === "ai_global_monthly_cap"
      );
      assert.equal(calls, 0, "cap of $0.001344 must refuse before calling upstream");
    } finally {
      db.close();
    }
  }

  // Concurrency proof under established route ceiling: 5 concurrent calls race against a tight cap fitting exactly 2 reservations.
  // Each returns the full 302 completion / 301 reasoning tokens; at most 2 execute and BOTH user and global caps hold strictly (<= cap)!
  {
    const db = makeDb();
    const clock = Date.parse("2026-11-26T12:00:00.000Z");
    const proxyProbe = createAIProxy(db, {
      aiProvider: "openrouter",
      orKey: "or-key",
      orModel: "google/gemini-3.8-flash",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 300,
      aiReasoningEffort: "low",
      now: () => clock,
      log: () => {}
    }, async () => makeOkRes("ok", null));
    const singleReserveUsd = nanosToUsd(proxyProbe.estimateAttemptReserveNanos("openrouter", [{ role: "user", content: "test" }], [], clock).reserveNanos);
    const tightCapUsd = singleReserveUsd * 2;
    let calls = 0;

    const proxy = createAIProxy(db, {
      aiProvider: "openrouter",
      orKey: "or-key",
      orModel: "google/gemini-3.8-flash",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 300,
      aiMaxConcurrent: 5,
      aiReasoningEffort: "low",
      aiUserMonthlyUsd: tightCapUsd,
      aiGlobalMonthlyUsd: tightCapUsd,
      now: () => clock,
      log: () => {}
    }, async () => {
      calls++;
      await new Promise(r => setTimeout(r, 15));
      return makeOkRes("ok", {
        prompt_tokens: 292,
        completion_tokens: 302,
        completion_tokens_details: { reasoning_tokens: 301 }
      });
    });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) => proxy({ id: `u_conc_${i}` }, { messages: [{ content: "test" }] }))
      );
      assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
      assert.equal(results.filter(r => r.status === "rejected").length, 3);
      assert.equal(calls, 2);
      const gSpentUsd = nanosToUsd(db.prepare("SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?").get("2026-11").cost_nanos);
      assert.ok(gSpentUsd <= tightCapUsd, `global spend ${gSpentUsd} must stay strictly <= cap ${tightCapUsd}`);
      for (const row of db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE month = ?").all("2026-11")) {
        assert.ok(nanosToUsd(row.cost_nanos) <= tightCapUsd, "each user's spend must stay strictly <= cap");
      }
    } finally {
      db.close();
    }
  }

  // 1D. Defense-in-depth if a provider violates its own clamped max_tokens contract on an in-flight call:
  //     Prior spend is $0.60 against $1.00 caps; 1 in-flight call reserves R ($0.392 <= $0.40 remaining) while a competing call is blocked.
  //     If that single in-flight call still overbills ($0.50 > R), full actual spend ($1.10) is debited immediately,
  //     80% + 100% alerts fire, every subsequent call is refused until back under cap, and overshoot stays <= R (one bounded reservation).
  {
    const db = makeDb();
    ensureAiBudgetSchema(db);
    const clock = Date.parse("2026-11-26T12:00:00.000Z");
    const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
    db.prepare("INSERT INTO ai_monthly_usage VALUES (?, ?, 1, 300, 300, 0, ?, ?)")
      .run("u_vio", "2026-11", usdToNanos(0.6), "2026-11-26T11:00:00.000Z");
    db.prepare("INSERT INTO ai_global_monthly_usage VALUES (?, 1, 300, 300, 0, ?, ?)")
      .run("2026-11", usdToNanos(0.6), "2026-11-26T11:00:00.000Z");

    const alerts = [];
    let calls = 0;
    let entered;
    const enteredP = new Promise(r => { entered = r; });
    let release;
    const releaseP = new Promise(r => { release = r; });

    const proxy = createAIProxy(db, {
      aiProvider: "openrouter",
      orKey: "or-key",
      orModel: "google/gemini-3.8-flash",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 40, // established ceiling 40 + 64 = 104 output + 292 prompt = 396 tokens = $0.396 <= $0.40 remaining
      aiUserMonthlyUsd: 1.0,
      aiGlobalMonthlyUsd: 1.0,
      aiPricing: pricing,
      alertUrl: "https://ntfy.example.com/overrun-alert",
      alertFetcher: async (url, init) => { alerts.push(init.headers["X-Idempotency-Key"]); return { status: 200, ok: true }; },
      alertLog: () => {},
      now: () => clock,
      log: () => {}
    }, async () => {
      calls++;
      entered();
      await releaseP;
      // Contract-violating provider bills 500 tokens ($0.50 > $0.396 reservation), pushing total to $1.10
      return makeOkRes("overbill", { prompt_tokens: 200, completion_tokens: 300 });
    });
    try {
      const reserveUsd = nanosToUsd(proxy.estimateAttemptReserveNanos("openrouter", [{ role: "user", content: "test" }], [], clock).reserveNanos);
      assert.ok(0.6 + reserveUsd <= 1.0, "first in-flight call must fit within $1.00 cap");

      const inflight = proxy({ id: "u_vio" }, { messages: [{ content: "test" }] });
      await enteredP;

      // Second concurrent call from the same user gets 429 ai_busy, and another user hits global cap!
      await assert.rejects(
        proxy({ id: "u_vio" }, { messages: [{ content: "competing" }] }),
        e => e.status === 429 && e.code === "ai_busy"
      );
      await assert.rejects(
        proxy({ id: "u_vio_other" }, { messages: [{ content: "competing" }] }),
        e => e.status === 503 && e.code === "ai_global_monthly_cap"
      );
      assert.equal(calls, 1);

      release();
      await inflight;
      await proxy.flushAlerts();

      const uSpent = nanosToUsd(db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?").get("u_vio", "2026-11").cost_nanos);
      const gSpent = nanosToUsd(db.prepare("SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?").get("2026-11").cost_nanos);
      assert.equal(roundUsd(uSpent), 1.1);
      assert.equal(roundUsd(gSpent), 1.1);
      assert.ok(uSpent - 1.0 <= reserveUsd, "overshoot must be bounded by at most one in-flight call's reservation");
      assert.ok(gSpent - 1.0 <= reserveUsd, "global overshoot must be bounded by at most one in-flight call's reservation");
      assert.deepEqual(alerts, ["ai-budget:2026-11:80", "ai-budget:2026-11:100"]);

      // Every subsequent call is refused before calling upstream until back under cap
      await assert.rejects(
        proxy({ id: "u_vio" }, { messages: [{ content: "next" }] }),
        e => e.status === 503 && e.code === "ai_global_monthly_cap"
      );
      assert.equal(calls, 1);
    } finally {
      db.close();
    }
  }
});

test("Re-review Finding 2: slow pending alert, midnight crossing during payload serialization, and pre-send month/rate boundary recheck all enforce new-month caps", async () => {
  // 2A. Slow pending alert webhook at 23:59:59.900Z with December capped at $80:
  //     Alert delivery runs asynchronously off the admission/dispatch path so provider dispatch is never delayed into December!
  {
    const db = makeDb();
    ensureAiBudgetSchema(db);
    let clock = Date.parse("2026-11-30T23:59:59.900Z");
    db.prepare("INSERT INTO ai_global_monthly_baseline (month, baseline_nanos, note, updated) VALUES (?, ?, ?, ?)")
      .run("2026-12", usdToNanos(80), "december pre-seeded full", "2026-11-30T23:00:00.000Z");
    db.prepare(
      `INSERT INTO ai_budget_alerts (month, threshold, status, attempts, next_attempt_at, dedupe_key, sent_at, delivered_at, spend_nanos, cap_nanos)
       VALUES ('2026-11', 80, 'pending', 0, 0, 'ai-budget:2026-11:80', '2026-11-30T23:00:00.000Z', NULL, ?, ?)`
    ).run(usdToNanos(65), usdToNanos(80));

    let alertFinished = false;
    let dispatchTimeMs = null;
    let alertStartedBeforeDispatch = false;

    const proxy = createAIProxy(db, {
      aiProvider: "gemini",
      geminiKey: "g-key",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 200,
      aiUserMonthlyUsd: 5.0,
      aiGlobalMonthlyUsd: 80.0,
      alertUrl: "https://ntfy.example.com/slow-alert",
      alertFetcher: async () => {
        if (dispatchTimeMs === null) alertStartedBeforeDispatch = true;
        await new Promise(r => setTimeout(r, 150));
        clock = Date.parse("2026-12-01T00:00:00.150Z");
        alertFinished = true;
        return { status: 200, ok: true };
      },
      alertLog: () => {},
      now: () => clock,
      log: () => {}
    }, async () => {
      dispatchTimeMs = clock;
      assert.equal(alertFinished, false, "provider fetch must NOT wait for slow pending alert webhook");
      return makeOkRes("nov ok", { prompt_tokens: 100, completion_tokens: 100 });
    });

    try {
      const res = await proxy({ id: "u_fast" }, { messages: [{ content: "hi" }] });
      assert.deepEqual(res, { text: "nov ok", truncated: false });
      assert.equal(alertStartedBeforeDispatch, false, "alert delivery must be scheduled asynchronously off the admission path");
      assert.equal(new Date(dispatchTimeMs).toISOString(), "2026-11-30T23:59:59.900Z", "provider dispatched immediately in November");
      await proxy.flushAlerts();
      assert.equal(alertFinished, true);
      assert.equal(db.prepare("SELECT status FROM ai_budget_alerts WHERE month = '2026-11' AND threshold = 80").get().status, "delivered");
    } finally {
      db.close();
    }
  }

  // 2B. Codex third-review exact reproduction: clock crosses 2026-11-30T23:59:59.999Z -> 2026-12-01T00:00:00.001Z
  //     DURING JSON.stringify(payload) (e.g. multi-MB image serialization) while December is capped at $80.
  //     Because serialization happens BEFORE admission and the final check runs immediately before fetcher,
  //     the request MUST be refused under December's cap and NEVER call fetcher or settle into November!
  {
    const db = makeDb();
    ensureAiBudgetSchema(db);
    db.prepare("INSERT INTO ai_global_monthly_baseline (month, baseline_nanos, note, updated) VALUES (?, ?, ?, ?)")
      .run("2026-12", usdToNanos(80), "december capped", "2026-11-30T23:00:00.000Z");

    let clock = Date.parse("2026-11-30T23:59:59.999Z");
    let upstreamCalls = 0;
    let serializedPayloadSeen = false;
    const origStringify = JSON.stringify;
    JSON.stringify = function patchedStringify(val, ...rest) {
      const out = origStringify.call(this, val, ...rest);
      if (val && typeof val === "object" && Array.isArray(val.messages)) {
        serializedPayloadSeen = true;
        clock = Date.parse("2026-12-01T00:00:00.001Z");
      }
      return out;
    };

    const proxy = createAIProxy(db, {
      aiProvider: "gemini",
      geminiKey: "g-key",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 200,
      aiUserMonthlyUsd: 5.0,
      aiGlobalMonthlyUsd: 80.0,
      now: () => clock,
      log: () => {}
    }, async () => {
      upstreamCalls++;
      return makeOkRes("should never dispatch", { prompt_tokens: 100, completion_tokens: 100 });
    });

    try {
      await assert.rejects(
        proxy({ id: "u_ser" }, {
          messages: [{ content: "large meal photo" }],
          images: ["data:image/jpeg;base64," + "A".repeat(1024)]
        }),
        e => e.status === 503 && e.code === "ai_global_monthly_cap"
      );
      assert.equal(serializedPayloadSeen, true, "payload serialization must have occurred before admission");
      assert.equal(upstreamCalls, 0, "provider must NOT be called when midnight crossed during payload serialization");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_budget_reservations").get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_monthly_usage").get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_global_monthly_usage").get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_usage").get().n, 0);
    } finally {
      JSON.stringify = origStringify;
      db.close();
    }
  }

  // 2C. Pre-dispatch month boundary re-check: clock crosses 2026-11-30T23:59:59.900Z -> 2026-12-01T00:00:00.100Z
  //     between reservation and provider send while December is capped at $80 -> MUST release November reservation,
  //     re-admit against December, and REFUSE before calling fetcher!
  {
    const db = makeDb();
    ensureAiBudgetSchema(db);
    db.prepare("INSERT INTO ai_global_monthly_baseline (month, baseline_nanos, note, updated) VALUES (?, ?, ?, ?)")
      .run("2026-12", usdToNanos(80), "december capped", "2026-11-30T23:00:00.000Z");

    const novMs = Date.parse("2026-11-30T23:59:59.900Z");
    const decMs = Date.parse("2026-12-01T00:00:00.100Z");
    let nowCalls = 0;
    // Call 1: started, Call 2: remainingBeforeSerialize, Call 3: remaining, Call 4: reserveAttemptSync (Nov), Call 5+: pre-dispatch sendMs check (Dec!)
    const tickingNow = () => {
      nowCalls++;
      return nowCalls <= 4 ? novMs : decMs;
    };

    let upstreamCalls = 0;
    const proxy = createAIProxy(db, {
      aiProvider: "gemini",
      geminiKey: "g-key",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 200,
      aiUserMonthlyUsd: 5.0,
      aiGlobalMonthlyUsd: 80.0,
      now: tickingNow,
      log: () => {}
    }, async () => {
      upstreamCalls++;
      return makeOkRes("should never dispatch", { prompt_tokens: 100, completion_tokens: 100 });
    });

    try {
      await assert.rejects(
        proxy({ id: "u_roll" }, { messages: [{ content: "boundary" }] }),
        e => e.status === 503 && e.code === "ai_global_monthly_cap"
      );
      assert.equal(upstreamCalls, 0, "provider must NOT be called when month crossed into a capped December before send");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_budget_reservations").get().n, 0, "stale November reservation must be released");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_usage").get().n, 0, "unused November daily count must be rolled back");
    } finally {
      db.close();
    }
  }

  // 2D. Pre-dispatch pricing step-up boundary re-check: clock crosses 2026-12-31T23:59:59.900Z -> 2027-01-01T00:00:00.100Z
  //     ($0.75/$3.75 -> $1.50/$7.50) between reservation and send -> releases 2026-12 reservation, re-admits and settles in 2027-01 at $1.50/$7.50!
  {
    const db = makeDb();
    const dec2026Ms = Date.parse("2026-12-31T23:59:59.900Z");
    const jan2027Ms = Date.parse("2027-01-01T00:00:00.100Z");
    let nowCalls = 0;
    const tickingNow = () => {
      nowCalls++;
      return nowCalls <= 4 ? dec2026Ms : jan2027Ms;
    };

    const proxy = createAIProxy(db, {
      aiProvider: "gemini",
      geminiKey: "g-key",
      geminiModel: "gemini-3.8-flash",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 200,
      aiUserMonthlyUsd: 5.0,
      aiGlobalMonthlyUsd: 80.0,
      now: tickingNow,
      log: () => {}
    }, async () => makeOkRes("2027 ok", { prompt_tokens: 1_000_000, completion_tokens: 0 })); // $1.50 at 2027 rate vs $0.75 at 2026 rate

    try {
      const res = await proxy({ id: "u_2027" }, { messages: [{ content: "new year" }] });
      assert.deepEqual(res, { text: "2027 ok", truncated: false });
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_monthly_usage WHERE month = '2026-12'").get().n, 0);
      const janRow = db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = 'u_2027' AND month = '2027-01'").get();
      assert.equal(roundUsd(nanosToUsd(janRow.cost_nanos)), 1.5, "re-admitted 2027 call must settle at 2027 $1.50/1M rate");
    } finally {
      db.close();
    }
  }
});

test("Concurrency limits: 1 in-flight call per user (blocks Codex two-concurrent-attempts repro) and global AI_MAX_CONCURRENT cap (default 4, env-configurable)", async t => {
  // 1. Codex fourth-review reproduction: two simultaneous calls from the same user under $1 user & global caps
  //    where each reserves $0.456 ($0.912 combined <= $1.00!) and an overbilling provider settles $1.10 per call.
  //    Per-user concurrency = 1 MUST reject the 2nd call immediately with 429 ai_busy (zero provider call)
  //    so total spend is $1.10 (1 call), never $2.20!
  {
    const db = makeDb();
    const clock = Date.parse("2026-11-26T12:00:00.000Z");
    const pricing = parsePricing({ AI_INPUT_PRICE_PER_1M: "1000", AI_OUTPUT_PRICE_PER_1M: "1000" });
    let calls = 0;
    let entered;
    const enteredP = new Promise(r => { entered = r; });
    let release;
    const releaseP = new Promise(r => { release = r; });

    const proxy = createAIProxy(db, {
      aiProvider: "openrouter",
      orKey: "or-key",
      orModel: "google/gemini-3.8-flash",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 100, // reserve = (292 + 164) = 456 tokens = $0.456 ($0.912 for 2 calls <= $1.00 cap!)
      aiUserMonthlyUsd: 1.0,
      aiGlobalMonthlyUsd: 1.0,
      aiPricing: pricing,
      getUserLang: u => (u.id === "u_en" ? "en" : "zh"),
      now: () => clock,
      log: () => {}
    }, async () => {
      calls++;
      entered();
      await releaseP;
      return makeOkRes("overbill", { prompt_tokens: 200, completion_tokens: 900 }); // $1.10
    });

    try {
      assert.equal(proxy.maxConcurrent, 4, "default AI_MAX_CONCURRENT must be 4");
      const singleReserveUsd = nanosToUsd(proxy.estimateAttemptReserveNanos("openrouter", [{ role: "user", content: "test" }], [], clock).reserveNanos);
      assert.ok(singleReserveUsd * 2 <= 1.0, "two reservations alone would fit under $1.00 without per-user concurrency=1");

      const first = proxy({ id: "u_dup" }, { messages: [{ content: "test" }] });
      await enteredP;

      // Second concurrent call from the same user gets friendly 429 ai_busy without touching provider or DB
      await assert.rejects(
        proxy({ id: "u_dup" }, { messages: [{ content: "test" }] }),
        e => e.status === 429 && e.code === "ai_busy" && /稍后再试/.test(e.message)
      );
      await assert.rejects(
        proxy({ id: "u_dup", lang: "en" }, { messages: [{ content: "test" }] }),
        e => e.status === 429 && e.code === "ai_busy" && /busy.*try again/i.test(e.message) && !/[\u3400-\u9fff]/.test(e.message)
      );
      assert.equal(calls, 1, "second concurrent same-user call must never hit provider");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_budget_reservations WHERE uid = ?").get("u_dup").n, 1);

      release();
      await first;

      // Settled spend is $1.10 (one call, NOT $2.20), and subsequent calls are blocked by monthly cap
      const uSpent = roundUsd(nanosToUsd(db.prepare("SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?").get("u_dup", "2026-11").cost_nanos));
      const gSpent = roundUsd(nanosToUsd(db.prepare("SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?").get("2026-11").cost_nanos));
      assert.equal(uSpent, 1.1);
      assert.equal(gSpent, 1.1);

      await assert.rejects(
        proxy({ id: "u_dup" }, { messages: [{ content: "after" }] }),
        e => e.status === 503 && e.code === "ai_global_monthly_cap"
      );
      assert.equal(calls, 1);
    } finally {
      db.close();
    }
  }

  // 2. Per-user slot is always released after success AND after provider error so the user can retry cleanly
  {
    const db = makeDb();
    let step = 0;
    const proxy = createAIProxy(db, {
      aiProvider: "openrouter",
      orKey: "or-key",
      orModel: "google/gemini-3.8-flash",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 100,
      log: () => {}
    }, async () => {
      step++;
      if (step === 1) throw new Error("upstream boom");
      return makeOkRes("recovered", { prompt_tokens: 10, completion_tokens: 10 });
    });
    try {
      await assert.rejects(proxy({ id: "u_rel" }, { messages: [{ content: "fail" }] }), e => e.code === "ai_failed");
      const ok = await proxy({ id: "u_rel" }, { messages: [{ content: "retry" }] });
      assert.deepEqual(ok, { text: "recovered", truncated: false });
      assert.equal(step, 2);
    } finally {
      db.close();
    }
  }

  // 3. Global AI_MAX_CONCURRENT limit (default 4, configurable via env):
  //    distinct users up to maxConcurrent enter; the next distinct user gets 429 ai_busy (zero provider call);
  //    releasing one slot immediately admits the next user.
  for (const configured of [undefined, 2]) {
    const expectedLimit = configured ?? 4;
    const db = makeDb();
    const gates = [];
    const entered = [];
    let calls = 0;

    const proxy = createAIProxy(db, {
      aiProvider: "openrouter",
      orKey: "or-key",
      orModel: "google/gemini-3.8-flash",
      aiDaily: 50,
      aiGlobalDaily: 50,
      aiMaxTokens: 100,
      ...(configured !== undefined ? { aiMaxConcurrent: configured } : {}),
      log: () => {}
    }, async () => {
      const idx = calls++;
      let resolveGate;
      const gateP = new Promise(r => { resolveGate = r; });
      gates.push(resolveGate);
      if (entered[idx]) entered[idx]();
      await gateP;
      return makeOkRes(`ok-${idx}`, { prompt_tokens: 10, completion_tokens: 10 });
    });

    try {
      assert.equal(proxy.maxConcurrent, expectedLimit);
      const inflight = [];
      for (let i = 0; i < expectedLimit; i++) {
        let onEnter;
        const pEnter = new Promise(r => { onEnter = r; });
        entered[i] = onEnter;
        inflight.push(proxy({ id: `u_glob_${i}` }, { messages: [{ content: `req-${i}` }] }));
        await pEnter;
      }
      assert.equal(calls, expectedLimit);

      // (maxConcurrent + 1)-th distinct user MUST get 429 ai_busy with zero provider call!
      await assert.rejects(
        proxy({ id: "u_glob_overflow", lang: "en" }, { messages: [{ content: "overflow" }] }),
        e => e.status === 429 && e.code === "ai_busy" && /busy.*try again/i.test(e.message)
      );
      assert.equal(calls, expectedLimit, "overflow user must never reach provider");

      // Release one slot -> a new user is admitted immediately!
      gates[0]();
      await inflight[0];

      let onExtraEnter;
      const pExtra = new Promise(r => { onExtraEnter = r; });
      entered[expectedLimit] = onExtraEnter;
      const extra = proxy({ id: "u_glob_after" }, { messages: [{ content: "after" }] });
      await pExtra;
      assert.equal(calls, expectedLimit + 1);

      for (let i = 1; i < gates.length; i++) gates[i]();
      await Promise.all([...inflight.slice(1), extra]);
    } finally {
      db.close();
    }
  }

  // 4. Validation of AI_MAX_CONCURRENT (both in createAIProxy and server.js startup) + UI sampleErr("ai_busy") in zh & en
  for (const bad of [0, -1, 1.5, 65, "bogus"]) {
    const db = makeDb();
    try {
      assert.throws(
        () => createAIProxy(db, { aiDaily: 10, aiGlobalDaily: 10, aiMaxTokens: 100, aiMaxConcurrent: bad, orKey: "k" }),
        /AI_MAX_CONCURRENT/
      );
    } finally {
      db.close();
    }
  }
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-ai-conc-env-"));
  t.after(() => fs.rmSync(envDir, { recursive: true, force: true }));
  const badSrv = spawnSync(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: envDir, AI_MAX_CONCURRENT: "0" },
    encoding: "utf8",
    timeout: 5000
  });
  assert.notEqual(badSrv.status, 0);
  assert.match(badSrv.stderr, /AI_MAX_CONCURRENT/);

  const htmlSrc = fs.readFileSync(path.join(ROOT, "app/index.html"), "utf8");
  const appScript = htmlSrc.match(/<script>([\s\S]*?)<\/script>/)[1].split("/* ============ 启动 ============ */")[0];
  for (const lang of ["zh", "en"]) {
    const ctx = vm.createContext({
      window: { ritual: { hosted: true }, location: { hostname: "leanritual.app", search: "" } },
      location: { hostname: "leanritual.app", search: "" },
      document: { documentElement: { lang: lang === "en" ? "en" : "zh-CN" }, addEventListener() {}, querySelector() { return { innerHTML: "" }; } },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      console, URL, URLSearchParams, Date, setTimeout, clearTimeout, Math, JSON, Set, Map, Array, Object, Number, String, Boolean, RegExp
    });
    vm.runInContext(appScript, ctx);
    vm.runInContext(`S.explicitLang = ${JSON.stringify(lang)};`, ctx);
    const msg = vm.runInContext(`sampleErr({ code: "ai_busy" })`, ctx);
    if (lang === "en") {
      assert.match(msg, /busy.*try again/i);
      assert.doesNotMatch(msg, /[\u3400-\u9fff]/);
    } else {
      assert.match(msg, /稍后再试/);
    }
  }
});
