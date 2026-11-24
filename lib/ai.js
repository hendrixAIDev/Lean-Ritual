'use strict';
const {createHmac} = require('node:crypto');
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
const FALLBACK_RESERVE_MS = 30000;
const GEMINI_RETRY_BUDGET_MS = 15000;
const MIN_ATTEMPT_BUDGET_MS = 1000;
const FALLBACK_ERROR_STATUSES = new Set(['UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'INTERNAL', 'DEADLINE_EXCEEDED']);
const FALLBACK_ERROR_REASONS = new Set(['RATE_LIMIT_EXCEEDED', 'RESOURCE_EXHAUSTED']);
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
  async function aiProxy(user, body) {
    if (!primaryKey) throw failure(503,'sampling_disabled','服务器没有配置 AI');
    if (!body || !Array.isArray(body.messages) || !body.messages.length) throw failure(400,'bad_request','请提供消息');
    const wantJSON = body.json === true;
    const messages = body.messages.slice(-12).map(t => ({role:t?.role === 'assistant' ? 'assistant' : 'user',content:String(t?.content ?? '').slice(0,60000)}));
    const images = (Array.isArray(body.images) ? body.images : []).slice(0,4).filter(u=>typeof u === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(u));
    if (images.length) {
      const last = messages[messages.length-1];
      last.content = [{type:'text',text:last.content},...images.map(url=>({type:'image_url',image_url:{url}}))];
    }
    // Reserve before any await, atomically across connections. Failed attempts count:
    // a timeout does not prove that the upstream provider did not incur a charge.
    const day = new Date().toISOString().slice(0,10);
    db.exec('BEGIN IMMEDIATE');
    try {
      const used = db.prepare('SELECT n FROM ai_usage WHERE uid = ? AND day = ?').get(user.id,day)?.n || 0;
      const total = db.prepare('SELECT COALESCE(SUM(n),0) AS n FROM ai_usage WHERE day = ?').get(day).n;
      if (used >= perUser || total >= global) throw failure(429,'rate_limited','今天的 AI 使用次数已达上限，请手动填写或明天再试');
      db.prepare('INSERT INTO ai_usage (uid,day,n) VALUES (?,?,1) ON CONFLICT(uid,day) DO UPDATE SET n=n+1').run(user.id,day);
      db.exec('COMMIT');
    } catch(e) { db.exec('ROLLBACK'); throw e; }
    const now = typeof config.now === 'function' ? config.now : Date.now;
    const sleep = typeof config.sleep === 'function' ? config.sleep : defaultSleep;
    const retryDelays = Array.isArray(config.geminiRetryDelays) ? config.geminiRetryDelays : GEMINI_RETRY_DELAYS;
    const started = now();
    const deadline = started + REQUEST_TIMEOUT_MS;
    const primaryDeadline = hasFallback ? deadline - FALLBACK_RESERVE_MS : deadline;
    const pseudonym = config.authSecret
      ? createHmac('sha256',config.authSecret).update('lean-ritual:ai-provider-user:v1:').update(user.id).digest('hex').slice(0,32)
      : undefined;
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
        const signal = AbortSignal.timeout(remaining);
        let res;
        try {
          res = await fetcher(url, {
            method:'POST',headers,
            body:JSON.stringify(payload),redirect:'manual',signal
          });
        } catch {
          return {res:undefined,json:undefined,networkError:true};
        }
        let json = null;
        try {
          json = await res.json();
        } catch (err) {
          const bodyAborted = signal.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError' || now() >= targetDeadline;
          if (bodyAborted && res.ok) {
            return {res:undefined,json:undefined,networkError:true};
          }
          json = null;
        }
        return {res,json,networkError:false};
      };
      let jsonFallback = false;
      let out = await sendReq(wantJSON ? {...basePayload, response_format:{type:'json_object'}} : basePayload);
      if (!out.networkError && wantJSON && isResponseFormat400(out.res, out.json) && (targetDeadline - now()) >= MIN_ATTEMPT_BUDGET_MS) {
        jsonFallback = true;
        out = await sendReq(basePayload);
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
      const text = result?.choices?.[0]?.message?.content;
      const empty = !response?.ok || hasUpstreamError(result) || typeof text !== 'string' || !text.trim();
      const usage = result?.usage;
      const promptTok = nonNegInt(usage?.prompt_tokens);
      const compTok = nonNegInt(usage?.completion_tokens);
      const reasonTok = nonNegInt(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens);
      const ms = Math.max(0, Math.trunc(now() - started));
      (config.log || console.log)(`ai provider=${servedProvider}${providerFallback ? ' provider_fallback=true' : ''}${retries ? ` retries=${retries}` : ''} kind=${wantJSON ? 'json' : 'text'} images=${images.length} model=${servedModel} finish_reason=${finishReason} prompt=${promptTok} completion=${compTok} reasoning=${reasonTok} empty=${empty}${fallback ? ' fallback=true' : ''} ms=${ms}`);
    }
  }
  return Object.assign(aiProxy, {
    provider,
    model: provider === 'gemini' ? geminiModel : orModel,
    enabled: Boolean(primaryKey),
    hasFallback,
    fallbackModel: orModel
  });
}
module.exports = {createAIProxy};
