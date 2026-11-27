/**
 * External uptime monitor for Lean Ritual (Cloudflare Worker + Cron Trigger).
 *
 * Probes TARGET_URL (default https://leanritual.app/api/health) on a schedule,
 * confirms failures with one immediate retry inside the same invocation to avoid
 * transient single-packet false alarms, and sends plain-text alerts to ALERT_URL
 * (ntfy-compatible HTTPS webhook) on UP->DOWN, periodic reminder, and DOWN->UP
 * transitions when STATE_KV is bound.
 */

export const DEFAULT_TARGET_URL = "https://leanritual.app/api/health";
export const DEFAULT_PROBE_TIMEOUT_MS = 8000;
export const DEFAULT_ALERT_TIMEOUT_MS = 8000;
export const DEFAULT_RETRY_DELAY_MS = 3000;
export const DEFAULT_REMINDER_MINUTES = 360;
export const STATE_KEY = "uptime:state:v1";
export const USER_AGENT = "lean-ritual-uptime-worker/1.0";
const MAX_BODY_BYTES = 16384;

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]+/g;
const URL_IN_ERROR_RE = /https?:\/\/\S+/gi;

export function sanitizeText(value, maxLen = 120) {
  const cleaned = String(value ?? "")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

export function formatShortRevision(revision) {
  const clean = sanitizeText(revision, 64);
  return clean.length > 7 ? clean.slice(0, 7) : clean;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function parseNumberSetting(raw, fallback, { min = 0, max = Infinity } = {}) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function parseHttpsUrl(raw, { allowCredentials = false } = {}) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\s\x00-\x1f\x7f]/.test(trimmed)) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return null;
  if (!allowCredentials && (parsed.username || parsed.password)) return null;
  return parsed;
}

function isJsonContentType(contentType) {
  if (typeof contentType !== "string" || !contentType) return false;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function isTimeoutError(err) {
  if (!err) return false;
  const name = String(err.name || "");
  return name === "TimeoutError" || name === "AbortError";
}

function sanitizeNetworkError(err, timeoutMs) {
  if (isTimeoutError(err)) return `timeout after ${timeoutMs}ms`;
  const raw = err?.message || err?.name || "fetch failed";
  const stripped = String(raw).replace(URL_IN_ERROR_RE, "[url]");
  const cleaned = sanitizeText(stripped, 80);
  return cleaned ? `network error: ${cleaned}` : "network error";
}

async function cancelBodyQuietly(res) {
  try {
    await res?.body?.cancel?.();
  } catch {
    // Ignore stream cancellation errors.
  }
}

async function readBoundedText(res, maxBytes) {
  if (res?.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "response body too large" };
        }
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
      return { ok: true, text };
    } finally {
      reader.releaseLock();
    }
  }

  const text = await res.text();
  if (text.length > maxBytes) {
    return { ok: false, reason: "response body too large" };
  }
  return { ok: true, text };
}

export async function probeOnce(targetUrl, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchImpl(targetUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "Cache-Control": "no-cache",
        "User-Agent": USER_AGENT,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    return { ok: false, reason: sanitizeNetworkError(err, timeoutMs) };
  }

  if (res.status !== 200) {
    await cancelBodyQuietly(res);
    return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
  }

  const contentType = res.headers?.get?.("content-type") || "";
  if (!isJsonContentType(contentType)) {
    await cancelBodyQuietly(res);
    const shortType = sanitizeText(contentType.split(";")[0] || "missing", 40) || "missing";
    return { ok: false, status: res.status, reason: `unexpected Content-Type (${shortType})` };
  }

  let bodyRead;
  try {
    bodyRead = await readBoundedText(res, MAX_BODY_BYTES);
  } catch (err) {
    return { ok: false, status: res.status, reason: sanitizeNetworkError(err, timeoutMs) };
  }
  if (!bodyRead.ok) {
    return { ok: false, status: res.status, reason: bodyRead.reason };
  }

  let payload;
  try {
    payload = JSON.parse(bodyRead.text);
  } catch {
    return { ok: false, status: res.status, reason: "invalid JSON body" };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, status: res.status, reason: "invalid JSON object" };
  }

  if (payload.ok !== true) {
    return { ok: false, status: res.status, reason: "health payload ok !== true" };
  }

  if (typeof payload.revision !== "string" || payload.revision.trim().length === 0) {
    return { ok: false, status: res.status, reason: "missing health revision" };
  }

  const revision = sanitizeText(payload.revision, 64);
  if (!revision) {
    return { ok: false, status: res.status, reason: "invalid health revision" };
  }

  return { ok: true, status: 200, revision };
}

export async function probeWithRetry(
  targetUrl,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}
) {
  const first = await probeOnce(targetUrl, { fetchImpl, timeoutMs });
  if (first.ok) {
    return { ...first, attempts: 1 };
  }
  if (retryDelayMs > 0) {
    await sleep(retryDelayMs);
  }
  const second = await probeOnce(targetUrl, { fetchImpl, timeoutMs });
  return { ...second, attempts: 2, firstError: first.reason };
}

export async function sendAlert(
  alertUrlRaw,
  message,
  {
    kind = "down",
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_ALERT_TIMEOUT_MS,
    logger = console
  } = {}
) {
  const trimmed = typeof alertUrlRaw === "string" ? alertUrlRaw.trim() : "";
  if (!trimmed) {
    return { sent: false, skipped: true };
  }

  const parsed = parseHttpsUrl(trimmed, { allowCredentials: false });
  if (!parsed) {
    logger?.error?.("Refusing invalid or non-HTTPS ALERT_URL");
    return { sent: false, error: "invalid_alert_url" };
  }

  const isRecovery = kind === "recovered";
  try {
    const res = await fetchImpl(parsed.toString(), {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "User-Agent": USER_AGENT,
        Title: isRecovery ? "Lean Ritual Uptime Recovered" : "Lean Ritual Uptime Alert",
        Tags: isRecovery ? "white_check_mark" : "rotating_light",
        Priority: isRecovery ? "default" : "high"
      },
      body: String(message),
      signal: AbortSignal.timeout(timeoutMs)
    });
    await cancelBodyQuietly(res);
    if (res.status < 200 || res.status >= 300) {
      logger?.error?.(`Alert delivery failed (HTTP ${res.status})`);
      return { sent: false, status: res.status, error: `http_${res.status}` };
    }
    return { sent: true, status: res.status };
  } catch (err) {
    const errName = sanitizeText(err?.name || "Error", 40) || "Error";
    logger?.error?.(`Alert delivery failed (${errName})`);
    return { sent: false, error: errName };
  }
}

async function readState(kv, logger) {
  try {
    const raw = await kv.get(STATE_KEY);
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object" || (parsed.status !== "up" && parsed.status !== "down")) {
      logger?.warn?.("Ignoring malformed uptime state in STATE_KV");
      return null;
    }
    return {
      status: parsed.status,
      since: typeof parsed.since === "string" ? parsed.since : null,
      lastAlertAt: typeof parsed.lastAlertAt === "string" ? parsed.lastAlertAt : null,
      consecutiveFailures:
        Number.isInteger(parsed.consecutiveFailures) && parsed.consecutiveFailures >= 0
          ? parsed.consecutiveFailures
          : parsed.status === "down"
            ? 1
            : 0,
      lastRevision: typeof parsed.lastRevision === "string" ? parsed.lastRevision : null,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null
    };
  } catch (err) {
    const errName = sanitizeText(err?.name || "Error", 40) || "Error";
    logger?.error?.(`STATE_KV read failed (${errName})`);
    return null;
  }
}

async function writeState(kv, state, logger) {
  try {
    await kv.put(STATE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    const errName = sanitizeText(err?.name || "Error", 40) || "Error";
    logger?.error?.(`STATE_KV write failed (${errName})`);
    return false;
  }
}

export async function runCheck(env = {}, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const logger = deps.logger ?? console;

  const targetRaw =
    typeof env.TARGET_URL === "string" && env.TARGET_URL.trim()
      ? env.TARGET_URL.trim()
      : DEFAULT_TARGET_URL;
  const targetParsed = parseHttpsUrl(targetRaw, { allowCredentials: false });
  if (!targetParsed) {
    throw new Error("Invalid TARGET_URL: must be a valid https:// URL");
  }

  const targetUrl = targetParsed.toString();
  const host = targetParsed.host;
  const timeoutMs = parseNumberSetting(env.PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS, {
    min: 100,
    max: 30000
  });
  const alertTimeoutMs = parseNumberSetting(env.ALERT_TIMEOUT_MS, DEFAULT_ALERT_TIMEOUT_MS, {
    min: 100,
    max: 30000
  });
  const retryDelayMs = parseNumberSetting(env.RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS, {
    min: 0,
    max: 15000
  });
  const reminderMinutes = parseNumberSetting(env.REMINDER_MINUTES, DEFAULT_REMINDER_MINUTES, {
    min: 1,
    max: 10080
  });

  const probe = await probeWithRetry(targetUrl, {
    fetchImpl,
    timeoutMs,
    retryDelayMs,
    sleep
  });

  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  const kv =
    env.STATE_KV &&
    typeof env.STATE_KV.get === "function" &&
    typeof env.STATE_KV.put === "function"
      ? env.STATE_KV
      : null;

  if (!kv) {
    if (probe.ok) {
      return {
        ok: true,
        status: "up",
        transition: "none",
        revision: probe.revision,
        attempts: probe.attempts,
        alerted: false,
        kvBound: false
      };
    }

    const alertMessage = `[DOWN] ${host} health check failed: ${probe.reason}`;
    const alert = await sendAlert(env.ALERT_URL, alertMessage, {
      kind: "down",
      fetchImpl,
      timeoutMs: alertTimeoutMs,
      logger
    });
    return {
      ok: false,
      status: "down",
      transition: "down",
      error: probe.reason,
      attempts: probe.attempts,
      alerted: alert.sent,
      alertMessage,
      kvBound: false
    };
  }

  const prev = await readState(kv, logger);

  if (probe.ok) {
    if (prev?.status === "down") {
      const sinceMs = prev.since ? Date.parse(prev.since) : NaN;
      const duration = formatDuration(Number.isFinite(sinceMs) ? Math.max(0, nowMs - sinceMs) : NaN);
      const shortRev = formatShortRevision(probe.revision);
      const alertMessage = `[RECOVERED] ${host} is back up (down for ${duration}, rev ${shortRev})`;
      const alert = await sendAlert(env.ALERT_URL, alertMessage, {
        kind: "recovered",
        fetchImpl,
        timeoutMs: alertTimeoutMs,
        logger
      });
      const nextState = {
        status: "up",
        since: nowIso,
        lastAlertAt: alert.sent ? nowIso : prev.lastAlertAt,
        consecutiveFailures: 0,
        lastRevision: probe.revision,
        lastError: null
      };
      await writeState(kv, nextState, logger);
      return {
        ok: true,
        status: "up",
        transition: "recovered",
        revision: probe.revision,
        attempts: probe.attempts,
        alerted: alert.sent,
        alertMessage,
        state: nextState,
        kvBound: true
      };
    }

    const nextState = {
      status: "up",
      since: prev?.since || nowIso,
      lastAlertAt: prev?.lastAlertAt ?? null,
      consecutiveFailures: 0,
      lastRevision: probe.revision,
      lastError: null
    };

    const needsWrite =
      !prev ||
      prev.status !== "up" ||
      prev.lastRevision !== probe.revision ||
      prev.consecutiveFailures !== 0 ||
      prev.lastError !== null;
    if (needsWrite) {
      await writeState(kv, nextState, logger);
    }

    return {
      ok: true,
      status: "up",
      transition: prev ? "none" : "init",
      revision: probe.revision,
      attempts: probe.attempts,
      alerted: false,
      state: nextState,
      kvBound: true
    };
  }

  const reminderMs = reminderMinutes * 60 * 1000;

  if (prev?.status !== "down") {
    const alertMessage = `[DOWN] ${host} health check failed: ${probe.reason}`;
    const alert = await sendAlert(env.ALERT_URL, alertMessage, {
      kind: "down",
      fetchImpl,
      timeoutMs: alertTimeoutMs,
      logger
    });
    const nextState = {
      status: "down",
      since: nowIso,
      lastAlertAt: alert.sent ? nowIso : null,
      consecutiveFailures: 1,
      lastRevision: prev?.lastRevision ?? null,
      lastError: probe.reason
    };
    await writeState(kv, nextState, logger);
    return {
      ok: false,
      status: "down",
      transition: "down",
      error: probe.reason,
      attempts: probe.attempts,
      alerted: alert.sent,
      alertMessage,
      state: nextState,
      kvBound: true
    };
  }

  const consecutiveFailures = (prev.consecutiveFailures > 0 ? prev.consecutiveFailures : 1) + 1;
  const lastAlertMs = prev.lastAlertAt ? Date.parse(prev.lastAlertAt) : NaN;
  const neverAlerted = !Number.isFinite(lastAlertMs);
  const shouldAlert = neverAlerted || nowMs - lastAlertMs >= reminderMs;

  let alert = { sent: false };
  let alertMessage = null;
  if (shouldAlert) {
    if (neverAlerted) {
      alertMessage = `[DOWN] ${host} health check failed: ${probe.reason}`;
    } else {
      const sinceMs = prev.since ? Date.parse(prev.since) : NaN;
      const duration = formatDuration(Number.isFinite(sinceMs) ? Math.max(0, nowMs - sinceMs) : NaN);
      alertMessage = `[DOWN] ${host} health check failed (still down for ${duration}): ${probe.reason}`;
    }
    alert = await sendAlert(env.ALERT_URL, alertMessage, {
      kind: "down",
      fetchImpl,
      timeoutMs: alertTimeoutMs,
      logger
    });
  }

  const nextState = {
    status: "down",
    since: prev.since || nowIso,
    lastAlertAt: alert.sent ? nowIso : prev.lastAlertAt,
    consecutiveFailures,
    lastRevision: prev.lastRevision ?? null,
    lastError: probe.reason
  };
  await writeState(kv, nextState, logger);

  return {
    ok: false,
    status: "down",
    transition: shouldAlert ? "reminder" : "suppressed",
    error: probe.reason,
    attempts: probe.attempts,
    alerted: alert.sent,
    alertMessage,
    state: nextState,
    kvBound: true
  };
}

export default {
  async fetch() {
    return new Response("Not Found\n", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      }
    });
  },

  async scheduled(_controller, env) {
    await runCheck(env);
  }
};
