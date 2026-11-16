'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
for(const [secure,proxy] of [['0','0'],['0','1'],['1','0']]) test('security headers secure='+secure+' proxy='+proxy,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'headers-'));
 const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'18189',MAIL_MODE:'file',DATA_DIR:dir,COOKIE_SECURE:secure,TRUST_PROXY:proxy,AUTH_SECRET:'test-secret-with-at-least-32-characters',AUTH_BASE_URL:'http://localhost:8080'},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}fs.rmSync(dir,{recursive:true,force:true});});
 // Discover the ephemeral port from the normal startup message.
 const output=await new Promise((resolve,reject)=>{child.stdout.once('data',d=>resolve(d.toString()));child.once('exit',()=>reject(new Error('server exited')));});
 const port=output.match(/:(\d+)/)[1];
 for(const route of ['/login.html','/privacy.html','/guide.html','/index.html','/api/health','/api/me','/missing','/api/auth/get-session']) for(const forwarded of ['http','https']){
  const r=await fetch('http://127.0.0.1:'+port+route,{redirect:'manual',headers:{'X-Forwarded-Proto':forwarded}});
  assert.equal(r.headers.get('strict-transport-security'),secure==='1'||proxy==='1'&&forwarded==='https'?'max-age=15552000; includeSubDomains':null);
  assert.equal(r.headers.get('cross-origin-opener-policy'),'same-origin');
  assert.equal(r.headers.get('permissions-policy'),'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  const csp=r.headers.get('content-security-policy');
  assert.match(csp,/script-src 'self' 'wasm-unsafe-eval' 'sha256-/);
  assert.match(csp,/frame-ancestors 'none'/);
  assert.doesNotMatch(csp.split(';').find(x=>x.includes('script-src')),/unsafe-inline/);
 }
});
