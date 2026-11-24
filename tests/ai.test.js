'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const {createAIProxy}=require('../lib/ai');
function fixture(overrides={},fetcher=async()=>({ok:true,json:async()=>({choices:[{message:{content:'ok'}}]})})) {
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_usage(uid TEXT,day TEXT,n INTEGER,PRIMARY KEY(uid,day))');
 const proxy=createAIProxy(db,{aiDaily:2,aiGlobalDaily:3,aiMaxTokens:100,orKey:'test-only',orBase:'https://openrouter.ai/api/v1',orModel:'test',...overrides},fetcher);
 return {db,proxy};
}
const body={messages:[{content:'test'}]};
test('concurrent requests respect both user and global limits',async()=>{
 const {db,proxy}=fixture();try{
 const results=await Promise.allSettled(['a','a','a','b','c'].map(id=>proxy({id},body)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,3);
 assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.status===429).length,2);
 assert.equal(db.prepare('SELECT SUM(n) n FROM ai_usage').get().n,3);
 }finally{db.close();}
});
test('failed provider requests count toward budget and redact upstream errors',async()=>{
 const {db,proxy}=fixture({},async()=>{throw new Error('secret-provider-details')});try{
 await assert.rejects(proxy({id:'a'},body),e=>e.code==='ai_failed'&&!e.message.includes('secret'));
 assert.equal(db.prepare('SELECT n FROM ai_usage').get().n,1);
 }finally{db.close();}
});
test('invalid requests do not consume quota; output token cap is enforced',async()=>{
 let sent;const {db,proxy}=fixture({},async(u,o)=>{sent=JSON.parse(o.body);return {ok:true,json:async()=>({choices:[{message:{content:'ok'}}]})};});try{
 await assert.rejects(proxy({id:'a'},null),e=>e.status===400);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage').get().n,0);
 await proxy({id:'a'},body);assert.equal(sent.max_tokens,100);
 }finally{db.close();}
});
test('zero global quota disables AI without disabling application storage',async()=>{
 const {db,proxy}=fixture({aiGlobalDaily:0});try{await assert.rejects(proxy({id:'a'},body),e=>e.status===429);assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage').get().n,0);}finally{db.close();}
});
test('provider user IDs are stable pseudonyms and never expose account IDs',async()=>{
 const sent=[];const {db,proxy}=fixture({authSecret:'test-server-secret'},async(u,o)=>{sent.push(JSON.parse(o.body));return {ok:true,json:async()=>({choices:[{message:{content:'ok'}}]})};});try{
 const first='internal-account-alice',second='internal-account-bob';
 await proxy({id:first},body);await proxy({id:first},body);await proxy({id:second},body);
 assert.equal(sent[0].user,sent[1].user);assert.notEqual(sent[0].user,sent[2].user);
 for(const request of sent){assert.match(request.user,/^[a-f0-9]{32}$/);assert.ok(!JSON.stringify(request).includes(first));assert.ok(!JSON.stringify(request).includes(second));}
 }finally{db.close();}
});
test('provider user field is omitted without a server secret',async()=>{
 let sent;const {db,proxy}=fixture({},async(u,o)=>{sent=JSON.parse(o.body);return {ok:true,json:async()=>({choices:[{message:{content:'ok'}}]})};});try{
 await proxy({id:'internal-account-alice'},body);assert.equal(Object.hasOwn(sent,'user'),false);
 }finally{db.close();}
});

test('response_format is sent only when caller explicitly requests JSON',async()=>{
 const sent=[];
 const {db,proxy}=fixture({aiDaily:10,aiGlobalDaily:10},async(u,o)=>{sent.push(JSON.parse(o.body));return {ok:true,status:200,json:async()=>({choices:[{message:{content:'{"ok":1}'},finish_reason:'stop'}]})};});
 try{
  await proxy({id:'a'},{messages:[{content:'plain text'}]});
  await proxy({id:'a'},{messages:[{content:'explicit false'}],json:false});
  await proxy({id:'a'},{messages:[{content:'json call'}],json:true});
  assert.equal(Object.hasOwn(sent[0],'response_format'),false);
  assert.equal(Object.hasOwn(sent[1],'response_format'),false);
  assert.deepEqual(sent[2].response_format,{type:'json_object'});
 }finally{db.close();}
});

test('JSON mode retries once without response_format when provider rejects response_format with 400',async()=>{
 const sent=[];
 const {db,proxy}=fixture({aiDaily:10,aiGlobalDaily:10,aiReasoningEffort:'low'},async(u,o)=>{
  const req=JSON.parse(o.body);sent.push(req);
  if(sent.length===1)return {ok:false,status:400,json:async()=>({error:{code:400,message:'Provider returned error',metadata:{raw:'{"error":{"message":"Invalid parameter: response_format json_object is not supported"}}'}}})};
  return {ok:true,status:200,json:async()=>({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20}})};
 });
 try{
  const res=await proxy({id:'a'},{messages:[{content:'json please'}],json:true});
  assert.deepEqual(res,{text:'{"ok":true}',truncated:false});
  assert.equal(sent.length,2);
  assert.deepEqual(sent[0].response_format,{type:'json_object'});
  assert.equal(Object.hasOwn(sent[1],'response_format'),false);
  assert.deepEqual(sent[1].reasoning,{effort:'low'});
  assert.equal(db.prepare('SELECT n FROM ai_usage WHERE uid=?').get('a').n,1);
 }finally{db.close();}
});

test('retry never runs for unrelated 400s, HTTP-200 error envelopes, text calls, non-400s, or more than once',async()=>{
 for(const unrelated of [
  {ok:false,status:400,body:{error:{code:400,message:'Bad Request'}}},
  {ok:false,status:400,body:{error:{code:400,message:'Invalid image data'}}},
  {ok:false,status:400,body:{error:{code:400,message:'maximum context length exceeded'}}},
  {ok:true,status:200,body:{error:{code:400,message:'response_format unsupported'}}},
  {ok:false,status:502,body:{error:{code:502,message:'response_format upstream error'}}}
 ]){
  let calls=0;
  const {db,proxy}=fixture({aiDaily:10,aiGlobalDaily:10},async()=>{calls++;return {ok:unrelated.ok,status:unrelated.status,json:async()=>unrelated.body};});
  try{
   await assert.rejects(proxy({id:'a'},{messages:[{content:'json call'}],json:true}),e=>e.code==='ai_failed');
   assert.equal(calls,1,`unexpected retry for ${JSON.stringify(unrelated)}`);
   assert.equal(db.prepare('SELECT n FROM ai_usage WHERE uid=?').get('a').n,1);
  }finally{db.close();}
 }
 let textCalls=0;
 const fText=fixture({aiDaily:10,aiGlobalDaily:10},async()=>{textCalls++;return {ok:false,status:400,json:async()=>({error:{code:400,message:'response_format is not supported'}})};});
 try{
  await assert.rejects(fText.proxy({id:'a'},{messages:[{content:'text call'}]}),e=>e.code==='ai_failed');
  assert.equal(textCalls,1);
 }finally{fText.db.close();}

 let repeatCalls=0;
 const fRepeat=fixture({aiDaily:10,aiGlobalDaily:10},async()=>{repeatCalls++;return {ok:false,status:400,json:async()=>({error:{code:400,message:'response_format is not supported'}})};});
 try{
  await assert.rejects(fRepeat.proxy({id:'a'},{messages:[{content:'json call'}],json:true}),e=>e.code==='ai_failed');
  assert.equal(repeatCalls,2);
  assert.equal(fRepeat.db.prepare('SELECT n FROM ai_usage WHERE uid=?').get('a').n,1);
 }finally{fRepeat.db.close();}
});

test('AI_REASONING_EFFORT validates at startup and passes reasoning.effort only when set',async()=>{
 for(const bad of ['minimal','LOW','none','invalid',123]){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_usage(uid TEXT,day TEXT,n INTEGER,PRIMARY KEY(uid,day))');
  try{assert.throws(()=>createAIProxy(db,{aiDaily:2,aiGlobalDaily:3,aiMaxTokens:100,orKey:'k',orBase:'https://openrouter.ai/api/v1',orModel:'test',aiReasoningEffort:bad}),/AI_REASONING_EFFORT/);}
  finally{db.close();}
 }
 for(const empty of [undefined,'','   ']){
  let sent;const {db,proxy}=fixture({aiReasoningEffort:empty},async(u,o)=>{sent=JSON.parse(o.body);return {ok:true,json:async()=>({choices:[{message:{content:'ok'}}]})};});
  try{await proxy({id:'a'},body);assert.equal(Object.hasOwn(sent,'reasoning'),false);}finally{db.close();}
 }
 for(const effort of ['low','medium','high']){
  let sent;const {db,proxy}=fixture({aiReasoningEffort:effort},async(u,o)=>{sent=JSON.parse(o.body);return {ok:true,json:async()=>({choices:[{message:{content:'ok'}}]})};});
  try{await proxy({id:'a'},body);assert.deepEqual(sent.reasoning,{effort});}finally{db.close();}
 }
 const {spawnSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-ai-env-'));
 try{
  const r=spawnSync(process.execPath,['server.js'],{env:{...process.env,DATA_DIR:dir,AI_REASONING_EFFORT:'bogus'},encoding:'utf8',timeout:5000});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/AI_REASONING_EFFORT/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('diagnostic log uses configured model, allowlisted finish_reason, numeric counters, and never logs personal markers even when echoed in model or finish_reason',async()=>{
 const logs=[];
 const origLog=console.log,origErr=console.error;
 console.log=(...a)=>logs.push(a.join(' '));
 console.error=(...a)=>logs.push(a.join(' '));
 const markers={
  uid:'PLANTED_UID_MARKER_9911',
  secret:'PLANTED_AUTH_SECRET_3377',
  prompt:'PLANTED_PROMPT_MARKER_8822',
  history:'PLANTED_HISTORY_MARKER_7733',
  image:'PLANTEDIMAGEMARKER6644',
  response:'PLANTED_RESPONSE_MARKER_5555',
  errMsg:'PLANTED_UPSTREAM_ERR_MARKER_4466'
 };
 let pseudonym='',step=0;
 const {db,proxy}=fixture({aiDaily:10,aiGlobalDaily:10,authSecret:markers.secret,orModel:'google/gemini-3.8-flash'},async(u,o)=>{
  const req=JSON.parse(o.body);pseudonym=req.user;step++;
  if(step===1)return {
   ok:true,status:200,
   json:async()=>({
    model:`${markers.prompt}/${markers.uid}/${pseudonym}`,
    choices:[{message:{content:`{"note":"${markers.response}"}`},finish_reason:pseudonym}],
    usage:{prompt_tokens:321,completion_tokens:1234,completion_tokens_details:{reasoning_tokens:789}}
   })
  };
  if(step===2)return {
   ok:true,status:200,
   json:async()=>({
    model:markers.response,
    choices:[{message:{content:'ok'},finish_reason:'content_filter'}],
    usage:{prompt_tokens:11,completion_tokens:22,completion_tokens_details:{reasoning_tokens:0}}
   })
  };
  if(step===3)return {
   ok:true,status:200,
   json:async()=>({
    model:markers.history,
    choices:[{message:{content:'ok'},finish_reason:'tool_calls'}],
    usage:{prompt_tokens:5,completion_tokens:6}
   })
  };
  if(step===4)return {
   ok:true,status:200,
   json:async()=>({
    model:markers.uid,
    choices:[{message:{content:'   '},finish_reason:'stop'}],
    usage:{prompt_tokens:501,completion_tokens:12,completion_tokens_details:{reasoning_tokens:12}}
   })
  };
  return {ok:false,status:502,json:async()=>({model:markers.prompt,choices:[{finish_reason:markers.errMsg}],error:{message:markers.errMsg}})};
 });
 try{
  await proxy({id:markers.uid},{
   json:true,
   messages:[{role:'assistant',content:markers.history},{role:'user',content:markers.prompt}],
   images:[`data:image/jpeg;base64,${markers.image}==`]
  });
  assert.equal(logs.length,1);
  assert.equal(logs[0].includes('\n'),false);
  assert.match(logs[0],/\bprovider=openrouter\b/);
  assert.match(logs[0],/\bkind=json\b/);
  assert.match(logs[0],/\bimages=1\b/);
  assert.match(logs[0],/\bmodel=google\/gemini-3\.8-flash\b/);
  assert.match(logs[0],/\bfinish_reason=other\b/);
  assert.match(logs[0],/\bprompt=321\b/);
  assert.match(logs[0],/\bcompletion=1234\b/);
  assert.match(logs[0],/\breasoning=789\b/);
  assert.match(logs[0],/\bempty=false\b/);
  assert.match(logs[0],/\bms=\d+\b/);

  await proxy({id:markers.uid},{messages:[{content:markers.prompt}]});
  assert.equal(logs.length,2);
  assert.match(logs[1],/\bmodel=google\/gemini-3\.8-flash\b/);
  assert.match(logs[1],/\bfinish_reason=content_filter\b/);

  await proxy({id:markers.uid},{messages:[{content:markers.prompt}]});
  assert.equal(logs.length,3);
  assert.match(logs[2],/\bfinish_reason=tool_calls\b/);

  await assert.rejects(proxy({id:markers.uid},{messages:[{content:markers.prompt}]}),e=>e.code==='ai_failed');
  assert.equal(logs.length,4);
  assert.match(logs[3],/\bkind=text\b/);
  assert.match(logs[3],/\bimages=0\b/);
  assert.match(logs[3],/\bfinish_reason=stop\b/);
  assert.match(logs[3],/\bprompt=501\b/);
  assert.match(logs[3],/\bcompletion=12\b/);
  assert.match(logs[3],/\breasoning=12\b/);
  assert.match(logs[3],/\bempty=true\b/);

  await assert.rejects(proxy({id:markers.uid},{messages:[{content:markers.prompt}]}),e=>e.code==='ai_failed');
  assert.equal(logs.length,5);
  assert.match(logs[4],/\bfinish_reason=error\b/);
  assert.match(logs[4],/\bprompt=0\b/);
  assert.match(logs[4],/\bcompletion=0\b/);
  assert.match(logs[4],/\breasoning=0\b/);
  assert.match(logs[4],/\bempty=true\b/);

  const combined=logs.join('\n');
  for(const m of [...Object.values(markers),pseudonym]){
   assert.ok(m&&!combined.includes(m),`log leaked marker: ${m}`);
  }
 }finally{
  console.log=origLog;console.error=origErr;db.close();
 }
});

test('length-truncated responses with empty content surface dedicated truncation error end-to-end',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const shimSrc=fs.readFileSync(path.join(__dirname,'../public/shim.js'),'utf8');
 const htmlSrc=fs.readFileSync(path.join(__dirname,'../app/index.html'),'utf8');
 const appScript=htmlSrc.match(/<script>([\s\S]*?)<\/script>/)[1].split('/* ============ 启动 ============ */')[0];
 const appCtx=vm.createContext({window:{ritual:{hosted:true}},document:{addEventListener(){},querySelector(){return {innerHTML:''};}},localStorage:{getItem:()=>null,setItem(){}},console,URL,Date,setTimeout,clearTimeout});
 vm.runInContext(appScript,appCtx);
 const sampleErr=e=>appCtx.sampleErr(e);

 let upstream={choices:[{message:{content:''},finish_reason:'length'}],usage:{prompt_tokens:800,completion_tokens:6000,completion_tokens_details:{reasoning_tokens:6000}}};
 const logs=[];
 const {db,proxy}=fixture({aiDaily:10,aiGlobalDaily:10,log:l=>logs.push(l)},async()=>({ok:true,status:200,json:async()=>upstream}));
 try{
  const ctx=vm.createContext({window:{},location:{},URLSearchParams,fetch:async(url,options)=>{
   if(url==='/api/me')return {ok:true,status:200,json:async()=>({id:'alice',ai:true})};
   try{
    const res=await proxy({id:'alice'},JSON.parse(options.body));
    return {ok:true,status:200,json:async()=>res};
   }catch(e){
    return {ok:false,status:e.status||500,json:async()=>({error:e.code||'server_error',message:e.message})};
   }
  }});
  vm.runInContext(shimSrc,ctx);
  const sample=await ctx.window.ritual.use('sample');

  for(const emptyContent of ['','   ',null]){
   upstream={choices:[{message:{content:emptyContent},finish_reason:'length'}],usage:{prompt_tokens:800,completion_tokens:6000,completion_tokens_details:{reasoning_tokens:6000}}};
   let err;
   await assert.rejects(sample.json('feedback'),e=>{err=e;return e.code==='truncated';});
   assert.equal(sampleErr(err),'AI 的回答太长被截断了，请再试一次或缩短反馈。');
   assert.equal(sampleErr(err).replace('估算','分析'),'AI 的回答太长被截断了，请再试一次或缩短反馈。');
  }
  assert.match(logs[0],/\bfinish_reason=length\b/);
  assert.match(logs[0],/\bcompletion=6000\b/);
  assert.match(logs[0],/\breasoning=6000\b/);
  assert.match(logs[0],/\bempty=true\b/);

  upstream={choices:[{message:{content:'   '},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:5}};
  let nonTruncErr;
  await assert.rejects(sample.json('feedback'),e=>{nonTruncErr=e;return e.code==='ai_failed';});
  assert.notEqual(sampleErr(nonTruncErr),'AI 的回答太长被截断了，请再试一次或缩短反馈。');
 }finally{db.close();}
});

test('shim sample.json requests JSON mode, distinguishes truncated from invalid_json, and tolerates safe wrappers',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const shimSrc=fs.readFileSync(path.join(__dirname,'../public/shim.js'),'utf8');
 const htmlSrc=fs.readFileSync(path.join(__dirname,'../app/index.html'),'utf8');
 const appScript=htmlSrc.match(/<script>([\s\S]*?)<\/script>/)[1].split('/* ============ 启动 ============ */')[0];
 const appCtx=vm.createContext({window:{ritual:{hosted:true}},document:{addEventListener(){},querySelector(){return {innerHTML:''};}},localStorage:{getItem:()=>null,setItem(){}},console,URL,Date,setTimeout,clearTimeout});
 vm.runInContext(appScript,appCtx);
 const sampleErr=e=>appCtx.sampleErr(e);

 const posted=[];
 let reply={text:'{"kcal":500}',truncated:false};
 const ctx=vm.createContext({window:{},location:{},URLSearchParams,fetch:async(url,options)=>{
  if(url==='/api/me')return {ok:true,status:200,json:async()=>({id:'alice',ai:true})};
  posted.push(JSON.parse(options.body));
  return {ok:true,status:200,json:async()=>reply};
 }});
 vm.runInContext(shimSrc,ctx);
 const sample=await ctx.window.ritual.use('sample');

 reply={text:'plain reply',truncated:false};
 assert.equal((await sample('hello')).text,'plain reply');
 assert.equal(Object.hasOwn(posted[0],'json'),false);

 reply={text:'\uFEFF  \n {"kcal":420} \t ',truncated:false};
 assert.deepEqual(JSON.parse(JSON.stringify(await sample.json('meal'))),{kcal:420});
 assert.equal(posted[1].json,true);

 reply={text:'说明 [1]：\n```JSON\n{"kcal":610,"items":[{"name":"鸡胸"}]}\n```\n附注 [2]',truncated:false};
 assert.deepEqual(JSON.parse(JSON.stringify(await sample.json('meal'))),{kcal:610,items:[{name:'鸡胸'}]});

 reply={text:'[提示] {"kcal":330} [完]',truncated:false};
 assert.deepEqual(JSON.parse(JSON.stringify(await sample.json('meal'))),{kcal:330});

 reply={text:'{"summary":"回答一半被截断',truncated:true};
 let truncErr;
 await assert.rejects(sample.json('feedback'),e=>{truncErr=e;return e.code==='truncated';});
 assert.equal(sampleErr(truncErr),'AI 的回答太长被截断了，请再试一次或缩短反馈。');
 assert.equal(sampleErr(truncErr).replace('估算','分析'),'AI 的回答太长被截断了，请再试一次或缩短反馈。');

 reply={text:'抱歉，我无法按格式回答。',truncated:false};
 let fmtErr;
 await assert.rejects(sample.json('feedback'),e=>{fmtErr=e;return e.code==='invalid_json';});
 assert.equal(sampleErr(fmtErr),'AI 的回答格式不对，再点一次试试。');

 for(const unsafe of ['({a:1})','{"a":1,}','1+1']){
  reply={text:unsafe,truncated:false};
  await assert.rejects(sample.json('unsafe'),e=>e.code==='invalid_json');
 }
});

test('AI_PROVIDER validates at startup, defaults to openrouter, and requires the active provider key',async()=>{
 for(const bad of ['openai','GEMINI','vertex','google',123]){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_usage(uid TEXT,day TEXT,n INTEGER,PRIMARY KEY(uid,day))');
  try{assert.throws(()=>createAIProxy(db,{aiDaily:2,aiGlobalDaily:3,aiMaxTokens:100,aiProvider:bad}),/AI_PROVIDER/);}
  finally{db.close();}
 }
 for(const empty of [undefined,'','   ']){
  const {db,proxy}=fixture({aiProvider:empty});
  try{
   assert.equal(proxy.provider,'openrouter');
   assert.equal(proxy.enabled,true);
  }finally{db.close();}
 }
 // AI_PROVIDER=gemini without GEMINI_API_KEY fails closed (503) and does not silently fall back to OpenRouter.
 let called=0;
 const {db,proxy}=fixture({aiProvider:'gemini',geminiKey:'',orKey:'backup-key'},async()=>{called++;return {ok:true,status:200,json:async()=>({choices:[{message:{content:'ok'}}]})};});
 try{
  assert.equal(proxy.provider,'gemini');
  assert.equal(proxy.model,'gemini-3.8-flash');
  assert.equal(proxy.enabled,false);
  assert.equal(proxy.hasFallback,false);
  await assert.rejects(proxy({id:'a'},body),e=>e.status===503&&e.code==='sampling_disabled');
  assert.equal(called,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage').get().n,0);
 }finally{db.close();}

 const {spawnSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-ai-provider-'));
 try{
  const r=spawnSync(process.execPath,['server.js'],{env:{...process.env,DATA_DIR:dir,AI_PROVIDER:'bogus'},encoding:'utf8',timeout:5000});
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/AI_PROVIDER/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Gemini direct provider sends expected payload, headers, images, reasoning_effort, JSON mode, and diagnostics without leaking user ID or keys',async()=>{
 const calls=[],logs=[];
 const geminiKey='PLANTED_GEMINI_KEY_1111';
 const orKey='PLANTED_OPENROUTER_KEY_2222';
 const authSecret='PLANTED_AUTH_SECRET_3333';
 const uid='PLANTED_UID_4444';
 const prompt='PLANTED_PROMPT_5555';
 const {db,proxy}=fixture({
  aiProvider:'gemini',
  geminiKey,
  orKey,
  authSecret,
  aiDaily:10,
  aiGlobalDaily:10,
  aiMaxTokens:2000,
  aiReasoningEffort:'low',
  log:l=>logs.push(l)
 },async(url,opts)=>{
  calls.push({url,headers:opts.headers,body:JSON.parse(opts.body)});
  return {
   ok:true,status:200,
   json:async()=>({
    model:`${geminiKey}/${uid}`,
    choices:[{message:{content:'{"kcal":420}'},finish_reason:'stop'}],
    usage:{prompt_tokens:120,completion_tokens:85,completion_tokens_details:{reasoning_tokens:0}}
   })
  };
 });
 try{
  assert.equal(proxy.provider,'gemini');
  assert.equal(proxy.model,'gemini-3.8-flash');
  assert.equal(proxy.enabled,true);
  assert.equal(proxy.hasFallback,true);
  const res=await proxy({id:uid},{
   json:true,
   messages:[{role:'user',content:prompt}],
   images:['data:image/jpeg;base64,AAAA']
  });
  assert.deepEqual(res,{text:'{"kcal":420}',truncated:false});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(calls[0].headers.Authorization,'Bearer '+geminiKey);
  assert.equal(Object.hasOwn(calls[0].headers,'X-Title'),false);
  assert.equal(calls[0].body.model,'gemini-3.8-flash');
  assert.equal(calls[0].body.max_tokens,2000);
  assert.equal(calls[0].body.reasoning_effort,'low');
  assert.equal(Object.hasOwn(calls[0].body,'reasoning'),false);
  assert.equal(Object.hasOwn(calls[0].body,'user'),false);
  assert.deepEqual(calls[0].body.response_format,{type:'json_object'});
  assert.deepEqual(calls[0].body.messages[0].content,[
   {type:'text',text:prompt},
   {type:'image_url',image_url:{url:'data:image/jpeg;base64,AAAA'}}
  ]);
  assert.equal(logs.length,1);
  assert.match(logs[0],/\bprovider=gemini\b/);
  assert.doesNotMatch(logs[0],/\bprovider_fallback=true\b/);
  assert.match(logs[0],/\bkind=json\b/);
  assert.match(logs[0],/\bimages=1\b/);
  assert.match(logs[0],/\bmodel=gemini-3\.8-flash\b/);
  assert.match(logs[0],/\bfinish_reason=stop\b/);
  assert.match(logs[0],/\bprompt=120\b/);
  assert.match(logs[0],/\bcompletion=85\b/);
  assert.match(logs[0],/\breasoning=0\b/);
  assert.match(logs[0],/\bempty=false\b/);
  for(const secret of [geminiKey,orKey,authSecret,uid,prompt]){
   assert.ok(!logs[0].includes(secret),`log leaked ${secret}`);
  }
 }finally{db.close();}
});

test('provider base URLs enforce exact official HTTPS origins, reject misrouted hosts, and disable redirects',async()=>{
 const badOrBases=[
  'http://openrouter.ai/api/v1',
  'https://example.invalid/v1',
  'https://openrouter.ai.evil.example/api/v1',
  'https://generativelanguage.googleapis.com/v1beta/openai',
  'https://user:pass@openrouter.ai/api/v1',
  'https://openrouter.ai/api/v1?x=1',
  'https://openrouter.ai/api/v1#frag',
  'http://127.0.0.1:18080/v1',
  'not-a-url'
 ];
 for(const bad of badOrBases){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_usage(uid TEXT,day TEXT,n INTEGER,PRIMARY KEY(uid,day))');
  try{assert.throws(()=>createAIProxy(db,{aiDaily:2,aiGlobalDaily:3,aiMaxTokens:100,orKey:'k',orBase:bad}),/OPENROUTER_BASE/,bad);}
  finally{db.close();}
 }
 const badGeminiBases=[
  'http://generativelanguage.googleapis.com/v1beta/openai',
  'https://example.invalid/v1beta/openai',
  'https://generativelanguage.googleapis.com.evil.example/v1beta/openai',
  'https://openrouter.ai/api/v1',
  'https://user:pass@generativelanguage.googleapis.com/v1beta/openai',
  'https://generativelanguage.googleapis.com/v1beta/openai?key=leak',
  'https://generativelanguage.googleapis.com/v1beta/openai#frag',
  'http://127.0.0.1:18080/gemini',
  'not-a-url'
 ];
 for(const bad of badGeminiBases){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_usage(uid TEXT,day TEXT,n INTEGER,PRIMARY KEY(uid,day))');
  try{assert.throws(()=>createAIProxy(db,{aiDaily:2,aiGlobalDaily:3,aiMaxTokens:100,aiProvider:'gemini',geminiKey:'k',geminiBase:bad}),/GEMINI_BASE/,bad);}
  finally{db.close();}
 }
 // Server refuses loopback/foreign overrides whenever not in explicit localhost file-mail dev mode
 const {spawnSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-ai-base-'));
 try{
  const r1=spawnSync(process.execPath,['server.js'],{
   env:{...process.env,DATA_DIR:dir,AUTH_BASE_URL:'https://leanritual.app',COOKIE_SECURE:'1',MAIL_MODE:'smtp',GEMINI_BASE:'http://127.0.0.1:18080/gemini'},
   encoding:'utf8',timeout:5000
  });
  assert.notEqual(r1.status,0);
  assert.match(r1.stderr,/GEMINI_BASE/);
  const r2=spawnSync(process.execPath,['server.js'],{
   env:{...process.env,DATA_DIR:dir,AUTH_BASE_URL:'http://127.0.0.1:18080',COOKIE_SECURE:'0',TRUST_PROXY:'0',MAIL_MODE:'file',OPENROUTER_BASE:'https://generativelanguage.googleapis.com/v1beta/openai'},
   encoding:'utf8',timeout:5000
  });
  assert.notEqual(r2.status,0);
  assert.match(r2.stderr,/OPENROUTER_BASE/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}

 // Every fetch sets redirect: 'manual' and 3xx redirects fail closed without falling back
 const optsSeen=[];
 const {db,proxy}=fixture({
  aiProvider:'gemini',geminiKey:'g-key',orKey:'or-key',aiDaily:10,aiGlobalDaily:10
 },async(url,opts)=>{
  optsSeen.push({url,redirect:opts.redirect});
  return {ok:false,status:302,json:async()=>null};
 });
 try{
  await assert.rejects(proxy({id:'a'},body),e=>e.status===502&&e.code==='ai_failed');
  assert.equal(optsSeen.length,1);
  assert.equal(optsSeen[0].redirect,'manual');
  assert.equal(new URL(optsSeen[0].url).origin,'https://generativelanguage.googleapis.com');
 }finally{db.close();}
});

test('Gemini direct JSON-mode 400 retries once on Gemini without response_format and handles array-wrapped errors',async()=>{
 const calls=[],logs=[];
 const {db,proxy}=fixture({
  aiProvider:'gemini',
  geminiKey:'g-key',
  geminiBase:'https://generativelanguage.googleapis.com/v1beta/openai/',
  geminiModel:'gemini-3.8-flash',
  orKey:'or-key',
  orBase:'https://openrouter.ai/api/v1',
  aiDaily:10,
  aiGlobalDaily:10,
  log:l=>logs.push(l)
 },async(url,opts)=>{
  calls.push({url,redirect:opts.redirect,body:JSON.parse(opts.body)});
  if(calls.length===1){
   return {ok:false,status:400,json:async()=>([{error:{code:400,status:'INVALID_ARGUMENT',message:'response_format json_object is not supported'}}])};
  }
  return {ok:true,status:200,json:async()=>({choices:[{message:{content:'{"ok":1}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:15}})};
 });
 try{
  const res=await proxy({id:'a'},{messages:[{content:'json'}],json:true});
  assert.deepEqual(res,{text:'{"ok":1}',truncated:false});
  assert.equal(calls.length,2);
  assert.equal(calls[0].url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(calls[1].url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(calls[0].redirect,'manual');
  assert.deepEqual(calls[0].body.response_format,{type:'json_object'});
  assert.equal(Object.hasOwn(calls[1].body,'response_format'),false);
  assert.match(logs[0],/\bprovider=gemini\b/);
  assert.match(logs[0],/\bfallback=true\b/);
  assert.doesNotMatch(logs[0],/\bprovider_fallback=true\b/);
  assert.equal(db.prepare('SELECT n FROM ai_usage WHERE uid=?').get('a').n,1);
 }finally{db.close();}
});

test('Gemini direct falls back once to OpenRouter ONLY on transient/quota/timeout errors',async()=>{
 const cases=[
  {label:'429 quota',transient:true,fn:async()=>({ok:false,status:429,json:async()=>({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Quota exceeded'}})})},
  {label:'500 internal',transient:true,fn:async()=>({ok:false,status:500,json:async()=>({error:{code:500,status:'INTERNAL',message:'Internal error'}})})},
  {label:'502 bad gateway',transient:true,fn:async()=>({ok:false,status:502,json:async()=>{throw new SyntaxError('html');}})},
  {label:'503 unavailable',transient:true,fn:async()=>({ok:false,status:503,json:async()=>({error:{code:503,status:'UNAVAILABLE',message:'This model is currently experiencing high demand.'}})})},
  {label:'504 deadline exceeded',transient:true,fn:async()=>({ok:false,status:504,json:async()=>({error:{code:504,status:'DEADLINE_EXCEEDED',message:'Timed out'}})})},
  {label:'network error',transient:false,fn:async()=>{throw new Error('ECONNRESET');}},
  {label:'200 envelope 429',transient:true,fn:async()=>({ok:true,status:200,json:async()=>({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Quota exceeded'}})})},
  {label:'200 envelope UNAVAILABLE without code',transient:true,fn:async()=>({ok:true,status:200,json:async()=>({error:{status:'UNAVAILABLE',message:'model is currently experiencing high demand'}})})},
  {label:'200 envelope structured RATE_LIMIT_EXCEEDED reason',transient:true,fn:async()=>({ok:true,status:200,json:async()=>({error:{details:[{reason:'RATE_LIMIT_EXCEEDED'}]}})})}
 ];
 for(const tc of cases){
  const calls=[],logs=[],sleeps=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',
   geminiKey:'PLANTED_GEM_KEY',
   geminiBase:'https://generativelanguage.googleapis.com/v1beta/openai',
   geminiModel:'gemini-3.8-flash',
   orKey:'PLANTED_OR_KEY',
   orBase:'https://openrouter.ai/api/v1',
   orModel:'google/gemini-3.8-flash',
   authSecret:'PLANTED_SECRET_VALUE',
   aiReasoningEffort:'low',
   aiDaily:10,
   aiGlobalDaily:10,
   sleep:async ms=>{sleeps.push(ms);},
   log:l=>logs.push(l)
  },async(url,opts)=>{
   calls.push({url,headers:opts.headers,redirect:opts.redirect,body:JSON.parse(opts.body)});
   if(url.startsWith('https://generativelanguage.googleapis.com'))return tc.fn();
   return {
    ok:true,status:200,
    json:async()=>({choices:[{message:{content:'{"from":"backup"}'},finish_reason:'stop'}],usage:{prompt_tokens:50,completion_tokens:30}})
   };
  });
  try{
   const res=await proxy({id:'alice-internal-id'},{messages:[{content:'hello'}],json:true});
   assert.deepEqual(res,{text:'{"from":"backup"}',truncated:false},tc.label);
   const expectedGeminiCalls=tc.transient?3:1;
   assert.equal(calls.length,expectedGeminiCalls+1,tc.label);
   assert.deepEqual(sleeps,tc.transient?[400,1000]:[],tc.label);
   for(let i=0;i<expectedGeminiCalls;i++){
    assert.equal(calls[i].url,'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',tc.label);
    assert.equal(calls[i].redirect,'manual',tc.label);
   }
   const orCall=calls[calls.length-1];
   assert.equal(orCall.url,'https://openrouter.ai/api/v1/chat/completions',tc.label);
   assert.equal(orCall.redirect,'manual',tc.label);
   assert.equal(orCall.headers.Authorization,'Bearer PLANTED_OR_KEY',tc.label);
   assert.equal(orCall.headers['X-Title'],'Bojin Rike',tc.label);
   assert.equal(orCall.body.model,'google/gemini-3.8-flash',tc.label);
   assert.deepEqual(orCall.body.reasoning,{effort:'low'},tc.label);
   assert.equal(Object.hasOwn(orCall.body,'reasoning_effort'),false,tc.label);
   assert.match(orCall.body.user,/^[a-f0-9]{32}$/,tc.label);
   assert.ok(!JSON.stringify(orCall.body).includes('alice-internal-id'),tc.label);
   assert.deepEqual(orCall.body.response_format,{type:'json_object'},tc.label);
   assert.equal(db.prepare('SELECT n FROM ai_usage WHERE uid=?').get('alice-internal-id').n,1,tc.label);
   assert.equal(logs.length,1,tc.label);
   assert.match(logs[0],/\bprovider=openrouter\b/,tc.label);
   assert.match(logs[0],/\bprovider_fallback=true\b/,tc.label);
   if(tc.transient)assert.match(logs[0],/\bretries=2\b/,tc.label);
   else assert.doesNotMatch(logs[0],/\bretries=/,tc.label);
   assert.match(logs[0],/\bmodel=google\/gemini-3\.8-flash\b/,tc.label);
   assert.match(logs[0],/\bempty=false\b/,tc.label);
   for(const s of ['PLANTED_GEM_KEY','PLANTED_OR_KEY','PLANTED_SECRET_VALUE','alice-internal-id']){
    assert.ok(!logs[0].includes(s),`${tc.label} leaked ${s}`);
   }
  }finally{db.close();}
 }
});

test('Gemini transient 503/429 retries with backoff recover on Gemini without spending OpenRouter',async()=>{
 for(const failCount of [1,2]){
  const calls=[],sleeps=[],logs=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',
   geminiKey:'g-key',
   geminiBase:'https://generativelanguage.googleapis.com/v1beta/openai',
   geminiModel:'gemini-3.8-flash',
   orKey:'or-key',
   orBase:'https://openrouter.ai/api/v1',
   aiDaily:10,
   aiGlobalDaily:10,
   sleep:async ms=>{sleeps.push(ms);},
   log:l=>logs.push(l)
  },async url=>{
   calls.push(url);
   if(calls.length<=failCount){
    return {ok:false,status:503,json:async()=>({error:{code:503,status:'UNAVAILABLE',message:'model is currently experiencing high demand'}})};
   }
   return {ok:true,status:200,json:async()=>({choices:[{message:{content:'{"recovered":true}'},finish_reason:'stop'}],usage:{prompt_tokens:25,completion_tokens:15}})};
  });
  try{
   const res=await proxy({id:'a'},{messages:[{content:'retry me'}],json:true});
   assert.deepEqual(res,{text:'{"recovered":true}',truncated:false});
   assert.equal(calls.length,failCount+1);
   assert.ok(calls.every(u=>u.startsWith('https://generativelanguage.googleapis.com')));
   assert.deepEqual(sleeps,[400,1000].slice(0,failCount));
   assert.equal(db.prepare('SELECT n FROM ai_usage WHERE uid=?').get('a').n,1);
   assert.match(logs[0],/\bprovider=gemini\b/);
   assert.match(logs[0],new RegExp(`\\bretries=${failCount}\\b`));
   assert.doesNotMatch(logs[0],/\bprovider_fallback=true\b/);
  }finally{db.close();}
 }
});

test('Gemini direct does NOT fall back on 400/401/402/403, policy/safety blocks, truncation, missing OpenRouter key, or when AI_PROVIDER=openrouter',async()=>{
 // 1. Permanent auth/billing/permission, user-input 4xx (even mentioning quota/billing in message!), and 3xx redirects must NEVER disclose payload to OpenRouter
 for(const nonFallback of [
  {status:400,body:{error:{code:400,status:'INVALID_ARGUMENT',message:'Invalid image data'}}},
  {status:400,body:{error:{code:400,status:'INVALID_ARGUMENT',message:'Prompt exceeded quota or billing limit text echoed from user input'}}},
  {status:400,body:{error:{code:400,status:'INVALID_ARGUMENT',message:'API key not valid. Please pass a valid API key.',details:[{reason:'API_KEY_INVALID'}]}}},
  {status:400,body:{error:{code:400,status:'FAILED_PRECONDITION',message:'Billing account not enabled'}}},
  {status:401,body:{error:{code:401,status:'UNAUTHENTICATED',message:'Invalid API key'}}},
  {status:402,body:{error:{code:402,message:'Payment required'}}},
  {status:403,body:{error:{code:403,status:'PERMISSION_DENIED',message:'Safety policy blocked request'}}},
  {status:403,body:{error:{code:403,status:'PERMISSION_DENIED',message:'Caller does not have permission or billing disabled'}}},
  {status:404,body:{error:{code:404,message:'Model not found'}}},
  {status:422,body:{error:{code:422,message:'Unprocessable entity'}}},
  {ok:true,status:200,body:{error:{code:400,status:'INVALID_ARGUMENT',message:'quota exceeded in user prompt'}}}
 ]){
  const calls=[],logs=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',geminiKey:'g-key',geminiBase:'https://generativelanguage.googleapis.com/v1beta/openai',
   orKey:'or-key',orBase:'https://openrouter.ai/api/v1',aiDaily:10,aiGlobalDaily:10,log:l=>logs.push(l)
  },async url=>{calls.push(url);return {ok:Boolean(nonFallback.ok),status:nonFallback.status,json:async()=>nonFallback.body};});
  try{
   await assert.rejects(proxy({id:'a'},body),e=>e.status===502&&e.code==='ai_failed');
   assert.equal(calls.length,1,`unexpected fallback for ${JSON.stringify(nonFallback)}`);
   assert.equal(db.prepare('SELECT n FROM ai_usage WHERE uid=?').get('a').n,1);
   assert.match(logs[0],/\bprovider=gemini\b/);
   assert.doesNotMatch(logs[0],/\bprovider_fallback=true\b/);
  }finally{db.close();}
 }

 // 2. Safety content_filter response (empty content) must NOT fall back to OpenRouter
 {
  const calls=[],logs=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',geminiKey:'g-key',geminiBase:'https://generativelanguage.googleapis.com/v1beta/openai',
   orKey:'or-key',orBase:'https://openrouter.ai/api/v1',aiDaily:10,aiGlobalDaily:10,log:l=>logs.push(l)
  },async url=>{
   calls.push(url);
   return {ok:true,status:200,json:async()=>({choices:[{message:{content:''},finish_reason:'content_filter'}],usage:{prompt_tokens:100,completion_tokens:0}})};
  });
  try{
   await assert.rejects(proxy({id:'a'},body),e=>e.status===502&&e.code==='ai_failed');
   assert.equal(calls.length,1);
   assert.match(logs[0],/\bprovider=gemini\b/);
   assert.match(logs[0],/\bfinish_reason=content_filter\b/);
   assert.doesNotMatch(logs[0],/\bprovider_fallback=true\b/);
  }finally{db.close();}
 }

 // 3. Truncated empty response from Gemini surfaces truncated error without fallback
 {
  const calls=[],logs=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',geminiKey:'g-key',geminiBase:'https://generativelanguage.googleapis.com/v1beta/openai',
   orKey:'or-key',orBase:'https://openrouter.ai/api/v1',aiDaily:10,aiGlobalDaily:10,log:l=>logs.push(l)
  },async url=>{
   calls.push(url);
   return {ok:true,status:200,json:async()=>({choices:[{message:{content:''},finish_reason:'length'}],usage:{prompt_tokens:100,completion_tokens:2000,completion_tokens_details:{reasoning_tokens:2000}}})};
  });
  try{
   await assert.rejects(proxy({id:'a'},body),e=>e.status===502&&e.code==='truncated');
   assert.equal(calls.length,1);
   assert.match(logs[0],/\bprovider=gemini\b/);
   assert.match(logs[0],/\bfinish_reason=length\b/);
   assert.doesNotMatch(logs[0],/\bprovider_fallback=true\b/);
  }finally{db.close();}
 }

 // 4. No OpenRouter key set -> Gemini 429 retries with backoff then fails directly with 429 rate_limited
 {
  const calls=[],logs=[],sleeps=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',geminiKey:'g-key',geminiBase:'https://generativelanguage.googleapis.com/v1beta/openai',
   orKey:'',aiDaily:10,aiGlobalDaily:10,sleep:async ms=>{sleeps.push(ms);},log:l=>logs.push(l)
  },async url=>{calls.push(url);return {ok:false,status:429,json:async()=>({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Quota exceeded'}})};});
  try{
   assert.equal(proxy.hasFallback,false);
   await assert.rejects(proxy({id:'a'},body),e=>e.status===429&&e.code==='rate_limited');
   assert.equal(calls.length,3);
   assert.deepEqual(sleeps,[400,1000]);
   assert.match(logs[0],/\bprovider=gemini\b/);
   assert.match(logs[0],/\bretries=2\b/);
   assert.doesNotMatch(logs[0],/\bprovider_fallback=true\b/);
  }finally{db.close();}
 }

 // 5. AI_PROVIDER=openrouter never falls back to Gemini even when GEMINI_API_KEY is set
 {
  const calls=[],logs=[];
  const {db,proxy}=fixture({
   aiProvider:'openrouter',geminiKey:'g-key',geminiBase:'https://generativelanguage.googleapis.com/v1beta/openai',
   orKey:'or-key',orBase:'https://openrouter.ai/api/v1',aiDaily:10,aiGlobalDaily:10,log:l=>logs.push(l)
  },async url=>{calls.push(url);return {ok:false,status:503,json:async()=>({error:{code:503,message:'Down'}})};});
  try{
   assert.equal(proxy.hasFallback,false);
   await assert.rejects(proxy({id:'a'},body),e=>e.status===502&&e.code==='ai_failed');
   assert.equal(calls.length,1);
   assert.equal(calls[0],'https://openrouter.ai/api/v1/chat/completions');
   assert.match(logs[0],/\bprovider=openrouter\b/);
   assert.doesNotMatch(logs[0],/\bprovider_fallback=true\b/);
  }finally{db.close();}
 }

 // 6. Both Gemini and OpenRouter fail -> retries OpenRouter at most once, maps final status, counts 1 quota unit
 {
  const calls=[],logs=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',geminiKey:'g-key',geminiBase:'https://generativelanguage.googleapis.com/v1beta/openai',
   orKey:'or-key',orBase:'https://openrouter.ai/api/v1',orModel:'google/gemini-3.8-flash',
   aiDaily:10,aiGlobalDaily:10,sleep:async()=>{},log:l=>logs.push(l)
  },async url=>{
   calls.push(url);
   if(url.startsWith('https://generativelanguage.googleapis.com'))return {ok:false,status:503,json:async()=>({error:{code:503,message:'Gemini down'}})};
   return {ok:false,status:429,json:async()=>({error:{code:429,message:'OpenRouter rate limit'}})};
  });
  try{
   await assert.rejects(proxy({id:'a'},body),e=>e.status===429&&e.code==='rate_limited');
   assert.equal(calls.length,4);
   assert.equal(calls.filter(u=>u.startsWith('https://openrouter.ai')).length,1);
   assert.equal(db.prepare('SELECT n FROM ai_usage WHERE uid=?').get('a').n,1);
   assert.match(logs[0],/\bprovider=openrouter\b/);
   assert.match(logs[0],/\bprovider_fallback=true\b/);
   assert.match(logs[0],/\bretries=2\b/);
   assert.match(logs[0],/\bfinish_reason=error\b/);
   assert.match(logs[0],/\bempty=true\b/);
  }finally{db.close();}
 }
});

test('hard 120s deadline, 30s fallback reserve, retry budget, and aborted body reads under controlled clock',async()=>{
 // 1. Slow Gemini call hitting 90s primary cap leaves 30s reserve for OpenRouter fallback
 {
  let clock=1000000;
  const seen=[],logs=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',geminiKey:'g-key',orKey:'or-key',orModel:'google/gemini-3.8-flash',
   aiDaily:10,aiGlobalDaily:10,now:()=>clock,sleep:async ms=>{clock+=ms;},log:l=>logs.push(l)
  },async url=>{
   seen.push({url,at:clock-1000000});
   if(url.startsWith('https://generativelanguage.googleapis.com')){
    clock+=90000;
    const err=new Error('aborted');err.name='TimeoutError';throw err;
   }
   clock+=4000;
   return {ok:true,status:200,json:async()=>({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}]})};
  });
  try{
   const res=await proxy({id:'a'},{messages:[{content:'slow'}],json:true});
   assert.deepEqual(res,{text:'{"ok":true}',truncated:false});
   assert.equal(seen.length,2);
   assert.equal(seen[1].url,'https://openrouter.ai/api/v1/chat/completions');
   assert.equal(seen[1].at,90000);
   assert.match(logs[0],/\bprovider=openrouter\b/);
   assert.match(logs[0],/\bprovider_fallback=true\b/);
   assert.match(logs[0],/\bms=94000\b/);
  }finally{db.close();}
 }

 // 2. Once full 120s deadline is reached, NEVER start a retry or fallback past expiration
 {
  let clock=2000000;
  const seen=[],logs=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',geminiKey:'g-key',orKey:'or-key',
   aiDaily:10,aiGlobalDaily:10,now:()=>clock,sleep:async ms=>{clock+=ms;},log:l=>logs.push(l)
  },async url=>{
   seen.push(url);
   clock+=120000;
   return {ok:false,status:503,json:async()=>({error:{code:503,status:'UNAVAILABLE'}})};
  });
  try{
   await assert.rejects(proxy({id:'a'},body),e=>e.status===502&&e.code==='ai_failed');
   assert.equal(seen.length,1);
   assert.match(logs[0],/\bprovider=gemini\b/);
   assert.doesNotMatch(logs[0],/\bprovider_fallback=true\b/);
   assert.match(logs[0],/\bms=120000\b/);
  }finally{db.close();}
 }

 // 3. Slow Gemini 503 near 15s retry budget skips backoff retries and falls back immediately
 {
  let clock=3000000;
  const seen=[],sleeps=[],logs=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',geminiKey:'g-key',orKey:'or-key',orModel:'google/gemini-3.8-flash',
   aiDaily:10,aiGlobalDaily:10,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;},log:l=>logs.push(l)
  },async url=>{
   seen.push(url);
   if(url.startsWith('https://generativelanguage.googleapis.com')){
    clock+=14800;
    return {ok:false,status:503,json:async()=>({error:{code:503,status:'UNAVAILABLE'}})};
   }
   clock+=2500;
   return {ok:true,status:200,json:async()=>({choices:[{message:{content:'ok'},finish_reason:'stop'}]})};
  });
  try{
   const res=await proxy({id:'a'},body);
   assert.deepEqual(res,{text:'ok',truncated:false});
   assert.equal(seen.length,2);
   assert.deepEqual(sleeps,[]);
   assert.match(logs[0],/\bprovider=openrouter\b/);
   assert.match(logs[0],/\bprovider_fallback=true\b/);
   assert.doesNotMatch(logs[0],/\bretries=/);
  }finally{db.close();}
 }

 // 4. Timeout/abort during HTTP 200 response body parsing triggers OpenRouter fallback instead of null-payload failure
 {
  let clock=4000000;
  const seen=[],logs=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',geminiKey:'g-key',orKey:'or-key',orModel:'google/gemini-3.8-flash',
   aiDaily:10,aiGlobalDaily:10,now:()=>clock,sleep:async ms=>{clock+=ms;},log:l=>logs.push(l)
  },async url=>{
   seen.push(url);
   if(url.startsWith('https://generativelanguage.googleapis.com')){
    return {
     ok:true,status:200,
     json:async()=>{
      clock+=90000;
      const err=new Error('body read timed out');err.name='TimeoutError';throw err;
     }
    };
   }
   clock+=3000;
   return {ok:true,status:200,json:async()=>({choices:[{message:{content:'recovered-after-body-timeout'},finish_reason:'stop'}]})};
  });
  try{
   const res=await proxy({id:'a'},body);
   assert.deepEqual(res,{text:'recovered-after-body-timeout',truncated:false});
   assert.equal(seen.length,2);
   assert.equal(seen[1],'https://openrouter.ai/api/v1/chat/completions');
   assert.match(logs[0],/\bprovider=openrouter\b/);
   assert.match(logs[0],/\bprovider_fallback=true\b/);
  }finally{db.close();}
 }

 // 5. Non-JSON body SyntaxError on HTTP 200 before deadline fails without spurious fallback
 {
  let clock=5000000;
  const seen=[],logs=[];
  const {db,proxy}=fixture({
   aiProvider:'gemini',geminiKey:'g-key',orKey:'or-key',
   aiDaily:10,aiGlobalDaily:10,now:()=>clock,log:l=>logs.push(l)
  },async url=>{
   seen.push(url);
   clock+=1000;
   return {ok:true,status:200,json:async()=>{throw new SyntaxError('Unexpected token <');}};
  });
  try{
   await assert.rejects(proxy({id:'a'},body),e=>e.status===502&&e.code==='ai_failed');
   assert.equal(seen.length,1);
   assert.match(logs[0],/\bprovider=gemini\b/);
   assert.doesNotMatch(logs[0],/\bprovider_fallback=true\b/);
  }finally{db.close();}
 }
});

test('HTTP integration with mocked upstream servers: Gemini direct, OpenRouter fallback, /api/config, /api/me, and secret-free logs', {timeout:30000}, async t=>{
 const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const {spawn,spawnSync}=require('node:child_process');
 const geminiKey='TEST_GEMINI_SECRET_KEY_ABC';
 const orKey='TEST_OPENROUTER_SECRET_KEY_XYZ';
 let geminiMode='ok';
 const upstreamSeen=[];
 const mockUpstream=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  const bodyObj=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  upstreamSeen.push({url:req.url,auth:req.headers.authorization,title:req.headers['x-title'],body:bodyObj});
  res.setHeader('Content-Type','application/json');
  if(req.url==='/gemini/chat/completions'){
   if(geminiMode==='unavailable'){
    res.writeHead(503);
    res.end(JSON.stringify({error:{code:503,status:'UNAVAILABLE',message:'model is currently experiencing high demand'}}));
    return;
   }
   res.writeHead(200);
   res.end(JSON.stringify({choices:[{message:{content:'{"provider":"gemini"}'},finish_reason:'stop'}],usage:{prompt_tokens:40,completion_tokens:12,completion_tokens_details:{reasoning_tokens:0}}}));
   return;
  }
  if(req.url==='/openrouter/chat/completions'){
   res.writeHead(200);
   res.end(JSON.stringify({choices:[{message:{content:'{"provider":"openrouter"}'},finish_reason:'stop'}],usage:{prompt_tokens:42,completion_tokens:14}}));
   return;
  }
  res.writeHead(404);res.end('{}');
 });
 await new Promise(r=>mockUpstream.listen(0,'127.0.0.1',r));
 const mockPort=mockUpstream.address().port;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-ai-http-'));
 const port=18096,base=`http://127.0.0.1:${port}`;
 const env={
  ...process.env,
  DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',AUTH_BASE_URL:base,
  AUTH_SECRET:'disposable-test-secret-at-least-32-characters',
  COOKIE_SECURE:'0',TRUST_PROXY:'0',MAIL_MODE:'file',
  AI_PROVIDER:'gemini',
  GEMINI_API_KEY:geminiKey,
  GEMINI_BASE:`http://127.0.0.1:${mockPort}/gemini`,
  GEMINI_MODEL:'gemini-3.8-flash',
  OPENROUTER_API_KEY:orKey,
  OPENROUTER_BASE:`http://127.0.0.1:${mockPort}/openrouter`,
  OPENROUTER_MODEL:'google/gemini-3.8-flash',
  AI_REASONING_EFFORT:'low',
  AI_MAX_OUTPUT_TOKENS:'2000'
 };
 const inv=spawnSync(process.execPath,['scripts/auth-admin.js','invite','gemini-tester@example.com'],{env,encoding:'utf8',timeout:5000});
 assert.equal(inv.status,0,inv.stderr);
 const invitation=JSON.parse(inv.stdout);
 const child=spawn(process.execPath,['server.js'],{env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.on('data',d=>stdout+=d);
 child.stderr.on('data',d=>stderr+=d);
 t.after(async()=>{
  if(child.exitCode===null){const stopped=new Promise(r=>child.once('exit',r));child.kill();await stopped;}
  await new Promise(r=>mockUpstream.close(r));
  fs.rmSync(dir,{recursive:true,force:true});
 });
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('startup timeout '+stderr)),8000);
  const check=()=>{if(stdout.includes('薄肌日课已启动')){clearTimeout(timer);resolve();}};
  child.stdout.on('data',check);
  child.once('error',reject);
  child.once('exit',()=>{clearTimeout(timer);reject(new Error(stderr));});
 });
 assert.match(stdout,/已配置 gemini\/gemini-3\.8-flash，备用 openrouter\/google\/gemini-3\.8-flash/);
 const req=(route,payload,cookie)=>fetch(base+route,{
  method:payload?'POST':'GET',redirect:'manual',
  headers:{origin:base,'Content-Type':'application/json','X-Bojin':'1',...(cookie?{cookie}:{})},
  ...(payload?{body:JSON.stringify(payload)}:{})
 });
 const cfg=await (await req('/api/config')).json();
 assert.deepEqual(cfg,{allowSignup:true,invite:true,ai:true});

 const password='temporary strong test password';
 assert.equal((await req('/api/auth/sign-up/email',{email:invitation.email,name:'Tester',password,invitation:invitation.token,callbackURL:'/login.html'})).status,200);
 const mail=fs.readdirSync(path.join(dir,'mail')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,'mail',f),'utf8'))).find(m=>m.kind==='verify');
 assert.equal((await fetch(mail.url,{redirect:'manual'})).status,302);
 const login=await req('/api/auth/sign-in/email',{email:invitation.email,password});
 assert.equal(login.status,200);
 const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 const me=await (await req('/api/me',null,cookie)).json();
 assert.equal(me.ai,true);
 assert.equal(me.aiModel,'gemini-3.8-flash');

 // 1. Direct Gemini call succeeds
 const r1=await req('/api/ai',{messages:[{content:'meal estimate'}],json:true},cookie);
 assert.equal(r1.status,200);
 assert.deepEqual(await r1.json(),{text:'{"provider":"gemini"}',truncated:false});
 assert.equal(upstreamSeen.length,1);
 assert.equal(upstreamSeen[0].url,'/gemini/chat/completions');
 assert.equal(upstreamSeen[0].auth,'Bearer '+geminiKey);
 assert.equal(upstreamSeen[0].body.reasoning_effort,'low');

 // 2. Persistent Gemini 503 UNAVAILABLE retries with backoff, then falls back once to OpenRouter
 geminiMode='unavailable';
 const r2=await req('/api/ai',{messages:[{content:'second meal'}],json:true},cookie);
 assert.equal(r2.status,200);
 assert.deepEqual(await r2.json(),{text:'{"provider":"openrouter"}',truncated:false});
 assert.equal(upstreamSeen.length,5);
 assert.equal(upstreamSeen[1].url,'/gemini/chat/completions');
 assert.equal(upstreamSeen[2].url,'/gemini/chat/completions');
 assert.equal(upstreamSeen[3].url,'/gemini/chat/completions');
 assert.equal(upstreamSeen[4].url,'/openrouter/chat/completions');
 assert.equal(upstreamSeen[4].auth,'Bearer '+orKey);
 assert.equal(upstreamSeen[4].title,'Bojin Rike');
 assert.deepEqual(upstreamSeen[4].body.reasoning,{effort:'low'});
 assert.match(upstreamSeen[4].body.user,/^[a-f0-9]{32}$/);

 assert.match(stdout,/ai provider=gemini kind=json images=0 model=gemini-3\.8-flash finish_reason=stop/);
 assert.match(stdout,/ai provider=openrouter provider_fallback=true retries=2 kind=json images=0 model=google\/gemini-3\.8-flash finish_reason=stop/);
 for(const secret of [geminiKey,orKey,'meal estimate','second meal']){
  assert.ok(!stdout.includes(secret),`stdout leaked ${secret}`);
  assert.ok(!stderr.includes(secret),`stderr leaked ${secret}`);
 }
});

test('privacy.html, .env.example, and docs/OPERATIONS.md accurately document Gemini direct provider, OpenRouter backup, pre-cutover smoke test, switching, and rollback',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const root=path.join(__dirname,'..');
 const privacy=fs.readFileSync(path.join(root,'public/privacy.html'),'utf8');
 const zh=privacy.match(/<article id="doc-zh">([\s\S]*?)<\/article>/)[1];
 const en=privacy.match(/<article id="doc-en" hidden>([\s\S]*?)<\/article>/)[1];
 // Qualified paid-tier & processing location + pseudonymous metadata + user-supplied free-text/photo disclosure
 assert.match(zh,/Google Gemini API/);
 assert.match(zh,/无法强制验证计费档位或限定处理地区/);
 assert.match(zh,/HMAC/);
 assert.match(zh,/原样发送/);
 assert.match(zh,/OpenRouter.*备用/);
 assert.match(en,/Google Gemini API/);
 assert.match(en,/cannot itself enforce billing tier status or processing location/i);
 assert.match(en,/HMAC-derived pseudonymous user identifier/i);
 assert.match(en,/free-text notes and photos you submit are transmitted as supplied/i);
 assert.match(en,/OpenRouter.*backup/i);

 const envEx=fs.readFileSync(path.join(root,'.env.example'),'utf8');
 for(const key of ['AI_PROVIDER=openrouter','GEMINI_API_KEY=','GEMINI_MODEL=gemini-3.8-flash','GEMINI_BASE=','OPENROUTER_API_KEY=']){
  assert.ok(envEx.includes(key),`.env.example missing ${key}`);
 }
 const ops=fs.readFileSync(path.join(root,'docs/OPERATIONS.md'),'utf8');
 for(const snippet of [
  'AI_PROVIDER=gemini',
  'AI_PROVIDER=openrouter',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'OPENROUTER_MODEL=google/gemini-3.8-flash',
  'Pre-cutover direct Gemini smoke test',
  'response_format: { type: "json_object" }',
  'image_url',
  'reasoning_effort',
  'redirect: "manual"',
  'provider_fallback=true',
  'bojin-maintenance-lock -- systemctl restart bojin.service'
 ]){
  assert.ok(ops.includes(snippet),`docs/OPERATIONS.md missing ${snippet}`);
 }
});
