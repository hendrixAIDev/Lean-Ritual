// Privacy-safe client runtime error reporter for Lean Ritual.
// Captures window 'error' and 'unhandledrejection', scrubs PII/tokens/queries,
// deduplicates per page-load, caps at 10 per session, and POSTs minimal JSON
// to same-origin /api/client-error via fetch keepalive.
(function () {
  "use strict";

  const ENDPOINT = "/api/client-error";
  const MAX_PER_SESSION = 10;
  const SESSION_KEY = "bj-err-count";
  const SESSION_FILTERED_KEY = "bj-err-filtered-count";
  const ALLOWED_PAGES = new Set([
    "today", "food", "log", "fb", "me", "setup", "boot", "consent",
    "login", "app", "privacy", "terms", "guide", "unknown"
  ]);

  const ERROR_NAMES = new Set([
    "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
    "EvalError", "URIError", "AggregateError", "DOMException",
    "UnhandledRejection", "SaveError", "AIError"
  ]);
  const ALLOWED_FILTER_REASONS = Object.freeze([
    "script_error",
    "non_origin",
    "resize_observer"
  ]);
  const FILTER_REASON_SET = new Set(ALLOWED_FILTER_REASONS);
  const ALLOWED_SOURCE_FILES = Object.freeze([
    "index.html",
    "login.html",
    "privacy.html",
    "terms.html",
    "guide.html",
    "landing.html",
    "client-errors.js",
    "shim.js",
    "login.js",
    "phone-rules.js",
    "privacy.js",
    "terms.js",
    "guide.js",
    "boot.js",
    "nocturne.js",
    "heic2any-worker.js",
    "heic2any.min.js",
    "tesseract.min.js",
    "worker.min.js",
    "tesseract-core-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js",
    "tesseract-core-relaxedsimd-lstm.wasm.js"
  ]);
  const SOURCE_RE = new RegExp(
    "^(?:" + ALLOWED_SOURCE_FILES.map(f => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?::\\d{1,7}(?::\\d{1,7})?)?(?![\\s\\S])"
  );
  const EXTENSION_URL_RE = /^(?:chrome-extension|moz-extension|safari-extension|safari-web-extension|extension|webkit-masked-url|chrome|edge|resource|userscript|about):/i;
  const RESIZE_OBSERVER_RE = /^ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)\.?$/i;
  const SCRIPT_ERROR_RE = /^script error\.?$/i;
  const MAX_STACK_SCAN = 65536;
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

  function stripStackMessageHeader(stack, errMessage) {
    if (typeof stack !== "string" || !stack) return "";
    if (typeof errMessage !== "string" || !errMessage) return stack;
    const colonIdx = stack.indexOf(": ");
    if (colonIdx > 0 && colonIdx <= 64 && stack.slice(colonIdx + 2, colonIdx + 2 + errMessage.length) === errMessage) {
      const after = colonIdx + 2 + errMessage.length;
      if (after === stack.length) return "";
      if (stack[after] === "\n") return stack.slice(after + 1);
      if (stack[after] === "\r") return stack.slice(stack[after + 1] === "\n" ? after + 2 : after + 1);
    }
    if (stack.startsWith(errMessage)) {
      const after = errMessage.length;
      if (after === stack.length) return "";
      if (stack[after] === "\n") return stack.slice(after + 1);
      if (stack[after] === "\r") return stack.slice(stack[after + 1] === "\n" ? after + 2 : after + 1);
    }
    return stack;
  }

  function parseStackFrameLocation(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    // V8/Chromium/Node frame: "at fn (loc)" or "at loc"
    if (/^at\s+/.test(trimmed)) {
      const rest = trimmed.replace(/^at\s+/, "").trim();
      if (!rest) return null;
      if (rest.endsWith(")")) {
        const openIdx = rest.lastIndexOf("(");
        if (openIdx >= 0) {
          const inner = rest.slice(openIdx + 1, -1).trim();
          const hasFnPrefix = openIdx > 0 && rest.slice(0, openIdx).trim().length > 0;
          if (inner === "native" || inner === "[native code]" || (hasFnPrefix && inner === "<anonymous>")) {
            return { native: true, location: "" };
          }
          if (/[\s)]/.test(inner)) return { native: false, location: "" };
          return { native: false, location: inner };
        }
      }
      if (rest === "native" || rest === "[native code]") return { native: true, location: "" };
      return { native: false, location: rest };
    }
    // JavaScriptCore/Safari and SpiderMonkey/Firefox frame: "fn@loc" or "@loc" (no ":" before "@")
    const atMatch = trimmed.match(/^[^@:\r\n]{0,120}@(.*)$/);
    if (atMatch) {
      const loc = atMatch[1].trim();
      if (loc === "[native code]" || loc === "native") return { native: true, location: "" };
      return { native: false, location: loc };
    }
    return null;
  }

  function formatSource(filename, lineno, colno, stack, errMessage) {
    let base = extractBasename(filename);
    let line = Number.isFinite(+lineno) && +lineno > 0 ? Math.min(9999999, Math.trunc(+lineno)) : 0;
    let col = Number.isFinite(+colno) && +colno > 0 ? Math.min(9999999, Math.trunc(+colno)) : 0;

    if (!base && typeof stack === "string" && stack) {
      const frameText = stripStackMessageHeader(stack, errMessage);
      if (frameText && frameText.length <= MAX_STACK_SCAN) {
        const lines = frameText.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const frame = parseStackFrameLocation(lines[i]);
          if (!frame || frame.native || !frame.location) continue;
          const m = frame.location.match(/^(https?:\/\/[^\s)@]+?|\/[A-Za-z0-9_./-]*):(\d+)(?::(\d+))?$/);
          if (m) {
            base = extractBasename(m[1]);
            line = Math.min(9999999, Math.trunc(+m[2]) || 0);
            col = Math.min(9999999, Math.trunc(+m[3]) || 0);
            if (base) break;
          }
        }
      }
      if (!base) {
        const head = frameText.slice(0, 1024);
        const m = head.match(/(?:https?:\/\/[^\s)@]+?|\/[A-Za-z0-9_./-]*):(\d+)(?::(\d+))?(?=[\s)]|$)/);
        if (m) {
          base = extractBasename(m[0].replace(/:\d+(?::\d+)?$/, ""));
          line = Math.min(9999999, Math.trunc(+m[1]) || 0);
          col = Math.min(9999999, Math.trunc(+m[2]) || 0);
        }
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

  function normalizeFilterReason(raw) {
    return typeof raw === "string" && FILTER_REASON_SET.has(raw) ? raw : null;
  }

  function getPageOrigin(loc) {
    if (!loc) return "";
    if (typeof loc.origin === "string" && /^https?:\/\/[^/\s]+$/i.test(loc.origin)) {
      return loc.origin.toLowerCase();
    }
    if (typeof loc.protocol === "string" && /^https?:$/i.test(loc.protocol) && typeof loc.host === "string" && loc.host) {
      return (loc.protocol + "//" + loc.host).toLowerCase();
    }
    return "";
  }

  function classifyUrlOrigin(rawUrl, pageOrigin) {
    if (typeof rawUrl !== "string") return "unknown";
    const s = rawUrl.trim();
    if (!s || /\s/.test(s)) return "unknown";
    if (EXTENSION_URL_RE.test(s)) return "external";
    if (/^blob:/i.test(s)) {
      const inner = s.slice(5);
      if (EXTENSION_URL_RE.test(inner)) return "external";
      const bm = inner.match(/^(https?:\/\/[^/\s)@?#]+)/i);
      if (bm) {
        if (!pageOrigin) return "same";
        return bm[1].toLowerCase() === pageOrigin ? "same" : "external";
      }
      return "unknown";
    }
    if (s.startsWith("//")) {
      if (!pageOrigin) return "unknown";
      const hm = s.match(/^\/\/([^/\s)@?#]+)/);
      if (!hm) return "unknown";
      const pageHost = pageOrigin.replace(/^https?:\/\//i, "");
      return hm[1].toLowerCase() === pageHost ? "same" : "external";
    }
    if (s.startsWith("/")) return "same";
    const m = s.match(/^(https?:\/\/[^/\s)@?#]+)/i);
    if (m) {
      if (!pageOrigin) return "same";
      return m[1].toLowerCase() === pageOrigin ? "same" : "external";
    }
    if (/^file:/i.test(s)) return pageOrigin ? "external" : "unknown";
    return "unknown";
  }

  function classifyStackOrigin(stack, pageOrigin, errMessage) {
    if (typeof stack !== "string" || !stack) return "unknown";
    const frameText = stripStackMessageHeader(stack, errMessage);
    if (!frameText || frameText.length > MAX_STACK_SCAN) return "unknown";
    const lines = frameText.split(/\r?\n/);
    let hasExternal = false;
    let hasSame = false;
    let hasUnknown = false;
    for (let i = 0; i < lines.length; i++) {
      const frame = parseStackFrameLocation(lines[i]);
      if (!frame || frame.native) continue;
      if (!frame.location) {
        hasUnknown = true;
        continue;
      }
      const url = frame.location.replace(/:\d+(?::\d+)?$/, "");
      const kind = classifyUrlOrigin(url, pageOrigin);
      if (kind === "same") hasSame = true;
      else if (kind === "external") hasExternal = true;
      else hasUnknown = true;
    }
    if (hasSame) return "same";
    if (hasExternal && !hasUnknown) return "external";
    return "unknown";
  }

  function classifyWindowError(ev, pageOrigin) {
    if (!ev) return null;
    const err = ev.error;
    const rawMsg = (err && typeof err.message === "string" && err.message)
      || (typeof ev.message === "string" ? ev.message : "");
    const trimmedMsg = rawMsg.trim();
    const rawFile = typeof ev.filename === "string" ? ev.filename.trim() : "";
    const lineno = Number.isFinite(+ev.lineno) ? +ev.lineno : 0;
    const colno = Number.isFinite(+ev.colno) ? +ev.colno : 0;

    // Browser ResizeObserver loop notifications fire with no Error object and zero line/col.
    // Never filter a real thrown Error or same-origin exception with nonzero coordinates.
    if (RESIZE_OBSERVER_RE.test(trimmedMsg) && !err && lineno === 0 && colno === 0) {
      return "resize_observer";
    }
    if (SCRIPT_ERROR_RE.test(trimmedMsg) && !rawFile && lineno === 0 && colno === 0 && !err) {
      return "script_error";
    }
    if (rawFile) {
      const fileKind = classifyUrlOrigin(rawFile, pageOrigin);
      if (fileKind === "external") return "non_origin";
      if (fileKind === "same") return null;
    }
    if (err && typeof err.stack === "string" && err.stack) {
      if (classifyStackOrigin(err.stack, pageOrigin, typeof err.message === "string" ? err.message : "") === "external") {
        return "non_origin";
      }
    }
    return null;
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
    const filteredSeen = new Set();
    let memCount = 0;
    let filteredMemCount = 0;
    let reporting = false;
    let revision = typeof env.revision === "string" && /^[0-9a-f]{7,40}$/i.test(env.revision)
      ? env.revision.slice(0, 12).toLowerCase()
      : "unknown";
    let getPageFn = typeof env.getPage === "function" ? env.getPage : null;
    let getLangFn = typeof env.getLang === "function" ? env.getLang : null;

    function readCounter(key, memVal) {
      let stored = 0;
      try {
        const v = storage && typeof storage.getItem === "function" ? Number(storage.getItem(key)) : 0;
        if (Number.isFinite(v) && v > 0) stored = Math.trunc(v);
      } catch {}
      return Math.max(memVal, stored);
    }

    function readSessionCount() {
      return readCounter(SESSION_KEY, memCount);
    }

    function writeSessionCount(next) {
      memCount = next;
      try {
        if (storage && typeof storage.setItem === "function") storage.setItem(SESSION_KEY, String(next));
      } catch {}
    }

    function readFilteredSessionCount() {
      return readCounter(SESSION_FILTERED_KEY, filteredMemCount);
    }

    function writeFilteredSessionCount(next) {
      filteredMemCount = next;
      try {
        if (storage && typeof storage.setItem === "function") storage.setItem(SESSION_FILTERED_KEY, String(next));
      } catch {}
    }

    function configure(opts = {}) {
      if (typeof opts.getPage === "function") getPageFn = opts.getPage;
      if (typeof opts.getLang === "function") getLangFn = opts.getLang;
      if (typeof opts.revision === "string" && /^[0-9a-f]{7,40}$/i.test(opts.revision)) {
        revision = opts.revision.slice(0, 12).toLowerCase();
      }
    }

    function sendPayload(payload) {
      const body = JSON.stringify(payload);
      Promise.resolve(fetchFn(ENDPOINT, {
        method: "POST",
        keepalive: true,
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json", "X-Bojin": "1" },
        body
      })).catch(() => {});
    }

    function buildContextFields() {
      let rawPage = null;
      try { rawPage = getPageFn ? getPageFn() : null; } catch {}
      let rawLang = null;
      try { rawLang = getLangFn ? getLangFn() : null; } catch {}
      return {
        revision,
        page: normalizePage(rawPage, loc && loc.pathname),
        lang: normalizeLang(rawLang, doc && doc.documentElement && doc.documentElement.lang),
        ua: parseUA(nav && nav.userAgent),
        ts: nowFn()
      };
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

        const payload = Object.assign({ name, message, source }, buildContextFields());

        seen.add(key);
        writeSessionCount(current + 1);
        sendPayload(payload);
        return true;
      } catch {
        return false;
      } finally {
        reporting = false;
      }
    }

    function reportFiltered(rawReason) {
      if (reporting) return false;
      reporting = true;
      try {
        if (!fetchFn) return false;
        const reason = normalizeFilterReason(rawReason);
        if (!reason) return false;
        const key = "filtered|" + reason;
        if (filteredSeen.has(key)) return false;

        const current = readFilteredSessionCount();
        if (current >= maxPerSession) return false;

        const payload = Object.assign({ filtered: reason }, buildContextFields());

        filteredSeen.add(key);
        writeFilteredSessionCount(current + 1);
        sendPayload(payload);
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
        const filterReason = classifyWindowError(ev, getPageOrigin(loc));
        if (filterReason) {
          reportFiltered(filterReason);
          return;
        }
        const name = (err && typeof err.name === "string" && err.name) || "Error";
        const message = (err && typeof err.message === "string" && err.message) || (typeof ev.message === "string" ? ev.message : "");
        if (!message && !err) return;
        const source = formatSource(ev.filename, ev.lineno, ev.colno, err && err.stack, err && typeof err.message === "string" ? err.message : "");
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
          const stack = typeof reason.stack === "string" ? reason.stack : "";
          const rawErrMsg = typeof reason.message === "string" ? reason.message : "";
          if (stack && classifyStackOrigin(stack, getPageOrigin(loc), rawErrMsg) === "external") {
            reportFiltered("non_origin");
            return;
          }
          const name = errName || code || "UnhandledRejection";
          const message = rawErrMsg || code || "Unhandled rejection";
          const source = formatSource("", 0, 0, stack, rawErrMsg);
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
      reportFiltered,
      handleWindowError,
      handleRejection,
      loadRevision,
      getRevision: () => revision,
      getFilteredCount: readFilteredSessionCount
    };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      ALLOWED_SOURCE_FILES,
      ALLOWED_FILTER_REASONS,
      scrubMessage,
      normalizeName,
      normalizeSource,
      normalizeUA,
      normalizeFilterReason,
      parseUA,
      classifyUrlOrigin,
      classifyStackOrigin,
      classifyWindowError
    };
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
      reportFiltered: defaultReporter.reportFiltered,
      getRevision: defaultReporter.getRevision,
      getFilteredCount: defaultReporter.getFilteredCount,
      scrubMessage,
      formatSource,
      parseUA,
      normalizePage,
      classifyWindowError,
      createReporter
    };
  }
})();
