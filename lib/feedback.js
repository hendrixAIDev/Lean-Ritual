"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MAX_UPLOAD_BYTES } = require("./uploads");
const { normalizeUA, parseUA } = require("../public/client-errors");

const MAX_MESSAGE_LEN = 2000;
const MAX_BODY_BYTES = 21 * 1024 * 1024;
const DEFAULT_DAILY_LIMIT = 10;
const DEFAULT_GLOBAL_DAILY_LIMIT = 100;
const DEFAULT_MAX_CONCURRENT = 2;
const ALERT_TIMEOUT_MS = 3000;
const MAX_DIM = 20000;
const MIN_DPR = 0.25;
const MAX_DPR = 10;

const ALLOWED_TYPES = new Set(["bug", "idea", "other"]);
const ALLOWED_PAGES = new Set([
  "today", "food", "log", "fb", "me", "setup", "boot",
  "login", "app", "privacy", "guide", "unknown"
]);
const ALLOWED_LANGS = new Set(["zh", "en", "unknown"]);
const ALLOWED_IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;
const REV_HEX_RE = /^[0-9a-f]{7,40}$/i;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SCREEN_STR_RE = /^(\d{1,5})x(\d{1,5})(?: \((\d{1,5})x(\d{1,5}), dpr (\d{1,2}(?:\.\d{1,2})?)\))?$/;
const INLINE_CONTROL_RE = /[\x00-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]+/g;
const MESSAGE_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g;
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
  if (typeof raw !== "string") throw fail(400, "bad_request", "请填写意见反馈内容");
  const cleaned = raw.replace(/\r\n?/g, "\n").replace(MESSAGE_CONTROL_RE, "").trim();
  if (!cleaned) throw fail(400, "bad_request", "请填写意见反馈内容");
  if (Array.from(cleaned).length > MAX_MESSAGE_LEN) {
    throw fail(400, "message_too_long", `意见反馈内容最多 ${MAX_MESSAGE_LEN} 字`);
  }
  return cleaned;
}

function sanitizeRevision(raw, serverRevision) {
  const fallback = serverRevision && REV_HEX_RE.test(serverRevision)
    ? serverRevision.slice(0, 12).toLowerCase()
    : "dev";
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string") throw fail(400, "bad_request", "设备信息格式无效");
  const trimmed = raw.replace(INLINE_CONTROL_RE, "").trim();
  if (REV_HEX_RE.test(trimmed)) return trimmed.slice(0, 12).toLowerCase();
  if (trimmed === "dev") return "dev";
  return fallback;
}

function sanitizeUserAgent(raw) {
  if (raw === undefined || raw === null || raw === "") return "Other/Other";
  if (typeof raw !== "string") throw fail(400, "bad_request", "设备信息格式无效");
  const trimmed = raw.replace(INLINE_CONTROL_RE, " ").trim().slice(0, 300);
  if (!trimmed) return "Other/Other";
  const direct = normalizeUA(trimmed);
  if (direct !== "Other/Other" || trimmed === "Other/Other") return direct;
  return parseUA(trimmed);
}

function validDim(n) {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_DIM;
}

function validDpr(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= MIN_DPR && n <= MAX_DPR;
}

function sanitizeScreen(raw) {
  if (raw === undefined || raw === null || raw === "") return "unknown";
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const w = raw.width, h = raw.height;
    if (!validDim(w) || !validDim(h)) throw fail(400, "bad_request", "屏幕尺寸格式无效");
    const vw = raw.viewportWidth === undefined ? w : raw.viewportWidth;
    const vh = raw.viewportHeight === undefined ? h : raw.viewportHeight;
    if (!validDim(vw) || !validDim(vh)) throw fail(400, "bad_request", "屏幕尺寸格式无效");
    const dpr = raw.dpr === undefined ? 1 : raw.dpr;
    if (!validDpr(dpr)) throw fail(400, "bad_request", "屏幕尺寸格式无效");
    return `${w}x${h} (${vw}x${vh}, dpr ${dpr.toFixed(2)})`;
  }
  if (typeof raw !== "string") throw fail(400, "bad_request", "屏幕尺寸格式无效");
  const trimmed = raw.replace(INLINE_CONTROL_RE, "").trim();
  if (trimmed.length > 64) return "unknown";
  const m = trimmed.match(SCREEN_STR_RE);
  if (!m) return "unknown";
  const w = Number(m[1]), h = Number(m[2]);
  if (!validDim(w) || !validDim(h)) return "unknown";
  if (m[3] !== undefined) {
    const vw = Number(m[3]), vh = Number(m[4]), dpr = Number(m[5]);
    if (!validDim(vw) || !validDim(vh) || !validDpr(dpr)) return "unknown";
    return `${w}x${h} (${vw}x${vh}, dpr ${dpr.toFixed(2)})`;
  }
  return `${w}x${h}`;
}

function sanitizeDeviceInfo(raw, { includeDeviceInfo, releaseRevision, now = Date.now }) {
  if (includeDeviceInfo !== true) return null;
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw fail(400, "bad_request", "设备信息格式无效");
  }
  const src = raw || {};
  if (src.page !== undefined && src.page !== null && typeof src.page !== "string") {
    throw fail(400, "bad_request", "设备信息格式无效");
  }
  if (src.lang !== undefined && src.lang !== null && typeof src.lang !== "string") {
    throw fail(400, "bad_request", "设备信息格式无效");
  }
  if (src.online !== undefined && src.online !== null && typeof src.online !== "boolean") {
    throw fail(400, "bad_request", "设备信息格式无效");
  }
  if (src.clientTime !== undefined && src.clientTime !== null && typeof src.clientTime !== "string") {
    throw fail(400, "bad_request", "设备信息格式无效");
  }
  const rawPage = typeof src.page === "string" ? src.page.replace(INLINE_CONTROL_RE, "").trim().toLowerCase() : "";
  const rawLang = typeof src.lang === "string" ? src.lang.replace(INLINE_CONTROL_RE, "").trim().toLowerCase() : "";
  const rawTime = typeof src.clientTime === "string" ? src.clientTime.replace(INLINE_CONTROL_RE, "").trim().slice(0, 40) : "";
  const clientTime = ISO_UTC_RE.test(rawTime) && Number.isFinite(Date.parse(rawTime))
    ? rawTime
    : new Date(now()).toISOString();
  return {
    revision: sanitizeRevision(src.revision, releaseRevision),
    page: ALLOWED_PAGES.has(rawPage) ? rawPage : "unknown",
    userAgent: sanitizeUserAgent(src.userAgent),
    screen: sanitizeScreen(src.screen),
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

// Never relay free-text message content, account identifiers, or device info to third-party alert channels.
function formatAlertBody(record) {
  const type = ALLOWED_TYPES.has(record.type) ? record.type : "other";
  const id = String(record.id || "").replace(INLINE_CONTROL_RE, "");
  const created = String(record.created || "").replace(INLINE_CONTROL_RE, "");
  const shot = record.screenshotBlobId ? "yes" : "no";
  return `[${type}] #${id} at ${created} screenshot=${shot}`;
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
  try {
    // Do not follow redirects: never forward alert POSTs to a second origin.
    const res = await fetcher(parsed.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.status >= 200 && res.status < 300) {
      return { sent: true, status: res.status };
    }
    if (res.status >= 300 && res.status < 400) {
      log(`feedback alert failed: redirect rejected (http=${res.status})`);
      return { sent: false, status: res.status, reason: "redirect_rejected" };
    }
    log(`feedback alert failed (http=${res.status})`);
    return { sent: false, status: res.status };
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
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  alertUrl = "",
  fetcher = fetch,
  now = Date.now,
  log = console.warn
} = {}) {
  positiveInt(daily, DEFAULT_DAILY_LIMIT, "FEEDBACK_DAILY_LIMIT");
  positiveInt(globalDaily, DEFAULT_GLOBAL_DAILY_LIMIT, "FEEDBACK_GLOBAL_DAILY_LIMIT");
  positiveInt(maxConcurrent, DEFAULT_MAX_CONCURRENT, "FEEDBACK_MAX_CONCURRENT");

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

  let active = 0;
  const activeUsers = new Set();
  const staleBlobs = new Map();

  function removeBlobSafely(blobId, uid) {
    let cleanedDb = false;
    let cleanedFile = false;
    try {
      db.prepare("DELETE FROM blobs WHERE id = ? AND uid = ?").run(blobId, uid);
      cleanedDb = true;
    } catch (cleanErr) {
      log(`feedback screenshot cleanup db failed (${cleanErr?.code || cleanErr?.name || "error"})`);
    }
    // Only unlink the disk file after the DB row is removed so a committed blobs row
    // never points to a missing file (which would break NDJSON exports and snapshots).
    if (cleanedDb) {
      try {
        fs.rmSync(path.join(dataDir, "blobs", blobId), { force: true });
        cleanedFile = true;
      } catch (cleanErr) {
        log(`feedback screenshot cleanup file failed (${cleanErr?.code || cleanErr?.name || "error"})`);
      }
    }
    if (!cleanedDb || !cleanedFile) {
      log(`feedback screenshot cleanup incomplete (db=${cleanedDb} file=${cleanedFile})`);
    }
    return { cleanedDb, cleanedFile };
  }

  function sweep() {
    for (const [blobId, uid] of staleBlobs) {
      if (accountData?.isExporting?.(uid)) continue;
      try {
        if (db.prepare("SELECT 1 FROM feedback WHERE screenshot_blob_id = ?").get(blobId)) {
          staleBlobs.delete(blobId);
          continue;
        }
      } catch {
        continue;
      }
      const { cleanedDb } = removeBlobSafely(blobId, uid);
      if (cleanedDb) staleBlobs.delete(blobId);
    }
  }

  function checkRateLimit(uid, day) {
    const used = db.prepare("SELECT n FROM feedback_usage WHERE uid = ? AND day = ?").get(uid, day)?.n || 0;
    const total = db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM feedback_usage WHERE day = ?").get(day).n;
    if (used >= daily || total >= globalDaily) {
      throw fail(429, "feedback_rate_limited", "今天提交的意见反馈已达上限，请明天再试");
    }
  }

  function begin(uid) {
    if (typeof uid !== "string" || !uid) throw fail(401, "session_expired", "请先登录");
    accountData?.ensureActive?.(uid);
    if (active >= maxConcurrent || activeUsers.has(uid)) {
      throw fail(429, "feedback_busy", "意见反馈提交处理中，请稍后重试");
    }
    const day = new Date(now()).toISOString().slice(0, 10);
    checkRateLimit(uid, day);
    active++;
    activeUsers.add(uid);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        active--;
        activeUsers.delete(uid);
      }
    };
  }

  async function submit(user, body, { prechecked = false } = {}) {
    if (!user || typeof user.id !== "string" || !user.id) throw fail(401, "session_expired", "请先登录");
    const release = prechecked ? null : begin(user.id);
    try {
      if (staleBlobs.size) sweep();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "bad_request", "请求格式不正确");
      accountData?.ensureActive?.(user.id);

      const type = sanitizeType(body.type);
      const message = sanitizeMessage(body.message);
      const includeDeviceInfo = body.includeDeviceInfo === true;
      const deviceInfo = sanitizeDeviceInfo(body.deviceInfo, { includeDeviceInfo, releaseRevision, now });

      // Check daily quota before decoding any screenshot payload.
      const day = new Date(now()).toISOString().slice(0, 10);
      checkRateLimit(user.id, day);

      const screenshotBuf = decodeScreenshot(body.screenshot);
      let savedBlob = null;
      if (screenshotBuf) {
        if (!uploads) throw fail(503, "server_error", "暂不支持上传截图");
        const releaseUpload = uploads.begin(user.id);
        try {
          const normalized = await uploads.normalize(screenshotBuf);
          accountData?.ensureActive?.(user.id);
          savedBlob = uploads.save(user.id, normalized, null);
        } finally {
          releaseUpload();
        }
      }

      const id = "fb_" + crypto.randomBytes(6).toString("hex");
      const created = new Date(now()).toISOString();
      const deviceInfoJson = deviceInfo ? JSON.stringify(deviceInfo) : null;
      const screenshotBlobId = savedBlob ? savedBlob.id : null;

      let inTx = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        inTx = true;
        accountData?.ensureActive?.(user.id);
        const txDay = new Date(now()).toISOString().slice(0, 10);
        checkRateLimit(user.id, txDay);
        db.prepare("INSERT INTO feedback_usage (uid, day, n) VALUES (?, ?, 1) ON CONFLICT(uid, day) DO UPDATE SET n = n + 1")
          .run(user.id, txDay);
        db.prepare("INSERT INTO feedback (id, uid, type, message, screenshot_blob_id, device_info, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, user.id, type, message, screenshotBlobId, deviceInfoJson, created);
        db.exec("COMMIT");
        inTx = false;
      } catch (err) {
        if (inTx) {
          try { db.exec("ROLLBACK"); } catch {}
        }
        if (savedBlob) {
          const { cleanedDb } = removeBlobSafely(savedBlob.id, user.id);
          if (!cleanedDb && staleBlobs.size < 100) {
            staleBlobs.set(savedBlob.id, user.id);
          }
        }
        throw err;
      }

      const record = { id, uid: user.id, type, message, screenshotBlobId, deviceInfo, created };
      await sendFeedbackAlert({ alertUrl, record, fetcher, log });
      return { ok: true, id, created, hasScreenshot: !!screenshotBlobId };
    } finally {
      if (release) release();
    }
  }

  return { begin, submit, sweep };
}

module.exports = {
  MAX_MESSAGE_LEN,
  MAX_BODY_BYTES,
  DEFAULT_DAILY_LIMIT,
  DEFAULT_GLOBAL_DAILY_LIMIT,
  DEFAULT_MAX_CONCURRENT,
  ALLOWED_TYPES,
  feedbackOptions,
  sanitizeType,
  sanitizeMessage,
  sanitizeScreen,
  sanitizeUserAgent,
  sanitizeDeviceInfo,
  decodeScreenshot,
  parseAlertUrl,
  formatAlertBody,
  sendFeedbackAlert,
  createFeedback
};
