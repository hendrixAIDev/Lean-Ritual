'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn,spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
test('HTTP integration: invitation-only verified accounts, private data/photos and retired legacy auth', {timeout:30000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-http-'));
 const base='http://127.0.0.1:18082';
 const env={...process.env,DATA_DIR:dir,PORT:'18082',HOST:'127.0.0.1',AUTH_BASE_URL:base,AUTH_SECRET:'disposable-test-secret-at-least-32-characters',COOKIE_SECURE:'0',TRUST_PROXY:'0',MAIL_MODE:'file',OPENROUTER_API_KEY:''};
 // A real legacy data fixture proves the mapping preserves IDs and records.
 const legacy=new DatabaseSync(path.join(dir,'bojin.db'));
 legacy.exec("CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, created TEXT NOT NULL,mustChange INTEGER DEFAULT 0); INSERT INTO users VALUES('u_legacy_owner','legacy','not-a-real-password','2020-01-01',0)");legacy.close();
 const issue=(email,old)=>{const r=spawnSync(process.execPath,['scripts/auth-admin.js','invite',email,...(old?['--legacy-user',old]:[])],{env,encoding:'utf8',timeout:5000});if(r.error)throw r.error;assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const a=issue('alice@example.com','legacy'),b=issue('bob@example.com');
 const child=spawn(process.execPath,['server.js'],{env,stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);
 t.after(async()=>{if(child.exitCode===null){const stopped=new Promise(r=>child.once('exit',r));child.kill();await stopped;}fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('startup timeout '+errors)),8000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(new Error(errors));});});
 const request=(route,body,cookie,method)=>fetch(base+route,{method:method||(body?'POST':'GET'),redirect:'manual',headers:{origin:base,'Content-Type':'application/json','X-Bojin':'1',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await request('/api/register',{username:'outsider',password:'arbitrary'})).status,410);
 assert.equal((await request('/api/me',null,'bj_s=old-session')).status,401);
 const password='temporary strong test password';
 const register=async invitation=>{
  const r=await request('/api/auth/sign-up/email',{email:invitation.email,name:'Test',password,invitation:invitation.token,callbackURL:'/login.html'});assert.equal(r.status,200,await r.clone().text());
  assert.equal((await request('/api/auth/sign-in/email',{email:invitation.email,password})).status,403);
  const mails=fs.readdirSync(path.join(dir,'mail')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,'mail',f),'utf8')));
  const mail=mails.find(m=>m.to===invitation.email&&m.kind==='verify');assert.ok(mail);
  assert.equal((await fetch(mail.url,{redirect:'manual'})).status,302);
  const login=await request('/api/auth/sign-in/email',{email:invitation.email,password});assert.equal(login.status,200,await login.clone().text());
  return login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 };
 const ca=await register(a),cb=await register(b);
 assert.equal((await (await request('/api/me',null,ca)).json()).id,'u_legacy_owner');
 const doc='/api/doc?path=data/users/'+a.userId+'/app/app/profile';
 assert.equal((await request(doc,{data:{weight:70}},ca,'PUT')).status,200);
 assert.equal((await request(doc,null,cb)).status,403);
 const upload=await fetch(base+'/api/assets',{method:'POST',headers:{cookie:ca,'X-Bojin':'1','Content-Type':'image/png'},body:await require('sharp')({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer()});assert.equal(upload.status,200);
 const blob=await upload.json();assert.equal((await request(blob.url,null,cb)).status,404);
 const own=await request(blob.url,null,ca);assert.equal(own.status,200);assert.equal(own.headers.get('cache-control'),'private, no-store');
 assert.equal((await request('/api/ai',{messages:[{content:'test'}]},ca)).status,503);
 assert.equal((await request(doc,null,ca)).status,200);
 assert.equal((await request('/',null,ca)).status,200);
 // Better Auth rejects cross-origin requests; app APIs require the custom header.
 assert.equal((await fetch(base+'/api/auth/sign-out',{method:'POST',headers:{origin:'https://attacker.invalid','Content-Type':'application/json',cookie:ca},body:'{}'})).status,403);
 assert.equal((await fetch(base+doc,{method:'PUT',headers:{cookie:ca,'Content-Type':'application/json'},body:'{"data":{}}'})).status,403);
 const exported=await request('/api/account/export',null,ca);assert.equal(exported.status,200);
 const lines=(await exported.text()).trim().split('\n').map(JSON.parse);
 assert.equal(lines[0].user.id,a.userId);assert.equal(lines.find(x=>x.kind==='document').data.weight,70);
 assert.deepEqual(Buffer.from(lines.find(x=>x.kind==='photo').dataBase64,'base64'),fs.readFileSync(path.join(dir,'blobs',blob.id)));
 const otherLines=(await (await request('/api/account/export',null,cb)).text()).trim().split('\n').map(JSON.parse);
 assert.equal(otherLines.filter(x=>x.kind==='document'||x.kind==='photo').length,0);
 // A photo whose file vanished from disk, or a malformed URL, must not take the service down.
 const lost=await (await fetch(base+'/api/assets',{method:'POST',headers:{cookie:cb,'X-Bojin':'1','Content-Type':'image/png'},body:await require('sharp')({create:{width:2,height:2,channels:3,background:'blue'}}).png().toBuffer()})).json();
 fs.rmSync(path.join(dir,'blobs',lost.id));
 assert.equal((await request(lost.url,null,cb)).status,404);
 assert.equal((await fetch(base+'/%E0%A4%A')).status,400);
 await new Promise(r=>setTimeout(r,100));
 assert.equal(child.exitCode,null,errors);
 const health=await request('/api/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 assert.equal((await request('/api/auth/delete-user',{},ca)).status,400);
 assert.equal((await request('/api/auth/delete-user',{password:'incorrect password'},ca)).status,400);
 assert.equal((await request('/api/auth/sign-out',{},ca)).status,200);
 assert.equal((await request('/api/me',null,ca)).status,401);
 const again=await request('/api/auth/sign-in/email',{email:a.email,password});
 const deleteCookie=again.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 const deletion=await request('/api/auth/delete-user',{password},deleteCookie);assert.equal(deletion.status,200,await deletion.clone().text());
 assert.equal((await request('/api/me',null,deleteCookie)).status,401);
 assert.equal((await request('/api/me',null,cb)).status,200);
 assert.equal(fs.existsSync(path.join(dir,'blobs',blob.id)),false);
 const inspect=new DatabaseSync(path.join(dir,'bojin.db'));
 assert.equal(inspect.prepare('SELECT COUNT(*) n FROM docs WHERE uid=?').get(a.userId).n,0);
 assert.equal(inspect.prepare('SELECT COUNT(*) n FROM users WHERE id=?').get(a.userId).n,0);
 assert.ok(inspect.prepare('SELECT completed FROM deletion_jobs WHERE uid=?').get(a.userId).completed);inspect.close();
 // The handler must ignore spoofed client-IP headers when no proxy is trusted.
 let last;
 for(let i=0;i<9;i++)last=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{origin:base,'Content-Type':'application/json','x-ritual-client-ip':`198.51.100.${i+1}`,'x-forwarded-for':`198.51.100.${i+1}`},body:JSON.stringify({email:'nobody@example.com',password})});
 assert.equal(last.status,429);

});
