'use strict';
const {createHmac, randomBytes} = require('node:crypto');
const {
  DEFAULT_AI_BUDGETS,
  parseNonNegativeNumber,
  parsePricing,
  resolveModelRate,
  splitOutputTokens,
  estimateAttemptUpperBoundNanos,
  calcUsageCostNanos,
  usdToNanos,
  nanosToUsd,
  roundUsd,
  ensureAiBudgetSchema
} = require('./ai-pricing');
const {sendAlert} = require('./alerts');

function failure(status, code, message) { return Object.assign(new Error(message), {status,code}); }
function positiveLimit(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  return value;
}
const PROVIDERS = new Set(['openrouter', 'gemini']);
const ALLOWED_PROVIDER_ORIGINS = {
  openrouter: 'https://openrouter.ai',
  gemini: 'https://generativelanguage.googleapis.com'
};
const DEFAULT_OR_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_OR_MODEL = 'google/gemini-3.8-flash';
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_RETRY_DELAYS = [400, 1000];
const REQUEST_TIMEOUT_MS = 120000;
const RESERVATION_TTL_MS = REQUEST_TIMEOUT_MS + 30000;
const FALLBACK_RESERVE_MS = 30000;
const GEMINI_RETRY_BUDGET_MS = 15000;
const MIN_ATTEMPT_BUDGET_MS = 1000;
const MAX_BUDGET_USD = 1_000_000;
const MAX_ALERT_ATTEMPTS = 3;
const DEFAULT_ALERT_RETRY_DELAY_MS = 60000;
const FALLBACK_ERROR_STATUSES = new Set(['UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'DEADLINE_EXCEEDED']);
const FALLBACK_ERROR_REASONS = new Set(['RATE_LIMIT_EXCEEDED', 'RESOURCE_EXHAUSTED']);
// Pre-execution HTTP rejections without usage tokens are confirmed non-billable.
// 5xx responses, timeouts, aborted reads, and HTTP 200 without usage are ambiguous and keep the conservative debit.
const CONFIRMED_NONBILLABLE_STATUSES = new Set([400, 401, 403, 404, 422, 429]);
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseProvider(value) {
  if (value === undefined || value === null) return 'openrouter';
  if (typeof value !== 'string') throw new Error('AI_PROVIDER must be openrouter or gemini');
  const trimmed = value.trim();
  if (!trimmed) return 'openrouter';
  if (!PROVIDERS.has(trimmed)) throw new Error('AI_PROVIDER must be openrouter or gemini');
  return trimmed;
}
function parseProviderBase(value, envName, providerName) {
  const fallback = providerName === 'gemini' ? DEFAULT_GEMINI_BASE : DEFAULT_OR_BASE;
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new Error(`${envName} must use ${ALLOWED_PROVIDER_ORIGINS[providerName]}`);
  }
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  let parsed;
  try { parsed = new URL(raw); } catch {
    throw new Error(`${envName} must use ${ALLOWED_PROVIDER_ORIGINS[providerName]}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${envName} must not contain credentials, query parameters, or fragments`);
  }
  const officialOrigin = ALLOWED_PROVIDER_ORIGINS[providerName];
  if (parsed.protocol !== 'https:' || parsed.origin !== officialOrigin) {
    throw new Error(`${envName} must use ${officialOrigin}`);
  }
  return {
    base: (parsed.origin + parsed.pathname).replace(/\/+$/, ''),
    origin: parsed.origin
  };
}
const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
function parseReasoningEffort(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('AI_REASONING_EFFORT must be low, medium, or high');
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!REASONING_EFFORTS.has(trimmed)) throw new Error('AI_REASONING_EFFORT must be low, medium, or high');
  return trimmed;
}
const FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls', 'error']);
const mapFinishReason = v => typeof v === 'string' && FINISH_REASONS.has(v) ? v : 'other';
const safeConfiguredModel = v => typeof v === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/.test(v.trim()) ? v.trim() : 'unknown';
const nonNegInt = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0;
const trimModel = (v, fallback) => typeof v === 'string' && v.trim() ? v.trim() : fallback;
const trimKey = v => typeof v === 'string' ? v.trim() : '';

function budgetMessage(code, lang) {
  const isEn = lang === 'en';
  if (code === 'ai_user_monthly_cap') {
    return isEn
      ? "You've reached this month's AI limit (resets next month UTC). You can still log meals and workouts manually."
      : '本月 AI 额度已用完，下月（UTC）自动重置。你仍可手动填写饮食和训练记录。';
  }
  if (code === 'ai_global_monthly_cap') {
    return isEn
      ? 'AI features are paused for the rest of this month (UTC) after reaching the app budget. You can still log everything manually.'
      : '本月全站 AI 额度已用完，AI 功能暂时暂停，下月（UTC）自动恢复。你仍可手动填写记录。';
  }
  return isEn
    ? "Today's AI request limit has been reached. You can still log manually or try again tomorrow."
    : '今天的 AI 使用次数已达上限，请手动填写或明天再试';
}

function extractError(result) {
  if (!result || typeof result !== 'object') return null;
  const err = Array.isArray(result) ? result[0]?.error : result.error;
  return err && typeof err === 'object' ? err : null;
}
function hasUpstreamError(result) {
  if (!result || typeof result !== 'object') return false;
  return Boolean(Array.isArray(result) ? result[0]?.error : result.error);
}
function isResponseFormat400(response, result) {
  if (!response || response.ok || response.status !== 400) return false;
  const err = extractError(result);
  if (!err) return false;
  if (err.code !== undefined && Number(err.code) !== 400 && typeof err.code !== 'string') return false;
  const detail = [
    typeof err.param === 'string' ? err.param : '',
    typeof err.code === 'string' ? err.code : '',
    typeof err.message === 'string' ? err.message : '',
    typeof err.metadata?.raw === 'string' ? err.metadata.raw : ''
  ].join(' ');
  return /\b(response_format|response_mime_type|responseMimeType|json_object|json_schema|structured_outputs?|json[\s_-]?mode)\b/i.test(detail);
}
function isTransientStatus(code) {
  return code === 429 || (code >= 500 && code <= 599);
}
function hasStructuredTransientError(result) {
  const err = extractError(result);
  if (!err) return false;
  if (isTransientStatus(Number(err.code))) return true;
  if (typeof err.status === 'string' && FALLBACK_ERROR_STATUSES.has(err.status.trim().toUpperCase())) return true;
  if (Array.isArray(err.details)) {
    for (const d of err.details) {
      if (typeof d?.reason === 'string' && FALLBACK_ERROR_REASONS.has(d.reason.trim().toUpperCase())) return true;
    }
  }
  return false;
}
function isTransientGeminiHttpFailure(response, result) {
  if (!response) return false;
  if (isTransientStatus(response.status)) return true;
  if (response.ok && hasStructuredTransientError(result)) return true;
  return false;
}
function shouldFallbackToOpenRouter(attempt) {
  if (attempt.networkError) return true;
  return isTransientGeminiHttpFailure(attempt.res, attempt.json);
}

function extractAuthoritativeUsage(out) {
  const u = out?.json?.usage;
  if (!u || typeof u !== 'object') return null;
  const hasPrompt = typeof u.prompt_tokens === 'number' && Number.isFinite(u.prompt_tokens) && u.prompt_tokens >= 0;
  const hasComp = typeof u.completion_tokens === 'number' && Number.isFinite(u.completion_tokens) && u.completion_tokens >= 0;
  if (!hasPrompt || !hasComp) return null;
  const pTok = Math.trunc(u.prompt_tokens);
  const cTok = Math.trunc(u.completion_tokens);
  const rawR = u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens;
  const rTok = typeof rawR === 'number' && Number.isFinite(rawR) && rawR >= 0 ? Math.trunc(rawR) : 0;
  const tTok = typeof u.total_tokens === 'number' && Number.isFinite(u.total_tokens) && u.total_tokens >= 0
    ? Math.trunc(u.total_tokens)
    : 0;
  if (pTok === 0 && cTok === 0 && rTok === 0) return null;
  return { promptTokens: pTok, completionTokens: cTok, reasoningTokens: rTok, totalTokens: tTok };
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function hasDeletionTombstone(db, uid) {
  if (typeof uid !== 'string' || !uid) return true;
  if (!hasTable(db, 'deletion_jobs')) return false;
  return !!db.prepare('SELECT 1 FROM deletion_jobs WHERE uid = ?').get(uid);
}

function createAIProxy(db, config, fetcher = fetch) {
  const provider = parseProvider(config.aiProvider);
  const perUser = positiveLimit(config.aiDaily, 'AI_DAILY_LIMIT', true);
  const global = positiveLimit(config.aiGlobalDaily, 'AI_GLOBAL_DAILY_LIMIT', true);
  const maxTokens = positiveLimit(config.aiMaxTokens, 'AI_MAX_OUTPUT_TOKENS');
  const effort = parseReasoningEffort(config.aiReasoningEffort);
  const userMonthlyUsd = parseNonNegativeNumber(
    config.aiUserMonthlyUsd,
    DEFAULT_AI_BUDGETS.userMonthlyUsd,
    'AI_USER_MONTHLY_USD',
    MAX_BUDGET_USD
  );
  const globalMonthlyUsd = parseNonNegativeNumber(
    config.aiGlobalMonthlyUsd,
    DEFAULT_AI_BUDGETS.globalMonthlyUsd,
    'AI_GLOBAL_MONTHLY_USD',
    MAX_BUDGET_USD
  );
  const userMonthlyNanos = usdToNanos(userMonthlyUsd);
  const globalMonthlyNanos = usdToNanos(globalMonthlyUsd);
  const pricing = config.aiPricing || parsePricing(config.env || {});
  const orKey = trimKey(config.orKey);
  const {base: orBase, origin: orOrigin} = parseProviderBase(config.orBase, 'OPENROUTER_BASE', 'openrouter');
  const orModel = trimModel(config.orModel, DEFAULT_OR_MODEL);
  const geminiKey = trimKey(config.geminiKey);
  const {base: geminiBase, origin: geminiOrigin} = parseProviderBase(config.geminiBase, 'GEMINI_BASE', 'gemini');
  const geminiModel = trimModel(config.geminiModel, DEFAULT_GEMINI_MODEL);
  const configuredOrModel = safeConfiguredModel(orModel);
  const configuredGeminiModel = safeConfiguredModel(geminiModel);
  const primaryKey = provider === 'gemini' ? geminiKey : orKey;
  const hasFallback = provider === 'gemini' && Boolean(geminiKey) && Boolean(orKey);
  const alertUrl = typeof config.alertUrl === 'string' ? config.alertUrl.trim() : '';
  const alertFetcher = config.alertFetcher || fetcher;
  const alertLog = config.alertLog || console.warn;
  const alertRetryDelayMs = Number.isFinite(config.alertRetryDelayMs) && config.alertRetryDelayMs >= 0
    ? config.alertRetryDelayMs
    : DEFAULT_ALERT_RETRY_DELAY_MS;
  const nowFn = () => (typeof config.now === 'function' ? config.now() : Date.now());

  ensureAiBudgetSchema(db);

  function getModelForTarget(target) {
    return target === 'gemini' ? configuredGeminiModel : configuredOrModel;
  }

  function estimateAttemptReserveNanos(target, messages, images, atMs = nowFn()) {
    const rate = resolveModelRate(pricing, target, getModelForTarget(target), atMs);
    return {
      rate,
      reserveNanos: estimateAttemptUpperBoundNanos(messages, images, maxTokens, rate)
    };
  }

  function minPrimaryReserveNanos(atMs = nowFn()) {
    return estimateAttemptReserveNanos(provider, [{role: 'user', content: ''}], [], atMs).reserveNanos;
  }

  function getGlobalEffectiveSpentNanos(month) {
    const live = db.prepare('SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?').get(month)?.cost_nanos || 0;
    const base = db.prepare('SELECT baseline_nanos FROM ai_global_monthly_baseline WHERE month = ?').get(month)?.baseline_nanos || 0;
    return live + base;
  }

  function isAppWidePausedAt(effectiveSpentNanos, atMs) {
    if (globalMonthlyNanos === 0) return true;
    const minRes = minPrimaryReserveNanos(atMs);
    return effectiveSpentNanos >= globalMonthlyNanos || effectiveSpentNanos + minRes > globalMonthlyNanos;
  }

  // Enqueue 80% and 100% alerts independently (never else-if) inside an active transaction.
  // 100% triggers ONLY when the app-wide pause threshold is reached, never for a single oversized request.
  function enqueueThresholdAlertsInTx(month, atMs) {
    if (globalMonthlyNanos <= 0) return;
    const effectiveSpent = getGlobalEffectiveSpentNanos(month);
    const isoNow = new Date(atMs).toISOString();
    if (effectiveSpent * 5 >= globalMonthlyNanos * 4) {
      db.prepare(
        `INSERT OR IGNORE INTO ai_budget_alerts
         (month, threshold, status, attempts, next_attempt_at, dedupe_key, sent_at, delivered_at, spend_nanos, cap_nanos)
         VALUES (?, 80, 'pending', 0, 0, ?, ?, NULL, ?, ?)`
      ).run(month, `ai-budget:${month}:80`, isoNow, effectiveSpent, globalMonthlyNanos);
    }
    if (isAppWidePausedAt(effectiveSpent, atMs)) {
      db.prepare(
        `INSERT OR IGNORE INTO ai_budget_alerts
         (month, threshold, status, attempts, next_attempt_at, dedupe_key, sent_at, delivered_at, spend_nanos, cap_nanos)
         VALUES (?, 100, 'pending', 0, 0, ?, ?, NULL, ?, ?)`
      ).run(month, `ai-budget:${month}:100`, isoNow, effectiveSpent, globalMonthlyNanos);
    }
  }

  function claimDueAlertsInTx(atMs) {
    const isoNow = new Date(atMs).toISOString();
    const rows = db.prepare(
      `SELECT month, threshold, attempts, dedupe_key, spend_nanos, cap_nanos
       FROM ai_budget_alerts
       WHERE status = 'pending' AND attempts < ? AND next_attempt_at <= ?
       ORDER BY month ASC, threshold ASC`
    ).all(MAX_ALERT_ATTEMPTS, atMs);
    const claimed = [];
    for (const row of rows) {
      const upd = db.prepare(
        `UPDATE ai_budget_alerts
         SET attempts = attempts + 1, next_attempt_at = ?, sent_at = ?
         WHERE month = ? AND threshold = ? AND status = 'pending' AND attempts = ?`
      ).run(atMs + alertRetryDelayMs, isoNow, row.month, row.threshold, row.attempts);
      if (upd.changes === 1) {
        claimed.push({
          month: row.month,
          threshold: row.threshold,
          attempts: row.attempts + 1,
          dedupeKey: row.dedupe_key || `ai-budget:${row.month}:${row.threshold}`,
          spendNanos: row.spend_nanos,
          capNanos: row.cap_nanos
        });
      }
    }
    return claimed;
  }

  // Expired reservations represent uncertain provider work (e.g. crash or failed settlement).
  // NEVER refund them: conservatively finalize their full reserved_nanos into permanent spend.
  function reconcileExpiredReservationsInTx(atMs) {
    const expired = db.prepare(
      'SELECT id, uid, month, reserved_nanos FROM ai_budget_reservations WHERE expires_at <= ?'
    ).all(atMs);
    if (!expired.length) return;
    const isoNow = new Date(atMs).toISOString();
    const touchedMonths = new Set();
    for (const row of expired) {
      db.prepare('DELETE FROM ai_budget_reservations WHERE id = ?').run(row.id);
      db.prepare(
        `INSERT INTO ai_global_monthly_usage (month, calls, prompt_tokens, completion_tokens, reasoning_tokens, cost_nanos, updated)
         VALUES (?, 1, 0, 0, 0, ?, ?)
         ON CONFLICT(month) DO UPDATE SET
           calls = calls + 1,
           cost_nanos = cost_nanos + excluded.cost_nanos,
           updated = excluded.updated`
      ).run(row.month, row.reserved_nanos, isoNow);
      if (row.uid && !hasDeletionTombstone(db, row.uid)) {
        db.prepare(
          `INSERT INTO ai_monthly_usage (uid, month, calls, prompt_tokens, completion_tokens, reasoning_tokens, cost_nanos, updated)
           VALUES (?, ?, 1, 0, 0, 0, ?, ?)
           ON CONFLICT(uid, month) DO UPDATE SET
             calls = calls + 1,
             cost_nanos = cost_nanos + excluded.cost_nanos,
             updated = excluded.updated`
        ).run(row.uid, row.month, row.reserved_nanos, isoNow);
      }
      touchedMonths.add(row.month);
    }
    for (const m of touchedMonths) enqueueThresholdAlertsInTx(m, atMs);
  }

  async function deliverClaimedAlerts(claimed) {
    if (!claimed || !claimed.length) return;
    for (const alert of claimed) {
      const spendStr = `$${nanosToUsd(alert.spendNanos).toFixed(2)}`;
      const capStr = `$${nanosToUsd(alert.capNanos).toFixed(2)}`;
      const isPause = alert.threshold >= 100;
      const title = isPause
        ? 'Lean Ritual AI Budget Paused (100%)'
        : `Lean Ritual AI Budget (${alert.threshold}%)`;
      const body = isPause
        ? `AI paused for ${alert.month}: monthly budget reached (${spendStr} / ${capStr} UTC). Resets automatically next month.`
        : `AI monthly spend reached ${alert.threshold}% for ${alert.month} (${spendStr} / ${capStr} UTC).`;
      let res = { sent: false };
      try {
        res = await sendAlert({
          alertUrl,
          title,
          tags: isPause ? 'rotating_light' : 'warning',
          priority: isPause ? 'high' : undefined,
          idempotencyKey: alert.dedupeKey,
          body,
          fetcher: alertFetcher,
          log: alertLog,
          label: 'ai budget alert'
        });
      } catch {
        res = { sent: false };
      }
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          if (res.sent) {
            db.prepare(
              "UPDATE ai_budget_alerts SET status = 'delivered', delivered_at = ? WHERE month = ? AND threshold = ?"
            ).run(new Date(nowFn()).toISOString(), alert.month, alert.threshold);
          } else if (res.skipped) {
            db.prepare(
              "UPDATE ai_budget_alerts SET status = 'skipped' WHERE month = ? AND threshold = ?"
            ).run(alert.month, alert.threshold);
          } else if (alert.attempts >= MAX_ALERT_ATTEMPTS) {
            db.prepare(
              "UPDATE ai_budget_alerts SET status = 'failed' WHERE month = ? AND threshold = ?"
            ).run(alert.month, alert.threshold);
          }
          db.exec('COMMIT');
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      } catch (err) {
        alertLog(`ai budget alert state update failed (${err?.code || err?.name || 'error'})`);
      }
    }
  }

  // Reconcile any expired reservations from a prior crash immediately on startup (without claiming alerts yet).
  function reconcileExpiredOnly() {
    const atMs = nowFn();
    db.exec('BEGIN IMMEDIATE');
    try {
      reconcileExpiredReservationsInTx(atMs);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }
  try { reconcileExpiredOnly(); } catch {}

  function resolveUserLang(user, body) {
    const explicit = body?.lang ?? user?.lang;
    if (explicit === 'en' || explicit === 'zh') return explicit;
    if (typeof config.getUserLang === 'function') {
      try {
        const lookedUp = config.getUserLang(user);
        if (lookedUp === 'en' || lookedUp === 'zh') return lookedUp;
      } catch {}
    }
    return 'zh';
  }

  function getBudgetStatus(uid) {
    const atMs = nowFn();
    const month = new Date(atMs).toISOString().slice(0, 7);
    const minReserve = minPrimaryReserveNanos(atMs);
    const overrideRow = uid
      ? db.prepare('SELECT monthly_usd_nanos FROM ai_user_caps WHERE uid = ?').get(uid)
      : null;
    const userCapNanos = overrideRow ? overrideRow.monthly_usd_nanos : userMonthlyNanos;
    const userSettledNanos = uid
      ? (db.prepare('SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?').get(uid, month)?.cost_nanos || 0)
      : 0;
    const userReservedNanos = uid
      ? (db.prepare('SELECT COALESCE(SUM(reserved_nanos), 0) AS n FROM ai_budget_reservations WHERE uid = ? AND month = ?').get(uid, month).n)
      : 0;
    const userEffectiveNanos = userSettledNanos + userReservedNanos;

    const globalEffectiveSettled = getGlobalEffectiveSpentNanos(month);
    const globalReservedNanos = db.prepare('SELECT COALESCE(SUM(reserved_nanos), 0) AS n FROM ai_budget_reservations WHERE month = ?').get(month).n;
    const globalCommittedNanos = globalEffectiveSettled + globalReservedNanos;

    const globalPaused = globalMonthlyNanos === 0 || globalCommittedNanos >= globalMonthlyNanos || globalCommittedNanos + minReserve > globalMonthlyNanos;
    const reached = userCapNanos === 0 || userEffectiveNanos >= userCapNanos || userEffectiveNanos + minReserve > userCapNanos;
    const usedPct = userCapNanos > 0
      ? Math.min(100, Math.floor((userEffectiveNanos * 100) / userCapNanos))
      : 100;
    const nearCap = !globalPaused && !reached && userCapNanos > 0 && userEffectiveNanos * 5 >= userCapNanos * 4;
    return { month, usedPct, nearCap, reached, globalPaused };
  }

  async function aiProxy(user, body) {
    if (!primaryKey) throw failure(503,'sampling_disabled','服务器没有配置 AI');
    if (!body || !Array.isArray(body.messages) || !body.messages.length) throw failure(400,'bad_request','请提供消息');
    const lang = resolveUserLang(user, body);
    const wantJSON = body.json === true;
    const messages = body.messages.slice(-12).map(t => ({role:t?.role === 'assistant' ? 'assistant' : 'user',content:String(t?.content ?? '').slice(0,60000)}));
    const images = (Array.isArray(body.images) ? body.images : []).slice(0,4).filter(u=>typeof u === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(u));
    if (images.length) {
      const last = messages[messages.length-1];
      last.content = [{type:'text',text:last.content},...images.map(url=>({type:'image_url',image_url:{url}}))];
    }
    const now = typeof config.now === 'function' ? config.now : Date.now;
    const sleep = typeof config.sleep === 'function' ? config.sleep : defaultSleep;
    const retryDelays = Array.isArray(config.geminiRetryDelays) ? config.geminiRetryDelays : GEMINI_RETRY_DELAYS;
    const started = now();
    const deadline = started + REQUEST_TIMEOUT_MS;
    const primaryDeadline = hasFallback ? deadline - FALLBACK_RESERVE_MS : deadline;
    const pseudonym = config.authSecret
      ? createHmac('sha256',config.authSecret).update('lean-ritual:ai-provider-user:v1:').update(user.id).digest('hex').slice(0,32)
      : undefined;

    let dailyClaimed = false;
    const monthsCounted = new Set();
    let accCostNanos = 0;
    let totalDispatchedAttempts = 0;

    // Atomically admit & reserve an individual provider attempt for the UTC month at dispatch time.
    async function reserveAttempt(target) {
      const dispatchMs = now();
      const isoDispatch = new Date(dispatchMs).toISOString();
      const day = isoDispatch.slice(0, 10);
      const month = isoDispatch.slice(0, 7);
      const { rate, reserveNanos } = estimateAttemptReserveNanos(target, messages, images, dispatchMs);
      const reservationId = randomBytes(12).toString('hex');
      const expiresAt = dispatchMs + RESERVATION_TTL_MS;

      let refusal = null;
      let claimedAlerts = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        reconcileExpiredReservationsInTx(dispatchMs);

        if (hasDeletionTombstone(db, user.id)) {
          refusal = failure(423, 'account_deleting', '账号删除处理中，不能再写入或读取记录');
        }

        if (!refusal) {
          const globalSpent = getGlobalEffectiveSpentNanos(month);
          const globalReserved = db.prepare('SELECT COALESCE(SUM(reserved_nanos), 0) AS n FROM ai_budget_reservations WHERE month = ?').get(month).n;
          if (
            globalMonthlyNanos === 0 ||
            globalSpent >= globalMonthlyNanos ||
            globalSpent + globalReserved + reserveNanos > globalMonthlyNanos
          ) {
            enqueueThresholdAlertsInTx(month, dispatchMs);
            refusal = failure(503, 'ai_global_monthly_cap', budgetMessage('ai_global_monthly_cap', lang));
          }
        }

        if (!refusal) {
          const overrideRow = db.prepare('SELECT monthly_usd_nanos FROM ai_user_caps WHERE uid = ?').get(user.id);
          const userCapNanos = overrideRow ? overrideRow.monthly_usd_nanos : userMonthlyNanos;
          const userSpent = db.prepare('SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?').get(user.id, month)?.cost_nanos || 0;
          const userReserved = db.prepare('SELECT COALESCE(SUM(reserved_nanos), 0) AS n FROM ai_budget_reservations WHERE uid = ? AND month = ?').get(user.id, month).n;
          if (
            userCapNanos === 0 ||
            userSpent >= userCapNanos ||
            userSpent + userReserved + reserveNanos > userCapNanos
          ) {
            refusal = failure(429, 'ai_user_monthly_cap', budgetMessage('ai_user_monthly_cap', lang));
          }
        }

        if (!refusal && !dailyClaimed) {
          const used = db.prepare('SELECT n FROM ai_usage WHERE uid = ? AND day = ?').get(user.id, day)?.n || 0;
          const total = db.prepare('SELECT COALESCE(SUM(n),0) AS n FROM ai_usage WHERE day = ?').get(day).n;
          if (used >= perUser || total >= global) {
            refusal = failure(429, 'rate_limited', budgetMessage('rate_limited', lang));
          }
        }

        if (!refusal) {
          if (!dailyClaimed) {
            db.prepare('INSERT INTO ai_usage (uid,day,n) VALUES (?,?,1) ON CONFLICT(uid,day) DO UPDATE SET n=n+1').run(user.id, day);
            dailyClaimed = true;
          }
          db.prepare(
            'INSERT INTO ai_budget_reservations (id,uid,month,reserved_nanos,created_at,expires_at) VALUES (?,?,?,?,?,?)'
          ).run(reservationId, user.id, month, reserveNanos, dispatchMs, expiresAt);
        }

        claimedAlerts = claimDueAlertsInTx(dispatchMs);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }

      if (claimedAlerts.length) await deliverClaimedAlerts(claimedAlerts);
      if (refusal) throw refusal;
      return { id: reservationId, month, rate, reserveNanos };
    }

    // Replace an attempt's persisted conservative reservation with authoritative usage,
    // confirmed non-billable rejection (0), or keep the conservative upper bound on ambiguity.
    async function settleAttempt(reservation, out) {
      const authUsage = extractAuthoritativeUsage(out);
      let promptTok = 0, compTok = 0, reasonTok = 0, costNanos = reservation.reserveNanos;
      if (authUsage) {
        const split = splitOutputTokens(authUsage);
        promptTok = authUsage.promptTokens;
        compTok = split.billedOutputTokens;
        reasonTok = authUsage.reasoningTokens;
        costNanos = calcUsageCostNanos(authUsage, reservation.rate);
      } else if (
        out &&
        !out.networkError &&
        out.res &&
        !out.res.ok &&
        CONFIRMED_NONBILLABLE_STATUSES.has(out.res.status)
      ) {
        costNanos = 0;
      }
      accCostNanos += costNanos;

      const settleMs = now();
      const isoSettle = new Date(settleMs).toISOString();
      const callInc = monthsCounted.has(reservation.month) ? 0 : 1;
      let claimedAlerts = [];
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM ai_budget_reservations WHERE id = ?').run(reservation.id);
          db.prepare(
            `INSERT INTO ai_global_monthly_usage (month, calls, prompt_tokens, completion_tokens, reasoning_tokens, cost_nanos, updated)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(month) DO UPDATE SET
               calls = calls + excluded.calls,
               prompt_tokens = prompt_tokens + excluded.prompt_tokens,
               completion_tokens = completion_tokens + excluded.completion_tokens,
               reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
               cost_nanos = cost_nanos + excluded.cost_nanos,
               updated = excluded.updated`
          ).run(reservation.month, callInc, promptTok, compTok, reasonTok, costNanos, isoSettle);

          // Consult deletion tombstone inside the transaction: never recreate usage rows for a deleting/deleted user.
          if (!hasDeletionTombstone(db, user.id)) {
            db.prepare(
              `INSERT INTO ai_monthly_usage (uid, month, calls, prompt_tokens, completion_tokens, reasoning_tokens, cost_nanos, updated)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(uid, month) DO UPDATE SET
                 calls = calls + excluded.calls,
                 prompt_tokens = prompt_tokens + excluded.prompt_tokens,
                 completion_tokens = completion_tokens + excluded.completion_tokens,
                 reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
                 cost_nanos = cost_nanos + excluded.cost_nanos,
                 updated = excluded.updated`
            ).run(user.id, reservation.month, callInc, promptTok, compTok, reasonTok, costNanos, isoSettle);
          }

          enqueueThresholdAlertsInTx(reservation.month, settleMs);
          claimedAlerts = claimDueAlertsInTx(settleMs);
          db.exec('COMMIT');
          monthsCounted.add(reservation.month);
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      } catch (err) {
        // Reservation remains persisted in SQLite on settlement error and will be finalized conservatively on expiry.
        alertLog(`ai budget settlement failed (${err?.code || err?.name || 'error'})`);
      }

      if (claimedAlerts.length) await deliverClaimedAlerts(claimedAlerts);
    }

    const invokeProvider = async (target, targetDeadline) => {
      const isGemini = target === 'gemini';
      const url = (isGemini ? geminiBase : orBase) + '/chat/completions';
      const expectedOrigin = isGemini ? geminiOrigin : orOrigin;
      if (new URL(url).origin !== expectedOrigin) {
        throw new Error(`Refusing to send ${target} credentials to mismatched origin`);
      }
      const headers = isGemini
        ? {Authorization:'Bearer '+geminiKey,'Content-Type':'application/json'}
        : {Authorization:'Bearer '+orKey,'Content-Type':'application/json','X-Title':'Bojin Rike'};
      const basePayload = isGemini
        ? {
            model:geminiModel,
            messages,
            max_tokens:maxTokens,
            ...(effort ? {reasoning_effort:effort} : {})
          }
        : {
            model:orModel,
            messages,
            user:pseudonym,
            max_tokens:maxTokens,
            ...(effort ? {reasoning:{effort}} : {})
          };
      const sendReq = async payload => {
        const remaining = targetDeadline - now();
        if (remaining < MIN_ATTEMPT_BUDGET_MS) {
          return {res:undefined,json:undefined,networkError:true};
        }
        const reservation = await reserveAttempt(target);
        const remainingAfterReserve = targetDeadline - now();
        if (remainingAfterReserve < MIN_ATTEMPT_BUDGET_MS) {
          // Never dispatched upstream -> release the unused reservation cleanly.
          try { db.prepare('DELETE FROM ai_budget_reservations WHERE id = ?').run(reservation.id); } catch {}
          return {res:undefined,json:undefined,networkError:true};
        }
        totalDispatchedAttempts++;
        let out = {res:undefined,json:undefined,networkError:true};
        try {
          const signal = AbortSignal.timeout(remainingAfterReserve);
          let res;
          try {
            res = await fetcher(url, {
              method:'POST',headers,
              body:JSON.stringify(payload),redirect:'manual',signal
            });
          } catch {
            out = {res:undefined,json:undefined,networkError:true};
            return out;
          }
          let json = null;
          try {
            json = await res.json();
          } catch (err) {
            const bodyAborted = signal.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError' || now() >= targetDeadline;
            if (bodyAborted && res.ok) {
              out = {res:undefined,json:undefined,networkError:true};
              return out;
            }
            json = null;
          }
          out = {res,json,networkError:false};
          return out;
        } finally {
          await settleAttempt(reservation, out);
        }
      };
      let jsonFallback = false;
      let out = await sendReq(wantJSON ? {...basePayload, response_format:{type:'json_object'}} : basePayload);
      if (!out.networkError && wantJSON && isResponseFormat400(out.res, out.json) && (targetDeadline - now()) >= MIN_ATTEMPT_BUDGET_MS) {
        jsonFallback = true;
        out = await sendReq(basePayload);
      }
      return {...out, jsonFallback};
    };

    // Perform initial admission check before entering provider loop when attempt 1 can proceed.
    let servedProvider = provider;
    let servedModel = getModelForTarget(provider);
    let providerFallback = false;
    let retries = 0;
    let response, result, fallback = false, finishReason = 'error';
    try {
      let attempt = await invokeProvider(provider, primaryDeadline);
      ({res:response, json:result, jsonFallback:fallback} = attempt);
      if (provider === 'gemini') {
        while (
          retries < retryDelays.length &&
          !attempt.networkError &&
          (!attempt.res?.ok || hasUpstreamError(attempt.json)) &&
          isTransientGeminiHttpFailure(attempt.res, attempt.json)
        ) {
          const delay = retryDelays[retries];
          const elapsedAfterDelay = (now() - started) + delay;
          const primaryRemainingAfterDelay = (primaryDeadline - now()) - delay;
          if (elapsedAfterDelay >= GEMINI_RETRY_BUDGET_MS || primaryRemainingAfterDelay < MIN_ATTEMPT_BUDGET_MS) break;
          if (delay > 0) await sleep(delay);
          if (primaryDeadline - now() < MIN_ATTEMPT_BUDGET_MS) break;
          retries++;
          attempt = await invokeProvider('gemini', primaryDeadline);
          ({res:response, json:result, jsonFallback:fallback} = attempt);
        }
      }
      const failed = attempt.networkError || !attempt.res?.ok || hasUpstreamError(attempt.json);
      if (hasFallback && failed && shouldFallbackToOpenRouter(attempt) && (deadline - now()) >= MIN_ATTEMPT_BUDGET_MS) {
        providerFallback = true;
        servedProvider = 'openrouter';
        servedModel = configuredOrModel;
        attempt = await invokeProvider('openrouter', deadline);
        ({res:response, json:result, jsonFallback:fallback} = attempt);
      }
      if (attempt.networkError) {
        finishReason = 'error';
        throw failure(502,'ai_failed','AI 暂时无法连接，请稍后再试或手动填写');
      }
      if (!response.ok || hasUpstreamError(result)) {
        finishReason = 'error';
        throw failure(response.status===429?429:502,response.status===429?'rate_limited':'ai_failed','AI 服务暂时不可用，请稍后再试或手动填写');
      }
      const choice = result?.choices?.[0];
      finishReason = mapFinishReason(choice?.finish_reason);
      const text = choice?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw finishReason === 'length'
          ? failure(502,'truncated','AI 的回答太长被截断了，请再试一次或缩短反馈。')
          : failure(502,'ai_failed','AI 没有返回结果，请稍后再试');
      }
      return {text,truncated:finishReason==='length'};
    } finally {
      if (totalDispatchedAttempts > 0) {
        const text = result?.choices?.[0]?.message?.content;
        const empty = !response?.ok || hasUpstreamError(result) || typeof text !== 'string' || !text.trim();
        const usage = result?.usage;
        const promptTok = nonNegInt(usage?.prompt_tokens);
        const compTok = nonNegInt(usage?.completion_tokens);
        const reasonTok = nonNegInt(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens);
        const ms = Math.max(0, Math.trunc(now() - started));
        const costUsd = roundUsd(nanosToUsd(accCostNanos)).toFixed(6);
        (config.log || console.log)(`ai provider=${servedProvider}${providerFallback ? ' provider_fallback=true' : ''}${retries ? ` retries=${retries}` : ''} kind=${wantJSON ? 'json' : 'text'} images=${images.length} model=${servedModel} finish_reason=${finishReason} prompt=${promptTok} completion=${compTok} reasoning=${reasonTok} empty=${empty}${fallback ? ' fallback=true' : ''} ms=${ms} cost_usd=${costUsd}`);
      }
    }
  }

  async function flushAlerts() {
    const atMs = nowFn();
    let claimed = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      reconcileExpiredReservationsInTx(atMs);
      enqueueThresholdAlertsInTx(new Date(atMs).toISOString().slice(0, 7), atMs);
      claimed = claimDueAlertsInTx(atMs);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
    if (claimed.length) await deliverClaimedAlerts(claimed);
    return claimed.length;
  }

  return Object.assign(aiProxy, {
    provider,
    model: provider === 'gemini' ? geminiModel : orModel,
    enabled: Boolean(primaryKey),
    hasFallback,
    fallbackModel: orModel,
    pricing,
    budgets: { userMonthlyUsd, globalMonthlyUsd },
    getBudgetStatus,
    estimateAttemptReserveNanos,
    flushAlerts
  });
}
module.exports = {createAIProxy, budgetMessage, DEFAULT_OR_MODEL, DEFAULT_GEMINI_MODEL};
