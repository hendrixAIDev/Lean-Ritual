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
