// Privacy-safe client runtime error reporter for Lean Ritual.
// Captures window 'error' and 'unhandledrejection', scrubs PII/tokens/queries,
// deduplicates per page-load, caps at 10 per session, and POSTs minimal JSON
// to same-origin /api/client-error via fetch keepalive.
(function () {
  "use strict";

  const ENDPOINT = "/api/client-error";
  const MAX_MESSAGE_LEN = 300;
  const MAX_PER_SESSION = 10;
  const SESSION_KEY = "bj-err-count";
  const CONTROL_RE = /[\x00-\x1f\x7f\u2028\u2029]+/g;
  const ALLOWED_PAGES = new Set([
    "today", "food", "log", "fb", "me", "setup", "boot",
    "login", "app", "privacy", "guide", "unknown"
  ]);

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
      return scheme.toLowerCase() + "://" + host + tail;
    });
    // Strip query strings from relative URLs.
    s = s.replace(/(^|[\s"'(\[])(\/[A-Za-z0-9_./-]*)\?[^\s"'<>)\]]+/g, "$1$2");
    // Scrub emails.
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

  function extractBasename(rawPath) {
    if (typeof rawPath !== "string" || !rawPath.trim()) return "";
    let clean = rawPath.trim().replace(/[?#][\s\S]*$/, "");
    let isRootPath = false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) {
      const afterScheme = clean.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
      if (!afterScheme || afterScheme === "/") isRootPath = true;
      clean = afterScheme;
    } else if (clean === "/") {
      isRootPath = true;
    }
    if (isRootPath) return "index.html";
    const seg = clean.split(/[\\/]/).filter(Boolean).pop() || "";
    const safe = seg.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
    return safe;
  }

  function formatSource(filename, lineno, colno, stack) {
    let base = extractBasename(filename);
    let line = Number.isFinite(+lineno) && +lineno > 0 ? Math.min(9999999, Math.trunc(+lineno)) : 0;
    let col = Number.isFinite(+colno) && +colno > 0 ? Math.min(9999999, Math.trunc(+colno)) : 0;

    if (!base && typeof stack === "string" && stack) {
      const head = stack.slice(0, 1024);
      const m = head.match(/(?:https?:\/\/[^\s)@]+?|\/[A-Za-z0-9_./-]*):(\d+)(?::(\d+))?(?=[\s)]|$)/);
      if (m) {
        base = extractBasename(m[0].replace(/:\d+(?::\d+)?$/, ""));
        line = Math.min(9999999, Math.trunc(+m[1]) || 0);
        col = Math.min(9999999, Math.trunc(+m[2]) || 0);
      }
    }
    if (!base) return "unknown";
    if (line > 0) return base + ":" + line + ":" + col;
    return base;
  }

  function parseUA(uaString) {
    const ua = typeof uaString === "string" ? uaString : "";
    let family = "Other";
    if (/MicroMessenger\//i.test(ua)) family = "WeChat";
    else if (/\b(?:Edg|EdgiOS|EdgA)\//.test(ua)) family = "Edge";
    else if (/\b(?:Firefox|FxiOS)\//.test(ua)) family = "Firefox";
    else if (/\b(?:Chrome|CriOS)\//.test(ua)) family = "Chrome";
    else if (/\bSafari\//.test(ua)) family = "Safari";
    else if (/\bAppleWebKit\//.test(ua)) family = "WebKit";

    let os = "Other";
    let m;
    if ((m = ua.match(/(?:iPhone|iPad|iPod)[^)]*OS (\d+)/))) os = "iOS" + m[1];
    else if ((m = ua.match(/HarmonyOS (\d+)/))) os = "HarmonyOS" + m[1];
    else if ((m = ua.match(/Android (\d+)/))) os = "Android" + m[1];
    else if ((m = ua.match(/Mac OS X (\d+)/))) os = "macOS" + m[1];
    else if ((m = ua.match(/Windows NT (\d+)/))) os = "Win" + m[1];
    else if (/\bLinux\b/.test(ua)) os = "Linux";

    return family + "/" + os;
  }

  function normalizePage(raw, pathname) {
    if (typeof raw === "string") {
      const v = raw.trim().toLowerCase();
      if (ALLOWED_PAGES.has(v)) return v;
    }
    const p = typeof pathname === "string" ? pathname.replace(/[?#][\s\S]*$/, "").trim() : "";
    if (p === "/login.html") return "login";
    if (p === "/" || p === "/index.html") return "app";
    if (p === "/privacy.html") return "privacy";
    if (p === "/guide.html") return "guide";
    return "unknown";
  }

  function normalizeLang(raw, docLang) {
    const check = v => {
      if (typeof v !== "string") return null;
      const n = v.trim().toLowerCase();
      if (n === "zh" || n.startsWith("zh-")) return "zh";
      if (n === "en" || n.startsWith("en-")) return "en";
      return null;
    };
    return check(raw) || check(docLang) || "unknown";
  }

  function normalizeName(raw) {
    const s = typeof raw === "string" ? raw.replace(CONTROL_RE, " ").trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) : "";
    return s || "Error";
  }

  function createReporter(env = {}) {
    const fetchFn = env.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    const storage = env.sessionStorage !== undefined
      ? env.sessionStorage
      : (typeof sessionStorage !== "undefined" ? sessionStorage : null);
    const nav = env.navigator !== undefined
      ? env.navigator
      : (typeof navigator !== "undefined" ? navigator : null);
    const loc = env.location !== undefined
      ? env.location
      : (typeof location !== "undefined" ? location : null);
    const doc = env.document !== undefined
      ? env.document
      : (typeof document !== "undefined" ? document : null);
    const nowFn = env.now || (() => new Date().toISOString());
    const maxPerSession = Number.isInteger(env.maxPerSession) && env.maxPerSession > 0 ? env.maxPerSession : MAX_PER_SESSION;

    const seen = new Set();
    let memCount = 0;
    let reporting = false;
    let revision = typeof env.revision === "string" && /^[0-9a-f]{7,40}$/i.test(env.revision)
      ? env.revision.slice(0, 12).toLowerCase()
      : "unknown";
    let getPageFn = typeof env.getPage === "function" ? env.getPage : null;
    let getLangFn = typeof env.getLang === "function" ? env.getLang : null;

    function readSessionCount() {
      let stored = 0;
      try {
        const v = storage && typeof storage.getItem === "function" ? Number(storage.getItem(SESSION_KEY)) : 0;
        if (Number.isFinite(v) && v > 0) stored = Math.trunc(v);
      } catch {}
      return Math.max(memCount, stored);
    }

    function writeSessionCount(next) {
      memCount = next;
      try {
        if (storage && typeof storage.setItem === "function") storage.setItem(SESSION_KEY, String(next));
      } catch {}
    }

    function configure(opts = {}) {
      if (typeof opts.getPage === "function") getPageFn = opts.getPage;
      if (typeof opts.getLang === "function") getLangFn = opts.getLang;
      if (typeof opts.revision === "string" && /^[0-9a-f]{7,40}$/i.test(opts.revision)) {
        revision = opts.revision.slice(0, 12).toLowerCase();
      }
    }

    function report(input) {
      if (reporting) return false;
      reporting = true;
      try {
        if (!fetchFn) return false;
        const name = normalizeName(input && input.name);
        const message = scrubMessage(input && input.message) || name;
        const rawSource = input && typeof input.source === "string" ? input.source.trim() : "";
        const source = rawSource
          ? (/^[A-Za-z0-9._-]{1,64}(?::\d{1,7}(?::\d{1,7})?)?$/.test(rawSource) ? rawSource : formatSource(rawSource, 0, 0, ""))
          : formatSource(input && input.filename, input && input.lineno, input && input.colno, input && input.stack);
        const key = name + "|" + source + "|" + message;
        if (seen.has(key)) return false;

        const current = readSessionCount();
        if (current >= maxPerSession) return false;

        let rawPage = null;
        try { rawPage = getPageFn ? getPageFn() : null; } catch {}
        let rawLang = null;
        try { rawLang = getLangFn ? getLangFn() : null; } catch {}

        const payload = {
          name,
          message,
          source,
          revision,
          page: normalizePage(rawPage, loc && loc.pathname),
          lang: normalizeLang(rawLang, doc && doc.documentElement && doc.documentElement.lang),
          ua: parseUA(nav && nav.userAgent),
          ts: nowFn()
        };

        seen.add(key);
        writeSessionCount(current + 1);

        const body = JSON.stringify(payload);
        Promise.resolve(fetchFn(ENDPOINT, {
          method: "POST",
          keepalive: true,
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Bojin": "1" },
          body
        })).catch(() => {});
        return true;
      } catch {
        return false;
      } finally {
        reporting = false;
      }
    }

    function handleWindowError(ev) {
      try {
        if (!ev) return;
        const err = ev.error;
        if (!err && !ev.message) return;
        const name = (err && typeof err.name === "string" && err.name) || "Error";
        const message = (err && typeof err.message === "string" && err.message) || (typeof ev.message === "string" ? ev.message : "");
        if (!message && !err) return;
        const source = formatSource(ev.filename, ev.lineno, ev.colno, err && err.stack);
        report({ name, message, source });
      } catch {}
    }

    function handleRejection(ev) {
      try {
        const reason = ev && ev.reason;
        if (reason && typeof reason === "object") {
          const code = typeof reason.code === "string" ? reason.code : "";
          const errName = typeof reason.name === "string" ? reason.name : "";
          if (code === "cancelled" || code === "session_expired" || errName === "AbortError") return;
          const name = errName || code || "UnhandledRejection";
          const message = typeof reason.message === "string" && reason.message
            ? reason.message
            : (code || "Unhandled rejection");
          const source = formatSource("", 0, 0, typeof reason.stack === "string" ? reason.stack : "");
          report({ name, message, source });
          return;
        }
        if (typeof reason === "string" && reason.trim()) {
          report({ name: "UnhandledRejection", message: reason, source: "unknown" });
          return;
        }
        report({ name: "UnhandledRejection", message: "Unhandled rejection", source: "unknown" });
      } catch {}
    }

    function loadRevision() {
      if (!fetchFn) return;
      try {
        if (loc && loc.protocol && !/^https?:$/.test(loc.protocol)) return;
        Promise.resolve(fetchFn("/api/health", { credentials: "same-origin" }))
          .then(r => (r && r.ok ? r.json() : null))
          .then(j => {
            if (j && typeof j.revision === "string" && /^[0-9a-f]{7,40}$/i.test(j.revision)) {
              revision = j.revision.slice(0, 12).toLowerCase();
            }
          })
          .catch(() => {});
      } catch {}
    }

    return {
      configure,
      report,
      handleWindowError,
      handleRejection,
      loadRevision,
      getRevision: () => revision
    };
  }

  const defaultReporter = createReporter();
  if (typeof window !== "undefined") {
    if (typeof window.addEventListener === "function") {
      window.addEventListener("error", defaultReporter.handleWindowError);
      window.addEventListener("unhandledrejection", defaultReporter.handleRejection);
    }
    defaultReporter.loadRevision();
    window.ritualErrorReporter = {
      configure: defaultReporter.configure,
      report: defaultReporter.report,
      getRevision: defaultReporter.getRevision,
      scrubMessage,
      formatSource,
      parseUA,
      normalizePage,
      createReporter
    };
  }
})();
