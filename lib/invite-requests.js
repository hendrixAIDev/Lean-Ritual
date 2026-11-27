"use strict";
const crypto = require("node:crypto");
const { normalizeEmail } = require("./invitations");
const { normalizePhone, isSyntheticPhoneEmail } = require("./phone");
const { ALERT_TIMEOUT_MS, parseAlertUrl, sendAlert } = require("./alerts");

const MAX_BODY_BYTES = 8192;
const MAX_NAME_LEN = 80;
const MAX_GOAL_LEN = 500;
const MAX_NOTE_LEN = 500;
const MAX_STATUS_NOTE_LEN = 200;
const MAX_EMAIL_LEN = 254;
const ALERT_GOAL_MAX_CHARS = 80;

const DEFAULT_IP_HOURLY_LIMIT = 5;
const DEFAULT_IP_DAILY_LIMIT = 10;
const DEFAULT_GLOBAL_DAILY_LIMIT = 200;

const ALLOWED_KINDS = new Set(["phone", "email"]);
const ALLOWED_STATUSES = new Set(["pending", "invited", "dismissed"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INLINE_CONTROL_RE = /[\x00-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]+/g;
const BIDI_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]+/g;
const MULTILINE_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;

// Redaction patterns for ALERT_URL goal previews (zero PII in third-party alert payloads).
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const REDACT_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const REDACT_PHONE_RE = /(?<!\d)\+?\d(?:[\d\s().-]{5,}\d)/g;
const REDACT_LONG_DIGITS_RE = /\d{5,}/g;

function fail(status, code, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function positiveInt(raw, fallback, name) {
  const n = raw == null || String(raw).trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

function inviteRequestOptions(env = process.env) {
  return {
    ipHourly: positiveInt(env.INVITE_REQUEST_IP_HOURLY_LIMIT, DEFAULT_IP_HOURLY_LIMIT, "INVITE_REQUEST_IP_HOURLY_LIMIT"),
    ipDaily: positiveInt(env.INVITE_REQUEST_IP_DAILY_LIMIT, DEFAULT_IP_DAILY_LIMIT, "INVITE_REQUEST_IP_DAILY_LIMIT"),
    globalDaily: positiveInt(env.INVITE_REQUEST_GLOBAL_DAILY_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT, "INVITE_REQUEST_GLOBAL_DAILY_LIMIT"),
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

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip PII (emails, phones, URLs, long digit runs, and any occurrence of the applicant's
// own name or contact value) before including a short goal preview in third-party alerts.
function redactGoalForAlert(goal, { name = "", contactValue = "" } = {}) {
  let text = String(goal || "")
    .replace(INLINE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (contactValue && contactValue.length >= 4) {
    text = text.replace(new RegExp(escapeRegExp(contactValue), "gi"), "[redacted]");
  }
  const trimmedName = String(name || "").trim();
  if (Array.from(trimmedName).length >= 2) {
    text = text.replace(new RegExp(escapeRegExp(trimmedName), "gi"), "[redacted]");
  }

  text = text
    .replace(URL_RE, "[redacted]")
    .replace(REDACT_EMAIL_RE, "[redacted]")
    .replace(REDACT_PHONE_RE, "[redacted]")
    .replace(REDACT_LONG_DIGITS_RE, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();

  const chars = Array.from(text);
  if (chars.length > ALERT_GOAL_MAX_CHARS) {
    return chars.slice(0, ALERT_GOAL_MAX_CHARS).join("") + "…";
  }
  return text;
}

function formatAlertBody(record) {
  const id = String(record.id || "").replace(INLINE_CONTROL_RE, "");
  const kind = ALLOWED_KINDS.has(record.contactKind) ? record.contactKind : "unknown";
  const preview = redactGoalForAlert(record.goal, {
    name: record.name,
    contactValue: record.contactValue
  });
  return `[invite-request] #${id} (${kind}): ${preview}`;
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

function createInviteRequests(db, {
  ipHourly = DEFAULT_IP_HOURLY_LIMIT,
  ipDaily = DEFAULT_IP_DAILY_LIMIT,
  globalDaily = DEFAULT_GLOBAL_DAILY_LIMIT,
  alertUrl = "",
  ipHashSecret = "",
  fetcher = fetch,
  now = Date.now,
  log = console.warn
} = {}) {
  positiveInt(ipHourly, DEFAULT_IP_HOURLY_LIMIT, "INVITE_REQUEST_IP_HOURLY_LIMIT");
  positiveInt(ipDaily, DEFAULT_IP_DAILY_LIMIT, "INVITE_REQUEST_IP_DAILY_LIMIT");
  positiveInt(globalDaily, DEFAULT_GLOBAL_DAILY_LIMIT, "INVITE_REQUEST_GLOBAL_DAILY_LIMIT");

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
  `);

  const ipHashKey = crypto
    .createHash("sha256")
    .update("lean-ritual:invite-request-ip:v1:")
    .update(String(ipHashSecret || crypto.randomBytes(16).toString("hex")))
    .digest();

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
    const cutoffDay = new Date(nowMs - 2 * 86400 * 1000).toISOString().slice(0, 10);
    const ipBucket = hashIpBucket(ip);

    let id;
    let created;
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
        "SELECT id, created FROM invite_requests WHERE contact_kind = ? AND contact_value = ? AND status = 'pending'"
      ).get(contactKind, contactValue);

      if (existing) {
        id = existing.id;
        created = existing.created;
        deduplicated = true;
        db.prepare(
          "UPDATE invite_requests SET name = ?, goal = ?, note = ?, lang = ?, updated = ? WHERE id = ?"
        ).run(name, goal, note, lang, iso, id);
      } else {
        id = "req_" + crypto.randomBytes(6).toString("hex");
        created = iso;
        db.prepare(
          `INSERT INTO invite_requests
            (id, name, contact_kind, contact_value, goal, note, lang, status, status_note, created, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)`
        ).run(id, name, contactKind, contactValue, goal, note, lang, created, iso);
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

    if (!deduplicated) {
      await sendInviteRequestAlert({
        alertUrl,
        record: { id, name, contactKind, contactValue, goal, created },
        fetcher,
        log
      });
    }

    return {
      ok: true,
      id,
      contactKind,
      created,
      updated: iso,
      deduplicated,
      honeypot: false
    };
  }

  return { submit };
}

module.exports = {
  MAX_BODY_BYTES,
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
  redactGoalForAlert,
  formatAlertBody,
  parseAlertUrl,
  sendInviteRequestAlert,
  createInviteRequests
};
