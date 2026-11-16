'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
for(const [secure,proxy] of [['0','0'],['0','1'],['1','0'],['1','1']]) test('security headers secure='+secure+' proxy='+proxy,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'headers-'));
 const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:'0',MAIL_MODE:'file',DATA_DIR:dir,COOKIE_SECURE:secure,TRUST_PROXY:proxy,AUTH_SECRET:'test-secret-with-at-least-32-characters',AUTH_BASE_URL:'http://localhost:8080'},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}fs.rmSync(dir,{recursive:true,force:true});});
 // Discover the ephemeral port from the normal startup message.
 const output=await new Promise((resolve,reject)=>{child.stdout.once('data',d=>resolve(d.toString()));child.once('exit',()=>reject(new Error('server exited')));});
 const port=output.match(/:(\d+)/)[1];
 const worker=await fetch('http://127.0.0.1:'+port+'/vendor/heic2any-worker.js');
 assert.equal(worker.headers.get('content-security-policy'),"default-src 'none'; script-src 'unsafe-eval'");

 for(const route of ['/login.html','/privacy.html','/guide.html','/index.html','/api/health','/api/me','/missing','/api/auth/get-session','/shim.js','/ocr/tesseract-core-lstm.wasm.js','/_blob/00000000000000000000000000000000']) for(const forwarded of ['http','https','HTTPS','https, http']){
  const r=await fetch('http://127.0.0.1:'+port+route,{redirect:'manual',headers:{'X-Forwarded-Proto':forwarded}});
  assert.equal(r.headers.get('strict-transport-security'),secure==='1'||proxy==='1'&&forwarded.toLowerCase().split(',')[0]==='https'?'max-age=15552000; includeSubDomains':null);
  assert.equal(r.headers.get('cross-origin-opener-policy'),'same-origin');
  assert.equal(r.headers.get('permissions-policy'),'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  const csp=r.headers.get('content-security-policy');
  assert.match(csp,/script-src 'self' 'wasm-unsafe-eval' 'sha256-/);
  assert.match(csp,/frame-ancestors 'none'/);
  assert.doesNotMatch(csp.split(';').find(x=>x.includes('script-src')),/unsafe-inline|'unsafe-eval'/);
 }
});

test('built HTML and CSP hashes stay synchronized',()=>{
 const hashes=new Set();
 for(const name of ['index.html','login.html','privacy.html','guide.html']){
  const html=fs.readFileSync(path.join('public',name),'utf8');
  assert.doesNotMatch(html,/<[^>]+\son\w+\s*=/i);
  for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) if(!/\bsrc\s*=/i.test(m[1])) hashes.add("'sha256-"+require('node:crypto').createHash('sha256').update(m[2].replace(/\r\n?/g,'\n')).digest('base64')+"'");
 }
 assert.deepEqual(JSON.parse(fs.readFileSync('public/csp-hashes.json')).sort(),[...hashes].sort());
 const worker=fs.readFileSync('public/vendor/heic2any.min.js','utf8');
 assert.match(worker,/new Worker\("\/vendor\/heic2any-worker.js"\)/);
});
test('stale HTML fails startup with a rebuild message; CLI skips CSP',()=>{
 const {spawnSync}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stale-csp-'));
 try {
  for(const name of ['server.js','package.json']) fs.copyFileSync(name,path.join(dir,name));
  for(const name of ['lib','node_modules']) fs.symlinkSync(path.resolve(name),path.join(dir,name));
  fs.mkdirSync(path.join(dir,'public'));
  for(const name of ['index.html','login.html','privacy.html','guide.html','csp-hashes.json']) fs.copyFileSync(path.join('public',name),path.join(dir,'public',name));
  fs.appendFileSync(path.join(dir,'public/login.html'),'<script>/* changed */</script>');
  const env={...process.env,DATA_DIR:path.join(dir,'data'),AUTH_SECRET:'test-secret-with-at-least-32-characters',MAIL_MODE:'file'};
  const result=spawnSync(process.execPath,[path.join(dir,'server.js')],{env,encoding:'utf8',timeout:5000});
  assert.notEqual(result.status,0);assert.match(result.stderr,/CSP manifest missing or stale; run npm run build/);
  fs.unlinkSync(path.join(dir,'public/csp-hashes.json'));
  const cli=spawnSync(process.execPath,[path.join(dir,'server.js'),'import'],{env,encoding:'utf8',timeout:5000});
  assert.doesNotMatch(cli.stderr,/CSP manifest/);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
