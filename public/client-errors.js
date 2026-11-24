// Privacy-safe client runtime error reporter for Lean Ritual.
// Captures window 'error' and 'unhandledrejection', scrubs PII/tokens/queries,
// deduplicates per page-load, caps at 10 per session, and POSTs minimal JSON
// to same-origin /api/client-error via fetch keepalive.
(function () {
  "use strict";

  const ENDPOINT = "/api/client-error";
  const MAX_PER_SESSION = 10;
  const SESSION_KEY = "bj-err-count";
  const ALLOWED_PAGES = new Set([
    "today", "food", "log", "fb", "me", "setup", "boot", "consent",
    "login", "app", "privacy", "terms", "guide", "unknown"
  ]);

  const ERROR_NAMES = new Set([
    "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
    "EvalError", "URIError", "AggregateError", "DOMException",
    "UnhandledRejection", "SaveError", "AIError"
  ]);
  const SOURCE_RE = /^(?:(?:index|login)\.html|(?:client-errors|shim|heic2any-worker|heic2any\.min|tesseract\.min|worker\.min)\.js)(?::\d{1,7}(?::\d{1,7})?)?(?![\s\S])/;
  const UA_RE = /^(?:Other|WeChat|Edge|Firefox|Chrome|Safari|WebKit)\/(?:Other|Linux|(?:iOS|HarmonyOS|Android|macOS|Win)\d{1,3})(?![\s\S])/;
  const MESSAGES = [
    [/^Cannot read properties of (?:null|undefined)/, "Cannot read properties of null or undefined"],
    [/^Cannot set properties of (?:null|undefined)/, "Cannot set properties of null or undefined"],
    [/ is not (?:a function|a constructor)$/, "Value is not callable or constructible"],
    [/ is not defined$/, "Reference is not defined"],
    [/^Unexpected token/, "Unexpected token"],
    [/^Maximum call stack size exceeded$/, "Maximum call stack size exceeded"],
    [/^(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/, "Network request failed"],
    [/^ERR_HTTP2_PROTOCOL_ERROR$/, "ERR_HTTP2_PROTOCOL_ERROR"]
  ];

  // Match common failure patterns without copying any text from the exception.
  function scrubMessage(raw) {
    if (typeof raw !== "string") return "Error details withheld";
    const text = raw.slice(0, 300);
    for (const [pattern, message] of MESSAGES) {
      if (text === message || pattern.test(text)) return message;
    }
    return "Error details withheld";
  }

  function normalizeSource(raw) {
    return typeof raw === "string" && SOURCE_RE.test(raw) ? raw : "unknown";
  }

  function normalizeUA(raw) {
    return typeof raw === "string" && UA_RE.test(raw) ? raw : "Other/Other";
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
    return normalizeSource(line > 0 ? base + ":" + line + ":" + col : base);
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

    return normalizeUA(family + "/" + os);
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
    if (p === "/terms.html") return "terms";
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
    return ERROR_NAMES.has(raw) ? raw : "Error";
  }

  function createReporter(env = {}) {
    const fetchFn = env.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    let storage = env.sessionStorage;
    if (storage === undefined) {
      try { storage = globalThis.sessionStorage; } catch {}
    }
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
        const message = scrubMessage(input && input.message);
        const rawSource = input && typeof input.source === "string" ? input.source.trim() : "";
        const source = rawSource
          ? normalizeSource(rawSource)
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
          referrerPolicy: "no-referrer",
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
        Promise.resolve(fetchFn("/api/health", { credentials: "omit", referrerPolicy: "no-referrer" }))
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

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { scrubMessage, normalizeName, normalizeSource, normalizeUA, parseUA };
  }
  if (typeof window !== "undefined") {
    const defaultReporter = createReporter();
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
