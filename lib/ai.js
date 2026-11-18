'use strict';
const {createHmac} = require('node:crypto');
function failure(status, code, message) { return Object.assign(new Error(message), {status,code}); }
function positiveLimit(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  return value;
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
const safeModel = (v, fallback = 'unknown') => typeof v === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/.test(v) ? v : fallback;
const safeReason = (v, fallback = 'none') => typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v) ? v : fallback;
const tokenCount = v => Number.isFinite(v) && v >= 0 ? String(Math.trunc(v)) : '-';
function createAIProxy(db, config, fetcher = fetch) {
  const perUser = positiveLimit(config.aiDaily, 'AI_DAILY_LIMIT', true);
  const global = positiveLimit(config.aiGlobalDaily, 'AI_GLOBAL_DAILY_LIMIT', true);
  const maxTokens = positiveLimit(config.aiMaxTokens, 'AI_MAX_OUTPUT_TOKENS');
  const effort = parseReasoningEffort(config.aiReasoningEffort);
  return async function aiProxy(user, body) {
    if (!config.orKey) throw failure(503,'sampling_disabled','服务器没有配置 AI');
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
    const basePayload = {
      model:config.orModel,
      messages,
      user:config.authSecret ? createHmac('sha256',config.authSecret).update('lean-ritual:ai-provider-user:v1:').update(user.id).digest('hex').slice(0,32) : undefined,
      max_tokens:maxTokens,
      ...(effort ? {reasoning:{effort}} : {})
    };
    const callUpstream = async payload => {
      let res;
      try {
        res = await fetcher(config.orBase + '/chat/completions', {
          method:'POST',headers:{Authorization:'Bearer '+config.orKey,'Content-Type':'application/json','X-Title':'Bojin Rike'},
          body:JSON.stringify(payload),signal:AbortSignal.timeout(120000)
        });
      } catch { throw failure(502,'ai_failed','AI 暂时无法连接，请稍后再试或手动填写'); }
      return {res, json:await res.json().catch(()=>null)};
    };
    const started = Date.now();
    let response, result, fallback = false, finishReason = 'fetch_error';
    try {
      ({res:response, json:result} = await callUpstream(wantJSON ? {...basePayload, response_format:{type:'json_object'}} : basePayload));
      if (wantJSON && (response.status === 400 || Number(result?.error?.code) === 400)) {
        fallback = true; response = undefined; result = undefined; finishReason = 'fetch_error';
        ({res:response, json:result} = await callUpstream(basePayload));
      }
      if (!response.ok || result?.error) {
        finishReason = Number.isInteger(response.status) ? `http_${response.status}` : 'provider_error';
        throw failure(response.status===429?429:502,response.status===429?'rate_limited':'ai_failed','AI 服务暂时不可用，请稍后再试或手动填写');
      }
      const choice = result?.choices?.[0];
      finishReason = safeReason(choice?.finish_reason, 'none');
      const text = choice?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw failure(502,'ai_failed','AI 没有返回结果，请稍后再试');
      return {text,truncated:choice.finish_reason==='length'};
    } finally {
      const text = result?.choices?.[0]?.message?.content;
      const empty = !response?.ok || !!result?.error || typeof text !== 'string' || !text.trim();
      const usage = result?.usage;
      const promptTok = usage ? tokenCount(usage.prompt_tokens ?? 0) : '-';
      const compTok = usage ? tokenCount(usage.completion_tokens ?? 0) : '-';
      const reasonTok = usage ? tokenCount(usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0) : '-';
      const model = safeModel(result?.model, safeModel(config.orModel));
      const ms = Math.max(0, Date.now() - started);
      (config.log || console.log)(`ai kind=${wantJSON ? 'json' : 'text'} images=${images.length} model=${model} finish_reason=${finishReason} prompt=${promptTok} completion=${compTok} reasoning=${reasonTok} empty=${empty}${fallback ? ' fallback=true' : ''} ms=${ms}`);
    }
  };
}
module.exports = {createAIProxy};
