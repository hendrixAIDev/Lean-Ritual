#!/usr/bin/env node
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { createInvitations, normalizeEmail } = require("../lib/invitations");
const { normalizePhone, isSyntheticPhoneEmail } = require("../lib/phone");
const {
  parseBudgets,
  parseNonNegativeNumber,
  usdToNanos,
  nanosToUsd,
  roundUsd,
  ensureAiBudgetSchema
} = require("../lib/ai-pricing");

const USAGE = [
  "Usage:",
  "  node scripts/auth-admin.js invite <email> [--legacy-user <username>]",
  "  node scripts/auth-admin.js invite --phone <E.164 or 11-digit mainland number> [--legacy-user <username>]",
  "  node scripts/auth-admin.js reset-password --phone <E.164 or 11-digit mainland number>",
  "  node scripts/auth-admin.js revoke   (invitation token on stdin)",
  "  node scripts/auth-admin.js ai-cap --phone|--email <id> [--usd <n>|--reset] [--confirm-id <anonId>] [--show-identity] [--month YYYY-MM] [--json]",
  "  node scripts/auth-admin.js ai-usage [--month YYYY-MM] [--limit N] [--show-identity] [--json]",
  "  node scripts/auth-admin.js ai-seed --month <YYYY-MM> --usd <n> [--note <text>] [--json]"
].join("\n");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const TERMINAL_UNSAFE_RE = /[\x00-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;

function escapeTerminalText(value) {
  return String(value ?? "").replace(TERMINAL_UNSAFE_RE, ch => {
    const code = ch.charCodeAt(0);
    return code < 0x100
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function readFlagValue(args, idx, flag) {
  const arg = args[idx];
  if (arg === flag) {
    if (idx + 1 >= args.length || !args[idx + 1]) throw new Error(`Expected value for ${flag}`);
    return { value: args[idx + 1], nextIdx: idx + 1 };
  }
  const value = arg.slice(flag.length + 1);
  if (!value) throw new Error(`Expected value for ${flag}`);
  return { value, nextIdx: idx };
}

function parseMonthFlag(raw) {
  const trimmed = String(raw || "").trim();
  if (!MONTH_RE.test(trimmed)) throw new Error("--month must be YYYY-MM (UTC)");
  return trimmed;
}

function parseInviteArgs(args) {
  let email = null;
  let phone = null;
  let legacyName = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--phone" || arg.startsWith("--phone=")) {
      if (phone !== null || email !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--phone");
      phone = res.value;
      i = res.nextIdx;
    } else if (arg === "--email" || arg.startsWith("--email=")) {
      if (phone !== null || email !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--email");
      email = res.value;
      i = res.nextIdx;
    } else if (arg === "--legacy-user" || arg.startsWith("--legacy-user=")) {
      if (legacyName !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--legacy-user");
      legacyName = res.value;
      i = res.nextIdx;
    } else if (arg.startsWith("-")) {
      throw new Error(USAGE);
    } else if (email === null && phone === null) {
      email = arg;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!email && !phone) throw new Error(USAGE);
  return { email, phone, legacyName };
}

function parseResetArgs(args) {
  let phone = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--phone" || arg.startsWith("--phone=")) {
      if (phone !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--phone");
      phone = res.value;
      i = res.nextIdx;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!phone) throw new Error(USAGE);
  return { phone };
}

function parseAiCapArgs(args) {
  let phone = null;
  let email = null;
  let usd = null;
  let reset = false;
  let confirmId = null;
  let showIdentity = false;
  let month = new Date().toISOString().slice(0, 7);
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--phone" || arg.startsWith("--phone=")) {
      if (phone !== null || email !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--phone");
      phone = res.value;
      i = res.nextIdx;
    } else if (arg === "--email" || arg.startsWith("--email=")) {
      if (phone !== null || email !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--email");
      email = res.value;
      i = res.nextIdx;
    } else if (arg === "--usd" || arg.startsWith("--usd=")) {
      if (usd !== null || reset) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--usd");
      usd = parseNonNegativeNumber(res.value, NaN, "--usd", 1_000_000);
      i = res.nextIdx;
    } else if (arg === "--reset") {
      if (usd !== null || reset) throw new Error(USAGE);
      reset = true;
    } else if (arg === "--confirm-id" || arg.startsWith("--confirm-id=")) {
      if (confirmId !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--confirm-id");
      confirmId = res.value.trim();
      i = res.nextIdx;
    } else if (arg === "--show-identity") {
      showIdentity = true;
    } else if (arg === "--month" || arg.startsWith("--month=")) {
      const res = readFlagValue(args, i, "--month");
      month = parseMonthFlag(res.value);
      i = res.nextIdx;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!phone && !email) throw new Error(USAGE);
  return { phone, email, usd, reset, confirmId, showIdentity, month, json };
}

function parseAiUsageArgs(args) {
  let month = new Date().toISOString().slice(0, 7);
  let limit = 20;
  let showIdentity = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--month" || arg.startsWith("--month=")) {
      const res = readFlagValue(args, i, "--month");
      month = parseMonthFlag(res.value);
      i = res.nextIdx;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const res = readFlagValue(args, i, "--limit");
      const n = Number(res.value);
      if (!Number.isSafeInteger(n) || n < 1 || n > 200) throw new Error("--limit must be an integer between 1 and 200");
      limit = n;
    } else if (arg === "--show-identity") {
      showIdentity = true;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(USAGE);
    }
  }
  return { month, limit, showIdentity, json };
}

function parseAiSeedArgs(args) {
  let month = null;
  let usd = null;
  let note = "";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--month" || arg.startsWith("--month=")) {
      const res = readFlagValue(args, i, "--month");
      month = parseMonthFlag(res.value);
      i = res.nextIdx;
    } else if (arg === "--usd" || arg.startsWith("--usd=")) {
      if (usd !== null) throw new Error(USAGE);
      const res = readFlagValue(args, i, "--usd");
      usd = parseNonNegativeNumber(res.value, NaN, "--usd", 1_000_000);
      i = res.nextIdx;
    } else if (arg === "--note" || arg.startsWith("--note=")) {
      const res = readFlagValue(args, i, "--note");
      note = String(res.value).slice(0, 200);
      i = res.nextIdx;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!month || usd === null) throw new Error(USAGE);
  return { month, usd, note, json };
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function hasColumn(db, table, column) {
  if (!hasTable(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function createAnonHelper(env = process.env) {
  if (typeof env.AUTH_SECRET === "string" && env.AUTH_SECRET.length >= 16) {
    return uid => "u_" + crypto
      .createHmac("sha256", env.AUTH_SECRET)
      .update("lean-ritual:ai-admin:v1:")
      .update(String(uid || ""))
      .digest("hex")
      .slice(0, 8);
  }
  return uid => "u_" + crypto
    .createHash("sha256")
    .update("lean-ritual:ai-admin-no-secret:v1:")
    .update(String(uid || ""))
    .digest("hex")
    .slice(0, 8);
}

function resolveUserContact(row) {
  if (!row) return { email: null, phone: null };
  const phone = typeof row.phoneNumber === "string" && row.phoneNumber.trim() ? row.phoneNumber.trim() : null;
  const rawEmail = typeof row.email === "string" && row.email.trim() ? row.email.trim() : null;
  const email = rawEmail && !isSyntheticPhoneEmail(rawEmail) ? rawEmail : null;
  return { email, phone };
}

function formatContact({ email, phone }) {
  if (phone && email) return `${phone} / ${email}`;
  return phone || email || "(unknown)";
}

function handleAiCap(dataDir, rest) {
  const opts = parseAiCapArgs(rest);
  const budgets = parseBudgets(process.env);
  const authPath = path.join(dataDir, "auth.sqlite");
  if (!fs.existsSync(authPath)) throw new Error("Account not found");

  const authDb = new DatabaseSync(authPath, { readOnly: true });
  let userRow;
  try {
    authDb.exec("PRAGMA busy_timeout=5000");
    if (!hasTable(authDb, "user")) throw new Error("Account not found");
    const hasPhoneCol = hasColumn(authDb, "user", "phoneNumber");
    if (opts.phone) {
      const phone = normalizePhone(opts.phone);
      if (!phone) throw new Error("A valid phone number is required (E.164 or 11-digit mainland China number)");
      if (!hasPhoneCol) throw new Error("Account not found");
      userRow = authDb.prepare("SELECT id, email, phoneNumber FROM user WHERE phoneNumber = ?").get(phone);
    } else {
      const email = normalizeEmail(opts.email);
      if (!email) throw new Error("A valid email address is required");
      userRow = authDb.prepare(
        hasPhoneCol
          ? "SELECT id, email, phoneNumber FROM user WHERE lower(trim(email)) = ?"
          : "SELECT id, email FROM user WHERE lower(trim(email)) = ?"
      ).get(email);
    }
  } finally {
    authDb.close();
  }
  if (!userRow) throw new Error("Account not found");

  const anon = createAnonHelper(process.env);
  const anonId = anon(userRow.id);
  const isWrite = opts.usd !== null || opts.reset;

  // Require an explicit expected account identifier (--confirm-id) before any cap mutation
  // so a typo in --phone/--email matching another account can never silently modify it.
  if (isWrite) {
    if (!opts.confirmId) {
      throw new Error(
        `Refusing to modify cap without --confirm-id. Target resolved to ${anonId}; inspect first and re-run with --confirm-id ${anonId}.`
      );
    }
    if (opts.confirmId !== anonId && opts.confirmId !== userRow.id) {
      throw new Error(
        `Refusing to modify cap: --confirm-id does not match the resolved account (${anonId}).`
      );
    }
  }

  const bojinPath = path.join(dataDir, "bojin.db");
  let overrideNanos = null;
  let monthRow = null;
  let reservedNanos = 0;
  let todayCalls = 0;
  const todayUtc = new Date().toISOString().slice(0, 10);

  if (isWrite || fs.existsSync(bojinPath)) {
    const bojinDb = isWrite ? new DatabaseSync(bojinPath) : new DatabaseSync(bojinPath, { readOnly: true });
    try {
      bojinDb.exec("PRAGMA busy_timeout=5000");
      if (isWrite) {
        ensureAiBudgetSchema(bojinDb);
        const nowIso = new Date().toISOString();
        bojinDb.exec("BEGIN IMMEDIATE");
        try {
          if (opts.reset) {
            bojinDb.prepare("DELETE FROM ai_user_caps WHERE uid = ?").run(userRow.id);
          } else {
            bojinDb.prepare(
              "INSERT INTO ai_user_caps (uid, monthly_usd_nanos, updated) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET monthly_usd_nanos = excluded.monthly_usd_nanos, updated = excluded.updated"
            ).run(userRow.id, usdToNanos(opts.usd), nowIso);
          }
          bojinDb.exec("COMMIT");
        } catch (err) {
          bojinDb.exec("ROLLBACK");
          throw err;
        }
      }
      if (hasTable(bojinDb, "ai_user_caps")) {
        const capRow = bojinDb.prepare("SELECT monthly_usd_nanos FROM ai_user_caps WHERE uid = ?").get(userRow.id);
        if (capRow) overrideNanos = capRow.monthly_usd_nanos;
      }
      if (hasTable(bojinDb, "ai_monthly_usage")) {
        monthRow = bojinDb.prepare(
          "SELECT calls, prompt_tokens, completion_tokens, reasoning_tokens, cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?"
        ).get(userRow.id, opts.month);
      }
      if (hasTable(bojinDb, "ai_budget_reservations")) {
        reservedNanos = bojinDb.prepare(
          "SELECT COALESCE(SUM(reserved_nanos), 0) AS n FROM ai_budget_reservations WHERE uid = ? AND month = ?"
        ).get(userRow.id, opts.month).n;
      }
      if (hasTable(bojinDb, "ai_usage") && hasColumn(bojinDb, "ai_usage", "day")) {
        todayCalls = bojinDb.prepare("SELECT n FROM ai_usage WHERE uid = ? AND day = ?").get(userRow.id, todayUtc)?.n || 0;
      }
    } finally {
      bojinDb.close();
    }
  }

  const contact = resolveUserContact(userRow);
  const capNanos = overrideNanos !== null ? overrideNanos : budgets.userMonthlyNanos;
  const spentNanos = (monthRow?.cost_nanos || 0) + reservedNanos;
  const capUsd = roundUsd(nanosToUsd(capNanos));
  const spentUsd = roundUsd(nanosToUsd(spentNanos));
  const reservedUsd = roundUsd(nanosToUsd(reservedNanos));
  const usedPct = capNanos > 0 ? Math.round((spentNanos / capNanos) * 1000) / 10 : null;
  const out = {
    anonId,
    ...(opts.showIdentity ? { email: contact.email, phone: contact.phone } : {}),
    month: opts.month,
    capUsd,
    capSource: overrideNanos !== null ? "override" : "default",
    defaultCapUsd: budgets.userMonthlyUsd,
    spentUsd,
    ...(reservedNanos > 0 ? { reservedUsd } : {}),
    usedPct,
    calls: monthRow?.calls || 0,
    promptTokens: monthRow?.prompt_tokens || 0,
    completionTokens: monthRow?.completion_tokens || 0,
    reasoningTokens: monthRow?.reasoning_tokens || 0,
    todayCalls
  };

  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const actionNote = opts.reset
    ? ` (reset to default $${budgets.userMonthlyUsd.toFixed(2)})`
    : opts.usd !== null
      ? ` (updated to $${capUsd.toFixed(2)})`
      : "";
  const pctStr = usedPct !== null ? `${usedPct.toFixed(1)}%` : "n/a";
  const identitySuffix = opts.showIdentity ? `  (${escapeTerminalText(formatContact(contact))})` : "";
  console.log([
    `User:   ${escapeTerminalText(out.anonId)}${identitySuffix}`,
    `Month:  ${out.month} (UTC)`,
    `Cap:    $${capUsd.toFixed(2)} [${out.capSource}]${actionNote}`,
    `Spend:  $${spentUsd.toFixed(4)} / $${capUsd.toFixed(2)} (${pctStr})${reservedNanos > 0 ? ` [incl. $${reservedUsd.toFixed(4)} reserved]` : ""}`,
    `Usage:  ${out.calls} calls (today UTC: ${out.todayCalls}) | tokens: in=${out.promptTokens} out=${out.completionTokens} think=${out.reasoningTokens}`
  ].join("\n"));
}

function handleAiUsage(dataDir, rest) {
  const opts = parseAiUsageArgs(rest);
  const budgets = parseBudgets(process.env);
  const bojinPath = path.join(dataDir, "bojin.db");
  const authPath = path.join(dataDir, "auth.sqlite");
  const anon = createAnonHelper(process.env);

  let globalRow = null;
  let baselineNanos = 0;
  let globalReservedNanos = 0;
  let topRows = [];
  const capMap = new Map();

  if (fs.existsSync(bojinPath)) {
    const bojinDb = new DatabaseSync(bojinPath, { readOnly: true });
    try {
      bojinDb.exec("PRAGMA busy_timeout=5000");
      if (hasTable(bojinDb, "ai_global_monthly_usage")) {
        globalRow = bojinDb.prepare(
          "SELECT calls, prompt_tokens, completion_tokens, reasoning_tokens, cost_nanos FROM ai_global_monthly_usage WHERE month = ?"
        ).get(opts.month) || null;
      }
      if (hasTable(bojinDb, "ai_global_monthly_baseline")) {
        baselineNanos = bojinDb.prepare(
          "SELECT baseline_nanos FROM ai_global_monthly_baseline WHERE month = ?"
        ).get(opts.month)?.baseline_nanos || 0;
      }
      if (hasTable(bojinDb, "ai_budget_reservations")) {
        globalReservedNanos = bojinDb.prepare(
          "SELECT COALESCE(SUM(reserved_nanos), 0) AS n FROM ai_budget_reservations WHERE month = ?"
        ).get(opts.month).n;
      }
      if (hasTable(bojinDb, "ai_monthly_usage")) {
        topRows = bojinDb.prepare(
          "SELECT uid, calls, prompt_tokens, completion_tokens, reasoning_tokens, cost_nanos FROM ai_monthly_usage WHERE month = ? ORDER BY cost_nanos DESC, calls DESC, uid ASC LIMIT ?"
        ).all(opts.month, opts.limit);
        if (!globalRow) {
          const sum = bojinDb.prepare(
            "SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens, COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens, COALESCE(SUM(cost_nanos), 0) AS cost_nanos FROM ai_monthly_usage WHERE month = ?"
          ).get(opts.month);
          if (sum && (sum.calls > 0 || sum.cost_nanos > 0)) globalRow = sum;
        }
      }
      if (hasTable(bojinDb, "ai_user_caps")) {
        for (const r of bojinDb.prepare("SELECT uid, monthly_usd_nanos FROM ai_user_caps").all()) {
          capMap.set(r.uid, r.monthly_usd_nanos);
        }
      }
    } finally {
      bojinDb.close();
    }
  }

  const identityMap = new Map();
  if (opts.showIdentity && topRows.length && fs.existsSync(authPath)) {
    const authDb = new DatabaseSync(authPath, { readOnly: true });
    try {
      authDb.exec("PRAGMA busy_timeout=5000");
      if (hasTable(authDb, "user")) {
        const hasPhoneCol = hasColumn(authDb, "user", "phoneNumber");
        const stmt = authDb.prepare(
          hasPhoneCol
            ? "SELECT id, email, phoneNumber FROM user WHERE id = ?"
            : "SELECT id, email FROM user WHERE id = ?"
        );
        for (const row of topRows) {
          const u = stmt.get(row.uid);
          if (u) identityMap.set(row.uid, resolveUserContact(u));
        }
      }
    } finally {
      authDb.close();
    }
  }

  const globalLiveNanos = globalRow?.cost_nanos || 0;
  const globalSpentNanos = globalLiveNanos + baselineNanos + globalReservedNanos;
  const globalSpentUsd = roundUsd(nanosToUsd(globalSpentNanos));
  const baselineUsd = roundUsd(nanosToUsd(baselineNanos));
  const reservedUsd = roundUsd(nanosToUsd(globalReservedNanos));
  const globalUsedPct = budgets.globalMonthlyNanos > 0
    ? Math.round((globalSpentNanos / budgets.globalMonthlyNanos) * 1000) / 10
    : null;
  const globalPaused = budgets.globalMonthlyNanos === 0 || globalSpentNanos >= budgets.globalMonthlyNanos;

  const users = topRows.map((row, idx) => {
    const contact = identityMap.get(row.uid) || { email: null, phone: null };
    const overrideNanos = capMap.has(row.uid) ? capMap.get(row.uid) : null;
    const capNanos = overrideNanos !== null ? overrideNanos : budgets.userMonthlyNanos;
    const spentUsd = roundUsd(nanosToUsd(row.cost_nanos));
    const capUsd = roundUsd(nanosToUsd(capNanos));
    const usedPct = capNanos > 0 ? Math.round((row.cost_nanos / capNanos) * 1000) / 10 : null;
    return {
      rank: idx + 1,
      anonId: anon(row.uid),
      ...(opts.showIdentity ? { email: contact.email, phone: contact.phone } : {}),
      spentUsd,
      capUsd,
      capSource: overrideNanos !== null ? "override" : "default",
      usedPct,
      calls: row.calls,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      reasoningTokens: row.reasoning_tokens
    };
  });

  const payload = {
    month: opts.month,
    identitiesIncluded: opts.showIdentity,
    global: {
      spentUsd: globalSpentUsd,
      baselineUsd,
      reservedUsd,
      budgetUsd: budgets.globalMonthlyUsd,
      usedPct: globalUsedPct,
      paused: globalPaused,
      calls: globalRow?.calls || 0,
      promptTokens: globalRow?.prompt_tokens || 0,
      completionTokens: globalRow?.completion_tokens || 0,
      reasoningTokens: globalRow?.reasoning_tokens || 0
    },
    defaultUserCapUsd: budgets.userMonthlyUsd,
    users
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const statusTag = globalPaused
    ? " [PAUSED]"
    : globalUsedPct !== null && globalUsedPct >= 80
      ? " [>=80%]"
      : "";
  const extraParts = [];
  if (baselineNanos > 0) extraParts.push(`baseline=$${baselineUsd.toFixed(2)}`);
  if (globalReservedNanos > 0) extraParts.push(`reserved=$${reservedUsd.toFixed(4)}`);
  const extraNote = extraParts.length ? ` [${extraParts.join(", ")}]` : "";
  const lines = [
    `AI Monthly Usage (${opts.month} UTC)`,
    `App Total: $${globalSpentUsd.toFixed(4)} / $${budgets.globalMonthlyUsd.toFixed(2)} (${globalUsedPct !== null ? globalUsedPct.toFixed(1) + "%" : "n/a"})${statusTag}${extraNote} | ${payload.global.calls} calls | in=${payload.global.promptTokens} out=${payload.global.completionTokens} think=${payload.global.reasoningTokens}`,
    ""
  ];
  if (!users.length) {
    lines.push("No per-user AI spend recorded for this month.");
  } else {
    lines.push(opts.showIdentity
      ? "Top users (host-only identities shown via --show-identity):"
      : "Top users (pseudonymous; pass --show-identity on host to reveal phone/email):");
    for (const u of users) {
      const capTag = u.capSource === "override" ? " (override)" : "";
      const pctStr = u.usedPct !== null ? `${u.usedPct.toFixed(1)}%` : "n/a";
      const idCol = opts.showIdentity ? `  ${escapeTerminalText(formatContact(u))}` : "";
      lines.push(
        `  ${u.rank}. ${escapeTerminalText(u.anonId)}${idCol}  $${u.spentUsd.toFixed(4)} / $${u.capUsd.toFixed(2)}${capTag} (${pctStr})  ${u.calls} calls  in=${u.promptTokens} out=${u.completionTokens} think=${u.reasoningTokens}`
      );
    }
  }
  console.log(lines.join("\n"));
}

function handleAiSeed(dataDir, rest) {
  const opts = parseAiSeedArgs(rest);
  const budgets = parseBudgets(process.env);
  const bojinPath = path.join(dataDir, "bojin.db");
  const bojinDb = new DatabaseSync(bojinPath);
  let liveNanos = 0;
  try {
    bojinDb.exec("PRAGMA busy_timeout=5000");
    ensureAiBudgetSchema(bojinDb);
    const nowIso = new Date().toISOString();
    const baselineNanos = usdToNanos(opts.usd);
    bojinDb.exec("BEGIN IMMEDIATE");
    try {
      bojinDb.prepare(
        `INSERT INTO ai_global_monthly_baseline (month, baseline_nanos, note, updated)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(month) DO UPDATE SET
           baseline_nanos = excluded.baseline_nanos,
           note = excluded.note,
           updated = excluded.updated`
      ).run(opts.month, baselineNanos, opts.note, nowIso);
      liveNanos = bojinDb.prepare(
        "SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?"
      ).get(opts.month)?.cost_nanos || 0;
      bojinDb.exec("COMMIT");
    } catch (err) {
      bojinDb.exec("ROLLBACK");
      throw err;
    }
  } finally {
    bojinDb.close();
  }

  const baselineUsd = roundUsd(opts.usd);
  const liveUsd = roundUsd(nanosToUsd(liveNanos));
  const totalUsd = roundUsd(baselineUsd + liveUsd);
  const out = {
    month: opts.month,
    baselineUsd,
    liveUsd,
    totalUsd,
    budgetUsd: budgets.globalMonthlyUsd,
    note: opts.note
  };
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(
    `AI rollout baseline set for ${opts.month} (UTC): baseline=$${baselineUsd.toFixed(2)}, live=$${liveUsd.toFixed(4)}, effective total=$${totalUsd.toFixed(4)} / $${budgets.globalMonthlyUsd.toFixed(2)}${opts.note ? ` (${escapeTerminalText(opts.note)})` : ""}`
  );
}

// Operators issue an invitation or a one-time password reset link, never set a
// user's permanent password or mark an email verified.
function main() {
  const [command, ...rest] = process.argv.slice(2);
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  if (!["invite", "revoke", "reset-password", "ai-cap", "ai-usage", "ai-seed"].includes(command)) throw new Error(USAGE);

  if (command === "ai-cap" || command === "ai-usage" || command === "ai-seed") {
    const needsCreateDir = command === "ai-seed" || (command === "ai-cap" && rest.some(a => a === "--usd" || a.startsWith("--usd=") || a === "--reset"));
    if (needsCreateDir) fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(dataDir)) {
      if (command === "ai-cap") throw new Error("Account not found");
      handleAiUsage(dataDir, rest);
      return;
    }
    const releaseDataAccess = require("../lib/data-access").shared(dataDir);
    process.once("exit", releaseDataAccess);
    try {
      if (command === "ai-cap") handleAiCap(dataDir, rest);
      else if (command === "ai-seed") handleAiSeed(dataDir, rest);
      else handleAiUsage(dataDir, rest);
    } finally {
      releaseDataAccess();
    }
    return;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const releaseDataAccess = require("../lib/data-access").shared(dataDir);
  process.once("exit", releaseDataAccess);
  const db = new DatabaseSync(path.join(dataDir, "auth.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (command === "revoke") {
      if (rest.length) throw new Error(USAGE);
      const invitations = createInvitations(db);
      const token = fs.readFileSync(0, "utf8").trim();
      if (!token) throw new Error("Provide invitation token on stdin");
      invitations.revoke(token);
      console.log("Invitation revoked");
      return;
    }
    if (command === "reset-password") {
      const { phone: rawPhone } = parseResetArgs(rest);
      const phone = normalizePhone(rawPhone);
      if (!phone) throw new Error("A valid phone number is required (E.164 or 11-digit mainland China number)");
      if (!hasTable(db, "user") || !hasColumn(db, "user", "phoneNumber") || !hasTable(db, "verification")) {
        throw new Error("Phone account not found");
      }
      const user = db.prepare("SELECT id, phoneNumber FROM user WHERE phoneNumber = ?").get(phone);
      if (!user) throw new Error("Phone account not found");
      const token = crypto.randomBytes(32).toString("base64url");
      const verificationId = crypto.randomBytes(16).toString("base64url");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      db.exec("BEGIN IMMEDIATE");
      try {
        // Re-verify account still exists inside the write transaction and invalidate older reset links.
        if (!db.prepare("SELECT 1 FROM user WHERE id = ? AND phoneNumber = ?").get(user.id, phone)) {
          throw new Error("Phone account not found");
        }
        db.prepare("DELETE FROM verification WHERE value = ? AND identifier LIKE 'reset-password:%'").run(user.id);
        db.prepare("INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
          .run(verificationId, `reset-password:${token}`, user.id, expiresAt.toISOString(), now.toISOString(), now.toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const out = { phone: user.phoneNumber, userId: user.id, token, expiresAt: expiresAt.toISOString() };
      if (process.env.AUTH_BASE_URL) {
        const url = new URL("/login.html", process.env.AUTH_BASE_URL);
        url.searchParams.set("token", token);
        url.searchParams.set("method", "phone");
        out.url = url.href;
      }
      console.error(
        "OPERATOR REMINDER: Confirm the requester's identity out-of-band before sharing this reset link " +
        "(call back the registered phone number or confirm directly with the original inviter). " +
        "Send the link only via a previously established private channel—never to an unverified account or group chat. " +
        "Deny recovery if identity cannot be verified."
      );
      console.log(JSON.stringify(out));
      return;
    }

    const { email, phone, legacyName } = parseInviteArgs(rest);
    const invitations = createInvitations(db);
    let userId;
    if (legacyName) {
      const legacy = new DatabaseSync(path.join(dataDir, "bojin.db"), { readOnly: true });
      try { userId = legacy.prepare("SELECT id FROM users WHERE username = ?").get(legacyName.trim().toLowerCase())?.id; }
      finally { legacy.close(); }
      if (!userId) throw new Error("Legacy user not found");
    }
    const invite = phone
      ? invitations.issuePhone(phone, { userId })
      : invitations.issue(email, { userId });
    if (process.env.AUTH_BASE_URL) {
      const url = new URL("/login.html", process.env.AUTH_BASE_URL);
      url.searchParams.set("invite", invite.token);
      if (invite.phone) url.searchParams.set("phone", invite.phone);
      else url.searchParams.set("email", invite.email);
      invite.url = url.href;
    }
    console.log(JSON.stringify(invite));
  } finally { db.close(); releaseDataAccess(); }
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
