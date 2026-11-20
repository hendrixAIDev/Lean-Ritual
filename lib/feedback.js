"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MAX_UPLOAD_BYTES } = require("./uploads");

const MAX_MESSAGE_LEN = 2000;
const MAX_BODY_BYTES = 21 * 1024 * 1024;
const DEFAULT_DAILY_LIMIT = 10;
const DEFAULT_GLOBAL_DAILY_LIMIT = 100;
const ALERT_EXCERPT_LEN = 100;
const ALERT_TIMEOUT_MS = 3000;
const ALERT_MAX_REDIRECTS = 5;

const ALLOWED_TYPES = new Set(["bug", "idea", "other"]);
const ALLOWED_PAGES = new Set([
  "today", "food", "log", "fb", "me", "setup", "boot",
  "login", "app", "privacy", "guide", "unknown"
]);
const ALLOWED_LANGS = new Set(["zh", "en", "unknown"]);
const ALLOWED_IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;
const REV_HEX_RE = /^[0-9a-f]{7,40}$/i;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const INLINE_CONTROL_RE = /[\x00-\x1f\x7f\u2028\u2029]+/g;
const MESSAGE_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function fail(status, code, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function positiveInt(raw, fallback, name) {
  const n = raw == null || String(raw).trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

function feedbackOptions(env = process.env) {
  return {
    daily: positiveInt(env.FEEDBACK_DAILY_LIMIT, DEFAULT_DAILY_LIMIT, "FEEDBACK_DAILY_LIMIT"),
    globalDaily: positiveInt(env.FEEDBACK_GLOBAL_DAILY_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT, "FEEDBACK_GLOBAL_DAILY_LIMIT"),
    alertUrl: typeof env.ALERT_URL === "string" ? env.ALERT_URL.trim() : ""
  };
}

function sanitizeType(raw) {
  if (typeof raw !== "string") throw fail(400, "bad_request", "请选择反馈类型");
  const v = raw.trim().toLowerCase();
  if (!ALLOWED_TYPES.has(v)) throw fail(400, "bad_request", "反馈类型无效");
  return v;
}

function sanitizeMessage(raw) {
  if (typeof raw !== "string") throw fail(400, "bad_request", "请填写反馈内容");
  const cleaned = raw.replace(/\r\n?/g, "\n").replace(MESSAGE_CONTROL_RE, "").trim();
  if (!cleaned) throw fail(400, "bad_request", "请填写反馈内容");
  if (Array.from(cleaned).length > MAX_MESSAGE_LEN) {
    throw fail(400, "message_too_long", `反馈内容最多 ${MAX_MESSAGE_LEN} 字`);
  }
  return cleaned;
}

function sanitizeInline(raw, maxLen, fallback = "unknown") {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.replace(INLINE_CONTROL_RE, " ").trim();
  if (!cleaned) return fallback;
  return Array.from(cleaned).slice(0, maxLen).join("");
}

function sanitizeRevision(raw, serverRevision) {
  const fallback = serverRevision && REV_HEX_RE.test(serverRevision)
    ? serverRevision.slice(0, 12).toLowerCase()
    : "dev";
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const trimmed = raw.replace(INLINE_CONTROL_RE, "").trim();
  if (REV_HEX_RE.test(trimmed)) return trimmed.slice(0, 12).toLowerCase();
  if (trimmed === "dev") return "dev";
  return fallback;
}

function sanitizeDeviceInfo(raw, { includeDeviceInfo, releaseRevision, now = Date.now }) {
  if (includeDeviceInfo !== true) return null;
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawPage = typeof src.page === "string" ? src.page.replace(INLINE_CONTROL_RE, "").trim().toLowerCase() : "";
  const rawLang = typeof src.lang === "string" ? src.lang.replace(INLINE_CONTROL_RE, "").trim().toLowerCase() : "";
  const rawTime = typeof src.clientTime === "string" ? src.clientTime.replace(INLINE_CONTROL_RE, "").trim() : "";
  const clientTime = ISO_UTC_RE.test(rawTime) && Number.isFinite(Date.parse(rawTime))
    ? rawTime
    : new Date(now()).toISOString();
  return {
    revision: sanitizeRevision(src.revision, releaseRevision),
    page: ALLOWED_PAGES.has(rawPage) ? rawPage : "unknown",
    userAgent: sanitizeInline(src.userAgent, 300, "unknown"),
    screen: sanitizeInline(src.screen, 64, "unknown"),
    lang: ALLOWED_LANGS.has(rawLang) ? rawLang : "unknown",
    online: typeof src.online === "boolean" ? src.online : null,
    clientTime
  };
}

function decodeScreenshot(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw fail(400, "bad_request", "截图格式无效");
  const contentType = String(raw.contentType || "").split(";")[0].trim();
  if (!ALLOWED_IMAGE_TYPES.test(contentType)) {
    throw fail(415, "bad_type", "照片格式无效，请使用 JPG、PNG、WebP 或已转换的 HEIC 照片");
  }
  if (typeof raw.dataBase64 !== "string") throw fail(400, "bad_request", "截图内容无效");
  const cleaned = raw.dataBase64.replace(/\s+/g, "");
  if (!cleaned || cleaned.length % 4 !== 0 || !BASE64_RE.test(cleaned)) {
    throw fail(400, "bad_request", "截图编码无效");
  }
  const approxBytes = Math.floor((cleaned.length * 3) / 4);
  if (approxBytes > MAX_UPLOAD_BYTES + 2) {
    throw fail(413, "too_large", "截图太大，不能超过 15 MB");
  }
  const buf = Buffer.from(cleaned, "base64");
  if (!buf.length) throw fail(415, "bad_type", "照片格式无效，请使用 JPG、PNG、WebP 或已转换的 HEIC 照片");
  if (buf.length > MAX_UPLOAD_BYTES) throw fail(413, "too_large", "截图太大，不能超过 15 MB");
  return buf;
}

function parseAlertUrl(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) return { invalid: true };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || !parsed.hostname) return { invalid: true };
    return { url: parsed.href };
  } catch {
    return { invalid: true };
  }
}

function formatAlertBody(record) {
  const flat = String(record.message || "").replace(INLINE_CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  const excerpt = chars.length > ALERT_EXCERPT_LEN
    ? chars.slice(0, ALERT_EXCERPT_LEN).join("") + "…"
    : flat;
  const imgTag = record.screenshotBlobId ? " [+img]" : "";
  return `[${record.type}] #${record.id} (${record.uid})${imgTag}: ${excerpt}`;
}

async function sendFeedbackAlert({
  alertUrl,
  record,
  fetcher = fetch,
  timeoutMs = ALERT_TIMEOUT_MS,
  log = console.warn
}) {
  const parsed = parseAlertUrl(alertUrl);
  if (!parsed) return { sent: false, skipped: true };
  if (parsed.invalid) {
    log("feedback alert skipped: invalid or non-HTTPS ALERT_URL");
    return { sent: false, skipped: true, reason: "invalid_url" };
  }
  const tags = record.type === "bug" ? "bug" : record.type === "idea" ? "bulb" : "speech_balloon";
  const headers = {
    Title: `Lean Ritual Feedback (${record.type})`,
    Tags: tags,
    "Content-Type": "text/plain; charset=utf-8"
  };
  const body = formatAlertBody(record);
  let currentUrl = parsed.url;
  try {
    for (let hop = 0; hop <= ALERT_MAX_REDIRECTS; hop++) {
      const res = await fetcher(currentUrl, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.status >= 200 && res.status < 300) {
        return { sent: true, status: res.status };
      }
      if ([301, 302, 303, 307, 308].includes(res.status) && hop < ALERT_MAX_REDIRECTS) {
        const loc = res.headers?.get?.("location");
        if (!loc) {
          log(`feedback alert failed: redirect without location (http=${res.status})`);
          return { sent: false, status: res.status };
        }
        let nextUrl;
        try {
          nextUrl = new URL(loc, currentUrl);
        } catch {
          log("feedback alert failed: invalid redirect URL");
          return { sent: false, reason: "bad_redirect" };
        }
        if (nextUrl.protocol !== "https:") {
          log("feedback alert failed: refusing non-HTTPS redirect");
          return { sent: false, reason: "non_https_redirect" };
        }
        currentUrl = nextUrl.href;
        continue;
      }
      log(`feedback alert failed (http=${res.status})`);
      return { sent: false, status: res.status };
    }
    log("feedback alert failed: too many redirects");
    return { sent: false, reason: "too_many_redirects" };
  } catch (err) {
    const code = err?.name || err?.code || "error";
    log(`feedback alert failed (${code})`);
    return { sent: false, error: code };
  }
}

function createFeedback(db, dataDir, {
  uploads,
  accountData = null,
  releaseRevision = undefined,
  daily = DEFAULT_DAILY_LIMIT,
  globalDaily = DEFAULT_GLOBAL_DAILY_LIMIT,
  alertUrl = "",
  fetcher = fetch,
  now = Date.now,
  log = console.warn
} = {}) {
  positiveInt(daily, DEFAULT_DAILY_LIMIT, "FEEDBACK_DAILY_LIMIT");
  positiveInt(globalDaily, DEFAULT_GLOBAL_DAILY_LIMIT, "FEEDBACK_GLOBAL_DAILY_LIMIT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      screenshot_blob_id TEXT,
      device_info TEXT,
      created TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feedback_created ON feedback(created DESC);
    CREATE INDEX IF NOT EXISTS feedback_uid ON feedback(uid, created DESC);
    CREATE TABLE IF NOT EXISTS feedback_usage (
      uid TEXT NOT NULL,
      day TEXT NOT NULL,
      n INTEGER NOT NULL,
      PRIMARY KEY(uid, day)
    );
  `);

  function checkRateLimit(uid, day) {
    const used = db.prepare("SELECT n FROM feedback_usage WHERE uid = ? AND day = ?").get(uid, day)?.n || 0;
    const total = db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM feedback_usage WHERE day = ?").get(day).n;
    if (used >= daily || total >= globalDaily) {
      throw fail(429, "feedback_rate_limited", "今天提交的反馈已达上限，请明天再试");
    }
  }

  async function submit(user, body) {
    if (!user || typeof user.id !== "string" || !user.id) throw fail(401, "session_expired", "请先登录");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "bad_request", "请求格式不正确");
    accountData?.ensureActive?.(user.id);

    const type = sanitizeType(body.type);
    const message = sanitizeMessage(body.message);
    const includeDeviceInfo = body.includeDeviceInfo === true;
    const deviceInfo = sanitizeDeviceInfo(body.deviceInfo, { includeDeviceInfo, releaseRevision, now });
    const screenshotBuf = decodeScreenshot(body.screenshot);

    const day = new Date(now()).toISOString().slice(0, 10);
    checkRateLimit(user.id, day);

    let savedBlob = null;
    if (screenshotBuf) {
      if (!uploads) throw fail(503, "server_error", "暂不支持上传截图");
      const release = uploads.begin(user.id);
      try {
        const normalized = await uploads.normalize(screenshotBuf);
        accountData?.ensureActive?.(user.id);
        savedBlob = uploads.save(user.id, normalized, null);
      } finally {
        release();
      }
    }

    const id = "fb_" + crypto.randomBytes(6).toString("hex");
    const created = new Date(now()).toISOString();
    const deviceInfoJson = deviceInfo ? JSON.stringify(deviceInfo) : null;
    const screenshotBlobId = savedBlob ? savedBlob.id : null;

    db.exec("BEGIN IMMEDIATE");
    try {
      accountData?.ensureActive?.(user.id);
      const txDay = new Date(now()).toISOString().slice(0, 10);
      checkRateLimit(user.id, txDay);
      db.prepare("INSERT INTO feedback_usage (uid, day, n) VALUES (?, ?, 1) ON CONFLICT(uid, day) DO UPDATE SET n = n + 1")
        .run(user.id, txDay);
      db.prepare("INSERT INTO feedback (id, uid, type, message, screenshot_blob_id, device_info, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, user.id, type, message, screenshotBlobId, deviceInfoJson, created);
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      if (savedBlob) {
        try { db.prepare("DELETE FROM blobs WHERE id = ? AND uid = ?").run(savedBlob.id, user.id); } catch {}
        try { fs.rmSync(path.join(dataDir, "blobs", savedBlob.id), { force: true }); } catch {}
      }
      throw err;
    }

    const record = { id, uid: user.id, type, message, screenshotBlobId, deviceInfo, created };
    await sendFeedbackAlert({ alertUrl, record, fetcher, log });
    return { ok: true, id, created, hasScreenshot: !!screenshotBlobId };
  }

  return { submit };
}

module.exports = {
  MAX_MESSAGE_LEN,
  MAX_BODY_BYTES,
  DEFAULT_DAILY_LIMIT,
  DEFAULT_GLOBAL_DAILY_LIMIT,
  ALLOWED_TYPES,
  feedbackOptions,
  sanitizeType,
  sanitizeMessage,
  sanitizeDeviceInfo,
  decodeScreenshot,
  parseAlertUrl,
  formatAlertBody,
  sendFeedbackAlert,
  createFeedback
};
