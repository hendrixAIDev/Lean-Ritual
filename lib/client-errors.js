"use strict";

const MAX_BODY_BYTES = 2048;
const MAX_MESSAGE_LEN = 300;
const MAX_NAME_LEN = 64;
const MAX_SOURCE_LEN = 80;
const MAX_BUCKETS = 10000;

const ALLOWED_PAGES = new Set([
  "today", "food", "log", "fb", "me", "setup", "boot",
  "login", "app", "privacy", "guide", "unknown"
]);
const ALLOWED_LANGS = new Set(["zh", "en", "unknown"]);
const SOURCE_RE = /^[A-Za-z0-9._-]{1,64}(?::\d{1,7}(?::\d{1,7})?)?$/;
const REV_HEX_RE = /^[0-9a-f]{7,40}$/i;
const UA_RE = /^[A-Za-z]{2,16}\/[A-Za-z]{2,12}\d{0,3}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL_RE = /[\x00-\x1f\x7f\u2028\u2029]+/g;

function fail(status, code, message) {
  return Object.assign(new Error(message || code), { status, code });
}

function isTokenLike(word) {
  if (word.length < 16) return false;
  if (/^[0-9a-fA-F]{16,}$/.test(word)) return true;
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(word)) return true;
  if (/^(?:sk|pk|rk|re|ghp|gho|ghu|ghs|ghr|xox[baprs]|AKIA|AIza)[-_]?[A-Za-z0-9_-]{8,}$/.test(word)) return true;
  if (/^[A-Za-z0-9+/_-]{16,}={1,2}$/.test(word)) return true;
  if (/[+/]/.test(word)) return true;
  let digits = 0, lo = 0, up = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
    else if (c >= 97 && c <= 122) lo++;
    else if (c >= 65 && c <= 90) up++;
  }
  if (digits >= 2 && (lo + up) >= 2) return true;
  if (digits >= 1 && lo >= 1 && up >= 1) return true;
  if (word.length >= 32 && (digits >= 1 || /[_-]/.test(word) || (lo >= 4 && up >= 4))) return true;
  return false;
}

function scrubMessage(raw) {
  let s = typeof raw === "string" ? raw : String(raw ?? "");
  if (s.length > 4096) s = s.slice(0, 4096);
  s = s.replace(CONTROL_RE, " ");
  // Strip userinfo, query strings, and fragments from full URLs.
  s = s.replace(/\b(https?|wss?):\/\/([^\s"'<>)\]]+)/gi, (_, scheme, rest) => {
    const cut = rest.replace(/[?#][\s\S]*$/, "");
    const slash = cut.indexOf("/");
    const authority = slash < 0 ? cut : cut.slice(0, slash);
    const tail = slash < 0 ? "" : cut.slice(slash);
    const at = authority.lastIndexOf("@");
    const host = at < 0 ? authority : authority.slice(at + 1);
    return `${scheme.toLowerCase()}://${host}${tail}`;
  });
  // Strip query strings from relative URLs.
  s = s.replace(/(^|[\s"'(\[])(\/[A-Za-z0-9_./-]*)\?[^\s"'<>)\]]+/g, "$1$2");
  // Scrub email addresses.
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  // Scrub Authorization values and key=value secret assignments.
  s = s.replace(/\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "[token]");
  s = s.replace(/\b(?:(?:access|refresh|session|csrf|auth|invite|reset|verify)[_.-]?)?(?:token|secret|password|passwd|pwd|api[_-]?key|authorization|cookie|invitation|jwt)\s*[:=]\s*["']?[^\s"',;)}]{3,}["']?/gi, "[token]");
  // Scrub JWTs.
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[token]");
  // Scrub opaque tokens, hex hashes, UUIDs, API keys, base64 blobs.
  s = s.replace(/[A-Za-z0-9_+/=-]{16,}/g, word => (isTokenLike(word) ? "[token]" : word));
  // Scrub phone-like numbers and long digit sequences.
  s = s.replace(/(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){9,}\d/g, "[num]");
  s = s.replace(/\d{6,}/g, "[num]");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > MAX_MESSAGE_LEN) s = s.slice(0, MAX_MESSAGE_LEN).trim();
  return s;
}

function sanitizeName(raw) {
  if (typeof raw !== "string") throw fail(400, "bad_request");
  const cleaned = raw.replace(CONTROL_RE, " ").trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, MAX_NAME_LEN);
  if (!cleaned) throw fail(400, "bad_request");
  return cleaned;
}

function sanitizeSource(raw) {
  if (raw === undefined || raw === "") return "unknown";
  if (typeof raw !== "string") throw fail(400, "bad_request");
  const trimmed = raw.replace(CONTROL_RE, "").trim().slice(0, MAX_SOURCE_LEN);
  return SOURCE_RE.test(trimmed) ? trimmed : "unknown";
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
  const trimmed = raw.replace(CONTROL_RE, "").trim().slice(0, 32);
  return UA_RE.test(trimmed) ? trimmed : "Other/Other";
}

function sanitizeTimestamp(raw, nowFn) {
  if (raw === undefined || raw === "") return new Date(nowFn()).toISOString();
  if (typeof raw !== "string") throw fail(400, "bad_request");
  const trimmed = raw.replace(CONTROL_RE, "").trim();
  if (ISO_UTC_RE.test(trimmed) && Number.isFinite(Date.parse(trimmed))) return trimmed;
  return new Date(nowFn()).toISOString();
}

function validateReport(body, { isAuthenticated, releaseRevision, now = Date.now }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "bad_request");
  const page = sanitizePage(body.page, isAuthenticated);
  const name = sanitizeName(body.name);
  if (typeof body.message !== "string") throw fail(400, "bad_request");
  const message = scrubMessage(body.message);
  if (!message) throw fail(400, "bad_request");
  const source = sanitizeSource(body.source);
  const revision = sanitizeRevision(body.revision, releaseRevision);
  const lang = sanitizeLang(body.lang);
  const ua = sanitizeUA(body.ua);
  const ts = sanitizeTimestamp(body.ts, now);
  return { name, message, source, revision, page, lang, ua, ts };
}

function formatLogLine(report, isAuthenticated) {
  const auth = isAuthenticated ? "user" : "anon";
  // Every field is allowlisted or JSON-encoded with control chars stripped: strictly 1 line.
  return `client-error auth=${auth} page=${report.page} lang=${report.lang} rev=${report.revision} ua=${report.ua} source=${report.source} name=${report.name} ts=${report.ts} msg=${JSON.stringify(report.message)}`;
}

function createWindowLimiter(limit, windowMs, nowFn) {
  const buckets = new Map();
  function prune(t) {
    for (const [k, slot] of buckets) {
      if (t >= slot.until) buckets.delete(k);
    }
    while (buckets.size > MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      buckets.delete(oldest);
    }
  }
  return {
    canTake(key) {
      const t = nowFn();
      prune(t);
      const slot = buckets.get(key);
      return !slot || slot.n < limit;
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

function checkSameOrigin(req, expectedOrigin, isAuthenticated) {
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
    if (!isAuthenticated && refUrl.pathname !== "/login.html") {
      throw fail(403, "csrf", "请求来源不对");
    }
  }
}

function createClientErrors({
  expectedOrigin,
  releaseRevision,
  userLimit = 20,
  ipLimit = 40,
  anonIpLimit = 5,
  windowMs = 3600 * 1000,
  log = console.log,
  now = Date.now
} = {}) {
  if (!expectedOrigin || typeof expectedOrigin !== "string") {
    throw new Error("expectedOrigin is required");
  }
  const normalizedOrigin = new URL(expectedOrigin).origin;
  const userLimiter = createWindowLimiter(userLimit, windowMs, now);
  const ipLimiter = createWindowLimiter(ipLimit, windowMs, now);
  const anonIpLimiter = createWindowLimiter(anonIpLimit, windowMs, now);

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
          if (n > 65536) req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks)); });
      req.on("error", err => { if (!rejected) reject(err); });
    });
  }

  async function handle(req, res, { user = null, ip = "?", readBody }) {
    if (req.method !== "POST") throw fail(405, "method");
    const isAuthenticated = !!(user && user.id);
    checkSameOrigin(req, normalizedOrigin, isAuthenticated);

    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") throw fail(415, "bad_type");

    const buf = await readLimitedBody(req, res, readBody);
    let parsed;
    try {
      parsed = JSON.parse(buf.toString("utf8") || "");
    } catch {
      throw fail(400, "bad_json");
    }

    const report = validateReport(parsed, { isAuthenticated, releaseRevision, now });
    const ipKey = String(ip || "?");

    if (isAuthenticated) {
      if (!userLimiter.canTake(user.id) || !ipLimiter.canTake(ipKey)) {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      userLimiter.take(user.id);
      ipLimiter.take(ipKey);
    } else {
      if (!anonIpLimiter.canTake(ipKey) || !ipLimiter.canTake(ipKey)) {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      anonIpLimiter.take(ipKey);
      ipLimiter.take(ipKey);
    }

    log(formatLogLine(report, isAuthenticated));
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
  }

  return { handle };
}

module.exports = {
  MAX_BODY_BYTES,
  MAX_MESSAGE_LEN,
  ALLOWED_PAGES,
  createClientErrors,
  scrubMessage,
  validateReport,
  formatLogLine
};
