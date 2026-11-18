'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');const {createAIProxy}=require('../lib/ai');
function fixture(overrides={},fetcher=async()=>({ok:true,json:async()=>({choices:[{message:{content:'ok'}}]})})) {
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_usage(uid TEXT,day TEXT,n INTEGER,PRIMARY KEY(uid,day))');
 const proxy=createAIProxy(db,{aiDaily:2,aiGlobalDaily:3,aiMaxTokens:100,orKey:'test-only',orBase:'https://example.invalid',orModel:'test',...overrides},fetcher);
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

test('JSON mode retries once without response_format when provider rejects with 400',async()=>{
 const sent=[];
 const {db,proxy}=fixture({aiDaily:10,aiGlobalDaily:10,aiReasoningEffort:'low'},async(u,o)=>{
  const req=JSON.parse(o.body);sent.push(req);
  if(sent.length===1)return {ok:false,status:400,json:async()=>({error:{code:400,message:'response_format unsupported'}})};
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

test('400 retry does not trigger for text calls, non-400 errors, or more than once',async()=>{
 let calls=0;
 const {db,proxy}=fixture({aiDaily:10,aiGlobalDaily:10},async()=>{
  calls++;return {ok:false,status:400,json:async()=>({error:{code:400,message:'bad request'}})};
 });
 try{
  await assert.rejects(proxy({id:'a'},{messages:[{content:'text call'}]}),e=>e.code==='ai_failed');
  assert.equal(calls,1);
  calls=0;
  await assert.rejects(proxy({id:'a'},{messages:[{content:'json call'}],json:true}),e=>e.code==='ai_failed');
  assert.equal(calls,2);
 }finally{db.close();}
 let calls502=0;
 const f2=fixture({aiDaily:10,aiGlobalDaily:10},async()=>{calls502++;return {ok:false,status:502,json:async()=>({})};});
 try{
  await assert.rejects(f2.proxy({id:'a'},{messages:[{content:'json call'}],json:true}),e=>e.code==='ai_failed');
  assert.equal(calls502,1);
 }finally{f2.db.close();}
});

test('AI_REASONING_EFFORT validates at startup and passes reasoning.effort only when set',async()=>{
 for(const bad of ['minimal','LOW','none','invalid',123]){
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE ai_usage(uid TEXT,day TEXT,n INTEGER,PRIMARY KEY(uid,day))');
  try{assert.throws(()=>createAIProxy(db,{aiDaily:2,aiGlobalDaily:3,aiMaxTokens:100,orKey:'k',orBase:'https://example.invalid',orModel:'test',aiReasoningEffort:bad}),/AI_REASONING_EFFORT/);}
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

test('diagnostic log records one metadata line with tokens and finish_reason and never logs personal markers',async()=>{
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
 let pseudonym='';
 const {db,proxy}=fixture({aiDaily:10,aiGlobalDaily:10,authSecret:markers.secret,orModel:'google/gemini-3.8-flash'},async(u,o)=>{
  const req=JSON.parse(o.body);pseudonym=req.user;
  if(logs.length===1)return {ok:true,status:200,json:async()=>({model:'google/gemini-3.8-flash',choices:[{message:{content:'   '},finish_reason:'length'}],usage:{prompt_tokens:501,completion_tokens:2000,completion_tokens_details:{reasoning_tokens:2000}}})};
  if(logs.length===2)return {ok:false,status:502,json:async()=>({error:{message:markers.errMsg}})};
  return {ok:true,status:200,json:async()=>({model:'google/gemini-3.8-flash',choices:[{message:{content:`{"note":"${markers.response}"}`},finish_reason:'stop'}],usage:{prompt_tokens:321,completion_tokens:1234,completion_tokens_details:{reasoning_tokens:789}}})};
 });
 try{
  await proxy({id:markers.uid},{
   json:true,
   messages:[{role:'assistant',content:markers.history},{role:'user',content:markers.prompt}],
   images:[`data:image/jpeg;base64,${markers.image}==`]
  });
  assert.equal(logs.length,1);
  assert.equal(logs[0].includes('\n'),false);
  assert.match(logs[0],/\bkind=json\b/);
  assert.match(logs[0],/\bimages=1\b/);
  assert.match(logs[0],/\bmodel=google\/gemini-3\.8-flash\b/);
  assert.match(logs[0],/\bfinish_reason=stop\b/);
  assert.match(logs[0],/\b321\b/);
  assert.match(logs[0],/\b1234\b/);
  assert.match(logs[0],/\b789\b/);
  assert.match(logs[0],/\bempty=false\b/);
  assert.match(logs[0],/\bms=\d+\b/);

  await assert.rejects(proxy({id:markers.uid},{messages:[{content:markers.prompt}]}),e=>e.code==='ai_failed');
  assert.equal(logs.length,2);
  assert.match(logs[1],/\bkind=text\b/);
  assert.match(logs[1],/\bimages=0\b/);
  assert.match(logs[1],/\bfinish_reason=length\b/);
  assert.match(logs[1],/\b501\b/);
  assert.match(logs[1],/\b2000\b/);
  assert.match(logs[1],/\bempty=true\b/);

  await assert.rejects(proxy({id:markers.uid},{messages:[{content:markers.prompt}]}),e=>e.code==='ai_failed');
  assert.equal(logs.length,3);

  const combined=logs.join('\n');
  for(const m of [...Object.values(markers),pseudonym]){
   assert.ok(m&&!combined.includes(m),`log leaked marker: ${m}`);
  }
 }finally{
  console.log=origLog;console.error=origErr;db.close();
 }
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
