"use strict";
const crypto = require("node:crypto");
const { normalizeEmail } = require("./invitations");
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
  createInviteRequests
};
