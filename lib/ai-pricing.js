"use strict";

const TOKENS_PER_MILLION = 1_000_000;
const NANOS_PER_USD = 1_000_000_000;
const MAX_PRICE_PER_1M = 100_000;
const MAX_BUDGET_USD = 1_000_000;
const IMAGE_UPPER_BOUND_TOKENS = 4096;
const MESSAGE_OVERHEAD_TOKENS = 32;
const REQUEST_OVERHEAD_TOKENS = 256;
const OUTPUT_OVERRUN_MIN_LOW = 128;
const OUTPUT_OVERRUN_MIN_THINKING = 512;

// Google Vertex / OpenRouter list introductory Gemini 3.8 Flash pricing ($0.75 / $3.75)
// through 2026-12-31 UTC and standard undiscounted pricing ($1.50 / $7.50) starting 2027-01-01 UTC.
const GEMINI_38_STANDARD_EFFECTIVE_MS = Date.UTC(2027, 0, 1, 0, 0, 0);

// Current default gemini-3.8-flash rates (USD per 1M tokens; completion includes reasoning tokens).
const DEFAULT_AI_PRICING = Object.freeze({
  model: "gemini-3.8-flash",
  inputPer1M: 0.75,
  outputPer1M: 3.75
});

const GEMINI_38_STANDARD_PRICING = Object.freeze({
  inputPer1M: 1.50,
  outputPer1M: 7.50
});

// Sensible built-in per-model defaults (USD per 1M tokens).
// outputPer1M applies to both visible completion and thinking/reasoning tokens unless thinkingPer1M is overridden.
// Note: google/gemini-2.5-flash is listed by OpenRouter for retirement on 2026-12-01; retained here only
// for historical logs or explicit overrides, while default OPENROUTER_MODEL uses google/gemini-3.8-flash.
const DEFAULT_MODEL_PRICING = Object.freeze({
  "gemini-3.8-flash": Object.freeze({
    inputPer1M: 0.75,
    outputPer1M: 3.75,
    standardAfterMs: GEMINI_38_STANDARD_EFFECTIVE_MS,
    standardInputPer1M: GEMINI_38_STANDARD_PRICING.inputPer1M,
    standardOutputPer1M: GEMINI_38_STANDARD_PRICING.outputPer1M
  }),
  "google/gemini-3.8-flash": Object.freeze({
    inputPer1M: 0.75,
    outputPer1M: 3.75,
    standardAfterMs: GEMINI_38_STANDARD_EFFECTIVE_MS,
    standardInputPer1M: GEMINI_38_STANDARD_PRICING.inputPer1M,
    standardOutputPer1M: GEMINI_38_STANDARD_PRICING.outputPer1M
  }),
  "gemini-2.5-flash": Object.freeze({ inputPer1M: 0.30, outputPer1M: 2.50 }),
  "google/gemini-2.5-flash": Object.freeze({ inputPer1M: 0.30, outputPer1M: 2.50 })
});

const DEFAULT_AI_BUDGETS = Object.freeze({
  userMonthlyUsd: 5,
  globalMonthlyUsd: 80
});

function hasEnvValue(raw) {
  return raw !== undefined && raw !== null && String(raw).trim() !== "";
}

function parseNonNegativeNumber(raw, fallback, envName, max = Number.POSITIVE_INFINITY) {
  if (!hasEnvValue(raw)) return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0 || n > max) {
    throw new Error(`${envName} must be a non-negative finite number${Number.isFinite(max) ? ` (<= ${max})` : ""}`);
  }
  return n;
}

function parseModelPricesJson(raw) {
  if (!hasEnvValue(raw)) return Object.create(null);
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error("AI_MODEL_PRICES_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AI_MODEL_PRICES_JSON must be a JSON object mapping model names to rates");
  }
  const out = Object.create(null);
  for (const [modelName, spec] of Object.entries(parsed)) {
    const key = String(modelName || "").trim();
    if (!key || key.length > 100 || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error("AI_MODEL_PRICES_JSON contains an invalid model name");
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error(`AI_MODEL_PRICES_JSON[${key}] must be an object with inputPer1M and outputPer1M`);
    }
    const inputPer1M = parseNonNegativeNumber(spec.inputPer1M, NaN, `AI_MODEL_PRICES_JSON[${key}].inputPer1M`, MAX_PRICE_PER_1M);
    const outputPer1M = parseNonNegativeNumber(spec.outputPer1M, NaN, `AI_MODEL_PRICES_JSON[${key}].outputPer1M`, MAX_PRICE_PER_1M);
    if (!Number.isFinite(inputPer1M) || !Number.isFinite(outputPer1M)) {
      throw new Error(`AI_MODEL_PRICES_JSON[${key}] must specify inputPer1M and outputPer1M`);
    }
    const rate = { inputPer1M, outputPer1M };
    if (hasEnvValue(spec.thinkingPer1M)) {
      rate.thinkingPer1M = parseNonNegativeNumber(spec.thinkingPer1M, outputPer1M, `AI_MODEL_PRICES_JSON[${key}].thinkingPer1M`, MAX_PRICE_PER_1M);
    }
    out[key] = Object.freeze(rate);
  }
  return out;
}

function parsePricing(env = process.env) {
  const hasGlobalInput = hasEnvValue(env.AI_INPUT_PRICE_PER_1M);
  const hasGlobalOutput = hasEnvValue(env.AI_OUTPUT_PRICE_PER_1M);
  const hasGeminiInput = hasEnvValue(env.AI_GEMINI_INPUT_PRICE_PER_1M);
  const hasGeminiOutput = hasEnvValue(env.AI_GEMINI_OUTPUT_PRICE_PER_1M);
  const hasOpenRouterInput = hasEnvValue(env.AI_OPENROUTER_INPUT_PRICE_PER_1M);
  const hasOpenRouterOutput = hasEnvValue(env.AI_OPENROUTER_OUTPUT_PRICE_PER_1M);

  const baseInput = parseNonNegativeNumber(
    env.AI_INPUT_PRICE_PER_1M,
    DEFAULT_AI_PRICING.inputPer1M,
    "AI_INPUT_PRICE_PER_1M",
    MAX_PRICE_PER_1M
  );
  const baseOutput = parseNonNegativeNumber(
    env.AI_OUTPUT_PRICE_PER_1M,
    DEFAULT_AI_PRICING.outputPer1M,
    "AI_OUTPUT_PRICE_PER_1M",
    MAX_PRICE_PER_1M
  );
  const modelOverrides = parseModelPricesJson(env.AI_MODEL_PRICES_JSON);

  const gemini = {
    inputPer1M: parseNonNegativeNumber(
      env.AI_GEMINI_INPUT_PRICE_PER_1M,
      baseInput,
      "AI_GEMINI_INPUT_PRICE_PER_1M",
      MAX_PRICE_PER_1M
    ),
    outputPer1M: parseNonNegativeNumber(
      env.AI_GEMINI_OUTPUT_PRICE_PER_1M,
      baseOutput,
      "AI_GEMINI_OUTPUT_PRICE_PER_1M",
      MAX_PRICE_PER_1M
    )
  };
  const openrouter = {
    inputPer1M: parseNonNegativeNumber(
      env.AI_OPENROUTER_INPUT_PRICE_PER_1M,
      baseInput,
      "AI_OPENROUTER_INPUT_PRICE_PER_1M",
      MAX_PRICE_PER_1M
    ),
    outputPer1M: parseNonNegativeNumber(
      env.AI_OPENROUTER_OUTPUT_PRICE_PER_1M,
      baseOutput,
      "AI_OPENROUTER_OUTPUT_PRICE_PER_1M",
      MAX_PRICE_PER_1M
    )
  };

  const models = {};
  for (const [k, v] of Object.entries(DEFAULT_MODEL_PRICING)) {
    models[k] = {
      inputPer1M: v.inputPer1M,
      outputPer1M: v.outputPer1M,
      ...(v.standardAfterMs ? {
        standardAfter: new Date(v.standardAfterMs).toISOString(),
        standardInputPer1M: v.standardInputPer1M,
        standardOutputPer1M: v.standardOutputPer1M
      } : {})
    };
  }
  for (const [k, v] of Object.entries(modelOverrides)) models[k] = { ...v };

  const pricing = {
    modelDefault: DEFAULT_AI_PRICING.model,
    currency: "USD",
    basis: "final-attempt journal tokens or all-attempt live accounting (prompt + completion; completion includes reasoning tokens; per-model defaults with 2027-01-01 standard rate schedule and env overrides)",
    gemini,
    openrouter,
    models
  };

  Object.defineProperty(pricing, "_meta", {
    enumerable: false,
    value: {
      hasGlobalInput,
      hasGlobalOutput,
      hasGeminiInput,
      hasGeminiOutput,
      hasOpenRouterInput,
      hasOpenRouterOutput,
      modelOverrides
    }
  });

  return pricing;
}

function parseBudgets(env = process.env) {
  const userMonthlyUsd = parseNonNegativeNumber(
    env.AI_USER_MONTHLY_USD,
    DEFAULT_AI_BUDGETS.userMonthlyUsd,
    "AI_USER_MONTHLY_USD",
    MAX_BUDGET_USD
  );
  const globalMonthlyUsd = parseNonNegativeNumber(
    env.AI_GLOBAL_MONTHLY_USD,
    DEFAULT_AI_BUDGETS.globalMonthlyUsd,
    "AI_GLOBAL_MONTHLY_USD",
    MAX_BUDGET_USD
  );
  return {
    userMonthlyUsd,
    globalMonthlyUsd,
    userMonthlyNanos: usdToNanos(userMonthlyUsd),
    globalMonthlyNanos: usdToNanos(globalMonthlyUsd)
  };
}

function lookupMap(map, model) {
  if (!map || typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  if (Object.hasOwn(map, trimmed)) return map[trimmed];
  const bare = trimmed.includes("/") ? trimmed.split("/").pop() : trimmed;
  if (bare && Object.hasOwn(map, bare)) return map[bare];
  return null;
}

function effectiveBuiltinRate(entry, atMs) {
  if (entry.standardAfterMs && Number.isFinite(atMs) && atMs >= entry.standardAfterMs) {
    return {
      inputPer1M: entry.standardInputPer1M,
      outputPer1M: entry.standardOutputPer1M,
      thinkingPer1M: entry.standardOutputPer1M
    };
  }
  return {
    inputPer1M: entry.inputPer1M,
    outputPer1M: entry.outputPer1M,
    thinkingPer1M: entry.thinkingPer1M ?? entry.outputPer1M
  };
}

function resolveModelRate(pricing, provider, model, atMs = Date.now()) {
  const p = pricing || parsePricing({});
  const meta = p._meta || {};
  const provRate = provider === "gemini"
    ? p.gemini
    : provider === "openrouter"
      ? p.openrouter
      : null;

  // 1. Explicit AI_MODEL_PRICES_JSON override wins first.
  const explicitModel = lookupMap(meta.modelOverrides, model);
  if (explicitModel) return explicitModel;

  // 2. Built-in per-model default (with scheduled post-intro rate transition when not overridden by env).
  const builtinEntry = lookupMap(DEFAULT_MODEL_PRICING, model);
  const customOrBuiltin = builtinEntry ? effectiveBuiltinRate(builtinEntry, atMs) : lookupMap(p.models, model);
  const hasInputOverride = provider === "gemini"
    ? Boolean(meta.hasGeminiInput || meta.hasGlobalInput)
    : provider === "openrouter"
      ? Boolean(meta.hasOpenRouterInput || meta.hasGlobalInput)
      : Boolean(meta.hasGlobalInput);
  const hasOutputOverride = provider === "gemini"
    ? Boolean(meta.hasGeminiOutput || meta.hasGlobalOutput)
    : provider === "openrouter"
      ? Boolean(meta.hasOpenRouterOutput || meta.hasGlobalOutput)
      : Boolean(meta.hasGlobalOutput);

  if (customOrBuiltin) {
    const inputPer1M = hasInputOverride && provRate ? provRate.inputPer1M : customOrBuiltin.inputPer1M;
    const outputPer1M = hasOutputOverride && provRate ? provRate.outputPer1M : customOrBuiltin.outputPer1M;
    const thinkingPer1M = !hasOutputOverride && customOrBuiltin.thinkingPer1M !== undefined
      ? customOrBuiltin.thinkingPer1M
      : outputPer1M;
    return { inputPer1M, outputPer1M, thinkingPer1M };
  }

  if (provRate) {
    return {
      inputPer1M: provRate.inputPer1M,
      outputPer1M: provRate.outputPer1M,
      thinkingPer1M: provRate.thinkingPer1M ?? provRate.outputPer1M
    };
  }

  const fallback = Number.isFinite(atMs) && atMs >= GEMINI_38_STANDARD_EFFECTIVE_MS
    ? GEMINI_38_STANDARD_PRICING
    : DEFAULT_AI_PRICING;
  return {
    inputPer1M: fallback.inputPer1M,
    outputPer1M: fallback.outputPer1M,
    thinkingPer1M: fallback.outputPer1M
  };
}

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

// Reconcile completion_tokens and reasoning_tokens across OpenAI-compat providers:
// - Standard Gemini OpenAI-compat / OpenRouter includes reasoning_tokens inside completion_tokens.
// - If an upstream reports them separately (detectable when total_tokens >= prompt + completion + reasoning
//   with reasoning > 0, or when reasoning > completion), count both without double-counting standard responses.
function splitOutputTokens({ promptTokens = 0, completionTokens = 0, reasoningTokens = 0, totalTokens = 0 } = {}) {
  const p = nonNegInt(promptTokens);
  const c = nonNegInt(completionTokens);
  const r = nonNegInt(reasoningTokens);
  const t = nonNegInt(totalTokens);
  if (r > 0 && t > 0 && t >= p + c + r) {
    return { visibleOutputTokens: c, thinkingTokens: r, billedOutputTokens: c + r };
  }
  if (r > c) {
    return { visibleOutputTokens: 0, thinkingTokens: r, billedOutputTokens: r };
  }
  return { visibleOutputTokens: c - r, thinkingTokens: r, billedOutputTokens: c };
}

// Strict tokenizer-safe upper bound for a single provider attempt:
// - UTF-8 byte count bounds any UTF-8 BPE/SentencePiece tokenizer (<= 1 token per UTF-8 byte).
// - Images bounded at 4,096 tokens per image (above max Gemini/OpenRouter tiled image cost).
// - Output + thinking bounded by estimateOutputUpperBoundTokens(maxTokens, opts) at the higher of outputPer1M and thinkingPer1M.
function estimatePromptUpperBoundTokens(messages, images) {
  let tokens = REQUEST_OVERHEAD_TOKENS;
  for (const msg of messages || []) {
    tokens += MESSAGE_OVERHEAD_TOKENS;
    if (typeof msg?.content === "string") {
      tokens += Buffer.byteLength(msg.content, "utf8");
    } else if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        if (part?.type === "text" && typeof part.text === "string") {
          tokens += Buffer.byteLength(part.text, "utf8");
        }
      }
    }
  }
  tokens += (Array.isArray(images) ? images.length : 0) * IMAGE_UPPER_BOUND_TOKENS;
  return tokens;
}

// Upper bound on billed output + thinking tokens for a single provider attempt:
// Providers (e.g. OpenRouter reasoning routes) can bill slightly beyond max_tokens for stop/reasoning chunks
// (e.g. 302 completion / 301 reasoning on max_tokens=300) or allocate thinking tokens when effort is unset/medium/high.
function estimateOutputUpperBoundTokens(maxTokens, { reasoningEffort } = {}) {
  const base = nonNegInt(maxTokens);
  if (base === 0) return 0;
  if (reasoningEffort === "low") {
    return base + Math.max(OUTPUT_OVERRUN_MIN_LOW, Math.ceil(base * 0.25));
  }
  return base + Math.max(OUTPUT_OVERRUN_MIN_THINKING, base);
}

function estimateAttemptUpperBoundNanos(messages, images, maxTokens, rate, opts = {}) {
  const upperInputTokens = estimatePromptUpperBoundTokens(messages, images);
  const upperOutputTokens = estimateOutputUpperBoundTokens(maxTokens, opts);
  const maxOutRate = Math.max(rate.outputPer1M, rate.thinkingPer1M ?? rate.outputPer1M);
  return calcUsageCostNanos(
    { promptTokens: upperInputTokens, completionTokens: upperOutputTokens, reasoningTokens: 0 },
    { inputPer1M: rate.inputPer1M, outputPer1M: maxOutRate }
  );
}

function calcCostUsd(promptTokens, completionTokens, rate) {
  return (
    (nonNegInt(promptTokens) / TOKENS_PER_MILLION) * rate.inputPer1M +
    (nonNegInt(completionTokens) / TOKENS_PER_MILLION) * rate.outputPer1M
  );
}

function calcUsageCostUsd(usage, rate) {
  const p = nonNegInt(usage?.promptTokens);
  const { visibleOutputTokens, thinkingTokens } = splitOutputTokens(usage);
  const thinkingRate = rate.thinkingPer1M ?? rate.outputPer1M;
  return (
    (p / TOKENS_PER_MILLION) * rate.inputPer1M +
    (visibleOutputTokens / TOKENS_PER_MILLION) * rate.outputPer1M +
    (thinkingTokens / TOKENS_PER_MILLION) * thinkingRate
  );
}

function usdToNanos(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * NANOS_PER_USD);
}

function nanosToUsd(nanos) {
  const n = Number(nanos);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / NANOS_PER_USD;
}

function roundUsd(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function calcUsageCostNanos(usage, rate) {
  return usdToNanos(calcUsageCostUsd(usage, rate));
}

function ensureAiBudgetSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      uid TEXT NOT NULL,
      day TEXT NOT NULL,
      n INTEGER NOT NULL,
      PRIMARY KEY(uid, day)
    );
    CREATE TABLE IF NOT EXISTS ai_monthly_usage (
      uid TEXT NOT NULL,
      month TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cost_nanos INTEGER NOT NULL DEFAULT 0,
      updated TEXT NOT NULL,
      PRIMARY KEY (uid, month)
    );
    CREATE INDEX IF NOT EXISTS ai_monthly_usage_month ON ai_monthly_usage(month, cost_nanos DESC);
    CREATE TABLE IF NOT EXISTS ai_global_monthly_usage (
      month TEXT PRIMARY KEY,
      calls INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cost_nanos INTEGER NOT NULL DEFAULT 0,
      updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_global_monthly_baseline (
      month TEXT PRIMARY KEY,
      baseline_nanos INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_user_caps (
      uid TEXT PRIMARY KEY,
      monthly_usd_nanos INTEGER NOT NULL,
      updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_budget_reservations (
      id TEXT PRIMARY KEY,
      uid TEXT,
      month TEXT NOT NULL,
      reserved_nanos INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_budget_reservations_month ON ai_budget_reservations(month, uid);
    CREATE TABLE IF NOT EXISTS ai_budget_alerts (
      month TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      dedupe_key TEXT NOT NULL DEFAULT '',
      sent_at TEXT NOT NULL,
      delivered_at TEXT,
      spend_nanos INTEGER NOT NULL,
      cap_nanos INTEGER NOT NULL,
      PRIMARY KEY (month, threshold)
    );
  `);

  // Safe idempotent upgrades for any pre-existing tables from earlier schema revisions.
  const resCols = db.prepare("PRAGMA table_info(ai_budget_reservations)").all();
  const uidCol = resCols.find(c => c.name === "uid");
  const hasCreatedAt = resCols.some(c => c.name === "created_at");
  if ((uidCol && uidCol.notnull) || !hasCreatedAt) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE ai_budget_reservations_new (
          id TEXT PRIMARY KEY,
          uid TEXT,
          month TEXT NOT NULL,
          reserved_nanos INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT 0,
          expires_at INTEGER NOT NULL
        );
        INSERT INTO ai_budget_reservations_new (id, uid, month, reserved_nanos, created_at, expires_at)
        SELECT id, uid, month, reserved_nanos, ${hasCreatedAt ? "created_at" : "0"}, expires_at FROM ai_budget_reservations;
        DROP TABLE ai_budget_reservations;
        ALTER TABLE ai_budget_reservations_new RENAME TO ai_budget_reservations;
        CREATE INDEX IF NOT EXISTS ai_budget_reservations_month ON ai_budget_reservations(month, uid);
      `);
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  }

  const alertCols = new Set(db.prepare("PRAGMA table_info(ai_budget_alerts)").all().map(c => c.name));
  const alertMigrations = [
    ["status", "TEXT NOT NULL DEFAULT 'delivered'"],
    ["attempts", "INTEGER NOT NULL DEFAULT 1"],
    ["next_attempt_at", "INTEGER NOT NULL DEFAULT 0"],
    ["dedupe_key", "TEXT NOT NULL DEFAULT ''"],
    ["delivered_at", "TEXT"]
  ];
  for (const [col, def] of alertMigrations) {
    if (!alertCols.has(col)) {
      db.exec(`ALTER TABLE ai_budget_alerts ADD COLUMN ${col} ${def}`);
    }
  }
}

module.exports = {
  TOKENS_PER_MILLION,
  NANOS_PER_USD,
  IMAGE_UPPER_BOUND_TOKENS,
  GEMINI_38_STANDARD_EFFECTIVE_MS,
  DEFAULT_AI_PRICING,
  GEMINI_38_STANDARD_PRICING,
  DEFAULT_MODEL_PRICING,
  DEFAULT_AI_BUDGETS,
  parseNonNegativeNumber,
  parsePricing,
  parseBudgets,
  resolveModelRate,
  splitOutputTokens,
  estimatePromptUpperBoundTokens,
  estimateOutputUpperBoundTokens,
  estimateAttemptUpperBoundNanos,
  calcCostUsd,
  calcUsageCostUsd,
  calcUsageCostNanos,
  usdToNanos,
  nanosToUsd,
  roundUsd,
  ensureAiBudgetSchema
};
