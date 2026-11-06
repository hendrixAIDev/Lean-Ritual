'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../app/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function context() {
  const values = new Map([['bj-drafts', '{"privateLegacyDraft":true}']]);
  const app = {innerHTML:''};
  const ctx = vm.createContext({window:{}, document:{addEventListener(){},querySelector(){return app;}},
    localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},console,URL,Date,setTimeout,clearTimeout});
  return {ctx, values, app};
}
test('drafts and backups are isolated by authenticated account, without adopting legacy shared drafts', () => {
  const {ctx} = context();
  vm.runInContext(script.split('/* ============ 启动 ============ */')[0],ctx);
  assert.equal(vm.runInContext('Object.keys(S.drafts).length',ctx),0);
  vm.runInContext('storageUser="alice"; lsSet("bj-drafts", {privateDraft:true}); lsSet("bj-wbackup", {privateWorkout:true})',ctx);
  vm.runInContext('storageUser="bob"',ctx);
  assert.equal(vm.runInContext('Object.keys(lsGet("bj-drafts", {})).length',ctx),0);
  assert.equal(vm.runInContext('Object.keys(lsGet("bj-wbackup", {})).length',ctx),0);
  vm.runInContext('storageUser="alice"',ctx);
  assert.equal(vm.runInContext('lsGet("bj-drafts", {}).privateDraft',ctx),true);
});
test('unavailable account never boots into local unauthenticated storage', async () => {
  const {ctx,app} = context();
  vm.runInContext(script,ctx);
  await new Promise(r=>setImmediate(r));
  assert.match(app.innerHTML,/重新登录/);
  assert.equal(vm.runInContext('S.ready',ctx),false);
  assert.equal(vm.runInContext('S.store',ctx),null);
});
test('standalone client has no Claude bridge, provider-key UI or direct AI provider fetch', () => {
  new vm.Script(script);
  assert.doesNotMatch(script,/window\.claude|sendToClaude|canSendToClaude|openrouter\.ai|claude\.ai|or-key|bj-ai/);
});
test('shim sends AI requests to same-origin backend without provider credentials', async () => {
  const calls=[];
  const ctx=vm.createContext({window:{},location:{},URLSearchParams,fetch:async(url,options)=>{
    calls.push({url,options});return {ok:true,status:200,json:async()=>url==='/api/me'?{id:'alice',ai:true}:{text:'estimate'}};
  }});
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../public/shim.js'),'utf8'),ctx);
  const sample=await ctx.window.ritual.use('sample');
  assert.equal((await sample('test')).text,'estimate');
  assert.deepEqual(calls.map(c=>c.url),['/api/me','/api/ai']);
  assert.equal(calls[1].options.credentials,'same-origin');
  assert.equal(calls[1].options.headers.Authorization,undefined);
});
