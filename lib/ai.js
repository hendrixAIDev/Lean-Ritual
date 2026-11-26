'use strict';
const {createHmac, randomBytes} = require('node:crypto');
const {
  DEFAULT_AI_BUDGETS,
  parseNonNegativeNumber,
  parsePricing,
  resolveModelRate,
  splitOutputTokens,
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
const DEFAULT_OR_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_RETRY_DELAYS = [400, 1000];
const REQUEST_TIMEOUT_MS = 120000;
const RESERVATION_TTL_MS = REQUEST_TIMEOUT_MS + 30000;
const FALLBACK_RESERVE_MS = 30000;
const GEMINI_RETRY_BUDGET_MS = 15000;
const MIN_ATTEMPT_BUDGET_MS = 1000;
const MAX_BUDGET_USD = 1_000_000;
const FALLBACK_ERROR_STATUSES = new Set(['UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'DEADLINE_EXCEEDED']);
const FALLBACK_ERROR_REASONS = new Set(['RATE_LIMIT_EXCEEDED', 'RESOURCE_EXHAUSTED']);
const CJK_CHAR_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/g;
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

function estimateTextTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(CJK_CHAR_RE) || []).length;
  const other = s.length - cjk;
  return Math.ceil(cjk * 1.5 + other * 0.35);
}

function estimatePromptTokens(messages, images) {
  let tokens = 64;
  for (const msg of messages) {
    tokens += 8;
    if (typeof msg.content === 'string') {
      tokens += estimateTextTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'text') tokens += estimateTextTokens(part.text);
      }
    }
  }
  tokens += images.length * 1500;
  return tokens;
}

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
  const nowFn = () => (typeof config.now === 'function' ? config.now() : Date.now());

  ensureAiBudgetSchema(db);

  function estimateReservationNanos(messages, images) {
    const primaryModel = provider === 'gemini' ? configuredGeminiModel : configuredOrModel;
    const primaryRate = resolveModelRate(pricing, provider, primaryModel);
    const fallbackRate = hasFallback ? resolveModelRate(pricing, 'openrouter', configuredOrModel) : null;
    const maxInput = Math.max(primaryRate.inputPer1M, fallbackRate ? fallbackRate.inputPer1M : 0);
    const primaryOut = Math.max(primaryRate.outputPer1M, primaryRate.thinkingPer1M ?? primaryRate.outputPer1M);
    const fallbackOut = fallbackRate
      ? Math.max(fallbackRate.outputPer1M, fallbackRate.thinkingPer1M ?? fallbackRate.outputPer1M)
      : 0;
    const maxOutput = Math.max(primaryOut, fallbackOut);
    const estPrompt = estimatePromptTokens(messages, images);
    return calcUsageCostNanos(
      { promptTokens: estPrompt, completionTokens: maxTokens, reasoningTokens: 0 },
      { inputPer1M: maxInput, outputPer1M: maxOutput }
    );
  }

  async function dispatchBudgetAlert(alert) {
    if (!alert) return;
    const spendStr = `$${nanosToUsd(alert.spendNanos).toFixed(2)}`;
    const capStr = `$${nanosToUsd(alert.capNanos).toFixed(2)}`;
    const isPause = alert.threshold >= 100;
    const title = isPause
      ? 'Lean Ritual AI Budget Paused (100%)'
      : `Lean Ritual AI Budget (${alert.threshold}%)`;
    const body = isPause
      ? `AI paused for ${alert.month}: monthly budget reached (${spendStr} / ${capStr} UTC). Resets automatically next month.`
      : `AI monthly spend reached ${alert.threshold}% for ${alert.month} (${spendStr} / ${capStr} UTC).`;
    try {
      await sendAlert({
        alertUrl,
        title,
        tags: isPause ? 'rotating_light' : 'warning',
        priority: isPause ? 'high' : undefined,
        body,
        fetcher: alertFetcher,
        log: alertLog,
        label: 'ai budget alert'
      });
    } catch {
      // Never fail user requests because of an alert delivery issue.
    }
  }

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
    const month = new Date(nowFn()).toISOString().slice(0, 7);
    const minReserveNanos = estimateReservationNanos([{role: 'user', content: ''}], []);
    const overrideRow = uid
      ? db.prepare('SELECT monthly_usd_nanos FROM ai_user_caps WHERE uid = ?').get(uid)
      : null;
    const userCapNanos = overrideRow ? overrideRow.monthly_usd_nanos : userMonthlyNanos;
    const userSpentNanos = uid
      ? (db.prepare('SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?').get(uid, month)?.cost_nanos || 0)
      : 0;
    const globalSpentNanos = db.prepare('SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?').get(month)?.cost_nanos || 0;
    const globalPaused = globalMonthlyNanos === 0 || globalSpentNanos >= globalMonthlyNanos || globalSpentNanos + minReserveNanos > globalMonthlyNanos;
    const reached = userCapNanos === 0 || userSpentNanos >= userCapNanos || userSpentNanos + minReserveNanos > userCapNanos;
    const usedPct = userCapNanos > 0
      ? Math.min(100, Math.floor((userSpentNanos * 100) / userCapNanos))
      : 100;
    const nearCap = !globalPaused && !reached && userCapNanos > 0 && userSpentNanos * 5 >= userCapNanos * 4;
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
    const isoStarted = new Date(started).toISOString();
    const day = isoStarted.slice(0,10);
    const month = isoStarted.slice(0,7);
    const reserveNanos = estimateReservationNanos(messages, images);
    const reservationId = randomBytes(12).toString('hex');
    const expiresAt = started + RESERVATION_TTL_MS;

    // Reserve daily count + conservative monthly USD budget before any await, atomically across connections.
    // Failed attempts count: a timeout does not prove that the upstream provider did not incur a charge.
    let refusal = null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM ai_budget_reservations WHERE expires_at <= ?').run(started);
      const globalSpentNanos = db.prepare('SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?').get(month)?.cost_nanos || 0;
      const globalReservedNanos = db.prepare('SELECT COALESCE(SUM(reserved_nanos), 0) AS n FROM ai_budget_reservations WHERE month = ?').get(month).n;
      if (
        globalMonthlyNanos === 0 ||
        globalSpentNanos >= globalMonthlyNanos ||
        globalSpentNanos + globalReservedNanos + reserveNanos > globalMonthlyNanos
      ) {
        let alertToFire = null;
        if (globalMonthlyNanos > 0 && (globalSpentNanos >= globalMonthlyNanos || globalReservedNanos === 0)) {
          const claim = db.prepare(
            'INSERT OR IGNORE INTO ai_budget_alerts (month, threshold, sent_at, spend_nanos, cap_nanos) VALUES (?, 100, ?, ?, ?)'
          ).run(month, isoStarted, globalSpentNanos, globalMonthlyNanos);
          if (claim.changes === 1) {
            alertToFire = { threshold: 100, month, spendNanos: globalSpentNanos, capNanos: globalMonthlyNanos };
          }
        }
        refusal = { error: failure(503, 'ai_global_monthly_cap', budgetMessage('ai_global_monthly_cap', lang)), alertToFire };
      }

      if (!refusal) {
        const overrideRow = db.prepare('SELECT monthly_usd_nanos FROM ai_user_caps WHERE uid = ?').get(user.id);
        const userCapNanos = overrideRow ? overrideRow.monthly_usd_nanos : userMonthlyNanos;
        const userSpentNanos = db.prepare('SELECT cost_nanos FROM ai_monthly_usage WHERE uid = ? AND month = ?').get(user.id, month)?.cost_nanos || 0;
        const userReservedNanos = db.prepare('SELECT COALESCE(SUM(reserved_nanos), 0) AS n FROM ai_budget_reservations WHERE uid = ? AND month = ?').get(user.id, month).n;
        if (
          userCapNanos === 0 ||
          userSpentNanos >= userCapNanos ||
          userSpentNanos + userReservedNanos + reserveNanos > userCapNanos
        ) {
          refusal = { error: failure(429, 'ai_user_monthly_cap', budgetMessage('ai_user_monthly_cap', lang)), alertToFire: null };
        }
      }

      if (!refusal) {
        const used = db.prepare('SELECT n FROM ai_usage WHERE uid = ? AND day = ?').get(user.id,day)?.n || 0;
        const total = db.prepare('SELECT COALESCE(SUM(n),0) AS n FROM ai_usage WHERE day = ?').get(day).n;
        if (used >= perUser || total >= global) {
          refusal = { error: failure(429, 'rate_limited', budgetMessage('rate_limited', lang)), alertToFire: null };
        }
      }

      if (!refusal) {
        db.prepare('INSERT INTO ai_usage (uid,day,n) VALUES (?,?,1) ON CONFLICT(uid,day) DO UPDATE SET n=n+1').run(user.id,day);
        db.prepare('INSERT INTO ai_budget_reservations (id,uid,month,reserved_nanos,expires_at) VALUES (?,?,?,?,?)').run(reservationId, user.id, month, reserveNanos, expiresAt);
      }
      db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); throw e; }

    if (refusal) {
      if (refusal.alertToFire) await dispatchBudgetAlert(refusal.alertToFire);
      throw refusal.error;
    }

    const deadline = started + REQUEST_TIMEOUT_MS;
    const primaryDeadline = hasFallback ? deadline - FALLBACK_RESERVE_MS : deadline;
    const pseudonym = config.authSecret
      ? createHmac('sha256',config.authSecret).update('lean-ritual:ai-provider-user:v1:').update(user.id).digest('hex').slice(0,32)
      : undefined;

    let accPromptTok = 0;
    let accCompTok = 0;
    let accReasonTok = 0;
    let accCostNanos = 0;

    const recordAttemptUsage = (target, out) => {
      const attemptModel = target === 'gemini' ? configuredGeminiModel : configuredOrModel;
      const rate = resolveModelRate(pricing, target, attemptModel);
      const usage = out?.json?.usage;
      const pTok = nonNegInt(usage?.prompt_tokens);
      const cTok = nonNegInt(usage?.completion_tokens);
      const rTok = nonNegInt(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens);
      const tTok = nonNegInt(usage?.total_tokens);
      if (pTok > 0 || cTok > 0 || rTok > 0) {
        const { billedOutputTokens } = splitOutputTokens({
          promptTokens: pTok,
          completionTokens: cTok,
          reasoningTokens: rTok,
          totalTokens: tTok
        });
        accPromptTok += pTok;
        accCompTok += billedOutputTokens;
        accReasonTok += rTok;
        accCostNanos += calcUsageCostNanos(
          { promptTokens: pTok, completionTokens: cTok, reasoningTokens: rTok, totalTokens: tTok },
          rate
        );
      } else if (out?.res?.ok && !hasUpstreamError(out.json)) {
        const replyText = typeof out.json?.choices?.[0]?.message?.content === 'string'
          ? out.json.choices[0].message.content
          : '';
        const estP = estimatePromptTokens(messages, images);
        const estC = estimateTextTokens(replyText);
        accCostNanos += calcUsageCostNanos(
          { promptTokens: estP, completionTokens: estC, reasoningTokens: 0 },
          rate
        );
      } else if (out?.networkError && out?.sentRequest) {
        const estP = estimatePromptTokens(messages, images);
        accCostNanos += calcUsageCostNanos(
          { promptTokens: estP, completionTokens: 0, reasoningTokens: 0 },
          rate
        );
      }
    };

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
          return {res:undefined,json:undefined,networkError:true,sentRequest:false};
        }
        const signal = AbortSignal.timeout(remaining);
        let res;
        try {
          res = await fetcher(url, {
            method:'POST',headers,
            body:JSON.stringify(payload),redirect:'manual',signal
          });
        } catch {
          return {res:undefined,json:undefined,networkError:true,sentRequest:true};
        }
        let json = null;
        try {
          json = await res.json();
        } catch (err) {
          const bodyAborted = signal.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError' || now() >= targetDeadline;
          if (bodyAborted && res.ok) {
            return {res:undefined,json:undefined,networkError:true,sentRequest:true};
          }
          json = null;
        }
        return {res,json,networkError:false,sentRequest:true};
      };
      let jsonFallback = false;
      let out = await sendReq(wantJSON ? {...basePayload, response_format:{type:'json_object'}} : basePayload);
      recordAttemptUsage(target, out);
      if (!out.networkError && wantJSON && isResponseFormat400(out.res, out.json) && (targetDeadline - now()) >= MIN_ATTEMPT_BUDGET_MS) {
        jsonFallback = true;
        out = await sendReq(basePayload);
        recordAttemptUsage(target, out);
      }
      return {...out, jsonFallback};
    };
    let servedProvider = provider;
    let servedModel = provider === 'gemini' ? configuredGeminiModel : configuredOrModel;
    let providerFallback = false;
    let retries = 0;
    let response, result, fallback = false, finishReason = 'error';
    try {
      let attempt = await invokeProvider(provider, primaryDeadline);
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
        }
      }
      const failed = attempt.networkError || !attempt.res?.ok || hasUpstreamError(attempt.json);
      if (hasFallback && failed && shouldFallbackToOpenRouter(attempt) && (deadline - now()) >= MIN_ATTEMPT_BUDGET_MS) {
        providerFallback = true;
        servedProvider = 'openrouter';
        servedModel = configuredOrModel;
        attempt = await invokeProvider('openrouter', deadline);
      }
      ({res:response, json:result, jsonFallback:fallback} = attempt);
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
      const settledAt = new Date(now()).toISOString();
      let pendingAlert = null;
      try {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM ai_budget_reservations WHERE id = ?').run(reservationId);
          db.prepare(
            `INSERT INTO ai_monthly_usage (uid, month, calls, prompt_tokens, completion_tokens, reasoning_tokens, cost_nanos, updated)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?)
             ON CONFLICT(uid, month) DO UPDATE SET
               calls = calls + 1,
               prompt_tokens = prompt_tokens + excluded.prompt_tokens,
               completion_tokens = completion_tokens + excluded.completion_tokens,
               reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
               cost_nanos = cost_nanos + excluded.cost_nanos,
               updated = excluded.updated`
          ).run(user.id, month, accPromptTok, accCompTok, accReasonTok, accCostNanos, settledAt);
          db.prepare(
            `INSERT INTO ai_global_monthly_usage (month, calls, prompt_tokens, completion_tokens, reasoning_tokens, cost_nanos, updated)
             VALUES (?, 1, ?, ?, ?, ?, ?)
             ON CONFLICT(month) DO UPDATE SET
               calls = calls + 1,
               prompt_tokens = prompt_tokens + excluded.prompt_tokens,
               completion_tokens = completion_tokens + excluded.completion_tokens,
               reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
               cost_nanos = cost_nanos + excluded.cost_nanos,
               updated = excluded.updated`
          ).run(month, accPromptTok, accCompTok, accReasonTok, accCostNanos, settledAt);

          if (globalMonthlyNanos > 0) {
            const globalSpent = db.prepare('SELECT cost_nanos FROM ai_global_monthly_usage WHERE month = ?').get(month)?.cost_nanos || 0;
            if (globalSpent >= globalMonthlyNanos) {
              const claim = db.prepare(
                'INSERT OR IGNORE INTO ai_budget_alerts (month, threshold, sent_at, spend_nanos, cap_nanos) VALUES (?, 100, ?, ?, ?)'
              ).run(month, settledAt, globalSpent, globalMonthlyNanos);
              if (claim.changes === 1) {
                pendingAlert = { threshold: 100, month, spendNanos: globalSpent, capNanos: globalMonthlyNanos };
              }
            } else if (globalSpent * 5 >= globalMonthlyNanos * 4) {
              const claim = db.prepare(
                'INSERT OR IGNORE INTO ai_budget_alerts (month, threshold, sent_at, spend_nanos, cap_nanos) VALUES (?, 80, ?, ?, ?)'
              ).run(month, settledAt, globalSpent, globalMonthlyNanos);
              if (claim.changes === 1) {
                pendingAlert = { threshold: 80, month, spendNanos: globalSpent, capNanos: globalMonthlyNanos };
              }
            }
          }
          db.exec('COMMIT');
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      } catch (err) {
        alertLog(`ai budget settlement failed (${err?.code || err?.name || 'error'})`);
      }

      if (pendingAlert) {
        await dispatchBudgetAlert(pendingAlert);
      }

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
  return Object.assign(aiProxy, {
    provider,
    model: provider === 'gemini' ? geminiModel : orModel,
    enabled: Boolean(primaryKey),
    hasFallback,
    fallbackModel: orModel,
    pricing,
    budgets: { userMonthlyUsd, globalMonthlyUsd },
    getBudgetStatus,
    estimateReservationNanos
  });
}
module.exports = {createAIProxy, budgetMessage, estimateTextTokens, estimatePromptTokens};
