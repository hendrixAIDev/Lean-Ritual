"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { DatabaseSync, backup } = require("node:sqlite");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TOKENS_PER_MILLION = 1_000_000;
const FEEDBACK_EXCERPT_CHARS = 80;
const FEEDBACK_NEWEST_LIMIT = 3;
const DEFAULT_UNIT = "bojin.service";
const DEFAULT_BACKUP_ROOT = "/var/backups/bojin";
const DEFAULT_DEPLOY_BACKUP_ROOT = "/var/backups/bojin-deploy";

// Observed gemini-3.8-flash rates (USD per 1M tokens; completion includes reasoning tokens).
const DEFAULT_AI_PRICING = Object.freeze({
  model: "gemini-3.8-flash",
  inputPer1M: 0.75,
  outputPer1M: 3.75
});

const TERMINAL_UNSAFE_INLINE_RE = /[\x00-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_RE = /\b(?:(?:sk|pk|ghp|gho|AIza|LTAI|eyJ)[A-Za-z0-9._-]{8,}|(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z_-]*\d)(?=[\d_-]*[A-Za-z])[A-Za-z0-9_-]{20,})\b/g;
const PHONE_RE = /(?<!\d)\+?\d(?:[\d\s().-]{5,}\d)/g;
const LONG_DIGITS_RE = /\d{5,}/g;
const DAY_DOC_RE = /^data\/users\/([^/]+)\/app\/days\/(\d{4}-\d{2}-\d{2})$/;
const DAILY_SNAP_RE = /^snapshot-(\d{8}T\d{6}Z)$/;
const DEPLOY_SNAP_RE = /^(\d{8}T\d{6}Z)-[A-Za-z0-9_]{8}$/;
const BASE36_UID_RE = /^[0-9a-z]{10,14}$/;
const SAFE_MODEL_RE = /^[A-Za-z0-9._:/-]{1,80}$/;
const MIN_UID_EPOCH_MS = Date.UTC(2020, 0, 1);

const USAGE = [
  "Usage: node scripts/daily-summary.js [--json] [--since <YYYY-MM-DD|ISO>] [--now <ISO>]",
  "  [--journal-file <path|->] [--unit <systemd-unit>]",
  "  [--backup-root <dir>] [--deploy-backup-root <dir>]",
  "  [--include-feedback-excerpts] [--no-journal] [--no-systemd] [--help]"
].join("\n");

function escapeTerminalChar(ch) {
  const code = ch.charCodeAt(0);
  return code < 0x100
    ? `\\x${code.toString(16).padStart(2, "0")}`
    : `\\u${code.toString(16).padStart(4, "0")}`;
}

function escapeTerminalText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(TERMINAL_UNSAFE_INLINE_RE, escapeTerminalChar);
}

// Per-report ephemeral 256-bit HMAC key prevents offline candidate-table matching
// and cross-report correlation while still allowing within-report grouping.
function createReportPseudonymizer(key = crypto.randomBytes(32)) {
  if (!Buffer.isBuffer(key) || key.length < 16) {
    throw new Error("Report pseudonymizer key must be a Buffer of at least 16 bytes");
  }
  const hmacHex = (domain, value) => crypto
    .createHmac("sha256", key)
    .update("lean-ritual:daily-summary:v2:")
    .update(domain)
    .update(":")
    .update(String(value ?? ""))
    .digest("hex")
    .slice(0, 8);
  return {
    user(uid) { return `u_${hmacHex("uid", uid)}`; },
    feedback(id) { return `fb_${hmacHex("feedback", id)}`; }
  };
}

function parseNonNegativeNumber(raw, fallback, envName) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${envName} must be a non-negative finite number`);
  }
  return n;
}

function parsePricing(env = process.env) {
  const baseInput = parseNonNegativeNumber(
    env.AI_INPUT_PRICE_PER_1M,
    DEFAULT_AI_PRICING.inputPer1M,
    "AI_INPUT_PRICE_PER_1M"
  );
  const baseOutput = parseNonNegativeNumber(
    env.AI_OUTPUT_PRICE_PER_1M,
    DEFAULT_AI_PRICING.outputPer1M,
    "AI_OUTPUT_PRICE_PER_1M"
  );
  return {
    modelDefault: DEFAULT_AI_PRICING.model,
    currency: "USD",
    basis: "final-attempt journal tokens (prompt + completion; completion includes reasoning tokens; flat provider rate across models)",
    gemini: {
      inputPer1M: parseNonNegativeNumber(
        env.AI_GEMINI_INPUT_PRICE_PER_1M,
        baseInput,
        "AI_GEMINI_INPUT_PRICE_PER_1M"
      ),
      outputPer1M: parseNonNegativeNumber(
        env.AI_GEMINI_OUTPUT_PRICE_PER_1M,
        baseOutput,
        "AI_GEMINI_OUTPUT_PRICE_PER_1M"
      )
    },
    openrouter: {
      inputPer1M: parseNonNegativeNumber(
        env.AI_OPENROUTER_INPUT_PRICE_PER_1M,
        baseInput,
        "AI_OPENROUTER_INPUT_PRICE_PER_1M"
      ),
      outputPer1M: parseNonNegativeNumber(
        env.AI_OPENROUTER_OUTPUT_PRICE_PER_1M,
        baseOutput,
        "AI_OPENROUTER_OUTPUT_PRICE_PER_1M"
      )
    }
  };
}

function parseTimestampMs(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value >= 1e12) return Math.trunc(value);
    if (value >= 1e9) return Math.trunc(value * 1000);
    return null;
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s === "n/a" || s === "0") return null;
  if (/^@\d+(?:\.\d+)?$/.test(s)) {
    const sec = Number(s.slice(1));
    return Number.isFinite(sec) && sec > 0 ? Math.trunc(sec * 1000) : null;
  }
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}T00:00:00.000Z`);
    if (!Number.isFinite(ms)) return null;
    if (new Date(ms).toISOString().slice(0, 10) !== s) return null;
    return ms;
  }
  const normalized = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function parseCompactUtcStamp(stamp) {
  const m = String(stamp || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}.000Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  if (new Date(ms).toISOString() !== iso) return null;
  return { ms, iso };
}

function parseOptionDate(raw, flagName) {
  const ms = parseTimestampMs(raw);
  if (ms === null) {
    throw new Error(`${flagName} must be a valid YYYY-MM-DD or ISO-8601 timestamp`);
  }
  return ms;
}

function parseCliArgs(argv, env = process.env) {
  const opts = {
    json: false,
    help: false,
    sinceMs: null,
    nowMs: null,
    journalFile: env.SUMMARY_JOURNAL_FILE ? env.SUMMARY_JOURNAL_FILE.trim() : null,
    unit: (env.SUMMARY_SYSTEMD_UNIT || DEFAULT_UNIT).trim() || DEFAULT_UNIT,
    backupRoot: env.BACKUP_ROOT ? env.BACKUP_ROOT.trim() : DEFAULT_BACKUP_ROOT,
    deployBackupRoot: env.DEPLOY_BACKUP_ROOT ? env.DEPLOY_BACKUP_ROOT.trim() : DEFAULT_DEPLOY_BACKUP_ROOT,
    includeFeedbackExcerpts: false,
    noJournal: false,
    noSystemd: false
  };

  if (env.TRIAL_START && env.TRIAL_START.trim()) {
    opts.sinceMs = parseOptionDate(env.TRIAL_START.trim(), "TRIAL_START");
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readVal = (flag) => {
      const val = arg === flag ? argv[++i] : arg.slice(flag.length + 1);
      if (val === undefined || val === "") throw new Error(`${flag} requires a value`);
      return val;
    };

    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--include-feedback-excerpts") {
      opts.includeFeedbackExcerpts = true;
    } else if (arg === "--no-journal") {
      opts.noJournal = true;
    } else if (arg === "--no-systemd") {
      opts.noSystemd = true;
    } else if (arg === "--since" || arg.startsWith("--since=")) {
      opts.sinceMs = parseOptionDate(readVal("--since"), "--since");
    } else if (arg === "--now" || arg.startsWith("--now=")) {
      opts.nowMs = parseOptionDate(readVal("--now"), "--now");
    } else if (arg === "--journal-file" || arg.startsWith("--journal-file=")) {
      opts.journalFile = readVal("--journal-file");
    } else if (arg === "--unit" || arg.startsWith("--unit=")) {
      const val = readVal("--unit").trim();
      if (!/^[A-Za-z0-9@._:-]{1,128}$/.test(val)) throw new Error("Invalid --unit value");
      opts.unit = val;
    } else if (arg === "--backup-root" || arg.startsWith("--backup-root=")) {
      opts.backupRoot = readVal("--backup-root");
    } else if (arg === "--deploy-backup-root" || arg.startsWith("--deploy-backup-root=")) {
      opts.deployBackupRoot = readVal("--deploy-backup-root");
    } else {
      throw new Error(USAGE);
    }
  }

  return opts;
}

// Read-only, zero-lease SQLite snapshot into a private 0700 temp directory.
// - Never calls dataAccess.shared(), so scheduled backups (exclusive lease) are never blocked.
// - When no WAL/SHM sidecars exist (quiescent DB or verified snapshot), copies the file
//   directly without opening sourcePath, leaving zero files or WAL/SHM sidecars in DATA_DIR
//   (works even when DATA_DIR is 0500 read-only).
// - When WAL/SHM sidecars exist (live server), uses SQLite's online backup() API and closes
//   sourceDb immediately so WAL checkpoints are never delayed during table scans.
async function snapshotDbToTemp(sourcePath, tempPath) {
  const st = fs.lstatSync(sourcePath);
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new Error(`Refusing non-regular database file: ${path.basename(sourcePath)}`);
  }
  const walPath = `${sourcePath}-wal`;
  const shmPath = `${sourcePath}-shm`;
  if (!fs.existsSync(walPath) && !fs.existsSync(shmPath)) {
    fs.copyFileSync(sourcePath, tempPath);
    fs.chmodSync(tempPath, 0o600);
    if (!fs.existsSync(walPath) && !fs.existsSync(shmPath)) {
      return;
    }
    fs.rmSync(tempPath, { force: true });
  }
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    src.exec("PRAGMA busy_timeout = 5000");
    await backup(src, tempPath);
  } finally {
    src.close();
  }
  fs.chmodSync(tempPath, 0o600);
}

function hasTable(db, tableName) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function hasCheckin(day) {
  const c = day?.checkin;
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  return Object.values(c).some(v => v !== null && v !== undefined && String(v).trim() !== "");
}

function decodeMealUidMs(id, maxMs) {
  if (typeof id !== "string" || !BASE36_UID_RE.test(id)) return null;
  const ms = Number.parseInt(id.slice(0, 8), 36);
  if (!Number.isFinite(ms) || ms < MIN_UID_EPOCH_MS || ms > maxMs + MS_PER_DAY) return null;
  return ms;
}

function resolveMealTimestampMs(meal, docUpdatedMs, nowMs) {
  const explicit = parseTimestampMs(meal?.createdAt ?? meal?.at);
  if (explicit !== null) return explicit;
  const fromId = decodeMealUidMs(meal?.id, nowMs);
  if (fromId !== null) return fromId;
  const fromEst = parseTimestampMs(meal?.est?.at);
  if (fromEst !== null) return fromEst;
  return docUpdatedMs;
}

function messageCharLength(message) {
  const cleaned = String(message ?? "").replace(/\r\n?/g, "\n").trim();
  return Array.from(cleaned).length;
}

// Opt-in only (--include-feedback-excerpts): redacts URLs, emails, tokens, phone numbers,
// and long digit runs, strips control/bidi chars, and truncates to maxChars code points.
function sanitizeFeedbackExcerpt(message, maxChars = FEEDBACK_EXCERPT_CHARS) {
  const normalized = String(message ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\n]+/g, " ")
    .replace(TERMINAL_UNSAFE_INLINE_RE, " ")
    .replace(URL_RE, "[url]")
    .replace(EMAIL_RE, "[email]")
    .replace(TOKEN_RE, "[token]")
    .replace(PHONE_RE, "[number]")
    .replace(LONG_DIGITS_RE, "[number]")
    .replace(/\s{2,}/g, " ")
    .trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return { excerpt: normalized, truncated: false };
  }
  return {
    excerpt: chars.slice(0, maxChars).join(""),
    truncated: true
  };
}

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function parseKeyValues(str) {
  const out = Object.create(null);
  const parts = str.trim().split(/\s+/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    out[key] = val;
  }
  return out;
}

function parseJournalLine(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line) return null;

  let timestampMs = null;
  let message = line;

  if (line.startsWith("{")) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry.MESSAGE === "string") {
        message = entry.MESSAGE;
      } else if (Array.isArray(entry.MESSAGE)) {
        message = Buffer.from(entry.MESSAGE.filter(n => Number.isInteger(n) && n >= 0 && n <= 255)).toString("utf8");
      } else {
        return null;
      }
      const rt = entry.__REALTIME_TIMESTAMP ?? entry._SOURCE_REALTIME_TIMESTAMP;
      if (rt !== undefined && rt !== null && /^\d+$/.test(String(rt))) {
        timestampMs = Math.floor(Number(rt) / 1000);
      }
    } catch {
      return null;
    }
  } else {
    const shortIso = line.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s+\S+\s+[^:]+:\s+(.*)$/
    );
    if (shortIso) {
      timestampMs = parseTimestampMs(shortIso[1]);
      message = shortIso[2];
    } else {
      const prefixed = line.match(
        /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s+((?:ai|client-error)\s+.*)$/
      );
      if (prefixed) {
        timestampMs = parseTimestampMs(prefixed[1]);
        message = prefixed[2];
      }
    }
  }

  if (message.startsWith("ai ")) {
    const kv = parseKeyValues(message.slice(3));
    if (kv.kind === undefined || kv.prompt === undefined || kv.completion === undefined) {
      return null;
    }
    const rawProvider = kv.provider;
    let provider;
    if (rawProvider === "gemini" || rawProvider === "openrouter") {
      provider = rawProvider;
    } else if (rawProvider === undefined) {
      // Legacy pre-provider log format (OpenRouter was the sole provider).
      provider = "openrouter";
    } else {
      provider = "other";
    }
    const empty = kv.empty === "true";
    const finishReason = kv.finish_reason || "other";
    const model = typeof kv.model === "string" && SAFE_MODEL_RE.test(kv.model) ? kv.model : "unknown";
    return {
      kind: "ai",
      timestampMs,
      provider,
      model,
      providerFallback: kv.provider_fallback === "true",
      retries: nonNegInt(kv.retries),
      promptTokens: nonNegInt(kv.prompt),
      completionTokens: nonNegInt(kv.completion),
      reasoningTokens: nonNegInt(kv.reasoning),
      empty,
      finishReason,
      isError: empty || finishReason === "error"
    };
  }

  if (message.startsWith("client-error ")) {
    const msgIdx = message.indexOf(" msg=");
    const metaPart = msgIdx >= 0 ? message.slice(13, msgIdx) : message.slice(13);
    const kv = parseKeyValues(metaPart);
    if (kv.auth === undefined || kv.name === undefined) {
      return null;
    }
    const eventTs = timestampMs !== null ? timestampMs : parseTimestampMs(kv.ts);
    return {
      kind: "client-error",
      timestampMs: eventTs,
      auth: kv.auth,
      page: kv.page || "unknown",
      name: kv.name || "Error",
      source: kv.source || "unknown"
    };
  }

  return null;
}

function parseJournalStream(text) {
  const aiEvents = [];
  const clientErrors = [];
  let aiEventsWithoutTimestamp = 0;
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseJournalLine(line);
    if (!parsed) continue;
    if (parsed.kind === "ai") {
      aiEvents.push(parsed);
      if (parsed.timestampMs === null) aiEventsWithoutTimestamp++;
    } else if (parsed.kind === "client-error") {
      clientErrors.push(parsed);
    }
  }
  return { aiEvents, clientErrors, aiEventsWithoutTimestamp };
}

function defaultRunCommand(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      timeout: opts.timeout ?? 15000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { status: 0, stdout, stderr: "", error: null };
  } catch (err) {
    return {
      status: typeof err.status === "number" ? err.status : null,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr: typeof err.stderr === "string" ? err.stderr : "",
      error: err
    };
  }
}

function formatJournalctlSince(ms) {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function loadJournal({ journalFile, unit, fetchSinceMs, noJournal, runCommand = defaultRunCommand }) {
  if (noJournal) {
    return {
      status: "disabled",
      source: "disabled",
      note: "journal reading disabled (--no-journal)",
      aiEvents: [],
      clientErrors: [],
      aiEventsWithoutTimestamp: 0
    };
  }

  if (journalFile) {
    const raw = journalFile === "-"
      ? fs.readFileSync(0, "utf8")
      : fs.readFileSync(journalFile, "utf8");
    const parsed = parseJournalStream(raw);
    const note = parsed.aiEventsWithoutTimestamp > 0
      ? "some AI log lines lacked timestamps; use journalctl -o json or -o short-iso for accurate 24h counts"
      : null;
    return {
      status: "ok",
      source: journalFile === "-" ? "stdin" : "file",
      note,
      ...parsed
    };
  }

  const args = ["-u", unit, "-o", "json", "--no-pager"];
  if (fetchSinceMs !== null) {
    args.push("--since", formatJournalctlSince(fetchSinceMs));
  }
  const res = runCommand("journalctl", args);
  const permHint = /insufficient permissions|not seeing messages|permission denied/i.test(res.stderr || "");

  if (res.error && res.error.code === "ENOENT") {
    return {
      status: "unavailable",
      source: "journalctl",
      note: "journalctl not found on this host",
      aiEvents: [],
      clientErrors: [],
      aiEventsWithoutTimestamp: 0
    };
  }
  if (res.status !== 0) {
    return {
      status: permHint ? "permission_denied" : "error",
      source: "journalctl",
      note: permHint
        ? "insufficient permissions to read systemd journal (pipe journalctl via --journal-file -)"
        : `journalctl exited with status ${res.status ?? "unknown"}`,
      aiEvents: [],
      clientErrors: [],
      aiEventsWithoutTimestamp: 0
    };
  }
  if (!res.stdout.trim() && permHint) {
    return {
      status: "permission_denied",
      source: "journalctl",
      note: "no journal entries visible for this user (pipe journalctl via --journal-file -)",
      aiEvents: [],
      clientErrors: [],
      aiEventsWithoutTimestamp: 0
    };
  }
  const parsed = parseJournalStream(res.stdout);
  return {
    status: "ok",
    source: "journalctl",
    note: null,
    ...parsed
  };
}

function emptyProviderStats(withFallback = false) {
  const base = {
    calls: 0,
    errors: 0,
    retries: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
    models: []
  };
  if (withFallback) {
    return { ...base, fallbackCalls: 0, primaryCalls: 0 };
  }
  return base;
}

function calcCostUsd(promptTokens, completionTokens, rate) {
  return (
    (promptTokens / TOKENS_PER_MILLION) * rate.inputPer1M +
    (completionTokens / TOKENS_PER_MILLION) * rate.outputPer1M
  );
}

function roundUsd(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function aggregateAiEvents(events, pricing, { minMs, maxMs, allowNullTs = false }) {
  const gemini = emptyProviderStats(false);
  const openrouter = emptyProviderStats(true);
  const other = emptyProviderStats(false);
  const geminiModels = new Set();
  const openrouterModels = new Set();
  const otherModels = new Set();

  for (const ev of events) {
    if (ev.timestampMs === null) {
      if (!allowNullTs) continue;
    } else {
      if (minMs !== null && ev.timestampMs < minMs) continue;
      if (ev.timestampMs > maxMs) continue;
    }
    const bucket = ev.provider === "gemini"
      ? gemini
      : ev.provider === "openrouter"
        ? openrouter
        : other;
    const modelSet = ev.provider === "gemini"
      ? geminiModels
      : ev.provider === "openrouter"
        ? openrouterModels
        : otherModels;

    bucket.calls++;
    if (ev.isError) bucket.errors++;
    if (ev.model && ev.model !== "unknown") modelSet.add(ev.model);

    // In lib/ai.js, transient backoff retries happen on Gemini prior to any OpenRouter
    // fallback. Attribute retries on provider_fallback=true calls back to Gemini so they
    // are never lost or misattributed to OpenRouter.
    if (ev.provider === "openrouter" && ev.providerFallback) {
      gemini.retries += ev.retries;
    } else {
      bucket.retries += ev.retries;
    }

    bucket.promptTokens += ev.promptTokens;
    bucket.completionTokens += ev.completionTokens;
    bucket.reasoningTokens += ev.reasoningTokens;
    if (ev.provider === "openrouter") {
      if (ev.providerFallback) openrouter.fallbackCalls++;
      else openrouter.primaryCalls++;
    }
  }

  gemini.models = [...geminiModels].sort();
  openrouter.models = [...openrouterModels].sort();
  other.models = [...otherModels].sort();

  gemini.estimatedCostUsd = roundUsd(calcCostUsd(gemini.promptTokens, gemini.completionTokens, pricing.gemini));
  openrouter.estimatedCostUsd = roundUsd(
    calcCostUsd(openrouter.promptTokens, openrouter.completionTokens, pricing.openrouter)
  );
  // Never assign Gemini rates to unknown providers.
  other.estimatedCostUsd = null;

  const byProvider = { gemini, openrouter };
  if (other.calls > 0) byProvider.other = other;

  const calls = gemini.calls + openrouter.calls + other.calls;
  const errors = gemini.errors + openrouter.errors + other.errors;
  const promptTokens = gemini.promptTokens + openrouter.promptTokens + other.promptTokens;
  const completionTokens = gemini.completionTokens + openrouter.completionTokens + other.completionTokens;
  const reasoningTokens = gemini.reasoningTokens + openrouter.reasoningTokens + other.reasoningTokens;
  const estimatedCostUsd = roundUsd(gemini.estimatedCostUsd + openrouter.estimatedCostUsd);

  return {
    calls,
    errors,
    unpricedCalls: other.calls,
    promptTokens,
    completionTokens,
    reasoningTokens,
    estimatedCostUsd,
    byProvider
  };
}

function aggregateClientErrors(events, { minMs, maxMs, allowNullTs = false }) {
  let count = 0;
  const byName = Object.create(null);
  const byPage = Object.create(null);

  for (const ev of events) {
    if (ev.timestampMs === null) {
      if (!allowNullTs) continue;
    } else {
      if (minMs !== null && ev.timestampMs < minMs) continue;
      if (ev.timestampMs > maxMs) continue;
    }
    count++;
    byName[ev.name] = (byName[ev.name] || 0) + 1;
    byPage[ev.page] = (byPage[ev.page] || 0) + 1;
  }

  return { count, byName: { ...byName }, byPage: { ...byPage } };
}

function sumDirBytesSafe(dirPath) {
  let totalBytes = 0;
  let fileCount = 0;
  function walk(cur) {
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        try {
          const st = fs.lstatSync(full);
          if (st.isFile() && !st.isSymbolicLink()) {
            totalBytes += st.size;
            fileCount++;
          }
        } catch {}
      }
    }
  }
  walk(dirPath);
  return { bytes: totalBytes, files: fileCount };
}

function nearestExistingDir(targetPath) {
  let cur = path.resolve(targetPath);
  while (true) {
    try {
      if (fs.existsSync(cur)) return cur;
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return "/";
    cur = parent;
  }
}

function inspectStorage(dataDir) {
  const probePath = nearestExistingDir(dataDir);
  let disk = null;
  try {
    const st = fs.statfsSync(probePath);
    const bsize = Number(st.bsize || st.frsize || 0);
    if (bsize > 0) {
      const totalBytes = Number(st.blocks) * bsize;
      const freeBytes = Number(st.bfree) * bsize;
      const availableBytes = Number(st.bavail) * bsize;
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const denom = usedBytes + availableBytes;
      const usedPercent = denom > 0 ? Math.round((usedBytes / denom) * 1000) / 10 : 0;
      disk = {
        path: probePath,
        totalBytes,
        usedBytes,
        availableBytes,
        usedPercent
      };
    }
  } catch {}

  const dataDirExists = fs.existsSync(dataDir);
  const dataDirTotals = dataDirExists ? sumDirBytesSafe(dataDir) : { bytes: 0, files: 0 };
  const blobsTotals = dataDirExists ? sumDirBytesSafe(path.join(dataDir, "blobs")) : { bytes: 0, files: 0 };

  let dbBytes = 0;
  if (dataDirExists) {
    for (const name of [
      "bojin.db", "bojin.db-wal", "bojin.db-shm",
      "auth.sqlite", "auth.sqlite-wal", "auth.sqlite-shm"
    ]) {
      const p = path.join(dataDir, name);
      try {
        const st = fs.lstatSync(p);
        if (st.isFile() && !st.isSymbolicLink()) dbBytes += st.size;
      } catch {}
    }
  }

  return {
    disk,
    dataDirPath: dataDir,
    dataDirExists,
    dataDirBytes: dataDirTotals.bytes,
    dbBytes,
    blobsDiskBytes: blobsTotals.bytes,
    blobsDiskCount: blobsTotals.files
  };
}

function readManifestCreated(manifestPath) {
  try {
    const st = fs.lstatSync(manifestPath);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const ms = parseTimestampMs(raw?.created);
    return ms !== null ? { ms, iso: new Date(ms).toISOString() } : null;
  } catch {
    return null;
  }
}

function scanSnapshotDir(rootDir, pattern, manifestRelPath, nowMs) {
  let entries;
  try {
    const st = fs.lstatSync(rootDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return { status: "unavailable", latest: null, count: 0 };
    }
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      return { status: "permission_denied", latest: null, count: 0 };
    }
    if (err.code === "ENOENT") {
      return { status: "missing", latest: null, count: 0 };
    }
    return { status: "error", latest: null, count: 0 };
  }

  let latest = null;
  let count = 0;
  const maxAllowedMs = nowMs + 3600 * 1000;
  for (const ent of entries) {
    if (ent.isSymbolicLink() || !ent.isDirectory()) continue;
    const m = ent.name.match(pattern);
    if (!m) continue;
    const parsedStamp = parseCompactUtcStamp(m[1]);
    if (!parsedStamp) continue;
    const manifestTime = readManifestCreated(path.join(rootDir, ent.name, manifestRelPath));
    const ts = manifestTime || parsedStamp;
    if (ts.ms > maxAllowedMs) continue;
    count++;
    if (!latest || ts.ms > latest.ms) {
      latest = { name: ent.name, ms: ts.ms, iso: ts.iso };
    }
  }
  return { status: "ok", latest, count };
}

function parseSystemctlProps(stdout) {
  const props = Object.create(null);
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return props;
}

function inspectSystemdBackup(runCommand = defaultRunCommand) {
  const svc = runCommand("systemctl", [
    "show",
    "--timestamp=utc",
    "-p", "LoadState",
    "-p", "ActiveState",
    "-p", "Result",
    "-p", "ExecMainStatus",
    "-p", "ExecMainExitTimestamp",
    "-p", "InactiveEnterTimestamp",
    "bojin-backup.service"
  ]);
  if (svc.error && svc.error.code === "ENOENT") {
    return { available: false };
  }
  if (svc.status !== 0) {
    return { available: false };
  }
  const sProps = parseSystemctlProps(svc.stdout);
  if (sProps.LoadState !== "loaded") {
    return { available: false };
  }

  const activeState = sProps.ActiveState || null;
  const result = sProps.Result || null;
  const exitStatus = sProps.ExecMainStatus !== undefined && sProps.ExecMainStatus !== ""
    ? Number(sProps.ExecMainStatus)
    : null;
  // Require a completed, non-running service exit with Result=success and status 0.
  const exitTs = parseTimestampMs(sProps.ExecMainExitTimestamp)
    ?? parseTimestampMs(sProps.InactiveEnterTimestamp);
  const serviceLastSuccessMs =
    activeState !== "activating" && activeState !== "active" && result === "success" && exitStatus === 0
      ? exitTs
      : null;

  let timerLastTriggerMs = null;
  const tmr = runCommand("systemctl", [
    "show",
    "--timestamp=utc",
    "-p", "LoadState",
    "-p", "LastTriggerUSec",
    "bojin-backup.timer"
  ]);
  if (tmr.status === 0) {
    const tProps = parseSystemctlProps(tmr.stdout);
    if (tProps.LoadState === "loaded") {
      timerLastTriggerMs = parseTimestampMs(tProps.LastTriggerUSec);
    }
  }

  return {
    available: true,
    serviceActiveState: activeState,
    serviceResult: result,
    serviceExitStatus: Number.isFinite(exitStatus) ? exitStatus : null,
    serviceLastSuccessMs,
    timerLastTriggerMs
  };
}

function inspectBackups({ backupRoot, deployBackupRoot, nowMs, noSystemd, runCommand = defaultRunCommand }) {
  const daily = backupRoot ? scanSnapshotDir(backupRoot, DAILY_SNAP_RE, "manifest.json", nowMs) : { status: "missing", latest: null, count: 0 };
  const deploy = deployBackupRoot
    ? scanSnapshotDir(deployBackupRoot, DEPLOY_SNAP_RE, path.join("snapshot", "manifest.json"), nowMs)
    : { status: "missing", latest: null, count: 0 };

  let fsLatest = null;
  let fsKind = null;
  if (daily.latest && (!deploy.latest || daily.latest.ms >= deploy.latest.ms)) {
    fsLatest = daily.latest;
    fsKind = "daily";
  } else if (deploy.latest) {
    fsLatest = deploy.latest;
    fsKind = "deploy";
  }

  const systemd = noSystemd ? { available: false } : inspectSystemdBackup(runCommand);
  const fsPermDenied = daily.status === "permission_denied" || deploy.status === "permission_denied";
  const systemdFailed = Boolean(
    systemd.available &&
    ((systemd.serviceResult && systemd.serviceResult !== "success") ||
      (systemd.serviceExitStatus !== null && systemd.serviceExitStatus !== 0))
  );
  const systemdRunning = Boolean(
    systemd.available && (systemd.serviceActiveState === "activating" || systemd.serviceActiveState === "active")
  );
  const timerLastTriggerAt = systemd.available && systemd.timerLastTriggerMs !== null
    ? new Date(systemd.timerLastTriggerMs).toISOString()
    : null;

  let lastBackupMs = null;
  let source = "unavailable";
  let latestSnapshotName = null;
  let note = null;

  // Never populate lastBackupAt from timerLastTriggerMs: a timer trigger only indicates
  // that a backup started/was scheduled, not that it succeeded.
  if (fsLatest) {
    lastBackupMs = fsLatest.ms;
    source = "filesystem";
    latestSnapshotName = fsLatest.name;
    if (systemd.available && systemd.serviceLastSuccessMs && systemd.serviceLastSuccessMs > lastBackupMs) {
      lastBackupMs = systemd.serviceLastSuccessMs;
      source = "systemd-service";
      latestSnapshotName = null;
    } else if (systemdFailed) {
      note = `last bojin-backup.service run failed (result=${systemd.serviceResult || "unknown"}, status=${systemd.serviceExitStatus ?? "?"})`;
    } else if (systemdRunning) {
      note = "bojin-backup.service is currently running; showing previous completed snapshot";
    }
  } else if (systemd.available && systemd.serviceLastSuccessMs) {
    lastBackupMs = systemd.serviceLastSuccessMs;
    source = "systemd-service";
    if (fsPermDenied) {
      note = "backup directory is root-only (0710); completed time sourced from bojin-backup.service";
    }
  } else if (systemdFailed) {
    note = `last bojin-backup.service run failed (result=${systemd.serviceResult || "unknown"}, status=${systemd.serviceExitStatus ?? "?"})`;
  } else if (systemdRunning) {
    note = "bojin-backup.service is currently running; no completed backup timestamp confirmed yet";
  } else if (fsPermDenied) {
    note = timerLastTriggerAt
      ? "backup directory is root-only (0710) and bojin-backup.service has no recorded successful exit since boot (timer trigger shown separately)"
      : "backup directory unreadable by service user and no completed bojin-backup.service exit recorded";
  } else {
    note = timerLastTriggerAt
      ? "no readable snapshots and bojin-backup.service has no recorded successful exit since boot (timer trigger shown separately)"
      : "no backups or snapshots found";
  }

  const lastBackupAt = lastBackupMs !== null ? new Date(lastBackupMs).toISOString() : null;
  const ageHours = lastBackupMs !== null ? Math.round(((nowMs - lastBackupMs) / 3600000) * 10) / 10 : null;

  return {
    lastBackupAt,
    ageHours,
    source,
    latestSnapshotName,
    latestSnapshotKind: fsKind,
    dailySnapshotAt: daily.latest ? daily.latest.iso : null,
    deploySnapshotAt: deploy.latest ? deploy.latest.iso : null,
    dailySnapshotCount: daily.status === "ok" ? daily.count : null,
    deploySnapshotCount: deploy.status === "ok" ? deploy.count : null,
    serviceResult: systemd.available ? systemd.serviceResult : null,
    serviceActiveState: systemd.available ? systemd.serviceActiveState : null,
    timerLastTriggerAt,
    note
  };
}

async function collectDailySummary(options = {}) {
  const env = options.env || process.env;
  const dataDir = path.resolve(options.dataDir || env.DATA_DIR || path.join(__dirname, "..", "data"));
  const nowMs = options.nowMs ?? Date.now();
  const since24hMs = nowMs - MS_PER_DAY;
  const trialStartMs = options.sinceMs ?? null;
  const nowIso = new Date(nowMs).toISOString();
  const since24hIso = new Date(since24hMs).toISOString();
  const nowUtcDate = nowIso.slice(0, 10);
  const trialStartUtcDate = trialStartMs !== null ? new Date(trialStartMs).toISOString().slice(0, 10) : null;
  const pricing = options.pricing || parsePricing(env);
  const runCommand = options.runCommand || defaultRunCommand;
  const includeFeedbackExcerpts = Boolean(options.includeFeedbackExcerpts);
  const pseudo = createReportPseudonymizer(options.pseudonymKey);

  const in24h = (ms) => ms !== null && ms >= since24hMs && ms <= nowMs;
  const inTrial = (ms) => ms !== null && (trialStartMs === null || ms >= trialStartMs) && ms <= nowMs;

  const accounts = {
    authDbPresent: false,
    last24h: { signups: 0, verifiedSignups: 0 },
    trialToDate: { signups: 0, verified: 0, unverified: 0 }
  };

  const active24h = new Set();
  const activeTrial = new Set();

  const logs = {
    appDbPresent: false,
    last24h: { checkins: 0, workouts: 0, meals: 0 },
    trialToDate: { checkins: 0, workouts: 0, meals: 0 }
  };

  const feedback = {
    excerptsIncluded: includeFeedbackExcerpts,
    last24h: { total: 0, byType: { bug: 0, idea: 0, other: 0 } },
    trialToDate: { total: 0, byType: { bug: 0, idea: 0, other: 0 } },
    newest: []
  };

  const photos = {
    last24h: { count: 0, bytes: 0 },
    trialToDate: { count: 0, bytes: 0 },
    totalDbCount: 0,
    totalDbBytes: 0,
    diskCount: 0,
    diskBytes: 0
  };

  let dbAiTodayUtc = 0;
  let dbAiTrialTotal = 0;

  const bojinDbPath = path.join(dataDir, "bojin.db");
  const authDbPath = path.join(dataDir, "auth.sqlite");
  const hasBojinDb = fs.existsSync(bojinDbPath);
  const hasAuthDb = fs.existsSync(authDbPath);

  let tempDir = null;
  let bojinDb = null;
  let authDb = null;

  try {
    if (hasBojinDb || hasAuthDb) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-summary-db-"));
      fs.chmodSync(tempDir, 0o700);
    }

    if (hasAuthDb) {
      accounts.authDbPresent = true;
      const authCopy = path.join(tempDir, "auth.sqlite");
      await snapshotDbToTemp(authDbPath, authCopy);
      authDb = new DatabaseSync(authCopy, { readOnly: true });

      if (hasTable(authDb, "user")) {
        // Better Auth has no dedicated emailVerifiedAt column, so report verified accounts
        // within each signup cohort (createdAt in window & emailVerified = 1) rather than
        // misattributing unrelated user-row updates as verifications.
        const userRows = authDb.prepare("SELECT id, emailVerified, createdAt FROM user").all();
        for (const u of userRows) {
          const createdMs = parseTimestampMs(u.createdAt);
          const isVerified = Boolean(u.emailVerified);

          if (inTrial(createdMs) || (createdMs === null && trialStartMs === null)) {
            accounts.trialToDate.signups++;
            if (isVerified) accounts.trialToDate.verified++;
            else accounts.trialToDate.unverified++;
          }
          if (in24h(createdMs)) {
            accounts.last24h.signups++;
            if (isVerified) accounts.last24h.verifiedSignups++;
          }
        }
      }

      if (hasTable(authDb, "session")) {
        const sessionRows = authDb.prepare("SELECT userId, createdAt, updatedAt FROM session").all();
        for (const s of sessionRows) {
          if (!s.userId) continue;
          const cMs = parseTimestampMs(s.createdAt);
          const uMs = parseTimestampMs(s.updatedAt);
          if (in24h(cMs) || in24h(uMs)) active24h.add(s.userId);
          if (inTrial(cMs) || inTrial(uMs) || (cMs === null && uMs === null && trialStartMs === null)) {
            activeTrial.add(s.userId);
          }
        }
      }
    }

    if (hasBojinDb) {
      logs.appDbPresent = true;
      const bojinCopy = path.join(tempDir, "bojin.db");
      await snapshotDbToTemp(bojinDbPath, bojinCopy);
      bojinDb = new DatabaseSync(bojinCopy, { readOnly: true });

      if (hasTable(bojinDb, "docs")) {
        for (const row of bojinDb.prepare("SELECT path, uid, data, updated FROM docs").iterate()) {
          const updatedMs = parseTimestampMs(row.updated);
          if (row.uid) {
            if (in24h(updatedMs)) active24h.add(row.uid);
            if (inTrial(updatedMs) || (updatedMs === null && trialStartMs === null)) {
              activeTrial.add(row.uid);
            }
          }
          const dayMatch = typeof row.path === "string" ? row.path.match(DAY_DOC_RE) : null;
          if (!dayMatch) continue;

          let doc;
          try {
            doc = JSON.parse(row.data);
          } catch {
            continue;
          }
          if (!doc || typeof doc !== "object") continue;

          if (hasCheckin(doc)) {
            const checkinMs = parseTimestampMs(doc.checkin?.savedAt ?? doc.checkin?.at) ?? updatedMs;
            if (inTrial(checkinMs) || (checkinMs === null && trialStartMs === null)) {
              logs.trialToDate.checkins++;
            }
            if (in24h(checkinMs)) {
              logs.last24h.checkins++;
            }
          }

          if (doc.workout && doc.workout.done === true) {
            const workoutMs = parseTimestampMs(doc.workout.savedAt) ?? updatedMs;
            if (inTrial(workoutMs) || (workoutMs === null && trialStartMs === null)) {
              logs.trialToDate.workouts++;
            }
            if (in24h(workoutMs)) {
              logs.last24h.workouts++;
            }
          }

          if (Array.isArray(doc.meals)) {
            for (const meal of doc.meals) {
              if (!meal || typeof meal !== "object") continue;
              const mealMs = resolveMealTimestampMs(meal, updatedMs, nowMs);
              if (inTrial(mealMs) || (mealMs === null && trialStartMs === null)) {
                logs.trialToDate.meals++;
              }
              if (in24h(mealMs)) {
                logs.last24h.meals++;
              }
            }
          }
        }
      }

      if (hasTable(bojinDb, "blobs")) {
        for (const row of bojinDb.prepare("SELECT uid, size, created FROM blobs").iterate()) {
          const size = nonNegInt(row.size);
          const createdMs = parseTimestampMs(row.created);
          photos.totalDbCount++;
          photos.totalDbBytes += size;
          if (row.uid) {
            if (in24h(createdMs)) active24h.add(row.uid);
            if (inTrial(createdMs) || (createdMs === null && trialStartMs === null)) {
              activeTrial.add(row.uid);
            }
          }
          if (inTrial(createdMs) || (createdMs === null && trialStartMs === null)) {
            photos.trialToDate.count++;
            photos.trialToDate.bytes += size;
          }
          if (in24h(createdMs)) {
            photos.last24h.count++;
            photos.last24h.bytes += size;
          }
        }
      }

      if (hasTable(bojinDb, "ai_usage")) {
        for (const row of bojinDb.prepare("SELECT uid, day, n FROM ai_usage").iterate()) {
          const n = nonNegInt(row.n);
          if (n <= 0) continue;
          const day = typeof row.day === "string" ? row.day : "";
          const inTrialDay = day && day <= nowUtcDate && (!trialStartUtcDate || day >= trialStartUtcDate);
          if (inTrialDay || (!day && trialStartMs === null)) {
            dbAiTrialTotal += n;
            if (row.uid) activeTrial.add(row.uid);
          }
          if (day === nowUtcDate) {
            dbAiTodayUtc += n;
            if (row.uid) active24h.add(row.uid);
          }
        }
      }

      if (hasTable(bojinDb, "feedback")) {
        const fbRows = bojinDb
          .prepare("SELECT id, uid, type, message, screenshot_blob_id, created FROM feedback ORDER BY created DESC, id DESC")
          .all();
        for (const row of fbRows) {
          const createdMs = parseTimestampMs(row.created);
          const type = row.type === "bug" || row.type === "idea" || row.type === "other" ? row.type : "other";
          if (row.uid) {
            if (in24h(createdMs)) active24h.add(row.uid);
            if (inTrial(createdMs) || (createdMs === null && trialStartMs === null)) {
              activeTrial.add(row.uid);
            }
          }
          const matchedTrial = inTrial(createdMs) || (createdMs === null && trialStartMs === null);
          if (matchedTrial) {
            feedback.trialToDate.total++;
            feedback.trialToDate.byType[type]++;
            if (feedback.newest.length < FEEDBACK_NEWEST_LIMIT) {
              const item = {
                ref: pseudo.feedback(row.id),
                user: pseudo.user(row.uid),
                type,
                created: row.created || null,
                messageChars: messageCharLength(row.message),
                hasScreenshot: Boolean(row.screenshot_blob_id)
              };
              if (includeFeedbackExcerpts) {
                const { excerpt, truncated } = sanitizeFeedbackExcerpt(row.message, FEEDBACK_EXCERPT_CHARS);
                item.excerpt = excerpt;
                item.truncated = truncated;
              }
              feedback.newest.push(item);
            }
          }
          if (in24h(createdMs)) {
            feedback.last24h.total++;
            feedback.last24h.byType[type]++;
          }
        }
      }
    }
  } finally {
    if (bojinDb) { try { bojinDb.close(); } catch {} }
    if (authDb) { try { authDb.close(); } catch {} }
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }

  // Fetch journal lines from the earlier of trialStartMs and since24hMs so a recent
  // --since (e.g. 6h ago) never truncates the full 24h rolling window.
  const journalFetchSinceMs = trialStartMs !== null ? Math.min(trialStartMs, since24hMs) : null;
  const journal = loadJournal({
    journalFile: options.journalFile ?? null,
    unit: options.unit || DEFAULT_UNIT,
    fetchSinceMs: journalFetchSinceMs,
    noJournal: Boolean(options.noJournal),
    runCommand
  });

  const ai24h = journal.status === "ok"
    ? aggregateAiEvents(journal.aiEvents, pricing, { minMs: since24hMs, maxMs: nowMs, allowNullTs: false })
    : null;
  const aiTrial = journal.status === "ok"
    ? aggregateAiEvents(journal.aiEvents, pricing, {
        minMs: trialStartMs,
        maxMs: nowMs,
        allowNullTs: trialStartMs === null
      })
    : null;

  const clientErrors24h = journal.status === "ok"
    ? aggregateClientErrors(journal.clientErrors, { minMs: since24hMs, maxMs: nowMs, allowNullTs: false })
    : null;
  const clientErrorsTrial = journal.status === "ok"
    ? aggregateClientErrors(journal.clientErrors, {
        minMs: trialStartMs,
        maxMs: nowMs,
        allowNullTs: trialStartMs === null
      })
    : null;

  const storage = inspectStorage(dataDir);
  photos.diskCount = storage.blobsDiskCount;
  photos.diskBytes = storage.blobsDiskBytes;

  const backupInfo = inspectBackups({
    backupRoot: options.backupRoot !== undefined ? options.backupRoot : DEFAULT_BACKUP_ROOT,
    deployBackupRoot: options.deployBackupRoot !== undefined ? options.deployBackupRoot : DEFAULT_DEPLOY_BACKUP_ROOT,
    nowMs,
    noSystemd: Boolean(options.noSystemd),
    runCommand
  });

  return {
    generatedAt: nowIso,
    windows: {
      last24h: { from: since24hIso, to: nowIso },
      trialToDate: { from: trialStartMs !== null ? new Date(trialStartMs).toISOString() : null, to: nowIso }
    },
    accounts,
    activeUsers: {
      last24h: active24h.size,
      trialToDate: activeTrial.size
    },
    logs,
    ai: {
      source: journal.status === "ok" ? "journal" : "db_only",
      journalStatus: journal.status,
      journalNote: journal.note,
      pricing,
      last24h: ai24h
        ? { ...ai24h, dbCallsTodayUtc: dbAiTodayUtc }
        : { calls: null, dbCallsTodayUtc: dbAiTodayUtc },
      trialToDate: aiTrial
        ? { ...aiTrial, dbCalls: dbAiTrialTotal }
        : { calls: null, dbCalls: dbAiTrialTotal }
    },
    feedback,
    clientErrors: {
      source: journal.status === "ok" ? "journal" : "unavailable",
      journalStatus: journal.status,
      journalNote: journal.note,
      last24h: clientErrors24h,
      trialToDate: clientErrorsTrial
    },
    storage: {
      disk: storage.disk,
      dataDirBytes: storage.dataDirBytes,
      dbBytes: storage.dbBytes,
      photos
    },
    backup: backupInfo
  };
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function fmtUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "$0.0000";
  return `$${n.toFixed(4)}`;
}

function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function fmtModels(models) {
  if (!Array.isArray(models) || !models.length) return "";
  return `, 模型 ${models.map(escapeTerminalText).join("/")}`;
}

function formatAiWindowLines(label, data, dbLabel, dbVal) {
  if (!data || data.calls === null) {
    return [`  ${label} 无法读取日志（${dbLabel} ${fmtInt(dbVal)} 次）`];
  }
  const g = data.byProvider.gemini;
  const o = data.byProvider.openrouter;
  const unpricedSuffix = data.unpricedCalls > 0 ? `，另有 ${fmtInt(data.unpricedCalls)} 次未知 provider 未计价` : "";
  const lines = [
    `  ${label} 合计 ${fmtInt(data.calls)} 次 (错误 ${fmtInt(data.errors)}, ${dbLabel} ${fmtInt(dbVal)}) | Tokens: 输入 ${fmtInt(data.promptTokens)} / 输出 ${fmtInt(data.completionTokens)} (含思考 ${fmtInt(data.reasoningTokens)}) | 预估费用: ${fmtUsd(data.estimatedCostUsd)}${unpricedSuffix}`,
    `    - Gemini: ${fmtInt(g.calls)} 次 (含回退前总重试 ${fmtInt(g.retries)}${fmtModels(g.models)}, 输入 ${fmtInt(g.promptTokens)} / 输出 ${fmtInt(g.completionTokens)} / 思考 ${fmtInt(g.reasoningTokens)}, 约 ${fmtUsd(g.estimatedCostUsd)})`,
    `    - OpenRouter: ${fmtInt(o.calls)} 次 (回退 fallback ${fmtInt(o.fallbackCalls)} / 主用 ${fmtInt(o.primaryCalls)}${fmtModels(o.models)}, 输入 ${fmtInt(o.promptTokens)} / 输出 ${fmtInt(o.completionTokens)} / 思考 ${fmtInt(o.reasoningTokens)}, 约 ${fmtUsd(o.estimatedCostUsd)})`
  ];
  if (data.byProvider.other && data.byProvider.other.calls > 0) {
    const x = data.byProvider.other;
    lines.push(
      `    - 其他 (未计价): ${fmtInt(x.calls)} 次 (输入 ${fmtInt(x.promptTokens)} / 输出 ${fmtInt(x.completionTokens)} / 思考 ${fmtInt(x.reasoningTokens)})`
    );
  }
  return lines;
}

function formatErrorBreakdown(byName) {
  const entries = Object.entries(byName || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return "";
  return ` (${entries.slice(0, 5).map(([k, v]) => `${escapeTerminalText(k)}: ${fmtInt(v)}`).join(", ")})`;
}

function formatSummaryText(s) {
  const lines = [];
  const trialLabel = s.windows.trialToDate.from
    ? `自 ${s.windows.trialToDate.from} 起`
    : "全部记录";

  lines.push("薄肌日课 · 每日活动摘要 (Lean Ritual Daily Summary)");
  lines.push(`统计时间: ${s.generatedAt}`);
  lines.push(`统计范围: 近 24h (${s.windows.last24h.from} ~ ${s.windows.last24h.to}) | 内测累计 (${trialLabel})`);
  lines.push("");

  lines.push("[账号与活跃 / Accounts & Activity]");
  if (!s.accounts.authDbPresent) {
    lines.push("  auth.sqlite 不存在（尚无账号数据）");
  } else {
    lines.push(
      `  注册与验证: 近24h 新增 ${fmtInt(s.accounts.last24h.signups)} (其中已验证 ${fmtInt(s.accounts.last24h.verifiedSignups)}) | 累计 ${fmtInt(s.accounts.trialToDate.signups)} (已验证 ${fmtInt(s.accounts.trialToDate.verified)}, 未验证 ${fmtInt(s.accounts.trialToDate.unverified)})`
    );
  }
  lines.push(`  活跃用户:   近24h ${fmtInt(s.activeUsers.last24h)} | 累计 ${fmtInt(s.activeUsers.trialToDate)}`);
  lines.push("");

  lines.push("[记录统计 / Logs]");
  if (!s.logs.appDbPresent) {
    lines.push("  bojin.db 不存在（尚无记录数据）");
  } else {
    lines.push(`  打卡 (Check-ins): 近24h ${fmtInt(s.logs.last24h.checkins)} | 累计 ${fmtInt(s.logs.trialToDate.checkins)}`);
    lines.push(`  训练 (Workouts):  近24h ${fmtInt(s.logs.last24h.workouts)} | 累计 ${fmtInt(s.logs.trialToDate.workouts)}`);
    lines.push(`  饮食 (Meals):     近24h ${fmtInt(s.logs.last24h.meals)} | 累计 ${fmtInt(s.logs.trialToDate.meals)}`);
  }
  lines.push("");

  lines.push("[AI 调用与预估费用 / AI Usage & Est. Cost]");
  const p = s.ai.pricing;
  lines.push(
    `  参考单价 (USD/1M tokens, 按最终尝试 prompt+completion 估算, 不区分模型): Gemini 输入 $${p.gemini.inputPer1M} / 输出 $${p.gemini.outputPer1M} | OpenRouter 输入 $${p.openrouter.inputPer1M} / 输出 $${p.openrouter.outputPer1M}`
  );
  if (s.ai.journalNote) {
    lines.push(`  日志状态: ${escapeTerminalText(s.ai.journalStatus)} (${escapeTerminalText(s.ai.journalNote)})`);
  }
  lines.push(...formatAiWindowLines("近24h:", s.ai.last24h, "DB今日UTC", s.ai.last24h.dbCallsTodayUtc));
  lines.push(...formatAiWindowLines("累计: ", s.ai.trialToDate, "DB累计", s.ai.trialToDate.dbCalls));
  lines.push("");

  lines.push("[意见反馈 / Feedback]");
  const f24 = s.feedback.last24h;
  const ft = s.feedback.trialToDate;
  lines.push(`  近24h: 合计 ${fmtInt(f24.total)} (bug ${fmtInt(f24.byType.bug)}, idea ${fmtInt(f24.byType.idea)}, other ${fmtInt(f24.byType.other)})`);
  lines.push(`  累计:  合计 ${fmtInt(ft.total)} (bug ${fmtInt(ft.byType.bug)}, idea ${fmtInt(ft.byType.idea)}, other ${fmtInt(ft.byType.other)})`);
  if (!s.feedback.newest.length) {
    lines.push("  最新 3 条: 暂无反馈");
  } else if (s.feedback.excerptsIncluded) {
    lines.push("  最新 3 条 (报告内临时匿名 ID + 脱敏前 80 字):");
    s.feedback.newest.forEach((item, idx) => {
      const text = escapeTerminalText(item.excerpt || "") + (item.truncated ? "…" : "");
      const shot = item.hasScreenshot ? ", 含截图" : "";
      lines.push(
        `    ${idx + 1}. [${escapeTerminalText(item.type)}] ${escapeTerminalText(item.created || "?")} (${escapeTerminalText(item.ref)}, ${escapeTerminalText(item.user)}, ${fmtInt(item.messageChars)} 字${shot}) ${text}`
      );
    });
  } else {
    lines.push("  最新 3 条 (默认隐藏正文以保护隐私；查看原文请在主机运行 scripts/feedback-admin.js):");
    s.feedback.newest.forEach((item, idx) => {
      const shot = item.hasScreenshot ? ", 含截图" : "";
      lines.push(
        `    ${idx + 1}. [${escapeTerminalText(item.type)}] ${escapeTerminalText(item.created || "?")} (${escapeTerminalText(item.ref)}, ${escapeTerminalText(item.user)}, ${fmtInt(item.messageChars)} 字${shot})`
      );
    });
  }
  lines.push("");

  lines.push("[客户端错误 / Client Errors]");
  if (s.clientErrors.source !== "journal") {
    lines.push(`  无法读取日志 (${escapeTerminalText(s.clientErrors.journalStatus)}${s.clientErrors.journalNote ? `: ${escapeTerminalText(s.clientErrors.journalNote)}` : ""})`);
  } else {
    lines.push(`  近24h: ${fmtInt(s.clientErrors.last24h.count)}${formatErrorBreakdown(s.clientErrors.last24h.byName)}`);
    lines.push(`  累计:  ${fmtInt(s.clientErrors.trialToDate.count)}${formatErrorBreakdown(s.clientErrors.trialToDate.byName)}`);
  }
  lines.push("");

  lines.push("[磁盘与照片 / Disk & Photos]");
  if (s.storage.disk) {
    const d = s.storage.disk;
    lines.push(
      `  磁盘 (${escapeTerminalText(d.path)}): 已用 ${fmtBytes(d.usedBytes)} / ${fmtBytes(d.totalBytes)} (${d.usedPercent.toFixed(1)}%), 可用 ${fmtBytes(d.availableBytes)}`
    );
  } else {
    lines.push("  磁盘: 无法读取文件系统容量");
  }
  lines.push(`  数据目录: ${fmtBytes(s.storage.dataDirBytes)} (数据库 ${fmtBytes(s.storage.dbBytes)})`);
  const ph = s.storage.photos;
  lines.push(
    `  照片占用: ${fmtBytes(ph.totalDbBytes)} (DB 记录 ${fmtInt(ph.totalDbCount)} 张, 磁盘 ${fmtBytes(ph.diskBytes)} / ${fmtInt(ph.diskCount)} 个文件; 近24h 新增 ${fmtInt(ph.last24h.count)} 张 / ${fmtBytes(ph.last24h.bytes)})`
  );
  lines.push("");

  lines.push("[最近备份 / Last Backup & Snapshot]");
  const b = s.backup;
  if (b.lastBackupAt) {
    const extra = [
      `约 ${b.ageHours.toFixed(1)} 小时前`,
      `来源: ${escapeTerminalText(b.source)}`,
      ...(b.latestSnapshotName ? [escapeTerminalText(b.latestSnapshotName)] : []),
      ...(b.serviceResult ? [`service=${escapeTerminalText(b.serviceResult)}`] : [])
    ];
    lines.push(`  最近成功备份: ${b.lastBackupAt} (${extra.join(", ")})`);
  } else {
    const statusParts = [];
    if (b.serviceActiveState) statusParts.push(`state=${escapeTerminalText(b.serviceActiveState)}`);
    if (b.serviceResult) statusParts.push(`result=${escapeTerminalText(b.serviceResult)}`);
    lines.push(`  最近成功备份: 未知${statusParts.length ? ` (${statusParts.join(", ")})` : ""}`);
  }
  if (b.timerLastTriggerAt) {
    lines.push(`  定时最近触发: ${b.timerLastTriggerAt} (bojin-backup.timer，仅表示触发时间，不代表备份成功)`);
  }
  if (b.note) {
    lines.push(`  备注: ${escapeTerminalText(b.note)}`);
  }

  return lines.join("\n");
}

module.exports = {
  USAGE,
  DEFAULT_AI_PRICING,
  FEEDBACK_EXCERPT_CHARS,
  FEEDBACK_NEWEST_LIMIT,
  escapeTerminalText,
  createReportPseudonymizer,
  parsePricing,
  parseTimestampMs,
  parseCompactUtcStamp,
  parseCliArgs,
  sanitizeFeedbackExcerpt,
  parseJournalLine,
  parseJournalStream,
  collectDailySummary,
  formatSummaryText
};
