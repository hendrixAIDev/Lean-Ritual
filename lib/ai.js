'use strict';
function failure(status, code, message) { return Object.assign(new Error(message), {status,code}); }
function positiveLimit(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  return value;
}
function createAIProxy(db, config, fetcher = fetch) {
  const perUser = positiveLimit(config.aiDaily, 'AI_DAILY_LIMIT', true);
  const global = positiveLimit(config.aiGlobalDaily, 'AI_GLOBAL_DAILY_LIMIT', true);
  const maxTokens = positiveLimit(config.aiMaxTokens, 'AI_MAX_OUTPUT_TOKENS');
  return async function aiProxy(user, body) {
    if (!config.orKey) throw failure(503,'sampling_disabled','服务器没有配置 AI');
    if (!body || !Array.isArray(body.messages) || !body.messages.length) throw failure(400,'bad_request','请提供消息');
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
    let response;
    try {
      response = await fetcher(config.orBase + '/chat/completions', {
        method:'POST',headers:{Authorization:'Bearer '+config.orKey,'Content-Type':'application/json','X-Title':'Bojin Rike'},
        body:JSON.stringify({model:config.orModel,messages,user:user.id,max_tokens:maxTokens}),signal:AbortSignal.timeout(120000)
      });
    } catch { throw failure(502,'ai_failed','AI 暂时无法连接，请稍后再试或手动填写'); }
    const result = await response.json().catch(()=>null);
    if (!response.ok || result?.error) throw failure(response.status===429?429:502,response.status===429?'rate_limited':'ai_failed','AI 服务暂时不可用，请稍后再试或手动填写');
    const text = result?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw failure(502,'ai_failed','AI 没有返回结果，请稍后再试');
    return {text,truncated:result.choices[0].finish_reason==='length'};
  };
}
module.exports = {createAIProxy};
