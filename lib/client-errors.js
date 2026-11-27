"use strict";

const {
  ALLOWED_SOURCE_FILES,
  ALLOWED_FILTER_REASONS,
  scrubMessage,
  normalizeName,
  normalizeSource,
  normalizeUA,
  normalizeFilterReason
} = require("../public/client-errors");

const MAX_BODY_BYTES = 2048;
const MAX_MESSAGE_LEN = 300;
const MAX_BUCKETS = 10000;

const ALLOWED_PAGES = new Set([
  "today", "food", "log", "fb", "me", "setup", "boot", "consent",
  "login", "app", "privacy", "terms", "guide", "unknown"
]);
const ALLOWED_LANGS = new Set(["zh", "en", "unknown"]);
const REV_HEX_RE = /^[0-9a-f]{7,40}$/i;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL_RE = /[\x00-\x1f\x7f\u2028\u2029]+/g;

function fail(status, code, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function sanitizeName(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw fail(400, "bad_request");
  return normalizeName(raw);
}

function sanitizeSource(raw) {
  if (raw !== undefined && typeof raw !== "string") throw fail(400, "bad_request");
  return normalizeSource(raw);
}

function sanitizeRevision(raw, serverRevision) {
  const fallback = serverRevision && REV_HEX_RE.test(serverRevision) ? serverRevision.slice(0, 12).toLowerCase() : "dev";
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string") throw fail(400, "bad_request");
  const trimmed = raw.replace(CONTROL_RE, "").trim();
  if (REV_HEX_RE.test(trimmed)) return trimmed.slice(0, 12).toLowerCase();
  if (trimmed === "dev") return "dev";
  if (trimmed === "unknown") return fallback;
  return fallback;
}

function sanitizePage(raw, isAuthenticated) {
  if (raw === undefined) {
    if (!isAuthenticated) throw fail(401, "session_expired", "请先登录");
    return "unknown";
  }
  if (typeof raw !== "string") throw fail(400, "bad_request");
  const trimmed = raw.replace(CONTROL_RE, "").trim().toLowerCase();
  if (!isAuthenticated) {
    if (trimmed !== "login") throw fail(401, "session_expired", "请先登录");
    return "login";
  }
  if (!ALLOWED_PAGES.has(trimmed)) throw fail(400, "bad_request");
  return trimmed;
}

function sanitizeLang(raw) {
  if (raw === undefined || raw === "") return "unknown";
  if (typeof raw !== "string") throw fail(400, "bad_request");
  const trimmed = raw.replace(CONTROL_RE, "").trim().toLowerCase();
  return ALLOWED_LANGS.has(trimmed) ? trimmed : "unknown";
}

function sanitizeUA(raw) {
  if (raw === undefined || raw === "") return "Other/Other";
  if (typeof raw !== "string") throw fail(400, "bad_request");
  return normalizeUA(raw);
}

function sanitizeTimestamp(raw, nowFn) {
  if (raw === undefined || raw === "") return new Date(nowFn()).toISOString();
  if (typeof raw !== "string") throw fail(400, "bad_request");
  const trimmed = raw.replace(CONTROL_RE, "").trim();
  if (ISO_UTC_RE.test(trimmed) && Number.isFinite(Date.parse(trimmed))) return trimmed;
  return new Date(nowFn()).toISOString();
}

function sanitizeFilterReason(raw) {
  if (typeof raw !== "string") throw fail(400, "bad_request");
  const normalized = normalizeFilterReason(raw);
  if (!normalized) throw fail(400, "bad_request");
  return normalized;
}

function validateReport(body, { isAuthenticated, releaseRevision, now = Date.now }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "bad_request");
  const page = sanitizePage(body.page, isAuthenticated);
  const filtered = body.filtered === undefined ? null : sanitizeFilterReason(body.filtered);
  let name;
  let message;
  let source;
  if (filtered) {
    if (body.name !== undefined && typeof body.name !== "string") throw fail(400, "bad_request");
    if (body.message !== undefined && typeof body.message !== "string") throw fail(400, "bad_request");
    if (body.source !== undefined && typeof body.source !== "string") throw fail(400, "bad_request");
    name = "Error";
    message = "Error details withheld";
    source = "unknown";
  } else {
    name = sanitizeName(body.name);
    if (typeof body.message !== "string") throw fail(400, "bad_request");
    if (!body.message.trim()) throw fail(400, "bad_request");
    message = scrubMessage(body.message);
    source = sanitizeSource(body.source);
  }
  const revision = sanitizeRevision(body.revision, releaseRevision);
  const lang = sanitizeLang(body.lang);
  const ua = sanitizeUA(body.ua);
  const ts = sanitizeTimestamp(body.ts, now);
  return filtered
    ? { name, message, source, filtered, revision, page, lang, ua, ts }
    : { name, message, source, revision, page, lang, ua, ts };
}

function formatLogLine(report, isAuthenticated) {
  const auth = isAuthenticated ? "user" : "anon";
  // Every field is allowlisted or JSON-encoded with control chars stripped: strictly 1 line.
  if (report.filtered) {
    return `client-error-filtered auth=${auth} page=${report.page} lang=${report.lang} rev=${report.revision} ua=${report.ua} reason=${report.filtered} ts=${report.ts}`;
  }
  return `client-error auth=${auth} page=${report.page} lang=${report.lang} rev=${report.revision} ua=${report.ua} source=${report.source} name=${report.name} ts=${report.ts} msg=${JSON.stringify(report.message)}`;
}

function createWindowLimiter(limit, windowMs, nowFn) {
  const buckets = new Map();
  function prune(t) {
    for (const [key, slot] of buckets) {
      if (t < slot.until) break;
      buckets.delete(key);
    }
  }
  return {
    canTake(key) {
      const t = nowFn();
      prune(t);
      const slot = buckets.get(key);
      return slot ? slot.n < limit : buckets.size < MAX_BUCKETS;
    },
    take(key) {
      const t = nowFn();
      prune(t);
      let slot = buckets.get(key);
      if (!slot) {
        slot = { until: t + windowMs, n: 0 };
        buckets.set(key, slot);
      }
      slot.n++;
    }
  };
}

function checkSameOrigin(req, expectedOrigin) {
  if (req.headers["x-bojin"] !== "1") throw fail(403, "csrf", "请求来源不对");
  const origin = req.headers.origin;
  if (origin !== undefined && String(origin).trim() !== expectedOrigin) {
    throw fail(403, "csrf", "请求来源不对");
  }
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite !== undefined && String(fetchSite).trim().toLowerCase() !== "same-origin") {
    throw fail(403, "csrf", "请求来源不对");
  }
  const referer = req.headers.referer;
  if (referer !== undefined) {
    let refUrl;
    try { refUrl = new URL(String(referer)); } catch { throw fail(403, "csrf", "请求来源不对"); }
    if (refUrl.origin !== expectedOrigin) throw fail(403, "csrf", "请求来源不对");
    return refUrl.pathname;
  }
}

function createClientErrors({
  expectedOrigin,
  releaseRevision,
  userLimit = 20,
  ipLimit = 40,
  anonIpLimit = 5,
  globalLimit = 300,
  windowMs = 3600 * 1000,
  log = console.log,
  now = Date.now
} = {}) {
  if (!expectedOrigin || typeof expectedOrigin !== "string") {
    throw new Error("expectedOrigin is required");
  }
  const normalizedOrigin = new URL(expectedOrigin).origin;
  const globalLimiter = createWindowLimiter(globalLimit, windowMs, now);
  const userLimiter = createWindowLimiter(userLimit, windowMs, now);
  const ipLimiter = createWindowLimiter(ipLimit, windowMs, now);
  const anonIpLimiter = createWindowLimiter(anonIpLimit, windowMs, now);
  // Keep filtered browser/extension noise on independent rate limiters so it can never starve real app error reports.
  const filteredGlobalLimiter = createWindowLimiter(globalLimit, windowMs, now);
  const filteredUserLimiter = createWindowLimiter(userLimit, windowMs, now);
  const filteredIpLimiter = createWindowLimiter(ipLimit, windowMs, now);
  const filteredAnonIpLimiter = createWindowLimiter(anonIpLimit, windowMs, now);

  function readLimitedBody(req, res, fallbackReadBody) {
    const cl = Number(req.headers["content-length"]);
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
      res.setHeader?.("Connection", "close");
      return Promise.reject(fail(413, "too_large", "内容太大"));
    }
    if (typeof req.on !== "function") {
      return fallbackReadBody(req, MAX_BODY_BYTES);
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      let rejected = false;
      req.on("data", chunk => {
        n += chunk.length;
        if (n > MAX_BODY_BYTES) {
          if (!rejected) {
            rejected = true;
            res.setHeader?.("Connection", "close");
            reject(fail(413, "too_large", "内容太大"));
          }
          req.pause();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks)); });
      req.on("error", err => { if (!rejected) reject(err); });
      req.on("close", () => {
        if (!req.complete && !rejected) reject(fail(400, "bad_request"));
      });
    });
  }

  async function handle(req, res, { getUser = async () => null, ip = "?", readBody }) {
    if (req.method !== "POST") throw fail(405, "method");
    const refererPath = checkSameOrigin(req, normalizedOrigin);

    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw fail(415, "bad_type");

    const buf = await readLimitedBody(req, res, readBody);
    let parsed;
    try {
      parsed = JSON.parse(buf.toString("utf8") || "");
    } catch {
      throw fail(400, "bad_json");
    }

    const user = await getUser();
    const isAuthenticated = !!user?.id;
    if (!isAuthenticated && refererPath && refererPath !== "/login.html") {
      throw fail(403, "csrf", "请求来源不对");
    }
    const report = validateReport(parsed, { isAuthenticated, releaseRevision, now });
    const ipKey = String(ip || "?");

    const gLimiter = report.filtered ? filteredGlobalLimiter : globalLimiter;
    const iLimiter = report.filtered ? filteredIpLimiter : ipLimiter;
    const scopedLimiter = report.filtered
      ? (isAuthenticated ? filteredUserLimiter : filteredAnonIpLimiter)
      : (isAuthenticated ? userLimiter : anonIpLimiter);
    const scopedKey = isAuthenticated ? user.id : ipKey;
    if (gLimiter.canTake("all") && iLimiter.canTake(ipKey) && scopedLimiter.canTake(scopedKey)) {
      gLimiter.take("all");
      iLimiter.take(ipKey);
      scopedLimiter.take(scopedKey);
      log(formatLogLine(report, isAuthenticated));
    }
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
  }

  return { handle };
}

module.exports = {
  MAX_BODY_BYTES,
  MAX_MESSAGE_LEN,
  ALLOWED_PAGES,
  ALLOWED_SOURCE_FILES,
  ALLOWED_FILTER_REASONS,
  createClientErrors,
  scrubMessage,
  validateReport,
  formatLogLine
};
