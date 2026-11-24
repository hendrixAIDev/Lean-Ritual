'use strict';
const {createHmac} = require('node:crypto');
function failure(status, code, message) { return Object.assign(new Error(message), {status,code}); }
function positiveLimit(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  return value;
}
const PROVIDERS = new Set(['openrouter', 'gemini']);
const DEFAULT_OR_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_OR_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_RETRY_DELAYS = [400, 1000];
const REQUEST_TIMEOUT_MS = 120000;
const GEMINI_RETRY_BUDGET_MS = 15000;
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function parseProvider(value) {
  if (value === undefined || value === null) return 'openrouter';
  if (typeof value !== 'string') throw new Error('AI_PROVIDER must be openrouter or gemini');
  const trimmed = value.trim();
  if (!trimmed) return 'openrouter';
  if (!PROVIDERS.has(trimmed)) throw new Error('AI_PROVIDER must be openrouter or gemini');
  return trimmed;
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
const trimBase = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback).replace(/\/+$/, '');
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
function isTransientGeminiFailure(response, result) {
  if (!response) return false;
  if (isTransientStatus(response.status)) return true;
  if (response.ok) {
    const err = extractError(result);
    if (!err) return false;
    if (isTransientStatus(Number(err.code))) return true;
    const status = typeof err.status === 'string' ? err.status : '';
    if (/^(UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|DEADLINE_EXCEEDED)$/i.test(status)) return true;
  }
  return false;
}
function isRetryableProviderStatus(code) {
  return code === 401 || code === 402 || code === 403 || code === 429 || (code >= 500 && code <= 599);
}
function shouldFallbackToOpenRouter(response, result) {
  if (!response) return true;
  if (isRetryableProviderStatus(response.status)) return true;
  const err = extractError(result);
  if (!err) return false;
  if (response.ok) {
    if (isRetryableProviderStatus(Number(err.code))) return true;
    const status = typeof err.status === 'string' ? err.status : '';
    if (/^(UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|DEADLINE_EXCEEDED|UNAUTHENTICATED|PERMISSION_DENIED)$/i.test(status)) return true;
  }
  if (response.status === 400 || response.ok) {
    const reasons = Array.isArray(err.details)
      ? err.details.map(d => (typeof d?.reason === 'string' ? d.reason : '')).join(' ')
      : '';
    const detail = [
      typeof err.status === 'string' ? err.status : '',
      typeof err.code === 'string' ? err.code : '',
      typeof err.type === 'string' ? err.type : '',
      typeof err.message === 'string' ? err.message : '',
      reasons
    ].join(' ');
    if (/\b(API_KEY_INVALID|API_KEY_EXPIRED|API_KEY_NOT_FOUND|UNAUTHENTICATED|PERMISSION_DENIED|RESOURCE_EXHAUSTED|BILLING_DISABLED|QUOTA_EXCEEDED)\b/i.test(detail)) return true;
    if (/\b(api[\s_-]?key\s+(not\s+valid|invalid|expired|missing)|billing\s+(not\s+enabled|disabled|required|account)|credits?\s+(exhausted|depleted|insufficient)|quota\s+(exceeded|exhausted|limit))\b/i.test(detail)) return true;
  }
  return false;
}
function createAIProxy(db, config, fetcher = fetch) {
  const provider = parseProvider(config.aiProvider);
  const perUser = positiveLimit(config.aiDaily, 'AI_DAILY_LIMIT', true);
  const global = positiveLimit(config.aiGlobalDaily, 'AI_GLOBAL_DAILY_LIMIT', true);
  const maxTokens = positiveLimit(config.aiMaxTokens, 'AI_MAX_OUTPUT_TOKENS');
  const effort = parseReasoningEffort(config.aiReasoningEffort);
  const orKey = trimKey(config.orKey);
  const orBase = trimBase(config.orBase, DEFAULT_OR_BASE);
  const orModel = trimModel(config.orModel, DEFAULT_OR_MODEL);
  const geminiKey = trimKey(config.geminiKey);
  const geminiBase = trimBase(config.geminiBase, DEFAULT_GEMINI_BASE);
  const geminiModel = trimModel(config.geminiModel, DEFAULT_GEMINI_MODEL);
  const configuredOrModel = safeConfiguredModel(orModel);
  const configuredGeminiModel = safeConfiguredModel(geminiModel);
  const primaryKey = provider === 'gemini' ? geminiKey : orKey;
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
    const sleep = typeof config.sleep === 'function' ? config.sleep : defaultSleep;
    const retryDelays = Array.isArray(config.geminiRetryDelays) ? config.geminiRetryDelays : GEMINI_RETRY_DELAYS;
    const started = Date.now();
    const deadline = started + REQUEST_TIMEOUT_MS;
    const remainingTimeout = () => Math.max(1000, deadline - Date.now());
    const pseudonym = config.authSecret
      ? createHmac('sha256',config.authSecret).update('lean-ritual:ai-provider-user:v1:').update(user.id).digest('hex').slice(0,32)
      : undefined;
    const invokeProvider = async target => {
      const isGemini = target === 'gemini';
      const url = (isGemini ? geminiBase : orBase) + '/chat/completions';
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
        let res;
        try {
          res = await fetcher(url, {
            method:'POST',headers,
            body:JSON.stringify(payload),signal:AbortSignal.timeout(remainingTimeout())
          });
        } catch {
          return {res:undefined,json:undefined,networkError:true};
        }
        return {res,json:await res.json().catch(()=>null),networkError:false};
      };
      let jsonFallback = false;
      let out = await sendReq(wantJSON ? {...basePayload, response_format:{type:'json_object'}} : basePayload);
      if (!out.networkError && wantJSON && isResponseFormat400(out.res, out.json)) {
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
      let attempt = await invokeProvider(provider);
      if (provider === 'gemini') {
        while (
          retries < retryDelays.length &&
          !attempt.networkError &&
          (!attempt.res?.ok || hasUpstreamError(attempt.json)) &&
          isTransientGeminiFailure(attempt.res, attempt.json) &&
          (Date.now() - started) < GEMINI_RETRY_BUDGET_MS
        ) {
          const delay = retryDelays[retries];
          if (delay > 0) await sleep(delay);
          retries++;
          attempt = await invokeProvider('gemini');
        }
      }
      const failed = attempt.networkError || !attempt.res?.ok || hasUpstreamError(attempt.json);
      if (provider === 'gemini' && orKey && failed && shouldFallbackToOpenRouter(attempt.res, attempt.json)) {
        providerFallback = true;
        servedProvider = 'openrouter';
        servedModel = configuredOrModel;
        attempt = await invokeProvider('openrouter');
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
      const ms = Math.max(0, Math.trunc(Date.now() - started));
      (config.log || console.log)(`ai provider=${servedProvider}${providerFallback ? ' provider_fallback=true' : ''}${retries ? ` retries=${retries}` : ''} kind=${wantJSON ? 'json' : 'text'} images=${images.length} model=${servedModel} finish_reason=${finishReason} prompt=${promptTok} completion=${compTok} reasoning=${reasonTok} empty=${empty}${fallback ? ' fallback=true' : ''} ms=${ms}`);
    }
  }
  return Object.assign(aiProxy, {
    provider,
    model: provider === 'gemini' ? geminiModel : orModel,
    enabled: Boolean(primaryKey),
    hasFallback: provider === 'gemini' && Boolean(geminiKey) && Boolean(orKey),
    fallbackModel: orModel
  });
}
module.exports = {createAIProxy};
