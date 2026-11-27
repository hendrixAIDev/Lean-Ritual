"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createInvitations, normalizeEmail } = require("./invitations");
const { normalizePhone, isSyntheticPhoneEmail } = require("./phone");
const { ALERT_TIMEOUT_MS, parseAlertUrl, sendAlert } = require("./alerts");

const MAX_BODY_BYTES = 8192;
const DEFAULT_BODY_TIMEOUT_MS = 5000;
const MAX_BODY_TIMEOUT_MS = 30000;
const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 90;
const RATE_LIMIT_RETENTION_DAYS = 2;

const MAX_NAME_LEN = 80;
const MAX_GOAL_LEN = 500;
const MAX_NOTE_LEN = 500;
const MAX_STATUS_NOTE_LEN = 200;
const MAX_EMAIL_LEN = 254;

const DEFAULT_IP_HOURLY_LIMIT = 5;
const DEFAULT_IP_DAILY_LIMIT = 10;
const DEFAULT_GLOBAL_DAILY_LIMIT = 200;

const ALLOWED_KINDS = new Set(["phone", "email"]);
const ALLOWED_STATUSES = new Set(["pending", "invited", "dismissed"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INLINE_CONTROL_RE = /[\x00-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]+/g;
const BIDI_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]+/g;
const MULTILINE_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;

function fail(status, code, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function positiveInt(raw, fallback, name, max = Number.MAX_SAFE_INTEGER) {
  const n = raw == null || String(raw).trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new Error(max < Number.MAX_SAFE_INTEGER ? `${name} must be an integer between 1 and ${max}` : `${name} must be a positive integer`);
  }
  return n;
}

function clampedRetentionDays(raw, fallback = DEFAULT_RETENTION_DAYS, name = "INVITE_REQUEST_RETENTION_DAYS") {
  const n = positiveInt(raw, fallback, name);
  return Math.min(n, MAX_RETENTION_DAYS);
}

function inviteRequestOptions(env = process.env) {
  return {
    ipHourly: positiveInt(env.INVITE_REQUEST_IP_HOURLY_LIMIT, DEFAULT_IP_HOURLY_LIMIT, "INVITE_REQUEST_IP_HOURLY_LIMIT"),
    ipDaily: positiveInt(env.INVITE_REQUEST_IP_DAILY_LIMIT, DEFAULT_IP_DAILY_LIMIT, "INVITE_REQUEST_IP_DAILY_LIMIT"),
    globalDaily: positiveInt(env.INVITE_REQUEST_GLOBAL_DAILY_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT, "INVITE_REQUEST_GLOBAL_DAILY_LIMIT"),
    bodyTimeoutMs: positiveInt(env.INVITE_REQUEST_BODY_TIMEOUT_MS, DEFAULT_BODY_TIMEOUT_MS, "INVITE_REQUEST_BODY_TIMEOUT_MS", MAX_BODY_TIMEOUT_MS),
    retentionDays: clampedRetentionDays(env.INVITE_REQUEST_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, "INVITE_REQUEST_RETENTION_DAYS"),
    alertUrl: typeof env.ALERT_URL === "string" ? env.ALERT_URL.trim() : "",
    ipHashSecret: typeof env.AUTH_SECRET === "string" ? env.AUTH_SECRET : ""
  };
}

function assertNoNullByte(str) {
  if (str.includes("\x00")) throw fail(400, "bad_request", "输入包含无效字符");
}

function sanitizeName(raw) {
  if (typeof raw !== "string") throw fail(400, "name_required", "请填写你的称呼");
  assertNoNullByte(raw);
  const cleaned = raw.replace(BIDI_CONTROL_RE, "").replace(/\s+/g, " ").trim();
  if (!cleaned) throw fail(400, "name_required", "请填写你的称呼");
  if (Array.from(cleaned).length > MAX_NAME_LEN) {
    throw fail(400, "name_too_long", `称呼最多 ${MAX_NAME_LEN} 字`);
  }
  return cleaned;
}

function sanitizeContact(kindRaw, valueRaw) {
  if (typeof kindRaw !== "string") throw fail(400, "invalid_contact_kind", "请选择手机号或邮箱");
  const contactKind = kindRaw.trim().toLowerCase();
  if (!ALLOWED_KINDS.has(contactKind)) {
    throw fail(400, "invalid_contact_kind", "请选择手机号或邮箱");
  }
  if (typeof valueRaw !== "string") {
    throw fail(
      400,
      contactKind === "phone" ? "invalid_phone" : "invalid_email",
      contactKind === "phone" ? "请填写有效的手机号" : "请填写有效的邮箱地址"
    );
  }
  assertNoNullByte(valueRaw);
  if (/[\x00-\x1f\x7f-\x9f]/.test(valueRaw)) {
    throw fail(
      400,
      contactKind === "phone" ? "invalid_phone" : "invalid_email",
      contactKind === "phone" ? "请填写有效的手机号" : "请填写有效的邮箱地址"
    );
  }
  if (contactKind === "email") {
    const email = normalizeEmail(valueRaw);
    if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email) || isSyntheticPhoneEmail(email)) {
      throw fail(400, "invalid_email", "请填写有效的邮箱地址");
    }
    return { contactKind, contactValue: email };
  }
  const phone = normalizePhone(valueRaw);
  if (!phone) {
    throw fail(400, "invalid_phone", "请填写有效的手机号（中国大陆 11 位或含国家代码）");
  }
  return { contactKind, contactValue: phone };
}

function sanitizeGoal(raw) {
  if (typeof raw !== "string") throw fail(400, "goal_required", "请填写你想达成的目标");
  assertNoNullByte(raw);
  const cleaned = raw.replace(/\r\n?/g, "\n").replace(MULTILINE_CONTROL_RE, "").trim();
  if (!cleaned) throw fail(400, "goal_required", "请填写你想达成的目标");
  if (Array.from(cleaned).length > MAX_GOAL_LEN) {
    throw fail(400, "goal_too_long", `目标最多 ${MAX_GOAL_LEN} 字`);
  }
  return cleaned;
}

function sanitizeNote(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") throw fail(400, "bad_request", "补充说明格式无效");
  assertNoNullByte(raw);
  const cleaned = raw.replace(/\r\n?/g, "\n").replace(MULTILINE_CONTROL_RE, "").trim();
  if (Array.from(cleaned).length > MAX_NOTE_LEN) {
    throw fail(400, "note_too_long", `补充说明最多 ${MAX_NOTE_LEN} 字`);
  }
  return cleaned;
}

function sanitizeStatusNote(raw) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new Error("--note must be a string");
  const cleaned = raw.replace(INLINE_CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (Array.from(cleaned).length > MAX_STATUS_NOTE_LEN) {
    throw new Error(`--note must be at most ${MAX_STATUS_NOTE_LEN} characters`);
  }
  return cleaned;
}

function sanitizeLang(raw, fallback = "zh") {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "en") return "en";
  if (v === "zh") return "zh";
  return fallback === "en" ? "en" : "zh";
}

// Bound both body bytes and total body read time for this unauthenticated public endpoint.
function readInviteRequestBody(req, res, { maxBytes = MAX_BODY_BYTES, timeoutMs = DEFAULT_BODY_TIMEOUT_MS } = {}) {
  const cl = Number(req.headers["content-length"]);
  if (Number.isFinite(cl) && cl > maxBytes) {
    res?.setHeader?.("Connection", "close");
    return Promise.reject(fail(413, "too_large", "内容太大"));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      req.off?.("data", onData);
      req.off?.("end", onEnd);
      req.off?.("error", onError);
      req.off?.("close", onClose);
    };

    const rejectOnce = (err, { forceDestroySoon = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      res?.setHeader?.("Connection", "close");
      req.pause?.();
      reject(err);
      if (forceDestroySoon) {
        setTimeout(() => {
          if (!req.destroyed) req.destroy();
        }, 250).unref();
      }
    };

    const onData = chunk => {
      if (settled) return;
      n += chunk.length;
      if (n > maxBytes) {
        rejectOnce(fail(413, "too_large", "内容太大"));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = err => {
      rejectOnce(err);
    };

    const onClose = () => {
      if (!req.complete) rejectOnce(fail(400, "bad_request"));
    };

    timer = setTimeout(() => {
      rejectOnce(fail(408, "request_timeout", "请求超时，请重试"), { forceDestroySoon: true });
    }, timeoutMs);
    timer.unref?.();

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

// Metadata only: never forward user-controlled text (name, contact, goal, note, or status note)
// to third-party alert channels.
function formatAlertBody(record) {
  const id = String(record.id || "").replace(INLINE_CONTROL_RE, "");
  const kind = ALLOWED_KINDS.has(record.contactKind) ? record.contactKind : "unknown";
  const lang = record.lang === "en" ? "en" : "zh";
  return `[invite-request] #${id} (${kind}, ${lang})`;
}

async function sendInviteRequestAlert({
  alertUrl,
  record,
  fetcher = fetch,
  timeoutMs = ALERT_TIMEOUT_MS,
  log = console.warn
}) {
  return sendAlert({
    alertUrl,
    title: "Lean Ritual Invite Request",
    tags: "envelope",
    body: formatAlertBody(record),
    fetcher,
    timeoutMs,
    log,
    label: "invite-request alert"
  });
}

function pruneInviteRequestData(db, { nowMs = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  const days = clampedRetentionDays(retentionDays, DEFAULT_RETENTION_DAYS, "INVITE_REQUEST_RETENTION_DAYS");
  const nowIso = new Date(nowMs).toISOString();
  const cutoffDay = new Date(nowMs - RATE_LIMIT_RETENTION_DAYS * 86400 * 1000).toISOString().slice(0, 10);
  const cutoffRetentionIso = new Date(nowMs - days * 86400 * 1000).toISOString();

  const hasTable = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  let deletedRequests = 0;
  let deletedRateLimits = 0;
  let inTx = false;

  try {
    db.exec("BEGIN IMMEDIATE");
    inTx = true;

    if (hasTable("invite_request_rate_limits")) {
      const rlRes = db.prepare(
        "DELETE FROM invite_request_rate_limits WHERE (window LIKE 'd:%' AND window < ?) OR (window LIKE 'h:%' AND window < ?)"
      ).run("d:" + cutoffDay, "h:" + cutoffDay);
      deletedRateLimits = Number(rlRes.changes || 0);
    }

    if (hasTable("invite_requests")) {
      const expired = db.prepare("SELECT id FROM invite_requests WHERE updated < ?").all(cutoffRetentionIso);
      if (expired.length) {
        db.exec("CREATE TABLE IF NOT EXISTS invite_request_deletions (id TEXT PRIMARY KEY, deleted TEXT NOT NULL)");
        const delStmt = db.prepare("DELETE FROM invite_requests WHERE id = ?");
        const tombStmt = db.prepare("INSERT OR REPLACE INTO invite_request_deletions (id, deleted) VALUES (?, ?)");
        for (const row of expired) {
          delStmt.run(row.id);
          tombStmt.run(row.id, nowIso);
        }
        deletedRequests = expired.length;
      }
    }

    db.exec("COMMIT");
    inTx = false;
  } catch (err) {
    if (inTx) {
      try { db.exec("ROLLBACK"); } catch {}
    }
    throw err;
  }

  return { deletedRequests, deletedRateLimits, cutoffIso: cutoffRetentionIso };
}

function createInviteRequests(db, {
  ipHourly = DEFAULT_IP_HOURLY_LIMIT,
  ipDaily = DEFAULT_IP_DAILY_LIMIT,
  globalDaily = DEFAULT_GLOBAL_DAILY_LIMIT,
  retentionDays = DEFAULT_RETENTION_DAYS,
  alertUrl = "",
  ipHashSecret = "",
  fetcher = fetch,
  now = Date.now,
  log = console.warn
} = {}) {
  positiveInt(ipHourly, DEFAULT_IP_HOURLY_LIMIT, "INVITE_REQUEST_IP_HOURLY_LIMIT");
  positiveInt(ipDaily, DEFAULT_IP_DAILY_LIMIT, "INVITE_REQUEST_IP_DAILY_LIMIT");
  positiveInt(globalDaily, DEFAULT_GLOBAL_DAILY_LIMIT, "INVITE_REQUEST_GLOBAL_DAILY_LIMIT");
  const normalizedRetentionDays = clampedRetentionDays(retentionDays, DEFAULT_RETENTION_DAYS, "INVITE_REQUEST_RETENTION_DAYS");

  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_requests (
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
    CREATE INDEX IF NOT EXISTS invite_requests_status_created ON invite_requests(status, created DESC);
    CREATE INDEX IF NOT EXISTS invite_requests_created ON invite_requests(created DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS invite_requests_pending_contact
      ON invite_requests(contact_kind, contact_value) WHERE status = 'pending';
    CREATE TABLE IF NOT EXISTS invite_request_rate_limits (
      bucket TEXT NOT NULL,
      window TEXT NOT NULL,
      n INTEGER NOT NULL,
      PRIMARY KEY(bucket, window)
    );
    CREATE TABLE IF NOT EXISTS invite_request_deletions (
      id TEXT PRIMARY KEY,
      deleted TEXT NOT NULL
    );
  `);

  const ipHashKey = crypto
    .createHash("sha256")
    .update("lean-ritual:invite-request-ip:v1:")
    .update(String(ipHashSecret || crypto.randomBytes(16).toString("hex")))
    .digest();

  const pendingAlerts = new Set();

  function hashIpBucket(ip) {
    return "ip:" + crypto
      .createHmac("sha256", ipHashKey)
      .update(String(ip || "?"))
      .digest("hex")
      .slice(0, 32);
  }

  function getCount(bucket, windowKey) {
    return db.prepare("SELECT n FROM invite_request_rate_limits WHERE bucket = ? AND window = ?").get(bucket, windowKey)?.n || 0;
  }

  function incrementCount(bucket, windowKey) {
    db.prepare(
      "INSERT INTO invite_request_rate_limits (bucket, window, n) VALUES (?, ?, 1) ON CONFLICT(bucket, window) DO UPDATE SET n = n + 1"
    ).run(bucket, windowKey);
  }

  function dispatchAlertAsync(record) {
    const task = Promise.resolve()
      .then(() => sendInviteRequestAlert({ alertUrl, record, fetcher, log }))
      .catch(() => {})
      .finally(() => { pendingAlerts.delete(task); });
    pendingAlerts.add(task);
  }

  async function flushPendingAlerts() {
    while (pendingAlerts.size > 0) {
      await Promise.allSettled([...pendingAlerts]);
    }
  }

  function pruneExpired({ retentionDays: overrideDays } = {}) {
    return pruneInviteRequestData(db, {
      nowMs: now(),
      retentionDays: overrideDays ?? normalizedRetentionDays
    });
  }

  async function submit(body, { ip = "?", headerLang = null } = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw fail(400, "bad_request", "请求格式不正确");
    }

    // Honeypot: silently accept bots without storing, alerting, or consuming global quota.
    if (body.website !== undefined && body.website !== null) {
      if (typeof body.website !== "string" || body.website.trim() !== "") {
        return { ok: true, honeypot: true };
      }
    }

    const name = sanitizeName(body.name);
    const { contactKind, contactValue } = sanitizeContact(body.contactKind, body.contactValue);
    const goal = sanitizeGoal(body.goal);
    const note = sanitizeNote(body.note);
    const lang = sanitizeLang(body.lang, sanitizeLang(headerLang, "zh"));

    const nowMs = now();
    const iso = new Date(nowMs).toISOString();
    const hourWindow = "h:" + iso.slice(0, 13);
    const dayWindow = "d:" + iso.slice(0, 10);
    const cutoffDay = new Date(nowMs - RATE_LIMIT_RETENTION_DAYS * 86400 * 1000).toISOString().slice(0, 10);
    const ipBucket = hashIpBucket(ip);

    let id;
    let created;
    let updated;
    let deduplicated = false;
    let inTx = false;

    try {
      db.exec("BEGIN IMMEDIATE");
      inTx = true;

      if (
        getCount(ipBucket, hourWindow) >= ipHourly ||
        getCount(ipBucket, dayWindow) >= ipDaily ||
        getCount("global", dayWindow) >= globalDaily
      ) {
        throw fail(429, "rate_limited", "提交太频繁了，请稍后再试");
      }

      incrementCount(ipBucket, hourWindow);
      incrementCount(ipBucket, dayWindow);
      incrementCount("global", dayWindow);

      const existing = db.prepare(
        "SELECT id, created, updated FROM invite_requests WHERE contact_kind = ? AND contact_value = ? AND status = 'pending'"
      ).get(contactKind, contactValue);

      if (existing) {
        // Strict no-op: never let an unauthenticated request overwrite an existing pending application.
        id = existing.id;
        created = existing.created;
        updated = existing.updated;
        deduplicated = true;
      } else {
        id = "req_" + crypto.randomBytes(6).toString("hex");
        created = iso;
        updated = iso;
        db.prepare(
          `INSERT INTO invite_requests
            (id, name, contact_kind, contact_value, goal, note, lang, status, status_note, created, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)`
        ).run(id, name, contactKind, contactValue, goal, note, lang, created, updated);
      }

      db.prepare(
        "DELETE FROM invite_request_rate_limits WHERE (window LIKE 'd:%' AND window < ?) OR (window LIKE 'h:%' AND window < ?)"
      ).run("d:" + cutoffDay, "h:" + cutoffDay);

      db.exec("COMMIT");
      inTx = false;
    } catch (err) {
      if (inTx) {
        try { db.exec("ROLLBACK"); } catch {}
      }
      throw err;
    }

    // Decouple webhook delivery from HTTP response completion so external alert latency
    // cannot reveal whether a contact already had a pending application.
    if (!deduplicated) {
      dispatchAlertAsync({ id, contactKind, lang, created });
    }

    return {
      ok: true,
      id,
      contactKind,
      created,
      updated,
      deduplicated,
      honeypot: false
    };
  }

  return { submit, flushPendingAlerts, pruneExpired };
}

const DEFAULT_MAX_BETA_SPOTS = 50;
const MAX_BETA_SPOTS_LIMIT = 10000;
const AUTO_EMAILED_NOTE = "auto-emailed invite";
const ALREADY_REGISTERED_NOTE = "already registered";
const EXISTING_ACTIVE_INVITE_NOTE = "existing active invite";
const DELIVERY_UNCERTAIN_NOTE = "delivery uncertain; inspect before retrying";
const ROLLBACK_REVOKE_FAILED_NOTE = "rollback revoke failed; inspect before retrying";
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_ERR_CODE_RE = /^[A-Z0-9_]{1,32}$/;
const SYSTEMD_DQ_ESCAPABLE = new Set(['"', "\\", "$", "`"]);
const DEFINITE_PRE_SEND_CODES = new Set([
  "INVALID_ACTION_URL",
  "INVALID_RECIPIENT",
  "EAUTH",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EDNS"
]);

// Parse a systemd EnvironmentFile (systemd.exec(5) / src/basic/env-file.c) without shell evaluation.
// Preserves literal backslashes in double quotes except for systemd's SHELL_NEED_ESCAPE (", \, $, `)
// and line continuations (\ + newline), supports single/double-quoted multiline values, and handles
// unquoted values such as MAIL_FROM=Lean Ritual <noreply@leanritual.app>.
function parseSystemdEnvFile(content) {
  const entries = Object.create(null);
  const src = String(content ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const len = src.length;
  let i = 0;
  let lineNo = 1;

  while (i < len) {
    // Skip leading whitespace and blank lines.
    while (i < len && (src[i] === " " || src[i] === "\t" || src[i] === "\n")) {
      if (src[i] === "\n") lineNo++;
      i++;
    }
    if (i >= len) break;

    // Skip comment lines starting with # or ;.
    if (src[i] === "#" || src[i] === ";") {
      while (i < len && src[i] !== "\n") i++;
      continue;
    }

    const startLine = lineNo;
    let key = "";
    while (i < len && src[i] !== "=" && src[i] !== "\n") {
      key += src[i++];
    }
    if (i >= len || src[i] !== "=") {
      throw new Error(`Invalid env-file syntax at line ${startLine}`);
    }
    i++; // consume '='

    key = key.trim();
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid environment variable name at line ${startLine}`);
    }

    // Skip leading horizontal whitespace before value.
    while (i < len && (src[i] === " " || src[i] === "\t")) i++;

    let value = "";
    let pendingSpaces = "";
    while (i < len) {
      const ch = src[i];
      if (ch === "\n") {
        lineNo++;
        i++;
        break;
      }
      if (ch === " " || ch === "\t") {
        pendingSpaces += ch;
        i++;
        continue;
      }
      if (ch === "'") {
        value += pendingSpaces;
        pendingSpaces = "";
        const quoteStart = lineNo;
        i++; // consume opening '
        let closed = false;
        while (i < len) {
          const qc = src[i++];
          if (qc === "'") {
            closed = true;
            break;
          }
          if (qc === "\n") lineNo++;
          value += qc;
        }
        if (!closed) {
          throw new Error(`Unterminated single-quoted value in --env-file at line ${quoteStart}`);
        }
        continue;
      }
      if (ch === '"') {
        value += pendingSpaces;
        pendingSpaces = "";
        const quoteStart = lineNo;
        i++; // consume opening "
        let closed = false;
        while (i < len) {
          const qc = src[i++];
          if (qc === '"') {
            closed = true;
            break;
          }
          if (qc === "\\") {
            if (i >= len) break;
            const next = src[i++];
            if (next === "\n") {
              // Line continuation inside double quotes: discard both \ and newline.
              lineNo++;
            } else if (SYSTEMD_DQ_ESCAPABLE.has(next)) {
              value += next;
            } else {
              // systemd env-file.c preserves literal backslash for non-special sequences (e.g. \n, \t).
              value += "\\" + next;
            }
            continue;
          }
          if (qc === "\n") lineNo++;
          value += qc;
        }
        if (!closed) {
          throw new Error(`Unterminated double-quoted value in --env-file at line ${quoteStart}`);
        }
        continue;
      }
      if (ch === "\\") {
        i++;
        if (i >= len) break;
        const next = src[i++];
        if (next === "\n") {
          // Unquoted line continuation: discard both \ and newline.
          lineNo++;
          continue;
        }
        value += pendingSpaces + next;
        pendingSpaces = "";
        continue;
      }
      value += pendingSpaces + ch;
      pendingSpaces = "";
      i++;
    }

    entries[key] = value;
  }

  return entries;
}

function loadEnvFile(filePath, baseEnv = process.env) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("--env-file requires a file path");
  }
  let raw;
  let fd = null;
  try {
    const lst = fs.lstatSync(filePath);
    if (lst.isSymbolicLink()) {
      throw new Error(`Refusing symlink --env-file: ${filePath}`);
    }
    if (!lst.isFile()) {
      throw new Error(`--env-file is not a regular file: ${filePath}`);
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(filePath, flags);
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) {
      throw new Error(`--env-file is not a regular file: ${filePath}`);
    }
    raw = fs.readFileSync(fd, "utf8");
  } catch (err) {
    if (err && /Refusing symlink --env-file|--env-file is not a regular file/.test(err.message)) {
      throw err;
    }
    if (err && err.code === "ELOOP") {
      throw new Error(`Refusing symlink --env-file: ${filePath}`);
    }
    const code = err?.code ? ` (${err.code})` : "";
    throw new Error(`Failed to read --env-file ${filePath}${code}`);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  const parsed = parseSystemdEnvFile(raw);
  const merged = { ...baseEnv };
  for (const [key, value] of Object.entries(parsed)) {
    if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function countBetaSpots(authDb, { nowMs = Date.now() } = {}) {
  const hasTable = name => !!authDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const registeredUsers = hasTable("user")
    ? Number(authDb.prepare("SELECT COUNT(*) AS n FROM user").get()?.n || 0)
    : 0;
  let activeUnusedInvites = 0;
  let expiredUnusedInvites = 0;
  if (hasTable("launch_invites")) {
    activeUnusedInvites = Number(
      authDb.prepare("SELECT COUNT(*) AS n FROM launch_invites WHERE consumed IS NULL AND revoked = 0 AND expires > ?")
        .get(nowMs)?.n || 0
    );
    expiredUnusedInvites = Number(
      authDb.prepare("SELECT COUNT(*) AS n FROM launch_invites WHERE consumed IS NULL AND revoked = 0 AND expires <= ?")
        .get(nowMs)?.n || 0
    );
  }
  return {
    registeredUsers,
    activeUnusedInvites,
    expiredUnusedInvites,
    spotsUsed: registeredUsers + activeUnusedInvites
  };
}

function buildInviteUrl(baseURL, invite) {
  if (typeof baseURL !== "string" || !baseURL.trim()) {
    throw new Error("AUTH_BASE_URL is required to build invitation links");
  }
  let parsedBase;
  try {
    parsedBase = new URL(baseURL.trim());
  } catch {
    throw new Error("Invalid AUTH_BASE_URL");
  }
  if (!["http:", "https:"].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password || parsedBase.pathname !== "/" || parsedBase.search || parsedBase.hash) {
    throw new Error("Invalid AUTH_BASE_URL");
  }
  const url = new URL("/login.html", parsedBase.origin);
  url.searchParams.set("invite", invite.token);
  if (invite.phone) url.searchParams.set("phone", invite.phone);
  else url.searchParams.set("email", invite.email);
  return url.href;
}

function ensureFulfillColumns(bojinDb) {
  const hasCol = () => bojinDb.prepare("PRAGMA table_info(invite_requests)").all().some(c => c.name === "fulfill_token_hash");
  if (hasCol()) return;
  runImmediateTx(bojinDb, () => {
    if (!hasCol()) {
      bojinDb.exec("ALTER TABLE invite_requests ADD COLUMN fulfill_token_hash TEXT NOT NULL DEFAULT ''");
    }
  });
}

function runImmediateTx(db, fn) {
  let inTx = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTx = true;
    const result = fn();
    db.exec("COMMIT");
    inTx = false;
    return result;
  } catch (err) {
    if (inTx) {
      try { db.exec("ROLLBACK"); } catch {}
    }
    throw err;
  }
}

function isDefiniteNonDelivery(err) {
  if (!err) return false;
  if (typeof err.responseCode === "number" && err.responseCode >= 400 && err.responseCode <= 599) {
    return true;
  }
  if (typeof err.code === "string" && DEFINITE_PRE_SEND_CODES.has(err.code)) {
    return true;
  }
  return false;
}

function sanitizeErrorCode(err, fallback = "MAIL_SEND_FAILED") {
  return typeof err?.code === "string" && SAFE_ERR_CODE_RE.test(err.code) ? err.code : fallback;
}

function formatSanitizedSendError(code, responseCode, uncertain = false) {
  const hasSmtp = typeof responseCode === "number" && Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 599;
  const suffix = hasSmtp ? `${code}, smtp=${responseCode}` : code;
  const err = new Error(
    uncertain
      ? `Mail delivery uncertain (${suffix}); invite preserved for manual verification`
      : `Mail delivery failed (${suffix})`
  );
  err.code = code;
  if (hasSmtp) err.responseCode = responseCode;
  return err;
}

async function fulfillInviteRequests({
  bojinDb,
  authDb,
  mailer = null,
  createMailerFn = null,
  baseURL,
  maxSpots = DEFAULT_MAX_BETA_SPOTS,
  expiresInDays = 7,
  targetId = null,
  now = Date.now
}) {
  const cap = positiveInt(maxSpots, DEFAULT_MAX_BETA_SPOTS, "--max-spots", MAX_BETA_SPOTS_LIMIT);
  const hasBojinTable = !!bojinDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'invite_requests'").get();
  if (!hasBojinTable) {
    if (targetId) throw new Error(`Invite request not found: ${targetId}`);
    const spots = countBetaSpots(authDb, { nowMs: now() });
    return {
      ok: true,
      spotsUsed: spots.spotsUsed,
      maxSpots: cap,
      capReached: spots.spotsUsed >= cap,
      emailedCount: 0,
      emailedIds: [],
      resolvedCount: 0,
      resolvedIds: [],
      failedCount: 0,
      failedIds: [],
      uncertainCount: 0,
      uncertainIds: [],
      phonePendingCount: 0,
      phonePendingIds: []
    };
  }

  ensureFulfillColumns(bojinDb);

  const listUncertainIds = () => bojinDb
    .prepare("SELECT id FROM invite_requests WHERE status IN ('sending', 'sending_uncertain') ORDER BY created ASC, id ASC")
    .all()
    .map(r => r.id);

  const phonePendingIds = bojinDb
    .prepare("SELECT id FROM invite_requests WHERE status = 'pending' AND contact_kind = 'phone' ORDER BY created ASC, id ASC")
    .all()
    .map(r => r.id);

  let candidateIds;
  if (targetId) {
    const row = bojinDb
      .prepare("SELECT id, contact_kind, status FROM invite_requests WHERE id = ?")
      .get(targetId);
    if (!row) throw new Error(`Invite request not found: ${targetId}`);
    if (row.status !== "pending") {
      throw new Error(`Invite request ${targetId} is not pending (status=${row.status})`);
    }
    if (row.contact_kind === "phone") {
      throw new Error(`Invite request ${targetId} is phone-only and cannot be auto-emailed; issue manually via scripts/auth-admin.js invite --phone`);
    }
    candidateIds = [row.id];
  } else {
    candidateIds = bojinDb
      .prepare("SELECT id FROM invite_requests WHERE status = 'pending' AND contact_kind = 'email' ORDER BY created ASC, id ASC")
      .all()
      .map(r => r.id);
  }

  if (!candidateIds.length) {
    const spots = countBetaSpots(authDb, { nowMs: now() });
    const uncertainIds = listUncertainIds();
    return {
      ok: true,
      spotsUsed: spots.spotsUsed,
      maxSpots: cap,
      capReached: spots.spotsUsed >= cap,
      emailedCount: 0,
      emailedIds: [],
      resolvedCount: 0,
      resolvedIds: [],
      failedCount: 0,
      failedIds: [],
      uncertainCount: uncertainIds.length,
      uncertainIds,
      phonePendingCount: phonePendingIds.length,
      phonePendingIds
    };
  }

  const invitations = createInvitations(authDb);
  let resolvedMailer = mailer;
  let mailerInitialized = Boolean(resolvedMailer);
  const ensureMailerReady = () => {
    if (mailerInitialized) {
      if (!resolvedMailer || typeof resolvedMailer.sendInvitationEmail !== "function") {
        throw new Error("Mailer with sendInvitationEmail is required");
      }
      return resolvedMailer;
    }
    buildInviteUrl(baseURL, { token: "probe", email: "probe@example.com" });
    resolvedMailer = typeof createMailerFn === "function" ? createMailerFn() : null;
    if (!resolvedMailer || typeof resolvedMailer.sendInvitationEmail !== "function") {
      throw new Error("Mailer with sendInvitationEmail is required");
    }
    mailerInitialized = true;
    return resolvedMailer;
  };

  const emailedIds = [];
  const resolvedIds = [];
  const failedIds = [];
  let capReached = false;

  const claimPendingRow = (id) => runImmediateTx(bojinDb, () => {
    const existing = bojinDb.prepare(
      "SELECT id, contact_kind, contact_value, lang, status, status_note FROM invite_requests WHERE id = ?"
    ).get(id);
    if (!existing || existing.status !== "pending" || existing.contact_kind !== "email") {
      return null;
    }
    const res = bojinDb.prepare(
      "UPDATE invite_requests SET status = 'sending', status_note = 'fulfill in progress', updated = ? WHERE id = ? AND status = 'pending' AND contact_kind = 'email'"
    ).run(new Date(now()).toISOString(), id);
    return Number(res.changes || 0) === 1 ? existing : null;
  });

  const releaseClaimToPending = (claimed) => {
    try {
      return runImmediateTx(bojinDb, () => {
        const res = bojinDb.prepare(
          "UPDATE invite_requests SET status = 'pending', status_note = ?, fulfill_token_hash = '', updated = ? WHERE id = ? AND status = 'sending'"
        ).run(claimed.status_note || "", new Date(now()).toISOString(), claimed.id);
        return Number(res.changes || 0) === 1;
      });
    } catch (err) {
      if (err && /UNIQUE constraint failed/i.test(String(err.message))) {
        runImmediateTx(bojinDb, () => {
          bojinDb.prepare(
            "UPDATE invite_requests SET status = 'dismissed', status_note = 'duplicate pending', fulfill_token_hash = '', updated = ? WHERE id = ? AND status = 'sending'"
          ).run(new Date(now()).toISOString(), claimed.id);
        });
        return true;
      }
      throw err;
    }
  };

  const finalizeRowStatus = (id, nextStatus, nextNote) => runImmediateTx(bojinDb, () => {
    const res = bojinDb.prepare(
      "UPDATE invite_requests SET status = ?, status_note = ?, updated = ? WHERE id = ? AND status = 'sending'"
    ).run(nextStatus, nextNote, new Date(now()).toISOString(), id);
    return Number(res.changes || 0) === 1;
  });

  for (const id of candidateIds) {
    // 1. Atomically claim the pending row in bojin.db (BEGIN IMMEDIATE) so no two workers pick it up.
    const claimed = claimPendingRow(id);
    if (!claimed) {
      if (targetId) {
        throw new Error(`Invite request ${targetId} is no longer pending`);
      }
      continue;
    }

    // 2. Atomically check existing user, existing active invite, and capacity in auth.sqlite (BEGIN IMMEDIATE)
    //    before issuing a new invitation.
    let reservation;
    try {
      reservation = invitations.reserveEmailForFulfillment(claimed.contact_value, {
        expiresInDays,
        maxSpots: cap,
        nowMs: now()
      });
    } catch (err) {
      try { releaseClaimToPending(claimed); } catch {}
      if (targetId) {
        throw new Error("Failed to reserve invitation");
      }
      failedIds.push({ id: claimed.id, code: "INVITE_ISSUE_FAILED" });
      continue;
    }

    if (reservation.outcome === "already_registered") {
      const ok = finalizeRowStatus(claimed.id, "dismissed", ALREADY_REGISTERED_NOTE);
      if (!ok) {
        if (targetId) throw new Error("Failed to update invite request status (STATUS_UPDATE_FAILED)");
        failedIds.push({ id: claimed.id, code: "STATUS_UPDATE_FAILED" });
      } else {
        resolvedIds.push({ id: claimed.id, code: "already_registered", status: "dismissed" });
      }
      continue;
    }

    if (reservation.outcome === "already_invited") {
      // Preserve existing active invite untouched; resolve request without sending a duplicate or revoking.
      const ok = finalizeRowStatus(claimed.id, "invited", EXISTING_ACTIVE_INVITE_NOTE);
      if (!ok) {
        if (targetId) throw new Error("Failed to update invite request status (STATUS_UPDATE_FAILED)");
        failedIds.push({ id: claimed.id, code: "STATUS_UPDATE_FAILED" });
      } else {
        resolvedIds.push({ id: claimed.id, code: "already_invited", status: "invited" });
      }
      continue;
    }

    if (reservation.outcome === "cap_reached") {
      releaseClaimToPending(claimed);
      capReached = true;
      break;
    }

    // 3. Validate mailer & AUTH_BASE_URL and durably record tokenHash on the sending row BEFORE calling SMTP.
    let activeMailer;
    let inviteUrl;
    try {
      activeMailer = ensureMailerReady();
      inviteUrl = buildInviteUrl(baseURL, reservation);
      const recorded = runImmediateTx(bojinDb, () => {
        const res = bojinDb.prepare(
          "UPDATE invite_requests SET fulfill_token_hash = ?, updated = ? WHERE id = ? AND status = 'sending'"
        ).run(reservation.tokenHash, new Date(now()).toISOString(), claimed.id);
        return Number(res.changes || 0) === 1;
      });
      if (!recorded) {
        throw Object.assign(new Error("Failed to persist fulfillment reservation"), { code: "STATUS_UPDATE_FAILED" });
      }
    } catch (prepErr) {
      let revokeOk = false;
      try {
        const rev = invitations.revoke(reservation.token);
        revokeOk = Number(rev?.changes || 0) === 1;
      } catch {
        revokeOk = false;
      }
      if (revokeOk) {
        try { releaseClaimToPending(claimed); } catch {}
        throw prepErr;
      }
      try { finalizeRowStatus(claimed.id, "sending_uncertain", ROLLBACK_REVOKE_FAILED_NOTE); } catch {}
      const revErr = new Error("Rollback revocation failed (ROLLBACK_REVOKE_FAILED)");
      revErr.code = "ROLLBACK_REVOKE_FAILED";
      throw revErr;
    }

    // 4. Deliver invitation email.
    try {
      await activeMailer.sendInvitationEmail({
        to: reservation.email,
        url: inviteUrl,
        lang: claimed.lang,
        expiresInDays
      });
    } catch (sendErr) {
      const code = sanitizeErrorCode(sendErr, "MAIL_SEND_FAILED");
      const smtpCode = typeof sendErr?.responseCode === "number" ? sendErr.responseCode : null;

      if (isDefiniteNonDelivery(sendErr)) {
        // Definitely not delivered: revoke the freshly reserved token and verify revocation succeeded.
        let revokeOk = false;
        try {
          const rev = invitations.revoke(reservation.token);
          revokeOk = Number(rev?.changes || 0) === 1;
        } catch {
          revokeOk = false;
        }

        if (!revokeOk) {
          try { finalizeRowStatus(claimed.id, "sending_uncertain", ROLLBACK_REVOKE_FAILED_NOTE); } catch {}
          if (targetId) {
            const revErr = new Error("Mail delivery failed and rollback revocation failed (ROLLBACK_REVOKE_FAILED)");
            revErr.code = "ROLLBACK_REVOKE_FAILED";
            throw revErr;
          }
          failedIds.push({ id: claimed.id, code: "ROLLBACK_REVOKE_FAILED", uncertain: true });
          continue;
        }

        let resetOk = false;
        try {
          resetOk = releaseClaimToPending(claimed);
        } catch {
          resetOk = false;
        }
        if (!resetOk) {
          if (targetId) {
            const stErr = new Error("Mail delivery failed and status rollback failed (ROLLBACK_STATUS_FAILED)");
            stErr.code = "ROLLBACK_STATUS_FAILED";
            throw stErr;
          }
          failedIds.push({ id: claimed.id, code: "ROLLBACK_STATUS_FAILED" });
          continue;
        }

        if (targetId) {
          throw formatSanitizedSendError(code, smtpCode, false);
        }
        failedIds.push({ id: claimed.id, code });
        continue;
      }

      // Mid-flight ambiguous error: SMTP may have accepted the message; NEVER revoke token or reset to pending!
      try { finalizeRowStatus(claimed.id, "sending_uncertain", DELIVERY_UNCERTAIN_NOTE); } catch {}
      if (targetId) {
        throw formatSanitizedSendError(code, smtpCode, true);
      }
      failedIds.push({ id: claimed.id, code, uncertain: true });
      continue;
    }

    // 5. SMTP accepted the email: finalize request status to 'invited' and verify changes === 1.
    //    If this DB write fails, NEVER revoke the delivered token or reset to 'pending' (row stays
    //    durably in 'sending'/'sending_uncertain' so retries cannot rotate/revoke the delivered link).
    let finalized = false;
    try {
      finalized = finalizeRowStatus(claimed.id, "invited", AUTO_EMAILED_NOTE);
    } catch {
      finalized = false;
    }
    if (!finalized) {
      try {
        finalizeRowStatus(claimed.id, "sending_uncertain", "email accepted; status finalize failed");
      } catch {}
      if (targetId) {
        const finErr = new Error("Invite email accepted but failed to finalize request status (STATUS_UPDATE_FAILED)");
        finErr.code = "STATUS_UPDATE_FAILED";
        throw finErr;
      }
      failedIds.push({ id: claimed.id, code: "STATUS_UPDATE_FAILED", deliveryAccepted: true });
      continue;
    }

    emailedIds.push(claimed.id);
  }

  const spots = countBetaSpots(authDb, { nowMs: now() });
  const uncertainIds = listUncertainIds();
  return {
    ok: failedIds.length === 0,
    spotsUsed: spots.spotsUsed,
    maxSpots: cap,
    capReached: capReached || spots.spotsUsed >= cap,
    emailedCount: emailedIds.length,
    emailedIds,
    resolvedCount: resolvedIds.length,
    resolvedIds,
    failedCount: failedIds.length,
    failedIds,
    uncertainCount: uncertainIds.length,
    uncertainIds,
    phonePendingCount: phonePendingIds.length,
    phonePendingIds
  };
}

module.exports = {
  MAX_BODY_BYTES,
  DEFAULT_BODY_TIMEOUT_MS,
  MAX_BODY_TIMEOUT_MS,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  RATE_LIMIT_RETENTION_DAYS,
  MAX_NAME_LEN,
  MAX_GOAL_LEN,
  MAX_NOTE_LEN,
  MAX_STATUS_NOTE_LEN,
  DEFAULT_IP_HOURLY_LIMIT,
  DEFAULT_IP_DAILY_LIMIT,
  DEFAULT_GLOBAL_DAILY_LIMIT,
  DEFAULT_MAX_BETA_SPOTS,
  MAX_BETA_SPOTS_LIMIT,
  AUTO_EMAILED_NOTE,
  ALLOWED_KINDS,
  ALLOWED_STATUSES,
  inviteRequestOptions,
  sanitizeName,
  sanitizeContact,
  sanitizeGoal,
  sanitizeNote,
  sanitizeStatusNote,
  sanitizeLang,
  readInviteRequestBody,
  formatAlertBody,
  parseAlertUrl,
  sendInviteRequestAlert,
  pruneInviteRequestData,
  createInviteRequests,
  parseSystemdEnvFile,
  loadEnvFile,
  countBetaSpots,
  buildInviteUrl,
  fulfillInviteRequests
};
