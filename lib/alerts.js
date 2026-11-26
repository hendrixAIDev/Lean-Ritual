"use strict";

const ALERT_TIMEOUT_MS = 3000;

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

async function sendAlert({
  alertUrl,
  title,
  tags,
  priority,
  body,
  fetcher = fetch,
  timeoutMs = ALERT_TIMEOUT_MS,
  log = console.warn,
  label = "alert"
}) {
  const parsed = parseAlertUrl(alertUrl);
  if (!parsed) return { sent: false, skipped: true };
  if (parsed.invalid) {
    log(`${label} skipped: invalid or non-HTTPS ALERT_URL`);
    return { sent: false, skipped: true, reason: "invalid_url" };
  }
  const headers = {
    Title: title || "Lean Ritual",
    "Content-Type": "text/plain; charset=utf-8"
  };
  if (tags) headers.Tags = tags;
  if (priority) headers.Priority = priority;
  try {
    // Do not follow redirects: never forward alert POSTs to a second origin.
    const res = await fetcher(parsed.url, {
      method: "POST",
      headers,
      body: String(body ?? ""),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.status >= 200 && res.status < 300) {
      return { sent: true, status: res.status };
    }
    if (res.status >= 300 && res.status < 400) {
      log(`${label} failed: redirect rejected (http=${res.status})`);
      return { sent: false, status: res.status, reason: "redirect_rejected" };
    }
    log(`${label} failed (http=${res.status})`);
    return { sent: false, status: res.status };
  } catch (err) {
    const code = err?.name || err?.code || "error";
    log(`${label} failed (${code})`);
    return { sent: false, error: code };
  }
}

module.exports = {
  ALERT_TIMEOUT_MS,
  parseAlertUrl,
  sendAlert
};
